import { describe, expect, test } from "bun:test";
import { WorkflowEngine } from "../src/engine.js";
import { WorkflowError } from "../src/errors.js";
import { scriptedExecutor, echoExecutor } from "../src/executors.js";
import { fixedClock, idFactory } from "../src/clock.js";
import type { EngineConfig, WorkflowSpec } from "../src/types.js";
import type { FixedClock } from "../src/clock.js";

function makeEngine(
  executor = echoExecutor(),
  config: Partial<EngineConfig> = {},
): { engine: WorkflowEngine; clock: FixedClock } {
  const clock = fixedClock(1_767_225_600_000);
  const engine = new WorkflowEngine({
    clock: () => clock.now(),
    newId: idFactory(),
    executor,
    config,
  });
  return { engine, clock };
}

const LINEAR: WorkflowSpec = {
  name: "linear",
  tasks: [
    { id: "a", requires: ["x"], dependsOn: [] },
    { id: "b", requires: ["x"], dependsOn: ["a"] },
    { id: "c", requires: ["x"], dependsOn: ["b"] },
  ],
};

describe("workflow validation", () => {
  test("rejects unknown dependency", () => {
    const { engine } = makeEngine();
    expect(() =>
      engine.createRun({ name: "bad", tasks: [{ id: "a", requires: [], dependsOn: ["ghost"] }] }),
    ).toThrow(/unknown task "ghost"/);
  });

  test("rejects duplicate task ids", () => {
    const { engine } = makeEngine();
    expect(() =>
      engine.createRun({
        name: "bad",
        tasks: [
          { id: "a", requires: [], dependsOn: [] },
          { id: "a", requires: [], dependsOn: [] },
        ],
      }),
    ).toThrow(/duplicate task id "a"/);
  });

  test("rejects dependency cycles", () => {
    const { engine } = makeEngine();
    expect(() =>
      engine.createRun({
        name: "bad",
        tasks: [
          { id: "a", requires: [], dependsOn: ["b"] },
          { id: "b", requires: [], dependsOn: ["a"] },
        ],
      }),
    ).toThrow(/dependency cycle/);
  });

  test("rejects self dependency", () => {
    const { engine } = makeEngine();
    expect(() =>
      engine.createRun({ name: "bad", tasks: [{ id: "a", requires: [], dependsOn: ["a"] }] }),
    ).toThrow(/depends on itself/);
  });

  test("rejects duplicate capabilities within a task", () => {
    const { engine } = makeEngine();
    expect(() =>
      engine.createRun({
        name: "bad",
        tasks: [{ id: "a", requires: ["x", "x"], dependsOn: [] }],
      }),
    ).toThrow(/duplicate entry "x"/);
  });
});

describe("agent registry", () => {
  test("re-registering with identical capabilities is idempotent", () => {
    const { engine } = makeEngine();
    engine.registerAgent({ id: "a1", capabilities: ["x", "y"] });
    engine.registerAgent({ id: "a1", capabilities: ["y", "x"] });
    expect(engine.registry.list()).toHaveLength(1);
  });

  test("re-registering with different capabilities conflicts", () => {
    const { engine } = makeEngine();
    engine.registerAgent({ id: "a1", capabilities: ["x"] });
    expect(() => engine.registerAgent({ id: "a1", capabilities: ["z"] })).toThrow(WorkflowError);
  });

  test("rejects empty capability strings", () => {
    const { engine } = makeEngine();
    expect(() => engine.registerAgent({ id: "a1", capabilities: [""] })).toThrow(WorkflowError);
  });
});

describe("scheduling", () => {
  test("completes a linear workflow respecting dependency order", async () => {
    const { engine } = makeEngine();
    engine.registerAgent({ id: "w1", capabilities: ["x"] });
    const run = engine.createRun(LINEAR);
    const result = await engine.drive(run.id);
    expect(result.settled).toBe(true);
    expect(result.status).toBe("succeeded");
    const finished = engine.getRun(run.id);
    const times = Object.values(finished.tasks).map((task) => task.completedAt ?? -1);
    expect(times[0]!).toBeLessThanOrEqual(times[1]!);
    expect(times[1]!).toBeLessThanOrEqual(times[2]!);
    expect(result.succeeded).toBe(3);
  });

  test("task stays ready when no agent has the capability", async () => {
    const { engine } = makeEngine();
    engine.registerAgent({ id: "w1", capabilities: ["x"] });
    const run = engine.createRun({
      name: "gap",
      tasks: [
        { id: "a", requires: ["x"], dependsOn: [] },
        { id: "b", requires: ["gpu"], dependsOn: ["a"] },
      ],
    });
    const result = await engine.drive(run.id, { maxTicks: 5 });
    expect(result.settled).toBe(false);
    expect(engine.getRun(run.id).tasks["b"]!.status).toBe("ready");
  });

  test("one agent cannot hold two tasks at once", async () => {
    const { engine } = makeEngine();
    engine.registerAgent({ id: "solo", capabilities: ["x"] });
    const run = engine.createRun({
      name: "parallel",
      tasks: [
        { id: "a", requires: ["x"], dependsOn: [] },
        { id: "b", requires: ["x"], dependsOn: [] },
      ],
    });
    const tick = await engine.tick(run.id);
    expect(tick.claimed).toBe(1);
    const finished = engine.getRun(run.id);
    const firstClaimed = finished.tasks["a"]!.attempts === 1 ? "a" : "b";
    const other = firstClaimed === "a" ? "b" : "a";
    expect(finished.tasks[other]!.attempts).toBe(0);
  });

  test("capability matching routes tasks to capable agents", async () => {
    const { engine } = makeEngine();
    engine.registerAgent({ id: "generic", capabilities: ["x"] });
    engine.registerAgent({ id: "specialist", capabilities: ["x", "gpu"] });
    const run = engine.createRun({ name: "route", tasks: [{ id: "t", requires: ["gpu"], dependsOn: [] }] });
    await engine.tick(run.id);
    expect(engine.getRun(run.id).tasks["t"]!.assignedTo).toBe("specialist");
  });
});

describe("retries and failure policies", () => {
  test("flaky task retries with backoff then succeeds", async () => {
    const { engine, clock } = makeEngine(
      scriptedExecutor({}, { flaky: [1] }),
      { baseBackoffMs: 100, maxBackoffMs: 1_000, defaultMaxAttempts: 3 },
    );
    engine.registerAgent({ id: "w", capabilities: ["x"] });
    const run = engine.createRun({
      name: "flaky",
      tasks: [{ id: "flaky", requires: ["x"], dependsOn: [], maxAttempts: 2 }],
    });
    await engine.tick(run.id);
    const afterFirst = engine.getRun(run.id).tasks["flaky"]!;
    expect(afterFirst.status).toBe("ready");
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.nextRetryAt).toBe(clock.now() + 100);

    clock.advance(150);
    await engine.tick(run.id);
    const finished = engine.getRun(run.id).tasks["flaky"]!;
    expect(finished.status).toBe("succeeded");
    expect(finished.attempts).toBe(2);
  });

  test("retry does not fire before its backoff deadline", async () => {
    const { engine, clock } = makeEngine(
      scriptedExecutor({}, { flaky: [1] }),
      { baseBackoffMs: 500, maxBackoffMs: 5_000, defaultMaxAttempts: 3 },
    );
    engine.registerAgent({ id: "w", capabilities: ["x"] });
    const run = engine.createRun({ name: "flaky", tasks: [{ id: "flaky", requires: ["x"], dependsOn: [] }] });
    await engine.tick(run.id);
    clock.advance(100);
    const tick = await engine.tick(run.id);
    expect(tick.claimed).toBe(0);
    clock.advance(500);
    const later = await engine.tick(run.id);
    expect(later.claimed).toBe(1);
  });

  test("exhausted fail-run task fails the run and emits run_failed", async () => {
    const { engine, clock } = makeEngine(scriptedExecutor({}, { doomed: [1, 2] }), {
      baseBackoffMs: 10,
      maxBackoffMs: 10,
      defaultMaxAttempts: 2,
    });
    engine.registerAgent({ id: "w", capabilities: ["x"] });
    const run = engine.createRun({ name: "doomed", tasks: [{ id: "doomed", requires: ["x"], dependsOn: [] }] });
    await engine.drive(run.id, { advance: (ms) => clock.advance(ms) });
    const finished = engine.getRun(run.id);
    expect(finished.status).toBe("failed");
    expect(finished.tasks["doomed"]!.status).toBe("failed");
    expect(finished.tasks["doomed"]!.error).toContain("scripted failure");
    expect(engine.eventsFor(run.id).some((event) => event.type === "run_failed")).toBe(true);
  });

  test("exhausted skip task is skipped and downstream cascades", async () => {
    const { engine, clock } = makeEngine(scriptedExecutor({}, { optional: [1, 2, 3] }), {
      baseBackoffMs: 10,
      maxBackoffMs: 10,
      defaultMaxAttempts: 3,
    });
    engine.registerAgent({ id: "w", capabilities: ["x"] });
    const run = engine.createRun({
      name: "cascade",
      tasks: [
        { id: "optional", requires: ["x"], dependsOn: [], onExhausted: "skip" },
        { id: "child", requires: ["x"], dependsOn: ["optional"] },
        { id: "grandchild", requires: ["x"], dependsOn: ["child"] },
      ],
    });
    const result = await engine.drive(run.id, { advance: (ms) => clock.advance(ms) });
    const finished = engine.getRun(run.id);
    expect(finished.status).toBe("succeeded");
    expect(finished.tasks["optional"]!.status).toBe("skipped");
    expect(finished.tasks["child"]!.status).toBe("skipped");
    expect(finished.tasks["grandchild"]!.status).toBe("skipped");
    expect(result.skipped).toBeGreaterThanOrEqual(3);
    expect(finished.tasks["child"]!.skipReason).toContain("dependency \"optional\"");
  });
});

describe("run lifecycle", () => {
  test("cancelRun marks non-terminal tasks canceled", async () => {
    const { engine } = makeEngine();
    engine.registerAgent({ id: "w", capabilities: ["x"] });
    const run = engine.createRun(LINEAR);
    await engine.tick(run.id);
    engine.cancelRun(run.id);
    const finished = engine.getRun(run.id);
    expect(finished.status).toBe("canceled");
    expect(Object.values(finished.tasks).every((task) => task.status === "canceled" || task.status === "succeeded")).toBe(true);
  });

  test("tick on a finished run is a STATE error", async () => {
    const { engine } = makeEngine();
    engine.registerAgent({ id: "w", capabilities: ["x"] });
    const run = engine.createRun({ name: "one", tasks: [{ id: "a", requires: ["x"], dependsOn: [] }] });
    await engine.drive(run.id);
    await expect(engine.tick(run.id)).rejects.toThrow(WorkflowError);
  });

  test("getRun on unknown id is NOT_FOUND", () => {
    const { engine } = makeEngine();
    expect(() => engine.getRun("run_nope")).toThrow(WorkflowError);
  });

  test("events are sequenced and complete", async () => {
    const { engine } = makeEngine();
    engine.registerAgent({ id: "w", capabilities: ["x"] });
    const run = engine.createRun({ name: "one", tasks: [{ id: "a", requires: ["x"], dependsOn: [] }] });
    await engine.drive(run.id);
    const events = engine.eventsFor(run.id);
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("run_created");
    expect(types.at(-1)).toBe("run_succeeded");
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.seq).toBe(events[i - 1]!.seq + 1);
    }
  });
});

describe("persistence round-trip", () => {
  test("toJSON/fromJSON preserves agents, runs, and events", async () => {
    const { engine } = makeEngine(scriptedExecutor({}, { flaky: [1] }), {
      baseBackoffMs: 10,
      maxBackoffMs: 10,
      defaultMaxAttempts: 2,
    });
    engine.registerAgent({ id: "w", capabilities: ["x"] });
    const run = engine.createRun({ name: "snap", tasks: [{ id: "flaky", requires: ["x"], dependsOn: [] }] });
    await engine.tick(run.id);
    const snapshot = engine.toJSON();

    const clock2 = fixedClock(1_767_225_600_000 + 20);
    const restored = WorkflowEngine.fromJSON(JSON.parse(JSON.stringify(snapshot)), {
      clock: () => clock2.now(),
      newId: idFactory(),
      executor: scriptedExecutor({}, {}),
    });
    expect(restored.registry.list().map((agent) => agent.id)).toEqual(["w"]);
    expect(restored.listRuns()).toHaveLength(1);
    const task = restored.getRun(run.id).tasks["flaky"]!;
    expect(task.status).toBe("ready");
    expect(task.attempts).toBe(1);
    const restoredState = snapshot as { events: unknown[] };
    expect(restored.allEvents().length).toBe(restoredState.events.length);

    clock2.advance(1000);
    await restored.tick(run.id);
    expect(restored.getRun(run.id).tasks["flaky"]!.status).toBe("succeeded");
  });

  test("fromJSON rejects malformed state", () => {
    const clock2 = fixedClock(0);
    expect(() =>
      WorkflowEngine.fromJSON({ version: 2 }, { clock: () => clock2.now(), newId: idFactory(), executor: echoExecutor() }),
    ).toThrow(WorkflowError);
    expect(() =>
      WorkflowEngine.fromJSON(null, { clock: () => clock2.now(), newId: idFactory(), executor: echoExecutor() }),
    ).toThrow(WorkflowError);
  });
});

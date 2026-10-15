import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowEngine } from "../src/engine.js";
import { echoExecutor } from "../src/executors.js";
import { fixedClock, idFactory } from "../src/clock.js";
import { loadEngineState, saveEngineState } from "../src/persistence.js";
import { WorkflowError } from "../src/errors.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "amwe-test-"));
}

function makeEngine(): WorkflowEngine {
  const clock = fixedClock(1_767_225_600_000);
  return new WorkflowEngine({ clock: () => clock.now(), newId: idFactory(), executor: echoExecutor() });
}

describe("engine state persistence", () => {
  test("save + load round-trip preserves the full state", async () => {
    const directory = await tempDir();
    const path = join(directory, "engine-state.json");
    const engine = makeEngine();
    engine.registerAgent({ id: "w1", capabilities: ["x", "y"] });
    const run = engine.createRun({
      name: "roundtrip",
      tasks: [
        { id: "a", requires: ["x"], dependsOn: [], payload: { k: 1 } },
        { id: "b", requires: ["x"], dependsOn: ["a"], onExhausted: "skip", maxAttempts: 5 },
      ],
    });
    await engine.drive(run.id);
    await saveEngineState(path, engine.toJSON(), 1_234_567_890);

    const envelope = await loadEngineState<Record<string, unknown>>(path);
    expect(envelope.version).toBe(1);
    expect(envelope.savedAt).toBe(1_234_567_890);

    const restored = WorkflowEngine.fromJSON(envelope.state, {
      clock: () => 0,
      newId: idFactory(),
      executor: echoExecutor(),
    });
    expect(restored.listRuns().map((r) => r.id)).toEqual([run.id]);
    expect(restored.getRun(run.id).status).toBe("succeeded");
    expect(restored.getRun(run.id).tasks["a"]!.output).toEqual(
      engine.getRun(run.id).tasks["a"]!.output,
    );
    expect(restored.getRun(run.id).tasks["b"]!.maxAttempts).toBe(5);
    expect(restored.getRun(run.id).tasks["b"]!.onExhausted).toBe("skip");
    expect(restored.registry.get("w1").capabilities).toEqual(["x", "y"]);
    expect(restored.allEvents()).toHaveLength(engine.allEvents().length);
  });

  test("writes are atomic: no temporary files left behind", async () => {
    const directory = await tempDir();
    const path = join(directory, "engine-state.json");
    await saveEngineState(path, { version: 1, hello: "world" });
    await saveEngineState(path, { version: 1, hello: "again" });
    const files = await readdir(directory);
    expect(files).toEqual(["engine-state.json"]);
    const contents = JSON.parse(await readFile(path, "utf8"));
    expect(contents.state.hello).toBe("again");
  });

  test("corrupt state files raise CORRUPTION", async () => {
    const directory = await tempDir();
    const path = join(directory, "broken.json");
    await writeFile(path, "{not json", "utf8");
    expect(loadEngineState(path)).rejects.toThrow(WorkflowError);
    expect(loadEngineState(path)).rejects.toThrow(/not valid JSON/);

    const missing = join(directory, "absent.json");
    expect(loadEngineState(missing)).rejects.toThrow(/does not exist/);
  });

  test("invalid envelope shapes raise CORRUPTION", async () => {
    const directory = await tempDir();
    const path = join(directory, "bad-envelope.json");
    await writeFile(path, JSON.stringify({ version: 9, savedAt: 0 }), "utf8");
    expect(loadEngineState(path)).rejects.toThrow(/invalid envelope/);
    await writeFile(path, JSON.stringify({ version: 1, state: {} }), "utf8");
    expect(loadEngineState(path)).rejects.toThrow(/invalid envelope/);
  });
});

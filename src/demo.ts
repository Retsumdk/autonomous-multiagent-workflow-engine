import { fixedClock, idFactory } from "./clock.js";
import { WorkflowEngine } from "./engine.js";
import { scriptedExecutor } from "./executors.js";
import type { WorkflowSpec } from "./types.js";

const DEMO_SPEC: WorkflowSpec = {
  name: "release-brief",
  tasks: [
    { id: "research", requires: ["research"], dependsOn: [], payload: { topic: "agent workflows" } },
    { id: "draft", requires: ["writing"], dependsOn: ["research"], payload: { format: "brief" } },
    { id: "fact-check", requires: ["verification"], dependsOn: ["research"], maxAttempts: 2 },
    { id: "review", requires: ["writing", "verification"], dependsOn: ["draft", "fact-check"] },
    { id: "publish", requires: ["publishing"], dependsOn: ["review"] },
  ],
};

const DEMO_OUTPUTS: Record<string, unknown> = {
  research: { sources: 4, finding: "Task ownership must be explicit." },
  draft: { words: 420, title: "A practical workflow for agent teams" },
  "fact-check": { verified: true, claimsChecked: 6 },
  review: { approved: true, notes: [] },
  publish: { url: "https://example.org/briefs/agent-workflows" },
};

export async function runDemo(): Promise<string> {
  const clock = fixedClock(Date.UTC(2026, 0, 1));
  const engine = new WorkflowEngine({
    clock: () => clock.now(),
    newId: idFactory(),
    executor: scriptedExecutor(DEMO_OUTPUTS, { "fact-check": [1] }),
    config: { baseBackoffMs: 100, maxBackoffMs: 1_000, defaultMaxAttempts: 3 },
  });
  engine.registerAgent({ id: "researcher", capabilities: ["research"] });
  engine.registerAgent({ id: "writer", capabilities: ["writing"] });
  engine.registerAgent({ id: "verifier", capabilities: ["verification"] });
  engine.registerAgent({ id: "reviewer", capabilities: ["writing", "verification"] });
  engine.registerAgent({ id: "publisher", capabilities: ["publishing"] });
  const run = engine.createRun(DEMO_SPEC);
  const driven = await engine.drive(run.id, { maxTicks: 30, advance: (ms) => clock.advance(ms), stepMs: 100 });
  const finished = engine.getRun(run.id);
  const lines = [
    `Workflow: ${finished.name}`,
    `Run: ${finished.id}`,
    `Status: ${finished.status} (${driven.ticks} ticks, ${driven.succeeded} successful executions, ${driven.retried} retry)`,
    "Tasks:",
    ...Object.values(finished.tasks).map((task) => {
      const retried = engine
        .eventsFor(run.id)
        .some((event) => event.type === "task_retry_scheduled" && event.taskId === task.id);
      const suffix = task.status === "succeeded" && retried ? ` (recovered after ${task.attempts} attempts)` : "";
      return `  ${task.status.padEnd(9)} ${task.id}${suffix}`;
    }),
    "Events:",
    ...engine.eventsFor(run.id).map((event) => {
      const task = event.taskId ? ` ${event.taskId}` : "";
      const agent = event.agentId ? ` by ${event.agentId}` : "";
      const detail = event.detail ? ` — ${event.detail}` : "";
      return `  ${event.type}${task}${agent}${detail}`;
    }),
  ];
  return lines.join("\n");
}

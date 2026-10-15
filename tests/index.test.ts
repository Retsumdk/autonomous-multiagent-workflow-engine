import { describe, test, expect } from "bun:test";
import {
  WorkflowEngine,
  echoExecutor,
  WorkflowError,
  isWorkflowError,
} from "../src/index.js";
import type { WorkflowSpec } from "../src/index.js";

describe("public API surface", () => {
  test("engine runs a two-task linear workflow end to end", async () => {
    const spec: WorkflowSpec = {
      name: "smoke",
      tasks: [
        { id: "a", requires: ["work"] },
        { id: "b", requires: ["work"], dependsOn: ["a"] },
      ],
    };
    const engine = new WorkflowEngine({ executor: echoExecutor() });
    engine.registerAgent({ id: "worker", capabilities: ["work"] });
    const run = engine.createRun(spec);
    const result = await engine.drive(run.id, { maxTicks: 10 });
    expect(result.status).toBe("succeeded");
    expect(result.claimed).toBe(2);
  });

  test("WorkflowError carries a machine-readable code", () => {
    const error = new WorkflowError("VALIDATION", "bad spec");
    expect(isWorkflowError(error)).toBe(true);
    expect(error.code).toBe("VALIDATION");
  });
});

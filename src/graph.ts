import type { WorkflowSpec } from "./types.js";
import { WorkflowError } from "./errors.js";

export function validateWorkflowSpec(spec: WorkflowSpec): void {
  if (typeof spec !== "object" || spec === null || Array.isArray(spec)) {
    throw new WorkflowError("VALIDATION", "workflow spec must be an object");
  }
  if (typeof spec.name !== "string" || spec.name.trim().length === 0) {
    throw new WorkflowError("VALIDATION", "workflow name must be a non-empty string");
  }
  if (!Array.isArray(spec.tasks) || spec.tasks.length === 0) {
    throw new WorkflowError("VALIDATION", "workflow must declare at least one task");
  }

  const seen = new Set<string>();
  for (const task of spec.tasks) {
    if (typeof task !== "object" || task === null) {
      throw new WorkflowError("VALIDATION", "each task must be an object");
    }
    if (typeof task.id !== "string" || task.id.trim().length === 0) {
      throw new WorkflowError("VALIDATION", "task id must be a non-empty string");
    }
    if (seen.has(task.id)) {
      throw new WorkflowError("VALIDATION", `duplicate task id "${task.id}"`, {
        taskId: task.id,
      });
    }
    seen.add(task.id);
  }

  for (const task of spec.tasks) {
    validateStringList(task.id, "requires", task.requires);
    validateStringList(task.id, "dependsOn", task.dependsOn ?? []);
    for (const dep of task.dependsOn ?? []) {
      if (dep === task.id) {
        throw new WorkflowError("VALIDATION", `task "${task.id}" depends on itself`, {
          taskId: task.id,
        });
      }
      if (!seen.has(dep)) {
        throw new WorkflowError(
          "VALIDATION",
          `task "${task.id}" depends on unknown task "${dep}"`,
          { taskId: task.id, unknownDependency: dep },
        );
      }
    }
    if (task.payload !== undefined) {
      if (typeof task.payload !== "object" || task.payload === null || Array.isArray(task.payload)) {
        throw new WorkflowError("VALIDATION", `task "${task.id}" payload must be an object`, {
          taskId: task.id,
        });
      }
    }
    if (task.maxAttempts !== undefined) {
      if (!Number.isInteger(task.maxAttempts) || task.maxAttempts < 1) {
        throw new WorkflowError(
          "VALIDATION",
          `task "${task.id}" maxAttempts must be an integer >= 1`,
          { taskId: task.id },
        );
      }
    }
    if (task.onExhausted !== undefined && task.onExhausted !== "fail-run" && task.onExhausted !== "skip") {
      throw new WorkflowError(
        "VALIDATION",
        `task "${task.id}" onExhausted must be "fail-run" or "skip"`,
        { taskId: task.id },
      );
    }
  }

  assertAcyclic(spec);
}

function validateStringList(
  taskId: string,
  field: "requires" | "dependsOn",
  value: unknown,
): void {
  if (!Array.isArray(value)) {
    throw new WorkflowError("VALIDATION", `task "${taskId}" ${field} must be an array of strings`, {
      taskId,
    });
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new WorkflowError(
        "VALIDATION",
        `task "${taskId}" ${field} must contain only non-empty strings`,
        { taskId },
      );
    }
    if (seen.has(entry)) {
      throw new WorkflowError(
        "VALIDATION",
        `task "${taskId}" ${field} contains duplicate entry "${entry}"`,
        { taskId },
      );
    }
    seen.add(entry);
  }
}

function assertAcyclic(spec: WorkflowSpec): void {
  const dependents = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const task of spec.tasks) {
    const dependsOn = task.dependsOn ?? [];
    indegree.set(task.id, dependsOn.length);
    for (const dep of dependsOn) {
      const list = dependents.get(dep);
      if (list) list.push(task.id);
      else dependents.set(dep, [task.id]);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of indegree) {
    if (degree === 0) queue.push(id);
  }
  let processed = 0;
  while (queue.length > 0) {
    const id = queue.pop()!;
    processed += 1;
    for (const next of dependents.get(id) ?? []) {
      const degree = indegree.get(next)! - 1;
      indegree.set(next, degree);
      if (degree === 0) queue.push(next);
    }
  }

  if (processed < spec.tasks.length) {
    const cycleMembers = spec.tasks
      .map((t) => t.id)
      .filter((id) => (indegree.get(id) ?? 0) > 0);
    throw new WorkflowError(
      "VALIDATION",
      `workflow contains a dependency cycle involving: ${cycleMembers.join(", ")}`,
      { cycleMembers },
    );
  }
}

export function topologicalOrder(spec: WorkflowSpec): string[] {
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const byId = new Map(spec.tasks.map((t) => [t.id, t] as const));

  const visit = (id: string): void => {
    const marker = state.get(id);
    if (marker === "done") return;
    if (marker === "visiting") {
      throw new WorkflowError("VALIDATION", `dependency cycle detected at task "${id}"`, {
        taskId: id,
      });
    }
    state.set(id, "visiting");
    for (const dep of byId.get(id)!.dependsOn ?? []) visit(dep);
    state.set(id, "done");
    order.push(id);
  };

  for (const task of spec.tasks) visit(task.id);
  return order;
}

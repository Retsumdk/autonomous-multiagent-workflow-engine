import type {
  AgentDescriptor,
  AgentRecord,
  EngineConfig,
  EngineEvent,
  EngineEventType,
  Executor,
  RunRecord,
  TaskRun,
  TaskSpec,
  TaskStatus,
  WorkflowSpec,
} from "./types.js";
import { RUN_STATUSES, TASK_STATUSES } from "./types.js";
import { WorkflowError, isWorkflowError } from "./errors.js";
import { validateWorkflowSpec } from "./graph.js";
import { AgentRegistry, validateAgentDescriptor } from "./registry.js";
import { backoffDelay } from "./retry.js";
import type { IdFactory } from "./clock.js";

export function defaultIdFactory(): IdFactory {
  let counter = 0;
  return (prefix) => `${prefix}_${String(++counter).padStart(4, "0")}`;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  baseBackoffMs: 100,
  maxBackoffMs: 30_000,
  defaultMaxAttempts: 3,
};

export interface TickResult {
  claimed: number;
  succeeded: number;
  retried: number;
  skipped: number;
  failed: number;
}

export interface EngineDeps {
  clock?: () => number;
  newId?: IdFactory;
  executor: Executor;
  config?: Partial<EngineConfig>;
}

export interface DriveOptions {
  maxTicks?: number;
  advance?: (milliseconds: number) => void;
  stepMs?: number;
}

export interface DriveResult extends TickResult {
  ticks: number;
  settled: boolean;
  status: RunRecord["status"];
}

const TERMINAL_STATUSES: readonly TaskStatus[] = ["succeeded", "failed", "skipped", "canceled"];

function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

function taskSpecView(task: TaskRun): TaskSpec {
  return {
    id: task.id,
    requires: [...task.requires],
    dependsOn: [...(task.dependsOn ?? [])],
    payload: { ...task.payload },
    maxAttempts: task.maxAttempts,
    onExhausted: task.onExhausted,
  };
}

export class WorkflowEngine {
  readonly registry = new AgentRegistry();
  readonly config: EngineConfig;

  private readonly deps: Required<Omit<EngineDeps, "config">>;
  private readonly runs = new Map<string, RunRecord>();
  private readonly events: EngineEvent[] = [];
  private seq = 0;

  constructor(deps: EngineDeps) {
    this.deps = {
      clock: deps.clock ?? (() => Date.now()),
      newId: deps.newId ?? defaultIdFactory(),
      executor: deps.executor,
    };
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...deps.config };
  }

  registerAgent(descriptor: AgentDescriptor): AgentRecord {
    validateAgentDescriptor(descriptor);
    const record = this.registry.register(descriptor, this.deps.clock());
    this.emit("agent_registered", "", { agentId: record.id, detail: record.capabilities.join(",") });
    return record;
  }

  createRun(spec: WorkflowSpec): RunRecord {
    validateWorkflowSpec(spec);
    const now = this.deps.clock();
    const id = this.deps.newId("run");
    const tasks: Record<string, TaskRun> = {};
    for (const task of spec.tasks) {
      tasks[task.id] = {
        id: task.id,
        requires: [...task.requires],
        dependsOn: [...(task.dependsOn ?? [])],
        payload: task.payload ? { ...task.payload } : {},
        maxAttempts: task.maxAttempts ?? this.config.defaultMaxAttempts,
        onExhausted: task.onExhausted ?? "fail-run",
        status: "pending",
        attempts: 0,
        assignedTo: null,
        startedAt: null,
        completedAt: null,
        nextRetryAt: null,
      };
    }
    const run: RunRecord = {
      id,
      name: spec.name,
      createdAt: now,
      endedAt: null,
      status: "running",
      tasks,
    };
    this.runs.set(id, run);
    this.emit("run_created", id, { detail: `${spec.tasks.length} tasks` });
    return run;
  }

  getRun(runId: string): RunRecord {
    const run = this.runs.get(runId);
    if (!run) {
      throw new WorkflowError("NOT_FOUND", `run "${runId}" does not exist`, { runId });
    }
    return run;
  }

  listRuns(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) =>
      a.createdAt === b.createdAt ? a.id.localeCompare(b.id) : a.createdAt - b.createdAt,
    );
  }

  cancelRun(runId: string): RunRecord {
    const run = this.getRun(runId);
    if (run.status !== "running") {
      throw new WorkflowError("STATE", `run "${runId}" is already ${run.status}`, {
        runId,
        status: run.status,
      });
    }
    const now = this.deps.clock();
    for (const task of Object.values(run.tasks)) {
      if (isTerminal(task.status)) continue;
      if (task.assignedTo) {
        this.registry.release(task.assignedTo, "failed");
        task.assignedTo = null;
      }
      task.status = "canceled";
    }
    run.status = "canceled";
    run.endedAt = now;
    this.emit("run_canceled", runId);
    return run;
  }

  eventsFor(runId: string): EngineEvent[] {
    this.getRun(runId);
    return this.events.filter((event) => event.runId === runId);
  }

  restoreRun(run: RunRecord): RunRecord {
    const existing = this.runs.get(run.id);
    if (existing) return existing;
    this.runs.set(run.id, run);
    return run;
  }

  allEvents(): EngineEvent[] {
    return [...this.events];
  }

  stats(): Record<string, unknown> {
    const byStatus: Record<string, number> = {};
    for (const status of RUN_STATUSES) byStatus[status] = 0;
    for (const run of this.runs.values()) byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
    return {
      agents: this.registry.list().length,
      runs: { total: this.runs.size, byStatus },
      events: this.events.length,
    };
  }

  async tick(runId: string): Promise<TickResult> {
    const run = this.getRun(runId);
    if (run.status !== "running") {
      throw new WorkflowError("STATE", `run "${runId}" is ${run.status}, not running`, {
        runId,
        status: run.status,
      });
    }
    const now = this.deps.clock();
    const result: TickResult = { claimed: 0, succeeded: 0, retried: 0, skipped: 0, failed: 0 };

    for (const task of Object.values(run.tasks)) {
      if (task.status !== "pending") continue;
      const depStatuses = task.dependsOn.map((dep) => run.tasks[dep]!.status);
      if (depStatuses.every((status) => status === "succeeded")) {
        task.status = "ready";
        this.emit("task_ready", run.id, { taskId: task.id });
      } else {
        const blocked = task.dependsOn.find((dep) => {
          const status = run.tasks[dep]!.status;
          return isTerminal(status) && status !== "succeeded";
        });
        if (blocked !== undefined) {
          const depStatus = run.tasks[blocked]!.status;
          task.status = "skipped";
          task.skipReason = `dependency "${blocked}" is ${depStatus}`;
          this.emit("task_skipped", run.id, { taskId: task.id, detail: task.skipReason });
          result.skipped += 1;
        }
      }
    }

    const claimed: Array<{ task: TaskRun; agentId: string }> = [];
    for (const task of Object.values(run.tasks)) {
      if (task.status !== "ready") continue;
      if (task.nextRetryAt !== null && task.nextRetryAt > now) continue;
      const candidates = this.registry.findCapable(task.requires);
      if (candidates.length === 0) continue;
      const agent = candidates[0]!;
      this.registry.acquire(agent.id, task.id, now);
      task.status = "running";
      task.assignedTo = agent.id;
      task.attempts += 1;
      task.startedAt = now;
      this.emit("task_started", run.id, {
        taskId: task.id,
        agentId: agent.id,
        detail: `attempt ${task.attempts}`,
      });
      claimed.push({ task, agentId: agent.id });
      result.claimed += 1;
    }

    for (const { task, agentId } of claimed) {
      try {
        const output = await this.deps.executor(
          taskSpecView(task),
          this.registry.get(agentId),
          { runId: run.id, attempt: task.attempts, now },
        );
        task.output = output;
        task.status = "succeeded";
        task.completedAt = now;
        delete task.error;
        this.registry.release(agentId, "completed");
        this.emit("task_succeeded", run.id, {
          taskId: task.id,
          agentId,
          detail: `attempt ${task.attempts}`,
        });
        result.succeeded += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (task.attempts < task.maxAttempts) {
          const delay = backoffDelay(task.attempts, this.config);
          task.status = "ready";
          task.assignedTo = null;
          task.nextRetryAt = now + delay;
          task.error = message;
          this.registry.release(agentId, "failed");
          this.emit("task_retry_scheduled", run.id, {
            taskId: task.id,
            agentId,
            detail: `attempt ${task.attempts} failed, retry in ${delay}ms`,
          });
          result.retried += 1;
        } else if (task.onExhausted === "skip") {
          task.status = "skipped";
          task.assignedTo = null;
          task.error = message;
          task.skipReason = `exhausted ${task.attempts} attempts: ${message}`;
          this.registry.release(agentId, "failed");
          this.emit("task_skipped", run.id, { taskId: task.id, detail: task.skipReason });
          result.skipped += 1;
        } else {
          task.status = "failed";
          task.assignedTo = null;
          task.error = message;
          task.completedAt = now;
          this.registry.release(agentId, "failed");
          this.emit("task_failed", run.id, { taskId: task.id, agentId, detail: message });
          run.status = "failed";
          run.endedAt = now;
          this.emit("run_failed", run.id, { taskId: task.id, detail: message });
          result.failed += 1;
        }
      }
    }

    if (run.status === "running") {
      const tasks = Object.values(run.tasks);
      if (tasks.every((task) => isTerminal(task.status))) {
        const anyFailed = tasks.some((task) => task.status === "failed");
        run.status = anyFailed ? "failed" : "succeeded";
        run.endedAt = now;
        this.emit(anyFailed ? "run_failed" : "run_succeeded", run.id);
      }
    }

    return result;
  }

  async drive(runId: string, options: DriveOptions = {}): Promise<DriveResult> {
    const maxTicks = options.maxTicks ?? 10_000;
    const stepMs = options.stepMs ?? 50;
    const totals: DriveResult = {
      claimed: 0,
      succeeded: 0,
      retried: 0,
      skipped: 0,
      failed: 0,
      ticks: 0,
      settled: false,
      status: "running",
    };
    while (totals.ticks < maxTicks) {
      const tick = await this.tick(runId);
      totals.ticks += 1;
      totals.claimed += tick.claimed;
      totals.succeeded += tick.succeeded;
      totals.retried += tick.retried;
      totals.skipped += tick.skipped;
      totals.failed += tick.failed;
      const run = this.getRun(runId);
      if (run.status !== "running") break;
      if (tick.claimed === 0 && tick.skipped === 0) options.advance?.(stepMs);
      else options.advance?.(1);
    }
    const run = this.getRun(runId);
    totals.settled = run.status !== "running";
    totals.status = run.status;
    return totals;
  }

  serializeRun(run: RunRecord): Record<string, unknown> {
    return JSON.parse(JSON.stringify(run)) as Record<string, unknown>;
  }

  toJSON(): Record<string, unknown> {
    return {
      version: 1,
      savedAt: this.deps.clock(),
      agents: this.registry.list().map((agent) => ({ ...agent })),
      runs: this.listRuns().map((run) => JSON.parse(JSON.stringify(run))),
      events: this.events.map((event) => ({ ...event })),
      nextSeq: this.seq + 1,
    };
  }

  static fromJSON(json: unknown, deps: Omit<EngineDeps, "config">): WorkflowEngine {
    const engine = new WorkflowEngine(deps);
    if (typeof json !== "object" || json === null) {
      throw new WorkflowError("CORRUPTION", "engine state must be an object");
    }
    const state = json as Record<string, unknown>;
    if (state.version !== 1) {
      throw new WorkflowError("CORRUPTION", `unsupported engine state version ${String(state.version)}`);
    }
    if (!Array.isArray(state.agents) || !Array.isArray(state.runs) || !Array.isArray(state.events)) {
      throw new WorkflowError("CORRUPTION", "engine state is missing agents, runs, or events");
    }

    for (const raw of state.agents) {
      const record = raw as Record<string, unknown>;
      if (
        typeof record.id !== "string" ||
        typeof record.registeredAt !== "number" ||
        (record.busyWith !== null && typeof record.busyWith !== "string") ||
        typeof record.completed !== "number" ||
        typeof record.failed !== "number"
      ) {
        throw new WorkflowError("CORRUPTION", "malformed agent record in engine state");
      }
      const agent: AgentRecord = {
        id: record.id,
        capabilities: normalizeCaps(record.capabilities),
        registeredAt: record.registeredAt,
        busyWith: record.busyWith as string | null,
        completed: record.completed,
        failed: record.failed,
      };
      engine.registryRestore(agent);
    }

    for (const raw of state.runs) {
      const run = raw as Record<string, unknown>;
      if (
        typeof run.id !== "string" ||
        typeof run.name !== "string" ||
        typeof run.createdAt !== "number" ||
        !RUN_STATUSES.includes(run.status as never) ||
        typeof run.tasks !== "object" ||
        run.tasks === null
      ) {
        throw new WorkflowError("CORRUPTION", "malformed run record in engine state");
      }
      const tasks: Record<string, TaskRun> = {};
      for (const [taskId, rawTask] of Object.entries(run.tasks as Record<string, unknown>)) {
        const t = rawTask as Record<string, unknown>;
        if (
          taskId !== t.id ||
          typeof t.id !== "string" ||
          !Array.isArray(t.requires) ||
          !Array.isArray(t.dependsOn) ||
          typeof t.maxAttempts !== "number" ||
          (t.onExhausted !== "fail-run" && t.onExhausted !== "skip") ||
          !TASK_STATUSES.includes(t.status as never) ||
          typeof t.attempts !== "number" ||
          typeof t.payload !== "object" ||
          t.payload === null
        ) {
          throw new WorkflowError("CORRUPTION", `malformed task record "${taskId}" in engine state`);
        }
        tasks[taskId] = {
          id: t.id,
          requires: t.requires as string[],
          dependsOn: t.dependsOn as string[],
          payload: t.payload as Record<string, unknown>,
          maxAttempts: t.maxAttempts,
          onExhausted: t.onExhausted,
          status: t.status as TaskStatus,
          attempts: t.attempts,
          assignedTo: (t.assignedTo as string | null) ?? null,
          output: t.output,
          ...(t.error !== undefined ? { error: t.error as string } : {}),
          ...(t.skipReason !== undefined ? { skipReason: t.skipReason as string } : {}),
          startedAt: (t.startedAt as number | null) ?? null,
          completedAt: (t.completedAt as number | null) ?? null,
          nextRetryAt: (t.nextRetryAt as number | null) ?? null,
        };
      }
      const restored: RunRecord = {
        id: run.id,
        name: run.name,
        createdAt: run.createdAt,
        endedAt: (run.endedAt as number | null) ?? null,
        status: run.status as RunRecord["status"],
        tasks,
      };
      engine.runs.set(restored.id, restored);
    }

    for (const raw of state.events) {
      const event = raw as Record<string, unknown>;
      if (
        typeof event.seq !== "number" ||
        typeof event.at !== "number" ||
        typeof event.type !== "string" ||
        typeof event.runId !== "string"
      ) {
        throw new WorkflowError("CORRUPTION", "malformed event record in engine state");
      }
      const restored: EngineEvent = {
        seq: event.seq,
        at: event.at,
        type: event.type as EngineEventType,
        runId: event.runId,
      };
      if (typeof event.taskId === "string") restored.taskId = event.taskId;
      if (typeof event.agentId === "string") restored.agentId = event.agentId;
      if (typeof event.detail === "string") restored.detail = event.detail;
      engine.events.push(restored);
    }
    if (typeof state.nextSeq === "number") engine.seq = state.nextSeq;
    return engine;
  }

  private registryRestore(agent: AgentRecord): void {
    validateAgentDescriptor(agent);
    this.registry.register({ id: agent.id, capabilities: agent.capabilities }, agent.registeredAt);
    const record = this.registry.get(agent.id);
    record.busyWith = agent.busyWith;
    record.completed = agent.completed;
    record.failed = agent.failed;
  }

  private emit(
    type: EngineEventType,
    runId: string,
    extra?: { taskId?: string; agentId?: string; detail?: string },
  ): void {
    const event: EngineEvent = {
      seq: this.seq++,
      at: this.deps.clock(),
      type,
      runId,
    };
    if (extra?.taskId !== undefined) event.taskId = extra.taskId;
    if (extra?.agentId !== undefined) event.agentId = extra.agentId;
    if (extra?.detail !== undefined) event.detail = extra.detail;
    this.events.push(event);
  }
}

function normalizeCaps(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((cap) => typeof cap !== "string" || cap.length === 0)) {
    throw new WorkflowError("CORRUPTION", "malformed agent capabilities in engine state");
  }
  return [...value].sort();
}

export { isWorkflowError, WorkflowError };

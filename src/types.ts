export type TaskStatus =
  | "pending"
  | "ready"
  | "claimed"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "canceled";

export type RunStatus = "running" | "succeeded" | "failed" | "canceled";

export type ExhaustPolicy = "fail-run" | "skip";

export interface TaskSpec {
  id: string;
  requires: string[];
  dependsOn?: string[];
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  onExhausted?: ExhaustPolicy;
}

export interface WorkflowSpec {
  name: string;
  tasks: TaskSpec[];
}

export interface AgentDescriptor {
  id: string;
  capabilities: string[];
}

export interface AgentRecord extends AgentDescriptor {
  registeredAt: number;
  busyWith: string | null;
  completed: number;
  failed: number;
}

export interface TaskRun {
  id: string;
  requires: string[];
  dependsOn: string[];
  payload: Record<string, unknown>;
  maxAttempts: number;
  onExhausted: ExhaustPolicy;
  status: TaskStatus;
  attempts: number;
  assignedTo: string | null;
  output?: unknown;
  error?: string;
  skipReason?: string;
  startedAt: number | null;
  completedAt: number | null;
  nextRetryAt: number | null;
}

export type EngineEventType =
  | "agent_registered"
  | "run_created"
  | "task_ready"
  | "task_started"
  | "task_succeeded"
  | "task_retry_scheduled"
  | "task_failed"
  | "task_skipped"
  | "run_succeeded"
  | "run_failed"
  | "run_canceled";

export interface EngineEvent {
  seq: number;
  at: number;
  type: EngineEventType;
  runId: string;
  taskId?: string;
  agentId?: string;
  detail?: string;
}

export interface RunRecord {
  id: string;
  name: string;
  createdAt: number;
  endedAt: number | null;
  status: RunStatus;
  tasks: Record<string, TaskRun>;
}

export interface EngineConfig {
  baseBackoffMs: number;
  maxBackoffMs: number;
  defaultMaxAttempts: number;
}

export interface TaskContext {
  runId: string;
  attempt: number;
  now: number;
}

export type Executor = (
  task: TaskSpec,
  agent: AgentDescriptor,
  ctx: TaskContext,
) => unknown | Promise<unknown>;

export const TASK_STATUSES: readonly TaskStatus[] = [
  "pending",
  "ready",
  "claimed",
  "running",
  "succeeded",
  "failed",
  "skipped",
  "canceled",
];

export const RUN_STATUSES: readonly RunStatus[] = [
  "running",
  "succeeded",
  "failed",
  "canceled",
];

import type { AgentDescriptor, Executor, TaskContext, TaskSpec } from "./types.js";

export function echoExecutor(): Executor {
  return (task: TaskSpec, agent: AgentDescriptor, ctx: TaskContext) => ({
    engine: "echo",
    task: task.id,
    agent: agent.id,
    attempt: ctx.attempt,
    payload: task.payload ?? {},
  });
}

export function scriptedExecutor(
  outputs: Record<string, unknown>,
  failures: Record<string, number[]> = {},
): Executor {
  return (task: TaskSpec, agent: AgentDescriptor, ctx: TaskContext) => {
    const failingAttempts = failures[task.id];
    if (failingAttempts && failingAttempts.includes(ctx.attempt)) {
      throw new Error(`scripted failure for task "${task.id}" on attempt ${ctx.attempt}`);
    }
    if (task.id in outputs) return outputs[task.id];
    return { engine: "scripted", task: task.id, agent: agent.id, attempt: ctx.attempt };
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SimulatedExecutorOptions {
  failRate?: number;
}

export function simulatedExecutor(seed: number, options: SimulatedExecutorOptions = {}): Executor {
  const failRate = options.failRate ?? 0.2;
  if (!Number.isFinite(failRate) || failRate < 0 || failRate > 1) {
    throw new RangeError("failRate must be between 0 and 1");
  }
  const rand = mulberry32(seed);
  return (task: TaskSpec, agent: AgentDescriptor, ctx: TaskContext) => {
    const roll = rand();
    if (roll < failRate) {
      throw new Error(
        `simulated failure for task "${task.id}" (roll ${roll.toFixed(4)} < failRate ${failRate})`,
      );
    }
    return {
      engine: "simulated",
      task: task.id,
      agent: agent.id,
      attempt: ctx.attempt,
      roll,
    };
  };
}

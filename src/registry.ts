import type { AgentDescriptor, AgentRecord } from "./types.js";
import { WorkflowError } from "./errors.js";

export function normalizeCapabilities(capabilities: unknown): string[] {
  if (!Array.isArray(capabilities)) {
    throw new WorkflowError("VALIDATION", "capabilities must be an array of non-empty strings");
  }
  const seen = new Set<string>();
  for (const cap of capabilities) {
    if (typeof cap !== "string" || cap.trim().length === 0) {
      throw new WorkflowError("VALIDATION", "capabilities must contain only non-empty strings");
    }
    seen.add(cap);
  }
  return [...seen].sort();
}

export function validateAgentDescriptor(descriptor: AgentDescriptor): void {
  if (typeof descriptor !== "object" || descriptor === null) {
    throw new WorkflowError("VALIDATION", "agent descriptor must be an object");
  }
  if (typeof descriptor.id !== "string" || descriptor.id.trim().length === 0) {
    throw new WorkflowError("VALIDATION", "agent id must be a non-empty string");
  }
  normalizeCapabilities(descriptor.capabilities);
}

export class AgentRegistry {
  private readonly agents = new Map<string, AgentRecord>();

  register(descriptor: AgentDescriptor, now: number): AgentRecord {
    validateAgentDescriptor(descriptor);
    const capabilities = normalizeCapabilities(descriptor.capabilities);
    const existing = this.agents.get(descriptor.id);
    if (existing) {
      const sameCaps =
        existing.capabilities.length === capabilities.length &&
        existing.capabilities.every((cap, i) => cap === capabilities[i]);
      if (sameCaps) return existing;
      throw new WorkflowError(
        "CONFLICT",
        `agent "${descriptor.id}" is already registered with different capabilities`,
        { agentId: descriptor.id },
      );
    }
    const record: AgentRecord = {
      id: descriptor.id,
      capabilities,
      registeredAt: now,
      busyWith: null,
      completed: 0,
      failed: 0,
    };
    this.agents.set(descriptor.id, record);
    return record;
  }

  get(id: string): AgentRecord {
    const record = this.agents.get(id);
    if (!record) {
      throw new WorkflowError("NOT_FOUND", `agent "${id}" is not registered`, { agentId: id });
    }
    return record;
  }

  has(id: string): boolean {
    return this.agents.has(id);
  }

  list(): AgentRecord[] {
    return [...this.agents.values()].sort((a, b) =>
      a.registeredAt === b.registeredAt ? a.id.localeCompare(b.id) : a.registeredAt - b.registeredAt,
    );
  }

  findCapable(requires: string[]): AgentRecord[] {
    return this.list().filter(
      (agent) => agent.busyWith === null && requires.every((cap) => agent.capabilities.includes(cap)),
    );
  }

  acquire(agentId: string, taskId: string, _now: number): void {
    const agent = this.get(agentId);
    if (agent.busyWith !== null) {
      throw new WorkflowError(
        "STATE",
        `agent "${agentId}" is already busy with task "${agent.busyWith}"`,
        { agentId, busyWith: agent.busyWith },
      );
    }
    agent.busyWith = taskId;
  }

  release(agentId: string, outcome: "completed" | "failed"): void {
    const agent = this.get(agentId);
    agent.busyWith = null;
    if (outcome === "completed") agent.completed += 1;
    else agent.failed += 1;
  }
}

import type { EngineConfig } from "./types.js";

export function backoffDelay(attempt: number, config: EngineConfig): number {
  const exponential = config.baseBackoffMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(exponential, config.maxBackoffMs);
}

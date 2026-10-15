import { readFile, rename, writeFile, unlink } from "node:fs/promises";
import { dirname, basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import { WorkflowError } from "./errors.js";

export interface PersistedEnvelope<T = unknown> {
  version: 1;
  savedAt: number;
  state: T;
}

export async function saveEngineState(path: string, state: unknown, savedAt = Date.now()): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  const envelope: PersistedEnvelope = { version: 1, savedAt, state };
  try {
    await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function loadEngineState<T = unknown>(path: string): Promise<PersistedEnvelope<T>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new WorkflowError("NOT_FOUND", `state file "${path}" does not exist`, { path });
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WorkflowError("CORRUPTION", `state file "${path}" is not valid JSON`, { path });
  }
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Record<string, unknown>).version !== 1 ||
    typeof (value as Record<string, unknown>).savedAt !== "number" ||
    !("state" in value)
  ) {
    throw new WorkflowError("CORRUPTION", `state file "${path}" has an invalid envelope`, { path });
  }
  return value as PersistedEnvelope<T>;
}

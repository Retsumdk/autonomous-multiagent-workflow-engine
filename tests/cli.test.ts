import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDemo } from "../src/demo.js";

const CLI = new URL("../src/cli.ts", import.meta.url).pathname;

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCli(args: string[]): CliResult {
  const proc = Bun.spawnSync(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    exitCode: proc.exitCode ?? -1,
  };
}

describe("CLI", () => {
  test("demo is deterministic and shows the retry recovery", () => {
    const first = runCli(["demo"]);
    const second = runCli(["demo"]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toBe(second.stdout);
    expect(first.stdout).toContain("Status: succeeded");
    expect(first.stdout).toContain("fact-check");
    expect(first.stdout).toContain("task_retry_scheduled");
    expect(first.stdout).toContain("(recovered after 2 attempts)");
  });

  test("demo() output matches the CLI demo output exactly", async () => {
    expect(await runDemo()).toBe(runCli(["demo"]).stdout.trimEnd());
  });

  test("validate accepts a good spec and rejects a bad one", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amwe-cli-"));
    const good = join(directory, "good.json");
    await writeFile(
      good,
      JSON.stringify({
        name: "pipe",
        tasks: [
          { id: "a", requires: ["x"], dependsOn: [] },
          { id: "b", requires: ["x"], dependsOn: ["a"] },
        ],
      }),
    );
    const ok = runCli(["validate", good]);
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout).toContain("valid: pipe (2 tasks)");

    const bad = join(directory, "bad.json");
    await writeFile(
      bad,
      JSON.stringify({ name: "bad", tasks: [{ id: "a", requires: [], dependsOn: ["ghost"] }] }),
    );
    const rejected = runCli(["validate", bad]);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("VALIDATION");
  });

  test("run executes a workflow and persists state for status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amwe-cli-"));
    const spec = join(directory, "spec.json");
    const state = join(directory, "state.json");
    const agents = join(directory, "agents.json");
    await writeFile(agents, JSON.stringify([{ id: "solo", capabilities: ["x"] }]));
    await writeFile(
      spec,
      JSON.stringify({
        name: "cli-pipeline",
        tasks: [
          { id: "extract", requires: ["x"], dependsOn: [] },
          { id: "load", requires: ["x"], dependsOn: ["extract"] },
        ],
      }),
    );
    const ran = runCli(["run", spec, "--agents", agents, "--state", state]);
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain("run run_0001 (cli-pipeline): succeeded");
    expect(ran.stdout).toContain("[ok] extract");
    expect(ran.stdout).toContain("[ok] load");
    expect(ran.stdout).toContain("state saved to");

    const status = runCli(["status", "--state", state]);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).toContain("cli-pipeline");

    const persisted = JSON.parse(await readFile(state, "utf8"));
    expect(persisted.version).toBe(1);
    expect(persisted.state.runs).toHaveLength(1);
  });

  test("run exits 1 when the workflow cannot settle (unsatisfiable capability)", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amwe-cli-"));
    const spec = join(directory, "stuck.json");
    await writeFile(
      spec,
      JSON.stringify({ name: "stuck", tasks: [{ id: "a", requires: ["impossible"], dependsOn: [] }] }),
    );
    const stuck = runCli(["run", spec]);
    expect(stuck.exitCode).toBe(1);
    expect(stuck.stdout).toContain("run run_0001 (stuck): running");
  });

  test("unknown command and bad argv exit with usage (code 2)", () => {
    const unknown = runCli(["frobnicate"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain("unknown command");
    expect(unknown.stderr).toContain("Usage");

    const badFlag = runCli(["demo", "--nonsense"]);
    expect(badFlag.exitCode).toBe(2);

    const help = runCli(["--help"]);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Usage:");
  });
});

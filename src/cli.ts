#!/usr/bin/env node
import { parseArgs } from "node:util";
import { WorkflowEngine, isWorkflowError } from "./engine.js";
import { echoExecutor } from "./executors.js";
import { systemClock, idFactory } from "./clock.js";
import { loadEngineState, saveEngineState } from "./persistence.js";
import { startServer } from "./server.js";
import { runDemo } from "./demo.js";
import type { WorkflowSpec } from "./types.js";
import { readFileSync } from "node:fs";

const USAGE = `amwe — autonomous multi-agent workflow engine

Usage:
  amwe demo                          Run the deterministic demo workflow
  amwe validate <spec.json>          Validate a workflow spec file
  amwe run <spec.json> [--agents f] [--state f]
                                     Execute a workflow to completion
  amwe status [--state f]            Summarize runs from a state file
  amwe serve [--port N] [--token T] [--state f]
                                     Start the HTTP control server

Options:
  -h, --help  Show this help`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function readSpec(path: string): WorkflowSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read spec file "${path}": ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed as WorkflowSpec;
}

function newEngine(): WorkflowEngine {
  return new WorkflowEngine({
    clock: systemClock().now,
    newId: idFactory(),
    executor: echoExecutor(),
  });
}

async function main(): Promise<number> {
  let argv: string[];
  let values: { port?: string; token?: string; state?: string; agents?: string; help?: boolean };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        port: { type: "string" },
        token: { type: "string" },
        state: { type: "string" },
        agents: { type: "string" },
        help: { type: "boolean", short: "h", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
    argv = parsed.positionals;
    values = parsed.values;
    positionals = argv;
  } catch (error) {
    fail(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const command = positionals[0];
  switch (command) {
    case undefined:
      console.log(USAGE);
      return 0;

    case "demo": {
      if (positionals.length > 1) fail(`unexpected arguments after "demo"\n\n${USAGE}`);
      console.log(await runDemo());
      return 0;
    }

    case "validate": {
      const path = positionals[1];
      if (!path || positionals.length > 2) fail(`usage: amwe validate <spec.json>\n\n${USAGE}`);
      const spec = readSpec(path);
      const engine = newEngine();
      engine.createRun(spec);
      console.log(`valid: ${spec.name} (${spec.tasks.length} tasks)`);
      return 0;
    }

    case "run": {
      const path = positionals[1];
      if (!path || positionals.length > 2) fail(`usage: amwe run <spec.json> [--agents file] [--state file]\n\n${USAGE}`);
      const engine = newEngine();
      if (values.agents) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(values.agents, "utf8"));
        } catch (error) {
          fail(`cannot read agents file "${values.agents}": ${error instanceof Error ? error.message : String(error)}`);
        }
        if (!Array.isArray(parsed)) fail(`agents file "${values.agents}" must be a JSON array of { id, capabilities }`);
        for (const descriptor of parsed as unknown[]) engine.registerAgent(descriptor as Parameters<WorkflowEngine["registerAgent"]>[0]);
      }
      const run = engine.createRun(readSpec(path));
      const result = await engine.drive(run.id, { maxTicks: 10_000 });
      const finished = engine.getRun(run.id);
      console.log(`run ${finished.id} (${finished.name}): ${finished.status}`);
      for (const task of Object.values(finished.tasks)) {
        const marker = task.status === "succeeded" ? "ok" : "no";
        const attempt = task.attempts > 1 ? ` after ${task.attempts} attempts` : "";
        const error = task.error ? ` — ${task.error}` : "";
        console.log(`  [${marker}] ${task.id}: ${task.status}${attempt}${error}`);
      }
      console.log(`ticks: ${result.ticks}, succeeded: ${result.succeeded}, retried: ${result.retried}, skipped: ${result.skipped}`);
      if (values.state) {
        await saveEngineState(values.state, engine.toJSON());
        console.log(`state saved to ${values.state}`);
      }
      return finished.status === "succeeded" ? 0 : 1;
    }

    case "status": {
      if (positionals.length > 1) fail(`usage: amwe status --state <file>\n\n${USAGE}`);
      if (!values.state) fail(`status requires --state <file>\n\n${USAGE}`);
      const envelope = await loadEngineState<Record<string, unknown>>(values.state);
      const engine = WorkflowEngine.fromJSON(envelope.state, {
        clock: systemClock().now,
        newId: idFactory(),
        executor: echoExecutor(),
      });
      for (const run of engine.listRuns()) {
        console.log(`${run.id}  ${run.status.padEnd(9)} ${run.name} (${Object.keys(run.tasks).length} tasks)`);
      }
      if (engine.listRuns().length === 0) console.log("no runs recorded");
      return 0;
    }

    case "serve": {
      if (positionals.length > 1) fail(`usage: amwe serve [--port N] [--token T] [--state file]\n\n${USAGE}`);
      const port = values.port !== undefined ? Number(values.port) : undefined;
      if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65_535)) {
        fail(`--port must be an integer between 0 and 65535\n\n${USAGE}`);
      }
      const engine = newEngine();
      if (values.state) {
        try {
          const envelope = await loadEngineState<Record<string, unknown>>(values.state);
          const restored = WorkflowEngine.fromJSON(envelope.state, {
            clock: systemClock().now,
            newId: idFactory(),
            executor: echoExecutor(),
          });
          for (const agent of restored.registry.list()) engine.registerAgent(agent);
          for (const run of restored.listRuns()) engine.restoreRun(run);
          console.log(`state restored from ${values.state}`);
        } catch (error) {
          if (!isWorkflowError(error) || error.code !== "NOT_FOUND") throw error;
        }
      }
      const running = await startServer(engine, {
        ...(port !== undefined ? { port } : {}),
        ...(values.token !== undefined ? { token: values.token } : {}),
      });
      console.log(`amwe serve listening on http://127.0.0.1:${running.port}`);
      console.log("press Ctrl+C to stop");
      process.on("SIGINT", () => {
        running.close().finally(() => process.exit(0));
      });
      return new Promise(() => undefined);
    }

    default:
      fail(`unknown command "${command}"\n\n${USAGE}`);
  }
}

main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((error: unknown) => {
    if (isWorkflowError(error)) {
      console.error(`${error.code}: ${error.message}`);
      process.exit(1);
    }
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });

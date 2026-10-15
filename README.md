# autonomous-multiagent-workflow-engine

**Self-directed workflow engine for complex multi-agent collaborations.**

[![CI](https://github.com/Retsumdk/autonomous-multiagent-workflow-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/Retsumdk/autonomous-multiagent-workflow-engine/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%E2%89%A518.17-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Dependencies](https://img.shields.io/badge/runtime%20dependencies-0-success)

## The problem

When you coordinate several AI agents on one job, the hard part is never the
individual tasks — it is the *scheduling*:

- Which agent runs which task? Hand-assigning work breaks the moment an agent
  is slow, busy, or missing a capability.
- A task fails transiently (a rate limit, a flaky tool call). Naive pipelines
  either abort the whole run or retry forever.
- A task fails permanently. What happens to the four tasks downstream of it?
  Most ad-hoc orchestration code either hangs or silently produces garbage.
- If the process restarts mid-run, where does the run pick up?

Most orchestration frameworks answer these with YAML graphs, cron triggers, and
a central scheduler that decides everything up front. That works for data
pipelines. It works poorly for agent fleets, where the pool of executors is
dynamic, heterogeneous in capability, and individually unreliable.

## The solution

This engine inverts the usual design: instead of assigning tasks to agents, it
publishes what needs doing and lets **capable agents claim it**, one atomic
claim per agent per tick. Everything else is layered on top of that single
mechanism:

| Concern | Mechanism |
| --- | --- |
| Who runs what | Capability matching — each task declares required capabilities; only agents holding all of them may claim it |
| Transient failure | Per-task retry with **exponential backoff** (`base * 2^(attempt-1)`, capped) |
| Permanent failure | Per-task policy: `retry-until-limit` (default), `skip-and-continue`, or `halt-run` |
| Downstream blast radius | `dependsOn` edges; `skip-and-continue` cascades `skipped` to dependents so they never run on missing input |
| Fairness | One claim per agent per tick — a single-agent fleet still makes progress, never deadlocks |
| History | Append-only **event log** per run (`run_created`, `task_started`, `task_succeeded`, `task_retry_scheduled`, `task_skipped`, `run_succeeded`, …) |
| Durability | `toJSON()` / `fromJSON()` full-state round-trip, plus atomic (`tmp` + rename) persistence helpers |
| Operation | `startServer`: an HTTP control plane (`/healthz`, `/stats`, `/runs`, `/runs/:id/tick`, `/runs/:id/cancel`, `/agents`) |
| CLI | `validate`, `run`, `serve`, `demo` — see below |

Zero runtime dependencies. One executor interface to plug anything into:
an LLM call, a shell command, an HTTP fetch, or a plain function.

## How it works

```
                 ┌─────────────────────────────────────────────┐
                 │                WorkflowEngine               │
                 │                                             │
   specs ──────► │  createRun() ─► validate()                  │
                 │                     │                       │
                 │                RunRecord                    │
                 │                tasks (Map) ── state machine  │
                 │                     │        pending        │
                 │                     ▼         │ ▲ ready      │
                 │  agentRegistry ──► tick()      │ ├ running   │
                 │  (capability    (claim → run → │ ├ succeeded │
                 │   index, one     record event) │ ├ failed    │
                 │   claim/tick)                  │ └ skipped   │
                 │                     │          │             │
                 │                     ▼          ▼             │
                 │             drive() loops ticks              │
                 │             until settled / maxTicks         │
                 │                                             │
                 │  toJSON() ◄───► fromJSON()    persistence    │
                 └─────────────────────────────────────────────┘
```

Per tick the engine does four things, in order:

1. **Promote** — tasks whose dependencies are all `succeeded` become `ready`.
2. **Claim** — each `ready` task is claimed by the first free agent (in
   registration order) that (a) holds every required capability and (b) is not
   already busy. An agent holds at most one task per tick.
3. **Execute** — claimed tasks run through the `Executor` the engine was
   constructed with. Success or failure is recorded as an event.
4. **Reconcile** — per the task's `onExhausted` policy: reschedule with backoff,
   skip the task and cascade `skipped` to everything downstream, or halt the
   run. `drive()` keeps ticking until the run is `succeeded` / `failed` /
   `canceled` or `maxTicks` is exhausted.

Every transition is appended to the run's event log, which is what makes the
state snapshot auditable and replayable.

### Task state machine

```
pending ──(deps succeeded)──► ready ──(claim)──► running ──► succeeded
                                   ▲                 │
                                   └──(retry, backoff─┴──► failed* / skipped
                                   (*retry: returns to ready after backoff)
```

## Getting started

Requires Node.js ≥ 18.17 (or Bun ≥ 1.0). No runtime dependencies.

**Install from GitHub:**

```bash
npm install github:Retsumdk/autonomous-multiagent-workflow-engine
```

> Note: this package is *not* published to the npm registry. Install it
> directly from GitHub as shown (npm runs the `prepare` build automatically).
> A short commit SHA pin (`#<sha>`) is recommended for reproducible builds.

**Or from a clone:**

```bash
git clone https://github.com/Retsumdk/autonomous-multiagent-workflow-engine.git
cd autonomous-multiagent-workflow-engine
npm install        # installs devDependencies (typescript) + builds dist/
npm test           # bun test if you have Bun; tsc build works either way
```

## Quick start

### 1. Run the built-in demo

```bash
node dist/cli.js demo
```

Expected output:

```
Workflow: release-brief
Run: run_0001
Status: succeeded (6 ticks, 5 successful executions, 1 retry)
Tasks:
  succeeded research
  succeeded draft
  succeeded fact-check (recovered after 2 attempts)
  succeeded review
  succeeded publish
```

The demo is fully deterministic — it runs on a fixed clock with a scripted
executor, so this exact output is reproducible offline. `fact-check` fails
once and is recovered by the retry policy.

### 2. Run a workflow from a JSON spec

`examples/content-pipeline.json` declares a five-task editorial pipeline;
`examples/content-pipeline-agents.json` registers the agent pool that
covers its capabilities:

```bash
node dist/cli.js run examples/content-pipeline.json \
  --agents examples/content-pipeline-agents.json
```

Expected output:

```
run run_0001 (content-pipeline): succeeded
  [ok] research: succeeded
  [ok] draft: succeeded
  [ok] fact-check: succeeded
  [ok] review: succeeded
  [ok] publish: succeeded
ticks: 4, succeeded: 5, retried: 0, skipped: 0
```

The spec is validated first — duplicate task ids, cycles, self dependencies,
unknown dependencies, and duplicate capabilities within one task all fail
fast with a precise `VALIDATION` error before any tick happens. (Capability
coverage is checked at scheduling time: a task whose capability no agent
holds simply stays `ready`.)

### 3. Validate a spec without running it

```bash
node dist/cli.js validate examples/content-pipeline.json
# valid: content-pipeline (5 tasks)
```

### 4. Programmatic use

```typescript
import { WorkflowEngine, echoExecutor } from "autonomous-multiagent-workflow-engine";

const engine = new WorkflowEngine({ executor: echoExecutor() });
engine.registerAgent({ id: "worker-1", capabilities: ["fetch", "transform"] });
engine.registerAgent({ id: "worker-2", capabilities: ["transform"] });

const run = engine.createRun({
  name: "pipeline",
  tasks: [
    { id: "fetch", requires: ["fetch"] },
    { id: "transform", requires: ["transform"], dependsOn: ["fetch"] },
    { id: "index", requires: ["transform"], dependsOn: ["fetch"] },
  ],
});

const result = await engine.drive(run.id, { maxTicks: 1000 });
console.log(result.status);  // "succeeded"
console.log(engine.getRun(run.id).tasks["index"]!.output);
```

### 5. HTTP control server

```bash
node dist/cli.js serve --port 8080 --state ./engine-state.json
```

| Endpoint | Purpose |
| --- | --- |
| `GET /healthz` | Liveness probe |
| `GET /stats` | Agent count, run counts by status, event count |
| `GET /agents` | List registered agents |
| `POST /agents` | Register an agent at runtime (`{id, capabilities}`) |
| `GET /runs` | List all runs |
| `POST /runs` | Create a run from a JSON spec (validated, 400 on error) |
| `GET /runs/:id` | Full run record |
| `GET /runs/:id/events` | The run's event log |
| `POST /runs/:id/tick` | Execute one scheduling tick |
| `POST /runs/:id/cancel` | Cancel the run |

Every `POST` route requires a bearer token: start the server with
`--token <secret>` and send `Authorization: Bearer <secret>`. `GET` routes
are read-only and unauthenticated.

```bash
curl -s -X POST localhost:8080/runs \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer <secret>' \
  -d @examples/content-pipeline.json | jq .
```

With `--state` the server loads a previous `engine-state.json` at boot and
restores every agent and run, so a restarted control plane resumes where it
left off. Saving is atomic: the payload is written to `<path>.tmp` and
renamed into place, so a crash mid-write never corrupts the file.

## Failure policies

```json
{
  "tasks": [
    { "id": "scrape", "requires": ["network"], "maxAttempts": 5 },
    { "id": "enrich", "requires": ["nlp"], "dependsOn": ["scrape"], "onExhausted": "skip" },
    { "id": "commit", "requires": ["db"], "dependsOn": ["enrich"] }
  ]
}
```

| `onExhausted` | On final attempt failure | Downstream tasks |
| --- | --- | --- |
| `"fail-run"` (default) | Task `failed`, run fails | Marked `skipped` by the dependency check |
| `"skip"` | Task `skipped` | Cascade to `skipped` too — they are marked skipped before running, never on missing input |

Retries use exponential backoff: attempt *n* waits `base * 2^(n-1)` ms, capped
at `maxBackoffMs` (defaults: base 100 ms, cap 30000 ms, maxAttempts 3).

## Executors

An executor receives a task spec plus a context and returns the task output:

```typescript
import type { Executor } from "autonomous-multiagent-workflow-engine";

const llmExecutor: Executor = async (task, agent, ctx) => {
  const response = await callMyLlm(task.id, agent.id, ctx.attempt);
  return { model: response.model, tokens: response.tokens };
};
```

Three built-in executors ship for offline use: `echoExecutor` (echoes the
task — what the demo, the CLI, and the tests use), `scriptedExecutor`
(deterministic outputs and failure schedules for a fixed task list), and
`simulatedExecutor` (seeded random failures). Every example above runs
offline with no network or API keys.

## Event history

Every state change is recorded with a monotonically increasing sequence:

```typescript
for (const event of engine.eventsFor(run.id)) {
  console.log(event.seq, event.type, event.taskId ?? "");
}
// 0 run_created
// 1 task_ready      fetch
// 2 task_started    fetch
// 3 task_succeeded  fetch
// ...
```

The event log is part of every snapshot, so a restored engine retains the
complete audit trail of past runs.

## Durability

```typescript
import { WorkflowEngine, echoExecutor } from "autonomous-multiagent-workflow-engine";
import { saveEngineState, loadEngineState } from "autonomous-multiagent-workflow-engine";

await saveEngineState("./engine-state.json", engine.toJSON());
const envelope = await loadEngineState<Record<string, unknown>>("./engine-state.json");
const restored = WorkflowEngine.fromJSON(envelope.state, { executor: echoExecutor() });
```

Note that `fromJSON` takes your executor (and optionally `clock`, `newId`,
`config`) — the durable state carries agents, runs, and events, while the
execution behavior is supplied fresh by the host process.

`loadEngineState` validates the envelope `{version, savedAt, state}` and throws
typed errors (`NOT_FOUND`, `CORRUPTION`) instead of returning garbage.

## Project layout

```
src/
  index.ts        public API (all exports)
  types.ts        AgentDescriptor, Executor, WorkflowSpec, TaskSpec, RunRecord, ...
  errors.ts       WorkflowError + VALIDATION / NOT_FOUND / CONFLICT / STATE / CONFIG / CORRUPTION / UNAUTHORIZED
  clock.ts        fixedClock / systemClock / idFactory (deterministic test time)
  registry.ts     agent registry: capability index, one claim per agent per tick
  executors.ts    Executor interface + echo/scripted/simulated executors
  engine.ts       WorkflowEngine: createRun / tick / drive / cancel / toJSON / fromJSON
  persistence.ts  atomic save/load, envelope validation
  server.ts       startServer — HTTP control plane (Node http)
  cli.ts          validate | run | status | serve | demo
  demo.ts         the offline demo scenario
tests/            bun tests (engine, persistence, server, CLI, public API)
examples/         content-pipeline.json — runnable workflow spec
```

## API surface

| Export | Kind | Purpose |
| --- | --- | --- |
| `WorkflowEngine` | class | createRun / tick / drive / cancel / toJSON / fromJSON |
| `startServer` | fn | HTTP control plane (bearer-token protected POSTs) |
| `echoExecutor` / `scriptedExecutor` / `simulatedExecutor` | fn | built-in offline executors |
| `saveEngineState` / `loadEngineState` | fn | atomic durable persistence |
| `validateWorkflowSpec`, `topologicalOrder` | fn | spec validation, deterministic ordering |
| `AgentRegistry`, `validateAgentDescriptor` | class / fn | agent registry + validation |
| `fixedClock` / `systemClock` / `idFactory` | fn | deterministic clocks and id generation |
| `WorkflowError`, `WorkflowErrorCode` | class / type | typed error taxonomy |

## Scripts

| Script | What it does |
| --- | --- |
| `npm run build` | `tsc -p tsconfig.json` → `dist/` with declarations |
| `npm test` | Bun test suite |
| `npm start` | `node dist/cli.js` (CLI entry) |
| `npm run prepare` | Build on install — this is what makes GitHub installs work |

## CI

GitHub Actions runs on every push and PR: the full Bun test suite, strict
`tsc --noEmit` over `src/` **and** `tests/`, the production build, and a Node
smoke test that validates and runs the example workflow end-to-end — on
Node 18, 20, and 22.

## License

[MIT](./LICENSE) © 2026 Retsumdk

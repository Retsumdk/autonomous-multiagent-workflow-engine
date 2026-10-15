import { describe, expect, test } from "bun:test";
import { WorkflowEngine } from "../src/engine.js";
import { echoExecutor } from "../src/executors.js";
import { fixedClock, idFactory } from "../src/clock.js";
import { startServer } from "../src/server.js";
import type { RunningServer } from "../src/server.js";

const TOKEN = "test-token-0123456789abcdef";

async function makeServer(engine: WorkflowEngine): Promise<RunningServer> {
  return startServer(engine, { port: 0, token: TOKEN });
}

function makeEngine(): WorkflowEngine {
  const clock = fixedClock(1_767_225_600_000);
  return new WorkflowEngine({ clock: () => clock.now(), newId: idFactory(), executor: echoExecutor() });
}

async function request(
  base: string,
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${base}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe("HTTP server", () => {
  test("full lifecycle: register agent, create run, tick, fetch run and events", async () => {
    const engine = makeEngine();
    const running = await makeServer(engine);
    try {
      const base = `http://127.0.0.1:${running.port}`;

      const health = await request(base, "/healthz");
      expect(health.status).toBe(200);
      expect(health.body.ok).toBe(true);

      const unauth = await request(base, "/agents", {
        method: "POST",
        body: { id: "w1", capabilities: ["x"] },
      });
      expect(unauth.status).toBe(401);
      expect(unauth.body.error).toBe("unauthorized");

      const badToken = await request(base, "/agents", {
        method: "POST",
        token: "wrong-token-0123456789abcdef",
        body: { id: "w1", capabilities: ["x"] },
      });
      expect(badToken.status).toBe(401);

      const agent = await request(base, "/agents", {
        method: "POST",
        token: TOKEN,
        body: { id: "w1", capabilities: ["x"] },
      });
      expect(agent.status).toBe(201);
      expect((agent.body.agent as Record<string, unknown>).id).toBe("w1");

      const badRun = await request(base, "/runs", {
        method: "POST",
        token: TOKEN,
        body: { name: "bad", tasks: [{ id: "a", requires: [], dependsOn: ["ghost"] }] },
      });
      expect(badRun.status).toBe(400);
      expect(badRun.body.error).toBe("validation");

      const created = await request(base, "/runs", {
        method: "POST",
        token: TOKEN,
        body: {
          name: "http-run",
          tasks: [{ id: "a", requires: ["x"], dependsOn: [] }],
        },
      });
      expect(created.status).toBe(201);
      const runId = (created.body.run as Record<string, unknown>).id as string;

      const listed = await request(base, "/runs");
      expect(listed.status).toBe(200);
      expect((listed.body.runs as unknown[]).length).toBe(1);

      const ticked = await request(base, `/runs/${runId}/tick`, { method: "POST", token: TOKEN });
      expect(ticked.status).toBe(200);
      const run = ticked.body.run as Record<string, unknown>;
      expect(run.status).toBe("succeeded");

      const fetched = await request(base, `/runs/${runId}`);
      expect(fetched.status).toBe(200);
      expect((fetched.body.run as Record<string, unknown>).status).toBe("succeeded");

      const events = await request(base, `/runs/${runId}/events`);
      expect(events.status).toBe(200);
      expect((events.body.events as unknown[]).length).toBeGreaterThan(0);

      const stats = await request(base, "/stats");
      expect(stats.status).toBe(200);
      expect((stats.body.agents as number)).toBe(1);
    } finally {
      await running.close();
    }
  });

  test("cancel, 404, and malformed bodies behave correctly", async () => {
    const engine = makeEngine();
    const running = await makeServer(engine);
    try {
      const base = `http://127.0.0.1:${running.port}`;

      const missingRoute = await request(base, "/nope");
      expect(missingRoute.status).toBe(404);
      expect(missingRoute.body.error).toBe("not_found");

      const missingRun = await request(base, "/runs/run_zzzz");
      expect(missingRun.status).toBe(404);
      expect(missingRun.body.error).toBe("not_found");

      const response = await fetch(`${base}/runs`, {
        method: "POST",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
        body: "{not json",
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.error).toBe("validation");

      const noAgent = await request(base, "/runs", {
        method: "POST",
        token: TOKEN,
        body: { name: "n", tasks: [{ id: "a", requires: ["x"], dependsOn: [] }] },
      });
      const runId = (noAgent.body.run as Record<string, unknown>).id as string;
      const canceled = await request(base, `/runs/${runId}/cancel`, { method: "POST", token: TOKEN });
      expect(canceled.status).toBe(200);
      expect((canceled.body.run as Record<string, unknown>).status).toBe("canceled");

      const tickAfterCancel = await request(base, `/runs/${runId}/tick`, { method: "POST", token: TOKEN });
      expect(tickAfterCancel.status).toBe(409);
      expect(tickAfterCancel.body.error).toBe("state");
    } finally {
      await running.close();
    }
  });
});

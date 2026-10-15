import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WorkflowEngine, isWorkflowError } from "./engine.js";
import { WorkflowError } from "./errors.js";
import type { WorkflowSpec } from "./types.js";

const BODY_LIMIT = 1_048_576;

export interface ServerOptions {
  port?: number;
  token?: string;
}

export interface RunningServer {
  server: Server;
  port: number;
  close(): Promise<void>;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) throw new WorkflowError("VALIDATION", "request body exceeds 1 MiB");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new WorkflowError("VALIDATION", "request body must be valid JSON");
  }
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  if (!token) return false;
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export async function startServer(engine: WorkflowEngine, options: ServerOptions = {}): Promise<RunningServer> {
  const token = options.token;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://localhost");
      const method = request.method ?? "GET";
      const path = url.pathname;
      if (method === "GET" && path === "/healthz") return sendJson(response, 200, { ok: true });
      if (method === "GET" && path === "/stats") return sendJson(response, 200, engine.stats());
      if (method === "GET" && path === "/agents") return sendJson(response, 200, { agents: engine.registry.list() });

      if (method === "POST" && ["/agents", "/runs"].includes(path)) {
        if (!authorized(request, token)) throw new WorkflowError("UNAUTHORIZED", "valid bearer token required");
        const body = await readJson(request) as Record<string, unknown>;
        if (path === "/agents") {
          const agent = engine.registerAgent({
            id: body.id as string,
            capabilities: body.capabilities as string[],
          });
          return sendJson(response, 201, { agent });
        }
        const run = engine.createRun(body as unknown as WorkflowSpec);
        return sendJson(response, 201, { run: engine.serializeRun(run) });
      }

      if (method === "GET" && path === "/runs") {
        return sendJson(response, 200, { runs: engine.listRuns().map((run) => engine.serializeRun(run)) });
      }

      const runMatch = /^\/runs\/([^/]+)$/.exec(path);
      if (method === "GET" && runMatch) {
        const run = engine.getRun(decodeURIComponent(runMatch[1]!));
        return sendJson(response, 200, { run: engine.serializeRun(run) });
      }

      const eventsMatch = /^\/runs\/([^/]+)\/events$/.exec(path);
      if (method === "GET" && eventsMatch) {
        return sendJson(response, 200, { events: engine.eventsFor(decodeURIComponent(eventsMatch[1]!)) });
      }

      const actionMatch = /^\/runs\/([^/]+)\/(tick|cancel)$/.exec(path);
      if (method === "POST" && actionMatch) {
        if (!authorized(request, token)) throw new WorkflowError("UNAUTHORIZED", "valid bearer token required");
        const runId = decodeURIComponent(actionMatch[1]!);
        if (actionMatch[2] === "tick") {
          const result = await engine.tick(runId);
          return sendJson(response, 200, { result, run: engine.serializeRun(engine.getRun(runId)) });
        }
        const run = engine.cancelRun(runId);
        return sendJson(response, 200, { run: engine.serializeRun(run) });
      }

      return sendJson(response, 404, { error: "not_found", message: `no route for ${method} ${path}` });
    } catch (error) {
      if (isWorkflowError(error)) {
        return sendJson(response, error.httpStatus, {
          error: error.code.toLowerCase(),
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return sendJson(response, 500, { error: "internal", message: error instanceof Error ? error.message : String(error) });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to a TCP port");
  return {
    server,
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildDashboardData, renderDashboard, storeDirFor } from "@smr/core";
import { ApiError, runOperation, type ApiContext } from "./api.js";

/**
 * Local HTTP API (generic adapter for custom agents, scripts, dashboards).
 * Binds to 127.0.0.1 only. Optional bearer token via SMR_API_TOKEN.
 *
 *   GET  /health                 GET  /models          GET /usage  (alias /analytics)
 *   POST /tasks/classify         POST /tasks/route     POST /tasks/execute
 *   POST /tasks                  (start)               POST /tasks/evaluate
 *   POST /tasks/:id/attempts     GET  /tasks/:id/next  POST /tasks/:id/handoff
 *   GET  /tasks/:id              GET  /dashboard       (HTML)
 */

const MAX_BODY = 1_000_000;

type Route = { method: string; pattern: RegExp; op: string; build: (m: RegExpMatchArray, body: any) => unknown };

const ROUTES: Route[] = [
  { method: "GET", pattern: /^\/models$/, op: "smr_models", build: () => ({}) },
  { method: "GET", pattern: /^\/(usage|analytics)$/, op: "smr_report", build: () => ({}) },
  { method: "POST", pattern: /^\/tasks\/classify$/, op: "smr_classify", build: (_m, b) => b },
  { method: "POST", pattern: /^\/tasks\/route$/, op: "smr_route", build: (_m, b) => b },
  { method: "POST", pattern: /^\/tasks\/execute$/, op: "smr_execute", build: (_m, b) => b },
  { method: "POST", pattern: /^\/tasks\/evaluate$/, op: "smr_verify", build: (_m, b) => b },
  { method: "POST", pattern: /^\/tasks$/, op: "smr_task_start", build: (_m, b) => b },
  { method: "POST", pattern: /^\/tasks\/([\w-]+)\/attempts$/, op: "smr_task_attempt", build: (m, b) => ({ ...b, taskId: m[1] }) },
  { method: "GET", pattern: /^\/tasks\/([\w-]+)\/next$/, op: "smr_task_next", build: (m) => ({ taskId: m[1] }) },
  { method: "POST", pattern: /^\/tasks\/([\w-]+)\/handoff$/, op: "smr_task_handoff", build: (m, b) => ({ ...b, taskId: m[1] }) },
];

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Browser-attack guards (a web page you visit can send requests to 127.0.0.1):
 *  - Host must be a loopback name      → blocks DNS-rebinding
 *  - Origin, if present, must be local → blocks cross-site requests
 *  - POST bodies must be application/json → forces a CORS preflight, which we never approve
 */
export function rejectUnsafe(req: IncomingMessage): { status: number; error: string } | undefined {
  const hostName = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
  if (!LOCAL_HOSTS.has(hostName)) return { status: 403, error: "forbidden host" };
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    try {
      if (!LOCAL_HOSTS.has(new URL(origin).hostname.toLowerCase())) return { status: 403, error: "cross-origin request refused" };
    } catch { return { status: 403, error: "bad origin" }; }
  } else if (origin === "null") return { status: 403, error: "cross-origin request refused" };
  if (req.method === "POST" && !/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return { status: 415, error: "content-type must be application/json" };
  if (req.method !== "GET" && req.method !== "POST") return { status: 405, error: "method not allowed" };
  return undefined;
}

export function createHttpServer(ctx: ApiContext, opts: { token?: string } = {}): Server {
  const token = opts.token ?? process.env.SMR_API_TOKEN;
  return createServer(async (req, res) => {
    try {
      const unsafe = rejectUnsafe(req);
      if (unsafe) return send(res, unsafe.status, { error: unsafe.error });
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, service: "smart-model-router", store: ctx.store().backend });
      if (token && !authorized(req, token)) return send(res, 401, { error: "unauthorized" });
      if (req.method === "GET" && url.pathname === "/dashboard") {
        const dir = join(storeDirFor(ctx.cfg), "benchmarks");
        const benches = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(dir, f), "utf8"))) : [];
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'" });
        return void res.end(renderDashboard(buildDashboardData(ctx.store(), ctx.registry, benches)));
      }

      const taskShow = url.pathname.match(/^\/tasks\/([\w-]+)$/);
      if (req.method === "GET" && taskShow) {
        const rec = ctx.store().getTask(taskShow[1]!);
        return rec ? send(res, 200, rec) : send(res, 404, { error: "task not found" });
      }

      for (const r of ROUTES) {
        const m = url.pathname.match(r.pattern);
        if (!m || r.method !== req.method) continue;
        const body = req.method === "POST" ? await readJson(req) : {};
        return send(res, 200, await runOperation(ctx, r.op, r.build(m, body)));
      }
      send(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
    } catch (e) {
      const status = e instanceof ApiError ? e.status : /unknown task id|Unknown task id/.test((e as Error).message) ? 404 : 500;
      send(res, status, { error: (e as Error).message });
    }
  });
}

export function startHttpServer(ctx: ApiContext, port = 4317, host = "127.0.0.1"): Promise<{ server: Server; url: string }> {
  const server = createHttpServer(ctx);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const p = typeof addr === "object" && addr ? addr.port : port;
      resolve({ server, url: `http://${host}:${p}` });
    });
  });
}

function authorized(req: IncomingMessage, token: string): boolean {
  const got = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(got);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new ApiError(413, "body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new ApiError(400, "invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

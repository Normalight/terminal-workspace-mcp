import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import process from "node:process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { HttpTransport } from "./http-transport.mjs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LocalCommandExecutor } from "./local-executor.mjs";
import { JobManager } from "./job-manager.mjs";
import { TerminalManager } from "./terminal-manager.mjs";
import { childEnvironment } from "./runtime.mjs";
import { registerTools } from "./tools.mjs";
import { execFileSync } from "node:child_process";
import { LogWriter } from "./log-store.mjs";
import { Workspace, WorkspaceError } from "./workspace.mjs";
import { loadConfig } from "./config.mjs";

const deployment = loadConfig();
const settings = deployment.config;
Object.assign(process.env, deployment.env);
const workspaceRoot = settings.workspaceRoot;
const { host, port, path: endpoint, allowAnonymous } = settings.http;
const authToken = deployment.env.MCP_AUTH_TOKEN;
const allowedHosts = new Set(settings.http.allowedHosts);
const { enableWrite, enableTerminal, profile: toolProfile } = settings.tools;
const { maxBytes: maxFileBytes, directMaxBytes: directFileMaxBytes } = settings.files;
if (!authToken && !allowAnonymous) throw new Error("Set the configured authentication token or explicitly enable http.allowAnonymous for local-only testing");
if (allowAnonymous && process.env.MCP_NO_HTTP !== "1" && !["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("Anonymous HTTP is only permitted on loopback");
if (enableTerminal && !authToken) throw new Error("Terminal execution requires an authentication token");
const workspace = await new Workspace(workspaceRoot, { enableWrite }).initialize();
const jobRoot = settings.paths.jobs;
const childEnv = childEnvironment(workspace.root);
await mkdir(childEnv.TMPDIR, { recursive: true });
const logsConfig = settings.logs;
const jobManager = await new JobManager({ root: jobRoot, shell: settings.terminal.shell, maxJobs: settings.jobs.maxCount, maxRunning: settings.jobs.maxRunning, retentionDays: settings.jobs.retentionDays, ...logsConfig }).initialize();
const localExecutor = new LocalCommandExecutor({ jobManager, maxTimeoutMs: settings.terminal.maxWaitMs, maxOutputBytes: settings.terminal.maxOutputBytes });
const terminalManager = await new TerminalManager({ root: settings.paths.terminals, env: childEnv, maxSessions: settings.terminal.maxSessions, ...logsConfig }).initialize();
let revision = "unknown";
try { revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 2000 }).trim(); } catch {}
const version = "0.4.0";
const maxSessions = settings.http.sessions.max;
let toolCount = 0;
const sessions = new Map();
const startedAt = Date.now();
const sessionIdleTtlMs = settings.http.sessions.idleTtlMs;
const sessionGcIntervalMs = settings.http.sessions.gcIntervalMs;
const auditLogPath = settings.paths.audit;
const compressionConfig = settings.http.compression;
const runtimeCounters = {
  compressedResponses: 0, compressionOriginalBytes: 0, compressionWireBytes: 0,
  httpRequests: 0, httpErrors: 0, sessionsCreated: 0, sessionsClosed: 0,
  sessionsExpired: 0, unknownSessionRequests: 0, oversizedDirectFilesDenied: 0,
};

function sessionHash(id) {
  if (!id) return null;
  return createHash("sha256").update(String(id)).digest("hex").slice(0, 16);
}

const auditWriter = new LogWriter(auditLogPath, { segmentBytes: 8388608, maxSegments: 8 });
auditWriter.on("error", error => console.error("[http-audit-write-error]", error.message));
let auditDropped = 0;
async function auditHttp(entry) {
  if (auditWriter.destroyed || auditWriter.writableLength > 1048576) { auditDropped++; return; }
  auditWriter.write(JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + "\n");
}

function sessionStats() {
  const now = Date.now();
  let inflight = 0;
  let oldestIdleMs = 0;
  for (const session of sessions.values()) {
    inflight += session.inflight ?? 0;
    oldestIdleMs = Math.max(oldestIdleMs, now - (session.lastActiveAt ?? session.createdAt ?? now));
  }
  return { active: sessions.size, inflight, oldestIdleMs };
}

export function createMcpServer() {
  const server = new McpServer({
    name: "terminal-workspace",
    version,
    instructions: "Personal remote terminal. Use execute_command for shell commands and reuse its sessionId to preserve state. Poll with sessionId/cursor, send input or key=C-c for interaction. Use ordinary shell commands for files, search, Git and task management. get_file retrieves original files or chunks. wait/output limits never terminate the shell. tmux persists across MCP restarts. Absolute and ~/ paths use the service account permissions.",
  });
  registerTools(server, { workspace, executor: localExecutor, jobs: jobManager, terminals: terminalManager,
    config: { enableTerminal, enableWrite, directFileMaxBytes, childEnv, version, toolProfile },
    diagnostics: async () => ({ version, revision, toolCount, toolProfile, workspace: workspace.root, writesEnabled: enableWrite, terminalEnabled: enableTerminal, sessions: sessionStats(), counters: runtimeCounters, auditDropped, jobs: await jobManager.list({ limit: 10 }), limits: { maxSessions, directFileMaxBytes, ...logsConfig } }),
  });
  toolCount = Object.keys(server._registeredTools).length;
  return server;
}

function authorized(req) {
  if (allowAnonymous) return true;
  const header = req.headers.authorization ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(authToken);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function hostAllowed(req) {
  return allowedHosts.size === 0 || allowedHosts.has(req.headers.host ?? "");
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 2 * 1024 * 1024) throw new WorkspaceError("request body exceeds 2 MiB", "request_too_large");
    chunks.push(chunk);
  }
  if (size === 0) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new WorkspaceError("request body is not valid JSON", "invalid_json"); }
}

async function handleMcp(req, res) {
  const requestId = randomUUID();
  const began = Date.now();
  runtimeCounters.httpRequests += 1;
  const sessionId = req.headers["mcp-session-id"];
  const hashedSession = sessionHash(sessionId);
  let statusCode = 200;
  let methodName = null;
  let toolName = null;
  let requestBytes = 0;
  let responseBytes = 0;

  const chunkBytes = (chunk, encoding) => {
    if (chunk === undefined || chunk === null) return 0;
    if (Buffer.isBuffer(chunk) || chunk instanceof Uint8Array) return chunk.byteLength;
    return Buffer.byteLength(String(chunk), typeof encoding === "string" ? encoding : undefined);
  };
  const originalWriteHead = res.writeHead.bind(res);
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  res.writeHead = (status, ...args) => {
    statusCode = status;
    return originalWriteHead(status, ...args);
  };
  res.write = (chunk, encoding, callback) => {
    responseBytes += chunkBytes(chunk, encoding);
    return originalWrite(chunk, encoding, callback);
  };
  res.end = (chunk, encoding, callback) => {
    responseBytes += chunkBytes(chunk, encoding);
    return originalEnd(chunk, encoding, callback);
  };
  res.once("finish", () => {
    if (statusCode >= 400) runtimeCounters.httpErrors += 1;
    void auditHttp({
      requestId,
      httpMethod: req.method,
      rpcMethod: methodName,
      toolName,
      session: hashedSession,
      statusCode,
      durationMs: Date.now() - began,
      requestBytes,
      responseBytes,
      ...(res.compressionStats ? { compression: res.compressionStats } : {}),
    });
  });

  if (!authorized(req)) {
    sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
    return;
  }
  if (!hostAllowed(req)) {
    sendJson(res, 403, { error: "host is not allowed" });
    return;
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await readBody(req);
      requestBytes = Buffer.byteLength(JSON.stringify(body ?? null));
      methodName = typeof body?.method === "string" ? body.method : null;
      toolName = methodName === "tools/call" && typeof body?.params?.name === "string" ? body.params.name : null;
    } catch (error) {
      sendJson(res, 400, { error: error.message });
      return;
    }
    let session = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && !session) {
      runtimeCounters.unknownSessionRequests += 1;
      sendJson(res, 404, { error: "unknown MCP session" });
      return;
    }
    if (!session) {
      if (sessions.size >= maxSessions) { sendJson(res, 503, { error: "session limit reached" }); return; }
      let transport;
      const server = createMcpServer();
      session = { server, transport: null, createdAt: Date.now(), lastActiveAt: Date.now(), inflight: 0 };
      transport = new HttpTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => {
          const now = Date.now();
          sessions.set(id, session);
          runtimeCounters.sessionsCreated += 1;
          void auditHttp({ event: "session_created", session: sessionHash(id) });
        },
        onsessionclosed: (id) => {
          if (sessions.delete(id)) {
            runtimeCounters.sessionsClosed += 1;
            void auditHttp({ event: "session_closed", session: sessionHash(id) });
          }
        },
      }, { ...compressionConfig, onResult: stats => {
        if (stats.encoding === "gzip") runtimeCounters.compressedResponses++;
        runtimeCounters.compressionOriginalBytes += stats.originalBytes;
        runtimeCounters.compressionWireBytes += stats.wireBytes;
      } });
      session.transport = transport;
      await server.connect(transport);
    }
    session.lastActiveAt = Date.now();
    session.inflight = (session.inflight ?? 0) + 1;
    try {
      await session.transport.handleNodeRequest(req, res, body);
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: "MCP request failed" });
      console.error(error);
    } finally {
      session.inflight = Math.max(0, (session.inflight ?? 1) - 1);
      session.lastActiveAt = Date.now();
    }
    return;
  }

  if (req.method === "GET" || req.method === "DELETE") {
    if (!sessionId || !sessions.has(sessionId)) {
      runtimeCounters.unknownSessionRequests += 1;
      sendJson(res, 404, { error: "unknown MCP session" });
      return;
    }
    const session = sessions.get(sessionId);
    session.lastActiveAt = Date.now();
    session.inflight = (session.inflight ?? 0) + 1;
    try {
      await session.transport.handleNodeRequest(req, res);
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: "MCP request failed" });
      console.error(error);
    } finally {
      session.inflight = Math.max(0, (session.inflight ?? 1) - 1);
      session.lastActiveAt = Date.now();
    }
    return;
  }
  sendJson(res, 405, { error: "method not allowed" }, { allow: "GET, POST, DELETE" });
}

if (process.env.MCP_NO_HTTP !== "1") {
  createMcpServer(); // Establish the advertised tool count before the first session.
  const httpServer = createHttpServer((req, res) => {
    void (async () => {
    // Validate headers within this boundary; malformed input must not terminate the process.
    if (req.headers.host) new URL(`http://${req.headers.host}`);
    const requestUrl = new URL(req.url ?? "/", "http://localhost");
    if (requestUrl.pathname === "/healthz") {
      sendJson(res, 200, {
        ok: true,
        service: "terminal-workspace-mcp",
        version, revision, toolCount, toolProfile,
        compression: compressionConfig,
        configFile: deployment.configFile,
        workspace: workspace.root,
        writesEnabled: enableWrite,
        commandEnabled: enableTerminal,
        maxFileBytes,
        directFileMaxBytes,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        sessions: sessionStats(),
        counters: runtimeCounters,
        jobRoot,
      });
      return;
    }
    if (requestUrl.pathname === "/metrics") {
      sendJson(res, 200, {
        service: "terminal-workspace-mcp",
        version, revision, toolCount, toolProfile,
        compression: compressionConfig,
        configFile: deployment.configFile,
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        sessions: sessionStats(),
        counters: runtimeCounters,
        limits: { maxFileBytes, directFileMaxBytes, sessionIdleTtlMs, sessionGcIntervalMs },
        jobRoot,
      });
      return;
    }
    if (requestUrl.pathname !== endpoint) {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    await handleMcp(req, res);
    })().catch(error => {
      if (!res.headersSent && !res.destroyed) sendJson(res, error instanceof TypeError ? 400 : 500, { error: "invalid or failed HTTP request" });
      else if (!res.destroyed) res.end();
      console.error("[http-request-error]", error.message);
    });
  });

  httpServer.listen(port, host, () => {
    console.error(`terminal-workspace-mcp listening on http://${host}:${port}${endpoint}`);
    console.error(`workspace=${workspace.root} writes=${enableWrite} command=${enableTerminal} auth=${authToken ? "bearer" : "anonymous"}`);
    console.error(`sessionIdleTtlMs=${sessionIdleTtlMs} directFileMaxBytes=${directFileMaxBytes} auditLog=${auditLogPath}`);
  });

  const gcTimer = setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions.entries()) {
      const idleMs = now - (session.lastActiveAt ?? session.createdAt ?? now);
      if ((session.inflight ?? 0) === 0 && idleMs >= sessionIdleTtlMs) {
        sessions.delete(id);
        runtimeCounters.sessionsExpired += 1;
        void session.transport.close().catch(() => {});
        void auditHttp({ event: "session_expired", session: sessionHash(id), idleMs });
      }
    }
  }, sessionGcIntervalMs);
  gcTimer.unref();

  async function shutdown() {
    clearInterval(gcTimer);
    for (const { transport } of sessions.values()) await transport.close().catch(() => {});
    auditWriter.end();
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import process from "node:process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { InitializeRequestSchema, JSONRPCRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { HttpSessionPool } from "./http-session-pool.mjs";
import { HttpTransport } from "./http-transport.mjs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LocalCommandExecutor } from "./local-executor.mjs";
import { JobManager } from "./job-manager.mjs";
import { TerminalManager } from "./terminal-manager.mjs";
import { TerminalAdmin } from "./terminal-admin.mjs";
import { childEnvironment } from "./runtime.mjs";
import { registerTools } from "./tools.mjs";
import { CompletionNotifications } from "./completion-notifications.mjs";
import { execFileSync } from "node:child_process";
import { LogWriter } from "./log-store.mjs";
import { Workspace, WorkspaceError } from "./workspace.mjs";
import { serviceLogging } from "./service-logging.mjs";
import { terminalDescription } from "./terminal-tool.mjs";
import { loadConfig } from "./config.mjs";
import { ServerLifecycle, restartingCode, rejectedRecovery } from './server-lifecycle.mjs';
import { requestAudit } from './request-audit.mjs';
import { BotmuxCompletionWatcher } from './botmux-completion-watcher.mjs';
import path from 'node:path';

const deployment = loadConfig(process.env.MCP_ISOLATED_SERVICE === '1' ? { env: { MCP_CONFIG_FILE: process.env.MCP_CONFIG_FILE } } : undefined);
const settings = deployment.config;
const noHttp = process.env.MCP_ISOLATED_SERVICE !== '1' && process.env.MCP_NO_HTTP === '1';
const finishLogging = serviceLogging("server", settings.paths.service);
const lifecycle = new ServerLifecycle();
Object.assign(process.env, deployment.env);
const workspaceRoot = settings.workspaceRoot;
const { host, port, path: endpoint, allowAnonymous } = settings.http;
const authToken = deployment.env.MCP_AUTH_TOKEN;
const allowedHosts = new Set(settings.http.allowedHosts);
const { enableWrite, enableTerminal, profile: toolProfile } = settings.tools;
const { maxBytes: maxFileBytes, directMaxBytes: directFileMaxBytes } = settings.files;
if (!authToken && !allowAnonymous) throw new Error("Set the configured authentication token or explicitly enable http.allowAnonymous for local-only testing");
if (allowAnonymous && !noHttp && !["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("Anonymous HTTP is only permitted on loopback");
if (enableTerminal && !authToken) throw new Error("Terminal execution requires an authentication token");
const workspace = await new Workspace(workspaceRoot, { enableWrite }).initialize();
const jobRoot = settings.paths.jobs;
const childEnv = childEnvironment(workspace.root);
delete childEnv[settings.auth.tokenEnv];
delete childEnv[settings.client.tokenEnv];
await mkdir(childEnv.TMPDIR, { recursive: true });
const logsConfig = settings.logs;
const jobManager = await new JobManager({ root: jobRoot, shell: settings.terminal.shell, maxJobs: settings.jobs.maxCount, maxRunning: settings.jobs.maxRunning, retentionDays: settings.jobs.retentionDays, ...logsConfig }).initialize();
const localExecutor = new LocalCommandExecutor({ jobManager, maxTimeoutMs: settings.terminal.maxWaitMs, maxOutputBytes: settings.terminal.maxOutputBytes });
const terminalManager = await new TerminalManager({ root: settings.paths.terminals, env: childEnv, maxSessions: settings.terminal.maxSessions, ...logsConfig }).initialize();
const backgroundNotifications = await new BotmuxCompletionWatcher({ config: settings.notifications.botmux,
  root: path.join(settings.paths.service, 'botmux-notifications'), terminals: terminalManager, env: childEnv, cwd: workspace.root }).initialize();
const terminalAdmin = new TerminalAdmin(terminalManager);
let terminalGcRunning = false;
const terminalGcTimer = setInterval(async () => {
  if (terminalGcRunning) return;
  terminalGcRunning = true;
  try {
    const result = await terminalAdmin.cleanup({ apply: true, idleTtlMs: settings.terminal.idleTtlMs });
    if (result.removed.length) console.error('[terminal-gc]', JSON.stringify({ removed: result.removed, logsRetained: true }));
  } catch (error) { console.error('[terminal-gc-error]', error.message); }
  finally { terminalGcRunning = false; }
}, settings.terminal.gcIntervalMs);
terminalGcTimer.unref();
let revision = "unknown";
try { revision = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 2000 }).trim(); } catch {}
const version = "0.5.9";
const maxSessions = settings.http.sessions.max;
let toolCount = 0;
const startedAt = Date.now();
const sessionIdleTtlMs = settings.http.sessions.idleTtlMs;
const sessionGcIntervalMs = settings.http.sessions.gcIntervalMs;
const auditLogPath = settings.paths.audit;
const compressionConfig = settings.http.compression;
const runtimeCounters = {
  compressedResponses: 0, compressionOriginalBytes: 0, compressionWireBytes: 0,
  httpRequests: 0, httpErrors: 0, httpAborted: 0, sessionsCreated: 0, sessionsClosed: 0,
  sessionsExpired: 0, sessionsEvicted: 0, sessionsRejected: 0, unknownSessionRequests: 0, oversizedDirectFilesDenied: 0,
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

const sessionPool = new HttpSessionPool({ ...settings.http.sessions,
  onRemove: (id, session, reason, idleMs) => {
    const counter = { expired: 'sessionsExpired', capacity: 'sessionsEvicted', closed: 'sessionsClosed' }[reason];
    if (counter) runtimeCounters[counter]++;
    void auditHttp({ event: reason === 'capacity' ? 'session_evicted' : `session_${reason}`, session: sessionHash(id), idleMs, reason });
    if (reason !== 'closed') void session.transport.close().catch(error => console.error('[session-close-error]', error.message));
  },
});
const sessions = sessionPool.sessions;
const sessionStats = () => sessionPool.stats();

export function createMcpServer() {
  const server = new McpServer({
    name: "terminal-workspace",
    version,
  }, {
    capabilities: { logging: {} },
    instructions: `${terminalDescription} Prefer absolute paths. Idle shells expire after ${settings.terminal.idleTtlMs}ms (0 disables expiry); active tasks and kept sessions are protected. Save task IDs/cursors and artifact paths in persistent checkpoints for handoff.`,
  });
  const completions = new CompletionNotifications({ terminals: terminalManager, jobs: jobManager,
    ready: () => !!server.server.transport && (server.server.transport.notificationStreamOpen ?? true),
    send: async params => {
      const id = server.server.transport?.sessionId;
      if (server.server.isMessageIgnored(params.level, id)) return false;
      await server.sendLoggingMessage(params, id);
      return true;
    },
  });
  server.server.onclose = () => completions.close();
  registerTools(server, { workspace, executor: localExecutor, jobs: jobManager, terminals: terminalManager, completions, backgroundNotifications,
    config: { enableTerminal, enableWrite, directFileMaxBytes, childEnv, version, toolProfile, waitSignal: lifecycle.signal, foregroundBudgetMs: settings.terminal.foregroundBudgetMs },
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

function unknownSession(res) {
  sendJson(res, 404, { error: 'unknown MCP session', code: 'mcp_session_expired',
    recovery: { initializeWithoutSessionId: true, resubscribeWithSavedTaskIds: true, replayCommand: false } });
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
  if (req.method !== 'GET') lifecycle.track(res);
  // Finite RPCs can preserve MCP sessions without reusing an idle TCP socket.
  // SSE GET stays open. Explicit closure avoids stale keep-alive reuse by relays.
  if (req.method !== 'GET' && settings.http.closeFiniteConnections) res.setHeader('connection', 'close');
  const requestId = randomUUID();
  const auditContext = { requestId, maxToolWaitMs: settings.http.maxToolWaitMs, emit: entry => { void auditHttp(entry); }, tool: {} };
  res.setHeader('x-request-id', requestId);
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
      responseFinished: true,
      ...auditContext.tool,
      ...(res.compressionStats ? { compression: res.compressionStats } : {}),
    });
  });
  res.once('close', () => {
    if (res.writableFinished) return;
    if (req.method !== 'GET') runtimeCounters.httpAborted++;
    // A missing reply does not establish that a tools/call never executed.
    void auditHttp({ event: req.method === 'GET' ? 'sse_disconnected' : 'http_aborted', requestId, httpMethod: req.method,
      rpcMethod: methodName, toolName, session: hashedSession,
      statusCode: null, responseFinished: false, durationMs: Date.now() - began, requestBytes, responseBytes, ...auditContext.tool });
  });

  if (!authorized(req)) {
    sendJson(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });
    return;
  }
  if (!hostAllowed(req)) {
    sendJson(res, 403, { error: "host is not allowed" });
    return;
  }
  if (lifecycle.draining && req.method !== 'DELETE') {
    sendJson(res, 503, { error: 'MCP service restarting', code: restartingCode, recovery: rejectedRecovery }, { 'retry-after': '1' });
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
      unknownSession(res);
      return;
    }
    let reservation;
    if (!session) {
      // Validate before admission: malformed/missing initialization must neither
      // allocate a session nor displace another client's idle connection.
      if (!JSONRPCRequestSchema.safeParse(body).success || !InitializeRequestSchema.safeParse(body).success) {
        sendJson(res, 400, { error: "valid initialize request required when MCP-Session-Id is absent" }); return;
      }
      reservation = sessionPool.reserve();
      if (!reservation) {
        runtimeCounters.sessionsRejected++;
        sendJson(res, 503, { error: "session capacity busy; retry after backoff", retryAfterMs: 5000 }, { 'retry-after': '5' }); return;
      }
      let transport;
      try {
        const server = createMcpServer();
        session = { server, transport: null, createdAt: Date.now(), lastActiveAt: Date.now(), inflight: 0 };
        transport = new HttpTransport({
          sessionIdGenerator: () => randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            reservation.activate(id, session);
            runtimeCounters.sessionsCreated += 1;
            void auditHttp({ event: "session_created", session: sessionHash(id) });
          },
          onsessionclosed: (id) => {
            sessionPool.remove(id, 'closed');
          },
        }, { ...compressionConfig, onResult: stats => {
          if (stats.encoding === "gzip") runtimeCounters.compressedResponses++;
          runtimeCounters.compressionOriginalBytes += stats.originalBytes;
          runtimeCounters.compressionWireBytes += stats.wireBytes;
        } });
        session.transport = transport;
        await server.connect(transport);
      } catch (error) {
        reservation.release();
        await transport?.close().catch(() => {});
        throw error;
      }
    }
    session.lastActiveAt = Date.now();
    session.inflight = (session.inflight ?? 0) + 1;
    try {
      await requestAudit.run(auditContext, () => session.transport.handleNodeRequest(req, res, body));
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { error: "MCP request failed" });
      console.error(error);
    } finally {
      session.inflight = Math.max(0, (session.inflight ?? 1) - 1);
      session.lastActiveAt = Date.now();
      reservation?.release();
      if (reservation && !session.transport.sessionId) await session.transport.close().catch(() => {});
    }
    return;
  }

  if (req.method === "GET" || req.method === "DELETE") {
    if (!sessionId || !sessions.has(sessionId)) {
      runtimeCounters.unknownSessionRequests += 1;
      unknownSession(res);
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

if (!noHttp) {
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
        httpSessions: settings.http.sessions,
        httpResponsePolicy: { maxToolWaitMs: settings.http.maxToolWaitMs, closeFiniteConnections: settings.http.closeFiniteConnections },
        backgroundNotifications: backgroundNotifications.summary(),
        configFile: deployment.configFile,
        workspace: workspace.root,
        writesEnabled: enableWrite,
        commandEnabled: enableTerminal,
        maxFileBytes,
        directFileMaxBytes,
        terminalCleanup: { idleTtlMs: settings.terminal.idleTtlMs, gcIntervalMs: settings.terminal.gcIntervalMs },
        uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
        draining: lifecycle.draining,
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
        httpSessions: settings.http.sessions,
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

  // Finite POST responses release idle TCP sockets promptly. This timeout
  // starts after a response ends, so it does not cut off an open SSE response.
  httpServer.keepAliveTimeout = 5000;
  httpServer.listen(port, host, () => {
    console.error(`terminal-workspace-mcp listening on http://${host}:${port}${endpoint}`);
    console.error(`workspace=${workspace.root} writes=${enableWrite} command=${enableTerminal} auth=${authToken ? "bearer" : "anonymous"}`);
    console.error(`sessionIdleTtlMs=${sessionIdleTtlMs} directFileMaxBytes=${directFileMaxBytes} auditLog=${auditLogPath}`);
  });

  const gcTimer = setInterval(() => sessionPool.expire(), sessionGcIntervalMs);
  gcTimer.unref();

  async function shutdown() {
    if (lifecycle.draining) return;
    clearInterval(terminalGcTimer);
    clearInterval(gcTimer);
    const draining = lifecycle.drain();
    await backgroundNotifications.close();
    const drained = await draining;
    await auditHttp({ event: 'service_draining', ...drained });
    for (const { transport } of sessions.values()) await transport.close().catch(() => {});
    auditWriter.end();
    httpServer.close(async () => { await finishLogging(); process.exit(0); });
    setTimeout(() => process.exit(0), 3000).unref();
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

import { z } from "zod";
import { OperationError, quote } from "./runtime.mjs";

const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const modifying = { readOnlyHint: false, destructiveHint: true, openWorldHint: true, idempotentHint: false };
const object = z.object({}).passthrough();
const string = z.string();
const maxBytes = z.number().int().min(4).max(1048576).default(65536);
const sessionId = string.regex(/^term_[a-f0-9-]{36}$/);
export function result(value, summary) {
  const serialized = JSON.stringify(value);
  return { structuredContent: value, content: [{ type: "text", text: summary ?? (Buffer.byteLength(serialized) < 4096 ? serialized : `Result available in structuredContent (${Buffer.byteLength(serialized)} bytes).`) }] };
}
export function errorResult(error) {
  const code = typeof error?.code === "string" ? error.code : "operation_failed";
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ code, message: error?.message ?? String(error) }) }] };
}
function readonlyCommand(command) {
  const parts = command.split(/\s+&&\s+/);
  if (parts.length > 4) throw new OperationError("at most four read-only commands", "read_only_policy_denied");
  return parts.map(part => {
    if (/[;|<>`$(){}\\\n\r]/.test(part)) throw new OperationError("use execute_command for shell syntax", "read_only_policy_denied");
    const args = part.trim().split(/\s+/), binary = args.shift();
    if (["pwd", "whoami"].includes(binary) && !args.length) return `/usr/bin/${binary}`;
    if (["uname", "id"].includes(binary) && args.every(x => /^-[a-zA-Z]+$/.test(x))) return [`/usr/bin/${binary}`, ...args.map(quote)].join(" ");
    if (binary === "ls" && args.every(x => !x.startsWith("-") || /^-[alhRdtF]+$/.test(x))) return ["/usr/bin/ls", ...args.map(quote)].join(" ");
    if (binary === "cat" && args.length === 1 && !args[0].startsWith("-")) return `/usr/bin/cat -- ${quote(args[0])}`;
    if (binary === "git") {
      const sub = args.shift();
      const allowed = { status: new Set(["--short", "--branch", "--porcelain", "-s", "-b"]), branch: new Set(["--list", "-a", "-r", "--all", "--remotes"]), log: new Set(["--oneline", "--stat", "--all", "--decorate", "-1", "-5", "-10", "-20"]), diff: new Set(["--stat", "--name-only", "--cached", "--staged"]) };
      if (allowed[sub] && args.every(x => allowed[sub].has(x))) return `/usr/bin/git --no-pager -c core.fsmonitor=false -c core.hooksPath=/dev/null ${sub} ${sub === "diff" ? "--no-ext-diff --no-textconv " : ""}${args.map(quote).join(" ")}`;
    }
    throw new OperationError("command is not a read-only query; use execute_command", "read_only_policy_denied");
  }).join(" && ");
}
export function registerTools(server, { workspace: w, executor, jobs, terminals: t, config, diagnostics }) {
  const definitions = new Map();
  const define = (name, spec, callback) => definitions.set(name, { spec, callback });
  const register = (name, description, schema, run, annotations = readOnly) => define(name, { title: name.replaceAll("_", " "), description, inputSchema: schema, outputSchema: object, annotations }, async (args, extra) => {
    try { return result(await run(args, extra)); } catch (error) { return errorResult(error); }
  });
  const terminal = fn => async (...args) => { if (!config.enableTerminal) throw new OperationError("set MCP_ENABLE_TERMINAL=1 to enable execution", "terminal_disabled"); return fn(...args); };
  const cwd = async value => { const target = await w.resolve(value ?? "."); const info = await w.describe(target.absolute); if (info.type !== "directory") throw new OperationError("cwd is not a directory", "not_a_directory"); return target; };
  register("workspace_summary", "Show the default directory and available operation modes. Absolute paths and ~ are supported with the service account's permissions.", {}, async () => ({ root: w.root, topLevel: (await w.listDirectory()).entries, writesEnabled: config.enableWrite, terminalEnabled: config.enableTerminal, version: config.version }));
  register("list_directory", "List a relative, absolute, or ~/ directory. Recursive traversal handles symlink cycles.", { path: string.default("."), recursive: z.boolean().default(false), includeHidden: z.boolean().default(false), maxEntries: z.number().int().min(1).max(5000).default(200) }, a => w.listDirectory(a.path, a));
  register("read_file", "Read a bounded UTF-8 window of any accessible file. Use nextOffset for continuation; sha256Scope says whether the hash covers a whole file or a slice.", { path: string, maxBytes, startLine: z.number().int().min(1).default(1), endLine: z.number().int().min(1).optional(), offset: z.number().int().min(0).optional(), tail: z.boolean().default(false) }, a => w.readText(a.path, a));
  register("file_info", "Get file size and modification time; optionally stream a full-file SHA256 checksum.", { path: string, checksum: z.boolean().default(false) }, a => w.fileInfo(a.path, a));
  register("read_file_chunk", "Download a bounded binary (base64) or UTF-8 chunk. Resume using nextOffset; includes a checksum of the returned byte range.", { path: string, offset: z.number().int().min(0).default(0), maxBytes, encoding: z.enum(["base64", "utf8"]).default("base64"), tail: z.boolean().default(false) }, a => w.readChunk(a.path, a));
  register("write_file_chunk", "Upload original bytes as base64. Create/overwrite at offset 0; append with offset equal to current file size. Optional chunk SHA256 and expectedSize detect transfer errors and conflicts.", { path: string, data: string.max(1398104), offset: z.number().int().min(0).default(0), mode: z.enum(["create", "append", "overwrite"]).default("append"), expectedSize: z.number().int().min(0).optional(), sha256: string.regex(/^[a-f0-9]{64}$/).optional() }, a => w.writeChunk(a.path, a), modifying);
  define("get_file", { title: "Get original file", description: "Fetch an original accessible file. Prefer an absolute path on every call; ~/ and default-directory relative paths also work. Small images render directly. For large files provide offset=0 and continue using nextOffset; chunks include SHA256 and totalBytes.", inputSchema: { path: string, offset: z.number().int().min(0).optional(), maxBytes: z.number().int().min(4).max(1048576).optional() }, outputSchema: object, annotations: readOnly }, async a => {
    try {
      let file;
      if (a.offset !== undefined) {
        const chunk = await w.readChunk(a.path, { offset: a.offset, maxBytes: Math.min(a.maxBytes ?? config.directFileMaxBytes, config.directFileMaxBytes), encoding: "base64" });
        file = { ...chunk, data: Buffer.from(chunk.data, "base64") };
      } else {
        try { file = await w.readFileBytes(a.path, { maxBytes: Math.min(a.maxBytes ?? config.directFileMaxBytes, config.directFileMaxBytes) }); }
        catch (error) { if (error.code === "file_too_large") throw new OperationError("file exceeds this response budget; set offset=0 and continue with nextOffset", "file_too_large"); throw error; }
      }
      const ext = file.path.toLowerCase().split(".").at(-1);
      const mimeType = ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", pdf: "application/pdf", svg: "image/svg+xml", txt: "text/plain", json: "application/json" })[ext] ?? "application/octet-stream";
      const metadata = { path: file.path, bytes: file.bytes, sha256: file.sha256, ...(a.offset === undefined ? { sha256Scope: "file" } : { offset: file.offset, nextOffset: file.nextOffset, totalBytes: file.totalBytes, eof: file.eof, sha256Scope: "chunk" }), mimeType, uri: `workspace:///${file.path.split("/").map(encodeURIComponent).join("/")}` };
      const blob = file.data.toString("base64");
      return { ...result(metadata), content: [{ type: "text", text: `Fetched ${file.path} (${file.bytes} bytes)` }, mimeType.startsWith("image/") && ext !== "svg" && (a.offset === undefined || (file.offset === 0 && file.eof)) ? { type: "image", data: blob, mimeType } : { type: "resource", resource: { uri: metadata.uri, mimeType, blob } }] };
    } catch (error) { return errorResult(error); }
  });
  register("search_text", "Search incrementally in a cancellable worker with time, file-count, and total-output budgets. Set exclude=[] to include normally skipped data/cache directories.", { query: string.min(1).max(4096), path: string.default("."), regex: z.boolean().default(false), includeHidden: z.boolean().default(false), maxResults: z.number().int().min(1).max(1000).default(100), maxBytes: z.number().int().min(1024).max(1048576).default(262144), maxFiles: z.number().int().min(1).max(100000).default(10000), timeoutMs: z.number().int().min(10).max(30000).default(5000), exclude: z.array(string).optional() }, (a, extra) => w.searchText(a.query, { ...a, relativePath: a.path, signal: extra.signal }));
  register("write_file", "Create, replace, or append UTF-8 text using account permissions. Supports atomic replacement and a whole-file expectedSha256 conflict check.", { path: string, content: string, mode: z.enum(["create", "overwrite", "append"]).default("overwrite"), expectedSha256: string.regex(/^[a-f0-9]{64}$/).optional() }, a => w.writeText(a.path, a.content, a), modifying);
  register("replace_in_file", "Replace exact text with serialized conflict checking and optional dry-run preview.", { path: string, find: string.min(1), replace: string, maxReplacements: z.number().int().min(1).max(1000).default(1), dryRun: z.boolean().default(true), expectedSha256: string.regex(/^[a-f0-9]{64}$/).optional() }, a => w.replaceText(a.path, a.find, a.replace, a), modifying);
  const input = { command: string.min(1).max(20000), cwd: string.default("."), timeoutMs: z.number().int().min(0).max(120000).default(30000), waitMs: z.number().int().min(0).max(120000).optional(), executionTimeoutMs: z.number().int().min(0).max(2147483647).default(0), maxOutputBytes: z.number().int().min(1024).max(2097152).default(262144) };
  const execute = terminal(async (a, tool) => { const target = await cwd(a.cwd); return executor.execute({ ...a, cwd: target.absolute, cwdLabel: target.relative, tool, env: config.childEnv }); });
  for (const name of ["execute_command", "run_terminal"]) register(name, "Execute a command as a durable job. timeoutMs/waitMs only bound this call's wait; output truncation never stops execution. Returns jobId and cursors. Set executionTimeoutMs for an explicit process deadline. Use tmux terminal tools for interactive state.", input, a => execute(a, name), modifying);
  register("execute_readonly_command", "Execute a fixed read-only query (pwd/ls/cat/uname/id/whoami or limited git queries). Use execute_command for general shell commands.", input, a => execute({ ...a, command: readonlyCommand(a.command) }, "execute_readonly_command"));
  register("git_status", "Read Git status in an accessible repository.", { cwd: string.default(".") }, async a => {
    const target = await cwd(a.cwd);
    const { execFile } = await import("node:child_process");
    const output = await new Promise((resolve, reject) => execFile("/usr/bin/git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--short", "--branch"], { cwd: target.absolute, timeout: 10000, maxBuffer: 1048576 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    const [branch, ...changes] = output.trimEnd().split("\n"); return { branch, changes };
  });
  register("start_job", "Start a durable non-interactive job and return immediately. Jobs survive MCP reconnects and service restarts.", { command: input.command, cwd: input.cwd, executionTimeoutMs: input.executionTimeoutMs }, terminal(async a => { const target = await cwd(a.cwd); return jobs.start({ ...a, cwd: target.absolute, cwdLabel: target.relative, env: config.childEnv }); }), modifying);
  register("get_job_status", "Read persisted job state and final exit code.", { jobId: string }, a => jobs.status(a.jobId));
  register("get_job_logs", "Read original output with separate stdout/stderr cursors; omit cursors for tails. Rotated-log retention gaps are reported in droppedBytes.", { jobId: string, stream: z.enum(["stdout", "stderr", "both"]).default("both"), maxBytes, stdoutCursor: z.number().int().min(0).optional(), stderrCursor: z.number().int().min(0).optional() }, a => jobs.logs(a.jobId, a));
  register("list_jobs", "List recent jobs, including completed and cancelled jobs.", { limit: z.number().int().min(1).max(200).default(50) }, async a => ({ jobs: await jobs.list(a) }));
  register("stop_job", "Cancel a durable job, waiting for confirmation. Sends TERM followed by KILL after a grace period; force requests immediate KILL.", { jobId: string, force: z.boolean().default(false), waitMs: z.number().int().min(0).max(30000).default(2500) }, terminal(a => jobs.stop(a.jobId, a)), modifying);
  register("cleanup_jobs", "Remove completed job histories according to age/count retention. Running jobs are preserved. dryRun previews the selection.", { retainCount: z.number().int().min(0).max(100000).default(1000), dryRun: z.boolean().default(true) }, terminal(a => jobs.cleanup(a)), modifying);
  register("open_terminal", "Create a persistent tmux Bash PTY or resume an existing sessionId. State survives MCP service restarts. env extends the server environment for the new session.", { sessionId: sessionId.optional(), cwd: string.default("."), name: string.max(200).default(""), env: z.record(string, string).default({}), cols: z.number().int().min(20).max(500).default(120), rows: z.number().int().min(5).max(300).default(40) }, terminal(async a => t.open({ ...a, cwd: (await cwd(a.cwd)).absolute })), modifying);
  register("list_terminals", "List managed tmux terminal sessions with their current directories.", {}, async () => ({ terminals: await t.list() }));
  register("execute_in_terminal", "Run a tracked command in an existing tmux shell, preserving cd/export/activation. Returns commandId, status, exit code, and output cursor. Use write_terminal to answer prompts.", { sessionId, command: input.command, waitMs: z.number().int().min(0).max(30000).default(1000), maxBytes }, terminal(a => t.execute(a.sessionId, a)), modifying);
  register("get_terminal_command", "Read completion and exit code for a tracked terminal command.", { sessionId, commandId: string }, a => t.commandStatus(a.sessionId, a.commandId));
  register("write_terminal", "Send literal input and optional Enter, or a control key such as C-c. Does not open another shell.", { sessionId, input: string.max(65536).default(""), enter: z.boolean().default(false), key: z.enum(["C-c", "C-d", "C-z", "Enter", "Escape", "Tab", "Up", "Down"]).optional() }, terminal(a => t.write(a.sessionId, a)), modifying);
  register("read_terminal", "Read original PTY output incrementally using nextCursor. Output may contain terminal ANSI sequences.", { sessionId, cursor: z.number().int().min(0).optional(), maxBytes, waitMs: z.number().int().min(0).max(30000).default(0) }, a => t.read(a.sessionId, a));
  register("resize_terminal", "Resize the terminal PTY.", { sessionId, cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(300) }, terminal(a => t.resize(a.sessionId, a.cols, a.rows)), modifying);
  register("close_terminal", "Close a managed tmux session and its shell. Logs remain available.", { sessionId }, terminal(a => t.close(a.sessionId)), modifying);
  register("server_diagnostics", "Show build revision, operation modes, limits, tool count, sessions and job summary.", {}, diagnostics);
  if (config.toolProfile === "legacy") {
    for (const [name, { spec, callback }] of definitions) server.registerTool(name, spec, callback);
    return;
  }
  const getFile = definitions.get("get_file");
  server.registerTool("get_file", getFile.spec, getFile.callback);
  server.registerTool("execute_command", {
    title: "Execute in persistent terminal",
    description: "Run shell commands in persistent tmux. Prefer absolute paths on every call; cwd only sets a new session, so use explicit paths or cd for reused sessions. Start once, then keep sessionId and nextCursor. While status=running, poll with sessionId/cursor and no command; use waitMs=10000..30000 for long waits. waitMs/maxBytes only bound this response: never rerun a task because waiting expired. Check status/exitCode and drain remaining output before reporting completion. Reuse sessionId for cwd/env; cwd applies only to new sessions. Use input for prompts or key=C-c to interrupt. Output is original merged PTY stdout/stderr with ANSI sequences. Use shell for files, search, Git and processes. Inspect owned sessions with node \"$MCP_TERMINAL_ADMIN\" list; cleanup previews reclamation, --apply retains logs. Idle sessions may expire; running tasks are protected. command=exit closes a finished shell; check background jobs first. Save IDs/cursors/artifact paths for handoff.",
    inputSchema: { command: string.max(20000).optional(), sessionId: sessionId.optional(), cwd: string.optional(), input: string.max(65536).optional(), key: z.enum(["C-c", "C-d", "C-z", "Enter", "Escape", "Tab"]).optional(), cursor: z.number().int().min(0).optional(), waitMs: z.number().int().min(0).max(30000).default(1000), maxBytes },
    outputSchema: object, annotations: modifying,
  }, async (a) => {
    try {
      if (!config.enableTerminal) throw new OperationError("set MCP_ENABLE_TERMINAL=1 to enable execution", "terminal_disabled");
      const began = Date.now();
      if (a.command !== undefined && (a.input !== undefined || a.key)) throw new OperationError("send a command or interactive input in separate calls", "invalid_input");
      if (!a.sessionId && (!a.command?.trim())) throw new OperationError("provide command for a new session, or sessionId to resume", "invalid_input");
      const id = a.sessionId ?? (await t.open({ cwd: (await cwd(a.cwd)).absolute })).sessionId;
      let tracked, page;
      if (a.command?.trim()) {
        const execution = await t.execute(id, { command: a.command, waitMs: a.waitMs, maxBytes: a.maxBytes });
        const { output, ...state } = execution; tracked = state; page = output;
      } else {
        if (a.input !== undefined || a.key) await t.write(id, { input: a.input ?? "", key: a.key });
        page = await t.read(id, { cursor: a.cursor, maxBytes: a.maxBytes, waitMs: a.waitMs });
        const state = await t.status(id);
        tracked = state.activeCommandId ? await t.commandStatus(id, state.activeCommandId) : { status: state.alive ? "idle" : "terminal_closed", exitCode: null };
      }
      const state = await t.status(id);
      return result({ ...tracked, sessionId: id, cwd: state.cwd, stdout: page.content, stderr: "", nextCursor: page.nextCursor, endCursor: page.endCursor, earliestCursor: page.earliestCursor, droppedBytes: page.droppedBytes, outputTruncated: page.truncated, waitingExpired: tracked.status === "running", durationMs: Date.now() - began });
    } catch (error) { return errorResult(error); }
  });
}

# Terminal Workspace MCP

[Public repository](https://github.com/Normalight/terminal-workspace-mcp) · [MIT license](LICENSE) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

A personal remote terminal for the account running the server. Release 0.4.1 exposes two tools by default:

- `execute_command`: shell commands, persistent tmux sessions, interactive input, and output polling.
- `get_file`: original files and images, with resumable chunks for large files.

Use ordinary shell commands for directory listings, text editing, search, Git, and process management. Paths may be absolute, `~/`, or relative to the default workspace; the service account's permissions apply. Command output and files retain their original content.

Linux, Bash, Node.js 22+, npm, tmux 3.2+, and `flock` (util-linux) are required. The service helper and tests require Python 3.9+. Process identity uses Linux `/proc`; macOS and native Windows are unsupported. HTTP MCP connections can come and go without ending running tmux tasks.

## Install

From a clone of the public repository:

```bash
mkdir -p .tmp .cache/npm
npm_config_cache="$PWD/.cache/npm" npm ci --prefix mcp_server
```

Dependencies are pinned in `package-lock.json`. The package is marked private to prevent accidental npm publication; its source is MIT-licensed. Public release changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Configure and run

`config.json` is the source of deployment settings. The server, stdio entry point, TCP relay, service helper, diagnostics, and plugin generator all use the same loader.

| Setting | Purpose |
| --- | --- |
| `workspaceRoot` | Default directory; relative to the selected configuration file. The shipped `".."` resolves to the repository workspace. |
| `http.host`, `http.port`, `http.path` | MCP listener and route. |
| `client.url`, `client.tokenEnv` | Client-facing endpoint and its token environment variable. The endpoint can differ from the local listener when a tunnel is used. |
| `relay.host`, `relay.port` | Optional TCP relay listener. Its target defaults to the MCP listener; `targetHost`/`targetPort` can override it. |
| `paths` | Service state, jobs, terminal sessions, and audit log, resolved relative to `workspaceRoot`. Managed paths must resolve inside it, including symlinks. |
| `http.compression`, `http.sessions` | Compression and HTTP session limits. |
| `tools`, `files`, `terminal`, `jobs`, `logs` | Tool profile, operation modes, output limits, and retention. |
| `diagnostics.tunnelUrl` | Existing tunnel health/metrics origin; this config does not reconfigure the external tunnel itself. |
| `auth.tokenEnv` | Server token environment variable. Alternatively set `auth.token` in the ignored `config.local.json` overlay. |

Load order is `config.json` → `config.local.json` → explicit process environment overrides. For a separate deployment, set `MCP_CONFIG_FILE` or pass `--config` to a script: that file overlays the shipped defaults, resolves its own workspace path, and does not load the default machine's local overlay. Invalid fields, types, ports, and managed paths fail before server startup. The `.env.example` file documents optional environment overrides; dotenv files are not automatically loaded.

From the repository root:

```bash
node mcp_server/scripts/config.mjs show
python3 -B mcp_server/scripts/service.py start
python3 -B mcp_server/scripts/service.py status
```

Supply the existing token through its configured variable or a mode-0600 `mcp_server/config.local.json`:

```json
{"auth":{"token":"your-existing-token"}}
```

After changing the client address, generate both plugin connection files from it:

```bash
node mcp_server/scripts/config.mjs sync-plugin
python3 -B mcp_server/scripts/service.py restart
# If using the optional TCP relay:
python3 -B mcp_server/scripts/service.py restart --component relay
```

Refresh the client connection after updating its generated package. Changing `client.url` does not create or repair an external tunnel route. Before moving `workspaceRoot` or runtime `paths`, stop the service using its current configuration and plan migration of any persistent tmux/job state.

For foreground operation, use `node mcp_server/src/server.mjs`; stdio uses `node mcp_server/src/stdio.mjs`; the optional relay uses `node mcp_server/src/tcp-relay.mjs`. These entry points automatically read the configuration regardless of the current working directory. Terminal execution requires `tools.enableTerminal` and a token. `tools.enableWrite` controls compatibility file APIs; shell commands operate with account permissions.

Managed sockets, metadata, logs, temporary files, and child package caches live under the configured workspace. Follow the task's filesystem constraints for command output paths. Child processes inherit the configured paths, with MCP/control-plane authentication variables omitted.

## Connect from ChatGPT

See the [ChatGPT deployment and update guide](CHATGPT.md) ([中文](CHATGPT.zh-CN.md)) for Secure MCP Tunnel setup, authentication, developer-mode registration, and refreshing saved tool definitions. The included plugin connection files configure compatible clients; generating them does not update an existing ChatGPT connection. This server implements a static local Bearer token, not an OAuth authorization server.

## Execute and interact

Prefer absolute paths on every call, including `get_file`. Use an absolute `cwd` for a new session; on reused sessions, use absolute operands or explicitly `cd -- /absolute/path`. `cwd` does not reset an existing shell. Idle shells can be reclaimed, so do not rely on a previous session's directory or environment for independent operations.

Start a shell and keep its returned `sessionId`:

```json
{"command":"pwd; export MODE=dev","waitMs":1000}
```

Reuse that ID for subsequent commands to preserve `cd`, environment activation, shell variables, and background processes:

```json
{"sessionId":"term_...","command":"printf '%s\\n' \"$MODE\"; git status --short","waitMs":1000}
```

For callers that reconnect frequently, choose one stable `terminalKey` per task from its first command:

```json
{"terminalKey":"project/build-42","command":"export MODE=dev; pwd","cwd":"/absolute/project","waitMs":1000}
```

Subsequent calls can use the same key instead of `sessionId`, including read/subscribe calls without `command`. The key persists across MCP connections and server restarts and returns the same tmux shell, preserving its directory and environment. `cwd` and creation options apply only when creating a shell. Provide either `sessionId` or `terminalKey`, never both. Keys are case-sensitive, 1–120 ASCII letters/digits or `._:/-`, beginning with a letter/digit, and scoped to the configured terminal root. Use separate keys for independent tasks; omitting both selectors creates a fresh terminal.

`terminalReused` identifies reuse. Read-only key lookups never create a terminal; unknown keys return `terminal_not_found`. Reading a closed keyed terminal retains its history. A new command may replace a closed/reclaimed keyed shell, returning `terminalReused:false` and `replacedSessionId`; its old environment is gone, so initialize the new command explicitly. Keep the original `sessionId` with each `commandId`/cursor to retrieve that shell's earlier results even after its key has moved to a replacement. Restoring monitoring never requires re-running a command.

Concurrent key lookups/creation use cross-process locks; one key creates only one shell and capacity is checked against live tmux sessions. A busy keyed shell remains the same shell and rejects another command with `terminal_busy`; use read/input/key to continue its current work.

`waitMs` (0–30000 ms) bounds this call's wait. `maxBytes` (4–1048576, default 65536) bounds the returned output page. Neither ends a command. A response includes `status`, `exitCode`, `sessionId`, `commandId`, `stdout`, `nextCursor`, and truncation/wait indicators. When a command is still running, or output remains unread, continue:

```json
{"sessionId":"term_...","cursor":1234,"waitMs":1000,"maxBytes":65536}
```

Use the previous `nextCursor` to avoid repeating output. Omitting `cursor` reads a tail. To answer a prompt, send literal input with a newline for Enter, or a control key:

```json
{"sessionId":"term_...","input":"yes\n","cursor":1234,"waitMs":1000}
```

```json
{"sessionId":"term_...","key":"C-c","waitMs":1000}
```

Send `command` and interactive input in separate calls. Only one tracked command may run per shell. Independent work can open another session. `cwd` applies when creating a session; use `cd` to change an existing shell's directory. An explicit deadline can be implemented with the shell's `timeout` command.

PTY output combines stdout/stderr and includes command echo and ANSI control sequences. `stderr` is empty because the terminal merges both streams. For structured output, redirect to a file and retrieve it with `get_file`. Large responses place the full page in `structuredContent`, with a short text summary.

The managed Bash uses an isolated rcfile, `PROMPT_COMMAND`, and a `DEBUG` trap to track prompt readiness. Preserve these hooks and the internal command-tracking variables. A private PTY marker lets the logger confirm completion only after preceding command output is written; bookkeeping markers are omitted from returned output. `outputEndCursor` identifies that confirmed boundary when available. Shell `exit`/`exec` may return `terminal_closed` after log drainage instead of a prompt-generated result. `command:"exit"` ends the shell and retains its logs. tmux survives MCP server restarts; machine reboot or termination of the tmux server ends its sessions.

After upgrading, newly opened terminals use the current hooks and logging protocol. Existing terminals keep their running shell/logger and their prior completion protocol; create a new session to use the output acknowledgement guarantee.

Inside a managed shell, use its configured terminal root to manage sessions. For an external terminal, get the resolved path from `config.mjs show`:

```bash
tmux -S "$MCP_TERMINAL_ROOT/tmux.sock" list-sessions
tmux -S "$MCP_TERMINAL_ROOT/tmux.sock" attach -t <sessionId>
tmux -S "$MCP_TERMINAL_ROOT/tmux.sock" resize-window -t <sessionId>:0 -x 160 -y 50
tmux -S "$MCP_TERMINAL_ROOT/tmux.sock" kill-session -t <sessionId>
```

Close only sessions belonging to the completed task when their processes are no longer needed.

### Long tasks

Start a command once and save `sessionId`, `commandId`, and `nextCursor`. A command returned as `running` automatically subscribes **the calling MCP connection** to a completion event. The server advertises `logging` and emits the standard MCP `notifications/message` with `level: "notice"`, `logger: "terminal-workspace.completion"`, and structured `data`:

```json
{
  "event": "command_completed",
  "notificationId": "term_...:cmd_...",
  "sessionId": "term_...",
  "commandId": "cmd_...",
  "status": "succeeded",
  "exitCode": 0,
  "signal": null,
  "startedAt": "...",
  "finishedAt": "...",
  "startCursor": 100,
  "outputEndCursor": 200
}
```

The notification carries status and identifiers; retrieve output using `execute_command({sessionId, commandId, cursor: nextCursor, waitMs: 0})` without `command`, draining remaining pages. Keep commands that represent long work in the foreground: a shell command ending in `&` finishes when the shell returns, not when its detached work finishes. In the legacy profile, job notifications contain `jobId`/`commandId`; use `get_job_status` and `get_job_logs` for final state and output.

- **Client integration:** register a logging notification handler before starting work; keep Streamable HTTP GET SSE or stdio open. Accept `notice` messages (`logging/setLevel` to `notice` or a lower threshold). The SDK 1.x Streamable HTTP client opens GET automatically. These are structured logging events, not the experimental MCP Tasks API. See [MCP logging](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging) and the [SDK v1 transport guide](https://ts.sdk.modelcontextprotocol.io/server).
- **Controls:** `notifyOnCompletion: false` disables/removes that command's subscription. Explicit `true` also subscribes to an already completed command. By default, commands finished within the initial wait are simply returned, without an extra event. Ordinary output reads do not change subscriptions.
- **Recovery:** pending events wait while this HTTP session lacks GET SSE. Same-session reconnection resumes delivery. After service restart, HTTP-session expiry, or a new connection, initialize again and call `{sessionId, commandId, notifyOnCompletion: true, waitMs: 0}` to subscribe to persisted command state. Legacy clients use `get_terminal_command` or `get_job_status` with the same flag. Never rerun the command to restore monitoring.
- **Delivery limits:** subscriptions belong to a connection, not a broadcast channel. A connection retains up to 256 pending subscriptions and a 2,048-entry sent-ID deduplication window; capacity failures explicitly return `completionNotification.reason: "subscription_limit"` and `fallback: "poll"`. Network receipt is not acknowledged, so clients should deduplicate `notificationId` and reconcile saved IDs after reconnecting. Server restart discards subscriptions, not task results. Logging thresholds above `notice` defer delivery until the client allows it.
- **Server lifecycle:** a demand-started monitor checks subscribed commands about every 500 ms while a listener exists. Terminal completion uses the persisted output-drain acknowledgement. Completed states are cached during retries. The monitor stops when empty or when the MCP session closes; active SSE listeners are protected from idle session GC. SSE is uncompressed, with SDK keep-alives and proxy-buffering disabled. No commands or output are included in notification payloads.
- **Fallback:** a client must handle events to act on them. Receiving a notification does not itself wake an offline application or schedule another model turn. If the host does not expose notification handlers, continue polling with `{sessionId, cursor: nextCursor, waitMs: 10000}` (up to 30000 ms). Waiting expiry, output truncation and a dropped connection do not stop execution. Always verify the final status/exit code and read remaining output before reporting completion.

A runnable SDK example is [examples/completion-client.mjs](examples/completion-client.mjs). It listens for pushed completion, reconciles persisted task status every 30 seconds if no event arrives, and fetches remaining output:

```bash
node mcp_server/examples/completion-client.mjs 'sleep 5; printf first' 'sleep 2; printf second'
```

It uses the configured local HTTP endpoint and authentication; set `MCP_NOTIFICATION_URL` to exercise a relay/tunnel endpoint instead. Before submitting, it writes a private checkpoint under `outputs/mcp-client-state/` containing its stable task key. It then saves the returned task IDs and consumed output cursor. If the client process exits, use the printed checkpoint path:

```bash
node mcp_server/examples/completion-client.mjs --resume /absolute/workspace/outputs/mcp-client-state/<id>.json
```

Resume only inspects/subscribes/reads the saved task, even when the submission reply was lost. It never submits another command or continues unsubmitted commands from the original argument list. An unconfirmed submission stops with an explicit diagnostic. A crash between writing stdout and saving its cursor may repeat that last output page.

The reusable [client/reconnecting-client.mjs](client/reconnecting-client.mjs) shares one active client and initialization among concurrent readers. On session 404, network loss, timeouts, 429 or retryable 5xx, safe reads retry at most four times with exponential backoff and jitter, honoring `Retry-After`. Finite requests have a 40-second deadline; GET SSE remains open. Existing SDK reconnect handles short SSE interruptions; saved IDs and reconciliation recover completion after a new session/server restart. Authentication, argument/tool errors and `Unknown tool` stop immediately. Command/input/key requests are never replayed automatically: a lost command response raises `SubmissionUncertainError` with the saved selector, because execution may already have started. Only `read()` requests are eligible for automatic retries.

This helper improves clients that adopt it. A hosted ChatGPT/Codex connector has its own transport and tool registry; origin code cannot repair an upstream `Unknown tool`. Refresh that saved connection and test a new conversation. HTTP 404 responses include recovery guidance, while `http_aborted` audit records identify replies interrupted before completion without recording command text or credentials.

### Reuse connections and reclaim short-lived sessions

There are three separate lifetimes:

| Layer | Reuse and cleanup |
| --- | --- |
| HTTP request/TCP socket | Each RPC uses a finite POST/JSON response. TCP keep-alive can reuse a socket between requests; idle sockets have a 5-second keep-alive timeout. Only GET SSE stays open for events. |
| MCP protocol session | Initialize once and reuse the returned `Mcp-Session-Id` header on POST, GET and DELETE. One SSE stream carries completion events for all subscribed tasks on that session. |
| Terminal/task | Save tool-returned `sessionId` (`term_...`), `commandId` and output cursor. These survive MCP session expiry/restart. Repeatedly reading one task does not require opening another terminal. |

Use one SDK `Client`/transport for the whole workflow, including output reads and multiple commands, rather than connecting inside each tool call. Repeated subscriptions to the same command on that MCP session are deduplicated. `completionNotification.listening` reports whether a listener is present at response time; `subscribed:true` alone does not mean a client is listening. If the host supports only request/response, poll using saved terminal IDs and output cursors. Finish a workflow with HTTP DELETE (`transport.terminateSession()`), then close the client. The [MCP session contract](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports#session-management) allows HTTP connections to change while retaining the same logical session.

Defaults for `http.sessions`:

- `idleTtlMs: 120000`: reclaim an MCP session after 2 idle minutes when it has no in-flight request or open SSE listener.
- `gcIntervalMs: 10000`: check every 10 seconds, and again before admitting a new session.
- `pressureIdleMs: 5000`: at the 128-session limit, reclaim the least recently used eligible session after at least 5 idle seconds. This grace protects newly initialized sessions while their first requests arrive.
- Reserve capacity during concurrent initialization. Malformed requests allocate no session and evict none. If all slots are active, listening or within the grace period, return HTTP 503 with `Retry-After: 5` rather than interrupting them.

Pressure reclamation closes protocol state and its notification subscriptions only; terminal processes, logs and task results remain. A stale MCP header gets HTTP 404. Initialize once again, then inspect/re-subscribe to the saved terminal/command IDs without rerunning the command. Do not blindly retry a command after an ambiguous network failure. Server logic cannot make an external host retain headers; short-lived clients are accommodated by this reclamation policy without merging distinct clients.

`/healthz` and `/metrics` expose the effective `httpSessions` policy, active/reserved sessions, listener count and reclaimable count. Audit events distinguish `session_evicted` from `session_expired`; counters include `sessionsEvicted` and `sessionsRejected`. Override the pressure grace with `MCP_SESSION_PRESSURE_IDLE_MS`, alongside existing session TTL/GC variables.

### Identify and reclaim managed tmux sessions

Each configured `paths.terminals` directory uses its own `tmux.sock`. New sessions carry `@mcp_manager=terminal-workspace-mcp` and an instance-specific `@mcp_owner`; matching metadata records the native tmux session ID. The inventory also verifies older sessions against their stored metadata and generated Bash launch command. A `term_` name alone does not establish ownership.

```bash
node mcp_server/scripts/terminals.mjs list
node mcp_server/scripts/terminals.mjs cleanup
node mcp_server/scripts/terminals.mjs cleanup --apply
# Limit cleanup to one returned ID:
node mcp_server/scripts/terminals.mjs cleanup --session "$SESSION_ID" --apply
```

Pass `--config /absolute/config.json` for a separate deployment. The list reports managed/unverified ownership, active/idle/exited/missing state, native session/window/pane IDs, attachment count, eligibility and skip reason. Inside a newly created MCP shell, the helper is also available as `node "$MCP_TERMINAL_ADMIN" list`.

By default the server checks every 30 seconds and reclaims exited sessions or shells idle for five minutes. Idle age starts from the latest use or command completion, not command start. Running commands, shell child processes (including background jobs), attached clients, manually added windows/panes, unknown owners and kept sessions are protected. Cross-process `flock` locks serialize managed command submission with cleanup; candidates are checked again before removal. Only tmux sessions are reclaimed: output logs, command records and files remain available. No default-socket tmux sessions are touched.

Idle reclamation also requires a current prompt marker, invalidated before commands entered through either MCP input or a tmux client. This protects builtins such as `read` that have no child processes. Older shells without the readiness hook are kept until explicitly closed or exited.

Configure `terminal.idleTtlMs` (default `300000`; `0` disables idle reclamation) and `terminal.gcIntervalMs` (default `30000`). To retain an idle shell intentionally, use its returned ID:

```bash
tmux -S "$MCP_TERMINAL_ROOT/tmux.sock" set-option -t "$SESSION_ID" @mcp_keep 1
# Restore normal reclamation:
tmux -S "$MCP_TERMINAL_ROOT/tmux.sock" set-option -u -t "$SESSION_ID" @mcp_keep
```

Read the resolved terminal root from `config.mjs show` when operating outside an MCP shell. Reclamation discards that shell's cwd and environment. Reopen a session with explicit paths for new work. A task owner can end an unneeded shell immediately with `command:"exit"` after checking `jobs -pr` and completing any background work.

## Retrieve files

`get_file({path:"/absolute/result.png"})` returns original bytes and a SHA256 checksum. Small raster images use MCP image content; other files use embedded resources. Default direct-file response budget is 1 MiB. Text inspection, editing, uploads, and checksums can also use shell commands.

For a large file, start with `{path,offset:0,maxBytes:1048576}` and continue with `offset:nextOffset` until `eof:true`. Omitting `maxBytes` uses at most 1 MiB per chunk, including when the direct-file budget is larger. Results include `totalBytes` and a chunk checksum (`sha256Scope:"chunk"`). Concatenate decoded resource blobs in offset order. Fetch a whole-file checksum with `sha256sum` when verification across chunks is needed. Full-file results have `sha256Scope:"file"`.

## HTTP transfer compression

Finite MCP JSON responses negotiate gzip through `Accept-Encoding` ([HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-12.5.3)). Compression is enabled by default for responses of at least 1024 bytes, uses asynchronous gzip level 4, and sends the original bytes if encoding would expand the response. Clients without gzip support continue receiving ordinary JSON. No extra MCP tool or compressed model-facing payload is introduced.

SSE remains unbuffered. Response headers retain the MCP session ID, declare `Vary: Accept-Encoding`, and carry the encoded content length. `/metrics` includes counts and before/after bytes for negotiated responses; the HTTP audit records per-response encoding and sizes. `http.compression.enabled` disables/enables compression; `http.compression.minBytes` changes the threshold. The corresponding environment overrides remain supported.

Compression saves network bytes. It does not reduce text after the client decodes it for the model. Keep command pages bounded, continue from `nextCursor`, and save large results to files. File chunks and checksums refer to original file bytes and remain unchanged by HTTP encoding. For a large collection of files, create an archive using shell commands, then retrieve that archive.

## Operation and compatibility

`tools.profile="minimal"` is the default two-tool interface. `tools.profile="legacy"` exposes the individual compatibility APIs, including the batch runner, job management, file editing, bounded worker search, and separate terminal operations. In that profile, `execute_command` retains batch-job semantics and returns `jobId`; its `waitMs`/`timeoutMs` limit waiting, and `executionTimeoutMs` explicitly limits execution. Select one profile per server process. Refresh client discovery after changing it.

Raw logs rotate in 8 MiB segments. By default all segments are retained. `logs.maxSegments` enables retention; `earliestCursor`/`droppedBytes` report removed history. Closed terminal logs are retained for manual archival. HTTP metadata audit is separately capped at eight 8 MiB segments and drops excess queued entries with a counter.

Defaults allow 32 live terminals, 32 batch jobs, and 128 HTTP MCP sessions. New batch jobs retain a process-group supervisor until shell output drains, so TERM-to-KILL escalation and explicit deadlines remain effective after the shell exits. Completed batch histories default to 30 days and at most 1000 stored jobs; accepting new batch jobs cleans old completed histories while preserving active ones. Old job records remain readable.

`/healthz` reports version, Git revision, tool profile, and tool count. `/metrics` reports HTTP/session counters. After a service restart the client needs a new MCP initialize handshake; tmux session IDs and job IDs remain valid. A client may need to refresh its connection or start a new conversation to load the updated tool schema.

The service helper reads the same configuration by default; `--config` selects another deployment. Its state file records the selected config path. `--component relay` manages the optional relay with its own pid/logs; the default component is the MCP server. `config.mjs show` prints effective paths and settings without credential values.

The helper detaches the process and writes pid/logs in the workspace. It is not a boot-time supervisor. Deployment can continue using an existing host process manager.

## Validation

```bash
node --test mcp_server/test/*.test.mjs
node mcp_server/scripts/measure_tools.mjs
```

Tests cover configuration precedence, relocated workspace/ports, plugin generation, service/relay startup, the two-tool interface, tmux state and prompts, Ctrl+C, output pagination, process deadlines, cancellation, spawn failure, UTF-8, log rotation, absolute paths, chunks, concurrent edits, search cancellation, HTTP errors, authentication, compression negotiation/integrity, and recovery across a server restart. Tests use isolated workspace-local state and remove their own processes and fixtures. Tool footprint measurement reports serialized definition bytes, not model token counts.

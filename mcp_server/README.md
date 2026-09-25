# Terminal Workspace MCP

[Public repository](https://github.com/Normalight/terminal-workspace-mcp) · [MIT license](LICENSE) · [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

A personal remote terminal for the account running the server. Release 0.4.0 exposes two tools by default:

- `execute_command`: shell commands, persistent tmux sessions, interactive input, and output polling.
- `get_file`: original files and images, with resumable chunks for large files.

Use ordinary shell commands for directory listings, text editing, search, Git, and process management. Paths may be absolute, `~/`, or relative to the default workspace; the service account's permissions apply. Command output and files retain their original content.

Linux, Bash, Node.js 22+, npm, and tmux 3.2+ are required. The service helper and tests require Python 3.9+. Process identity uses Linux `/proc`; macOS and native Windows are unsupported. HTTP MCP connections can come and go without ending tmux processes.

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

Start a shell and keep its returned `sessionId`:

```json
{"command":"pwd; export MODE=dev","waitMs":1000}
```

Reuse that ID for subsequent commands to preserve `cd`, environment activation, shell variables, and background processes:

```json
{"sessionId":"term_...","command":"printf '%s\\n' \"$MODE\"; git status --short","waitMs":1000}
```

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

The managed Bash uses an isolated rcfile and a prompt hook to record exit codes. Preserve `PROMPT_COMMAND` and the internal command-tracking variables. Shell `exit`/`exec` may return `terminal_closed` instead of a prompt-generated result. `command:"exit"` ends the shell and retains its logs. tmux survives MCP server restarts; machine reboot or termination of the tmux server ends its sessions.

Inside a managed shell, use its configured terminal root to manage sessions. For an external terminal, get the resolved path from `config.mjs show`:

```bash
tmux -S "$MCP_TERMINAL_ROOT/tmux.sock" list-sessions
tmux -S "$MCP_TERMINAL_ROOT/tmux.sock" attach -t <sessionId>
tmux -S "$MCP_TERMINAL_ROOT/tmux.sock" resize-window -t <sessionId>:0 -x 160 -y 50
tmux -S "$MCP_TERMINAL_ROOT/tmux.sock" kill-session -t <sessionId>
```

Close only sessions belonging to the completed task when their processes are no longer needed.

## Retrieve files

`get_file({path:"/absolute/result.png"})` returns original bytes and a SHA256 checksum. Small raster images use MCP image content; other files use embedded resources. Default direct-file response budget is 1 MiB. Text inspection, editing, uploads, and checksums can also use shell commands.

For a large file, start with `{path,offset:0,maxBytes:1048576}` and continue with `offset:nextOffset` until `eof:true`. Results include `totalBytes` and a chunk checksum (`sha256Scope:"chunk"`). Concatenate decoded resource blobs in offset order. Fetch a whole-file checksum with `sha256sum` when verification across chunks is needed. Full-file results have `sha256Scope:"file"`.

## HTTP transfer compression

Finite MCP JSON responses negotiate gzip through `Accept-Encoding` ([HTTP semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-12.5.3)). Compression is enabled by default for responses of at least 1024 bytes, uses asynchronous gzip level 4, and sends the original bytes if encoding would expand the response. Clients without gzip support continue receiving ordinary JSON. No extra MCP tool or compressed model-facing payload is introduced.

SSE remains unbuffered. Response headers retain the MCP session ID, declare `Vary: Accept-Encoding`, and carry the encoded content length. `/metrics` includes counts and before/after bytes for negotiated responses; the HTTP audit records per-response encoding and sizes. `http.compression.enabled` disables/enables compression; `http.compression.minBytes` changes the threshold. The corresponding environment overrides remain supported.

Compression saves network bytes. It does not reduce text after the client decodes it for the model. Keep command pages bounded, continue from `nextCursor`, and save large results to files. File chunks and checksums refer to original file bytes and remain unchanged by HTTP encoding. For a large collection of files, create an archive using shell commands, then retrieve that archive.

## Operation and compatibility

`tools.profile="minimal"` is the default two-tool interface. `tools.profile="legacy"` exposes the individual compatibility APIs, including the batch runner, job management, file editing, bounded worker search, and separate terminal operations. In that profile, `execute_command` retains batch-job semantics and returns `jobId`; its `waitMs`/`timeoutMs` limit waiting, and `executionTimeoutMs` explicitly limits execution. Select one profile per server process. Refresh client discovery after changing it.

Raw logs rotate in 8 MiB segments. By default all segments are retained. `logs.maxSegments` enables retention; `earliestCursor`/`droppedBytes` report removed history. Closed terminal logs are retained for manual archival. HTTP metadata audit is separately capped at eight 8 MiB segments and drops excess queued entries with a counter.

Defaults allow 32 live terminals, 32 batch jobs, and 128 HTTP MCP sessions. Completed batch histories default to 30 days and at most 1000 stored jobs; accepting new batch jobs cleans old completed histories while preserving active ones. Old job records remain readable.

`/healthz` reports version, Git revision, tool profile, and tool count. `/metrics` reports HTTP/session counters. After a service restart the client needs a new MCP initialize handshake; tmux session IDs and job IDs remain valid. A client may need to refresh its connection or start a new conversation to load the updated tool schema.

The service helper reads the same configuration by default; `--config` selects another deployment. Its state file records the selected config path. `--component relay` manages the optional relay with its own pid/logs; the default component is the MCP server. `config.mjs show` prints effective paths and settings without credential values.

The helper detaches the process and writes pid/logs in the workspace. It is not a boot-time supervisor. Deployment can continue using an existing host process manager.

## Validation

```bash
node --test mcp_server/test/*.test.mjs
node mcp_server/scripts/measure_tools.mjs
```

Tests cover configuration precedence, relocated workspace/ports, plugin generation, service/relay startup, the two-tool interface, tmux state and prompts, Ctrl+C, output pagination, process deadlines, cancellation, spawn failure, UTF-8, log rotation, absolute paths, chunks, concurrent edits, search cancellation, HTTP errors, authentication, compression negotiation/integrity, and recovery across a server restart. Tests use isolated workspace-local state and remove their own processes and fixtures. Tool footprint measurement reports serialized definition bytes, not model token counts.

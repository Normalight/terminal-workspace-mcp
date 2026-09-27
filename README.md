# Terminal Workspace MCP

[中文说明](README.zh-CN.md) · [Operator guide](mcp_server/README.md) · [MIT license](LICENSE)

A Linux terminal over MCP, with persistent tmux sessions and original file retrieval. Two tools cover the workflow: run shell commands with `execute_command`, and fetch files with `get_file`.

- Keep shell state, working directories, and activated environments across calls and MCP server restarts.
- Answer interactive prompts, send Ctrl+C, and read output incrementally.
- Retrieve original images and binary files, including chunked transfers with SHA256 checksums.
- Negotiate gzip for JSON responses while keeping the tool interface small.
- Configure the listener, workspace, relay, client endpoint, and runtime limits in one JSON file.

Commands run with the service account's permissions, including access beyond the default workspace. Use this server with clients and agents you trust. [Deployment and reporting guidance](SECURITY.md) describes the access model.

## Create a ChatGPT MCP app through Tunnel

This deployment uses **OpenAI Secure MCP Tunnel**: ChatGPT → Tunnel → local `http://127.0.0.1:5679/mcp`. Complete the local installation below, then follow the [full Tunnel walkthrough](mcp_server/CHATGPT.md) ([中文](mcp_server/CHATGPT.zh-CN.md)).

1. Create a tunnel in [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels), associate the target ChatGPT workspace, and obtain its ID and runtime key.
2. Start MCP and the tunnel client. Configure the local Bearer token for both forwarding and discovery.
3. Enable ChatGPT developer mode. At [Plugins](https://chatgpt.com/plugins), choose **+**, name the app **Terminal Workspace MCP**, select **Connection → Tunnel**, and choose or enter the tunnel ID.
4. Verify `execute_command` and `get_file`; add the app in a new chat and run `pwd`.
5. After schema changes, select **Refresh** on the saved connection and retest in a new chat.

The walkthrough covers permissions, client download, startup, credentials, readiness and troubleshooting, checked against [official connection instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt) on 2026-09-27. The loopback URL is used by the tunnel on your server; the ChatGPT form uses the tunnel identity.

## Requirements

- Linux with Bash, tmux 3.2 or newer, and `flock` (util-linux).
- Node.js 22 or newer and npm.
- Python 3.9 or newer for the service helper and tests.
- Git for cloning and revision reporting.

The implementation uses Linux `/proc` for process identity. macOS and native Windows are not supported. This is a source distribution; no npm publication is required.

## Quick start

```bash
git clone https://github.com/Normalight/terminal-workspace-mcp.git
cd terminal-workspace-mcp
mkdir -p .tmp .cache/npm
npm_config_cache="$PWD/.cache/npm" npm ci --prefix mcp_server

# Generate one token and use the same value in your MCP client.
export MCP_AUTH_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export TERMINAL_MCP_TOKEN="$MCP_AUTH_TOKEN"
node mcp_server/src/server.mjs
```

The default endpoint is `http://127.0.0.1:5679/mcp`. The default workspace is the clone's root. A second terminal can check `curl http://127.0.0.1:5679/healthz`.

Configure your MCP client to use Streamable HTTP, that URL, and the header `Authorization: Bearer <the same token>`. Client configuration syntax varies; the included [plugin](plugins/terminal-workspace-mcp/README.md) provides connection files for compatible clients. For remote access, use an HTTPS reverse proxy or an authenticated tunnel and set `client.url` to its endpoint.

For a persistent local token, put `{"auth":{"token":"your-token"}}` in `mcp_server/config.local.json` with file mode 0600. That file is ignored by Git. The server reads `config.json`, its local overlay, then explicit environment overrides.

## Use the two tools

Optional [botmux completion notifications](mcp_server/README.md#optional-botmux-completion-notifications) can monitor long tasks after clients disconnect and send status to a configured session. The integration is disabled by default; task execution remains available without botmux.

Prefer absolute paths on every call. Use an absolute `cwd` for new sessions; on reused sessions, use absolute operands or explicitly change directory. For long tasks, start once and listen for the completion notification on the calling MCP connection; fetch remaining output using saved IDs/cursors. Clients without notification handling can poll with `sessionId`/`commandId`/`nextCursor` and a wait of up to five seconds by default. See [completion notifications and recovery](mcp_server/README.md#long-tasks). On `nextAction:defer`, end foreground monitoring and report the running task with its suggested check interval. It is not a completion ETA or an automatic scheduled check. Check the final status and exit code before reporting completion.

Choose a stable task key before the first submission:

```json
{"terminalKey":"project/agent/task","command":"pwd; export DEMO=hello","waitMs":1000}
```

Reuse the returned `sessionId`:

```json
{"sessionId":"term_<returned-uuid>","command":"printf '%s\n' \"$DEMO\"","waitMs":1000}
```

Poll a running command with `{ "sessionId": "...", "commandId": "...", "cursor": 1234 }`, using the previous `nextCursor`. Answer a prompt with `{ "sessionId": "...", "input": "yes\n" }`, or interrupt with `{ "sessionId": "...", "key": "C-c" }`.

For reuse across fresh MCP connections, set a stable `terminalKey` such as `project/build-42` on the first and subsequent calls instead of `sessionId`. Reads never create a shell. New commands can replace a closed keyed shell, reporting `terminalReused:false` and `replacedSessionId`; initialize its directory/environment again. Use distinct keys for independent tasks and retain original IDs/cursors for history. See [terminal reuse and interaction](mcp_server/README.md#execute-and-interact).

`waitMs` and `maxBytes` limit the response; they do not kill a process. Default output is bounded to the selected command; omitted cursors read from its beginning. Explicit `outputScope:"terminal"` reads shared PTY history (tail by default). Check `outputGap` and `outputComplete` in addition to exit status. PTY output merges stdout/stderr and may contain ANSI and concurrent background output; use dedicated files for strict process output. Use shell commands for editing, search, Git, and process management.

Fetch a file with `get_file({"path":"result.png"})`. For larger files, start at `offset:0` and continue with `nextOffset` and `expectedVersion` from the first response's `version` until `eof`. Files retain their original bytes; HTTP compression is decoded by the client.

## Configuration and service management

Edit [`mcp_server/config.json`](mcp_server/config.json), or place machine-specific overrides in `config.local.json`. Relative runtime paths resolve under `workspaceRoot`. Authentication enables account-level shell access; changing the workspace directory does not impose a filesystem sandbox.

```bash
node mcp_server/scripts/config.mjs show
node mcp_server/scripts/config.mjs sync-plugin
python3 -B mcp_server/scripts/services.py prepare
# Review generated units and any filesystem-policy exception first.
python3 -B mcp_server/scripts/services.py install
python3 -B mcp_server/scripts/services.py start --component all
python3 -B mcp_server/scripts/services.py status --component all
```

MCP, tmux, relay and an optional tunnel run as independent systemd user services, with no botmux runtime dependency. See [service deployment and migration](mcp_server/SERVICES.md) for linger, private configuration and adoption of existing tasks. MCP restart preserves tmux tasks. Multiple agents can call concurrently using distinct terminal keys and independent read cursors; clients share service-account permissions. See the [operator guide](mcp_server/README.md) for session cleanup, retention, file limits, compression, configuration precedence, and compatibility mode.

## Session cleanup

The server reclaims exited tmux sessions and shells idle for five minutes, checking every 30 seconds. Running commands, background children, attached clients, kept sessions and modified window layouts are protected; logs remain. `node mcp_server/scripts/terminals.mjs list` identifies managed sessions. `cleanup` previews candidates and `cleanup --apply` removes them. See the [ownership, retention and keep settings](mcp_server/README.md#identify-and-reclaim-managed-tmux-sessions).

## Development

```bash
node --test mcp_server/test/*.test.mjs
node mcp_server/scripts/measure_tools.mjs
```

Tests use isolated directories and local ports. GitHub Actions runs the suite on Linux with Node.js 22 and 24. Contributions and reproducible bug reports are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

Long submissions may include `taskSummary` (1–240 characters). Completion notices preserve this purpose across restarts and summarize execution/output state; omitted descriptions use a coarse task category. The botmux `sessionId` selects both the sending bot and its chat/thread destination.

## License

[MIT](LICENSE). Dependencies retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

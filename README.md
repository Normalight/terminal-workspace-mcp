# CSY Workspace MCP

[中文说明](README.zh-CN.md) · [Operator guide](mcp_server/README.md) · [MIT license](LICENSE)

A Linux terminal over MCP, with persistent tmux sessions and original file retrieval. Two tools cover the workflow: run shell commands with `execute_command`, and fetch files with `get_file`.

- Keep shell state, working directories, and activated environments across calls and MCP server restarts.
- Answer interactive prompts, send Ctrl+C, and read output incrementally.
- Retrieve original images and binary files, including chunked transfers with SHA256 checksums.
- Negotiate gzip for JSON responses while keeping the tool interface small.
- Configure the listener, workspace, relay, client endpoint, and runtime limits in one JSON file.

Commands run with the service account's permissions, including access beyond the default workspace. Use this server with clients and agents you trust. [Deployment and reporting guidance](SECURITY.md) describes the access model.

## Requirements

- Linux with Bash and tmux 3.2 or newer.
- Node.js 22 or newer and npm.
- Python 3.9 or newer for the service helper and tests.
- Git for cloning and revision reporting.

The implementation uses Linux `/proc` for process identity. macOS and native Windows are not supported. This is a source distribution; no npm publication is required.

## Quick start

```bash
git clone https://github.com/Normalight/csy-workspace-mcp.git
cd csy-workspace-mcp
mkdir -p .tmp .cache/npm
npm_config_cache="$PWD/.cache/npm" npm ci --prefix mcp_server

# Generate one token and use the same value in your MCP client.
export MCP_AUTH_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export CSY_MCP_TOKEN="$MCP_AUTH_TOKEN"
node mcp_server/src/server.mjs
```

The default endpoint is `http://127.0.0.1:5679/mcp`. The default workspace is the clone's root. A second terminal can check `curl http://127.0.0.1:5679/healthz`.

Configure your MCP client to use Streamable HTTP, that URL, and the header `Authorization: Bearer <the same token>`. Client configuration syntax varies; the included [plugin](plugins/csy-workspace-mcp/README.md) provides connection files for compatible clients. For remote access, use an HTTPS reverse proxy or an authenticated tunnel and set `client.url` to its endpoint.

For a persistent local token, put `{"auth":{"token":"your-token"}}` in `mcp_server/config.local.json` with file mode 0600. That file is ignored by Git. The server reads `config.json`, its local overlay, then explicit environment overrides.

## Use the two tools

Start a terminal:

```json
{"command":"pwd; export DEMO=hello","waitMs":1000}
```

Reuse the returned `sessionId`:

```json
{"sessionId":"term_<returned-uuid>","command":"printf '%s\n' \"$DEMO\"","waitMs":1000}
```

Poll a running command with `{ "sessionId": "...", "cursor": 1234 }`, using the previous `nextCursor`. Answer a prompt with `{ "sessionId": "...", "input": "yes\n" }`, or interrupt with `{ "sessionId": "...", "key": "C-c" }`.

`waitMs` and `maxBytes` limit the response; they do not kill a process. Terminal output merges stdout/stderr and may contain ANSI sequences. Use shell commands for editing, search, Git, and process management.

Fetch a file with `get_file({"path":"result.png"})`. For larger files, start at `offset:0` and continue with `nextOffset` until `eof`. Files retain their original bytes; HTTP compression is decoded by the client.

## Configuration and service management

Edit [`mcp_server/config.json`](mcp_server/config.json), or place machine-specific overrides in `config.local.json`. Relative runtime paths resolve under `workspaceRoot`. Authentication enables account-level shell access; changing the workspace directory does not impose a filesystem sandbox.

```bash
node mcp_server/scripts/config.mjs show
node mcp_server/scripts/config.mjs sync-plugin
python3 -B mcp_server/scripts/service.py start
python3 -B mcp_server/scripts/service.py status
python3 -B mcp_server/scripts/service.py restart
python3 -B mcp_server/scripts/service.py stop
```

Use `--component relay` for the optional TCP relay. The helper manages detached processes; use your host's service manager for boot startup and automatic restart. Stopping the MCP process leaves tmux sessions running. See the [operator guide](mcp_server/README.md) for session cleanup, retention, file limits, compression, configuration precedence, and compatibility mode.

## Development

```bash
node --test mcp_server/test/*.test.mjs
node mcp_server/scripts/measure_tools.mjs
```

Tests use isolated directories and local ports. GitHub Actions runs the suite on Linux with Node.js 22 and 24. Contributions and reproducible bug reports are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE). Dependencies retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Changes are recorded in [CHANGELOG.md](CHANGELOG.md).

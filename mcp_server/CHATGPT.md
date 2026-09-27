# Create a Terminal Workspace MCP app in ChatGPT through Tunnel

[中文](CHATGPT.zh-CN.md) · [Operator guide](README.md)

This walkthrough connects the existing HTTP service through OpenAI Secure MCP Tunnel. MCP and the tunnel client run on your Linux machine. Official guidance and local runtime-client flags were checked on 2026-09-27.

```text
ChatGPT MCP app (Connection: Tunnel)
    → OpenAI Secure MCP Tunnel
    → tunnel-client on Linux
    → http://127.0.0.1:5679/mcp
    → persistent tmux terminals
```

## 0. Create the tunnel and prepare access

In [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels), select the organization, create a tunnel, associate the target ChatGPT workspace, and obtain its ID and runtime key. Creation needs Tunnels Read + Manage; running/selecting needs Read + Use. Developer-mode access is separate. See [the official Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels).

| Value | Where it goes | Purpose |
| --- | --- | --- |
| `tunnel_id` | Tunnel client and ChatGPT Tunnel selection | Select the same tunnel |
| Runtime key | Client's `CONTROL_PLANE_API_KEY` | Authenticate the tunnel to OpenAI |
| Local MCP token | `config.local.json` → `auth.token`, and client's `MCP_RUNTIME_AUTH` | Authenticate local MCP requests |

The loopback address is for the local tunnel client. ChatGPT selects the tunnel identity; keys stay on the running machine. The repository URL hosts source code.

## 1. Start the local service

Install prerequisites and dependencies from the repository README. Run commands from the repository root. For a new deployment, create a persistent token below; existing tokens and other configuration are preserved. Reuse an already-running deployment.

```bash
mkdir -p .tmp .cache .local/config
export TMPDIR="$PWD/.tmp" TMP="$PWD/.tmp" TEMP="$PWD/.tmp"
export XDG_CACHE_HOME="$PWD/.cache" XDG_CONFIG_HOME="$PWD/.local/config"
export npm_config_cache="$PWD/.cache/npm"
python3 -B - <<'PY'
import json, os, secrets
from pathlib import Path
p = Path('mcp_server/config.local.json')
c = json.loads(p.read_text()) if p.exists() else {}
auth = c.setdefault('auth', {})
if not auth.get('token'):
    auth['token'] = os.environ.get('MCP_AUTH_TOKEN') or secrets.token_hex(32)
fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, 'w') as f:
    json.dump(c, f, indent=2)
p.chmod(0o600)
PY
```

Use the launcher below for local testing. For operation after logout, install the [independent systemd services](SERVICES.md).

```bash
python3 -B mcp_server/scripts/service.py start
python3 -B mcp_server/scripts/service.py status
curl --noproxy '*' -fsS http://127.0.0.1:5679/healthz
```

With the default configuration, health reports `version: "0.5.10"`, `toolProfile: "minimal"`, and `toolCount: 2`. Adjust the URL if you changed the listener. Health is a liveness check; it does not prove authenticated tool discovery works.

## 2. Connect a Secure MCP Tunnel

Download the appropriate client from the Platform tunnel page into the workspace's `.local/bin/` and make it executable; reuse a compatible existing binary. It needs outbound HTTPS and access to the local MCP listener.

Open another terminal at the repository root. Set the executable path below; these HTTP flags were checked against the runtime client's `run --help`. For newer interactive/profile workflows, consult `help quickstart` and avoid mixing version-specific interfaces.

```bash
TUNNEL_CLIENT="/absolute/path/to/tunnel-client-runtime"
read -r -p 'Tunnel ID: ' CONTROL_PLANE_TUNNEL_ID
read -r -s -p 'Tunnel runtime key: ' CONTROL_PLANE_API_KEY
printf '\n'
export CONTROL_PLANE_TUNNEL_ID CONTROL_PLANE_API_KEY
MCP_AUTH_TOKEN="$(python3 -B -c 'import json; print(json.load(open("mcp_server/config.local.json"))["auth"]["token"])')"
export MCP_RUNTIME_AUTH="Bearer $MCP_AUTH_TOKEN"
mkdir -p .tmp .cache .local/config

TMPDIR="$PWD/.tmp" XDG_CACHE_HOME="$PWD/.cache" \
XDG_CONFIG_HOME="$PWD/.local/config" \
"$TUNNEL_CLIENT" run \
  --control-plane.api-key env:CONTROL_PLANE_API_KEY \
  --control-plane.tunnel-id "$CONTROL_PLANE_TUNNEL_ID" \
  --mcp.server-url http://127.0.0.1:5679/mcp \
  --mcp.extra-headers 'Authorization: env:MCP_RUNTIME_AUTH' \
  --mcp.discovery-extra-headers 'Authorization: env:MCP_RUNTIME_AUTH' \
  --health.listen-addr 127.0.0.1:8791 \
  --log.file ''
```

Keep the process running and check liveness and forwarding readiness from another terminal:

```bash
curl --noproxy '*' -fsS http://127.0.0.1:8791/healthz
curl --noproxy '*' -fsS http://127.0.0.1:8791/readyz
```

Reuse an existing tunnel instead of starting a second poller for its identity. For persistent supervision, `services.py prepare --tunnel-spec /absolute/private-tunnel.json` generates a separate tunnel unit; see [its specification and installation steps](SERVICES.md). It does not create or authorize the OpenAI tunnel. MCP updates restart only the server, preserving tunnel and terminal processes.

Changing `client.url` or running `config.mjs sync-plugin` updates generated connection files only. It does not configure the tunnel or register an app in ChatGPT.

## 3. Add the connection in ChatGPT

Enable Developer mode under **Settings → Security and login**. Open [ChatGPT Plugins](https://chatgpt.com/plugins), choose **+**, and use the following fields. See [OpenAI's connection instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt).

| Field | Value |
| --- | --- |
| Name | `Terminal Workspace MCP` |
| Description | `Execute commands, resume long tasks and retrieve files in my Linux workspace` |
| Connection | **Tunnel** |
| Tunnel | Select or paste the `tunnel_id` from step 0 |

Create the connection and inspect tool discovery. For a missing tunnel, check workspace association, permissions and client readiness. This flow creates the ChatGPT connection directly; repository `.mcp.json` files serve clients that import that format.

Confirm discovery lists `execute_command` and `get_file`. Add the app from the tools menu in a new conversation and send:

> Use Terminal Workspace MCP to run `pwd`, with terminalKey `onboarding/check`, taskSummary "Verify MCP connection" and waitMs=1000. Return the directory and sessionId. Reuse saved IDs for later reads without resubmitting.

Expect `sessionId`, `commandId`, `stdout` and `nextCursor`. A later read should preserve commandId. For long tasks, end foreground polling on `nextAction:defer`; optional [botmux completion notices](README.md#optional-botmux-completion-notifications) run independently and include task/result summaries.

### Public HTTPS alternative

ChatGPT can also connect to an HTTPS `/mcp` endpoint. This server validates a static Bearer token and does not implement OAuth discovery or login. ChatGPT's direct connection cannot supply a custom API key: use an OAuth-compatible gateway that authenticates ChatGPT users and injects the local token upstream. An ordinary HTTPS proxy alone does not provide that authentication. See [OpenAI's authentication contract](https://developers.openai.com/plugins/build/auth). Never choose anonymous public access for this account-level terminal.

## 4. Update an existing connection

For a deployment running directly from a clean clone of this public repository:

```bash
git pull --ff-only
mkdir -p .tmp .cache/npm
TMPDIR="$PWD/.tmp" npm_config_cache="$PWD/.cache/npm" \
  npm ci --prefix mcp_server
python3 -B mcp_server/scripts/service.py restart
python3 -B mcp_server/scripts/service.py status
curl --noproxy '*' -fsS http://127.0.0.1:5679/healthz
```

Use your deployment's existing update process if its source lives elsewhere. Retain the local configuration and token. In stdio deployments, restart the tunnel-managed MCP child instead; the commands above manage the HTTP service.

In ChatGPT Plugins, open the saved connection, choose **Refresh**, check the tool names and parameters, then start a new conversation. This is the documented [developer-mode refresh flow](https://developers.openai.com/plugins/deploy/connect-chatgpt#refresh-metadata). A server implementation change is active after deployment; changed tool schemas also require refreshing ChatGPT's metadata. GitHub pushes, local plugin manifests, and server restarts do not themselves refresh that saved metadata.

If older tools remain visible, check the connection targets the intended tunnel/server and uses `tools.profile="minimal"`. `execute_command` must now accept `sessionId`, `input`, `key`, and `cursor`; `get_file` must accept `offset`. If Refresh is unavailable, verify developer-mode access and create a new connection to the same working tunnel. Keep the existing connection until the new one passes discovery.

### A displayed version stays at 1.0.0

First identify the field: the server's runtime version is returned by `/healthz` and MCP `initialize.result.serverInfo.version`. Local plugin package versions and a saved ChatGPT connection's metadata are separate records; updating a local manifest does not edit that connection. A `schemas/1.0.0/` URL in a manifest identifies a file-format specification, not the server release.

If runtime checks report the expected version but ChatGPT still advertises older tool names or parameters, refresh the connection and check again in a new conversation. The displayed number alone cannot establish which server is running. Check both the connected endpoint and the discovered tool schema before diagnosing an update failure.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Local health fails | Service status, listener, and configured runtime logs. |
| Tunnel is absent in ChatGPT | Workspace association and Tunnels Read + Use. |
| Discovery returns 401 | Both forwarding and discovery headers use the existing local MCP token. |
| Tunnel disconnects | Tunnel client process, outbound connectivity, and runtime key. |
| New code, old tools | Refresh the saved connection and use a new conversation. |
| Public HTTPS fails authentication | Implement the OAuth gateway; a local token environment variable is not a ChatGPT credential setting. |

### A tool stays pending, then `stream recovery polling timed out` appears

The browser message alone does not establish that the terminal command failed, or that the browser received its result. Correlate the affected call's time with the MCP HTTP audit and tunnel response records. OpenAI's [troubleshooting guide](https://developers.openai.com/plugins/deploy/troubleshooting) separates server, streaming-proxy and ChatGPT-client checks; it does not specify a fixed timeout for this error.

For long commands, use a stable `terminalKey`, submit with `waitMs=1000` and `maxBytes=16384`, and save `sessionId`, `commandId` and `nextCursor`. Read the saved command with `waitMs=5000` and no `command`. After a lost submission reply, inspect the original key before deciding whether anything needs to run. Short waits and bounded pages reduce time spent in each tool request; they do not guarantee recovery of ChatGPT's answer stream. Saved task IDs remain usable in a new conversation.

If the host returns `Unknown tool` without a corresponding local request, check the selected plugin and refresh discovery in a new conversation. That error is separate from terminal execution.

Collect the affected time window, including its timezone (replace these example times):

```bash
python3 -B mcp_server/scripts/diagnose_transport.py \
  --since 2026-09-26T23:00:00+08:00 \
  --until 2026-09-26T23:10:00+08:00
```

Reports go to workspace-local `outputs/mcp-diagnostics`; pass `--config` for another deployment. The audit includes retained rotated segments and requests overlapping the window, with no command bodies or authorization headers. Tunnel counters remain cumulative since process start. HTTP 200 alone establishes neither tool success nor browser receipt. Missing records can also mean the relevant audit data was not retained.


On `nextAction:defer`, report that the task is still running, save `monitoring.resume`, and end foreground polling for the turn. `checkAfterMs` is a suggested next check, not an ETA or an automatic reminder. Only present an ETA if supported by a caller-provided estimate; unknown or exceeded estimates remain unknown.

# Connect Terminal Workspace MCP to ChatGPT

[中文](CHATGPT.zh-CN.md) · [Operator guide](README.md)

The MCP process runs on your Linux machine. ChatGPT calls it remotely; GitHub hosts the source. This guide covers a personal developer-mode connection. Documentation checked against official OpenAI guidance on 2026-09-25.

## 1. Start the local service

Install the prerequisites and dependencies from the repository README. Run these commands from the repository root. Use one persistent `auth.token` in the ignored `mcp_server/config.local.json` (mode 0600), or export `MCP_AUTH_TOKEN` before starting the service. Reuse that same token for the tunnel.

```bash
python3 -B mcp_server/scripts/service.py start
python3 -B mcp_server/scripts/service.py status
curl --noproxy '*' -fsS http://127.0.0.1:5679/healthz
```

With the default configuration, health reports `version: "0.4.1"`, `toolProfile: "minimal"`, and `toolCount: 2`. Adjust the URL if you changed the listener. Health is a liveness check; it does not prove authenticated tool discovery works.

## 2. Connect a Secure MCP Tunnel

For personal use, keep the MCP listener on loopback. Obtain the official tunnel client and create a tunnel following [OpenAI's Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels). Associate it with the ChatGPT workspace that will use it; the creator needs Tunnels Read + Use. The client needs outbound HTTPS to OpenAI and access to the local MCP listener.

The following HTTP example uses flags supported by the runtime client. Set the executable path to your downloaded binary. Check its `run --help` for version-specific options. Enter the tunnel ID and runtime control-plane key supplied by your tunnel setup, and the **existing local MCP token** from step 1:

```bash
TUNNEL_CLIENT="/absolute/path/to/tunnel-client-runtime"
read -r -p 'Tunnel ID: ' CONTROL_PLANE_TUNNEL_ID
read -r -s -p 'Tunnel runtime key: ' CONTROL_PLANE_API_KEY
printf '\n'
read -r -s -p 'Existing MCP token: ' MCP_AUTH_TOKEN
printf '\n'
export CONTROL_PLANE_TUNNEL_ID CONTROL_PLANE_API_KEY
export MCP_RUNTIME_AUTH="Bearer $MCP_AUTH_TOKEN"
mkdir -p .tmp .cache .local/config

TMPDIR="$PWD/.tmp" XDG_CACHE_HOME="$PWD/.cache" \
XDG_CONFIG_HOME="$PWD/.local/config" \
"$TUNNEL_CLIENT" run \
  --mcp.server-url http://127.0.0.1:5679/mcp \
  --mcp.extra-headers 'Authorization: env:MCP_RUNTIME_AUTH' \
  --mcp.discovery-extra-headers 'Authorization: env:MCP_RUNTIME_AUTH' \
  --health.listen-addr 127.0.0.1:8791
```

Keep this process running. For an existing deployment, reuse its running tunnel instead of starting another poller with the same tunnel ID. The tunnel runtime key authenticates to OpenAI; the separate MCP token authenticates the local forwarding hop. The service helper manages the MCP server and optional TCP relay, not the tunnel client. Use your process manager to persist the tunnel.

Changing `client.url` or running `config.mjs sync-plugin` updates generated connection files only. It does not configure the tunnel or register an app in ChatGPT.

## 3. Add the connection in ChatGPT

Enable Developer mode under **Settings → Security and login**. Open [ChatGPT Plugins](https://chatgpt.com/plugins), choose **+**, name the connection **Terminal Workspace MCP**, and select **Tunnel**. Choose the tunnel or enter its ID, then create the connection. Access depends on account and workspace policy. See [OpenAI's connection instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt).

Confirm discovery lists only `execute_command` and `get_file` with the default profile. Open a new conversation, enable the connection, and ask it to run `pwd`. A successful command result includes `sessionId`, `stdout`, and `nextCursor`.

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

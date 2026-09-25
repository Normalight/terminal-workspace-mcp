# CSY Workspace MCP Plugin

Connect to a self-hosted CSY Workspace MCP server through two tools: `execute_command` for persistent tmux execution, input, and output polling; `get_file` for original files and images. Directory operations, text editing, search, Git, and process management use ordinary shell commands.

Set `CSY_MCP_TOKEN` in the client environment using the same token as the server. Connection files are generated from `mcp_server/config.json` (`client.url` and `client.tokenEnv`). Run `node mcp_server/scripts/config.mjs sync-plugin` from the repository root after changing those fields. Do not edit `mcp.json` or `.mcp.json` by hand. The portable and Codex plugin manifests use the same connection configuration.

The `csy-workspace-operator` skill explains session reuse, interactive input, output cursors, and chunked file retrieval. Plugin and server release versions are 0.4.0. Development installations may carry a Codex cachebuster suffix. The source package uses the [MIT license](LICENSE).

The server's default `minimal` profile advertises two tools. Refresh the client's connection/tool discovery after upgrading; the server cannot replace schemas already captured in an existing client turn. `/healthz` reports version, revision, profile, and tool count.

Install through the client's local plugin mechanism. If using a local marketplace, point its entry to this package and reinstall the updated package from that marketplace. This repository does not create or modify a global marketplace.

See `../../mcp_server/README.md` for examples, runtime settings, session management, the service helper, and validation.

The checked-in endpoint is loopback for local setup. Configure `client.url` for your server and regenerate connection files before installing the plugin for remote use. See the project [security guidance](../../mcp_server/SECURITY.md) for the service account access model.

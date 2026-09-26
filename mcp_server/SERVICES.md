# Independent services

Terminal Workspace runs directly from this repository. It needs Linux, Node.js, tmux, Bash, Python and a systemd user manager; it has no botmux runtime, API or startup dependency. A foreground process or `setsid` alone does not give it an independent lifecycle: it can remain inside the caller's cgroup.

## Prepare and review

Configure `mcp_server/config.local.json` (mode 0600), or supply an explicit `--config /absolute/deployment.json`. A deployment may use a workspace outside the source checkout. Keep source, dependencies, runtime data, caches and private configuration on persistent storage. Keep dependency symlink targets independent of temporary checkouts.

```bash
python3 -B mcp_server/scripts/services.py prepare
```

This writes units and their manifest under the configured `paths.service/systemd` directory. It does not register or start anything. It prepares:

| Unit suffix | Responsibility | Restart behavior |
| --- | --- | --- |
| `terminals` | Own the private tmux server, shells and log collectors | Survives MCP/relay/tunnel restarts; stopping it ends its tasks |
| `server` | MCP HTTP listener | Rebuild HTTP sessions; persisted terminal IDs/commands remain readable |
| `relay` | Optional TCP forwarding | Clients reconnect; terminal execution continues |
| `tunnel` | Optional external tunnel client | Clients reconnect; terminal execution continues |

Units use an explicit executable, config path, working directory and workspace cache paths. The server and relay ignore ambient deployment overrides under service supervision. New shells and collectors start with an explicit private environment snapshot, even when the tmux daemon was adopted from an older caller. They strip caller routing and service authentication variables. Existing processes retain their own environment until they finish. Runtime logs rotate at 8 MiB with eight retained segments per stream. Units contain no tokens; the optional tunnel specification is private. Bootstrap errors use a separate local stderr file.

To supervise an existing tunnel, add `--tunnel-spec /absolute/private-tunnel.json` to `prepare`. The generic specification is `{ "executable": "/absolute/client", "args": [], "environment": {} }`; provide its existing launch arguments and only the variables required by that client. Direct its own log output to stdout/stderr. This project does not download, authenticate or invent a tunnel route.

Validate generated units with `systemd-analyze --user verify /absolute/runtime/systemd/*.service` and inspect them before installation. `prepare` is also the update step when the source path, executable or configuration changes; run `install` again afterward.

## Install and operate

Registration creates symlinks in systemd's user-unit directories. Enabling linger writes system-managed user state. If the workspace policy forbids these paths, obtain an explicit exception before these steps; preparation and tests can still run entirely inside the workspace.

```bash
python3 -B mcp_server/scripts/services.py install
loginctl enable-linger "$USER"
python3 -B mcp_server/scripts/services.py start --component all
python3 -B mcp_server/scripts/services.py status --component all
```

Pass the same `--config` on every command for a separate deployment. Linger keeps the user manager available after logout and starts it at boot; authorization depends on the host. A machine reboot restarts services but cannot resume the old tmux processes.

Use `restart --component server` for MCP updates. The MCP process drains finite replies before exit: pending terminal/batch waits return early with saved task state and `serverRestarting:true`, while tasks continue. New calls receive an explicit pre-dispatch rejection, allowing the reconnecting client to reinitialize after the update. This graceful path does not apply to SIGKILL, power loss or a process crash. `restart --component all` restarts network components while keeping tmux running. The helper refuses `stop`/`restart --component terminals`; use systemctl deliberately only after inspecting active tasks. After installation, the older `service.py` entry point delegates to the supervisor. Before installation it remains a local detached development launcher, with no promise of survival after its caller's cgroup is removed.

## Migrate a running deployment

Preserve the configured terminal root and socket. The terminals unit can adopt an existing tmux server and its descendants through the local systemd manager, verifying process identity and ownership before moving them into its cgroup. It does not replace shells or upgrade running shell hooks. Completed legacy receipts without a recorded byte boundary are returned as incomplete history.

Stop the old MCP and relay listeners before starting their replacements. Stop the old tunnel client before starting the same tunnel identity under supervision; do not run two pollers for one identity. Inspect any legacy batch-job supervisors separately: they are outside the tmux tree and need deliberate cgroup migration. Keep the original source available until old shells and collectors no longer reference it.

Verify the process cgroups, not just parent PIDs. The tmux unit, MCP, relay and tunnel must each belong to their corresponding service. Check `/healthz` for the expected version/revision, then submit a disposable command once, restart the MCP unit, and recover by saved `sessionId`/`commandId`. Confirm a single side effect, output boundaries, independent parallel terminal keys and the tunnel health endpoint. Inspect `NRestarts` and logs if any layer repeatedly restarts.

The adoption mechanism uses systemd's [manager D-Bus interface](https://github.com/systemd/systemd/blob/main/man/org.freedesktop.systemd1.xml). It requires a user manager with `AttachProcessesToUnit` and cgroup delegation. Hosts without that support should drain the old deployment before starting a new terminal service.

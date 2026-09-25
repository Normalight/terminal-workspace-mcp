---
name: terminal-workspace-operator
description: Operate the connected machine using shell commands in persistent tmux sessions and retrieve original files through MCP. Use for remote work on the connected server.
---

# Terminal Workspace Operator

Use `execute_command` for operations and `get_file` to retrieve artifacts. Paths may be absolute, `~/`, or relative to the configured default workspace; account permissions apply. Output retains its original content. Follow the user's task authorization and filesystem constraints.

Prefer absolute paths on every call. Set an absolute `cwd` for a new session; on reused sessions use absolute operands or an explicit `cd -- /absolute/path`. Do not depend on a previous shell's directory or environment after idle reclamation.

- Start with `execute_command({command,cwd,waitMs:1000})`. Keep the returned `sessionId` and reuse it to preserve directory, environment, and shell state. `cwd` applies only to new sessions; use `cd` in existing shells.
- Start a long task once. While `status=running`, poll with `{sessionId,cursor:nextCursor,waitMs:10000,maxBytes:65536}` and no `command`; increase waits up to 30000ms when output is sparse. Waiting expiry or a connection error is not a reason to launch it again. Check `status` and `exitCode`, then drain remaining output before reporting completion. Consume `structuredContent` for full pages. Output is merged PTY stdout/stderr and can contain ANSI sequences and command echo.
- Save sessionId, nextCursor, commandId and absolute log/artifact paths for handoff. tmux retains running processes across MCP restarts, but future monitoring needs an active client or separately configured scheduler. Start a replacement for a reclaimed idle shell only once the previous command's outcome is known.
- Answer prompts with `{sessionId,input:"yes\n"}` or interrupt with `{sessionId,key:"C-c"}`. Do not combine `command` with input/key. Each shell accepts one tracked command at a time; independent work may open another.
- Use ordinary shell commands for files, search, Git, and process management. For structured results, redirect output to a file. Preserve `PROMPT_COMMAND` and internal command-tracking variables used for exit-code tracking.
- Inspect ownership and window/pane IDs with `node "$MCP_TERMINAL_ADMIN" list`. `cleanup` previews the configured policy; `cleanup --apply` rechecks and reclaims eligible sessions, keeping logs. Defaults: check every 30 seconds, reclaim exited sessions and shells idle for five minutes. Running commands, child processes, attached clients, modified layouts and `@mcp_keep=1` are protected. Check `jobs -pr` before ending an unneeded shell with `command:"exit"`.
- To retain idle shell state, set SESSION_ID to the returned ID and run `tmux -S "$MCP_TERMINAL_ROOT/tmux.sock" set-option -t "$SESSION_ID" @mcp_keep 1`; unset the option when done. Never use a name prefix alone to infer ownership or kill the default tmux server. Runtime root and admin helper variables are set in new MCP shells; older sessions can use the paths from the deployment configuration and repository.
- `get_file({path})` returns an original small file/image and whole-file SHA256. Large files use `{path,offset:0,maxBytes:1048576}`, then `offset:nextOffset` until `eof`. Decode and concatenate resource blobs in order; chunk checksums cover only their byte range. Use `sha256sum` for a full-file checksum when needed.

The default server advertises two tools. `/healthz` reports deployed version, revision, and tool count. A client with stale tool schemas needs a fresh discovery session. Authentication stays in local configuration.

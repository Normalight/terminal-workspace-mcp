---
name: csy-workspace-operator
description: Operate the connected CSY machine using shell commands in persistent tmux sessions and retrieve original files through MCP. Use for remote work on the CSY server.
---

# CSY Workspace Operator

Use `execute_command` for operations and `get_file` to retrieve artifacts. Paths may be absolute, `~/`, or relative to the configured default workspace; account permissions apply. Output retains its original content. Follow the user's task authorization and filesystem constraints.

- Start with `execute_command({command,cwd,waitMs:1000})`. Keep the returned `sessionId` and reuse it to preserve directory, environment, and shell state. `cwd` applies only to new sessions; use `cd` in existing shells.
- For running commands or unread output, call `execute_command({sessionId,cursor:nextCursor,waitMs:1000})`. `waitMs` and `maxBytes` limit this response, not the process. Consume `structuredContent` for full pages. Output is merged PTY stdout/stderr and can contain ANSI sequences and command echo.
- Answer prompts with `{sessionId,input:"yes\n"}` or interrupt with `{sessionId,key:"C-c"}`. Do not combine `command` with input/key. Each shell accepts one tracked command at a time; independent work may open another.
- Use ordinary shell commands for files, search, Git, and process management. For structured results, redirect output to a file. Preserve `PROMPT_COMMAND` and internal `__csy_*` variables used for exit-code tracking.
- Sessions survive MCP restarts. Recover with the saved sessionId; list or manage them through `tmux -S "$MCP_TERMINAL_ROOT/tmux.sock"`. `command:"exit"` ends a shell; use `tmux kill-session -t <id>` to remove its pane. Close only sessions belonging to the completed task when no longer needed.
- `get_file({path})` returns an original small file/image and whole-file SHA256. Large files use `{path,offset:0,maxBytes:1048576}`, then `offset:nextOffset` until `eof`. Decode and concatenate resource blobs in order; chunk checksums cover only their byte range. Use `sha256sum` for a full-file checksum when needed.

The default server advertises two tools. `/healthz` reports deployed version, revision, and tool count. A client with stale tool schemas needs a fresh discovery session. Authentication stays in local configuration.

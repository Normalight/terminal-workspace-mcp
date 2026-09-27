---
name: terminal-workspace-operator
description: Operate a connected Terminal Workspace MCP server using persistent terminal tasks, reconnect or resume saved commands, inspect command output, and retrieve original files. Use for remote shell work on that connected machine.
---

# Terminal Workspace Operator

Use `execute_command` for shell operations and `get_file` for artifacts. Follow the user's authorization and filesystem constraints; the server runs with its service account's permissions. Prefer absolute paths and set an absolute `cwd` when creating a shell.

## Submit once and recover

Choose a stable `terminalKey` such as `project/agent/task` **before the first call**:

```json
{"terminalKey":"project/agent/task","command":"your command","cwd":"/absolute/project","waitMs":1000}
```

Save `sessionId`, `commandId`, `nextCursor`, and artifact paths. The key locates a shell; it does not deduplicate command submissions. Different agents/tasks should use distinct keys. A shell accepts one active tracked command; `terminal_busy` requires reading or interacting with its current task.

While `status` is `starting` or `running`, poll without `command`:

```json
{"sessionId":"term_...","commandId":"cmd_...","cursor":1234,"waitMs":10000,"maxBytes":65536}
```

Use the previous `nextCursor`. Follow `nextAction`: `poll` for active work, `read_output` for remaining pages, `input` for confirmed terminal input, `inspect` for uncertainty or missing output, and `done` to stop polling. A final status ends execution; drain remaining pages and report gaps, which do not disappear by polling. Check `status`, `exitCode`, `outputGap` and `outputComplete` before reporting success and complete output. TextContent and structuredContent both carry the full bounded result.

During a planned update, `serverRestarting:true` returns the current task state early. Reconnect/reinitialize and continue reading the saved IDs; the task keeps running. A lost reply, expired wait or reconnect is never permission to resubmit. If the first reply is lost, inspect the saved key without `command`. For `submission_uncertain` or `unknown`, inspect the saved command and its side effects; do not automatically replay. `submission_failed` provides a recovery selector and indicates failure before dispatch. HTTP `MCP-Session-Id` is a transport identifier, separate from the terminal's `sessionId`; an expired HTTP session needs fresh initialization, then reads of the saved task.

Running calls subscribe to `notifications/message` with logger `terminal-workspace.completion`. If `completionNotification.listening` is false or the host cannot handle notifications, keep polling. After reconnect, resubscribe with saved IDs and `notifyOnCompletion:true`. Events need a running client and do not start another model turn or wake an offline agent. The provided completion client supports private `--resume` checkpoints and marks incomplete output explicitly.

## Understand output and shell state

The default output scope is the tracked command's byte range. Without `cursor`, reads start at that command's beginning. Always save `commandId` for historical reads; omitting it selects the shell's latest command. `outputScope:"terminal"` explicitly reads the shared PTY stream, with tail semantics when no cursor is given.

PTY output merges stdout/stderr (`stderr` is empty). It may include ANSI, interactive echo and background-process output during that command's time range. Use dedicated output files for exact per-process stdout/stderr. Retention, a failed collector or old receipts without boundaries cause `outputGap:true`; execution success alone does not guarantee complete output.

`cwd` applies only on creation; use `cd -- /absolute/path` in an existing shell. Closed/reclaimed keys can return a replacement shell on a new command; initialize its cwd/environment again. Keep the original `sessionId` to read its old history. tmux tasks survive MCP restarts, but do not survive machine reboot or termination of their tmux server.

Answer prompts using `{sessionId,input:"yes\n"}` or interrupt using `{sessionId,key:"C-c"}`. Send commands and interactive input in separate calls. Preserve `PROMPT_COMMAND`, the `DEBUG` trap and internal tracking variables. Long work should stay in the foreground; a command ending in `&` completes when its shell returns.

New terminals disable automatic pagers. Existing shells may still launch one: prefer `git --no-pager` for status queries. When `interaction.type` is `pager`, inspect the output and deliberately send `{sessionId,input:"q"}` to leave it when finished reading. Polling cannot dismiss a pager; do not confuse it with a completed command or retry the command.

## Manage resources and files

- Use shell commands for files, search, Git and processes. Inspect managed ownership/panes with `node "$MCP_TERMINAL_ADMIN" list`. `cleanup` previews policy; `cleanup --apply` rechecks eligible sessions. Running/uncertain commands, child processes, attached clients, modified layouts and `@mcp_keep=1` are protected. Check `jobs -pr` before ending an unneeded shell with `command:"exit"`.
- To retain idle state, set `SESSION_ID` to the returned ID and run `tmux -S "$MCP_TERMINAL_ROOT/tmux.sock" set-option -t "$SESSION_ID" @mcp_keep 1`; unset when done. Never infer ownership from a name prefix or kill the default tmux server. Older shells may need the configured runtime/helper paths supplied explicitly.
- `get_file({path})` returns a small original file/image and whole-file SHA256. For large files, start with `{path,offset:0,maxBytes:1048576}`; then use `offset:nextOffset` **and `expectedVersion` set to the first response's `version`**, until `eof`. `file_changed` requires restarting the transfer from a stable artifact. Decode blobs in order; chunk checksums cover only their range. Use a whole-file checksum for final verification.

Multiple MCP clients may call concurrently and read with independent cursors. Keys and HTTP sessions are coordination identifiers, not security boundaries; agents share account permissions. The default server exposes two tools. `/healthz` reports version, revision and tool count. Refresh saved client discovery when schemas are stale. Authentication stays in local configuration.


For long output, consume pages while the command runs and persist each nextCursor; do not wait until completion before draining logs that may rotate. The SDK's awaited onPage callback supports output consumption and checkpoint persistence. A failed consumer stops at its last acknowledged cursor. A replayed output page after a crash does not authorize replaying a command.

For status checks without logs, send statusOnly:true with a saved commandId. Such replies have outputRead:false and no nextCursor; retain your existing cursor, then fetch output on read_output. Record requestId when reporting a stuck call so the operator can correlate tool_result and HTTP delivery. interactionHint is uncertain I/O evidence, not permission to send input or cancel. Inspect the prompt before interacting; a silent task can still be working.

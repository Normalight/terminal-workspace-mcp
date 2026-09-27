# Changelog

## 0.5.3 — 2026-09-27

- Stream bounded output pages through an awaited SDK consumer and advance checkpoints only after consumption; status-only waits avoid retransmitting logs.
- Add statusOnly reads with explicit outputRead=false and a separate output-drain action; no output cursor is advanced by a metadata query.
- Correlate tool start/result and HTTP delivery records by request ID and saved command IDs, with allowlisted status metadata and command-filtered diagnostics.
- Detect observable terminal stdin reads and distinguish uncertain I/O hints on restricted kernels from confirmed interactive input.
- Add retention/reconnect, consumer-failure, concurrent-audit and silent/input-wait regressions, plus an isolated configurable concurrent soak with fault injection.

## 0.5.2 — 2026-09-27

- Preserve full bounded results in TextContent as well as structuredContent, including final status and cursors for replies above 4 KiB.
- Return an explicit nextAction for polling, reading remaining output, interactive input, inspection or stopping. Missing output does not require endless polling.
- Disable automatic pagers in new shells and detect foreground pagers, including Git child processes. Existing shells keep their environments; interactive pagers require deliberate input.
- Expose polling fallback when no notification stream exists. SDK completion waits reconcile every second in that case and report interaction_required for pagers.

## 0.5.1 — 2026-09-26

- Drain finite MCP responses before a planned restart; return running task IDs/cursors with `serverRestarting:true` while leaving execution alive.
- Reject new calls during draining before dispatch and let the reconnecting client retry only the origin's explicit rejection. Generic gateway 503s remain uncertain.
- Interrupt terminal and batch wait loops during service updates, preserve active tasks and restore monitoring on the new connection.

## 0.5.0 — 2026-09-26

- Bound default output to the saved command, preserve missing-byte evidence, and distinguish command completion from output completeness. Explicit terminal scope retains PTY tail reads.
- Persist shell execution receipts independently of log collection, identify failed/uncertain submissions, and keep incomplete legacy histories bounded.
- Cancel stalled initialization promptly, enforce total completion deadlines, and retry a command only after a definitive origin rejection of its expired HTTP session.
- Add file-version guards for chunked transfers and validate saved resume identities/output completeness.
- Isolate new shells and collectors from stale tmux-server environments, and propagate inspection failures without replacing a live keyed terminal.
- Split command lifecycle, shell protocol, output paging, request policy and checkpoint helpers.
- Add independent systemd services for MCP, tmux, relay and optional tunnel, explicit private configuration, workspace logs and safe adoption of existing tmux processes.
- Verify six concurrent clients, independent read cursors, same-shell contention, exactly-once observed side effects across MCP restart, and output-loss recovery.


- Add bounded client reconnect, shared initialization, durable completion reconciliation and private resumable checkpoints; never replay uncertain command submissions.
- Return session recovery guidance on HTTP 404 and audit responses interrupted before completion.

- Reuse tmux shells across MCP connections/restarts by durable task keys; preserve lookup-only history, report closed-shell replacement, and reject commands while an interactive shell is busy.
- Serialize terminal creation across processes and count live tmux sessions without scanning archived command histories.

- Reclaim idle MCP sessions under capacity pressure, reserve concurrent handshake slots, and protect live requests/SSE listeners; shorten default idle retention to two minutes.
- Clarify HTTP/session/terminal reuse, report whether completion listeners are connected, and test sustained fresh-client traffic plus persistent listener reuse.

- Push per-connection command completion notices over MCP logging/SSE or stdio, with bounded subscriptions, opt-out, reconnect re-subscription, and a runnable client example.
- Document event handling, polling fallback, command IDs, and output-drain recovery in tools, server instructions, and operator guidance.

- Confirm terminal completion after preceding PTY output is written, and refresh output when a command finishes during polling.
- Keep a verified process-group supervisor alive so cancellation and deadlines can terminate descendants after their shell exits.
- Require a current Bash prompt marker for idle reclamation, protecting interactive builtins. Older shells without this hook remain protected from idle cleanup.
- Cap default file-transfer chunks at 1 MiB even when the direct-file response budget is larger.

## 0.4.1 — 2026-09-26

- Deliver server instructions in the standard MCP initialization field.
- Guide long-running commands through polling, completion checks, and recovery; prefer absolute paths.
- Identify managed tmux sessions through a private socket, metadata, and ownership tags, with verified legacy-session recognition.
- Reclaim exited sessions and shells idle for five minutes by default, retaining logs. Protect active commands, child processes, attached clients, kept sessions, and modified layouts.
- Add a terminal inventory/cleanup CLI and cross-process locking with Linux `flock`.

## 0.4.0 — 2026-09-25

Initial public source release.

- Two-tool default interface: persistent shell execution and original file retrieval.
- tmux session reuse, interactive input, control keys, and restart persistence.
- Bounded output pages, byte cursors, raw log rotation, and optional retention.
- Original image/binary transfer, file chunks, and SHA256 checksums.
- Negotiated gzip for finite HTTP JSON responses.
- Unified deployment configuration, local overrides, plugin generation, and service/relay management.
- Optional compatibility profile for individual file, search, terminal, and batch-job APIs.
- Linux integration tests for configuration, HTTP authentication, compression, process lifecycle, and data integrity.

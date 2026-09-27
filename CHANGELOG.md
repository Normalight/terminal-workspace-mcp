# Changelog

## 0.5.10

- Lead monitoring topics with the user goal and expected deliverable, with explicit missing-purpose handling and improved submission guidance.
- Add opt-in bounded command-output progress: structured MCP_PROGRESS reports, stage counters, recent log evidence, report age and output silence. Redact common credentials before forwarding.
- Suppress unchanged progress until a configurable heartbeat while always reporting completion; keep evidence available when agent summaries time out.

## 0.5.9

- Delegate long tasks to an optional botmux agent in a dedicated new topic, with periodic state summaries and explicit recipient mentions on start and completion. Persist task/topic/event routing across restarts.
- Send plain, consistently formatted messages through explicit bot identity; bound agent deadlines fall back to observed task state.
- Retain fixed-session completion mode for existing configurations. Document both modes and their retry boundaries.
- Verify retained exit receipts after tmux pipe draining and wait for final state in CI regressions instead of assuming a fixed two-second completion.

## 0.5.8

- Drain completed terminals on tmux versions that reject closing an exited pane pipe. Persist the exit receipt before retiring that dead pane, and preserve all buffered final output for later reads.
- Cover the tmux rejection path with a large-output regression and retain the Node.js 22/24 CI matrix.

## 0.5.7

- Make Secure MCP Tunnel the primary ChatGPT onboarding path in both READMEs; include credential setup, readiness checks, app form values and metadata refresh.

- Persist optional submission-only `taskSummary` text and include purpose/result summaries in long-task completion notices, including after client/server restarts.
- Use coarse command-type descriptions when no summary was supplied, escape display markup, and keep command arguments and raw logs out of automatic summaries.
- Document fixed botmux session routing, which selects both the sending bot and notification destination.

## 0.5.6

- Add opt-in persistent completion watches with an explicit botmux session destination and long-task threshold; command execution remains independent of botmux availability.
- Recover watches across MCP restarts, deduplicate readers/senders, retry reported send failures with backoff, and surface interrupted/unconfirmed delivery without blind replay.
- Keep completion messages limited to task identifiers/status and isolate tests from production notification routing.

## 0.5.5

- Long terminal commands return explicit foreground defer guidance after a configurable 30-second task-age budget, without cancelling work or changing completion state.
- Persist optional caller runtime estimates; distinguish remaining estimates from suggested check intervals and report exceeded/unknown estimates honestly.
- Add `monitorUntilYield` for clients that should return control with resumable checkpoints; retain `waitForCompletion` for explicit continuous monitoring.

## 0.5.4 — 2026-09-27

- Cap HTTP execution/output waiting at a configurable five seconds even when a caller uses a cached schema and requests thirty seconds. Return requested/effective wait metadata without stopping or replaying the task.
- Explicitly close finite MCP HTTP connections by default while retaining MCP session identity and leaving notification SSE open; deployments can opt back into TCP keep-alive.
- Include bounded, allowlisted tunnel error events in incident diagnostics so connection failures before MCP dispatch are visible alongside origin audit records.

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

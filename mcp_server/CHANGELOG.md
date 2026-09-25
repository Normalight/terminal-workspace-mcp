# Changelog

## Unreleased

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

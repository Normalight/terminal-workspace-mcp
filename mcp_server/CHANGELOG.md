# Changelog

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

# Contributing

Use GitHub issues for reproducible bugs and feature proposals, and pull requests for changes. For security-sensitive reports, follow [SECURITY.md](SECURITY.md).

## Development setup

From the repository root on Linux, install Node.js 22+, tmux 3.2+, Bash, and Python 3.9+:

```bash
mkdir -p .tmp .cache/npm
npm_config_cache="$PWD/.cache/npm" npm ci --prefix mcp_server
node --test mcp_server/test/*.test.mjs
node mcp_server/scripts/measure_tools.mjs
```

The tests create their own workspace directories and local ports, then clean up their processes. They use synthetic authentication values. Keep caches, local configuration, task logs, and tmux sockets out of commits.

## Pull requests

Describe the user-visible problem, the final behavior, and the validation performed. Keep changes scoped. Include a regression test when fixing command lifecycle, output integrity, HTTP behavior, configuration, or file-transfer bugs. Documentation-only changes should verify examples and relative links.

Preserve these interface properties:

- The default profile exposes `execute_command` and `get_file`.
- Response waiting and pagination do not implicitly terminate commands.
- Original file bytes and output cursors remain verifiable.
- tmux sessions are independent of MCP HTTP sessions.
- Configuration examples work from a new checkout and contain no personal deployment values.

Run the tests and `git diff --check` before submitting. If dependency versions change, update the npm lockfile. New dependencies must have an identified license compatible with distribution.

By contributing, you agree that your contributions are distributed under the project's MIT license. Third-party code must retain its original notices.

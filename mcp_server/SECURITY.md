# Security and deployment

## Access model

This is a single-account remote shell for trusted clients and agents. A valid token can authorize commands with the operating-system permissions of the server account. Commands may modify files, start network requests, and access paths outside the default workspace. `workspaceRoot` selects defaults and managed state locations; it is not an account-permission boundary.

`tools.enableWrite` controls compatibility file APIs. Shell access is controlled by `tools.enableTerminal`; disabling the file API does not prevent a shell from writing files. File contents and terminal logs are retained without redaction. The service does not provide tenant isolation or per-user authorization.

## Deployment

- Keep the default loopback listener for local use. For remote use, place the service behind HTTPS or an authenticated tunnel; the server itself speaks HTTP.
- Use a dedicated account with permissions appropriate to the tasks you intend to allow. Use a strong token, keep it in environment configuration or the ignored local overlay, and restrict access to runtime logs and files.
- Retain or archive raw logs deliberately. Default log retention preserves history; configure `logs.maxSegments` and clean up completed task state as needed.
- Authentication is applied to MCP HTTP requests. `/healthz` and `/metrics` expose operational metadata, including workspace and configuration paths; restrict access to these endpoints at the network/proxy boundary when needed.
- Stdio trusts the parent process and bypasses HTTP authentication. Terminal execution still requires a configured token in the current implementation.

## Reporting vulnerabilities

Use [GitHub private vulnerability reporting](https://github.com/Normalight/terminal-workspace-mcp/security/advisories/new) for authentication bypass, unintended file disclosure, process-isolation failures, or related vulnerabilities. Include affected versions, a minimal reproduction, and the expected versus observed behavior. Do not include live credentials or private terminal logs.

If private reporting is unavailable, open an issue requesting a private contact channel without disclosing exploit details. Security fixes target the latest release; there is no separate long-term support branch or guaranteed response time.

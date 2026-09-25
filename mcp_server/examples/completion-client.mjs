import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../src/config.mjs';

const commands = process.argv.slice(2);
if (!commands.length) throw Error('Usage: node mcp_server/examples/completion-client.mjs <shell-command> [next-command ...]');
const deployment = loadConfig();
const url = process.env.MCP_NOTIFICATION_URL ?? `${deployment.healthOrigin}${deployment.config.http.path}`;
const client = new Client({ name: 'completion-example', version: '1' });
const received = new Map();
let wake;
client.setNotificationHandler(LoggingMessageNotificationSchema, ({ params }) => {
  if (params.logger !== 'terminal-workspace.completion' || params.data?.event !== 'command_completed') return;
  received.set(params.data.commandId, params.data);
  wake?.();
});
const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${deployment.env.MCP_AUTH_TOKEN}` } },
});
async function call(args) {
  const response = await client.callTool({ name: 'execute_command', arguments: args });
  if (response.isError) throw Error(JSON.stringify(response.content));
  return response.structuredContent;
}
let timer;
try {
  await client.connect(transport);
  await client.setLoggingLevel('notice');
  let sessionId;
  // All commands, their event subscriptions and output reads share one Client,
  // one MCP session/SSE stream, and one persistent terminal.
  for (const command of commands) {
    const initial = await call({ command, sessionId, cwd: deployment.config.workspaceRoot, waitMs: 0, notifyOnCompletion: true });
    sessionId = initial.sessionId;
    const { commandId } = initial;
    console.error(JSON.stringify({ sessionId, commandId, nextCursor: initial.nextCursor, completionNotification: initial.completionNotification }));
    if (!initial.completionNotification?.subscribed) throw Error('Completion subscription unavailable; resume using the saved IDs.');
    process.stdout.write(initial.stdout);
    // The handler is installed before tools/call: fast completions cannot race
    // ahead of listener registration. Waiting here sends no status/tool requests.
    const completed = await new Promise((resolve, reject) => {
      wake = () => { if (received.has(commandId)) resolve(received.get(commandId)); };
      timer = setTimeout(() => reject(Error('No completion event within 30 minutes; reconnect and re-subscribe using saved IDs.')), 30 * 60 * 1000);
      wake();
    });
    clearTimeout(timer);
    console.error(JSON.stringify(completed));
    let cursor = initial.nextCursor;
    for (;;) {
      const page = await call({ sessionId, commandId, cursor, waitMs: 0 });
      process.stdout.write(page.stdout); cursor = page.nextCursor;
      if (!page.outputTruncated) break;
    }
    received.delete(commandId); wake = undefined;
    if (completed.exitCode !== 0) process.exitCode = 1;
  }
} finally {
  clearTimeout(timer);
  // Terminate the MCP connection; the terminal and its logs are retained.
  await transport.terminateSession().catch(() => {});
  await client.close();
}

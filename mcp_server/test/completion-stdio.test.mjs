import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { fixture, workspaceRoot } from './helpers.mjs';
import { JobManager } from '../src/job-manager.mjs';
import { delay } from '../src/runtime.mjs';

test('stdio callers receive legacy job failure, deadline and cancellation events', { timeout: 20000 }, async () => {
  const f = await fixture(), events = [], jobs = [];
  const client = new Client({ name: 'completion-stdio-test', version: '1' });
  client.setNotificationHandler(LoggingMessageNotificationSchema, event => { events.push(event.params.data); });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(workspaceRoot, 'mcp_server/src/stdio.mjs')], cwd: f.root, stderr: 'pipe', env: {
    ...f.env, MCP_WORKSPACE_ROOT: f.root, MCP_AUTH_TOKEN: 'synthetic-stdio-test', MCP_TOOL_PROFILE: 'legacy', MCP_ENABLE_TERMINAL: '1',
    MCP_JOB_ROOT: path.join(f.root, 'jobs'), MCP_TERMINAL_ROOT: path.join(f.root, 'terminals'), MCP_HTTP_AUDIT_LOG: path.join(f.root, 'audit.jsonl'), MCP_TERMINAL_SHELL: f.shell,
  } });
  async function call(name, args) {
    const r = await client.callTool({ name, arguments: args });
    assert(!r.isError, JSON.stringify(r)); return r.structuredContent;
  }
  async function completion(id) {
    for (let i = 0; i < 200; i++) { const event = events.find(x => x.jobId === id); if (event) return event; await delay(25); }
    throw Error('no job completion event');
  }
  try {
    await client.connect(transport); transport.stderr?.resume(); await client.setLoggingLevel('notice');
    const failed = await call('execute_command', { command: 'sleep .3; exit 4', cwd: f.root, waitMs: 0 }); jobs.push(failed.jobId);
    assert(failed.completionNotification.subscribed);
    assert.equal((await completion(failed.jobId)).exitCode, 4);
    const deadline = await call('start_job', { command: 'sleep 10', cwd: f.root, executionTimeoutMs: 250 }); jobs.push(deadline.jobId);
    assert.equal((await completion(deadline.jobId)).status, 'timed_out');
    const cancelled = await call('start_job', { command: 'sleep 10', cwd: f.root }); jobs.push(cancelled.jobId);
    await call('stop_job', { jobId: cancelled.jobId });
    assert.equal((await completion(cancelled.jobId)).status, 'cancelled');
    await call('get_job_status', { jobId: failed.jobId, notifyOnCompletion: true });
    await delay(600); assert.equal(events.filter(x => x.jobId === failed.jobId).length, 1);
  } finally {
    await client.close();
    const manager = new JobManager({ root: path.join(f.root, 'jobs'), shell: f.shell });
    for (const id of jobs) await manager.stop(id, { force: true }).catch(() => {});
    await f.cleanup();
  }
});

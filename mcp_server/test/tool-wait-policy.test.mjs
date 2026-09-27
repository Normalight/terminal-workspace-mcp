import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serverFixture } from './http-fixture.mjs';
import { toolWait } from '../src/tool-wait-policy.mjs';
import { requestAudit } from '../src/request-audit.mjs';
import { Agent, request } from 'node:http';

test('HTTP wait cap returns the original live task despite a caller requesting thirty seconds', { timeout: 12000 }, async () => {
  const f = await serverFixture(); f.env.MCP_HTTP_MAX_TOOL_WAIT_MS = '120';
  try {
    await f.start(); const c = f.client();
    const began = Date.now();
    const first = await c.execute({ terminalKey: 'wait-budget', cwd: f.root, waitMs: 30000,
      command: 'printf x >> once; while [ ! -f release ]; do sleep .02; done; printf RESUMED' });
    assert(Date.now() - began < 2500); assert.equal(first.status, 'running');
    assert.equal(first.requestedWaitMs, 30000); assert.equal(first.effectiveWaitMs, 120); assert(first.waitLimited);
    const target = { sessionId: first.sessionId, commandId: first.commandId, cursor: first.nextCursor };
    const pollBegan = Date.now(); const page = await c.read({ ...target, waitMs: 30000 });
    assert(Date.now() - pollBegan < 2000); assert.equal(page.commandId, first.commandId); assert.equal(page.status, 'running');
    assert.equal(page.effectiveWaitMs, 120); assert(page.waitLimited);
    await writeFile(path.join(f.root, 'release'), '');
    const end = await c.waitForCompletion(target);
    assert.equal(end.exitCode, 0); assert.equal(end.nextAction, 'done'); assert.match(end.stdout, /RESUMED/);
    assert.equal(await readFile(path.join(f.root, 'once'), 'utf8'), 'x');
    const rows = (await readFile(f.env.MCP_HTTP_AUDIT_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
    assert(rows.some(row => row.event === 'tool_result' && row.requestId === first.requestId && row.requestedWaitMs === 30000 && row.effectiveWaitMs === 120 && row.waitLimited));
  } finally { await f.cleanup(); }
});

test('short waits and stdio preserve caller semantics; legacy process deadlines are unchanged', () => {
  const original = { waitMs: 30000, executionTimeoutMs: 60000 };
  assert.equal(toolWait(original).args, original);
  requestAudit.run({ maxToolWaitMs: 5000 }, () => {
    assert.equal(toolWait({ waitMs: 100 }).args.waitMs, 100);
    assert.equal(toolWait({ waitMs: 0 }).args.waitMs, 0);
    const legacy = toolWait({ timeoutMs: 30000, executionTimeoutMs: 60000 }, { legacy: true });
    assert.equal(legacy.args.waitMs, 5000); assert.equal(legacy.args.executionTimeoutMs, 60000);
    assert.equal(toolWait({ statusOnly: true, waitMs: 30000 }).args.waitMs, 0);
  });
});

test('finite RPCs close TCP reuse explicitly while saved MCP sessions remain valid', { timeout: 10000 }, async () => {
  const f = await serverFixture(), agent = new Agent({ keepAlive: true });
  try {
    await f.start(); let session;
    const call = (id, method, params) => new Promise((resolve, reject) => {
      const req = request(f.url, { method: 'POST', agent, headers: {
        Authorization: `Bearer ${f.token}`, 'content-type': 'application/json', Accept: 'application/json, text/event-stream',
        ...(session ? { 'mcp-session-id': session } : {}),
      } }, res => {
        const chunks = [];
        res.on('data', b => chunks.push(b));
        res.on('end', () => resolve({ body: JSON.parse(Buffer.concat(chunks)), headers: res.headers, reused: req.reusedSocket, status: res.statusCode }));
        res.on('error', reject);
      });
      req.on('error', reject); req.end(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
    const first = await call(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'keepalive-probe', version: '1' } });
    session = first.headers['mcp-session-id']; assert(session); assert.equal(first.headers.connection, 'close');
    for (let i = 2; i <= 4; i++) {
      const next = await call(i, 'tools/list', {});
      assert.equal(next.status, 200); assert.equal(next.body.result.tools.length, 2);
      assert.equal(next.headers.connection, 'close'); assert.equal(next.reused, false);
    }
  } finally { agent.destroy(); await f.cleanup(); }
});

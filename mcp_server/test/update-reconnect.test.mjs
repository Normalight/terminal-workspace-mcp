import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serverFixture } from './http-fixture.mjs';
import { delay } from '../src/runtime.mjs';

const waitUntil = async check => {
  for (let i = 0; i < 150; i++) { if (await check()) return; await delay(20); }
  throw Error('condition not reached');
};
const health = f => fetch(new URL('/healthz', f.url)).then(r => r.json());

for (const mode of ['submission', 'poll']) test(`graceful update returns saved task state for an in-flight ${mode} and reconnects without replay`, { timeout: 15000 }, async () => {
  const f = await serverFixture();
  try {
    await f.start(); let submits = 0;
    const c = f.client({ requestTimeoutMs: 6000, fetch: (url, options) => {
      if (options.body && JSON.parse(options.body).params?.arguments?.command) submits++;
      return fetch(url, options);
    } });
    const args = { terminalKey: 'update/task', cwd: f.root, command: 'printf x >> once; while [ ! -f release ]; do sleep .02; done; printf UPDATED', waitMs: mode === 'submission' ? 30000 : 0 };
    let pending;
    if (mode === 'submission') pending = c.execute(args);
    else {
      const first = await c.execute(args);
      pending = c.read({ sessionId: first.sessionId, commandId: first.commandId, cursor: first.nextCursor, waitMs: 30000 });
    }
    const captured = pending.then(value => ({ value }), error => ({ error }));
    await waitUntil(async () => await readFile(path.join(f.root, 'once'), 'utf8').catch(() => '') === 'x');
    await waitUntil(async () => (await health(f)).sessions.inflight > 0);
    await delay(100);
    const start = Date.now(); await f.stop();
    const response = await captured;
    assert(!response.error, String(response.error));
    const saved = response.value;
    assert(saved.serverRestarting); assert.equal(saved.status, 'running'); assert(saved.commandId); assert(Date.now() - start < 2000);
    await f.start(); await writeFile(path.join(f.root, 'release'), '');
    const final = await c.waitForCompletion({ sessionId: saved.sessionId, commandId: saved.commandId, cursor: saved.nextCursor });
    assert.equal(final.status, 'succeeded'); assert.equal(final.stdout, 'UPDATED'); assert(final.outputComplete);
    assert.equal(submits, 1); assert.equal(await readFile(path.join(f.root, 'once'), 'utf8'), 'x'); assert.equal(c.generation, 2);
  } finally { await f.cleanup(); }
});

test('a new submission rejected during draining reconnects and is submitted only after the new server starts', { timeout: 15000 }, async () => {
  const f = await serverFixture(); let held;
  try {
    await f.start(); const c = f.client({ requestTimeoutMs: 6000 }); await c.connect();
    const before = (await health(f)).counters.httpRequests;
    held = request(f.url, { method: 'POST', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json', 'content-length': '100' } });
    held.on('error', () => {}); held.write('{'); // Keep a finite request open long enough to inspect drain admission.
    await waitUntil(async () => (await health(f)).counters.httpRequests > before);
    const stopping = f.stop();
    await waitUntil(async () => (await health(f)).draining);
    const pending = c.execute({ terminalKey: 'drain/rejected', cwd: f.root, command: 'printf x >> once', waitMs: 1000 }).then(value => ({ value }), error => ({ error }));
    // Let the first POST receive the explicit pre-dispatch rejection.
    await delay(150); assert.equal(await readFile(path.join(f.root, 'once'), 'utf8').catch(() => ''), '');
    held.destroy(); await stopping; await f.start();
    const response = await pending;
    assert(!response.error, String(response.error)); assert.equal(response.value.exitCode, 0);
    assert.equal(await readFile(path.join(f.root, 'once'), 'utf8'), 'x'); assert.equal(c.generation, 2);
  } finally { held?.destroy(); await f.cleanup(); }
});

test('an ambiguous gateway 503 never authorizes replay of a submitted command', { timeout: 10000 }, async () => {
  const f = await serverFixture();
  try {
    await f.start();
    for (const body of [{ error: 'gateway unavailable' }, { code: 'mcp_service_restarting', recovery: { requestAccepted: true, initializeWithoutSessionId: true, replayCommand: false } }]) {
      let attempts = 0;
      const c = f.client({ fetch: (url, options) => {
        if (options.body && JSON.parse(options.body).params?.arguments?.command) {
          attempts++; return Promise.resolve(new Response(JSON.stringify(body), { status: 503 }));
        }
        return fetch(url, options);
      } });
      await assert.rejects(c.execute({ terminalKey: 'gateway/uncertain', command: 'printf x' }), { code: 'submission_uncertain' });
      assert.equal(attempts, 1);
    }
  } finally { await f.cleanup(); }
});

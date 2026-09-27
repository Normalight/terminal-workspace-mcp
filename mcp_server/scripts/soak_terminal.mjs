// Isolated integration soak: never contacts or restarts the configured service.
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { serverFixture } from '../test/http-fixture.mjs';
import { delay, atomicJson } from '../src/runtime.mjs';

const durationMs = Number(process.argv[2] ?? 600000), count = Number(process.argv[3] ?? 6);
if (!Number.isSafeInteger(durationMs) || durationMs < 10000 || !Number.isSafeInteger(count) || count < 2 || count > 16) throw Error('Usage: node soak_terminal.mjs [durationMs>=10000] [clients=2..16]');
const f = await serverFixture(), began = Date.now(), progress = [], tasks = [], clients = [];
f.env.MCP_LOG_SEGMENT_BYTES = '1024'; f.env.MCP_LOG_MAX_SEGMENTS = '8';
let cancelled = false, restarts = 0, failuresInjected = 0, controller;
const pause = async ms => { const until = Date.now() + ms; while (!cancelled && Date.now() < until) await delay(Math.min(100, until - Date.now())); };
try {
  await f.start();
  for (let i = 0; i < count; i++) {
    let reads = 0;
    const client = f.client({ maxRetries: 15, baseDelayMs: 100, maxDelayMs: 1000, requestTimeoutMs: 5000, reconcileMs: 500,
      fetch: (url, options = {}) => {
        if (i % 2 && options.method === 'GET') return Promise.resolve(new Response('', { status: 405 }));
        const body = options.body ? JSON.parse(options.body) : {};
        if (body.method === 'tools/call' && !body.params?.arguments?.command && ++reads % 97 === 0) {
          failuresInjected++; return Promise.resolve(new Response('', { status: 503, headers: { 'retry-after': '0' } }));
        }
        return fetch(url, options);
      } });
    clients.push(client);
    const first = await client.execute({ terminalKey: `soak/${i}`, cwd: f.root, waitMs: 0,
      command: `printf x >> once-${i}; i=0; while [ ! -f release ]; do i=$((i+1)); printf '${i}:%08d:%064d\n' "$i" 0; sleep .2; done` });
    tasks.push({ sessionId: first.sessionId, commandId: first.commandId, cursor: first.startCursor, lines: 0, bytes: 0, carry: '' });
  }
  const monitoring = tasks.map((state, i) => clients[i].waitForCompletion({ sessionId: state.sessionId, commandId: state.commandId, cursor: state.cursor, maxBytes: 2048 }, {
    timeoutMs: durationMs + 120000, pollIntervalMs: 500, onPage: async (page, checkpoint) => {
      assert(!page.outputGap, `unexpected output gap for client ${i}`);
      const lines = (state.carry + page.stdout).split(/\r?\n/); state.carry = lines.pop();
      for (const line of lines) {
        const [owner, sequence, padding] = line.split(':');
        assert.equal(Number(owner), i); assert.equal(Number(sequence), ++state.lines); assert.equal(padding, '0'.repeat(64));
      }
      state.bytes += Buffer.byteLength(page.stdout); state.cursor = checkpoint.cursor;
      await atomicJson(path.join(f.root, `checkpoint-${i}.json`), checkpoint);
    },
  }));
  controller = (async () => {
    const started = Date.now(); let nextSample = started;
    while (!cancelled && Date.now() - started < durationMs) {
      const elapsed = Date.now() - started;
      if (restarts < 2 && elapsed >= durationMs * (restarts + 1) / 3) {
        await f.stop(restarts === 0 ? 'SIGTERM' : 'SIGKILL'); await f.start(); restarts++;
      }
      if (Date.now() >= nextSample) {
        const health = await (await fetch(f.url.replace('/mcp', '/healthz'))).json();
        const status = await readFile(`/proc/${f.pid}/status`, 'utf8');
        const sample = { elapsedMs: elapsed, restarts, failuresInjected, lines: tasks.map(x => x.lines),
          rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]), descriptors: (await readdir(`/proc/${f.pid}/fd`)).length,
          sessions: health.sessions, httpErrors: health.counters.httpErrors };
        progress.push(sample); console.log(JSON.stringify({ progress: sample })); nextSample = Date.now() + 30000;
      }
      await pause(100);
    }
    if (!cancelled) await writeFile(path.join(f.root, 'release'), '');
  })();
  const [, results] = await Promise.all([controller, Promise.all(monitoring)]);
  for (let i = 0; i < count; i++) {
    assert.equal(results[i].exitCode, 0); assert(results[i].outputComplete); assert.equal(results[i].nextAction, 'done');
    assert.equal(tasks[i].carry, ''); assert(tasks[i].lines > 0); assert.equal(await readFile(path.join(f.root, `once-${i}`), 'utf8'), 'x');
    const checkpoint = JSON.parse(await readFile(path.join(f.root, `checkpoint-${i}.json`)));
    assert.equal(checkpoint.cursor, results[i].nextCursor);
  }
  const rows = (await readFile(f.env.MCP_HTTP_AUDIT_LOG, 'utf8')).trim().split('\n').map(JSON.parse);
  assert(rows.some(row => row.event === 'tool_result' && row.nextAction === 'done'));
  console.log(JSON.stringify({ passed: true, durationMs: Date.now() - began, monitoringMs: durationMs, clients: count, restarts, failuresInjected,
    tasks: tasks.map(({ carry, ...state }) => state), samples: progress.length, scope: 'isolated local HTTP, half without SSE; not ChatGPT browser or 24-hour reliability' }));
} finally {
  cancelled = true;
  for (const client of clients) await client.close();
  await controller?.catch(() => {});
  await f.cleanup();
}

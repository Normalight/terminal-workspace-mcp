import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpSessionPool } from '../src/http-session-pool.mjs';

test('handshakes reserve capacity across asynchronous initialization and release on failure', async () => {
  const pool = new HttpSessionPool({ max: 2, idleTtlMs: 900000, pressureIdleMs: 5000 });
  const attempts = await Promise.all(Array.from({ length: 100 }, async () => {
    const slot = pool.reserve(); await Promise.resolve(); return slot;
  }));
  const admitted = attempts.filter(Boolean);
  assert.equal(admitted.length, 2); assert.equal(pool.stats().reserved, 2);
  admitted[0].release(); admitted[0].release();
  admitted[1].activate('one', { createdAt: Date.now(), inflight: 1 });
  const replacement = pool.reserve(); assert(replacement);
  assert.equal(pool.reserve(), null);
  replacement.release(); assert.equal(pool.stats().reserved, 0);
  assert.throws(() => replacement.activate('invalid', {}));
});

test('capacity reclaims oldest eligible session while protecting live requests, listeners and new handshakes', () => {
  let now = 0; const removed = [];
  const pool = new HttpSessionPool({ max: 4, idleTtlMs: 900000, pressureIdleMs: 5000, now: () => now,
    onRemove: (id, session, reason) => removed.push({ id, reason }),
  });
  const add = (id, fields = {}) => pool.reserve().activate(id, { createdAt: now, lastActiveAt: now, ...fields });
  add('busy', { inflight: 1 }); add('listener', { transport: { notificationStreamOpen: true } });
  add('old'); now = 1000; add('recent');
  assert.equal(pool.reserve(), null); // Do not evict a just-created session.
  now = 5000;
  const slot = pool.reserve(); assert(slot); slot.activate('new', { createdAt: now });
  assert.deepEqual(removed, [{ id: 'old', reason: 'capacity' }]);
  assert(pool.sessions.has('busy')); assert(pool.sessions.has('listener')); assert(pool.sessions.has('recent'));
  now = 6000;
  pool.sessions.get('recent').lastActiveAt = now; // Reuse refreshes LRU age.
  assert.equal(pool.reserve(), null);
});

test('expiry never interrupts a request or SSE listener and reclaims them once inactive', () => {
  let now = 0;
  const pool = new HttpSessionPool({ max: 3, idleTtlMs: 100, pressureIdleMs: 50, now: () => now });
  for (const [id, props] of [['idle', {}], ['busy', { inflight: 1 }], ['sse', { transport: { notificationStreamOpen: true } }]]) {
    pool.reserve().activate(id, { createdAt: now, ...props });
  }
  now = 1000; pool.expire(); assert.deepEqual([...pool.sessions.keys()], ['busy', 'sse']);
  pool.sessions.get('busy').inflight = 0;
  pool.sessions.get('sse').transport.notificationStreamOpen = false;
  pool.expire(); assert.equal(pool.stats().active, 0);
});

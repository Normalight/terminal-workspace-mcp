import test from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { acceptsGzip, compressJsonResponse } from '../src/http-transport.mjs';

const request = accept => new Request('http://localhost/mcp', { method: 'POST', headers: accept === undefined ? {} : { 'accept-encoding': accept } });
const response = (body, headers = {}) => new Response(body, { headers: { 'content-type': 'application/json', 'mcp-session-id': 'test-session', ...headers } });

test('gzip negotiation honors explicit exclusions and identity preference', () => {
  for (const header of [undefined, '', 'br', 'gzip;q=0', '*;q=1, gzip;q=0', 'gzip;q=0.4, identity;q=0.8', 'gzip;q=bad']) assert.equal(acceptsGzip(header), false, header);
  for (const header of ['gzip', 'br, gzip;q=0.5', '*;q=0.3', 'GZip; q=1.000', 'gzip;q=0.5, identity;q=0']) assert.equal(acceptsGzip(header), true, header);
});

test('gzip preserves exact JSON, session headers and accounting; bypasses unhelpful encoding', async () => {
  const original = Buffer.from(JSON.stringify({ text: '原始文本🙂\n'.repeat(2000) }));let stats;
  const encoded = await compressJsonResponse(request('gzip'), response(original, { vary: 'Origin' }), { onResult: value => stats = value });
  const bytes = Buffer.from(await encoded.arrayBuffer());
  assert.equal(encoded.headers.get('content-encoding'), 'gzip');assert.equal(encoded.headers.get('mcp-session-id'), 'test-session');
  assert.equal(encoded.headers.get('vary'), 'Origin, Accept-Encoding');assert.equal(Number(encoded.headers.get('content-length')), bytes.length);
  assert.deepEqual(gunzipSync(bytes), original);assert(bytes.length < original.length / 10);assert.equal(stats.originalBytes, original.length);assert.equal(stats.wireBytes, bytes.length);
  for (const accept of [undefined, 'identity', 'gzip;q=0']) {
    const plain = await compressJsonResponse(request(accept), response(original));assert(!plain.headers.has('content-encoding'));assert.deepEqual(Buffer.from(await plain.arrayBuffer()), original);
  }
  const small = await compressJsonResponse(request('gzip'), response('{}'));assert(!small.headers.has('content-encoding'));assert.equal(await small.text(), '{}');
  // A tiny high-entropy JSON string is valid but expands with a gzip header.
  const entropy = JSON.stringify(randomBytes(16).toString('hex'));
  const unhelpful = await compressJsonResponse(request('gzip'), response(entropy), { minBytes: 0 });assert(!unhelpful.headers.has('content-encoding'));assert.equal(await unhelpful.text(), entropy);
});

test('SSE, already encoded responses, no-transform and disabled compression pass through', async () => {
  for (const headers of [{ 'content-type': 'text/event-stream' }, { 'content-encoding': 'br' }, { 'cache-control': 'private, no-transform' }, { 'content-range': 'bytes 0-10/20' }]) {
    const source = response('data: event\n\n', headers);assert.equal(await compressJsonResponse(request('gzip'), source), source);
  }
  const source = response('x'.repeat(4096));assert.equal(await compressJsonResponse(request('gzip'), source, { enabled: false }), source);
});

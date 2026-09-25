import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { getRequestListener } from '@hono/node-server';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';

const zip = promisify(gzip);

// A missing header conservatively means no compression. Explicit gzip;q=0
// overrides a wildcard. Respect an explicit preference for identity as well.
export function acceptsGzip(header) {
  if (!header) return false;
  const weights = new Map();
  for (const entry of header.toLowerCase().split(',')) {
    const [coding, ...params] = entry.trim().split(';');
    const q = params.map(x => x.trim()).find(x => x.startsWith('q='));
    const value = q === undefined ? 1 : /^q=(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(q) ? Number(q.slice(2)) : 0;
    weights.set(coding.trim(), value);
  }
  const weight = weights.get('gzip') ?? weights.get('*') ?? 0;
  return weight > 0 && weight >= (weights.get('identity') ?? 0);
}

export async function compressJsonResponse(request, response, { enabled = true, minBytes = 1024, onResult = () => {} } = {}) {
  // SSE is deliberately passed through; its delivery must not wait for buffering.
  if (!enabled || request.method === 'HEAD' || response.status !== 200 || !response.body ||
      !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '') ||
      response.headers.has('content-encoding') || response.headers.has('content-range') ||
      /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(response.headers.get('cache-control') ?? '')) return response;
  const headers = new Headers(response.headers);
  const vary = headers.get('vary');
  if (!vary?.split(',').some(x => ['*', 'accept-encoding'].includes(x.trim().toLowerCase()))) headers.set('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
  if (!acceptsGzip(request.headers.get('accept-encoding'))) {
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  // MCP JSON results are finite and already materialized by the SDK. Native gzip
  // runs in the libuv pool, keeping compression work off the main JS thread.
  const original = Buffer.from(await response.arrayBuffer());
  let body = original, encoding = 'identity';
  if (original.length >= minBytes) {
    const compressed = await zip(original, { level: 4 });
    if (compressed.length < original.length) {
      body = compressed; encoding = 'gzip'; headers.set('content-encoding', encoding);
      headers.delete('etag'); headers.delete('content-md5'); headers.delete('digest');
    }
  }
  headers.set('content-length', String(body.length));
  onResult({ encoding, originalBytes: original.length, wireBytes: body.length });
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

// Use the SDK's public web-standard transport and the same Node adapter used by
// its built-in Node transport. This adds encoding without patching SDK internals.
export class HttpTransport extends WebStandardStreamableHTTPServerTransport {
  constructor(options, compression) { super(options); this.compression = compression; }
  async handleNodeRequest(incoming, outgoing, parsedBody) {
    const handler = getRequestListener(async request => {
      const response = await super.handleRequest(request, { authInfo: incoming.auth, parsedBody });
      return compressJsonResponse(request, response, {
        ...this.compression,
        onResult: stats => { outgoing.compressionStats = stats; this.compression?.onResult?.(stats); },
      });
    }, { overrideGlobalObjects: false });
    await handler(incoming, outgoing);
  }
}

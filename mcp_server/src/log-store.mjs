import { mkdir, open, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { integer } from "./runtime.mjs";

export const DEFAULT_SEGMENT_BYTES = 8 * 1024 * 1024;
export async function logSegments(base, segmentBytes = DEFAULT_SEGMENT_BYTES) {
  const name = path.basename(base);
  const names = await readdir(path.dirname(base)).catch(() => []);
  const files = names.filter(n => n === name || (n.startsWith(name + ".") && /^\d{9}$/.test(n.slice(name.length + 1))));
  const segments = [];
  for (const file of files) {
    const index = file === name ? 0 : Number(file.slice(name.length + 1));
    const full = path.join(path.dirname(base), file);
    const info = await stat(full).catch(() => null);
    if (info?.isFile()) segments.push({ file: full, index, start: index * segmentBytes, bytes: info.size });
  }
  return segments.sort((a, b) => a.index - b.index);
}
export function utf8Window(buffer, { final = false } = {}) {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++;
  let end = buffer.length;
  if (!final && end > start) {
    let lead = end - 1;
    while (lead > start && (buffer[lead] & 0xc0) === 0x80) lead--;
    const byte = buffer[lead];
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    if (end - lead < needed) end = lead;
  }
  return { content: buffer.subarray(start, end).toString("utf8"), consumed: end, skippedBytes: start };
}
export async function readLog(base, { cursor, maxBytes = 65536, segmentBytes = DEFAULT_SEGMENT_BYTES, final = false } = {}) {
  integer(maxBytes, "maxBytes", 4, 2 * 1024 * 1024);
  if (cursor !== undefined) integer(cursor, "cursor", 0, Number.MAX_SAFE_INTEGER);
  const segments = await logSegments(base, segmentBytes);
  const first = segments[0]?.start ?? 0;
  const end = segments.length ? segments.at(-1).start + segments.at(-1).bytes : 0;
  const requested = cursor ?? Math.max(first, end - maxBytes);
  const from = Math.max(first, Math.min(requested, end));
  let offset = from;
  const chunks = [];
  for (const s of segments) {
    if (offset >= s.start + s.bytes || offset < s.start || offset - from >= maxBytes) continue;
    const handle = await open(s.file, "r").catch(() => null);
    if (!handle) continue;
    try {
      const buffer = Buffer.alloc(Math.min(s.bytes - (offset - s.start), maxBytes - (offset - from)));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset - s.start);
      chunks.push(buffer.subarray(0, bytesRead)); offset += bytesRead;
    } finally { await handle.close(); }
  }
  const decoded = utf8Window(Buffer.concat(chunks), { final: final && offset === end });
  return { ...decoded, cursor: from, nextCursor: from + decoded.consumed, endCursor: end,
    earliestCursor: first, truncated: from + decoded.consumed < end, droppedBytes: Math.max(0, first - requested) };
}
export class LogWriter extends Writable {
  constructor(base, { segmentBytes = DEFAULT_SEGMENT_BYTES, maxSegments = 0 } = {}) {
    super(); this.base = base; this.segmentBytes = integer(segmentBytes, "segmentBytes", 1024, 1024 ** 3);
    this.maxSegments = integer(maxSegments, "maxSegments", 0, 10000); this.ready = false; this.handle = null;
  }
  async setup() {
    await mkdir(path.dirname(this.base), { recursive: true });
    const segments = await logSegments(this.base, this.segmentBytes);
    this.index = segments.at(-1)?.index ?? 0; this.bytes = segments.at(-1)?.bytes ?? 0; this.ready = true;
  }
  async append(chunk) {
    if (!this.ready) await this.setup();
    let offset = 0;
    while (offset < chunk.length) {
      if (this.bytes >= this.segmentBytes) {
        await this.handle?.close(); this.handle = null; this.index++; this.bytes = 0;
        if (this.maxSegments) {
          for (const s of await logSegments(this.base, this.segmentBytes)) {
            if (s.index <= this.index - this.maxSegments) await unlink(s.file).catch(() => {});
          }
        }
      }
      if (!this.handle) this.handle = await open(this.index === 0 ? this.base : `${this.base}.${String(this.index).padStart(9, "0")}`, "a", 0o600);
      const size = Math.min(chunk.length - offset, this.segmentBytes - this.bytes);
      const { bytesWritten } = await this.handle.write(chunk, offset, size);
      offset += bytesWritten; this.bytes += bytesWritten;
    }
  }
  _write(chunk, _encoding, callback) { this.append(Buffer.from(chunk)).then(() => callback(), callback); }
  _final(callback) { (async () => { if (!this.ready) await this.setup(); await this.handle?.close(); this.handle = null; })().then(() => callback(), callback); }
  _destroy(error, callback) { Promise.resolve(this.handle?.close()).then(() => callback(error), callback); }
}

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, appendFile, lstat, mkdir, open, opendir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { integer, KeyedMutex, OperationError } from "./runtime.mjs";
import { utf8Window } from "./log-store.mjs";

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_BINARY_FILE_BYTES = 4 * 1024 * 1024;
const HARD_MAX_BINARY_FILE_BYTES = 32 * 1024 * 1024;
const locks = new KeyedMutex();
const sha256 = data => createHash("sha256").update(data).digest("hex");
export class WorkspaceError extends OperationError {}
export class Workspace {
  constructor(root, { enableWrite = false } = {}) { this.root = path.resolve(root); this.enableWrite = enableWrite; }
  async initialize() { this.root = await realpath(this.root); await access(this.root); return this; }
  label(absolute) { const relative = path.relative(this.root, absolute); return relative === "" ? "." : relative === ".." || relative.startsWith(".." + path.sep) ? absolute : relative; }
  async resolve(value, { allowMissing = false } = {}) {
    if (typeof value !== "string" || !value || value.includes("\0")) throw new WorkspaceError("path must be a non-empty string", "invalid_path");
    if (value === "~" || value.startsWith("~/")) value = path.join(os.homedir(), value.slice(2));
    const candidate = path.resolve(this.root, value);
    let absolute;
    try { absolute = await realpath(candidate); }
    catch (error) {
      if (error.code !== "ENOENT" || !allowMissing) throw error;
      // Canonicalize an existing parent so aliases share the same edit lock.
      const parts = []; let current = candidate;
      while (true) {
        try { absolute = path.join(await realpath(current), ...parts.reverse()); break; }
        catch (parentError) {
          if (parentError.code !== "ENOENT") throw parentError;
          const info = await lstat(current).catch(() => null);
          if (info?.isSymbolicLink()) throw new WorkspaceError("dangling symlink; create its target explicitly", "invalid_path");
          parts.push(path.basename(current)); const parent = path.dirname(current);
          if (parent === current) throw parentError; current = parent;
        }
      }
    }
    return { absolute, relative: this.label(absolute) };
  }
  async describe(value) {
    const target = await this.resolve(value), info = await stat(target.absolute);
    return { path: target.relative, type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other", bytes: info.size, modifiedAt: info.mtime.toISOString() };
  }
  async listDirectory(value = ".", { recursive = false, includeHidden = false, maxEntries = 200 } = {}) {
    integer(maxEntries, "maxEntries", 1, 5000);
    const start = await this.resolve(value), entries = [], queue = [start.absolute], seen = new Set();
    let truncated = false;
    while (queue.length && !truncated) {
      const current = queue.shift(), canonical = await realpath(current).catch(() => null);
      if (!canonical || seen.has(canonical)) continue; seen.add(canonical);
      const dir = await opendir(canonical);
      for await (const entry of dir) {
        if (!includeHidden && entry.name.startsWith(".")) continue;
        if (entries.length >= maxEntries) { truncated = true; break; }
        const full = path.join(current, entry.name), info = await stat(full).catch(() => null); if (!info) continue;
        entries.push({ path: this.label(full), type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other", bytes: info.size, symlink: entry.isSymbolicLink(), modifiedAt: info.mtime.toISOString() });
        if (recursive && info.isDirectory()) queue.push(full);
      }
    }
    entries.sort((a,b) => a.path.localeCompare(b.path));
    return { root: start.relative, entries, truncated: truncated || queue.length > 0 };
  }
  async readFileBytes(value, { maxBytes = DEFAULT_MAX_BINARY_FILE_BYTES } = {}) {
    integer(maxBytes, "maxBytes", 1, HARD_MAX_BINARY_FILE_BYTES);
    const target = await this.resolve(value), fh = await open(target.absolute, "r");
    try {
      const info = await fh.stat(); if (!info.isFile()) throw new WorkspaceError("path is not a file", "not_a_file");
      if (info.size > maxBytes) throw new WorkspaceError(`file is ${info.size} bytes; use read_file_chunk`, "file_too_large");
      const buffer = Buffer.alloc(Math.min(info.size + 1, maxBytes + 1));
      const { bytesRead } = await fh.read(buffer, 0, buffer.length, 0);
      if (bytesRead > maxBytes) throw new WorkspaceError("file grew beyond maxBytes", "file_too_large");
      const data = buffer.subarray(0, bytesRead); return { path: target.relative, bytes: data.length, sha256: sha256(data), data };
    } finally { await fh.close(); }
  }
  async fileInfo(value, { checksum = false } = {}) {
    const target = await this.resolve(value), info = await stat(target.absolute);
    let hash = null;
    if (checksum && info.isFile()) { const hasher = createHash("sha256"); for await (const chunk of createReadStream(target.absolute)) hasher.update(chunk); hash = hasher.digest("hex"); }
    return { path: target.relative, absolutePath: target.absolute, bytes: info.size, modifiedAt: info.mtime.toISOString(), sha256: hash, type: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other" };
  }
  async readChunk(value, { offset = 0, maxBytes = 262144, encoding = "base64", tail = false } = {}) {
    integer(offset, "offset", 0, Number.MAX_SAFE_INTEGER); integer(maxBytes, "maxBytes", 4, 1048576);
    if (!["base64", "utf8"].includes(encoding)) throw new WorkspaceError("encoding must be base64 or utf8", "invalid_input");
    const target = await this.resolve(value), fh = await open(target.absolute, "r");
    try {
      const info = await fh.stat(); if (!info.isFile()) throw new WorkspaceError("path is not a file", "not_a_file");
      if (tail) offset = Math.max(0, info.size - maxBytes); else offset = Math.min(offset, info.size);
      const buffer = Buffer.alloc(Math.min(maxBytes, info.size - offset)); const { bytesRead } = await fh.read(buffer, 0, buffer.length, offset); const data = buffer.subarray(0, bytesRead);
      const decoded = encoding === "utf8" ? utf8Window(data, { final: offset + bytesRead === info.size }) : null;
      const consumed = decoded?.consumed ?? bytesRead;
      return { path: target.relative, offset, nextOffset: offset + consumed, bytes: consumed, totalBytes: info.size,
        eof: offset + consumed >= info.size, encoding, data: decoded?.content ?? data.toString("base64"), sha256: sha256(data.subarray(0, consumed)), sha256Scope: "chunk", skippedBytes: decoded?.skippedBytes ?? 0 };
    } finally { await fh.close(); }
  }
  async readText(value, { maxBytes = DEFAULT_MAX_FILE_BYTES, startLine = 1, endLine, offset, tail = false, maxScanBytes = 16 * 1024 * 1024 } = {}) {
    integer(maxBytes, "maxBytes", 4, 2097152); integer(startLine, "startLine", 1, Number.MAX_SAFE_INTEGER);
    if (endLine !== undefined) integer(endLine, "endLine", startLine, Number.MAX_SAFE_INTEGER);
    if (offset !== undefined || tail) {
      const chunk = await this.readChunk(value, { offset: offset ?? 0, maxBytes: Math.min(maxBytes, 1048576), encoding: "utf8", tail });
      return { ...chunk, content: chunk.data, startLine: null, endLine: null, truncated: !chunk.eof };
    }
    const target = await this.resolve(value), fh = await open(target.absolute, "r");
    try {
      const info = await fh.stat(); if (!info.isFile()) throw new WorkspaceError("path is not a file", "not_a_file");
      const chunks = []; let position = 0, line = 1, from = null, count = 0, lastLine = startLine, reachedEndLine = false;
      outer: while (position < info.size && position < maxScanBytes && count < maxBytes) {
        const buffer = Buffer.alloc(Math.min(65536, info.size - position, maxScanBytes - position));
        const { bytesRead } = await fh.read(buffer, 0, buffer.length, position); if (!bytesRead) break;
        if (buffer.subarray(0, bytesRead).includes(0)) throw new WorkspaceError("binary data; use read_file_chunk", "binary_file");
        let begin = -1;
        for (let i = 0; i < bytesRead; i++) {
          if (line >= startLine) {
            if (from === null) from = position + i;
            if (begin < 0) begin = i;
            count++; lastLine = line;
          }
          const newline = buffer[i] === 10;
          if (newline) line++;
          if (count >= maxBytes || (endLine !== undefined && newline && line > endLine)) {
            if (begin >= 0) chunks.push(buffer.subarray(begin, i + 1));
            position += i + 1; reachedEndLine = endLine !== undefined && line > endLine; break outer;
          }
        }
        if (begin >= 0) chunks.push(buffer.subarray(begin, bytesRead));
        position += bytesRead;
      }
      const raw = Buffer.concat(chunks), decoded = utf8Window(raw, { final: position >= info.size || reachedEndLine });
      const nextOffset = (from ?? position) + decoded.consumed;
      const fullFile = (from ?? 0) === 0 && nextOffset === info.size;
      return { path: target.relative, bytes: info.size, returnedBytes: decoded.consumed, sha256: sha256(raw.subarray(0, decoded.consumed)), sha256Scope: fullFile ? "file" : "slice",
        startLine, endLine: lastLine, content: decoded.content, offset: from ?? position, nextOffset, eof: nextOffset >= info.size,
        truncated: !reachedEndLine && nextOffset < info.size, scanLimitReached: position >= maxScanBytes && from === null };
    } finally { await fh.close(); }
  }
  async searchText(query, { relativePath = ".", regex = false, includeHidden = false, maxResults = 100, maxBytes = 262144, maxFiles = 10000, timeoutMs = 5000, exclude = [".git", "node_modules", ".cache", ".tmp", "shared", "outputs", "__pycache__"], signal } = {}) {
    if (typeof query !== "string" || !query || query.length > 4096) throw new WorkspaceError("query must be 1..4096 characters", "invalid_input");
    integer(maxResults, "maxResults", 1, 1000); integer(maxBytes, "maxBytes", 1024, 1048576); integer(maxFiles, "maxFiles", 1, 100000); integer(timeoutMs, "timeoutMs", 10, 30000);
    if (signal?.aborted) throw new WorkspaceError("search cancelled", "cancelled");
    const target = await this.resolve(relativePath);
    return new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./search-worker.mjs", import.meta.url), { workerData: { root: this.root, absolute: target.absolute, query, regex, includeHidden, maxResults, maxBytes, maxFiles, exclude, maxLineChars: Math.min(4096, Math.floor(maxBytes / 4)), maxFileBytes: 2097152 } });
      let done = false;
      const finish = (error, result) => { if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); void worker.terminate(); error ? reject(error) : resolve(result); };
      const abort = () => finish(new WorkspaceError("search cancelled", "cancelled"));
      const timer = setTimeout(() => finish(new WorkspaceError("search exceeded its time budget", "search_timeout")), timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      worker.once("message", value => finish(value.error ? new WorkspaceError(value.error, value.code) : null, value));
      worker.once("error", error => finish(error)); worker.once("exit", code => { if (!done) finish(new WorkspaceError(`search worker exited (${code})`, "search_error")); });
    });
  }
  assertWritable() { if (!this.enableWrite) throw new WorkspaceError("write tools are disabled; set MCP_ENABLE_WRITE=1", "writes_disabled"); }
  async edit(value, operation) {
    const target = await this.resolve(value, { allowMissing: true });
    return locks.run(target.absolute, () => operation(target));
  }
  async writeText(value, content, { mode = "overwrite", expectedSha256 } = {}) {
    this.assertWritable(); if (typeof content !== "string" || Buffer.byteLength(content) > 2097152) throw new WorkspaceError("content exceeds 2 MiB", "invalid_input");
    if (!["create", "overwrite", "append"].includes(mode)) throw new WorkspaceError("invalid write mode", "invalid_input");
    return this.edit(value, async target => {
      const info = await stat(target.absolute).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
      if (info && !info.isFile()) throw new WorkspaceError("path is not a file", "not_a_file");
      if (mode === "create" && info) throw new WorkspaceError("file already exists", "already_exists");
      if (info?.size > 2097152) throw new WorkspaceError("use write_file_chunk for files above 2 MiB", "file_too_large");
      const existing = info ? await readFile(target.absolute) : Buffer.alloc(0);
      if (existing.includes(0)) throw new WorkspaceError("use write_file_chunk for binary files", "binary_file");
      if (expectedSha256 !== undefined && sha256(existing) !== expectedSha256) throw new WorkspaceError("file changed since expectedSha256 was computed", "conflict");
      const data = mode === "append" ? Buffer.concat([existing, Buffer.from(content)]) : Buffer.from(content);
      if (data.length > 2097152) throw new WorkspaceError("result exceeds 2 MiB; use write_file_chunk", "file_too_large");
      await mkdir(path.dirname(target.absolute), { recursive: true });
      if (mode === "create") await writeFile(target.absolute, data, { flag: "wx", mode: 0o600 });
      else {
        const temp = `${target.absolute}.${randomUUID()}.tmp`;
        try { await writeFile(temp, data, { mode: info?.mode ?? 0o600 }); await rename(temp, target.absolute); } finally { await unlink(temp).catch(() => {}); }
      }
      return { path: target.relative, mode, bytes: data.length, sha256: sha256(data) };
    });
  }
  async replaceText(value, find, replace, { expectedSha256, maxReplacements = 1, dryRun = true } = {}) {
    if (typeof find !== "string" || !find || typeof replace !== "string") throw new WorkspaceError("find and replace must be strings", "invalid_input");
    integer(maxReplacements, "maxReplacements", 1, 1000);
    const target = await this.resolve(value);
    return locks.run(target.absolute, async () => {
      const file = await this.readFileBytes(target.absolute, { maxBytes: 2097152 });
      if (file.data.includes(0)) throw new WorkspaceError("binary file", "binary_file");
      if (expectedSha256 !== undefined && file.sha256 !== expectedSha256) throw new WorkspaceError("file changed since expectedSha256 was computed", "conflict");
      let count = 0; const after = file.data.toString("utf8").replaceAll(find, () => count < maxReplacements ? (count++, replace) : find);
      if (Buffer.byteLength(after) > 2097152) throw new WorkspaceError("result exceeds 2 MiB", "file_too_large");
      if (!dryRun) {
        this.assertWritable(); const info = await stat(target.absolute), temp = `${target.absolute}.${randomUUID()}.tmp`;
        try { await writeFile(temp, after, { mode: info.mode }); await rename(temp, target.absolute); } finally { await unlink(temp).catch(() => {}); }
      }
      const afterHash = sha256(Buffer.from(after)); return { path: target.relative, dryRun, replacements: count, beforeSha256: file.sha256, afterSha256: afterHash, changed: afterHash !== file.sha256 };
    });
  }
  async writeChunk(value, { data, offset = 0, mode = "append", expectedSize, sha256: expectedHash } = {}) {
    this.assertWritable(); integer(offset, "offset", 0, Number.MAX_SAFE_INTEGER);
    if (typeof data !== "string" || data.length > 1398104 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new WorkspaceError("data must be base64 up to 1 MiB", "invalid_input");
    if (!["create", "append", "overwrite"].includes(mode)) throw new WorkspaceError("invalid chunk mode", "invalid_input");
    if (mode !== "append" && offset !== 0) throw new WorkspaceError("create/overwrite requires offset 0", "invalid_input");
    const buffer = Buffer.from(data, "base64"); if (expectedHash && sha256(buffer) !== expectedHash) throw new WorkspaceError("chunk checksum mismatch", "checksum_mismatch");
    return this.edit(value, async target => {
      await mkdir(path.dirname(target.absolute), { recursive: true });
      const info = await stat(target.absolute).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
      if (info && !info.isFile()) throw new WorkspaceError("path is not a file", "not_a_file");
      const size = info?.size ?? 0;
      if (expectedSize !== undefined && size !== expectedSize) throw new WorkspaceError("file size changed", "conflict");
      if (mode === "append" && offset !== size) throw new WorkspaceError(`resume offset must equal file size ${size}`, "conflict");
      const fh = await open(target.absolute, mode === "create" ? "wx" : mode === "overwrite" ? "w" : "a", 0o600);
      try { await fh.writeFile(buffer); await fh.sync(); } finally { await fh.close(); }
      return { path: target.relative, bytes: buffer.length, nextOffset: offset + buffer.length, sha256: sha256(buffer), sha256Scope: "chunk" };
    });
  }
}
export { DEFAULT_MAX_FILE_BYTES, DEFAULT_MAX_BINARY_FILE_BYTES, HARD_MAX_BINARY_FILE_BYTES };

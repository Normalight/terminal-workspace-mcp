import { parentPort, workerData } from "node:worker_threads";
import { opendir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const o = workerData, matches = [], reasons = new Set();
let scannedFiles = 0, returnedBytes = 0, visitedEntries = 0;
const matcher = o.regex ? new RegExp(o.query) : null;
const excluded = new Set(o.exclude);
async function* files(target) {
  const info = await stat(target);
  if (info.isFile()) { yield target; return; }
  const queue = [target];
  while (queue.length) {
    const current = queue.shift();
    let dir; try { dir = await opendir(current); } catch { continue; }
    for await (const entry of dir) {
      if (++visitedEntries > o.maxFiles * 10) { reasons.add("entry_limit"); return; }
      if ((!o.includeHidden && entry.name.startsWith(".")) || excluded.has(entry.name)) continue;
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(child);
      else if (entry.isFile()) yield child;
    }
  }
}
try {
  for await (const file of files(o.absolute)) {
    if (++scannedFiles > o.maxFiles) { scannedFiles--; reasons.add("file_limit"); break; }
    const info = await stat(file).catch(() => null); if (!info || info.size > o.maxFileBytes) continue;
    const buffer = await readFile(file).catch(() => null); if (!buffer || buffer.includes(0)) continue;
    const lines = buffer.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!(matcher ? matcher.test(lines[i]) : lines[i].includes(o.query))) continue;
      const full = lines[i], text = full.slice(0, o.maxLineChars);
      const row = { path: path.relative(o.root, file).startsWith(".." + path.sep) ? file : path.relative(o.root, file), line: i + 1, text, lineTruncated: text.length < full.length };
      const bytes = Buffer.byteLength(JSON.stringify(row));
      if (returnedBytes + bytes > o.maxBytes) { reasons.add("output_limit"); break; }
      matches.push(row); returnedBytes += bytes;
      if (matches.length >= o.maxResults) { reasons.add("result_limit"); break; }
    }
    if (reasons.size) break;
  }
  parentPort.postMessage({ query: o.query, matches, truncated: reasons.size > 0, reasons: [...reasons], scannedFiles, returnedBytes });
} catch (error) { parentPort.postMessage({ error: error.message, code: "search_error" }); }

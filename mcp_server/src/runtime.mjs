import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export class OperationError extends Error {
  constructor(message, code = "operation_failed") { super(message); this.code = code; }
}
export function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new OperationError(`${name} must be ${min}..${max}`, "invalid_input");
  return value;
}
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
export async function jsonFile(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT" && fallback !== undefined) return fallback; throw error; }
}
export async function atomicWrite(file, data, mode = 0o600) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temp, data, { mode }); await rename(temp, file); }
  finally { await unlink(temp).catch(() => {}); }
}
export const atomicJson = (file, data) => atomicWrite(file, JSON.stringify(data, null, 2) + "\n");
export class KeyedMutex {
  #tails = new Map();
  async run(key, operation) {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release;
    const next = new Promise(resolve => { release = resolve; });
    this.#tails.set(key, next);
    await previous;
    try { return await operation(); }
    finally { release(); if (this.#tails.get(key) === next) this.#tails.delete(key); }
  }
}
export async function processIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    const text = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return null;
    return `${pid}:${fields[19]}`;
  } catch { return null; }
}
export async function signalProcess(pid, identity, signal) {
  if (!identity || await processIdentity(pid) !== identity) return false;
  try { process.kill(-pid, signal); return true; }
  catch { try { process.kill(pid, signal); return true; } catch { return false; } }
}
export function childEnvironment(storageRoot, extra = {}) {
  const base = path.resolve(storageRoot);
  const env = { ...process.env, ...extra,
    TMPDIR: path.join(base, ".tmp"), TMP: path.join(base, ".tmp"), TEMP: path.join(base, ".tmp"),
    XDG_CACHE_HOME: path.join(base, ".cache"), PIP_CACHE_DIR: path.join(base, ".cache/pip"),
    UV_CACHE_DIR: path.join(base, ".cache/uv"), npm_config_cache: path.join(base, ".cache/npm"),
    HF_HOME: path.join(base, ".cache/huggingface"), TORCH_HOME: path.join(base, ".cache/torch"),
    CONDA_ENVS_PATH: path.join(base, "shared/envs"), CONDA_PKGS_DIRS: path.join(base, ".cache/conda/pkgs"),
  };
  delete env.MCP_AUTH_TOKEN; delete env.CONTROL_PLANE_API_KEY; delete env.MCP_RUNTIME_AUTH;
  return env;
}

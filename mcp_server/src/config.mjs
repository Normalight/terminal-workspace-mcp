import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const defaultConfigFile = fileURLToPath(new URL('../config.json', import.meta.url));
const text = z.string().min(1);
const count = (min, max) => z.number().int().min(min).max(max);
const httpUrl = text.refine(value => { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } }, 'must be an HTTP(S) URL');
const schema = z.object({
  version: z.literal(1), workspaceRoot: text,
  http: z.object({ host: text, port: count(1, 65535), path: text.regex(/^\/[^?#\s]*$/), allowedHosts: z.array(text), allowAnonymous: z.boolean(),
    compression: z.object({ enabled: z.boolean(), minBytes: count(0, 1048576) }).strict(),
    sessions: z.object({ max: count(1, 10000), idleTtlMs: count(60000, 2147483647), gcIntervalMs: count(10000, 2147483647) }).strict(),
  }).strict(),
  auth: z.object({ tokenEnv: text.regex(/^[A-Za-z_][A-Za-z0-9_]*$/), token: z.string().optional() }).strict(),
  tools: z.object({ profile: z.enum(['minimal', 'legacy']), enableWrite: z.boolean(), enableTerminal: z.boolean() }).strict(),
  files: z.object({ maxBytes: count(65536, 33554432), directMaxBytes: count(65536, 33554432) }).strict(),
  terminal: z.object({ shell: text, maxSessions: count(1, 1000), maxWaitMs: count(100, 120000), maxOutputBytes: count(1024, 2097152) }).strict(),
  jobs: z.object({ maxCount: count(1, 100000), maxRunning: count(1, 10000), retentionDays: count(0, 36500) }).strict(),
  logs: z.object({ segmentBytes: count(1024, 1073741824), maxSegments: count(0, 10000) }).strict(),
  paths: z.object({ service: text, jobs: text, terminals: text, audit: text }).strict(),
  relay: z.object({ host: text, port: count(1, 65535), targetHost: text.optional(), targetPort: count(1, 65535).optional() }).strict(),
  client: z.object({ url: httpUrl, tokenEnv: text.regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict(),
  diagnostics: z.object({ tunnelUrl: httpUrl }).strict(),
}).strict().refine(c => c.files.directMaxBytes <= c.files.maxBytes, { path: ['files', 'directMaxBytes'], message: 'must not exceed files.maxBytes' });

const bindings = {
  MCP_WORKSPACE_ROOT: ['workspaceRoot', 'string'], MCP_HOST: ['http.host', 'string'], MCP_PORT: ['http.port', 'number'], MCP_PATH: ['http.path', 'string'],
  MCP_ALLOWED_HOSTS: ['http.allowedHosts', 'list'], MCP_ALLOW_ANONYMOUS: ['http.allowAnonymous', 'boolean'],
  MCP_HTTP_COMPRESSION: ['http.compression.enabled', 'boolean'], MCP_HTTP_COMPRESSION_MIN_BYTES: ['http.compression.minBytes', 'number'],
  MCP_MAX_SESSIONS: ['http.sessions.max', 'number'], MCP_SESSION_IDLE_TTL_MS: ['http.sessions.idleTtlMs', 'number'], MCP_SESSION_GC_INTERVAL_MS: ['http.sessions.gcIntervalMs', 'number'],
  MCP_TOOL_PROFILE: ['tools.profile', 'string'], MCP_ENABLE_WRITE: ['tools.enableWrite', 'boolean'], MCP_ENABLE_TERMINAL: ['tools.enableTerminal', 'boolean'],
  MCP_FILE_MAX_BYTES: ['files.maxBytes', 'number'], MCP_DIRECT_FILE_MAX_BYTES: ['files.directMaxBytes', 'number'],
  MCP_TERMINAL_SHELL: ['terminal.shell', 'string'], MCP_TERMINAL_MAX_SESSIONS: ['terminal.maxSessions', 'number'], MCP_TERMINAL_MAX_TIMEOUT_MS: ['terminal.maxWaitMs', 'number'], MCP_TERMINAL_MAX_OUTPUT_BYTES: ['terminal.maxOutputBytes', 'number'],
  MCP_JOB_MAX_COUNT: ['jobs.maxCount', 'number'], MCP_JOB_MAX_RUNNING: ['jobs.maxRunning', 'number'], MCP_JOB_RETENTION_DAYS: ['jobs.retentionDays', 'number'],
  MCP_LOG_SEGMENT_BYTES: ['logs.segmentBytes', 'number'], MCP_LOG_MAX_SEGMENTS: ['logs.maxSegments', 'number'],
  MCP_SERVICE_ROOT: ['paths.service', 'string'], MCP_JOB_ROOT: ['paths.jobs', 'string'], MCP_TERMINAL_ROOT: ['paths.terminals', 'string'], MCP_HTTP_AUDIT_LOG: ['paths.audit', 'string'],
  RELAY_LISTEN_HOST: ['relay.host', 'string'], RELAY_LISTEN_PORT: ['relay.port', 'number'], RELAY_TARGET_HOST: ['relay.targetHost', 'string'], RELAY_TARGET_PORT: ['relay.targetPort', 'number'],
  MCP_CLIENT_URL: ['client.url', 'string'], MCP_CLIENT_TOKEN_ENV: ['client.tokenEnv', 'string'], MCP_TUNNEL_DIAGNOSTIC_URL: ['diagnostics.tunnelUrl', 'string'],
};
const get = (object, key) => key.split('.').reduce((value, part) => value?.[part], object);
function set(object, key, value) { const parts = key.split('.'); const leaf = parts.pop(); parts.reduce((value, part) => value[part], object)[leaf] = value; }
function merge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const result = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('invalid configuration key');
    result[key] = value && typeof value === 'object' && !Array.isArray(value) ? merge(base?.[key], value) : value;
  }
  return result;
}
function read(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Cannot load configuration ${file}: ${error.code ?? 'invalid JSON'}`); }
}
function decode(value, type, key) {
  if (type === 'number') return value.trim() === '' ? NaN : Number(value);
  if (type === 'list') return value.split(',').map(x => x.trim()).filter(Boolean);
  if (type === 'boolean') { if (!['0', '1'].includes(value)) throw new Error(`${key} must be 0 or 1`); return value === '1'; }
  return value;
}
function resolvedExisting(file) {
  let parent = path.resolve(file); const suffix = [];
  while (!existsSync(parent)) { const next = path.dirname(parent); if (next === parent) break; suffix.unshift(path.basename(parent)); parent = next; }
  return path.join(realpathSync(parent), ...suffix);
}
export const connectHost = host => host === '0.0.0.0' ? '127.0.0.1' : ['::', '[::]'].includes(host) ? '::1' : host;
export const origin = (host, port) => `http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}:${port}`;

export function loadConfig({ file, env = process.env } = {}) {
  const configFile = path.resolve(file ?? env.MCP_CONFIG_FILE ?? defaultConfigFile);
  let input = read(defaultConfigFile);
  if (configFile !== defaultConfigFile) input = merge(input, read(configFile));
  const localFile = configFile === defaultConfigFile ? path.join(path.dirname(configFile), 'config.local.json') : null;
  if (localFile && existsSync(localFile)) input = merge(input, read(localFile));
  for (const [key, [field, type]] of Object.entries(bindings)) if (env[key] !== undefined) set(input, field, decode(env[key], type, key));
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid configuration: ${parsed.error.issues.map(x => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
  const config = parsed.data;
  config.workspaceRoot = resolvedExisting(path.resolve(env.MCP_WORKSPACE_ROOT === undefined ? path.dirname(configFile) : process.cwd(), config.workspaceRoot));
  for (const [key, value] of Object.entries(config.paths)) {
    const target = resolvedExisting(path.resolve(config.workspaceRoot, value));
    const relative = path.relative(config.workspaceRoot, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`paths.${key} must remain inside workspaceRoot`);
    config.paths[key] = target;
  }
  config.relay.targetHost ??= connectHost(config.http.host); config.relay.targetPort ??= config.http.port;
  const values = {};
  for (const [key, [field, type]] of Object.entries(bindings)) {
    const value = get(config, field); values[key] = type === 'boolean' ? (value ? '1' : '0') : type === 'list' ? value.join(',') : String(value);
  }
  values.MCP_AUTH_TOKEN = env.MCP_AUTH_TOKEN ?? env[config.auth.tokenEnv] ?? config.auth.token ?? '';
  values.MCP_CONFIG_FILE = configFile;
  // Credentials are only in the environment payload; the public config view is safe to print.
  delete config.auth.token;
  return { configFile, localFile, config, env: values, healthOrigin: origin(connectHost(config.http.host), config.http.port) };
}

export function pluginConnection(config) {
  return { mcpServers: { 'csy-workspace': { type: 'streamable-http', url: config.client.url, bearer_token_env_var: config.client.tokenEnv } } };
}

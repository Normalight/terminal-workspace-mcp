import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

// Logs are untrusted task data. Bound their size and remove common credentials
// before storing an observation or forwarding it to the configured bot.
export function cleanProgressText(value, max = 300) {
  return stripVTControlCharacters(String(value ?? ''))
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted private key]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [redacted]')
    .replace(/\b(password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret)(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1$2[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, '[redacted]')
    .replace(/https?:\/\/[^\s<>"']+/g, raw => {
      try { const u = new URL(raw); u.username = ''; u.password = ''; if (u.search) u.search = '?redacted'; if (u.hash) u.hash = '#redacted'; return u.href; } catch { return '[url]'; }
    })
    .replace(/[\x00-\x1f\x7f`*<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
export function reportedProgress(line) {
  const match = line.trim().match(/^MCP_PROGRESS\s+(\{.*\})$/);
  if (!match) return null;
  let data; try { data = JSON.parse(match[1]); } catch { return null; }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const out = {};
  for (const key of ['stage', 'unit', 'message']) if (typeof data[key] === 'string') out[key] = cleanProgressText(data[key], key === 'unit' ? 32 : 300);
  if (data.completed !== undefined || data.total !== undefined) {
    if (!number(data.completed) || !number(data.total) || !data.total || data.completed > data.total) return null;
    Object.assign(out, { completed: data.completed, total: data.total, percent: Math.round(data.completed / data.total * 1000) / 10 });
  } else if (data.percent !== undefined) {
    if (!number(data.percent) || data.percent > 100) return null;
    out.percent = data.percent;
  }
  return Object.values(out).some(v => v !== '') ? out : null;
}

function logProgress(line) {
  // These counters describe the named/logged stage, never overall job completion.
  const bar = line.match(/(\d{1,3}(?:\.\d+)?)%\s*\|[^|]*\|\s*(\d+)\s*\/\s*(\d+)/);
  const count = line.match(/\b(epoch|step|batch|file|item|sample)s?\s*[:：]?\s*(\d+)\s*\/\s*(\d+)/i)
    ?? line.match(/(轮次|批次|文件|样本|步骤|任务)\s*[:：]?\s*(\d+)\s*\/\s*(\d+)/);
  if (!bar && !count) return null;
  const completed = Number((bar ?? count)[2]), total = Number((bar ?? count)[3]);
  if (!number(completed) || !number(total) || !total || completed > total) return null;
  return { stage: bar ? cleanProgressText(line.split(':')[0].split('|')[0].replace(/\d+(?:\.\d+)?%.*$/, '')) || '日志报告阶段' : count[1],
    completed, total, percent: Math.round(completed / total * 1000) / 10, evidence: cleanProgressText(line) };
}

export function parseProgressOutput(content, { maxLines = 6 } = {}) {
  const raw = stripVTControlCharacters(content).replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted private key]');
  const lines = raw.split(/[\r\n]+/).filter(s => s.trim());
  let reported, inferred;
  const recentLines = [];
  for (const line of lines) {
    const record = reportedProgress(line);
    if (record) { reported = record; continue; }
    // Malformed explicit reports are data errors, not prose to forward.
    if (/^MCP_PROGRESS\s/.test(line.trim())) continue;
    const safe = cleanProgressText(line);
    if (!safe || /^__csy_dispatch\b/.test(safe)) continue;
    inferred = logProgress(safe) ?? inferred;
    if (recentLines.at(-1) !== safe) recentLines.push(safe);
  }
  return { report: reported ?? inferred ?? null, source: reported ? 'task_report' : inferred || recentLines.length ? 'terminal_output' : 'none', recentLines: recentLines.slice(-maxLines) };
}

export async function collectTaskProgress({ terminals, record, state, config, now }) {
  if (!config?.includeOutput) return undefined;
  try {
    // Discover the current command end with an empty bounded read, then tail
    // that command's range. Both reads keep the user's cursor independent and
    // the second read rechecks a final boundary if another command has started.
    const peek = await terminals.readCommand(record.terminalId, record.commandId, { cursor: Number.MAX_SAFE_INTEGER, maxBytes: 4, waitMs: 0 });
    const end = peek.output.endCursor;
    const page = await terminals.readCommand(record.terminalId, record.commandId, {
      cursor: Math.max(peek.startCursor, end - config.maxBytes), maxBytes: config.maxBytes, waitMs: 0 });
    const parsed = parseProgressOutput(page.output.content, config);
    const previous = record.progressObservation;
    const fingerprint = createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
    const changedAt = previous?.fingerprint === fingerprint ? previous.changedAt ?? now : now;
    const lastOutputAt = previous?.endCursor === page.output.endCursor ? previous.lastOutputAt ?? now : now;
    // Retain the last explicit report if it has scrolled out of the bounded
    // tail, but label its age instead of presenting it as a new observation.
    const savedReport = parsed.report ? { report: parsed.report, source: parsed.source,
      reportedAt: previous?.report && JSON.stringify(previous.report) === JSON.stringify(parsed.report) ? previous.reportedAt : now }
      : previous?.report ? { report: previous.report, source: previous.source, reportedAt: previous.reportedAt } : {};
    record.progressObservation = { fingerprint, changedAt, lastOutputAt, endCursor: page.output.endCursor, ...savedReport };
    return { ...parsed, ...savedReport, sampledAt: new Date(now).toISOString(),
      reportAgeMs: savedReport.reportedAt === undefined ? null : now - savedReport.reportedAt,
      noNewOutputMs: previous ? Math.max(0, now - lastOutputAt) : 0,
      unchangedForMs: Math.max(0, now - changedAt),
      outputGap: !!page.output.outputGap, tailLimited: page.output.cursor > peek.startCursor || page.output.truncated };
  } catch { return { source: 'unavailable', reason: 'output_read_failed', recentLines: [] }; }
}

export function progressMessage(progress) {
  if (!progress) return '';
  if (progress.source === 'unavailable') return '具体进度：本次读取任务输出失败，稍后继续检查。';
  const r = progress.report, lines = [];
  if (r) {
    const count = r.completed === undefined ? '' : `${r.completed}/${r.total}${r.unit ? ` ${r.unit}` : ''}`;
    lines.push(`最近报告${r.stage ? `（${r.stage}）` : ''}：${[count, r.percent === undefined ? '' : `${r.percent}%`].filter(Boolean).join('，') || r.message || '阶段已更新'}。`);
    if (r.message && count) lines.push(r.message);
    if (progress.reportAgeMs >= 1000) lines.push(`这条阶段进度距今 ${Math.floor(progress.reportAgeMs / 1000)} 秒；百分比仅代表报告的阶段。`);
    else if (r.percent !== undefined) lines.push('百分比仅代表报告的阶段。');
  }
  if (progress.recentLines.length) lines.push(`近期任务输出：\n${progress.recentLines.join('\n')}`);
  if (!r && !progress.recentLines.length) lines.push('任务暂无可读进度输出，当前无法确定执行到哪一步。');
  if (progress.noNewOutputMs >= 1000) lines.push(`最近 ${Math.floor(progress.noNewOutputMs / 1000)} 秒没有新增输出。`);
  if (progress.outputGap) lines.push('部分输出不可用，以上是当前可读取的进度。');
  return lines.map(line => line.replace(/[\\`*_<>]/g, '\\$&')).join('\n');
}

export function progressKey(snapshot) {
  return createHash('sha256').update(JSON.stringify({ status: snapshot.executionStatus ?? snapshot.status,
    outputStatus: snapshot.outputStatus, report: snapshot.progress?.report, lines: snapshot.progress?.recentLines,
    source: snapshot.progress?.source })).digest('hex');
}

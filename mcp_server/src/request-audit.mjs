import { AsyncLocalStorage } from 'node:async_hooks';

export const requestAudit = new AsyncLocalStorage();

function metadata(value = {}) {
  const fields = {};
  for (const [name, pattern] of Object.entries({ sessionId: /^term_[a-f0-9-]{36}$/, commandId: /^cmd_[a-f0-9-]{36}$/ })) {
    if (typeof value[name] === 'string' && pattern.test(value[name])) fields[name === 'sessionId' ? 'taskSessionId' : name] = value[name];
  }
  for (const name of ['status', 'executionStatus', 'outputStatus', 'nextAction']) {
    if (typeof value[name] === 'string' && /^[a-z_]{1,40}$/.test(value[name])) fields[name === 'status' ? 'taskStatus' : name] = value[name];
  }
  for (const name of ['exitCode', 'nextCursor', 'outputEndCursor']) if (Number.isSafeInteger(value[name])) fields[name] = value[name];
  for (const name of ['outputRead', 'outputGap', 'outputComplete', 'outputTruncated']) if (typeof value[name] === 'boolean') fields[name] = value[name];
  return fields;
}

// Results and HTTP delivery are separate facts. Never log commands, output,
// task labels or paths. Each request owns its context, including concurrent RPCs.
export async function auditTool(name, args, callback) {
  const context = requestAudit.getStore();
  if (!context) return callback();
  const began = Date.now();
  context.tool = { ...metadata(args), callKind: args.command !== undefined ? 'submit' : args.input !== undefined || args.key ? 'input' : args.statusOnly ? 'status' : 'read' };
  context.emit({ event: 'tool_started', requestId: context.requestId, toolName: name, ...context.tool });
  try {
    const response = await callback();
    context.tool = { ...context.tool, ...metadata(response.structuredContent), toolError: response.isError === true, toolDurationMs: Date.now() - began };
    if (response.isError) {
      try {
        const detail = JSON.parse(response.content?.find(item => item.type === 'text')?.text);
        if (/^[a-z_]{1,80}$/.test(detail.code)) context.tool.errorCode = detail.code;
      } catch {}
    }
    context.emit({ event: 'tool_result', requestId: context.requestId, toolName: name, ...context.tool });
    return response;
  } catch (error) {
    context.tool = { ...context.tool, toolError: true, toolDurationMs: Date.now() - began };
    context.emit({ event: 'tool_result', requestId: context.requestId, toolName: name, ...context.tool });
    throw error;
  }
}

export function registerAuditedTool(server, name, spec, callback) {
  return server.registerTool(name, spec, (args, extra) => auditTool(name, args, () => callback(args, extra)));
}

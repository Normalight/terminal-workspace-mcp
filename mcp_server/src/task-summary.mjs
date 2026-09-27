import path from 'node:path';
import { OperationError } from './runtime.mjs';

export function describeTask(command, provided) {
  if (provided !== undefined) {
    const normalized = typeof provided === 'string' ? provided.replace(/[\x00-\x20\x7f]+/g, ' ').trim() : '';
    if (!normalized || provided.length > 240) throw new OperationError('taskSummary must be 1..240 characters', 'invalid_input');
    return { taskSummary: normalized, taskSummarySource: 'caller' };
  }
  // Classify only the first executable. Never copy command arguments, paths,
  // environment assignments, or output into a notification automatically.
  const executable = path.basename((command ?? '').trim().split(/[\s;&|]/)[0]);
  const category = /^(python[\d.]*|pypy[\d.]*)$/.test(executable) ? 'Python 程序任务'
    : /^(node|npm|pnpm|yarn|bun)$/.test(executable) ? 'Node.js 项目任务'
    : /^(pytest|jest|vitest)$/.test(executable) ? '自动化测试任务'
    : /^(make|cmake|ninja)$/.test(executable) ? '项目构建任务'
    : executable === 'git' ? 'Git 仓库任务' : '终端后台任务';
  return { taskSummary: category, taskSummarySource: 'command_type' };
}

export const summaryMarkdown = text => text.replace(/[\\`*_{}[\]()#+.!|<>]/g, '\\$&');

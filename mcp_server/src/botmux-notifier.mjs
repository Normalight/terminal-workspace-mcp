import { spawn } from 'node:child_process';
import { describeTask, summaryMarkdown } from './task-summary.mjs';

export function completionMessage(record, state) {
  const label = { succeeded: '已完成', failed: '执行失败', terminal_closed: '终端已结束',
    failed_to_start: '启动失败', unknown: '执行状态待核查', submission_uncertain: '提交状态待核查' }[state.executionStatus ?? state.status] ?? '状态待核查';
  const outputSummary = { complete: '输出收集已结束', incomplete: '输出可能不完整，需检查', pending: '输出仍在收集中' }[state.outputStatus] ?? '输出状态待核查';
  return ['Terminal Workspace 长任务通知', `任务摘要：${summaryMarkdown(record.taskSummary ?? state.taskSummary ?? describeTask(state.command).taskSummary)}`,
    `结果摘要：${label}；${outputSummary}。`,
    `退出码：${state.exitCode ?? '未知'}`, `运行时长：${record.durationIsLowerBound ? '至少 ' : ''}${Math.round(record.durationMs / 1000)} 秒`,
    `输出状态：${state.outputStatus ?? '未知'}`, `任务：${record.commandId}`, `终端：${record.terminalId}`,
    '查看结果时使用原任务参数，不重新提交命令：',
    JSON.stringify({ sessionId: record.terminalId, commandId: record.commandId, waitMs: 0 }),
  ].join('\n');
}

// Explicit routing only: never inherit an interactive turn's BOTMUX identity.
// The CLI receives text over stdin and arguments as an array, without a shell.
export function sendBotmux({ executable, timeoutMs, env, cwd, target, message, signal }) {
  return new Promise(resolve => {
    const args = ['send', '--session-id', target.sessionId, '--no-quote', '--response-kind', 'auxiliary',
      ...(target.mentionOpenId ? ['--mention', target.mentionOpenId] : ['--no-mention'])];
    const child = spawn(executable, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', finished = false, interrupted = false;
    const stop = () => { interrupted = true; child.kill('SIGKILL'); };
    const timer = setTimeout(stop, timeoutMs);
    const finish = value => {
      if (finished) return;
      finished = true; clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve(value);
    };
    signal?.addEventListener('abort', stop, { once: true });
    if (signal?.aborted) stop();
    child.stdout.on('data', data => { output += data; if (output.length > 65536) stop(); });
    child.stderr.on('data', () => {}); // Never persist CLI errors with credentials/context.
    child.stdin.on('error', () => {});
    child.once('error', error => finish({ status: 'retry', code: error.code === 'ENOENT' ? 'botmux_not_found' : 'botmux_spawn_failed' }));
    child.once('close', (code, exitSignal) => {
      // A valid receipt proves delivery even if shutdown raced with CLI exit.
      const receipt = output.split('\n').map(line => { try { return JSON.parse(line); } catch { return null; } })
        .find(x => x?.success === true && /^om_[a-zA-Z0-9]+$/.test(x.messageId));
      if (receipt) return finish({ status: 'sent', messageId: receipt.messageId });
      if (interrupted || exitSignal || code === 0) return finish({ status: 'uncertain', code: 'botmux_delivery_unconfirmed' });
      finish({ status: 'retry', code: 'botmux_send_failed' });
    });
    child.stdin.end(message);
  });
}

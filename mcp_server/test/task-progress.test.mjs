import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { TerminalManager } from '../src/terminal-manager.mjs';
import { collectTaskProgress, parseProgressOutput, reportedProgress, progressMessage } from '../src/task-progress.mjs';
import { taskMessage, taskSnapshot } from '../src/botmux-task-monitor.mjs';
import { fixture } from './helpers.mjs';

const config = { includeOutput: true, maxBytes: 1024, maxLines: 3 };
test('explicit reports retain stage/count evidence and do not invent whole-task completion', () => {
  const parsed = parseProgressOutput('preparing\nMCP_PROGRESS {"stage":"验证集","completed":24,"total":100,"unit":"样本","message":"计算指标"}\ncheckpoint written\n');
  assert.deepEqual(parsed.report, { stage:'验证集', unit:'样本', message:'计算指标', completed:24, total:100, percent:24 });
  assert.equal(parsed.source,'task_report'); assert.deepEqual(parsed.recentLines,['preparing','checkpoint written']);
  assert.match(progressMessage({...parsed,reportAgeMs:0,noNewOutputMs:0}), /24\/100 样本，24%/);
  for(const invalid of ['{"completed":1,"total":0}', '{"completed":101,"total":100}', '{"percent":101}', '{"completed":"2","total":3}', 'null']) assert.equal(reportedProgress('MCP_PROGRESS '+invalid),null);
  const final = taskMessage({kind:'completion',snapshot:{taskSummary:'验证质量并生成报告',taskSummarySource:'caller',executionStatus:'succeeded',outputStatus:'complete',elapsedMs:1000,progress:parsed}});
  assert.match(final,/任务目的：验证质量并生成报告/); assert.match(final,/24%/); assert(!final.includes('100%'));
  assert.match(taskMessage({kind:'start',snapshot:{taskSummary:'Python 程序任务',taskSummarySource:'command_type',elapsedMs:0}}),/任务目的：提交时未提供/);
});

test('ANSI progress bars and named counters are read as stage progress, not arbitrary metrics', () => {
  const p = parseProgressOutput('\x1b[32mTrain: 20%|##        | 2/10\x1b[0m\rTrain: 40%|####      | 4/10\r\naccuracy: 99%\n');
  assert.equal(p.report.completed,4);assert.equal(p.report.percent,40);assert.equal(p.source,'terminal_output');
  assert(!p.recentLines.join('').includes('\x1b')); assert.equal(parseProgressOutput('accuracy=99% loss=0.1').report,null);
  assert.equal(parseProgressOutput('epoch 3/12 loss=0.15').report.percent,25);
  assert.equal(parseProgressOutput('样本 240/1000 已处理').report.completed,240);
});

test('bounded evidence removes common credentials before bot prompts and persistence', () => {
  const raw='Authorization: Bearer PRIVATE_CREDENTIAL\napi_key="SECRET" password=hunter2\nhttps://user:pass@example.com/result?token=SECRET#SECRET\n-----BEGIN '+'PRIVATE KEY-----\nPRIVATE_BODY\n-----END PRIVATE KEY-----\nMCP_PROGRESS {"stage":"验证","message":"token=SECRET","percent":25}\n';
  const p=parseProgressOutput(raw,{maxLines:10}), text=JSON.stringify(p);
  for(const secret of ['PRIVATE_CREDENTIAL','SECRET','hunter2','PRIVATE_BODY','user:pass']) assert(!text.includes(secret),secret);
  assert(text.includes('redacted'));assert.equal(p.report.percent,25);
});

test('progress observations survive restart, retain old reports with age and expose silence', async () => {
  let content='MCP_PROGRESS {"stage":"下载","completed":2,"total":10}\n', end=100;
  const terminals={readCommand:async(_s,_c,o)=>({startCursor:0,output:{content:o.maxBytes===4?'':content,endCursor:end,cursor:0,outputGap:false,truncated:false}})};
  const record={terminalId:'term',commandId:'cmd'};
  const first=await collectTaskProgress({terminals,record,config,now:10000});assert.equal(first.report.percent,20);
  const resumed=JSON.parse(JSON.stringify(record));
  const same=await collectTaskProgress({terminals,record:resumed,config,now:20000});
  assert.equal(same.noNewOutputMs,10000);assert.equal(same.reportAgeMs,10000);
  content='writing output\n';end=200;
  const newer=await collectTaskProgress({terminals,record:resumed,config,now:30000});
  assert.equal(newer.report.percent,20);assert.equal(newer.reportAgeMs,20000);assert.equal(newer.noNewOutputMs,0);assert.deepEqual(newer.recentLines,['writing output']);
  const silent=await collectTaskProgress({terminals,record:{},config,now:30000});assert.equal(silent.report,null);
});

test('disabled or unavailable output does not prevent lifecycle notifications', async () => {
  let calls=0;const terminals={readCommand:async()=>{calls++;throw Error('PRIVATE_ERROR');}};
  assert.equal(await collectTaskProgress({terminals,record:{},config:{includeOutput:false},now:0}),undefined);assert.equal(calls,0);
  const p=await collectTaskProgress({terminals,record:{},config,now:0});assert.equal(p.source,'unavailable');assert(!JSON.stringify(p).includes('PRIVATE_ERROR'));
  assert.match(progressMessage(p),/读取任务输出失败/);
  assert.match(progressMessage({source:'none',recentLines:[]}),/暂无可读进度输出/);
});

test('actual terminal tail respects saved command boundaries and independent reader cursors', {timeout:15000}, async () => {
  const f=await fixture(),t=await new TerminalManager({root:path.join(f.root,'tmux'),env:f.env}).initialize();let id;
  try{
    id=(await t.open({cwd:f.root})).sessionId;
    const a=await t.execute(id,{command:`printf 'MCP_PROGRESS {"stage":"校验","completed":3,"total":12}\n'; printf 'FINISHED_FIRST\n'`,waitMs:1000});
    await t.execute(id,{command:'printf SECOND_COMMAND_SECRET',waitMs:1000});
    const state=await t.commandStatus(id,a.commandId);
    const record={terminalId:id,commandId:a.commandId};
    const evidence=await collectTaskProgress({terminals:t,record,state,config,now:Date.now()});
    assert.equal(evidence.report.percent,25);assert(evidence.recentLines.includes('FINISHED_FIRST'));assert(!JSON.stringify(evidence).includes('SECOND_COMMAND_SECRET'));
    const reread=await t.readCommand(id,a.commandId,{cursor:a.startCursor,waitMs:0});assert.match(reread.output.content,/FINISHED_FIRST/);
    const s=taskSnapshot(record,state,Date.now());assert.equal(s.status,'succeeded');
  }finally{if(id)await t.close(id).catch(()=>{});await t.run(['kill-server']).catch(()=>{});await f.cleanup();}
});

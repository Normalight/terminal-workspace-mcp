import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { TerminalManager } from "../src/terminal-manager.mjs";
import { delay, quote, OperationError } from "../src/runtime.mjs";
import { fixture } from "./helpers.mjs";

test('tmux preserves cwd/env, supports prompts, Ctrl+C, resize and manager reconnect', {timeout:20000},async()=>{
 const f=await fixture();const t=await new TerminalManager({root:path.join(f.root,'tmux'),env:f.env}).initialize();let id;
 try{
 await mkdir(path.join(f.root,'nested'));const opened=await t.open({cwd:f.root});id=opened.sessionId;assert(opened.alive);
 let r=await t.execute(id,{command:'cd nested; export AUDIT_VALUE=preserved',waitMs:2000});assert.equal(r.exitCode,0);
 const next=await new TerminalManager({root:t.root,env:f.env}).initialize();r=await next.execute(id,{command:"printf '%s:%s\\n' \"$PWD\" \"$AUDIT_VALUE\"",waitMs:2000});assert.equal(r.exitCode,0);
 await delay(100);assert.match((await next.read(id,{cursor:r.startCursor})).content,/nested:preserved/);
 r=await next.execute(id,{command:"read -r -p 'Your answer: ' answer; printf 'answer=%s\\n' \"$answer\"",waitMs:100});assert.equal(r.status,'running');
 await next.write(id,{input:'yes',enter:true});for(let i=0;i<50;i++){if((await next.commandStatus(id,r.commandId)).status!=='running')break;await delay(20);}
 assert.equal((await next.commandStatus(id,r.commandId)).exitCode,0);await delay(50);assert.match((await next.read(id,{cursor:r.startCursor})).content,/answer=yes/);
 r=await next.execute(id,{command:'sleep 10',waitMs:100});assert.equal(r.status,'running');await next.write(id,{key:'C-c'});
 for(let i=0;i<50;i++){if((await next.commandStatus(id,r.commandId)).status!=='running')break;await delay(20);}
 assert.equal((await next.commandStatus(id,r.commandId)).exitCode,130);
 await next.resize(id,100,30);await next.close(id);assert.equal((await next.status(id)).status,'closed');
 }finally{if(id)await t.close(id);await f.cleanup();}
});

test('tmux rejecting pipe close on dead panes still drains output and persists the exit code', { timeout: 15000 }, async () => {
 const f = await fixture(), t = await new TerminalManager({ root: path.join(f.root, 'tmux'), env: f.env }).initialize();
 const run = t.run.bind(t); let rejected = 0, removed = 0, id;
 t.run = async args => {
  if (args[0] === 'if-shell' && args.some(x => x.startsWith('pipe-pane '))) { rejected++; throw new OperationError('target pane has exited', 'terminal_error'); }
  if (args.some(x => x.startsWith('kill-pane '))) { assert.match(args[4], /pane_dead_status/); removed++; }
  return run(args);
 };
 try {
  id = (await t.open({ cwd: f.root })).sessionId;
  const r = await t.execute(id, { command: "printf '%0200000d' 0; printf DRAINED; exit 9", waitMs: 3000, maxBytes: 1048576 });
  assert.equal(rejected, 1); assert.equal(removed, 1); assert.equal(r.status, 'terminal_closed'); assert.equal(r.exitCode, 9);
  assert.match(r.output.content, /0{200000}DRAINED/); assert.equal(r.output.truncated, false);
  const fresh = new TerminalManager({ root: t.root, env: f.env });
  assert.equal((await fresh.commandStatus(id, r.commandId)).exitCode, 9);
 } finally { if (id) await t.close(id).catch(() => {}); await t.run(['kill-server']).catch(() => {}); await f.cleanup(); }
});

test('exit and exec report completion only after large final output drains', { timeout: 15000 }, async () => {
 const f = await fixture(), t = await new TerminalManager({ root: path.join(f.root, 'tmux'), env: f.env, segmentBytes: 32768 }).initialize();
 const ids = [];
 try {
  for (const mode of ['exit', 'exec']) {
   const id = (await t.open({ cwd: f.root })).sessionId; ids.push(id);
   const command = "printf '%0200000d' 0; printf FINISHED; exit 9";
   const r = await t.execute(id, { command: mode === 'exit' ? command : `exec /bin/bash --noprofile --norc -c ${quote(command)}`, waitMs: 3000, maxBytes: 1048576 });
   assert.equal(r.status, 'terminal_closed'); assert.equal(r.exitCode, 9);
   assert.match(r.output.content, /0{200000}FINISHED/);
   assert.equal(r.output.truncated, false); assert.equal(r.output.nextCursor, r.outputEndCursor);
   await t.close(id);
  }
 } finally { for (const id of ids) await t.close(id).catch(() => {}); await t.run(['kill-server']).catch(() => {}); await f.cleanup(); }
});

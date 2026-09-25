import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { TerminalManager } from "../src/terminal-manager.mjs";
import { delay } from "../src/runtime.mjs";
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

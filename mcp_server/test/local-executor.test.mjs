import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { LocalCommandExecutor } from "../src/local-executor.mjs";
import { JobManager } from "../src/job-manager.mjs";
import { fixture } from "./helpers.mjs";
import { delay } from "../src/runtime.mjs";

test('output pagination and wait limits keep execution alive with raw complete logs',async()=>{
 const f=await fixture();const jobs=await new JobManager({root:path.join(f.root,'jobs'),shell:f.shell}).initialize();
 try{const exec=new LocalCommandExecutor({jobManager:jobs});
 const r=await exec.execute({command:"printf 'token=fixture-value\\n'; printf '%04096d' 0; sleep .3; printf 'done' > done",cwd:f.root,env:f.env,waitMs:50,maxOutputBytes:1024});
 assert(r.waitingExpired);assert.equal(r.signal,null);assert.match(r.stdout,/token=fixture-value/);
 const state=await jobs.wait(r.jobId,3000);assert.equal(state.status,'succeeded');assert.equal(await readFile(path.join(f.root,'done'),'utf8'),'done');
 const logs=await jobs.logs(r.jobId,{stdoutCursor:0,maxBytes:8192});assert.equal(logs.stdout.length,4116);assert(!logs.stdoutPage.truncated);
 }finally{for(const j of await jobs.list())await jobs.stop(j.jobId,{force:true});await f.cleanup();}
});
test('startup failures and explicit execution deadlines persist terminal states',async()=>{
 const f=await fixture();try{
 const bad=await new JobManager({root:path.join(f.root,'bad'),shell:path.join(f.root,'missing')}).initialize();const b=await bad.start({command:'true',cwd:f.root,env:f.env});assert.equal((await bad.wait(b.jobId,3000)).status,'failed_to_start');
 const jobs=await new JobManager({root:path.join(f.root,'jobs'),shell:f.shell}).initialize();const task=await jobs.start({command:'sleep 10',cwd:f.root,env:f.env,executionTimeoutMs:100});const done=await jobs.wait(task.jobId,3000);assert.equal(done.status,'timed_out');
 }finally{await f.cleanup();}
});
test('jobs survive manager recreation and confirmed stop escalates for ignored TERM',async()=>{
 const f=await fixture();const jobs=await new JobManager({root:path.join(f.root,'jobs'),shell:f.shell}).initialize();
 try{const j=await jobs.start({command:"trap '' TERM; printf ready; while :; do sleep 1; done",cwd:f.root,env:f.env});
 for(let i=0;i<30;i++){if((await jobs.logs(j.jobId)).stdout.includes('ready'))break;await delay(20);}
 const reopened=await new JobManager({root:jobs.root,shell:f.shell}).initialize();assert.equal((await reopened.status(j.jobId)).status,'running');
 const stopped=await reopened.stop(j.jobId,{waitMs:4000});assert(stopped.stopped);assert.equal(stopped.status,'cancelled');
 }finally{for(const j of await jobs.list())await jobs.stop(j.jobId,{force:true});await f.cleanup();}
});
test('original UTF-8 bytes and split labels survive persistence and cursor reads',async()=>{
 const f=await fixture();const jobs=await new JobManager({root:path.join(f.root,'jobs'),shell:f.shell,segmentBytes:1024}).initialize();
 try{const j=await jobs.start({command:"printf 'to'; sleep .1; printf 'ken=fixture\\n'; printf '\\344'; sleep .1; printf '\\270\\255\\n'",cwd:f.root,env:f.env});await jobs.wait(j.jobId,3000);
 assert.equal((await jobs.logs(j.jobId,{stdoutCursor:0})).stdout,'token=fixture\n中\n');
 const preview=await jobs.cleanup({retainCount:0,dryRun:true});assert(preview.removed.includes(j.jobId));await jobs.cleanup({retainCount:0});assert.equal((await jobs.list()).length,0);
 }finally{await f.cleanup();}
});

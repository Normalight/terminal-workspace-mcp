import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { TerminalManager } from '../src/terminal-manager.mjs';
import { TerminalAdmin } from '../src/terminal-admin.mjs';
import { atomicJson, delay } from '../src/runtime.mjs';
import { fixture } from './helpers.mjs';

test('terminal ownership, legacy recognition, previews and idle cleanup protect live work', {timeout:30000}, async () => {
  const f = await fixture(), t = await new TerminalManager({root:path.join(f.root,'tmux'),env:f.env}).initialize(), admin = new TerminalAdmin(t);
  const ids = []; let attachedClient;
  const open = async () => { const s = await t.open({cwd:f.root}); ids.push(s.sessionId); return s.sessionId; };
  const future = () => Date.now()+3600000;
  try {
    const exited=await open(), idle=await open(), busy=await open(), background=await open(), kept=await open(), split=await open(), legacy=await open(), attached=await open();
    attachedClient=spawn('tmux',['-S',t.socket,'-C','attach-session','-t',attached],{env:{...f.env,TERM:'xterm-256color'},stdio:['pipe','pipe','pipe']});
    attachedClient.stdout.resume();attachedClient.stderr.resume();
    for(let i=0;i<50;i++){if(await t.run(['display-message','-p','-t',attached,'#{session_attached}'])==='1')break;await delay(20);}
    await t.execute(exited,{command:'printf preserved; exit',waitMs:100});
    await t.execute(busy,{command:'sleep 30',waitMs:0});
    await t.execute(background,{command:'sleep 30 &',waitMs:500});
    await t.run(['set-option','-t',kept,'@mcp_keep','1']);
    await t.run(['split-window','-d','-t',split,'sleep 30']);
    const legacyMeta=JSON.parse(await readFile(path.join(t.dir(legacy),'meta.json'),'utf8'));
    delete legacyMeta.owner;delete legacyMeta.managerId;delete legacyMeta.tmuxSessionId;
    await atomicJson(path.join(t.dir(legacy),'meta.json'),legacyMeta);
    await t.run(['set-option','-u','-t',legacy,'@mcp_manager']);
    await t.run(['set-option','-u','-t',legacy,'@mcp_owner']);
    const foreign=`term_${randomUUID()}`;
    await t.run(['new-session','-d','-s',foreign,'sleep 30']);
    let inventory=await admin.inventory({idleTtlMs:300000,now:future()});
    const byId=new Map(inventory.sessions.map(s=>[s.sessionId,s]));
    assert.equal(byId.get(idle).ownership,'tagged');
    assert.equal(byId.get(legacy).ownership,'legacy');
    assert.equal(byId.get(foreign).managed,false);
    assert.equal(byId.get(busy).reclaimable,false);
    assert.equal(byId.get(background).reclaimable,false);
    assert.equal(byId.get(kept).reason,'kept_session');
    assert.equal(byId.get(split).reason,'modified_layout');
    assert.equal(byId.get(attached).reason,'attached_client');
    const preview=await admin.cleanup({idleTtlMs:300000,now:future()});
    assert.deepEqual(preview.candidates.sort(),[exited,idle,legacy].sort());
    assert(preview.dryRun);assert(await t.pane(idle).then(s=>s.alive));
    // Recent polling protects a session; use actual time to test the persisted activity.
    await t.read(idle,{waitMs:0});
    assert(!(await admin.cleanup({idleTtlMs:300000})).candidates.includes(idle));
    const result=await admin.cleanup({apply:true,idleTtlMs:300000,now:future()});
    assert.deepEqual(result.removed.sort(),[exited,idle,legacy].sort());
    assert.equal((await t.pane(idle)).alive,false);
    assert((await t.pane(busy)).alive);assert((await t.pane(background)).alive);assert((await t.pane(foreign)).alive);
    assert.match((await t.read(exited,{cursor:0})).content,/preserved/);
    assert((await admin.inventory()).sessions.some(s=>s.sessionId===exited && s.state==='missing'));
  } finally {
    attachedClient?.kill();
    for(const id of ids)await t.close(id).catch(()=>{});
    await t.run(['kill-server']).catch(()=>{});await f.cleanup();
  }
});

test('cross-manager locks prevent cleanup racing a command and changed eligibility is rechecked', {timeout:15000}, async () => {
  const f=await fixture(), t=await new TerminalManager({root:path.join(f.root,'tmux'),env:f.env}).initialize();
  const other=await new TerminalManager({root:t.root,env:f.env}).initialize();let id;
  try {
    id=(await t.open({cwd:f.root})).sessionId;
    let release,locked=false,secondEntered=false;
    const first=t.locked(id,async()=>{locked=true;await new Promise(r=>release=r);});
    while(!locked)await delay(5);
    const second=other.locked(id,async()=>{secondEntered=true;});
    await delay(100);assert.equal(secondEntered,false);release();await first;await second;assert(secondEntered);
    const admin=new TerminalAdmin(other), original=admin.inventory.bind(admin);
    admin.inventory=async options=>{const listing=await original(options);await t.execute(id,{command:'sleep 10',waitMs:0});return listing;};
    const result=await admin.cleanup({apply:true,idleTtlMs:1,now:Date.now()+60000});
    assert(result.skipped.includes(id));assert((await t.pane(id)).alive);
  } finally {if(id)await t.close(id).catch(()=>{});await f.cleanup();}
});

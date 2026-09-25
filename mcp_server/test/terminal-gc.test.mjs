import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture, workspaceRoot } from './helpers.mjs';
import { delay } from '../src/runtime.mjs';
import { TerminalManager } from '../src/terminal-manager.mjs';

test('server automatically reclaims idle shells while a long command survives', {timeout:15000}, async () => {
  const f=await fixture(), reservation=createServer();
  await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
  const token='synthetic-gc-test',root=path.join(f.root,'terminals');
  const env={...f.env,MCP_NO_HTTP:'0',MCP_AUTH_TOKEN:token,MCP_ALLOW_ANONYMOUS:'0',MCP_WORKSPACE_ROOT:f.root,MCP_HOST:'127.0.0.1',MCP_PORT:String(port),MCP_TOOL_PROFILE:'minimal',MCP_ENABLE_TERMINAL:'1',MCP_JOB_ROOT:path.join(f.root,'jobs'),MCP_TERMINAL_ROOT:root,MCP_HTTP_AUDIT_LOG:path.join(f.root,'audit.jsonl'),MCP_TERMINAL_IDLE_TTL_MS:'250',MCP_TERMINAL_GC_INTERVAL_MS:'1000'};
  const proc=spawn(process.execPath,[path.join(workspaceRoot,'mcp_server/src/server.mjs')],{env,stdio:['ignore','ignore','pipe']});const exited=once(proc,'exit');let stderr='';proc.stderr.on('data',d=>stderr+=d);
  const client=new Client({name:'gc-test',version:'1'}), t=await new TerminalManager({root,env:f.env}).initialize();
  try {
    const url=`http://127.0.0.1:${port}`;let healthy=false;
    for(let i=0;i<100;i++){if(proc.exitCode!==null)throw new Error(stderr);try{healthy=(await fetch(url+'/healthz')).ok;}catch{}if(healthy)break;await delay(30);}
    assert(healthy,stderr);
    await client.connect(new StreamableHTTPClientTransport(new URL(url+'/mcp'),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));
    const call=async args=>{const r=await client.callTool({name:'execute_command',arguments:args});assert(!r.isError,JSON.stringify(r));return r.structuredContent;};
    const idle=await call({command:'printf idle',cwd:f.root,waitMs:500});
    const busy=await call({command:'sleep 3; printf survived',cwd:f.root,waitMs:0});assert.equal(busy.status,'running');
    for(let i=0;i<40&&(await t.pane(idle.sessionId)).alive;i++)await delay(50);
    assert.equal((await t.pane(idle.sessionId)).alive,false);
    assert.equal((await t.commandStatus(busy.sessionId,busy.commandId)).status,'running');
    assert.match((await t.read(idle.sessionId,{cursor:0})).content,/idle/);
    let result=busy, output=busy.stdout;
    for(let i=0;i<50&&result.status==='running';i++){await delay(100);result=await call({sessionId:busy.sessionId,cursor:result.nextCursor,waitMs:100});output+=result.stdout;}
    assert.equal(result.exitCode,0);assert.match(output,/survived/);
    assert.match(stderr,/terminal-gc/);
  } finally {
    await client.close().catch(()=>{});if(proc.exitCode===null){proc.kill('SIGTERM');await exited;}
    await t.run(['kill-server']).catch(()=>{});await f.cleanup();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, createConnection } from 'node:net';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, workspaceRoot } from './helpers.mjs';
import { delay } from '../src/runtime.mjs';

test('HTTP authentication, tools, hostile input and restart-safe terminal/job workflows', {timeout:30000},async()=>{
 const f=await fixture();const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));
 let proc,exited,stderr='',session,id=0,terminalId,jobId;
 const token='synthetic-http-fixture';const url=`http://127.0.0.1:${port}`;
 const env={...f.env,MCP_TOOL_PROFILE:'legacy',MCP_NO_HTTP:'0',MCP_ALLOW_ANONYMOUS:'0',MCP_AUTH_TOKEN:token,MCP_HOST:'127.0.0.1',MCP_PORT:String(port),MCP_WORKSPACE_ROOT:f.root,MCP_JOB_ROOT:path.join(f.root,'jobs'),MCP_TERMINAL_ROOT:path.join(f.root,'terminals'),MCP_HTTP_AUDIT_LOG:path.join(f.root,'audit.jsonl'),MCP_TERMINAL_SHELL:f.shell,MCP_ENABLE_TERMINAL:'1',MCP_ENABLE_WRITE:'1'};
 async function start(){proc=spawn(process.execPath,[path.join(workspaceRoot,'mcp_server/src/server.mjs')],{cwd:workspaceRoot,env,stdio:['ignore','ignore','pipe']});exited=once(proc,'exit');proc.stderr.on('data',d=>stderr+=d.toString());
  for(let i=0;i<100;i++){if(proc.exitCode!==null)throw Error(stderr);try{if((await fetch(url+'/healthz')).ok)return;}catch{}await delay(30);}throw Error('not ready: '+stderr);
 }
 async function stop(){if(proc?.exitCode===null){proc.kill('SIGTERM');await exited;}}
 async function request(method,params={},withAuth=true){const response=await fetch(url+'/mcp',{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream',...(withAuth?{Authorization:`Bearer ${token}`} : {}),...(session?{'mcp-session-id':session}:{}),'mcp-protocol-version':'2025-06-18'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal:AbortSignal.timeout(10000)});const data=await response.json();return {response,data};}
 async function initialize(){session=null;const x=await request('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'integration-test',version:'1'}});assert.equal(x.response.status,200);session=x.response.headers.get('mcp-session-id');}
 async function tool(name,args={}){const x=await request('tools/call',{name,arguments:args});assert.equal(x.response.status,200,JSON.stringify(x.data));return x.data.result;}
 try{
  await start();assert.equal((await request('ping',{},false)).response.status,401);await initialize();
  const toolResponse=await request('tools/list');assert.equal(toolResponse.response.headers.get('content-encoding'),'gzip');assert.match(toolResponse.response.headers.get('vary'),/Accept-Encoding/);const listing=toolResponse.data.result.tools;assert.equal(listing.length,29);assert(listing.some(x=>x.name==='execute_in_terminal'));assert(listing.some(x=>x.name==='read_file_chunk'));
  const diagnostic=await tool('server_diagnostics');assert(!diagnostic.isError,JSON.stringify(diagnostic));assert.equal(diagnostic.structuredContent.toolCount,29);
  const denied=await tool('execute_readonly_command',{command:'git branch new-branch'});assert(denied.isError);
  const output=await tool('execute_command',{command:"printf 'token=original\\n'",waitMs:1000});assert(!output.isError,JSON.stringify(output));assert.equal(output.structuredContent.stdout,'token=original\n');
  const opened=await tool('open_terminal',{cwd:f.root});assert(!opened.isError,JSON.stringify(opened));terminalId=opened.structuredContent.sessionId;
  const command=await tool('execute_in_terminal',{sessionId:terminalId,command:'export RESUME_VALUE=restored',waitMs:1000});assert.equal(command.structuredContent.exitCode,0);
  const task=await tool('start_job',{command:'sleep 1; printf survived'});jobId=task.structuredContent.jobId;
  await new Promise(resolve=>{const socket=createConnection({port,host:'127.0.0.1'},()=>socket.end('GET /mcp HTTP/1.1\r\nHost: [\r\nConnection: close\r\n\r\n'));socket.on('error',()=>{});socket.resume();socket.on('close',resolve);socket.setTimeout(2000,()=>socket.destroy());});
  assert.equal((await fetch(url+'/healthz')).status,200);
  await stop();await start();await initialize();
  const resumed=await tool('open_terminal',{sessionId:terminalId});assert(resumed.structuredContent.alive);
  const echo=await tool('execute_in_terminal',{sessionId:terminalId,command:'printf "$RESUME_VALUE"',waitMs:1000});assert.equal(echo.structuredContent.exitCode,0);
  await delay(100);assert.match((await tool('read_terminal',{sessionId:terminalId,cursor:echo.structuredContent.startCursor})).structuredContent.content,/restored/);
  for(let i=0;i<50;i++){if((await tool('get_job_status',{jobId})).structuredContent.status==='succeeded')break;await delay(30);}
  assert.equal((await tool('get_job_status',{jobId})).structuredContent.status,'succeeded');
  assert.equal((await tool('get_job_logs',{jobId,stdoutCursor:0})).structuredContent.stdout,'survived');
  await writeFile(path.join(f.root,'large.txt'),'x'.repeat(2000000));const page=await tool('read_file',{path:path.join(f.root,'large.txt'),maxBytes:1024});assert.equal(page.structuredContent.content.length,1024);assert(page.structuredContent.truncated);
 }finally{
  if(proc?.exitCode===null&&session){if(terminalId)await tool('close_terminal',{sessionId:terminalId}).catch(()=>{});if(jobId)await tool('stop_job',{jobId,force:true}).catch(()=>{});}
  await stop();await f.cleanup();
 }
});

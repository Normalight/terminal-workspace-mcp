import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { fixture } from './helpers.mjs';
import { delay } from '../src/runtime.mjs';
import { TerminalManager } from '../src/terminal-manager.mjs';

test('two-tool profile handles shell state, prompts, paging, exit, and file chunks', {timeout:20000},async()=>{
 const f=await fixture();Object.assign(process.env,{MCP_NO_HTTP:'1',MCP_ALLOW_ANONYMOUS:'0',MCP_AUTH_TOKEN:'synthetic-minimal',MCP_WORKSPACE_ROOT:f.root,MCP_TOOL_PROFILE:'minimal',MCP_ENABLE_TERMINAL:'1',MCP_ENABLE_WRITE:'1',MCP_JOB_ROOT:path.join(f.root,'jobs'),MCP_TERMINAL_ROOT:path.join(f.root,'terminals'),MCP_HTTP_AUDIT_LOG:path.join(f.root,'audit.jsonl')});
 const {createMcpServer}=await import('../src/server.mjs');const server=createMcpServer(),client=new Client({name:'minimal-test',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);let id;
 const call=async(name,args)=>{const r=await client.callTool({name,arguments:args});assert(!r.isError,JSON.stringify(r));return r;};
 try{
 const tools=(await client.listTools()).tools;assert.deepEqual(tools.map(x=>x.name).sort(),['execute_command','get_file']);
 assert(Buffer.byteLength(JSON.stringify(tools))<6000);
 let r=(await call('execute_command',{command:'export TEST_CONTEXT=kept; mkdir child; cd child',cwd:f.root,waitMs:1000})).structuredContent;id=r.sessionId;assert.equal(r.exitCode,0);
 r=(await call('execute_command',{sessionId:id,command:'printf "value=%s\\n" "$TEST_CONTEXT"; pwd',waitMs:1000})).structuredContent;
 assert.equal(r.exitCode,0);await delay(70);r=(await call('execute_command',{sessionId:id,cursor:r.startCursor,waitMs:0})).structuredContent;assert.match(r.stdout,/value=kept/);assert.match(r.stdout,/child/);
 r=(await call('execute_command',{sessionId:id,command:'read -r answer; printf "reply=%s\\n" "$answer"',waitMs:50})).structuredContent;assert.equal(r.status,'running');
 r=(await call('execute_command',{sessionId:id,input:'yes\n',cursor:r.nextCursor,waitMs:200})).structuredContent;
 for(let i=0;i<20&&r.status==='running';i++){await delay(30);r=(await call('execute_command',{sessionId:id,cursor:r.nextCursor,waitMs:50})).structuredContent;}
 assert.equal(r.exitCode,0);
 r=(await call('execute_command',{sessionId:id,command:"printf '%04096d' 0; sleep .2; printf completed",waitMs:0,maxBytes:1024})).structuredContent;
 assert(r.waitingExpired);await delay(400);r=(await call('execute_command',{sessionId:id,cursor:r.nextCursor,waitMs:0,maxBytes:8192})).structuredContent;assert.equal(r.exitCode,0);assert.match(r.stdout,/completed/);
 const file=path.join(f.root,'binary.bin');await writeFile(file,Buffer.from([0,1,2,255,4,5,6,7]));
 const first=await call('get_file',{path:file,offset:0,maxBytes:4});assert.equal(first.structuredContent.nextOffset,4);assert.equal(first.structuredContent.totalBytes,8);
 const last=await call('get_file',{path:file,offset:4,maxBytes:4});assert(last.structuredContent.eof);assert.deepEqual(Buffer.from(last.content[1].resource.blob,'base64'),Buffer.from([4,5,6,7]));
 await call('execute_command',{sessionId:id,command:'exit',waitMs:1000});
 }finally{
 if(id)await new TerminalManager({root:path.join(f.root,'terminals'),env:f.env}).close(id).catch(()=>{});
 await client.close();await server.close();await f.cleanup();
 }
});

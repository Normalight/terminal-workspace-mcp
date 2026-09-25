import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile, mkdir, symlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import path from 'node:path';
import { loadConfig, pluginConnection } from '../src/config.mjs';
import { fixture, workspaceRoot } from './helpers.mjs';
import { delay } from '../src/runtime.mjs';
const exec = promisify(execFile);
const freshEnv = source => Object.fromEntries(Object.entries(source).filter(([key]) => !key.startsWith('MCP_') && !key.startsWith('RELAY_')));
async function freePort() { const server=createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r));return port; }

test('config derives runtime paths and relay targets, validates overrides, and isolates credentials', async()=>{
 const f=await fixture();const file=path.join(f.root,'custom.json');
 try{
  await writeFile(file,JSON.stringify({workspaceRoot:'.',http:{host:'0.0.0.0',port:23456},auth:{tokenEnv:'TEST_CONFIG_TOKEN',token:'synthetic-file-value'},client:{url:'https://example.test/custom',tokenEnv:'CLIENT_TOKEN'}}));
  const loaded=loadConfig({file,env:{TEST_CONFIG_TOKEN:'synthetic-env-value'}});
  assert.equal(loaded.config.workspaceRoot,f.root);assert.equal(loaded.config.paths.terminals,path.join(f.root,'outputs/mcp-terminals'));
  assert.equal(loaded.config.relay.targetHost,'127.0.0.1');assert.equal(loaded.config.relay.targetPort,23456);
  assert.equal(loaded.healthOrigin,'http://127.0.0.1:23456');assert.equal(loaded.env.MCP_AUTH_TOKEN,'synthetic-env-value');assert(!JSON.stringify(loaded.config).includes('synthetic-'));
  assert.equal(pluginConnection(loaded.config).mcpServers['csy-workspace'].url,'https://example.test/custom');
  const override=loadConfig({file,env:{MCP_PORT:'23457',MCP_ENABLE_TERMINAL:'0',MCP_AUTH_TOKEN:'synthetic-explicit'}});
  assert.equal(override.config.http.port,23457);assert.equal(override.config.relay.targetPort,23457);assert(!override.config.tools.enableTerminal);assert.equal(override.env.MCP_AUTH_TOKEN,'synthetic-explicit');
  for(const env of [{MCP_PORT:'5679oops'},{MCP_ENABLE_TERMINAL:'false'},{MCP_TOOL_PROFILE:'invalid'}])assert.throws(()=>loadConfig({file,env}),/Invalid configuration|must be/);
  await writeFile(file,JSON.stringify({workspaceRoot:'.',http:{porrt:1234}}));assert.throws(()=>loadConfig({file,env:{}}),/porrt/);
  await mkdir(path.join(f.root,'work'));await symlink(f.root,path.join(f.root,'work','escape'));
  await writeFile(file,JSON.stringify({workspaceRoot:'work',paths:{jobs:'escape/jobs'}}));assert.throws(()=>loadConfig({file,env:{}}),/inside workspaceRoot/);
 }finally{await f.cleanup();}
});

test('plugin generation takes URL and token variable from one config',async()=>{
 const f=await fixture();const file=path.join(f.root,'custom.json'),plugin=path.join(f.root,'plugin');
 try{
  await mkdir(plugin);await writeFile(file,JSON.stringify({workspaceRoot:'.',auth:{token:'synthetic-private-value'},client:{url:'https://example.test:9443/remote-mcp',tokenEnv:'CUSTOM_CLIENT_TOKEN'}}));
  const args=[path.join(workspaceRoot,'mcp_server/scripts/config.mjs'),'sync-plugin','--config',file,'--plugin-dir',plugin];
  await exec(process.execPath,args,{env:freshEnv(f.env),cwd:f.root});
  for(const name of ['mcp.json','.mcp.json']){const text=await readFile(path.join(plugin,name),'utf8'),data=JSON.parse(text);assert.equal(data.mcpServers['csy-workspace'].url,'https://example.test:9443/remote-mcp');assert.equal(data.mcpServers['csy-workspace'].bearer_token_env_var,'CUSTOM_CLIENT_TOKEN');assert(!text.includes('synthetic-private-value'));}
 }finally{await f.cleanup();}
});

test('service and TCP relay use configured workspace, ports, route, authentication and compression', {timeout:30000},async()=>{
 const f=await fixture(),file=path.join(f.root,'custom.json');const httpPort=await freePort(),relayPort=await freePort();let relayStarted=false,started=false;
 const env=freshEnv(f.env),script=path.join(workspaceRoot,'mcp_server/scripts/service.py');
 const service=(action,component='server')=>exec('python3',['-B',script,action,'--config',file,'--component',component],{env,cwd:f.root,timeout:12000});
 try{
  await writeFile(file,JSON.stringify({workspaceRoot:'.',http:{port:httpPort,path:'/configured-mcp',compression:{enabled:false}},auth:{token:'synthetic-config-auth'},relay:{port:relayPort}}));
  const startup=await service('start');started=true;assert(JSON.parse(startup.stdout).running);
  assert(JSON.parse((await service('start','relay')).stdout).running);relayStarted=true;
  const base=`http://127.0.0.1:${relayPort}`;let health;
  for(let i=0;i<100;i++){try{health=await (await fetch(base+'/healthz')).json();break;}catch{await delay(30);}}
  assert.equal(health.workspace,f.root);assert.equal(health.configFile,file);assert.equal(health.compression.enabled,false);assert.equal(health.toolCount,2);
  const request={method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'config-test',version:'1'}}})};
  assert.equal((await fetch(base+'/configured-mcp',request)).status,401);
  request.headers.Authorization='Bearer synthetic-config-auth';const initialized=await fetch(base+'/configured-mcp',request);assert.equal(initialized.status,200);const session=initialized.headers.get('mcp-session-id');assert(session);
  request.headers['mcp-session-id']=session;request.body=JSON.stringify({jsonrpc:'2.0',id:2,method:'tools/list',params:{}});const list=await fetch(base+'/configured-mcp',request);assert.equal(list.status,200);assert.equal(list.headers.get('content-encoding'),null);assert.equal((await list.json()).result.tools.length,2);
  assert(JSON.parse((await service('status')).stdout).running);
  assert(JSON.parse((await service('restart')).stdout).running);
  assert(JSON.parse((await service('restart','relay')).stdout).running);
  assert.equal((await fetch(base+'/healthz')).status,200);
 }finally{
  if(relayStarted)await service('stop','relay');
  if(started)await service('stop');await f.cleanup();
 }
});

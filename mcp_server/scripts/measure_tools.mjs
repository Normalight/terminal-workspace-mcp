import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../src/tools.mjs';
const results=[];
for(const profile of ['minimal','legacy']){
 const server=new McpServer({name:'schema-measurement',version:'0.4.1'});
 registerTools(server,{workspace:{},executor:{},jobs:{},terminals:{},config:{toolProfile:profile},diagnostics:async()=>({})});
 const client=new Client({name:'schema-measurement',version:'1'});const [ct,st]=InMemoryTransport.createLinkedPair();await server.connect(st);await client.connect(ct);
 const tools=(await client.listTools()).tools;
 results.push({profile,toolCount:tools.length,jsonBytes:Buffer.byteLength(JSON.stringify(tools)),names:tools.map(x=>x.name)});
 await client.close();await server.close();
}
console.log(JSON.stringify({results,reductionPercent:100*(1-results[0].jsonBytes/results[1].jsonBytes),unit:'UTF-8 bytes of tools/list tool definitions; not model token counts'},null,2));

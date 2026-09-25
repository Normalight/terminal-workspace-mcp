import test from 'node:test';
import assert from 'node:assert/strict';
import { finished } from 'node:stream/promises';
import path from 'node:path';
import { LogWriter, readLog } from '../src/log-store.mjs';
import { fixture } from './helpers.mjs';

test('rotated logs retain monotonic cursors and report retention gaps',async()=>{
 const f=await fixture();try{const base=path.join(f.root,'stdout.log');const writer=new LogWriter(base,{segmentBytes:1024,maxSegments:2});writer.end(Buffer.from('x'.repeat(3100)));await finished(writer);
 const page=await readLog(base,{cursor:0,maxBytes:4096,segmentBytes:1024,final:true});assert.equal(page.earliestCursor,2048);assert.equal(page.droppedBytes,2048);assert.equal(page.nextCursor,3100);assert.equal(page.content.length,1052);
 }finally{await f.cleanup();}
});
test('an incomplete UTF-8 sequence waits for a later read',async()=>{
 const f=await fixture();try{const base=path.join(f.root,'stdout.log');const writer=new LogWriter(base);await new Promise((r,j)=>writer.write(Buffer.from([0xe4]),e=>e?j(e):r()));
 const first=await readLog(base,{cursor:0,maxBytes:4});assert.equal(first.nextCursor,0);assert.equal(first.content,'');
 writer.end(Buffer.from([0xb8,0xad]));await finished(writer);const next=await readLog(base,{cursor:0,maxBytes:4,final:true});assert.equal(next.content,'中');assert.equal(next.nextCursor,3);
 }finally{await f.cleanup();}
});

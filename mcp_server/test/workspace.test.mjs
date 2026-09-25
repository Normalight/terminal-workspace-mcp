import { readFile, writeFile, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Workspace } from "../src/workspace.mjs";
import { fixture } from "./helpers.mjs";

test('account paths, original content, and cycle-safe directory traversal', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.root,'default')); await writeFile(path.join(f.root,'.env'),'token=fixture-value\n');
    const w=await new Workspace(path.join(f.root,'default')).initialize();
    assert.equal((await w.readText('../.env')).content,'token=fixture-value\n');
    assert.equal((await w.readText(path.join(f.root,'.env'))).content,'token=fixture-value\n');
    await symlink(f.root,path.join(f.root,'default','loop'));
    const listed=await w.listDirectory('.',{recursive:true,includeHidden:true});assert(listed.entries.length<20);
  }finally{await f.cleanup();}
});
test('large text windows and binary chunks preserve data with resumable offsets',async()=>{
 const f=await fixture();try{
  const w=await new Workspace(f.root,{enableWrite:true}).initialize();
  const data=Buffer.from(('中文ab\n').repeat(500000));await writeFile(path.join(f.root,'large.txt'),data);
  const first=await w.readText('large.txt',{startLine:1,endLine:1});assert.equal(first.content,'中文ab\n');assert.equal(first.sha256Scope,'slice');
  let offset=0, parts=[];for(let i=0;i<5;i++){const p=await w.readChunk('large.txt',{offset,maxBytes:17,encoding:'utf8'});assert(!p.data.includes('\ufffd'));parts.push(p.data);offset=p.nextOffset;}
  assert.equal(parts.join(''),data.subarray(0,offset).toString('utf8'));
  const binary=Buffer.from([0,255,123,12]);const hash=createHash('sha256').update(binary).digest('hex');
  await w.writeChunk('new.bin',{data:binary.toString('base64'),mode:'create',sha256:hash});
  await assert.rejects(w.writeChunk('new.bin',{data:'YQ==',offset:0}),/resume offset/);
  await w.writeChunk('new.bin',{data:'YQ==',offset:4});assert.deepEqual(await readFile(path.join(f.root,'new.bin')),Buffer.concat([binary,Buffer.from('a')]));
  assert.equal((await w.fileInfo('new.bin',{checksum:true})).sha256,createHash('sha256').update(Buffer.concat([binary,Buffer.from('a')])).digest('hex'));
 }finally{await f.cleanup();}
});
test('serialized SHA edits reject one competing writer and dry-run is unchanged',async()=>{
 const f=await fixture();try{const w=await new Workspace(f.root,{enableWrite:true}).initialize();
 const initial=await w.writeText('edit.txt','before',{mode:'create'});
 const race=await Promise.allSettled([w.writeText('edit.txt','A',{expectedSha256:initial.sha256}),w.writeText('edit.txt','B',{expectedSha256:initial.sha256})]);
 assert.equal(race.filter(x=>x.status==='fulfilled').length,1);assert.equal(race.filter(x=>x.status==='rejected').length,1);
 const before=await readFile(path.join(f.root,'edit.txt'),'utf8');const preview=await w.replaceText('edit.txt',before,'preview',{dryRun:true});assert(preview.changed);assert.equal(await readFile(path.join(f.root,'edit.txt'),'utf8'),before);
 await assert.rejects(new Workspace(f.root).writeText('denied','x'),/disabled/);
 }finally{await f.cleanup();}
});
test('search budgets, cancellation and catastrophic regex run away from the service thread',async()=>{
 const f=await fixture();try{const w=await new Workspace(f.root).initialize();
 await writeFile(path.join(f.root,'a.txt'),'target'+ 'x'.repeat(100000));await writeFile(path.join(f.root,'regex.txt'),'a'.repeat(32)+'!');
 const found=await w.searchText('target',{maxBytes:2048});assert.equal(found.matches.length,1);assert(found.matches[0].lineTruncated);assert(JSON.stringify(found).length<2300);
 await assert.rejects(w.searchText('^(a+)+$',{relativePath:'regex.txt',regex:true,timeoutMs:100}),e=>e.code==='search_timeout');
 const controller=new AbortController();const promise=w.searchText('^(a+)+$',{relativePath:'regex.txt',regex:true,signal:controller.signal});setTimeout(()=>controller.abort(),30);await assert.rejects(promise,e=>e.code==='cancelled');
 assert.equal((await w.searchText('target',{maxResults:1})).matches.length,1);
 }finally{await f.cleanup();}
});

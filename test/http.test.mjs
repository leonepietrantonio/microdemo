import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('HTTP dashboard: CSRF, import more than three brands, process sequentially, and download final files',async t=>{
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const temp=await mkdtemp(path.join(os.tmpdir(),'microdemo-http-'));
  const briefPath=path.join(temp,'PEZZO_BRIEF.md');await writeFile(briefPath,await readFile(path.join(root,'PEZZO_BRIEF.md')));
  const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
  const child=spawn(process.execPath,['server.mjs','--simulate'],{cwd:root,env:{...process.env,PORT:String(port),MICRODEMO_DATA_DIR:temp,MICRODEMO_BRIEF_PATH:briefPath,MICRODEMO_CONFIG_PATH:path.join(root,'config.example.json')},stdio:['ignore','pipe','pipe']});
  let errors='';child.stderr.on('data',c=>errors+=c);
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');child.kill('SIGTERM');await closed.catch(()=>{});}await rm(temp,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;
  let state;
  for(let i=0;i<100;i++){try{state=await fetch(base+'/api/state').then(r=>r.json());break;}catch{await new Promise(r=>setTimeout(r,30));}}
  assert.ok(state,errors||'HTTP server failed to start');assert.equal(state.simulate,true);
  assert.equal((await fetch(base+'/')).status,200);
  assert.match(await fetch(base+'/sample.csv').then(r=>r.text()),/^brand_name,instagram_url,website_url/);
  assert.equal((await fetch(base+'/api/check',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  const post=async(route,data={},extra={})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf,...extra},body:JSON.stringify(data)});
  const originalBrief=await fetch(base+'/api/brief').then(r=>r.json());assert.match(originalBrief.content,/Pezzo/);
  const changedBrief=originalBrief.content+'\nHTTP test direction: a narrative built around the brand.\n';
  assert.equal((await post('/api/brief',{content:changedBrief,expectedHash:originalBrief.hash})).status,200);
  assert.equal((await post('/api/brief',{content:'stale overwrite',expectedHash:originalBrief.hash})).status,409);
  assert.equal((await fetch(base+'/api/brief').then(r=>r.json())).content,changedBrief);
  assert.equal((await post('/api/check',{}, {Origin:'https://other.example'})).status,403);
  assert.equal((await post('/api/access',{action:'enable'})).status,400);
  assert.equal((await post('/api/access',{action:'enable',consent:'persistent-edit-generate'})).status,202);
  for(let i=0;i<100;i++){state=await fetch(base+'/api/state').then(r=>r.json());if(!state.busy)break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(state.permissionSetup.status,'ready');assert.equal(state.preflight.status,'ready');assert.equal(state.batches.length,0);
  await post('/api/check');
  const csv='brand_name,instagram_url,website_url\nAlpha,https://instagram.com/alpha,https://alpha.com\nBeta,https://instagram.com/beta,https://beta.com\nGamma,https://instagram.com/gamma,https://gamma.com\nDelta,https://instagram.com/delta,https://delta.com\nEpsilon,https://instagram.com/epsilon,https://epsilon.com\n';
  const validation=await post('/api/validate',{csv}).then(r=>r.json());assert.equal(validation.brands.length,5);
  const batch=await post('/api/batches',{csv,maxCredits:450}).then(r=>r.json());assert.ok(batch.id);
  assert.equal((await post('/api/run',{id:batch.id})).status,202);
  for(let i=0;i<150;i++){state=await fetch(base+'/api/state').then(r=>r.json());if(!state.busy&&state.batches[0].status!=='queued')break;await new Promise(r=>setTimeout(r,30));}
  const done=state.batches[0];assert.equal(done.status,'complete');assert.equal(done.brands.length,5);
  const brand=done.brands[0], output=brand.result.outputs[0];
  const image=await fetch(base+`/files/${done.id}/brands/${brand.id}/${output.relativePath}?download=1`);
  assert.equal(image.status,200);assert.match(image.headers.get('content-disposition'),/attachment/);assert.match(await image.text(),/SIMULATION/);
  assert.equal((await fetch(base+`/files/${done.id}/brands/${brand.id}/.schema.json`)).status,400);
  const report=await fetch(base+`/files/${done.id}/batch-report.csv?download=1`).then(r=>r.text());assert.match(report,/Alpha/);
});

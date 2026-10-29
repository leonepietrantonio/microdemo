import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,writeFile,rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Engine,verifyOutputs } from '../lib/engine.mjs';
import { readBrief,saveBrief,STYLE,OUTPUT,verifyImageFormat,textHash,composeScenePrompt } from '../lib/creative.mjs';
import { verifyPreparation,verifyNativeExecutions } from '../lib/preparation.mjs';
import { phasePrompt } from '../lib/prompts.mjs';

async function fixture(t){
  const root=await mkdtemp(path.join(os.tmpdir(),'pezzo-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const briefPath=path.join(root,'PEZZO_BRIEF.md');await writeFile(briefPath,'# Pezzo\nMinimum supporting objects: 3\nVersion one: sculptural objects in a specific brand world.');
  const config={maxBrands:3,defaultProducts:1,defaultStyle:STYLE.name,defaultStyleId:STYLE.id,defaultAspectRatio:OUTPUT.aspectRatio,defaultResolution:OUTPUT.resolution,defaultShootType:'still_life',workspaceName:'Microdemo',workspaceId:'team',productWorkspaceId:'team'};
  const engine=new Engine(path.join(root,'data'),config,{simulate:true,briefPath});await engine.init();
  const b=await engine.create('brand_name,instagram_url,website_url\nAlpha,https://instagram.com/alpha,https://alpha.com\nBeta,https://instagram.com/beta,https://beta.com\n',270);
  return {root,briefPath,config,engine,b};
}

test('brief edits affect the next preparation, while an already prepared set keeps its exact snapshot',async t=>{
  const {briefPath,engine,b}=await fixture(t);const [alpha,beta]=b.brands;
  await engine.invoke('prepare',b,alpha);assert.equal(alpha.status,'ready');
  const originalHash=alpha.creativeProfile.pezzoBriefHash;
  await saveBrief(briefPath,'# Pezzo\nMinimum supporting objects: 4\nVersion two: crafted objects, depth and material counterpoint.',originalHash);
  await engine.invoke('prepare',b,beta);assert.equal(beta.status,'ready');assert.notEqual(beta.creativeProfile.pezzoBriefHash,originalHash);
  assert.equal(alpha.creativeProfile.minSupportingObjects,3);assert.equal(beta.creativeProfile.minSupportingObjects,4);
  assert.match(await readFile(path.join(engine.dir(b,alpha),'pezzo-brief.md'),'utf8'),/Version one/);
  await verifyPreparation(engine.dir(b,alpha),alpha.input,alpha.result.projectId,verifyOutputs,true,'team',alpha.creativeProfile);
  const prompt=phasePrompt('prepare',b,beta,engine.config);assert.match(prompt,/Version two/);assert.match(prompt,/BOTH briefs/);assert.match(prompt,/brand-analysis\.md/);
});

test('manual Markdown edits are picked up and stale browser saves cannot overwrite them',async t=>{
  const {briefPath}=await fixture(t);const first=await readBrief(briefPath);
  await writeFile(briefPath,'# Pezzo\nMinimum supporting objects: 2\nA manually edited direction.');
  const manual=await readBrief(briefPath);assert.equal(manual.minSupportingObjects,2);assert.notEqual(manual.hash,first.hash);
  await assert.rejects(()=>saveBrief(briefPath,'Overwrite',first.hash),e=>e.statusCode===409);
  assert.match((await readBrief(briefPath)).content,/manually edited/);
});

test('native ownership uses matching server evidence without needing local flags and rejects real mismatches',async t=>{
  const {engine,b}=await fixture(t),brand=b.brands[0];await engine.invoke('prepare',b,brand);
  const dir=engine.dir(b,brand),file=path.join(dir,'manifest.json'),original=JSON.parse(await readFile(file,'utf8'));
  const check=()=>verifyPreparation(dir,brand.input,brand.result.projectId,verifyOutputs,true,'team',brand.creativeProfile);
  const noFlags=structuredClone(original);delete noFlags.workspaceVerified;for(const p of noFlags.products)delete p.workspaceVerified;
  await writeFile(file,JSON.stringify(noFlags));await check();
  const missing=structuredClone(original);delete missing.projectWorkspaceEvidence;await writeFile(file,JSON.stringify(missing));await assert.rejects(check,/Missing server ownership evidence/);
  const wrongProject=structuredClone(original);wrongProject.projectWorkspaceEvidence.workspaceId='another-workspace';await writeFile(file,JSON.stringify(wrongProject));await assert.rejects(check,/project ownership response/);
  const wrongProduct=structuredClone(original);wrongProduct.products[0].creationResponse.workspaceId='personal';await writeFile(file,JSON.stringify(wrongProduct));await assert.rejects(check,/ownership in the target workspace/);
  const wrongIdentity=structuredClone(original);wrongIdentity.projectWorkspaceEvidence.id='another-project';await writeFile(file,JSON.stringify(wrongIdentity));await assert.rejects(check,/Missing server ownership evidence/);
});

test('restart recovers a ready checkpoint rejected only by the old workspace flag check without rerunning preparation',async t=>{
  const {engine,b,config,briefPath}=await fixture(t),brand=b.brands[0];await engine.invoke('prepare',b,brand);
  brand.phase='prepare';brand.status='needs_attention';brand.message='The native project and all selected products must belong to the same verified workspace.';b.status='paused';
  const file=path.join(engine.dir(b,brand),'manifest.json'),m=JSON.parse(await readFile(file,'utf8'));delete m.workspaceVerified;await writeFile(file,JSON.stringify(m));await engine.save(b);
  const restored=new Engine(engine.root,config,{simulate:true,briefPath});await restored.init();const recovered=restored.batches[0].brands[0];
  assert.equal(recovered.phase,'generate');assert.equal(recovered.status,'ready');assert.equal(recovered.attempts,brand.attempts);assert.equal(recovered.result.projectId,brand.result.projectId);assert.equal(restored.batches[0].status,'paused');
});

test('new creative graphs reject wrong format, wrong style, disconnected text, sparse scenes and wrong brief versions',async t=>{
  const {engine,b}=await fixture(t),brand=b.brands[0];await engine.invoke('prepare',b,brand);
  const dir=engine.dir(b,brand),file=path.join(dir,'manifest.json');const original=JSON.parse(await readFile(file,'utf8'));
  const check=()=>verifyPreparation(dir,brand.input,brand.result.projectId,verifyOutputs,true,'team',brand.creativeProfile);
  async function reject(patch,pattern){const m=structuredClone(original);patch(m);await writeFile(file,JSON.stringify(m));await assert.rejects(check,pattern);}
  await reject(m=>m.canvasSnapshot.nodes.find(n=>n.type==='generator').data.aspectRatio='1:1',/3:4/);
  await reject(m=>m.canvasSnapshot.nodes.find(n=>n.type==='generator').data.resolution='1K',/2K/);
  await reject(m=>m.canvasSnapshot.nodes.find(n=>n.type==='style').data.customStyleId='old-line-gobo',/No Back/);
  await reject(m=>m.canvasSnapshot.nodes.find(n=>n.type==='text').data.text='Different prompt',/text actually connected/);
  await reject(m=>m.shots[0].sceneObjects=[],/purposeful supporting objects/);
  await reject(m=>m.shots[0].pezzoBriefHash='wrong',/both its Pezzo and brand/);
  await reject(m=>{m.shots[0].brief+=' Copied style recipe';m.canvasSnapshot.nodes.find(n=>n.type==='text').data.text=m.shots[0].brief;},/scene direction only/);
  await reject(m=>m.products[0].workspaceId='personal',/ownership in the target workspace/);
  await reject(m=>m.workspaceId='other-workspace',/same verified workspace/);
  await reject(m=>m.shots[0].template.workflowId='hand-built',/matching native Rainfrog template/);
  await reject(m=>m.shots[0].template.receipt={isError:true,error:'INVALID_NODE_PATCH'},/instantiation failed/);
  await reject(m=>m.shots[0].quote={isError:true,error:'EXECUTION_UNSUPPORTED'},/successful matching preview/);
  await writeFile(file,JSON.stringify(original));await check();
});

test('scene text stays separate from the native style and legacy text injection is rejected',async t=>{
  const {engine,b}=await fixture(t),brand=b.brands[0];await engine.invoke('prepare',b,brand);
  const m=JSON.parse(await readFile(path.join(engine.dir(b,brand),'manifest.json'),'utf8')),shot=m.shots[0];
  assert.equal(shot.brief,shot.sceneBrief);assert.equal(brand.creativeProfile.styleDelivery,'wired-native');
  assert.equal(brand.creativeProfile.stylePrompt,undefined);
  assert.equal(m.canvasSnapshot.nodes.find(n=>n.type==='text').data.text,shot.sceneBrief);
  assert.throws(()=>composeScenePrompt('Scene',{styleDelivery:'explicit-user-text'}),/Reprepare/);
});

test('native Fashion Shooting preserves the upstream full-body product path',async t=>{
  const {engine,b}=await fixture(t),brand=b.brands[0];brand.input.shoot_type='fashion';await engine.invoke('prepare',b,brand);
  const dir=engine.dir(b,brand),file=path.join(dir,'manifest.json'),m=JSON.parse(await readFile(file,'utf8')),shot=m.shots[0],graph=m.canvasSnapshot;
  const productEdge=graph.edges.find(e=>e.toNode===shot.nodeId&&e.toHandle==='products');
  const helperId='native-full-body';graph.nodes.push({id:helperId,type:'fullBody',data:{}});
  productEdge.toNode=helperId;
  graph.edges.push({fromNode:helperId,fromHandle:'front',toNode:shot.nodeId,toHandle:'character'});
  shot.template.nodeIds.push(helperId);shot.template.receipt.touchedNodeIds.push(helperId);
  await writeFile(file,JSON.stringify(m));await verifyPreparation(dir,brand.input,brand.result.projectId,verifyOutputs,true,'team',brand.creativeProfile);
  graph.nodes.find(n=>n.type==='product').data.productId='another-product';await writeFile(file,JSON.stringify(m));
  await assert.rejects(()=>verifyPreparation(dir,brand.input,brand.result.projectId,verifyOutputs,true,'team',brand.creativeProfile),/hero product/);
});

test('native generation is verified against the exact wired generator and cannot be replaced by a detached API call',async t=>{
  const {engine,b}=await fixture(t),brand=b.brands[0];await engine.invoke('prepare',b,brand);await engine.invoke('generate',b,brand);
  assert.equal(brand.status,'running');
  const dir=engine.dir(b,brand),file=path.join(dir,'manifest.json'),original=JSON.parse(await readFile(file,'utf8'));
  const check=()=>verifyNativeExecutions(dir,brand.result.projectId,brand.creativeProfile,'running');await check();
  const canonicalOnly=structuredClone(original);for(const shot of canonicalOnly.shots)delete shot.idempotencyKey;
  await writeFile(file,JSON.stringify(canonicalOnly));await check();
  const wrapped=structuredClone(canonicalOnly);for(const shot of wrapped.shots){shot.triggerResponse={structuredContent:shot.triggerResponse};shot.execution={structuredContent:shot.execution};}
  await writeFile(file,JSON.stringify(wrapped));await check();
  for(const mutate of [m=>m.shots[0].idempotencyKey='conflicting-copy',m=>delete m.shots[0].triggerRequest.idempotencyKey,m=>m.shots[0].execution.nodeId='other-node',m=>m.shots[0].execution.projectId='other-project',m=>m.shots[0].triggerRequest.tool='generate_image',m=>m.shots[0].triggerRequest.planHash='other-plan']){
    const changed=structuredClone(original);mutate(changed);await writeFile(file,JSON.stringify(changed));await assert.rejects(check,/exact wired native generator/);
  }
});

function pngHeader(width,height){const b=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(b);b.writeUInt32BE(width,16);b.writeUInt32BE(height,20);return b;}
test('restart recovers verified generated images into export without replaying generation',async t=>{
  const {engine,b,config,briefPath}=await fixture(t),brand=b.brands[0];await engine.invoke('prepare',b,brand);await engine.invoke('generate',b,brand);
  const file=path.join(engine.dir(b,brand),'manifest.json'),manifest=JSON.parse(await readFile(file,'utf8'));
  for(const shot of manifest.shots)delete shot.idempotencyKey;
  await writeFile(file,JSON.stringify(manifest));brand.phase='generate';brand.status='needs_attention';brand.message='Generation must be an execution of the exact wired native generator node, verified by its trigger request and execution metadata.';b.status='paused';await engine.save(b);
  const recovered=new Engine(engine.root,config,{simulate:true,briefPath,worker:async()=>{throw Error('Recovery must not call a worker');}});await recovered.init();
  const saved=recovered.batches[0].brands[0];assert.equal(saved.phase,'export');assert.equal(saved.status,'running');assert.equal(saved.result.spentCredits,brand.result.spentCredits);assert.equal(saved.result.projectId,brand.result.projectId);assert.equal(recovered.batches[0].status,'paused');
});
test('export verifies actual 3:4 and 2K dimensions and never accepts a square or upscaled-placeholder requirement',()=>{
  assert.deepEqual(verifyImageFormat(pngHeader(1536,2048),OUTPUT),{width:1536,height:2048});
  assert.throws(()=>verifyImageFormat(pngHeader(2048,2048),OUTPUT),/expected 3:4/);
  assert.throws(()=>verifyImageFormat(pngHeader(768,1024),OUTPUT),/below the requested 2K/);
});

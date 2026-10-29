import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, readFile, symlink, rm, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseCSV, validateBrands } from '../lib/csv.mjs';
import { Engine, verifyOutputs } from '../lib/engine.mjs';
import { normalizeResult, runCodex, hydrateApprovalIds, approvalIdFromURL } from '../lib/runner.mjs';
import { verifyPreparation } from '../lib/preparation.mjs';
import { createHash } from 'node:crypto';
const config={maxBrands:3,defaultProducts:3,defaultStyle:'Line Gobo',defaultShootType:'still_life',workspaceName:'Microdemo',workspaceId:'test-workspace',stepTimeoutMinutes:1};
const csv='brand_name,instagram_url,website_url\nAlpha,https://instagram.com/alpha,https://alpha.com/\nBeta,https://instagram.com/beta,https://beta.com/\nGamma,https://instagram.com/gamma,https://gamma.com/\n';
const result=(overrides={})=>({status:'ready',summary:'Prepared',projectId:'project-1',projectUrl:null,plannedCredits:90,spentCredits:0,approvals:[],outputs:[],warnings:[],...overrides});
async function seedPreparation(dir,projectId='project-1',count=3,mode='still_life',galleryCount=1) {
  await mkdir(dir,{recursive:true});
  const products=[],shots=[],nodes=[];
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=','base64');
  for(let i=0;i<count;i++) {
    const productId=`p${i}`,images=[];
    for(let j=0;j<Math.min(6,galleryCount);j++) {
      const localFile=`p${i}-${j}.png`,bytes=Buffer.concat([png,Buffer.from(`view-${i}-${j}`)]);
      await writeFile(path.join(dir,localFile),bytes);images.push({sourceUrl:`https://brand.com/${localFile}`,localFile,sha256:createHash('sha256').update(bytes).digest('hex')});
    }
    products.push({productId,name:`Product ${i}`,workspaceId:'test-workspace',workspaceVerified:true,availableImageCount:galleryCount,uploadedImageCount:images.length,images});
    for(const kind of mode==='both'?['still_life','fashion']:[mode]) {
      const nodeId=`g${i}-${kind}`;shots.push({nodeId,kind,productId});nodes.push({id:nodeId,type:'generator',data:{preset:kind==='fashion'?'fashion-shooting':'product-still-life'}});
    }
  }
  const manifest={projectId,products,shots,canvasSnapshot:{nodes}};
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest));return manifest;
}
async function fixture(t,options={}){const root=await mkdtemp(path.join(os.tmpdir(),'microdemo-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  if(options.worker){const worker=options.worker;options={...options,worker:async args=>{const r=await worker(args);if(args.prompt.includes('current phase is prepare')&&r.status==='ready')await seedPreparation(args.cwd,r.projectId);return r;}};}
  const engine=new Engine(root,config,options);await engine.init();return engine;}
test('CSV supports BOM, CRLF, quoted commas, embedded newlines and escaped quotes',()=>{
  assert.deepEqual(parseCSV('\ufeffname,note\r\n"Brand, Inc","A ""quote""\nand line"\r\n'),[['name','note'],['Brand, Inc','A "quote"\nand line']]);
  assert.throws(()=>parseCSV('a,b\n"unterminated,x'),/not closed/);
  assert.throws(()=>parseCSV('a,b\n"quoted"junk,x'),/Unexpected text/);
});
test('CSV validation accepts all rows without a three-brand limit',()=>{
  const rows=validateBrands(csv,config);assert.equal(rows.length,3);assert.equal(rows[0].product_count,3);assert.equal(rows[0].style,'Line Gobo');
  assert.equal(validateBrands(csv+'Delta,https://instagram.com/delta,https://delta.com/\n',config).length,4);
  const large='brand_name,instagram_url,website_url\n'+Array.from({length:1000},(_,i)=>`Brand ${i},https://instagram.com/brand${i},https://brand${i}.com`).join('\n');assert.equal(validateBrands(large,config).length,1000);
  assert.throws(()=>validateBrands('brand_name,instagram_url,website_url\n,,,,\n',config),/Add at least/);
  assert.throws(()=>validateBrands(csv.replace('Beta,','Alpha,'),config),/Duplicate/);
});

test('unattended runs stop before any setup when Generate remains Ask despite Edit being allowed',async t=>{
  let calls=0;const permissions={studioEnabled:true,actions:{read:'allow',add:'allow',edit:'allow',generate:'ask'}};
  const engine=await fixture(t,{worker:async()=>{calls++;return result();}});
  engine.config={...engine.config,approvalMode:'standing-grants'};engine.preflight={status:'ready'};engine.rainfrogPermissions=permissions;
  const batch=await engine.create(csv,270);await assert.rejects(()=>engine.run(batch.id),/Persistent Rainfrog Generate/);
  assert.equal(calls,0);assert.equal(batch.status,'needs_attention');assert.ok(batch.brands.every(b=>b.attempts===0));
});

test('Approve once cannot be mistaken for persistent Edit access or trigger repeated setup requests',async t=>{
  let checks=0;const permissions={studioEnabled:true,actions:{read:'allow',add:'allow',edit:'ask',generate:'ask'}};
  const engine=await fixture(t,{worker:async({prompt})=>{assert.ok(!prompt.includes('current phase is prepare'));checks++;return result({rainfrogPermissions:permissions});}});
  engine.config={...engine.config,approvalMode:'standing-grants'};const batch=await engine.create(csv,270);
  batch.brands[0].status='awaiting_approval';batch.brands[0].result=result({status:'awaiting_approval',approvals:[{id:'approved-once',url:'https://app.rainfrog.ai/agent/approve/approved-once?nonce=example',nodeId:'node'}]});
  await assert.rejects(()=>engine.approved(batch.id),/Persistent Rainfrog Edit/);assert.equal(checks,1);assert.ok(batch.brands.every(b=>b.attempts===0));
});

test('pre-batch permission setup rejects a claimed success when real capabilities remain Ask',async t=>{
  let calls=0;const engine=await fixture(t,{worker:async({prompt})=>{calls++;assert.match(prompt,/current phase is permissions/);return result({summary:'No permission request tool is exposed.',projectId:null,plannedCredits:0,rainfrogPermissions:{studioEnabled:true,actions:{read:'allow',add:'allow',edit:'ask',generate:'ask'}}});}});
  await engine.enablePermissions();assert.equal(calls,1);assert.equal(engine.permissionSetup.status,'blocked');assert.equal(engine.batches.length,0);assert.equal(engine.busy,false);
});

test('verified persistent grants unlock permission setup but never start a queued batch',async t=>{
  const permissions={studioEnabled:true,actions:{read:'allow',add:'allow',edit:'allow',generate:'allow',delete:'ask'}};
  const engine=await fixture(t,{worker:async()=>result({projectId:null,plannedCredits:0,rainfrogPermissions:permissions})});
  const batch=await engine.create(csv,270);await engine.enablePermissions();
  assert.equal(engine.permissionSetup.status,'ready');assert.equal(batch.status,'queued');assert.ok(batch.brands.every(b=>b.attempts===0));assert.equal(engine.rainfrogPermissions.actions.delete,'ask');
});

test('failed permission setup clears stale grants and cannot unlock batch start',async t=>{
  const engine=await fixture(t,{worker:async()=>{throw Error('Connection failed');}});
  engine.rainfrogPermissions={studioEnabled:true,actions:{read:'allow',add:'allow',edit:'allow',generate:'allow'}};
  await engine.enablePermissions();assert.equal(engine.rainfrogPermissions,null);assert.equal(engine.permissionSetup.status,'blocked');assert.equal(engine.busy,false);
});

test('one access action verifies connection after grants and exposes the final outcome',async t=>{
  const stages=[],permissions={studioEnabled:true,actions:{read:'allow',add:'allow',edit:'allow',generate:'allow'}};
  const engine=await fixture(t,{worker:async({prompt})=>{stages.push(prompt.includes('current phase is permissions')?'permissions':'connection');return result({projectId:null,plannedCredits:0,rainfrogPermissions:permissions});}});
  await engine.enablePermissions();assert.deepEqual(stages,['permissions','connection']);assert.equal(engine.preflight.status,'ready');assert.equal(engine.permissionSetup.status,'ready');
  engine.worker=async()=>{throw Error('Network unavailable');};await engine.check();assert.equal(engine.permissionSetup.status,'blocked');assert.equal(engine.rainfrogPermissions,null);assert.match(engine.permissionSetup.summary,/Network unavailable/);assert.equal(engine.busy,false);
});

test('standing Edit and Generate grants allow the entire three-brand run without per-operation approvals',async t=>{
  const phases=[],permissions={studioEnabled:true,actions:{read:'allow',add:'allow',edit:'allow',generate:'allow'}};
  const engine=await fixture(t,{worker:async({prompt})=>{
    const phase=prompt.match(/current phase is (\w+)/)[1];phases.push(phase);
    return result({rainfrogPermissions:permissions,...(phase==='generate'?{status:'running',spentCredits:90}:phase==='export'?{status:'complete',spentCredits:90,outputs:[0,1,2].map(i=>({relativePath:`p${i}-0.png`,label:`Product ${i}`}))}:{})});
  }});
  engine.config={...engine.config,approvalMode:'standing-grants'};engine.preflight={status:'ready'};engine.rainfrogPermissions=permissions;
  const batch=await engine.create(csv,270);await engine.run(batch.id);
  assert.equal(batch.status,'complete');assert.equal(phases.length,9);assert.equal(batch.brands.reduce((n,b)=>n+b.result.spentCredits,0),270);assert.ok(batch.brands.every(b=>b.result.approvals.length===0));
});

test('verified standing Edit grant retires stale local approvals without bypassing the server',async t=>{
  let calls=0;const engine=await fixture(t,{worker:async()=>{calls++;return result({status:'needs_attention',summary:'Reconciled existing request; test stops before changes.'});}});
  engine.config={...engine.config,approvalMode:'standing-grants'};engine.preflight={status:'ready'};engine.rainfrogPermissions={studioEnabled:true,actions:{read:'allow',add:'allow',edit:'allow',generate:'allow'}};
  const batch=await engine.create(csv.split('\n').slice(0,2).join('\n'),270),brand=batch.brands[0];
  brand.approvalRenewalBlocked=true;brand.approvalRefreshNeeded=true;brand.result=result({status:'awaiting_approval',approvals:[{id:'old',url:'https://app.rainfrog.ai/agent/approve/old?nonce=old',nodeId:'node'}]});
  await engine.run(batch.id);assert.equal(calls,1);assert.equal(brand.approvalRenewalBlocked,false);assert.equal(brand.approvalRefreshNeeded,false);assert.equal(brand.retiredApprovals[0].id,'old');
});

test('unattended execution cannot start with a denied server permission',async t=>{
  const engine=await fixture(t,{simulate:false,worker:async()=>{throw Error('Must never run');}});engine.config={...engine.config,approvalMode:'standing-grants'};engine.preflight={status:'ready'};engine.rainfrogPermissions={studioEnabled:true,actions:{read:'allow',add:'allow',edit:'deny',generate:'allow'}};
  const batch=await engine.create(csv,270);await assert.rejects(()=>engine.run(batch.id),/denied/);assert.equal(engine.busy,false);
});

test('closing a batch preserves its work, prevents resume, and permits another batch',async t=>{
  const engine=await fixture(t,{simulate:true});const batch=await engine.create(csv,270);
  batch.status='awaiting_approval';batch.resumeAfterApproval=true;batch.brands[0].result=result({projectId:'preserved-project'});
  await engine.close(batch.id);assert.equal(batch.status,'closed');assert.equal(batch.resumeAfterApproval,false);
  assert.equal(batch.brands[0].result.projectId,'preserved-project');
  await assert.rejects(()=>engine.resume(batch.id),/closed/);await assert.rejects(()=>engine.approved(batch.id),/closed/);
  engine.preflight={status:'ready'};await assert.rejects(()=>engine.run(batch.id),/closed/);
  const next=await engine.create(csv,270);assert.equal(next.status,'queued');assert.notEqual(next.id,batch.id);
});

test('preparation pauses at its first canvas approval rather than aging links while other brands run',async t=>{
  let calls=0;
  const engine=await fixture(t,{worker:async()=>{calls++;return result({status:'awaiting_approval',approvals:[{id:'setup',url:'https://app.rainfrog.ai/agent/approve/setup?nonce=example',nodeId:'generator'}]});}});
  engine.preflight={status:'ready'};const batch=await engine.create(csv,270);await engine.run(batch.id);
  assert.equal(calls,1);assert.equal(batch.status,'awaiting_approval');assert.equal(batch.brands[1].attempts,0);
  assert.equal(batch.brands[0].result.approvals[0].kind,'canvas_edit');assert.equal(batch.brands[0].phase,'prepare');
});

test('expired setup approval refresh is isolated to one brand and preserves project, products and costs',async t=>{
  let receivedPrompt;
  const engine=await fixture(t,{worker:async({prompt})=>{receivedPrompt=prompt;return result({status:'awaiting_approval',approvals:[{id:'fresh',url:'https://app.rainfrog.ai/agent/approve/fresh?nonce=new',nodeId:'native-node'}]});}});
  const batch=await engine.create(csv,270),brand=batch.brands[0];brand.status='awaiting_approval';brand.result=result({status:'awaiting_approval',approvals:[{id:'expired',url:'https://app.rainfrog.ai/agent/approve/expired?nonce=old',nodeId:'native-node'}]});
  await engine.refreshApproval(batch.id,brand.id);
  assert.match(receivedPrompt,/current phase is refresh_approval/);assert.match(receivedPrompt,/NO stale approvalId/);
  assert.equal(brand.result.approvals[0].id,'fresh');assert.equal(brand.result.approvals[0].kind,'canvas_edit');
  assert.equal(brand.result.projectId,'project-1');assert.equal(brand.result.plannedCredits,90);assert.equal(brand.result.spentCredits,0);
  assert.equal(brand.phase,'prepare');assert.equal(batch.brands[1].attempts,0);assert.equal(engine.busy,false);
});

test('a cached expired approval is rejected rather than advertised as a fresh link',async t=>{
  const approval={id:'expired',url:'https://app.rainfrog.ai/agent/approve/expired?nonce=old',nodeId:'native-node'};
  const engine=await fixture(t,{worker:async()=>result({status:'awaiting_approval',approvals:[approval]})});
  const batch=await engine.create(csv,270),brand=batch.brands[0];brand.status='awaiting_approval';brand.result=result({status:'awaiting_approval',approvals:[approval]});
  await engine.refreshApproval(batch.id,brand.id);assert.match(brand.message,/previous approval/);assert.equal(brand.result.approvals[0].id,'expired');assert.equal(engine.busy,false);assert.equal(brand.approvalRenewalBlocked,true);
});

test('renewing a nonce on the same approval ID is accepted without assuming the ID must change',async t=>{
  const old={id:'same-id',url:'https://app.rainfrog.ai/agent/approve/same-id?nonce=old',nodeId:'native-node'},renewed={...old,url:'https://app.rainfrog.ai/agent/approve/same-id?nonce=rotated'};
  const engine=await fixture(t,{worker:async()=>result({status:'awaiting_approval',approvals:[renewed]})});
  const batch=await engine.create(csv,270),brand=batch.brands[0];brand.status='awaiting_approval';brand.result=result({status:'awaiting_approval',approvals:[old]});
  await engine.refreshApproval(batch.id,brand.id);assert.equal(brand.result.approvals[0].url,renewed.url);assert.equal(brand.approvalRenewalBlocked,false);
});

test('server-side expired approval reuse blocks Resume instead of retrying indefinitely',async t=>{
  let calls=0;const engine=await fixture(t,{worker:async()=>{calls++;return result({status:'needs_attention',summary:'Server returned the same expired approval credential',approvals:[]});}});
  const batch=await engine.create(csv,270),brand=batch.brands[0];brand.status='awaiting_approval';brand.result=result({status:'awaiting_approval'});
  await engine.refreshApproval(batch.id,brand.id);assert.equal(brand.approvalRenewalBlocked,true);assert.equal(batch.status,'needs_attention');
  engine.preflight={status:'ready'};await engine.run(batch.id);assert.equal(calls,1);assert.match(batch.message,/MCP server/);
});

test('approval refresh checks saved credential history even when the prior result has no links',async t=>{
  const old={id:'expired',url:'https://app.rainfrog.ai/agent/approve/expired?nonce=old',nodeId:'native-node'};
  const engine=await fixture(t,{worker:async()=>result({status:'awaiting_approval',approvals:[old]})});
  const batch=await engine.create(csv,270),brand=batch.brands[0];brand.status='needs_attention';brand.approvalRenewalBlocked=true;brand.result=result({status:'needs_attention',approvals:[]});
  await writeFile(path.join(engine.dir(batch,brand),'manifest.json'),JSON.stringify({approvalHistory:[{approvalUrl:old.url}]}));
  await engine.refreshApproval(batch.id,brand.id);assert.equal(brand.approvalRenewalBlocked,true);assert.match(brand.message,/previous approval/);
});

test('a reported expired setup link pauses without replaying the old approval request',async t=>{
  let calls=0;const engine=await fixture(t,{worker:async()=>{calls++;return result();}});
  engine.preflight={status:'ready'};const batch=await engine.create(csv,270);batch.brands[0].approvalRefreshNeeded=true;
  batch.brands[0].status='awaiting_approval';await engine.run(batch.id);
  assert.equal(calls,0);assert.equal(batch.status,'awaiting_approval');assert.match(batch.message,/Refresh the expired/);
});

test('a native MCP template failure stops the batch before other brands or any paid generation',async t=>{
  let calls=0;
  const engine=await fixture(t,{worker:async()=>{calls++;return result({status:'needs_attention',summary:'INVALID_NODE_PATCH: Field is not editable on generator',projectId:null,plannedCredits:0});}});
  engine.preflight={status:'ready'};const batch=await engine.create(csv,270);await engine.run(batch.id);
  assert.equal(calls,1);assert.equal(batch.status,'needs_attention');assert.equal(batch.brands[1].attempts,0);
  assert.match(batch.message,/native-template integration/);assert.equal(batch.brands.reduce((n,b)=>n+(b.result?.spentCredits||0),0),0);
});
test('rejects local URLs, placeholders and invalid CSV modes',()=>{
  for(const url of ['http://alpha.com','https://localhost','https://127.0.0.1','https://10.0.0.1','https://brand.example','https://u:p@alpha.com','https://alpha.local']) assert.throws(()=>validateBrands(csv.replace('https://alpha.com/',url),config));
  assert.throws(()=>validateBrands(csv.replace('brand_name,','brand_name,shoot_type,').replace(/Alpha,/,'Alpha,video,').replace(/Beta,/,'Beta,video,').replace(/Gamma,/,'Gamma,video,'),config),/shoot_type/);
});
test('simulation processes all three brands, persists files, and resumes without duplicates',async t=>{
  const e=await fixture(t,{simulate:true});await e.check();const b=await e.create(csv,270);await e.run(b.id);
  assert.equal(b.status,'complete');assert.equal(b.brands.reduce((n,v)=>n+v.result.outputs.length,0),9);
  const attempts=b.brands.map(v=>v.attempts);await e.resume(b.id);assert.deepEqual(b.brands.map(v=>v.attempts),attempts);
  const e2=new Engine(e.root,config,{simulate:true});await e2.init();assert.equal(e2.batches[0].status,'complete');
  assert.match(await readFile(path.join(e.dir(b),'batch-report.csv'),'utf8'),/Alpha/);
});
test('each brand finishes downloads before the next CSV row starts, including a pending export',async t=>{
  const e=await fixture(t,{simulate:true}),calls=[];const fake=e.fake.bind(e);let pending=true;
  e.fake=async(phase,batch,brand)=>{calls.push(brand.input.brand_name+':'+phase);if(phase==='export'&&brand.input.brand_name==='Alpha'&&pending){pending=false;return {...brand.result,status:'running',summary:'Download not ready yet',outputs:[]};}return fake(phase,batch,brand);};
  await e.check();const batch=await e.create(csv,270);await e.run(batch.id);
  assert.equal(batch.status,'complete');assert.deepEqual(calls,['Alpha:prepare','Alpha:generate','Alpha:export','Alpha:export','Beta:prepare','Beta:generate','Beta:export','Gamma:prepare','Gamma:generate','Gamma:export']);
});
test('failed downloads block later brands and resume directly into export',async t=>{
  const e=await fixture(t,{simulate:true}),calls=[];const fake=e.fake.bind(e);let fail=true;
  e.fake=async(phase,batch,brand)=>{calls.push(brand.input.brand_name+':'+phase);if(phase==='export'&&fail){fail=false;throw Error('Download temporarily unavailable');}return fake(phase,batch,brand);};
  await e.check();const batch=await e.create(csv,270);await e.run(batch.id);assert.equal(batch.status,'needs_attention');assert.equal(batch.brands[0].phase,'export');assert.ok(batch.brands.slice(1).every(b=>b.attempts===0));
  await e.resume(batch.id);assert.equal(batch.status,'complete');assert.equal(calls.filter(c=>c==='Alpha:generate').length,1);assert.equal(calls.filter(c=>c==='Alpha:export').length,2);
});
test('sequential budget checks preserve completed brands and stop before an unaffordable visual',async t=>{
  const e=await fixture(t,{simulate:true});await e.check();const batch=await e.create(csv,269);await e.run(batch.id);
  assert.equal(batch.status,'needs_attention');assert.equal(batch.brands[0].status,'complete');assert.equal(batch.brands[1].status,'complete');assert.equal(batch.brands[2].phase,'generate');assert.equal(batch.brands.reduce((n,b)=>n+(b.result?.spentCredits||0),0),180);assert.match(batch.message,/remaining 89/);
  const attempts=batch.brands.slice(0,2).map(b=>b.attempts);await e.resume(batch.id,270);assert.equal(batch.status,'complete');assert.deepEqual(batch.brands.slice(0,2).map(b=>b.attempts),attempts);
});
test('server approval pending keeps saved projects and resumes generation without preparing twice',async t=>{
  const calls=[];let approved=false;
  const e=await fixture(t,{worker:async({prompt})=>{
    const phase=prompt.match(/current phase is (\w+)/)?.[1];calls.push(phase);
    if(phase==='prepare')return result();
    if(phase==='generate'&&!approved)return result({status:'awaiting_approval',approvals:[{id:'a',url:'https://app.rainfrog.ai/agent/approve/a',nodeId:'n'}]});
    return result({status:'needs_attention',summary:'Generation accepted; export needs a real URL.',spentCredits:90});
  }});
  e.preflight={status:'ready'};const b=await e.create(csv,270);await e.run(b.id);assert.equal(b.status,'awaiting_approval');
  assert.equal(calls.filter(x=>x==='generate').length,1);
  approved=true;await e.resume(b.id);assert.equal(calls.filter(x=>x==='prepare').length,1);assert.equal(calls.filter(x=>x==='generate').length,2);assert.ok(b.brands.slice(1).every(brand=>brand.attempts===0));assert.equal(b.brands[0].result.projectId,'project-1');
});

test('individual approvals advance one visual at a time and preserve counted work across resumes',async t=>{
  let generationCalls=0,prepareCalls=0;
  const e=await fixture(t,{worker:async({prompt})=>{
    const phase=prompt.match(/current phase is (\w+)/)?.[1];
    if(phase==='prepare'){prepareCalls++;return result();}
    if(phase==='generate'){
      const approved=generationCalls++;
      return approved<3?result({status:'awaiting_approval',spentCredits:approved*30,approvals:[{id:'shot-'+approved,url:'https://app.rainfrog.ai/agent/approve/shot-'+approved,nodeId:'g'+approved}]}):result({status:'running',spentCredits:90});
    }
    return result({status:'complete',spentCredits:90,outputs:[0,1,2].map(i=>({relativePath:`p${i}-0.png`,label:`Product ${i}`}))});
  }});
  const batch=await e.create(csv.split('\n').slice(0,2).join('\n'),90);e.preflight={status:'ready'};
  await e.run(batch.id);assert.equal(batch.status,'awaiting_approval');assert.equal(generationCalls,1);
  for(let i=1;i<=2;i++){await e.approved(batch.id);assert.equal(batch.status,'awaiting_approval');assert.equal(batch.brands[0].result.spentCredits,i*30);assert.equal(batch.brands[0].result.approvals.length,1);}
  await e.approved(batch.id);assert.equal(batch.status,'complete');assert.equal(batch.brands[0].result.spentCredits,90);assert.equal(prepareCalls,1);assert.equal(generationCalls,4);
});
test('restart turns active jobs into paused reviewable checkpoints',async t=>{
  const e=await fixture(t,{simulate:true});const b=await e.create(csv,270);b.status='running';b.brands[0].status='working';await e.save(b);
  const next=new Engine(e.root,config,{simulate:true});await next.init();assert.equal(next.batches[0].status,'paused');assert.equal(next.batches[0].brands[0].status,'needs_attention');
});
test('complete requires actual distinct image files and disallows symlink escape',async t=>{
  const e=await fixture(t);const dir=path.join(e.root,'brand');await mkdir(dir);await writeFile(path.join(dir,'bad.png'),'<html>not an image</html>');
  await assert.rejects(()=>verifyOutputs(dir,result({status:'complete',outputs:[{relativePath:'bad.png',label:'Bad'}]}),1),/not a supported image/);
  await assert.rejects(()=>verifyOutputs(dir,result({status:'complete',outputs:[]}),1),/Expected 1/);
  const outside=path.join(e.root,'outside.png');await writeFile(outside,Buffer.alloc(100));await symlink(outside,path.join(dir,'escape.png'));
  await assert.rejects(()=>verifyOutputs(dir,result({status:'complete',outputs:[{relativePath:'escape.png',label:'Escape'}]}),1),/outside/);
});
test('rejects unexpected approval/project URLs',()=>{
  assert.throws(()=>normalizeResult(result({approvals:[{url:'https://evil.com/agent/approve/a'}]})),/unexpected approval/);
  assert.throws(()=>normalizeResult(result({projectUrl:'javascript:alert(1)'})),/unexpected project/);
});
test('pause waits for the active phase and starts no subsequent brand',async t=>{
  let e;const calls=[];e=await fixture(t,{worker:async({prompt})=>{calls.push(prompt);e.pause();return result();}});e.preflight={status:'ready'};
  const b=await e.create(csv,270);await e.run(b.id);assert.equal(b.status,'paused');assert.equal(calls.length,1);assert.equal(b.brands[0].phase,'generate');assert.equal(b.brands[1].phase,'prepare');
});
test('product preparation keeps six gallery photos together and permits smaller galleries',async t=>{
  const e=await fixture(t),dir=path.join(e.root,'gallery');
  let m=await seedPreparation(dir,'project-1',1,'still_life',9);
  await verifyPreparation(dir,{product_count:1,shoot_type:'still_life'},'project-1',verifyOutputs);
  assert.equal(m.products.length,1);assert.equal(m.products[0].images.length,6);
  m=await seedPreparation(dir,'project-1',1,'still_life',2);
  await verifyPreparation(dir,{product_count:1,shoot_type:'still_life'},'project-1',verifyOutputs);
  assert.equal(m.products[0].images.length,2);
});
test('preparation rejects an omitted gallery view, a partial upload, and duplicate photo bytes',async t=>{
  const e=await fixture(t),dir=path.join(e.root,'gallery');
  const check=()=>verifyPreparation(dir,{product_count:1,shoot_type:'still_life'},'project-1',verifyOutputs);
  let m=await seedPreparation(dir,'project-1',1,'still_life',6);m.products[0].images.pop();await writeFile(path.join(dir,'manifest.json'),JSON.stringify(m));await assert.rejects(check,/download all/);
  m=await seedPreparation(dir,'project-1',1,'still_life',6);m.products[0].uploadedImageCount=1;await writeFile(path.join(dir,'manifest.json'),JSON.stringify(m));await assert.rejects(check,/same Rainfrog product/);
  m=await seedPreparation(dir,'project-1',1,'still_life',2);const [first,second]=m.products[0].images;await writeFile(path.join(dir,second.localFile),await readFile(path.join(dir,first.localFile)));second.sha256=first.sha256;await writeFile(path.join(dir,'manifest.json'),JSON.stringify(m));await assert.rejects(check,/duplicate gallery/);
});
test('both mode requires the correct actual dropdown for each of its two generators',async t=>{
  const e=await fixture(t),dir=path.join(e.root,'both');
  const m=await seedPreparation(dir,'project-1',1,'both',2);
  const check=()=>verifyPreparation(dir,{product_count:1,shoot_type:'both'},'project-1',verifyOutputs);
  await check();
  m.canvasSnapshot.nodes[1].data.preset='generic';await writeFile(path.join(dir,'manifest.json'),JSON.stringify(m));await assert.rejects(check,/fashion-shooting/);
  m.canvasSnapshot.nodes[1].data.preset='product-still-life';await writeFile(path.join(dir,'manifest.json'),JSON.stringify(m));await assert.rejects(check,/fashion-shooting/);
});
test('missing photo files stop preparation instead of advancing to a ready canvas',async t=>{
  const e=await fixture(t),dir=path.join(e.root,'missing');const m=await seedPreparation(dir,'project-1',1,'still_life',2);
  await rm(path.join(dir,m.products[0].images[1].localFile));
  await assert.rejects(()=>verifyPreparation(dir,{product_count:1,shoot_type:'still_life'},'project-1',verifyOutputs),/ENOENT/);
});
test('a global sandbox runtime failure stops after the first brand and invalidates readiness',async t=>{
  let calls=0;
  const e=await fixture(t,{worker:async()=>{calls++;return result({status:'needs_attention',projectId:null,plannedCredits:0,summary:'sandbox-exec: sandbox_apply: Operation not permitted'});}});
  e.preflight={status:'ready'};const b=await e.create(csv,270);await e.run(b.id);
  assert.equal(calls,1);assert.equal(e.preflight.status,'needs_attention');assert.equal(b.brands[1].status,'queued');
  assert.match(b.message,/Finder|Terminal/);await assert.rejects(()=>e.resume(b.id),/connection check/);
});
test('an API-only ready claim cannot pass preflight without a real worker file proof',async t=>{
  const e=await fixture(t),cli=path.join(e.root,'fake-codex');
  await writeFile(cli,`#!/usr/bin/env node\nconst fs=require('node:fs');const i=process.argv.indexOf('--output-last-message');process.stdin.resume();process.stdin.on('end',()=>fs.writeFileSync(process.argv[i+1],JSON.stringify(${JSON.stringify(result({projectId:null,plannedCredits:0,summary:'API connected; ready.'}))})));\n`);
  await chmod(cli,0o700);
  const r=await runCodex({prompt:'Read-only connection check.',cwd:path.join(e.root,'check'),config:{...config,codexPath:cli,rainfrogMcpUrl:'https://mcp.rainfrog.ai/mcp'},log:()=>{}});
  assert.equal(r.status,'needs_attention');assert.match(r.summary,/file access was not verified/);
});
test('prepare preserves manifest/report artifacts without validating them as generated images',async t=>{
  const e=await fixture(t,{worker:async()=>result({outputs:[{relativePath:'manifest.json',label:'Checkpoint'}]})});
  const b=await e.create(csv,270),brand=b.brands[0];await e.invoke('prepare',b,brand);
  assert.equal(brand.status,'ready');assert.equal(brand.phase,'generate');assert.deepEqual(brand.result.outputs,[]);
  assert.equal(brand.artifacts[0].relativePath,'manifest.json');assert.equal(brand.result.projectId,'project-1');
});
test('a target project workspace cannot stand in for actual product ownership',async t=>{
  const e=await fixture(t),dir=path.join(e.root,'scope');const m=await seedPreparation(dir,'project-1',1);
  m.workspaceId='test-workspace';m.products[0].workspaceId='personal';
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify(m));
  const check=()=>verifyPreparation(dir,{product_count:1,shoot_type:'still_life'},'project-1',verifyOutputs,false,'test-workspace');
  await assert.rejects(check,/ownership in the target workspace/);
  m.products[0].workspaceId='test-workspace';m.products[0].workspaceVerified=false;
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify(m));await assert.rejects(check,/ownership/);
  m.products[0].workspaceVerified=true;await writeFile(path.join(dir,'manifest.json'),JSON.stringify(m));await check();
});
test('explicit Personal product storage works with a different project workspace',async t=>{
  const e=await fixture(t,{simulate:true});e.config={...config,workspaceId:'team-workspace',productWorkspaceId:'personal',productWorkspaceName:'Personal'};
  await e.check();const b=await e.create(csv,270);await e.run(b.id);assert.equal(b.status,'complete');
  const m=JSON.parse(await readFile(path.join(e.dir(b,b.brands[0]),'manifest.json'),'utf8'));
  assert.ok(m.products.every(p=>p.workspaceId==='personal'));assert.equal(e.snapshot().config.productWorkspaceId,'personal');
});
test('approval URL supplies its missing ID without changing a saved generation key',async t=>{
  const e=await fixture(t),dir=path.join(e.root,'approval');const m=await seedPreparation(dir,'project-1',1);
  m.shots[0].approvalUrl='https://app.rainfrog.ai/agent/approve/99ca0459-ff8c-44fd-b186-9add4a52fac2?nonce=example';
  m.shots[0].idempotencyKey='original-shot-key';await writeFile(path.join(dir,'manifest.json'),JSON.stringify(m));
  await hydrateApprovalIds(dir);const saved=JSON.parse(await readFile(path.join(dir,'manifest.json'),'utf8'));
  assert.equal(saved.shots[0].approvalId,'99ca0459-ff8c-44fd-b186-9add4a52fac2');assert.equal(saved.shots[0].idempotencyKey,'original-shot-key');
  assert.throws(()=>approvalIdFromURL('https://other.example/agent/approve/a'),/Invalid/);
});
test('user approval confirmation queues a single continuation while a worker is active',async t=>{
  const e=await fixture(t);const b=await e.create(csv,270);e.busy=true;e.activeBatchId=b.id;
  b.brands[0].status='awaiting_approval';await e.approved(b.id);
  assert.equal(b.resumeAfterApproval,true);assert.equal(b.brands[0].attempts,0);
  await e.approved(b.id);assert.equal(b.resumeAfterApproval,true);
});

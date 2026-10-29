import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { instagramProfile,verifyInstagram } from '../lib/instagram.mjs';
import { textHash } from '../lib/creative.mjs';
import { Engine,verifyOutputs } from '../lib/engine.mjs';
import { verifyPreparation } from '../lib/preparation.mjs';

async function temporary(t){const root=await mkdtemp(path.join(os.tmpdir(),'instagram-test-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
async function captured(directory){
  await mkdir(path.join(directory,'instagram-research'),{recursive:true});
  const png=Buffer.alloc(40);Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
  const image={localFile:'instagram-research/profile.png',sha256:textHash(png)};
  await writeFile(path.join(directory,image.localFile),png);
  const evidence={version:2,status:'captured',handle:'alpha',profileUrl:'https://www.instagram.com/alpha/',profileScreenshot:image,posts:[]};
  for(let i=1;i<=6;i++){
    const bytes=Buffer.from(png);bytes[30]=i;const localFile=`instagram-research/post-${i}.png`;await writeFile(path.join(directory,localFile),bytes);
    evidence.posts.push({url:`https://www.instagram.com/alpha/p/post${i}/`,image:{localFile,sha256:textHash(bytes)},unobstructed:true});
  }
  const file=path.join(directory,'instagram-research/evidence.json');await writeFile(file,JSON.stringify(evidence));
  return {evidence,file};
}
test('Instagram URL normalization accepts profiles and rejects posts or unrelated hosts',()=>{
  assert.deepEqual(instagramProfile('https://instagram.com/alpha/?hl=it'),{handle:'alpha',url:'https://www.instagram.com/alpha/'});
  for(const u of ['http://instagram.com/alpha','https://example.com/alpha','https://instagram.com/p/ABC/','https://instagram.com/accounts/login/'])assert.throws(()=>instagramProfile(u));
});
test('Instagram evidence requires six distinct unobstructed images, matching brand and valid checksums',async t=>{
  const root=await temporary(t),{evidence,file}=await captured(root),input={instagram_url:'https://instagram.com/alpha'};
  await verifyInstagram(root,input);
  await assert.rejects(()=>verifyInstagram(root,{instagram_url:'https://instagram.com/beta'}),/another brand/);
  const obstructed=structuredClone(evidence);obstructed.posts[0].unobstructed=false;await writeFile(file,JSON.stringify(obstructed));await assert.rejects(()=>verifyInstagram(root,input),/unobstructed/);
  const duplicate=structuredClone(evidence);duplicate.posts[5].url=duplicate.posts[0].url;await writeFile(file,JSON.stringify(duplicate));await assert.rejects(()=>verifyInstagram(root,input),/distinct/);
  await writeFile(file,JSON.stringify({...evidence,posts:evidence.posts.slice(0,5)}));await assert.rejects(()=>verifyInstagram(root,input),/six/);
  await writeFile(file,JSON.stringify(evidence));await writeFile(path.join(root,evidence.posts[0].image.localFile),'error page');await assert.rejects(()=>verifyInstagram(root,input),/invalid or changed/);
});
test('blocked Instagram stops before invoking any Rainfrog worker and can resume from captured evidence',async t=>{
  const root=await temporary(t);let calls=0,captures=0;
  const config={requireInstagramResearch:true,maxBrands:3,defaultProducts:1,defaultShootType:'still_life',defaultStyle:'Line Gobo No Back'};
  const instagram={collect:async()=>{captures++;throw new Error('Instagram login required: sign in and Resume.');}};
  const worker=async()=>{calls++;return {status:'needs_attention',summary:'Worker inspected evidence; stop test before mutations.',projectId:null,projectUrl:null,plannedCredits:0,spentCredits:0,approvals:[],outputs:[],warnings:[]};};
  const engine=new Engine(root,config,{instagram,worker});await engine.init();
  const batch=await engine.create('brand_name,instagram_url,website_url\nAlpha,https://instagram.com/alpha,https://alpha.com',270),brand=batch.brands[0];
  await engine.invoke('prepare',batch,brand);assert.equal(calls,0);assert.equal(captures,1);assert.equal(brand.phase,'prepare');assert.match(brand.message,/login required/);
  await captured(engine.dir(batch,brand));await engine.invoke('prepare',batch,brand);assert.equal(calls,1);assert.equal(captures,1);assert.ok(brand.instagramEvidenceHash);
});
test('a ready canvas cannot bypass Instagram visual review or use a different evidence version',async t=>{
  const root=await temporary(t),config={maxBrands:3,defaultProducts:1,defaultShootType:'still_life',defaultStyle:'Line Gobo No Back'};
  const engine=new Engine(root,config,{simulate:true});await engine.init();
  const batch=await engine.create('brand_name,instagram_url,website_url\nAlpha,https://instagram.com/alpha,https://alpha.com',270),brand=batch.brands[0];
  await engine.invoke('prepare',batch,brand);const dir=engine.dir(batch,brand),{evidence}=await captured(dir);
  const {sha256}=await verifyInstagram(dir,brand.input),file=path.join(dir,'manifest.json'),manifest=JSON.parse(await readFile(file,'utf8'));
  const check=()=>verifyPreparation(dir,brand.input,brand.result.projectId,verifyOutputs,true,undefined,undefined,true);
  await assert.rejects(check,/captured Instagram evidence/);
  manifest.instagramEvidenceHash=sha256;await writeFile(file,JSON.stringify(manifest));
  const analysis={evidenceSha256:sha256,posts:evidence.posts.map(p=>({postUrl:p.url,imageFile:p.image.localFile,observations:'A specific observed image with a distinctive palette, composition and product presentation.'})),communication:'Observed communication codes with concrete recurring choices in framing, materials, casting, color palette, styling and product presentation.'};
  const analysisFile=path.join(dir,'instagram-analysis.json');await writeFile(analysisFile,JSON.stringify(analysis));await check();
  analysis.communication={observedCodes:analysis.communication,limitations:'Only rendered grid images are observed; unavailable captions and carousel interiors are not inferred.'};await writeFile(analysisFile,JSON.stringify(analysis));await check();
  analysis.posts.pop();await writeFile(analysisFile,JSON.stringify(analysis));await assert.rejects(check,/Review six/);
  analysis.evidenceSha256='wrong';await writeFile(analysisFile,JSON.stringify(analysis));await assert.rejects(check,/does not match/);
});

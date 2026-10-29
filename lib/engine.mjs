import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { atomicJSON, runCodex, isLocalRuntimeFailure, runtimeFailureMessage, hydrateApprovalIds } from './runner.mjs';
import { phasePrompt, preflightPrompt } from './prompts.mjs';
import { validateBrands } from './csv.mjs';
import { verifyPreparation,verifyNativeExecutions, PRESETS } from './preparation.mjs';
import { creativeProfile, verifyImageFormat, textHash,composeScenePrompt } from './creative.mjs';
import { verifyInstagram } from './instagram.mjs';
import {unattended,parseRainfrogPermissions,permissionStep,standingGrantMessage,persistentAccessReady,permissionSetupPrompt,pendingPermissionApprovals} from './permissions.mjs';
import { approvalKind,setupApprovalRefreshPrompt,sameApprovalCredential,recordedApprovalCredentials,isApprovalRenewalFailure,APPROVAL_RENEWAL_BLOCKED } from './approvals.mjs';

export function within(root, file) { return file === root || file.startsWith(root + path.sep); }
export function isNativeIntegrationFailure(message){return /\b(?:INVALID_NODE_PATCH|EXECUTION_UNSUPPORTED)\b/.test(message);}

export function partitionWorkerOutputs(outputs, phase) {
  const reports = /\.(json|md|csv|txt|pdf)$/i;
  return {
    images: phase === 'export' ? outputs.filter(o => !reports.test(o.relativePath)) : [],
    artifacts: outputs.filter(o => phase !== 'export' || reports.test(o.relativePath))
  };
}

export async function verifyOutputs(directory, result, expected, simulate = false, profile) {
  if (result.status === 'complete' && result.outputs.length !== expected) throw new Error(`Expected ${expected} final images; worker reported ${result.outputs.length}. Generated work is preserved for review.`);
  const root = await realpath(directory), seen = new Set();
  for (const output of result.outputs) {
    const relative = output.relativePath;
    if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Output must use a relative file path.');
    const target = await realpath(path.resolve(directory, relative));
    if (!within(root, target) || seen.has(target)) throw new Error('Output path is outside the brand folder, or duplicated.');
    seen.add(target);
    const info = await stat(target);
    if (!info.isFile() || info.size < 20 || info.size > 100 * 1024 * 1024) throw new Error('Output is empty, not a file, or too large.');
    const bytes = await readFile(target);
    const image = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
      (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) ||
      (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') ||
      (bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis|heic/.test(bytes.toString('ascii', 8, 32))) ||
      (simulate && bytes.toString('utf8', 0, 100).includes('<svg'));
    if (!image) throw new Error(`Downloaded file is not a supported image: ${relative}`);
    if(profile&&!simulate)verifyImageFormat(bytes,profile);
  }
}

export class Engine extends EventEmitter {
  constructor(root, config, { simulate = false, worker = runCodex, briefPath, instagram } = {}) {
    super(); this.root = root; this.config = config; this.simulate = simulate; this.worker = worker;
    this.briefPath=briefPath;
    this.instagram=instagram;
    this.batches = []; this.busy = false; this.preflight = null; this.logs = []; this.pauseRequested = false;this.activeBatchId=null;this.rainfrogPermissions=null;
  }
  async init() {
    await mkdir(path.join(this.root, 'batches'), { recursive: true });
    for (const entry of await readdir(path.join(this.root, 'batches'))) {
      try {
        const batch = JSON.parse(await readFile(path.join(this.root, 'batches', entry, 'batch.json'), 'utf8'));
        if (batch.id !== entry || !Array.isArray(batch.brands)) continue;
        if (batch.status === 'running') {
          batch.status = 'paused'; batch.message = 'App restarted. Review saved checkpoints, then resume.';
          for (const b of batch.brands) if (b.status === 'working') b.status = 'needs_attention';
        }
        if(batch.status!=='closed'&&batch.status!=='complete'&&batch.simulate===this.simulate){
          let recovered=false;
          for(const brand of batch.brands){
            if(brand.phase==='generate'&&brand.status==='needs_attention'&&brand.result?.status==='running'&&brand.message==='Generation must be an execution of the exact wired native generator node, verified by its trigger request and execution metadata.'){
              try{
                await verifyPreparation(this.dir(batch,brand),brand.input,brand.result.projectId,verifyOutputs,this.simulate,this.config.productWorkspaceId||this.config.workspaceId,brand.creativeProfile,brand.instagramRequired&&!this.simulate);
                await verifyNativeExecutions(this.dir(batch,brand),brand.result.projectId,brand.creativeProfile,'running');
                const manifest=JSON.parse(await readFile(path.join(this.dir(batch,brand),'manifest.json'),'utf8'));
                if(!manifest.shots?.length||manifest.shots.some(s=>!s.executionId))throw new Error('Some native executions are still missing.');
                brand.phase='export';brand.status='running';brand.message='Existing native generations verified. Ready to download; no regeneration needed.';recovered=true;
              }catch{/* Real request/node/execution mismatches remain blocked. */}
              continue;
            }
            if(brand.phase!=='prepare'||brand.status!=='needs_attention'||brand.result?.status!=='ready'||brand.message!=='The native project and all selected products must belong to the same verified workspace.')continue;
            try{
              await verifyPreparation(this.dir(batch,brand),brand.input,brand.result.projectId,verifyOutputs,this.simulate,this.config.productWorkspaceId||this.config.workspaceId,brand.creativeProfile,brand.instagramRequired&&!this.simulate);
              brand.status='ready';brand.phase='generate';brand.message='Saved native preparation revalidated against server ownership evidence. Existing products, canvas and quotes retained.';recovered=true;
            }catch{/* A real evidence/graph mismatch remains blocked and must not be promoted. */}
          }
          if(recovered){batch.status=batch.brands.some(b=>b.status==='awaiting_approval')?'awaiting_approval':'paused';batch.message='Saved checkpoints revalidated. Resume the existing batch to continue; prepared work and accepted generations are preserved.';await this.save(batch);}
        }
        this.batches.push(batch);
      } catch {}
    }
    this.batches.sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  }
  log(type, message) {
    // Keep console messages short; never copy tool payloads or credentials into the UI.
    const entry = { at: new Date().toISOString(), type, message: String(message).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 2000) };
    this.logs.push(entry); if (this.logs.length > 250) this.logs.shift(); this.emit('change');
  }
  dir(batch, brand) { return path.join(this.root, 'batches', batch.id, ...(brand ? ['brands', brand.id] : [])); }
  async save(batch) {
    batch.updatedAt = new Date().toISOString();
    await atomicJSON(path.join(this.dir(batch), 'batch.json'), batch);
    const quote = v => `"${String(v ?? '').replaceAll('"', '""')}"`;
    const report = [['brand','status','phase','project_id','planned_credits','counted_credits','downloaded_images','summary'],
      ...batch.brands.map(b => [b.input.brand_name,b.status,b.phase,b.result?.projectId,b.result?.plannedCredits,b.result?.spentCredits,b.result?.outputs?.length,b.message])];
    await writeFile(path.join(this.dir(batch), 'batch-report.csv'), report.map(r => r.map(quote).join(',')).join('\n') + '\n');
    this.emit('change');
  }
  snapshot() {
    return { config: { workspaceName: this.config.workspaceName, workspaceId: this.config.workspaceId, maxBrands: null,
      productWorkspaceName:this.config.productWorkspaceName || this.config.workspaceName,
      productWorkspaceId:this.config.productWorkspaceId || this.config.workspaceId,
      approvalMode:this.config.approvalMode||'per-action',
      defaultMaxCredits: this.config.defaultMaxCredits, defaultStyle: this.config.defaultStyle,
      aspectRatio:this.config.defaultAspectRatio||'3:4',resolution:this.config.defaultResolution||'2K',
      outputRoot: path.join(this.root, 'batches') },
      simulate: this.simulate, busy: this.busy, activeBatchId:this.activeBatchId, preflight: this.preflight,rainfrogPermissions:this.rainfrogPermissions,permissionSetup:this.permissionSetup||null, logs: this.logs, batches: this.batches };
  }
  async enablePermissions(){
    if(this.busy)throw new Error('Wait for the current worker.');
    this.busy=true;this.permissionSetup={status:'checking',stage:'permissions',summary:'Checking Rainfrog permissions…',startedAt:new Date().toISOString(),approvals:[]};this.emit('change');
    // Invalidate old capability evidence until this separate request is verified.
    this.rainfrogPermissions=null;
    try{
      const result=this.simulate?{rainfrogPermissions:{studioEnabled:true,actions:{read:'allow',add:'allow',edit:'allow',generate:'allow'}},summary:'Simulation permission check only.',approvals:[],spentCredits:0,plannedCredits:0,projectId:null,outputs:[]}:
        await this.worker({prompt:permissionSetupPrompt(),cwd:path.join(this.root,'permission-setup'),config:this.config,log:this.log.bind(this)});
      if(result.projectId||result.spentCredits!==0||result.plannedCredits!==0||result.outputs?.length)throw new Error('Permission setup returned unrelated project or generation work. No batch will start.');
      this.rainfrogPermissions=parseRainfrogPermissions(result.rainfrogPermissions);
      const ready=persistentAccessReady(this.rainfrogPermissions);
      if(ready){
        this.preflight=null;
        this.permissionSetup={...this.permissionSetup,stage:'connection',summary:'Permissions granted. Checking your workspace…'};this.emit('change');
        this.preflight=this.simulate?{status:'ready',summary:'Simulation connection.',warnings:[]}:
          await this.worker({prompt:preflightPrompt(this.config),cwd:path.join(this.root,'connection-check'),config:this.config,log:this.log.bind(this)});
        if(!this.simulate)this.rainfrogPermissions=parseRainfrogPermissions(this.preflight.rainfrogPermissions);
      }
      this.permissionSetup={status:persistentAccessReady(this.rainfrogPermissions)&&this.preflight?.status==='ready'?'ready':result.approvals?.length?'awaiting_authorization':'blocked',summary:ready&&this.preflight?.status!=='ready'?this.preflight.summary:result.summary,approvals:ready?[]:result.approvals||[],checkedAt:new Date().toISOString()};
      this.log('permissions',this.permissionSetup.summary);
    }catch(e){this.permissionSetup={status:'blocked',summary:e.message,approvals:[]};this.log('error',e.message);}
    finally{this.busy=false;this.emit('change');}
  }
  async check() {
    if (this.busy) throw new Error('A worker is already active.');
    const priorApprovals=this.permissionSetup?.approvals||[];
    this.busy = true; this.rainfrogPermissions=null; this.permissionSetup={status:'checking',stage:'connection',summary:'Checking access and workspace…',startedAt:new Date().toISOString(),approvals:[]};this.emit('change');
    try {
      this.preflight = this.simulate ? { status:'ready', summary:'Simulation only. No Rainfrog connection or generation.', warnings:[] } :
        await this.worker({ prompt: preflightPrompt(this.config), cwd: path.join(this.root,'connection-check'), config:this.config, log:this.log.bind(this) });
      if(unattended(this.config)||this.preflight.rainfrogPermissions||this.simulate){
        this.rainfrogPermissions=this.simulate?{studioEnabled:true,actions:{read:'allow',add:'allow',edit:'allow',generate:'allow'}}:parseRainfrogPermissions(this.preflight.rainfrogPermissions);
        if(!this.rainfrogPermissions.studioEnabled||['read','add','edit','generate'].some(k=>this.rainfrogPermissions.actions[k]==='deny'))throw new Error('Rainfrog has a disabled or denied permission. Enable the required actions before running.');
      }
      this.log('connection', this.preflight.summary);
    } catch (error) { this.preflight = { status:'needs_attention', summary:error.message, warnings:[] }; this.log('error', error.message); }
    finally {
      const ready=this.preflight?.status==='ready'&&(!unattended(this.config)||persistentAccessReady(this.rainfrogPermissions));
      const remaining=pendingPermissionApprovals(priorApprovals,this.rainfrogPermissions);
      this.permissionSetup={status:ready?'ready':remaining.length&&this.preflight?.status==='ready'?'awaiting_authorization':'blocked',summary:this.preflight.summary,approvals:ready?[]:remaining,checkedAt:new Date().toISOString()};
      this.busy = false; this.emit('change');
    }
  }
  async create(csv, maxCredits) {
    if (this.busy) throw new Error('Wait for the current worker before creating a batch.');
    const rows = validateBrands(csv, this.config);
    if (!Number.isSafeInteger(maxCredits) || maxCredits < 1) throw new Error('Batch credit limit must be a positive safe whole number.');
    const id = `${new Date().toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,6)}`;
    const batch = { id, createdAt:new Date().toISOString(), status:'queued', message:'Ready to start.', maxCredits, simulate:this.simulate,
      brands: rows.map(input => ({id:input.id, input, instagramRequired:this.config.requireInstagramResearch===true, phase:'prepare', status:'queued', message:'Waiting to research.', result:null, attempts:0})) };
    this.batches.unshift(batch); await mkdir(this.dir(batch), {recursive:true});
    await writeFile(path.join(this.dir(batch), 'brands.csv'), csv);
    for (const brand of batch.brands) {
      await mkdir(this.dir(batch,brand), {recursive:true});
      await atomicJSON(path.join(this.dir(batch,brand),'brand-input.json'), brand.input);
    }
    await this.save(batch); return batch;
  }
  pause() { this.pauseRequested = true; this.log('pause', 'Pause requested. Current step will finish and checkpoint; no further step will start.'); }
  async close(id){
    if(this.busy)throw new Error('Wait for the active worker to finish before closing a batch.');
    const batch=this.batches.find(b=>b.id===id);if(!batch)throw new Error('Batch not found.');
    if(batch.status==='closed')return batch;
    batch.status='closed';batch.closedAt=new Date().toISOString();batch.resumeAfterApproval=false;
    batch.message='Closed by user. Saved projects, products, images and checkpoints are preserved.';
    await this.save(batch);this.log('batch','Batch closed. You can create and start another batch.');return batch;
  }
  async invoke(phase, batch, brand) {
    brand.status='working'; brand.attempts++; brand.message=`${phase === 'prepare' ? 'Researching and preparing the canvas' : phase === 'generate' ? 'Submitting approved generations' : 'Checking images and downloading'}…`;
    batch.message=`Brand ${batch.brands.indexOf(brand)+1} of ${batch.brands.length} · ${brand.input.brand_name}: ${brand.message}`;
    await this.save(batch);
    const logStart = this.logs.length;
    try {
      if(phase==='prepare'&&brand.instagramRequired&&!this.simulate){
        let evidence;
        try{evidence=await verifyInstagram(this.dir(batch,brand),brand.input);}catch{
          if(!this.instagram)throw new Error('Mandatory Instagram browser is unavailable. Start the updated app and Resume.');
          evidence=await this.instagram.collect(brand.input,this.dir(batch,brand),this.log.bind(this));
        }
        brand.instagramEvidenceHash=evidence.sha256;await this.save(batch);
      }
      if(phase==='prepare'&&this.briefPath&&!brand.creativeProfile){
        brand.creativeProfile=await creativeProfile(this.briefPath,this.config);
        await writeFile(path.join(this.dir(batch,brand),'pezzo-brief.md'),brand.creativeProfile.pezzoBrief);
        await atomicJSON(path.join(this.dir(batch,brand),'creative-profile.json'),brand.creativeProfile);
        await this.save(batch);
      }
      if (phase === 'generate') {
        await verifyPreparation(this.dir(batch,brand),brand.input,brand.result?.projectId,verifyOutputs,this.simulate,this.config.productWorkspaceId || this.config.workspaceId,brand.creativeProfile,brand.instagramRequired&&!this.simulate);
        if(!unattended(this.config))await hydrateApprovalIds(this.dir(batch,brand));
      }
      const result = this.simulate ? await this.fake(phase,batch,brand) : await this.worker({
        prompt:phasePrompt(phase,batch,brand,this.config), cwd:this.dir(batch,brand), config:this.config, log:this.log.bind(this)
      });
      const prior = brand.result;
      if (prior?.projectId && result.projectId !== prior.projectId) throw new Error('Worker changed or lost the saved project ID. Review the manifest before resuming.');
      if (prior?.spentCredits > result.spentCredits) throw new Error('Worker reduced the counted generation cost. Review manifest.json before resuming.');
      // Preserve the returned remote IDs/costs even if local output verification fails.
      brand.result=result;
      if(result.rainfrogPermissions)this.rainfrogPermissions=parseRainfrogPermissions(result.rainfrogPermissions);
      result.approvals=result.approvals.map(a=>({...a,kind:approvalKind(phase),receivedAt:new Date().toISOString()}));
      const partition=partitionWorkerOutputs(result.outputs,phase);
      brand.artifacts=[...new Map([...(brand.artifacts||[]),...partition.artifacts].map(o=>[o.relativePath,o])).values()];
      result.outputs=partition.images;
      if (phase === 'prepare' && result.status === 'ready') await verifyPreparation(this.dir(batch,brand),brand.input,result.projectId,verifyOutputs,this.simulate,this.config.productWorkspaceId || this.config.workspaceId,brand.creativeProfile,brand.instagramRequired&&!this.simulate);
      if(phase==='generate'&&brand.creativeProfile?.styleDelivery==='wired-native'){
        await verifyPreparation(this.dir(batch,brand),brand.input,result.projectId,verifyOutputs,this.simulate,this.config.productWorkspaceId || this.config.workspaceId,brand.creativeProfile,brand.instagramRequired&&!this.simulate);
        await verifyNativeExecutions(this.dir(batch,brand),result.projectId,brand.creativeProfile,result.status);
      }
      const expected = brand.input.product_count * (brand.input.shoot_type === 'both' ? 2 : 1);
      await verifyOutputs(this.dir(batch,brand),result,expected,this.simulate,phase==='export'?brand.creativeProfile:undefined);
      brand.status=result.status; brand.message=result.summary;
      if (phase === 'prepare' && result.status === 'ready') brand.phase='generate';
      if (phase === 'generate' && result.status === 'running') brand.phase='export';
      if (result.status === 'complete') brand.phase='done';
    } catch (error) {
      if (brand.result) brand.result.outputs=[];
      brand.status='needs_attention'; brand.message=error.message;
      this.log('error', `${brand.input.brand_name}: ${error.message}`);
    }
    await writeFile(path.join(this.dir(batch,brand),'worker-log.txt'),this.logs.slice(logStart).map(e => `${e.at} [${e.type}] ${e.message}`).join('\n')+'\n', {flag:'a'});
    if (isLocalRuntimeFailure(brand.message)) {
      this.preflight={status:'needs_attention',summary:runtimeFailureMessage(),warnings:[]};
      this.log('runtime',runtimeFailureMessage());
    }
    await this.save(batch);
  }
  async run(id) {
    if (this.busy) throw new Error('A worker is already active.');
    const batch=this.batches.find(b => b.id===id); if (!batch) throw new Error('Batch not found.');
    if(batch.status==='closed')throw new Error('This batch is closed. Create a new batch to start another run.');
    if (batch.simulate !== this.simulate) throw new Error('Simulation batches cannot be run in live mode, or vice versa.');
    if (batch.status==='complete') return;
    if (this.preflight?.status!=='ready') throw new Error('Run a successful connection check before starting a batch.');
    if(unattended(this.config)&&!this.simulate){
      if(!this.rainfrogPermissions)throw new Error('Check Rainfrog permissions before starting unattended execution.');
      if(!this.rainfrogPermissions.studioEnabled||['read','add','edit','generate'].some(k=>this.rainfrogPermissions.actions[k]==='deny'))throw new Error('Rainfrog has a disabled or denied permission.');
      const missing=['edit','generate'].find(k=>this.rainfrogPermissions.actions[k]!=='allow');
      if(missing){batch.status='needs_attention';batch.message=standingGrantMessage(missing);await this.save(batch);throw new Error(batch.message);}
      if(!persistentAccessReady(this.rainfrogPermissions))throw new Error('Rainfrog must confirm Read, Add, Edit and Generate as Always allow before unattended execution.');
      for(const brand of batch.brands){
        if(this.rainfrogPermissions.actions[permissionStep(brand.phase)]!=='allow')continue;
        brand.approvalRenewalBlocked=false;brand.approvalRefreshNeeded=false;
        if(brand.result?.approvals?.length){brand.retiredApprovals=[...(brand.retiredApprovals||[]),...brand.result.approvals];brand.result.approvals=[];}
      }
    }
    this.busy=true;this.activeBatchId=id; this.pauseRequested=false; batch.status='running'; batch.message=batch.brands.some(b=>b.phase==='prepare')?'Preparing brands.':'Continuing prepared shots.'; await this.save(batch);
    try {
      // Complete one CSV row, including validated downloads, before touching the next.
      for (const brand of batch.brands) {
        if (brand.status==='complete'&&brand.phase==='done') continue;
        if (this.pauseRequested) {batch.status='paused';batch.message='Paused after checkpoint.';return;}
        if(brand.approvalRenewalBlocked){batch.status='needs_attention';batch.message=APPROVAL_RENEWAL_BLOCKED;return;}
        if(brand.approvalRefreshNeeded){batch.status='awaiting_approval';batch.message='Refresh the expired canvas-setup link for this brand, approve it, then continue.';return;}
        if(brand.phase==='prepare'){
          const spent=batch.brands.reduce((n,b)=>n+(b.result?.spentCredits||0),0);
          if(spent>=batch.maxCredits){batch.status='needs_attention';batch.message=`Batch credit limit reached (${spent} / ${batch.maxCredits}). Increase it to continue with ${brand.input.brand_name}.`;return;}
          await this.invoke('prepare',batch,brand);
          if(this.preflight?.status!=='ready'){batch.status='needs_attention';batch.message=runtimeFailureMessage();return;}
          if(brand.phase!=='generate'){
            batch.status=brand.status==='awaiting_approval'?'awaiting_approval':'needs_attention';
            batch.message=brand.status==='awaiting_approval'?(unattended(this.config)?standingGrantMessage('edit'):'Approve this brand’s canvas setup, then continue.'):`${brand.input.brand_name}: ${brand.message}`;
            if(isNativeIntegrationFailure(brand.message))batch.message=`Rainfrog native-template integration stopped preparation: ${brand.message}`;
            return;
          }
        }
        if(this.pauseRequested){batch.status='paused';batch.message='Paused after checkpoint.';return;}
        if(brand.phase==='generate'){
          const otherSpent=batch.brands.filter(b=>b.id!==brand.id).reduce((n,b)=>n+(b.result?.spentCredits||0),0);
          const quote=Math.max(brand.result?.plannedCredits||0,brand.result?.spentCredits||0);
          if(otherSpent+quote>batch.maxCredits){batch.status='needs_attention';batch.message=`${brand.input.brand_name}: verified quote ${quote} exceeds the remaining ${Math.max(0,batch.maxCredits-otherSpent)} credits (batch limit ${batch.maxCredits}). Increase the limit to continue. Completed brands are preserved.`;return;}
          await this.invoke('generate',batch,brand);
          if(this.preflight?.status!=='ready'){batch.status='needs_attention';batch.message=runtimeFailureMessage();return;}
          if(brand.phase!=='export'&&brand.phase!=='done'){
            batch.status=brand.status==='awaiting_approval'?'awaiting_approval':'needs_attention';
            batch.message=brand.status==='awaiting_approval'?(unattended(this.config)?standingGrantMessage('generate'):'Approve this visual in Rainfrog, then continue. The next visual will request its own approval.'):`${brand.input.brand_name}: ${brand.message}`;
            return;
          }
        }
        for(let pass=0;brand.phase==='export'&&pass<10&&!this.pauseRequested;pass++){
          await this.invoke('export',batch,brand);
          if(this.preflight?.status!=='ready'){batch.status='needs_attention';batch.message=runtimeFailureMessage();return;}
          if(brand.status==='complete')break;
          if(brand.status!=='running'){batch.status='needs_attention';batch.message=`${brand.input.brand_name}: ${brand.message}`;return;}
          if(pass<9&&!this.pauseRequested)await new Promise(r=>setTimeout(r,this.simulate?1:15000));
        }
        if(this.pauseRequested){batch.status='paused';batch.message='Paused after checkpoint.';return;}
        if(brand.status!=='complete'||brand.phase!=='done'){
          batch.status='needs_attention';batch.message=`${brand.input.brand_name}: downloads are not complete. Resume this brand before the next one starts.`;return;
        }
      }
      batch.status='complete';batch.message='All brands generated and downloaded.';
    } catch(error) { batch.status='needs_attention'; batch.message=error.message; this.log('error',error.message); }
    finally {
      this.busy=false;this.activeBatchId=null;
      const continueRequested=batch.resumeAfterApproval&&!this.pauseRequested&&this.preflight?.status==='ready'&&batch.status!=='complete';
      batch.resumeAfterApproval=false;await this.save(batch);
      if(continueRequested)queueMicrotask(()=>this.resume(id).catch(e=>this.log('error',e.message)));
    }
  }
  async approved(id) {
    const batch=this.batches.find(b=>b.id===id);if(!batch)throw new Error('Batch not found.');
    if(batch.status==='closed')throw new Error('This batch is closed.');
    if(!batch.brands.some(b=>b.status==='awaiting_approval'))throw new Error('No approval requests are waiting in this batch.');
    if(unattended(this.config)&&!this.busy){
      const pending=batch.brands.find(b=>b.status==='awaiting_approval'),action=permissionStep(pending.phase);
      await this.check();
      if(this.preflight?.status!=='ready'||this.rainfrogPermissions?.actions[action]!=='allow')throw new Error(standingGrantMessage(action));
    }
    if(this.busy){
      if(this.activeBatchId!==id)throw new Error('Wait for the connection check or other batch to finish.');
      batch.resumeAfterApproval=true;await this.save(batch);this.log('approval','Continue queued: saved approvals will be rechecked after the current worker finishes.');return;
    }
    return this.resume(id);
  }
  async refreshApproval(id,brandId){
    if(this.busy)throw new Error('Wait for the current worker before refreshing an approval.');
    const batch=this.batches.find(b=>b.id===id),brand=batch?.brands.find(b=>b.id===brandId);
    if(!brand||batch.status==='closed')throw new Error('Open batch and brand not found.');
    if(brand.phase!=='prepare'||(brand.status!=='awaiting_approval'&&!brand.approvalRenewalBlocked))throw new Error('Only a pending canvas-setup approval can be refreshed here.');
    if(this.simulate)throw new Error('Approval refresh is for live Rainfrog requests only.');
    const prior=structuredClone(brand.result);this.busy=true;this.activeBatchId=id;
    brand.approvalRenewalBlocked=false;brand.approvalRefreshNeeded=true;brand.message='Refreshing the saved canvas-setup approval. Projects, products and templates are being reused.';await this.save(batch);
    try{
      let knownCredentials=prior.approvals;
      try{knownCredentials=[...knownCredentials,...recordedApprovalCredentials(JSON.parse(await readFile(path.join(this.dir(batch,brand),'manifest.json'),'utf8')))];}catch{}
      const r=await this.worker({prompt:setupApprovalRefreshPrompt(batch,brand,randomUUID()),cwd:this.dir(batch,brand),config:this.config,log:this.log.bind(this)});
      if(r.projectId!==prior.projectId||r.spentCredits!==prior.spentCredits||r.plannedCredits!==prior.plannedCredits)throw new Error('Approval refresh changed the saved project or credits. Review checkpoint before resuming.');
      if(r.status==='awaiting_approval'&&(!r.approvals.length||r.approvals.some(a=>knownCredentials.some(old=>sameApprovalCredential(old,a)))))throw new Error('Rainfrog returned the previous approval instead of a fresh link.');
      if(isApprovalRenewalFailure(r.summary))throw new Error(r.summary);
      if(!['awaiting_approval','needs_attention'].includes(r.status))throw new Error('Approval refresh must not advance to generation.');
      brand.result={...prior,...r,outputs:prior.outputs,approvals:r.approvals.map(a=>({...a,kind:'canvas_edit',receivedAt:new Date().toISOString()}))};
      brand.approvalRefreshNeeded=false;
      brand.status=r.status;brand.message=r.summary;batch.status=r.status;
      batch.message=r.status==='awaiting_approval'?'Fresh canvas-setup approval ready. Approve it now, then continue.':'Review the saved setup status, then Resume to verify and quote.';
    }catch(e){
      brand.message=e.message;
      if(isApprovalRenewalFailure(e.message)){brand.approvalRenewalBlocked=true;brand.approvalRefreshNeeded=true;brand.status='needs_attention';batch.status='needs_attention';batch.message=APPROVAL_RENEWAL_BLOCKED;}
      this.log('error',e.message);
    }
    finally{this.busy=false;this.activeBatchId=null;await this.save(batch);}
  }
  async resume(id, maxCredits) {
    const batch=this.batches.find(b=>b.id===id); if(!batch)throw new Error('Batch not found.');
    if(batch.status==='closed')throw new Error('This batch is closed.');
    if (this.busy) throw new Error('A worker is already active.');
    if (maxCredits !== undefined) {
      if (!Number.isSafeInteger(maxCredits)||maxCredits<1)throw new Error('Invalid credit limit.');
      batch.maxCredits=maxCredits;
    }
    // Explicit resume rechecks blocked exports, without creating replacement images.
    for (const b of batch.brands) if (b.phase==='export'&&b.status==='needs_attention') b.status='running';
    await this.save(batch); return this.run(id);
  }
  async fake(phase,batch,brand) {
    await new Promise(r=>setTimeout(r,150));
    const count=brand.input.product_count*(brand.input.shoot_type==='both'?2:1);
    const r={status:'ready',summary:'SIMULATION · Canvas prepared. No remote changes.',projectId:`simulation-${brand.id}`,projectUrl:null,
      plannedCredits:count*30,spentCredits:0,approvals:[],outputs:[],warnings:['Simulation uses placeholder artwork. No brand research or Rainfrog calls.']};
    if(phase==='prepare') {
      const directory=this.dir(batch,brand), products=[], shots=[], nodes=[],edges=[];
      const profile=brand.creativeProfile;
      const brandBrief='SIMULATION: brand research placeholder.';
      if(profile)await writeFile(path.join(directory,'brand-analysis.md'),brandBrief);
      await mkdir(path.join(directory,'source-products'),{recursive:true});
      for(let i=0;i<brand.input.product_count;i++) {
        const productId=`simulation-product-${i+1}`,localFile=`source-products/product-${i+1}.svg`;
        const bytes=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text y="50">SIMULATION ${i+1}</text></svg>`);
        await writeFile(path.join(directory,localFile),bytes);
        products.push({productId,name:`Simulation product ${i+1}`,workspaceId:this.config.productWorkspaceId || this.config.workspaceId,workspaceVerified:true,creationResponse:{simulation:true,id:productId,workspaceId:this.config.productWorkspaceId||this.config.workspaceId},availableImageCount:1,uploadedImageCount:1,images:[{sourceUrl:'https://simulation.invalid/image',localFile,sha256:createHash('sha256').update(bytes).digest('hex')}]});
        for(const kind of brand.input.shoot_type==='both'?['still_life','fashion']:[brand.input.shoot_type==='auto'?'still_life':brand.input.shoot_type]) {
          const nodeId=`${productId}-${kind}`;
          const sceneBrief=`SIMULATION product ${i+1}: styled setting with supporting objects.`;
          const brief=profile?composeScenePrompt(sceneBrief,profile):sceneBrief;
          const shot={productId,nodeId,kind,brief,...(profile?{sceneBrief,pezzoBriefHash:profile.pezzoBriefHash,brandBriefHash:textHash(brandBrief),sceneObjects:Array.from({length:profile.minSupportingObjects},(_,n)=>({object:`Simulation object ${n+1}`,role:'Support the hero'}))}:{})};
          shots.push(shot);
          nodes.push({id:nodeId,type:'generator',data:{preset:PRESETS[kind],...(profile?{aspectRatio:profile.aspectRatio,resolution:profile.resolution}:{})}});
          if(profile){
            const styleId=`${nodeId}-style`,textId=`${nodeId}-text`,productNodeId=`${nodeId}-product`;
            nodes.push({id:styleId,type:'style',data:{customStyleId:profile.styleId}},{id:textId,type:'text',data:{text:brief}},{id:productNodeId,type:'product',data:{productId}});
            if(profile.requireNativeTemplates){
              shot.template={workflowId:profile.nativeTemplates[kind].id,source:'template',idempotencyKey:`simulation-template-${nodeId}`,nodeIds:[nodeId,styleId,textId,productNodeId],receipt:{simulation:true,projectId:r.projectId,operationId:`simulation-operation-${nodeId}`,revision:1,touchedNodeIds:[nodeId,styleId,textId,productNodeId]}};
              shot.planHash=`simulation-plan-${nodeId}`;shot.quote={projectId:r.projectId,nodeId,planHash:shot.planHash,creditCost:30,missingInputs:[]};
            }
            for(const [fromNode,fromHandle,toHandle] of [[styleId,'style','style'],[textId,'text','description'],[productNodeId,'product','products']])edges.push({fromNode,fromHandle,toNode:nodeId,toHandle});
          }
        }
      }
      await atomicJSON(path.join(directory,'manifest.json'),{projectId:r.projectId,workspaceId:this.config.workspaceId,workspaceVerified:true,projectWorkspaceEvidence:{simulation:true,id:r.projectId,workspaceId:this.config.workspaceId},products,shots,canvasSnapshot:{nodes,edges},...(profile?{creativeProfile:profile,brandBriefHash:textHash(brandBrief)}:{})});
    }
    if(phase==='generate') {
      r.status='running';r.spentCredits=count*30;r.summary='SIMULATION · Ready to export placeholders.';
      if(brand.creativeProfile?.styleDelivery==='wired-native'){
        const file=path.join(this.dir(batch,brand),'manifest.json'),manifest=JSON.parse(await readFile(file,'utf8'));
        for(const shot of manifest.shots){
          shot.executionId=`simulation-execution-${shot.nodeId}`;shot.idempotencyKey=`simulation-trigger-${shot.nodeId}`;
          shot.triggerRequest={tool:'trigger_node',projectId:r.projectId,nodeId:shot.nodeId,planHash:shot.planHash,idempotencyKey:shot.idempotencyKey};
          shot.triggerResponse={executionId:shot.executionId,status:'running'};
          shot.execution={executionId:shot.executionId,projectId:r.projectId,nodeId:shot.nodeId,status:'running'};
        }
        await atomicJSON(file,manifest);
      }
    }
    if(phase==='export') {
      r.status='complete';r.spentCredits=count*30;r.summary='SIMULATION · Placeholder files saved.';
      await mkdir(path.join(this.dir(batch,brand),'visuals'),{recursive:true});
      for(let i=0;i<count;i++){
        const relativePath=`visuals/simulation-${i+1}.svg`;
        await writeFile(path.join(this.dir(batch,brand),relativePath),`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1200" viewBox="0 0 900 1200"><rect width="900" height="1200" fill="#1b2927"/><circle cx="400" cy="430" r="200" fill="#bde6b5"/><path d="M120 80L680 900M260 0L800 800M0 260L560 1000" stroke="#0e1816" stroke-width="70" opacity=".6"/><text x="60" y="900" fill="#eff3e9" font-family="sans-serif" font-size="27">SIMULATION / NO RAINFROG IMAGE</text></svg>`);
        r.outputs.push({relativePath,label:`Simulation ${i+1}`});
      }
    }
    return r;
  }
}

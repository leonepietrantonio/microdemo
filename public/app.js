import { renderApprovalCard } from './approval-ui.js';
import { accessView } from './access-state.js';
const $=id=>document.getElementById(id);
let state=null, csv='', validated=false, lastBatches='', lastLogs='', lastConnection='',briefInfo=null,accessPending=false,accessError='',approvalOpened=false,verifyOnReturn=false,disconnected=false,approvalBatchOnReturn=null,budgetEdited=false;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const statusLabel=s=>({queued:'Queued',working:'Working',running:'Running',ready:'Ready',awaiting_approval:'Approval needed',needs_attention:'Needs attention',complete:'Complete',closed:'Closed',paused:'Paused',error:'Error'}[s]||s);
function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('toast').hidden=true,6500);}
async function api(route,data){const res=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':state.csrf},body:JSON.stringify(data||{})});const json=await res.json();if(!res.ok)throw new Error(json.error||'Request failed.');return json;}
function fileURL(batch,brand,relative,download=false){return '/files/'+[batch.id,'brands',brand.id,...relative.split('/')].map(encodeURIComponent).join('/')+(download?'?download=1':'');}
function permissionReady(){return state.rainfrogPermissions?.studioEnabled===true&&['read','add','edit','generate'].every(k=>state.rainfrogPermissions?.actions?.[k]==='allow');}
function brandSummary(brand){
  if(brand.status==='complete')return `${brand.result?.outputs?.length||0} visuals downloaded.`;
  if(brand.status==='queued')return 'Waiting to research.';
  if(brand.status==='ready')return 'Prepared and ready to generate.';
  if(brand.status==='needs_attention'||brand.status==='awaiting_approval'){
    if(brand.status==='awaiting_approval')return brand.phase==='prepare'?'Approve the canvas setup below to continue.':'Approve this visual below to generate it.';
    if(/permission|approval|persistent|grant/i.test(brand.message))return 'Rainfrog approval needs attention. Your saved work is preserved.';
    if(/aspect ratio|dimensions|3:4/i.test(brand.message))return 'Images saved. Output dimensions need review.';
    return 'This brand needs attention. Open Details below.';
  }
  return ({prepare:'Researching the brand and preparing its products.',generate:'Generating visuals.',export:'Downloading visuals.'})[brand.phase]||brand.message;
}
function batchSummary(batch){
  if(batch.status==='closed')return 'Closed. Saved work is preserved.';
  if(/permission|approval|persistent|grant/i.test(batch.message)&&state.config.approvalMode==='standing-grants')return 'Waiting for access. Complete the Rainfrog access step above.';
  return batch.message;
}
function renderBatches(){
  const signature=JSON.stringify([state.batches,state.busy,state.preflight?.status,state.rainfrogPermissions,disconnected]);if(signature===lastBatches)return;lastBatches=signature;
  $('batch-count').textContent=`${state.batches.length} ${state.batches.length===1?'run':'runs'}`;
  if(!state.batches.length)return;
  $('batch-list').innerHTML=state.batches.map((batch,index)=>{
    const planned=batch.brands.reduce((s,b)=>s+(b.result?.plannedCredits||0),0),spent=batch.brands.reduce((s,b)=>s+(b.result?.spentCredits||0),0);
    const content=`<article class="batch-card"><div class="batch-header"><div><strong>Batch ${String(state.batches.length-index).padStart(2,'0')}${batch.simulate?' / SIMULATION':''}</strong><span class="subtle">${esc(new Date(batch.createdAt).toLocaleString())} · ${batch.brands.length} brands · quote ${planned} / limit ${batch.maxCredits} · counted ${spent} credits</span></div><div class="batch-actions"><span class="pill status-${esc(batch.status)}">${esc(statusLabel(batch.status))}</span>${(['complete','closed'].includes(batch.status)||(batch.status==='awaiting_approval'&&state.config.approvalMode!=='standing-grants'))?'':`<button class="button secondary compact" data-run="${esc(batch.id)}" ${disconnected||state.busy||state.preflight?.status!=='ready'||batch.brands.some(b=>b.approvalRenewalBlocked)||(state.config.approvalMode==='standing-grants'&&!permissionReady())?'disabled':''}>${batch.status==='queued'?'Start batch':'Resume'} ↗</button>`}${!state.busy&&!['complete','closed'].includes(batch.status)?`<button class="button secondary compact" data-close="${esc(batch.id)}">Close batch</button>`:''}${state.busy&&batch.status==='running'?'<button class="button secondary compact" data-pause>Pause</button>':''}</div></div><div class="batch-message">${esc(batchSummary(batch))}</div>${state.config.approvalMode!=='standing-grants'&&batch.status!=='closed'&&batch.brands.some(b=>b.status==='awaiting_approval')?`<div class="batch-message"><button class="button secondary compact" data-approved="${esc(batch.id)}" ${batch.resumeAfterApproval||state.preflight?.status!=='ready'||batch.brands.some(b=>b.message.startsWith('Refreshing the saved canvas-setup'))||!batch.brands.some(b=>b.status==='awaiting_approval'&&!b.approvalRefreshNeeded&&b.result?.approvals?.length)?'disabled':''}>${batch.resumeAfterApproval?'Continue queued':state.config.approvalMode==='standing-grants'?'Recheck persistent access — continue':batch.brands.some(b=>b.phase==='prepare'&&b.status==='awaiting_approval')?'I’ve approved setup — continue':'I’ve approved — continue'}</button><span class="subtle">Approve in Rainfrog, then return here. We’ll continue automatically; this button is a fallback.</span></div>`:''}${batch.brands.map(brand=>{
      const phase=['prepare','generate','export','done'].indexOf(brand.phase);
      const stages=['Prepare','Generate','Download'];
      const approvals=brand.result?.approvals||[];
      const approvalUI=state.config.approvalMode==='standing-grants'?'':renderApprovalCard(batch,brand,state.busy,state.preflight?.status==='ready');
      return `<div class="brand-card"><div class="brand-card-top"><h3>${esc(brand.input.brand_name)}</h3><span class="pill status-${esc(brand.status)}">${esc(statusLabel(brand.status))}</span></div><div class="stage-list">${stages.map((s,i)=>`<span class="stage ${i<phase?'done':i===phase?'active':''}">${i<phase?'✓':String(i+1).padStart(2,'0')} ${s}</span>`).join('')}</div><p>${esc(brandSummary(brand))}</p>${approvalUI}<details class="brand-details"><summary>Details</summary><p>${esc(brand.message)}</p>${brand.creativeProfile?`<div class="brief-version">Pezzo brief ${esc(brand.creativeProfile.pezzoBriefHash.slice(0,8))} · ${esc(brand.creativeProfile.aspectRatio)} / ${esc(brand.creativeProfile.resolution)} · <a href="${fileURL(batch,brand,'pezzo-brief.md')}" target="_blank" rel="noopener">View brief used</a></div>`:''}${brand.instagramEvidenceHash?`<div class="brief-version">Instagram ${brand.phase==='prepare'?'captured':'reviewed'} · <a href="${fileURL(batch,brand,'instagram-research/profile.png')}" target="_blank" rel="noopener">Profile capture</a>${brand.phase!=='prepare'?` · <a href="${fileURL(batch,brand,'instagram-analysis.json')}" target="_blank" rel="noopener">Visual analysis</a>`:''}</div>`:''}${brand.result?.warnings?.length?`<p>${brand.result.warnings.map(esc).join(' · ')}</p>`:''}${brand.result?.projectUrl?`<a class="report-link" href="${esc(brand.result.projectUrl)}" target="_blank" rel="noopener noreferrer">Open Rainfrog project ↗</a>`:brand.result?.projectId?`<p>Rainfrog project ID: ${esc(brand.result.projectId)}</p>`:''}</details>${brand.result?.outputs?.length?`<div class="output-gallery">${brand.result.outputs.map(o=>`<a href="${fileURL(batch,brand,o.relativePath,true)}" download><img src="${fileURL(batch,brand,o.relativePath)}" loading="lazy" alt="${esc(o.label)}"><span>↓ ${esc(o.label)}</span></a>`).join('')}</div>`:''}</div>`;
    }).join('')}<div class="batch-message"><a class="report-link" href="/files/${encodeURIComponent(batch.id)}/batch-report.csv?download=1" download>↓ Batch report CSV</a> · <span class="subtle">Saved to ${esc(state.config.outputRoot+'/'+batch.id)}</span>${batch.status==='needs_attention'&&!state.busy?`<button class="text-button" data-budget="${esc(batch.id)}">Change credit limit</button>`:''}</div></article>`;
    return ['closed','complete'].includes(batch.status)?`<details class="past-batch"><summary><span>Batch ${String(state.batches.length-index).padStart(2,'0')} · ${batch.brands.map(b=>esc(b.input.brand_name)).join(', ')}</span><span class="pill status-${esc(batch.status)}">${esc(statusLabel(batch.status))}</span></summary>${content}</details>`:content;
  }).join('');
}
function render(){
  $('mode').textContent=state.simulate?'SIMULATION / NO REAL GENERATION':'LIVE MODE';$('mode').classList.toggle('simulation-banner',state.simulate);
  $('style-choice').textContent=state.config.defaultStyle;$('output-choice').textContent=state.config.aspectRatio+' / '+state.config.resolution;$('project-destination').textContent=state.config.workspaceName+' workspace';$('product-destination').textContent=(state.config.productWorkspaceName||state.config.workspaceName)+' workspace';$('output-root').textContent=state.config.outputRoot;$('worker-state').textContent=state.busy?'Worker active':'Idle';
  $('create').disabled=!validated||state.busy||disconnected;
  const view=accessView(state,{pending:accessPending,error:accessError,approvalOpened,disconnected});
  $('permissions-panel').dataset.tone=view.tone;
  $('permissions-panel').setAttribute('aria-busy',String(view.tone==='checking'));
  $('access-icon').textContent=view.icon;
  $('permissions-title').textContent=view.title;
  $('permissions-detail').textContent=view.message;
  $('access-note').textContent=view.note;
  if(view.tone==='checking'&&state.permissionSetup?.startedAt){const seconds=Math.max(0,Math.floor((Date.now()-Date.parse(state.permissionSetup.startedAt))/1000));$('access-note').textContent=`${seconds<60?seconds+'s':Math.floor(seconds/60)+'m '+seconds%60+'s'} elapsed · The result will appear here.`;}
  $('access-badge').textContent=view.badge||({neutral:'Not connected',checking:'Checking',success:'Granted',waiting:'Action needed',error:'Blocked'})[view.tone];
  $('permissions-values').innerHTML=view.rows.map(row=>`<span class="access-permission" data-value="${esc(row.value)}"><span>${esc(row.label)}</span><strong>${esc(row.value==='ask'&&state.config.approvalMode==='per-action'?(row.key==='generate'?'Approve each visual':'Approve each change'):({allow:'✓ Allowed',ask:'Approval required',deny:'× Denied',unknown:'Not checked'})[row.value]||'Not checked')}</strong></span>`).join('');
  $('access-action').textContent=view.button;
  $('access-action').disabled=Boolean(view.disabled)||(state.busy&&!disconnected);
  $('access-action').classList.toggle('secondary',view.tone==='success');
  $('access-action').classList.toggle('primary',view.tone!=='success');
  $('permission-gate').textContent=view.gate;
  $('access-technical-text').textContent=view.technical||'No check has been completed yet.';
  $('access-checked-at').textContent=state.permissionSetup?.checkedAt?'Last checked '+new Date(state.permissionSetup.checkedAt).toLocaleTimeString():'';
  $('open-instagram').disabled=state.busy||state.simulate;
  renderBatches();const logSignature=JSON.stringify(state.logs);if(logSignature!==lastLogs){lastLogs=logSignature;$('logs').innerHTML=state.logs.slice(-60).map(l=>`<div class="log-entry"><span class="log-time">${esc(new Date(l.at).toLocaleTimeString())}</span><span class="log-message">${esc(l.message)}</span></div>`).join('')||'<p class="subtle">The studio is ready when you are.</p>';$('logs').scrollTop=$('logs').scrollHeight;}
}
async function refresh(){try{const res=await fetch('/api/state',{cache:'no-store'});if(!res.ok)throw new Error('Disconnected');const next=await res.json();if(state?.permissionSetup?.approvals?.[0]?.url!==next.permissionSetup?.approvals?.[0]?.url)approvalOpened=false;state=next;disconnected=false;render();}catch{disconnected=true;if(state)render();$('worker-state').textContent='Disconnected';}}
async function validate(){
  csv=$('csv-editor').value;validated=false;$('csv-error').textContent='';
  try{const r=await api('/api/validate',{csv});validated=true;if(!budgetEdited){const estimate=r.brands.reduce((sum,b)=>sum+b.product_count*(b.shoot_type==='both'?2:1)*30,0);$('budget').value=Math.max(state.config.defaultMaxCredits||270,estimate);}$('brand-preview').innerHTML=r.brands.slice(0,20).map((b,i)=>`<div class="brand-preview"><span class="brand-initial">${esc(b.brand_name.slice(0,1))}</span><div class="brand-info">${esc(b.brand_name)}<div class="brand-meta">${esc(new URL(b.website_url).hostname)} · ${esc(b.shoot_type.replaceAll('_',' '))} · ${b.product_count} products</div></div><span class="brand-number">0${i+1}</span></div>`).join('')+(r.brands.length>20?`<p class="helper">Showing the first 20 of ${r.brands.length} brands. All CSV rows will be processed.</p>`:'');$('file-label').textContent=`${r.brands.length} valid brands · ready to create`;}catch(e){$('csv-error').textContent=e.message;$('brand-preview').innerHTML='';}render();
}
async function loadFile(file){if(!file)return;if(file.size>10*1024*1024){toast('CSV must be under 10 MB.');return;}$('csv-editor').value=await file.text();$('file-label').textContent=file.name;await validate();}
$('budget').addEventListener('input',()=>{budgetEdited=true;});
$('csv-file').addEventListener('change',e=>loadFile(e.target.files[0]));
$('dropzone').addEventListener('dragover',e=>{e.preventDefault();$('dropzone').classList.add('drag');});
$('dropzone').addEventListener('dragleave',()=>$('dropzone').classList.remove('drag'));
$('dropzone').addEventListener('drop',e=>{e.preventDefault();$('dropzone').classList.remove('drag');loadFile(e.dataTransfer.files[0]);});
$('edit-toggle').onclick=()=>{$('editor-wrap').hidden=!$('editor-wrap').hidden;if(!$('editor-wrap').hidden)$('csv-editor').focus();};
$('csv-editor').addEventListener('input',()=>{validated=false;$('create').disabled=true;});$('validate').onclick=validate;
async function checkAccess(action){
  if(accessPending||state.busy)return;
  accessPending=true;accessError='';render();
  try{await api('/api/access',{action,consent:action==='enable'?'persistent-edit-generate':undefined});await refresh();}
  catch(e){accessError=e.message;}
  finally{accessPending=false;render();}
}
$('access-action').onclick=async()=>{
  const view=accessView(state,{pending:accessPending,error:accessError,approvalOpened,disconnected});
  if(view.action==='refresh'){accessError='';await refresh();return;}
  if(view.action==='consent'){
    window.open(view.approvalUrl,'_blank','noopener,noreferrer');approvalOpened=true;verifyOnReturn=true;render();return;
  }
  await checkAccess(view.action);
};
function verifyReturnedApproval(){if(approvalBatchOnReturn&&!document.hidden&&!state.busy){const id=approvalBatchOnReturn;approvalBatchOnReturn=null;api('/api/resume-approved',{id}).then(refresh).catch(e=>toast(e.message));return;}if(verifyOnReturn&&!document.hidden&&!state.busy&&!accessPending){verifyOnReturn=false;checkAccess('check');}}
window.addEventListener('focus',verifyReturnedApproval);
document.addEventListener('visibilitychange',verifyReturnedApproval);
$('open-instagram').onclick=async()=>{try{$('open-instagram').disabled=true;await api('/api/instagram/open');toast('Instagram browser opened. Sign in there if requested.');}catch(e){toast(e.message);}finally{await refresh();}};
$('create').onclick=async()=>{try{await api('/api/batches',{csv,maxCredits:Number($('budget').value)});toast('Batch saved. Use Start batch when ready.');await refresh();$('batches').scrollIntoView({behavior:'smooth'});}catch(e){toast(e.message);}};
document.addEventListener('click',async e=>{
  const approvalLink=e.target.closest('[data-approval-batch]');if(approvalLink){approvalBatchOnReturn=approvalLink.dataset.approvalBatch;}
  const refreshApproval=e.target.closest('[data-refresh-approval]'),close=e.target.closest('[data-close]'),run=e.target.closest('[data-run]'),pause=e.target.closest('[data-pause]'),budget=e.target.closest('[data-budget]'),approved=e.target.closest('[data-approved]');
  try{if(refreshApproval){await api('/api/refresh-approval',{id:refreshApproval.dataset.refreshApproval,brandId:refreshApproval.dataset.brand});toast('Requesting a fresh setup approval for this brand only.');await refresh();}if(close){await api('/api/close',{id:close.dataset.close});toast('Batch closed. You can create another batch.');await refresh();}if(approved){await api('/api/resume-approved',{id:approved.dataset.approved});toast(state.busy?'Continue queued after the current worker.':'Rechecking saved approvals.');await refresh();}if(run){await api('/api/run',{id:run.dataset.run});await refresh();}if(pause){await api('/api/pause');await refresh();}if(budget){const value=prompt('New total credit limit for this batch:');if(value!==null){await api('/api/run',{id:budget.dataset.budget,maxCredits:Number(value)});await refresh();}}}catch(error){toast(error.message);}
});
$('clock').textContent=new Date().toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}).toUpperCase();
async function loadBrief(){try{const r=await fetch('/api/brief',{cache:'no-store'});const b=await r.json();if(!r.ok)throw new Error(b.error);briefInfo=b;$('pezzo-editor').value=b.content;$('brief-status').textContent='Saved version '+b.hash.slice(0,8);$('brief-path').textContent='Editable file: '+b.path;}catch(e){$('brief-status').textContent=e.message;}}
$('pezzo-editor').addEventListener('input',()=>$('brief-status').textContent='Unsaved changes');
$('reload-brief').onclick=loadBrief;
$('save-brief').onclick=async()=>{const content=$('pezzo-editor').value;if(!briefInfo){toast('Reload the brief first.');return;}$('save-brief').disabled=true;try{briefInfo=await api('/api/brief',{content,expectedHash:briefInfo.hash});$('brief-status').textContent=$('pezzo-editor').value===content?'Saved '+briefInfo.hash.slice(0,8)+' · used at the next preparation':'Saved previous version; new edits are unsaved';toast('Pezzo brief saved. New preparations will use it.');}catch(e){toast(e.message);$('brief-status').textContent=e.message;}finally{$('save-brief').disabled=false;}};
await refresh();await loadBrief();setInterval(refresh,2500);

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function renderApprovalCard(batch,brand,busy,connected){
  if(['closed','complete'].includes(batch.status))return '';
  const setup=brand.phase==='prepare';
  if(brand.approvalRenewalBlocked)return `<div class="approval-card"><strong>Approval link needs renewal</strong><p>Rainfrog returned an expired link. Your saved work is preserved.</p>${setup?`<button class="button secondary compact" data-refresh-approval="${esc(batch.id)}" data-brand="${esc(brand.id)}" ${busy?'disabled':''}>Request a new setup link</button>`:''}</div>`;
  if(brand.status!=='awaiting_approval')return '';
  const approvals=brand.approvalRefreshNeeded?[]:brand.result?.approvals||[];
  return `<div class="approval-card"><strong>${setup?'Canvas setup approval':'Visual approval required'}</strong><p>${setup?'Approve this canvas change to finish preparation.':'Approve this visual in Rainfrog. The next visual will ask separately.'}</p>${approvals.map((a,i)=>`<a class="button primary compact" href="${esc(a.url)}" target="_blank" rel="noopener noreferrer" data-approval-batch="${esc(batch.id)}">${setup?'Approve setup':approvals.length>1?'Approve visual '+(i+1):'Approve visual'} ↗</a>`).join('')}${setup?`<button class="text-button" data-refresh-approval="${esc(batch.id)}" data-brand="${esc(brand.id)}" ${busy||!connected?'disabled':''}>${approvals.length?'Link expired? Request a new one':'Request a setup approval link'}</button>`:''}</div>`;
}

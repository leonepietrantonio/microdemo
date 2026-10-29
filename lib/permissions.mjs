export function parseRainfrogPermissions(receipt){
  const r=receipt?.structuredContent||receipt;
  if(receipt?.isError||typeof r?.studioEnabled!=='boolean'||!r.actions||['read','add','edit','generate'].some(k=>!['allow','ask','deny'].includes(r.actions[k])))throw new Error('Rainfrog permission state was not verified.');
  return {studioEnabled:r.studioEnabled,actions:{...r.actions}};
}
export function permissionStep(phase){return phase==='prepare'?'edit':'generate';}
export function standingGrantMessage(action){return `Persistent Rainfrog ${action==='edit'?'Edit':'Generate'} access is required for unattended execution. Approve once authorizes only an individual request. Configure persistent Edit and Generate permissions for the connected Codex client in Rainfrog's permission configuration or backend, then check permissions here. The local app cannot enable these server grants. Saved work is preserved.`;}
export const unattended=config=>config.approvalMode==='standing-grants';

export function persistentAccessReady(permissions){
  return permissions?.studioEnabled===true&&['read','add','edit','generate'].every(k=>permissions.actions?.[k]==='allow');
}

export function permissionSetupPrompt(){return `The current phase is permissions.
The user clicked Enable automatic access in the local permission setup section, BEFORE starting a batch.
They authorize persistent Edit and Generate access for this authenticated Rainfrog Codex integration.
Read get_capabilities first. If the required actions are already allow, do not request them again; verify and return ready.
Inspect the actually exposed MCP tool declarations for a documented permission-management tool.
Use only a tool explicitly designed to request or update persistent permissions, following its real schema.
If available, request Edit=allow and Generate=allow for the CURRENT authenticated integration only.
Preserve Read/Add, Delete, other clients, accounts and workspace restrictions. Do not grant Delete or broader access.
If the tool can only grant broader access than this, do not call it: return needs_attention explaining the limitation.
If a tool returns a real permission consent URL, return it in approvals, with status awaiting_approval. For a permission
request set approvals[].nodeId to 'edit', 'generate', or 'edit,generate' according to the ACTUAL requested actions;
these are permission scope labels, not canvas nodes. Request only actions that still need consent. If the tool requires
separate requests, return both real links with their correct scope labels. Never reuse an edit-only consent as generate.
Never fabricate URLs, endpoints, tools, Always allow controls, or local success flags.
If NO supported permission tool is exposed, return needs_attention with this clear explanation:
Rainfrog does not expose a persistent-permission request tool. Its backend must expose an owner consent flow for Edit and Generate before this button can enable access.
Do not create or edit projects, products, canvas nodes or templates; do not preview or trigger generation, spend credits,
change OAuth files, click browser controls, or use private HTTP endpoints. No batch should be started or resumed.
At the end call get_capabilities again and save the COMPLETE fresh real result in the permission proof file specified below,
even if the permission tool is unavailable or consent is pending. Return ready ONLY if studioEnabled=true and
Read/Add/Edit/Generate are all allow. Approve once is not a persistent grant. All credit counts must be zero,
projectId/projectUrl null, outputs empty. This step only configures permissions; the user starts the batch separately.
Return the required structured worker result.`;}

export function pendingPermissionApprovals(approvals,permissions){
  return approvals.filter(a=>{const scopes=String(a.nodeId||'').split(',');return !scopes.every(s=>['edit','generate'].includes(s)&&permissions?.actions?.[s]==='allow');});
}

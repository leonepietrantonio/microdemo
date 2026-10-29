import test from 'node:test';
import assert from 'node:assert/strict';
import {accessView} from '../public/access-state.js';
import {renderApprovalCard} from '../public/approval-ui.js';
import {pendingPermissionApprovals} from '../lib/permissions.mjs';

const state=(actions={},extra={})=>({rainfrogPermissions:{studioEnabled:true,actions:{read:'allow',add:'allow',edit:'ask',generate:'ask',...actions}},...extra});
test('access screen distinguishes not granted, explicitly denied, and verified success',()=>{
  const pending=accessView(state());assert.equal(pending.tone,'waiting');assert.equal(pending.title,'Permission not granted yet');assert.equal(pending.action,'enable');
  const denied=accessView(state({edit:'deny'}));assert.equal(denied.tone,'error');assert.equal(denied.title,'Access denied');assert.match(denied.message,/denied canvas editing/);assert.equal(denied.action,'check');
  const ready=accessView(state({edit:'allow',generate:'allow'},{preflight:{status:'ready'}}));assert.equal(ready.tone,'success');assert.equal(ready.title,'Ready to start');assert.match(ready.gate,/Access granted/);
});
test('permissions alone never show ready when connection verification failed',()=>{
  const view=accessView(state({edit:'allow',generate:'allow'},{preflight:{status:'needs_attention'}}));assert.equal(view.title,'Permissions granted');assert.equal(view.action,'check');assert.notEqual(view.tone,'success');
});
test('checking feedback is immediate and replaces an old success state',()=>{
  const prior=state({edit:'allow',generate:'allow'},{preflight:{status:'ready'}});
  assert.equal(accessView(prior,{pending:true}).tone,'checking');
  const checking=accessView({...prior,permissionSetup:{status:'checking',stage:'connection'}});assert.match(checking.title,/Checking/);assert.equal(checking.disabled,true);
});
test('unsupported server controls show a useful result without confusing Ask with Deny',()=>{
  const view=accessView(state({}, {permissionSetup:{status:'blocked',summary:'Rainfrog does not expose a persistent-permission request tool.'}}));assert.equal(view.title,'Waiting for the Rainfrog update');assert.equal(view.tone,'waiting');assert.equal(view.button,'Try again');assert.ok(view.rows.every(r=>r.value==='ask'));
});
test('approval has one contextual action and changes to checking after the user returns',()=>{
  const s=state({}, {permissionSetup:{status:'awaiting_authorization',approvals:[{url:'https://app.rainfrog.ai/agent/approve/example'}]}});
  assert.equal(accessView(s).action,'consent');assert.equal(accessView(s).button,'Approve in Rainfrog ↗');assert.equal(accessView(s,{approvalOpened:true}).button,'Check approval');
});
test('local disconnect and request errors stay visible on the card',()=>{
  assert.equal(accessView(state(),{disconnected:true}).title,'Local app disconnected');
  const failure=accessView(state(),{error:'Request failed'});assert.equal(failure.title,'Couldn’t check access');assert.equal(failure.message,'Request failed');
});
test('individual approval mode allows a verified connection with Ask and never offers persistent access',()=>{
  const s=state({}, {config:{approvalMode:'per-action'},preflight:{status:'ready'}});
  const view=accessView(s);assert.equal(view.title,'Ready to start');assert.equal(view.action,'check');assert.match(view.message,/Individual approvals/);assert.match(view.note,/Each visual/);
  assert.equal(accessView({...s,rainfrogPermissions:{studioEnabled:true,actions:{read:'allow',add:'allow',edit:'deny',generate:'ask'}}}).title,'Access denied');
});
test('visual approval is a visible action card rather than hidden technical details',()=>{
  const brand={phase:'generate',status:'awaiting_approval',result:{approvals:[{url:'https://app.rainfrog.ai/agent/approve/one'}]}};
  const html=renderApprovalCard({id:'batch',status:'awaiting_approval'},brand,false,true);
  assert.match(html,/Approve visual/);assert.match(html,/data-approval-batch="batch"/);assert.doesNotMatch(html,/<details|persistent|Always allow/);
  assert.equal(renderApprovalCard({id:'batch',status:'closed'},brand,false,true),'');
});
test('separate pre-batch edit and generate consents advance past the scope already granted',()=>{
  const links=[{nodeId:'edit',url:'https://app.rainfrog.ai/agent/approve/edit'},{nodeId:'generate',url:'https://app.rainfrog.ai/agent/approve/generate'}];
  const remaining=pendingPermissionApprovals(links,{actions:{edit:'allow',generate:'ask'}});
  assert.deepEqual(remaining,[links[1]]);
  const view=accessView(state({edit:'allow'},{config:{approvalMode:'standing-grants'},preflight:{status:'ready'},permissionSetup:{status:'awaiting_authorization',approvals:remaining}}));
  assert.equal(view.action,'consent');assert.equal(view.approvalUrl,links[1].url);assert.notEqual(view.tone,'success');
  assert.deepEqual(pendingPermissionApprovals(links,{actions:{edit:'allow',generate:'allow'}}),[]);
});

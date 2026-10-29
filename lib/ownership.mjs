// Ownership comes from returned entity metadata, never from a requested destination,
// an asset URL, or a client-side boolean alone. Candidates are ordered newest first.
export function workspaceFromEntityEvidence(entityId,candidates,{simulation=false}={}){
  for(let receipt of candidates){
    if(!receipt||typeof receipt!=='object'||receipt.isError)continue;
    if(!receipt.structuredContent&&Array.isArray(receipt.content)){
      try{receipt=JSON.parse(receipt.content.find(c=>c.type==='text')?.text);}catch{continue;}
    }
    const payload=receipt.structuredContent||receipt;
    if(!payload||payload.error||payload.error_code||(payload.simulation&&!simulation))continue;
    const entity=payload.project||payload.product||payload.asset||payload;
    const id=entity.projectId||entity.productId||entity.assetId||entity.id;
    if(id!==entityId)continue;
    if(Object.hasOwn(entity,'workspaceId'))return entity.workspaceId===null?'personal':entity.workspaceId;
    if(entity.workspace&&typeof entity.workspace.id==='string')return entity.workspace.id;
  }
  return undefined;
}

export const projectOwnershipEvidence=m=>[m.projectReadResponse,m.projectWorkspaceEvidence,m.projectEvidence,m.projectCreation,m.projectCreationResponse];
export const productOwnershipEvidence=p=>[p.productReadResponse,p.ownershipEvidence,p.workspaceEvidence,p.moveResponse,p.creationResponse,p.createProductResponse];

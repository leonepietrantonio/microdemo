import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { textHash, composeScenePrompt } from './creative.mjs';
import { verifyInstagramAnalysis } from './instagram.mjs';
import { workspaceFromEntityEvidence,projectOwnershipEvidence,productOwnershipEvidence } from './ownership.mjs';

export const PRESETS = { still_life: 'product-still-life', fashion: 'fashion-shooting' };
export const MAX_PRODUCT_IMAGES = 6;

export async function verifyNativeExecutions(directory,projectId,profile,status){
  if(profile?.styleDelivery!=='wired-native')return;
  const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json'),'utf8'));
  let accepted=0;
  for(const shot of manifest.shots||[]){
    if(!shot.executionId)continue;
    accepted++;
    const request=shot.triggerRequest,response=shot.triggerResponse?.structuredContent||shot.triggerResponse,execution=shot.execution?.structuredContent||shot.execution;
    // The exact saved request owns the idempotency key. A redundant shot-level
    // copy is optional, but conflicting copies must still fail verification.
    if(request?.tool!=='trigger_node'||request.projectId!==projectId||request.nodeId!==shot.nodeId||request.planHash!==shot.planHash||!request.idempotencyKey||(shot.idempotencyKey!=null&&request.idempotencyKey!==shot.idempotencyKey)||response?.executionId!==shot.executionId||shot.triggerResponse?.isError||shot.execution?.isError||execution?.executionId!==shot.executionId||execution.projectId!==projectId||execution.nodeId!==shot.nodeId)throw new Error('Generation must be an execution of the exact wired native generator node, verified by its trigger request and execution metadata.');
  }
  if(status==='running'&&!accepted)throw new Error('No accepted native generator execution was recorded.');
}

export async function verifyPreparation(directory, input, projectId, verifyFiles, simulate = false, expectedWorkspaceId, profile, instagramRequired=false) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if(instagramRequired){
    if(!manifest.instagramEvidenceHash)throw new Error('Preparation must use the captured Instagram evidence version.');
    const {sha256}=await verifyInstagramAnalysis(directory,input);
    if(manifest.instagramEvidenceHash!==sha256)throw new Error('Preparation must use the captured Instagram evidence version.');
  }
  if (manifest.projectId !== projectId) throw new Error('Preparation checkpoint does not match the Rainfrog project.');
  if (!Array.isArray(manifest.products) || manifest.products.length !== input.product_count) throw new Error('Checkpoint must contain one Rainfrog product per selected website product.');
  if(profile?.requireSameWorkspace){
    if(profile.productWorkspaceId!==profile.workspaceId||expectedWorkspaceId!==profile.workspaceId||manifest.workspaceId!==profile.workspaceId)throw new Error('The native project and all selected products must belong to the same verified workspace.');
    const actual=workspaceFromEntityEvidence(projectId,projectOwnershipEvidence(manifest),{simulation:simulate});
    if(actual===undefined)throw new Error('Missing server ownership evidence for the native project. Save its creation/read response with matching project ID and workspaceId.');
    if(actual!==profile.workspaceId)throw new Error('The native project ownership response identifies a different workspace.');
  }
  const products = new Map();
  for (const product of manifest.products) {
    if (!product.productId || products.has(product.productId)) throw new Error('Each website product must have its own unique Rainfrog product ID.');
    products.set(product.productId, product);
    if (!Number.isInteger(product.availableImageCount) || product.availableImageCount < 1) throw new Error(`${product.name}: missing gallery image count.`);
    const count = Math.min(MAX_PRODUCT_IMAGES, product.availableImageCount);
    if (!Array.isArray(product.images) || product.images.length !== count) throw new Error(`${product.name}: download all eligible gallery images, up to ${MAX_PRODUCT_IMAGES} (expected ${count}).`);
    if (product.uploadedImageCount !== count) throw new Error(`${product.name}: all ${count} downloaded images must be uploaded into the same Rainfrog product.`);
    await verifyFiles(directory, {status:'ready', outputs:product.images.map(image => ({relativePath:image.localFile,label:product.name}))}, count, simulate);
    const hashes = new Set();
    for (const image of product.images) {
      const hash = createHash('sha256').update(await readFile(path.resolve(directory, image.localFile))).digest('hex');
      if (hash !== image.sha256) throw new Error(`${product.name}: downloaded image checksum does not match the checkpoint.`);
      if (hashes.has(hash)) throw new Error(`${product.name}: duplicate gallery photos must not occupy multiple upload slots.`);
      hashes.add(hash);
    }
    const productWorkspace=profile?.requireSameWorkspace?workspaceFromEntityEvidence(product.productId,productOwnershipEvidence(product),{simulation:simulate}):product.workspaceVerified===true?product.workspaceId:undefined;
    if (expectedWorkspaceId && (productWorkspace !== expectedWorkspaceId || (product.workspaceId!==undefined&&product.workspaceId!==expectedWorkspaceId))) {
      throw new Error(`${product.name}: product ownership in the target workspace (${expectedWorkspaceId}) is not verified. Verify the configured product library or use supported workspace creation/move tools. Existing product IDs and images are preserved.`);
    }
  }
  const graph = manifest.canvasSnapshot?.structuredContent || manifest.canvasSnapshot;
  if (!Array.isArray(graph?.nodes)) throw new Error('Missing verified Rainfrog canvas snapshot.');
  const expected = input.product_count * (input.shoot_type === 'both' ? 2 : 1);
  if (!Array.isArray(manifest.shots) || manifest.shots.length !== expected) throw new Error('Checkpoint shot count does not match the requested shoot type.');
  const nodes = new Map(graph.nodes.map(node => [node.id,node]));
  const seen = new Set(), productKinds = new Set(), kinds = new Set(),templateInstances=new Set(),templateNodes=new Set();
  let brandBriefHash;
  if(profile){
    if(manifest.creativeProfile?.pezzoBriefHash!==profile.pezzoBriefHash)throw new Error('Preparation did not record the selected Pezzo brief snapshot.');
    brandBriefHash=textHash(await readFile(path.join(directory,'brand-analysis.md'),'utf8'));
    if(manifest.brandBriefHash!==brandBriefHash)throw new Error('Brand brief hash does not match the saved brand analysis.');
  }
  for (const shot of manifest.shots) {
    const preset = PRESETS[shot.kind], node = nodes.get(shot.nodeId);
    if (!preset || !products.has(shot.productId)) throw new Error('Each shot must identify its selected product and shoot type.');
    if (input.shoot_type !== 'auto' && input.shoot_type !== 'both' && shot.kind !== input.shoot_type) throw new Error('Shot type does not match the CSV shoot_type.');
    if (!node || node.type !== 'generator' || node.data?.preset !== preset) throw new Error(`Wrong generator dropdown for ${shot.kind}: expected ${preset}. Correct the canvas before generating.`);
    if(profile){
      if(node.data.aspectRatio!==profile.aspectRatio||node.data.resolution!==profile.resolution)throw new Error(`Generator must be set to ${profile.aspectRatio} and ${profile.resolution}.`);
      const incoming=(graph.edges||[]).filter(e=>e.toNode===shot.nodeId);
      const source=handle=>incoming.filter(e=>e.toHandle===handle).map(e=>nodes.get(e.fromNode));
      if(!source('style').some(n=>n?.type==='style'&&n.data?.customStyleId===profile.styleId))throw new Error('The selected Line Gobo No Back style must be wired into the actual generator.');
      if(!source('description').some(n=>n?.type==='text'&&n.data?.text===shot.brief&&shot.brief?.trim()))throw new Error('The visual brief must be the text actually connected to this generator.');
      if(profile.styleDelivery==='explicit-user-text')throw new Error('This preparation copied style text. Reprepare it using native wired inputs before generating.');
      if(profile.styleDelivery==='wired-native'){
        if(shot.brief!==composeScenePrompt(shot.sceneBrief,profile))throw new Error('The connected text must contain scene direction only. Rainfrog resolves the selected style internally.');
        if(source('description').length!==1||source('style').length!==1)throw new Error('Each generator requires exactly one unambiguous text input and one selected style.');
        if(source('environment').some(n=>n?.data?.customEnvironmentId||n?.data?.defaultEnvironmentName))throw new Error('The environment selection must remain empty.');
      }
      if(profile.requireNativeTemplates){
        const t=shot.template,expectedTemplate=profile.nativeTemplates?.[shot.kind];
        if(!t||t.workflowId!==expectedTemplate?.id||t.source!=='template'||!t.idempotencyKey||!Array.isArray(t.nodeIds)||!t.nodeIds.includes(shot.nodeId))throw new Error('Each shot must come from its matching native Rainfrog template, with a saved instantiation receipt.');
        const receipt=t.receipt?.structuredContent||t.receipt;
        if(!receipt||typeof receipt!=='object'||t.receipt.isError||receipt.isError||receipt.error||receipt.error_code||(!simulate&&receipt.simulation)||receipt.projectId!==projectId||!receipt.operationId||!Number.isInteger(receipt.revision)||!Array.isArray(receipt.touchedNodeIds)||t.nodeIds.some(id=>!receipt.touchedNodeIds.includes(id)))throw new Error('Native template instantiation failed or its receipt is missing. Never rebuild the graph as a fallback.');
        if(templateInstances.has(t.idempotencyKey)||new Set(t.nodeIds).size!==t.nodeIds.length||t.nodeIds.some(id=>!nodes.has(id)||templateNodes.has(id)))throw new Error('Each shot requires a distinct native template instance containing real canvas nodes.');
        templateInstances.add(t.idempotencyKey);t.nodeIds.forEach(id=>templateNodes.add(id));
        const q=shot.quote?.structuredContent||shot.quote;
        if(!q||shot.quote.isError||q.error||q.error_code||q.nodeId!==shot.nodeId||q.projectId!==projectId||!q.planHash||q.planHash!==shot.planHash||!Number.isFinite(q.creditCost)||q.creditCost<0||!Array.isArray(q.missingInputs)||q.missingInputs.length)throw new Error('Every native generator requires a successful matching preview with no missing inputs before generation.');
      }
      const visited=new Set();
      const hasHero=id=>{if(visited.has(id))return false;visited.add(id);const n=nodes.get(id);if(n?.type==='product')return n.data?.productId===shot.productId;if(n?.type!=='fullBody'&&n?.type!=='outfitSheet')return false;return (graph.edges||[]).filter(e=>e.toNode===id&&e.toHandle==='products').some(e=>hasHero(e.fromNode));};
      const heroConnected=source('products').some(n=>n?.type==='product'&&n.data?.productId===shot.productId)||(profile.requireNativeTemplates&&incoming.filter(e=>e.toHandle==='character').some(e=>hasHero(e.fromNode)));
      if(!heroConnected)throw new Error('The hero product must be connected to the actual generator, directly or through its native character-preparation graph.');
      if(profile.requireNativeTemplates&&shot.kind==='fashion'&&!simulate){
        const helperNodes=(shot.template.nodeIds||[]).map(id=>nodes.get(id)).filter(n=>n?.type==='fullBody');
        if(!helperNodes.length||!helperNodes.some(n=>(graph.edges||[]).filter(e=>e.toNode===n.id&&e.toHandle==='model').some(e=>nodes.get(e.fromNode)?.data?.modelId)))throw new Error('The native Fashion Shooting template requires its character/model binding.');
      }
      if(shot.pezzoBriefHash!==profile.pezzoBriefHash||shot.brandBriefHash!==brandBriefHash)throw new Error('Each visual must reference both its Pezzo and brand brief versions.');
      if(!Array.isArray(shot.sceneObjects)||shot.sceneObjects.length<profile.minSupportingObjects||shot.sceneObjects.some(p=>!p.object?.trim()||!p.role?.trim()))throw new Error(`A rich editorial scene requires at least ${profile.minSupportingObjects} purposeful supporting objects.`);
    }
    const key = `${shot.productId}:${shot.kind}`;
    if (seen.has(shot.nodeId) || productKinds.has(key)) throw new Error('Each product/shoot pair must use one distinct generator.');
    seen.add(shot.nodeId); productKinds.add(key); kinds.add(shot.kind);
  }
  if (input.shoot_type === 'auto' && kinds.size !== 1) throw new Error('Auto must choose one consistent shoot type for this brand.');
  for (const id of products.keys()) {
    if (input.shoot_type === 'both') {
      if (!productKinds.has(`${id}:still_life`) || !productKinds.has(`${id}:fashion`)) throw new Error('Both mode requires a still-life and fashion generator for every product.');
    } else if (![...kinds].some(kind => productKinds.has(`${id}:${kind}`))) throw new Error('Every selected product must have a generator.');
  }
  return manifest;
}

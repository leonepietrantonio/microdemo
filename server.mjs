import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Engine, within } from './lib/engine.mjs';
import { validateBrands } from './lib/csv.mjs';
import { readBrief, saveBrief } from './lib/creative.mjs';
import { InstagramBrowser } from './lib/instagram.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const configPath=process.env.MICRODEMO_CONFIG_PATH ? path.resolve(process.env.MICRODEMO_CONFIG_PATH) : path.join(root,'config.json');
const config=JSON.parse(await readFile(configPath,'utf8'));
const port=Number(process.env.PORT || config.port);
const simulate=process.argv.includes('--simulate');
const dataRoot=path.join(process.env.MICRODEMO_DATA_DIR ? path.resolve(process.env.MICRODEMO_DATA_DIR) : path.join(root,'data'),simulate?'simulation':'live');
const briefPath=process.env.MICRODEMO_BRIEF_PATH ? path.resolve(process.env.MICRODEMO_BRIEF_PATH) : path.resolve(root,config.pezzoBriefPath||'PEZZO_BRIEF.md');
const instagram=new InstagramBrowser(path.join(dataRoot,'instagram-browser'));
const engine=new Engine(dataRoot,config,{simulate,briefPath,instagram}); await engine.init();
const csrf=randomBytes(24).toString('hex');
const mime={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.csv':'text/csv; charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.avif':'image/avif','.svg':'image/svg+xml','.md':'text/plain; charset=utf-8','.txt':'text/plain; charset=utf-8'};
function json(res,status,data){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
async function body(req){let size=0,chunks=[];for await(const chunk of req){size+=chunk.length;if(size>20*1024*1024)throw new Error('CSV/request exceeds 20 MB.');chunks.push(chunk);}return JSON.parse(Buffer.concat(chunks).toString()||'{}');}
async function serveFile(res,base,relative,download=false){
  const resolved=await realpath(path.resolve(base,relative)),realBase=await realpath(base);
  if(!within(realBase,resolved)||!(await stat(resolved)).isFile())throw new Error('File not found.');
  const ext=path.extname(resolved).toLowerCase();
  res.writeHead(200,{'Content-Type':mime[ext]||'application/octet-stream','X-Content-Type-Options':'nosniff','Cache-Control':'no-store',
    ...(download?{'Content-Disposition':`attachment; filename="${path.basename(resolved).replace(/["\r\n]/g,'_')}"`}:{})});
  res.end(await readFile(resolved));
}
const server=http.createServer(async(req,res)=>{
  // Only loopback, same-origin UI requests. No arbitrary shell commands or filesystem paths accepted.
  const host=req.headers.host;
  if(host!==`127.0.0.1:${port}`&&host!==`localhost:${port}`){json(res,403,{error:'Local access only.'});return;}
  res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try{
    const url=new URL(req.url,`http://${host}`),route=url.pathname;
    if(req.method==='GET'&&route==='/api/state'){json(res,200,{...engine.snapshot(),csrf});return;}
    if(req.method==='GET'&&route==='/api/brief'){json(res,200,await readBrief(briefPath));return;}
    if(req.method==='POST'){
      if(req.headers['x-csrf-token']!==csrf || (req.headers.origin&&req.headers.origin!==`http://${host}`)){json(res,403,{error:'Refresh the dashboard and try again.'});return;}
      const input=await body(req);
      if(route==='/api/brief'){json(res,200,await saveBrief(briefPath,input.content,input.expectedHash));return;}
      if(route==='/api/instagram/open'){
        if(simulate)throw new Error('Instagram browser is disabled in simulation mode.');
        if(engine.busy)throw new Error('Wait for the current research step to finish before opening the browser.');
        await instagram.open();json(res,200,{ok:true});return;
      }
      if(route==='/api/validate'){json(res,200,{brands:validateBrands(input.csv,config)});return;}
      if(route==='/api/check'){
        if(engine.busy)throw new Error('A worker is already active.');
        engine.check().catch(e=>engine.log('error',e.message));json(res,202,{ok:true});return;
      }
      if(route==='/api/permissions/enable'){
        if(config.approvalMode!=='standing-grants')throw new Error('Individual approvals are enabled. Check the connection to start.');
        if(input.consent!=='persistent-edit-generate')throw new Error('Select the persistent Edit and Generate permission consent first.');
        if(engine.busy)throw new Error('A worker is already active.');
        engine.enablePermissions().catch(e=>engine.log('error',e.message));json(res,202,{ok:true});return;
      }
      if(route==='/api/access'){
        if(engine.busy)throw new Error('A worker is already active.');
        if(!['enable','check'].includes(input.action))throw new Error('Unknown access action.');
        if(input.action==='enable'&&config.approvalMode!=='standing-grants')throw new Error('Individual approvals are enabled. Check the connection to start.');
        if(input.action==='enable'&&input.consent!=='persistent-edit-generate')throw new Error('Automatic access requires permission to edit canvases and generate images.');
        const work=input.action==='enable'?engine.enablePermissions():engine.check();
        work.catch(e=>engine.log('error',e.message));json(res,202,{ok:true});return;
      }
      if(route==='/api/batches'){const batch=await engine.create(input.csv,Number(input.maxCredits));json(res,201,{id:batch.id});return;}
      if(route==='/api/close'){const batch=await engine.close(input.id);json(res,200,{id:batch.id,status:batch.status});return;}
      if(route==='/api/refresh-approval'){
        if(engine.busy)throw new Error('Wait for the current worker.');
        const batch=engine.batches.find(b=>b.id===input.id),brand=batch?.brands.find(b=>b.id===input.brandId);
        if(!brand||batch.status==='closed'||brand.phase!=='prepare'||(brand.status!=='awaiting_approval'&&!brand.approvalRenewalBlocked))throw new Error('No pending canvas-setup approval found.');
        engine.refreshApproval(input.id,input.brandId).catch(e=>engine.log('error',e.message));json(res,202,{ok:true});return;
      }
      if(route==='/api/run'){
        if(engine.busy)throw new Error('A worker is already active.');
        if(engine.preflight?.status!=='ready')throw new Error('Check the Rainfrog connection first.');
        if(!engine.batches.some(b=>b.id===input.id))throw new Error('Batch not found.');
        engine.resume(input.id,input.maxCredits===undefined?undefined:Number(input.maxCredits)).catch(e=>engine.log('error',e.message));json(res,202,{ok:true});return;
      }
      if(route==='/api/resume-approved'){
        if(engine.preflight?.status!=='ready')throw new Error('Check the Rainfrog connection first.');
        if(!engine.batches.some(b=>b.id===input.id))throw new Error('Batch not found.');
        engine.approved(input.id).catch(e=>engine.log('error',e.message));json(res,202,{ok:true});return;
      }
      if(route==='/api/pause'){engine.pause();json(res,200,{ok:true});return;}
      throw new Error('Unknown action.');
    }
    if(req.method!=='GET'){json(res,405,{error:'Method not allowed.'});return;}
    if(route==='/sample.csv'){await serveFile(res,root,'brands.csv',true);return;}
    if(route==='/example.csv'){await serveFile(res,root,'brands.example.csv',true);return;}
    if(route.startsWith('/files/')){
      const relative=decodeURIComponent(route.slice(7));
      // Expose only reports, source photos, and final deliverables, never worker prompts/hidden files.
      if(relative.split(/[\\/]/).some(p=>p.startsWith('.'))||!(/\/(visuals|source-products|instagram-research)\//.test(relative)||/\/(batch-report\.csv|brand-analysis\.md|instagram-analysis\.json|report\.md|manifest\.json|pezzo-brief\.md|creative-direction\.md|creative-profile\.json)$/.test(relative)))throw new Error('File is not a deliverable.');
      await serveFile(res,path.join(dataRoot,'batches'),relative,url.searchParams.has('download'));return;
    }
    if(!['/','/app.js','/access-state.js','/approval-ui.js','/style.css'].includes(route)){json(res,404,{error:'Not found.'});return;}
    await serveFile(res,path.join(root,'public'),route==='/'?'index.html':route.slice(1));
  }catch(error){json(res,error.statusCode||400,{error:error.message});}
});
server.on('error',error=>{console.error(error.code==='EADDRINUSE'?`Port ${port} is already in use. Open http://127.0.0.1:${port} or set PORT to another value.`:error);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log(`\nRainfrog Microdemo${simulate?' [SIMULATION — no real generation]':''}\nhttp://127.0.0.1:${port}\nOutputs: ${dataRoot}/batches\nPress Ctrl+C to stop.\n`));
process.on('SIGINT',()=>{if(engine.busy){engine.pause();console.log('Waiting for the active phase to checkpoint. Press Ctrl+C again to force quit.');process.removeAllListeners('SIGINT');engine.on('change',()=>{if(!engine.busy)server.close(async()=>{await instagram.close();process.exit();});});}else server.close(async()=>{await instagram.close();process.exit();});});

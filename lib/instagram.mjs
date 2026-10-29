import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJSON } from './runner.mjs';

export function instagramProfile(value) {
  const u=new URL(value);
  const parts=u.pathname.split('/').filter(Boolean),handle=parts[0];
  if(u.protocol!=='https:'||!['instagram.com','www.instagram.com'].includes(u.hostname)||parts.length!==1||!handle||!/^[\w.]+$/.test(handle)||['p','reel','reels','accounts','explore','stories','direct'].includes(handle.toLowerCase()))throw new Error('Instagram research requires a public brand profile URL.');
  return {handle,url:`https://www.instagram.com/${handle}/`};
}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');

async function dismissOptionalOverlays(page){
  const decline=page.getByText(/^(Decline optional cookies|Only allow essential cookies|Rifiuta cookie facoltativi)$/).first();
  await decline.waitFor({state:'visible',timeout:5000}).catch(()=>{});
  if(await decline.isVisible())await decline.click();
  const close=page.getByRole('button',{name:/^(Close|Chiudi)$/}).first();
  await close.waitFor({state:'visible',timeout:1500}).catch(()=>{});
  if(await close.isVisible())await close.click();
}

export async function verifyInstagram(directory,input,{simulation=false}={}) {
  const file=path.join(directory,'instagram-research','evidence.json');
  const evidence=JSON.parse(await readFile(file,'utf8'));
  const expected=instagramProfile(input.instagram_url);
  if(evidence.version!==2||evidence.profileUrl!==expected.url||evidence.handle!==expected.handle||evidence.status!=='captured')throw new Error('Instagram profile evidence is missing or belongs to another brand.');
  if(evidence.simulation&&!simulation)throw new Error('Simulated Instagram evidence cannot be used for a real campaign.');
  if(!Array.isArray(evidence.posts)||evidence.posts.length<6||new Set(evidence.posts.map(p=>p.url)).size!==evidence.posts.length)throw new Error('Instagram research requires at least six distinct visually captured posts.');
  const files=[evidence.profileScreenshot,...evidence.posts.map(p=>p.image)];
  for(const entry of files){
    if(!entry||!/^instagram-research\/[a-zA-Z0-9_-]+\.png$/.test(entry.localFile))throw new Error('Invalid Instagram evidence image path.');
    const bytes=await readFile(path.join(directory,entry.localFile));
    if(!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||hash(bytes)!==entry.sha256)throw new Error('Instagram evidence image is missing, invalid or changed.');
  }
  for(const post of evidence.posts){const u=new URL(post.url);if(u.protocol!=='https:'||u.hostname!=='www.instagram.com'||!/^\/(?:[\w.]+\/)?(?:p|reel)\/[\w-]+\/$/.test(u.pathname)||post.unobstructed!==true)throw new Error('Instagram post source or unobstructed capture is not verified.');}
  return {evidence,sha256:hash(await readFile(file))};
}

export async function verifyInstagramAnalysis(directory,input){
  const captured=await verifyInstagram(directory,input),{evidence,sha256}=captured;
  const analysis=JSON.parse(await readFile(path.join(directory,'instagram-analysis.json'),'utf8'));
  const observed=new Set();
  if(analysis.evidenceSha256!==sha256)throw new Error('Instagram analysis does not match the captured profile.');
  for(const item of analysis.posts||[]){
    if(!evidence.posts.some(p=>p.url===item.postUrl&&p.image.localFile===item.imageFile)||typeof item.observations!=='string'||item.observations.trim().length<40)throw new Error('Instagram review requires concrete visual observations tied to captured posts.');
    observed.add(item.postUrl);
  }
  const communication=typeof analysis.communication==='string'?analysis.communication:
    analysis.communication&&typeof analysis.communication==='object'&&!Array.isArray(analysis.communication)?Object.values(analysis.communication).filter(v=>typeof v==='string').join('\n'):'';
  if(observed.size<6||communication.trim().length<100)throw new Error('Review six Instagram post images and explain the brand’s communication codes before preparing visuals.');
  return {...captured,analysis};
}

// A dedicated persistent Chrome profile. Never read/copy cookies from another browser.
// The user can sign in directly in this visible window if Instagram requests it.
export class InstagramBrowser {
  constructor(profileDirectory,{channel='chrome',headless=false,launch}={}){this.profileDirectory=profileDirectory;this.channel=channel;this.headless=headless;this.launch=launch;this.context=null;this.page=null;this.opening=null;this.collecting=false;}
  async open(url='https://www.instagram.com/'){
    if(!this.context){
      if(!this.opening)this.opening=(async()=>{
        const launcher=this.launch||(await import('playwright')).chromium.launchPersistentContext.bind((await import('playwright')).chromium);
        try{this.context=await launcher(this.profileDirectory,{channel:this.channel,headless:this.headless,viewport:{width:1440,height:1100},locale:'en-US'});}
        catch(e){throw new Error(`Instagram browser could not start. Install Google Chrome and run npm install in the app folder. ${e.message}`);}
        this.context.on('close',()=>{this.context=null;this.page=null;});
      })().finally(()=>{this.opening=null;});
      await this.opening;
    }
    if(!this.page||this.page.isClosed())this.page=await this.context.newPage();
    await this.page.goto(url,{waitUntil:'domcontentloaded',timeout:60000});
    return this.page;
  }
  async close(){await this.context?.close();}
  async collect(input,directory,log=()=>{}){
    if(this.collecting)throw new Error('Instagram research is already active.');
    this.collecting=true;
    try{
      const {handle,url}=instagramProfile(input.instagram_url);
      const destination=path.join(directory,'instagram-research');await mkdir(destination,{recursive:true});
      log('research',`Opening @${handle} in the dedicated Instagram browser.`);
      const page=await this.open(url);
      // Cookie/sign-up overlays may render after the feed. Wait for and dismiss only ordinary overlays.
      await dismissOptionalOverlays(page);
      const posts=page.locator('a[href*="/p/"], a[href*="/reel/"]').filter({has:page.locator('img')});
      try{await posts.first().waitFor({state:'visible',timeout:25000});}catch{
        throw new Error(`Instagram @${handle} needs attention. Complete any login or challenge yourself in the open Instagram browser, then Resume. Website-only research is not permitted.`);
      }
      await dismissOptionalOverlays(page);
      if(instagramProfile(page.url()).handle.toLowerCase()!==handle.toLowerCase())throw new Error('Instagram redirected to a different profile. Verify the brand URL before resuming.');
      const evidence={version:2,status:'captured',profileUrl:url,handle,capturedAt:new Date().toISOString(),method:'rendered-browser-screenshots',profileText:(await page.locator('body').innerText()).slice(0,18000),posts:[]};
      async function screenshot(locator,name){const localFile=`instagram-research/${name}.png`;const bytes=await locator.screenshot({path:path.join(directory,localFile),timeout:20000});return {localFile,sha256:hash(bytes)};}
      evidence.profileScreenshot=await screenshot(page,'profile');
      const seen=new Set();
      for(let pass=0;pass<4&&evidence.posts.length<9;pass++){
        const count=await posts.count();
        for(let i=0;i<count&&evidence.posts.length<9;i++){
          const tile=posts.nth(i),href=await tile.getAttribute('href');
          const postUrl=new URL(href,url);postUrl.search='';postUrl.hash='';postUrl.hostname='www.instagram.com';
          if(seen.has(postUrl.href)||!/^\/(?:[\w.]+\/)?(?:p|reel)\/[\w-]+\/$/.test(postUrl.pathname))continue;
          const img=tile.locator('img').first();
          try{
            await tile.scrollIntoViewIfNeeded();
            await img.evaluate(el=>el.decode());
            const unobstructed=await img.evaluate(el=>{const r=el.getBoundingClientRect();return [0.1,0.5,0.9].every(x=>[0.1,0.5,0.9].every(y=>{const top=document.elementFromPoint(r.x+r.width*x,r.y+r.height*y);return top===el||el.closest('a')?.contains(top);}));});
            if(!unobstructed)continue;
            const size=await img.evaluate(el=>({width:el.naturalWidth,height:el.naturalHeight}));
            if(size.width<150||size.height<150)continue;
            const image=await screenshot(tile,`post-${String(evidence.posts.length+1).padStart(2,'0')}`);
            evidence.posts.push({url:postUrl.href,alt:await img.getAttribute('alt')||'',image,unobstructed:true,caption:null,captionStatus:'not opened'});seen.add(postUrl.href);
          }catch{/* Skip unloaded/broken tiles; the minimum evidence gate still applies. */}
        }
        if(evidence.posts.length<9)await page.mouse.wheel(0,800);
      }
      if(evidence.posts.length<6)throw new Error(`Instagram @${handle}: captured only ${evidence.posts.length} posts; six are required. Resolve access in the open browser and Resume. No website-only fallback.`);
      // Read captions for three sampled posts when publicly accessible. Grid screenshots remain visual evidence.
      for(const post of evidence.posts.slice(0,3)){
        try{
          await page.goto(post.url,{waitUntil:'domcontentloaded',timeout:30000});
          await dismissOptionalOverlays(page);
          const article=page.locator('article').first();await article.waitFor({state:'visible',timeout:8000});
          post.caption=(await article.innerText()).slice(0,12000);post.captionStatus=post.caption.trim()?'visible post text':'no visible caption';
        }catch{post.captionStatus='post detail unavailable; grid image visually captured';}
      }
      await atomicJSON(path.join(destination,'evidence.json'),evidence);
      const result=await verifyInstagram(directory,input);
      log('research',`Instagram @${handle}: saved ${evidence.posts.length} post images and profile evidence for mandatory visual analysis.`);
      return result;
    }finally{this.collecting=false;}
  }
}

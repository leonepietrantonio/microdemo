import path from 'node:path';
import { InstagramBrowser,instagramProfile } from '../lib/instagram.mjs';

const url=process.argv[2];
if(!url)throw new Error('Usage: npm run check:instagram -- https://www.instagram.com/brand/');
const {handle}=instagramProfile(url);
const root=process.cwd();
const browser=new InstagramBrowser(path.join(root,'data','instagram-check-browser'));
try{
  const result=await browser.collect({instagram_url:url},path.join(root,'data','instagram-check',handle),(type,message)=>console.log(message));
  console.log(JSON.stringify({status:result.evidence.status,handle,posts:result.evidence.posts.length,evidenceSha256:result.sha256,directory:path.join(root,'data','instagram-check',handle)},null,2));
}finally{await browser.close();}

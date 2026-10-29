import { readFile, writeFile, rename, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';

export const STYLE = { name:'Line Gobo No Back', id:'cmrc7o64n000911beteqo4o6j' };
export const OUTPUT = { aspectRatio:'3:4', resolution:'2K' };
export const NATIVE_TEMPLATES = {
  still_life:{id:'3a7cd1d1-e6c2-4885-96d0-b78d5485f55e',name:'Product Still Life'},
  fashion:{id:'36d57089-806a-4c71-ab49-4d3c22202a9c',name:'Fashion Shooting'}
};
export const textHash = text => createHash('sha256').update(text).digest('hex');

export function composeScenePrompt(sceneBrief,profile){
  if(typeof sceneBrief!=='string'||!sceneBrief.trim())throw new Error('A scene brief is required.');
  if(profile?.styleDelivery==='explicit-user-text')throw new Error('This preparation copied style text. Reprepare it using native wired inputs before generating.');
  return sceneBrief.trim();
}

export async function readBrief(file) {
  const content=await readFile(file,'utf8');
  if(!content.trim()||Buffer.byteLength(content)>50000)throw new Error('Pezzo brief must contain text and fit within 50 KB.');
  const match=content.match(/^Minimum supporting objects:\s*(\d+)\s*$/im);
  const minSupportingObjects=match?Number(match[1]):3;
  if(minSupportingObjects<1||minSupportingObjects>8)throw new Error('Minimum supporting objects must be 1–8.');
  return {content,hash:textHash(content),minSupportingObjects,updatedAt:(await stat(file)).mtime.toISOString(),path:file};
}

export async function saveBrief(file,content,expectedHash) {
  if(typeof content!=='string'||!content.trim()||Buffer.byteLength(content)>50000)throw new Error('Pezzo brief must contain text and fit within 50 KB.');
  const previous=await readBrief(file);
  if(expectedHash!==previous.hash){const e=new Error('The brief changed on disk or in another tab. Reload it before saving.');e.statusCode=409;throw e;}
  const count=content.match(/^Minimum supporting objects:\s*(\d+)\s*$/im);
  if(count&&(Number(count[1])<1||Number(count[1])>8))throw new Error('Minimum supporting objects must be 1–8.');
  const temp=`${file}.${randomUUID()}.tmp`;await writeFile(temp,content,{mode:0o600});await rename(temp,file);
  return readBrief(file);
}

export async function creativeProfile(file,config) {
  const brief=await readBrief(file);
  return {version:3,pezzoBrief:brief.content,pezzoBriefHash:brief.hash,minSupportingObjects:brief.minSupportingObjects,
    styleName:config.defaultStyle||STYLE.name,styleId:config.defaultStyleId||STYLE.id,
    aspectRatio:config.defaultAspectRatio||OUTPUT.aspectRatio,resolution:config.defaultResolution||OUTPUT.resolution,
    styleDelivery:'wired-native',requireSameWorkspace:true,workspaceId:config.workspaceId,
    productWorkspaceId:config.productWorkspaceId||config.workspaceId,
    requireNativeTemplates:true,nativeTemplates:config.nativeTemplates||NATIVE_TEMPLATES,
    capturedAt:new Date().toISOString()};
}

export function imageDimensions(bytes) {
  if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
  if(bytes[0]===255&&bytes[1]===216){
    let p=2;while(p+4<=bytes.length){if(bytes[p++]!==255)continue;while(bytes[p]===255)p++;const marker=bytes[p++];if(marker===0xd9||marker===0xda)break;if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;const length=bytes.readUInt16BE(p);if(length<2||p+length>bytes.length)break;if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&length>=7)return {height:bytes.readUInt16BE(p+3),width:bytes.readUInt16BE(p+5)};p+=length;}
  }
  if(bytes.length>=30&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'){
    const type=bytes.toString('ascii',12,16);
    if(type==='VP8X')return {width:1+bytes.readUIntLE(24,3),height:1+bytes.readUIntLE(27,3)};
    if(type==='VP8L'&&bytes[20]===0x2f){const n=bytes.readUInt32LE(21);return {width:1+(n&0x3fff),height:1+((n>>>14)&0x3fff)};}
    if(type==='VP8 '&&bytes[23]===0x9d&&bytes[24]===1&&bytes[25]===0x2a)return {width:bytes.readUInt16LE(26)&0x3fff,height:bytes.readUInt16LE(28)&0x3fff};
  }
  if(bytes.toString('ascii',4,8)==='ftyp'){const i=bytes.indexOf(Buffer.from('ispe'));if(i>=0&&i+16<=bytes.length)return {width:bytes.readUInt32BE(i+8),height:bytes.readUInt32BE(i+12)};}
  return null;
}

export function verifyImageFormat(bytes,profile) {
  const size=imageDimensions(bytes);if(!size?.width||!size.height)throw new Error('Could not verify generated image dimensions.');
  const [w,h]=profile.aspectRatio.split(':').map(Number);
  if(Math.abs(size.width/size.height-w/h)>0.01*(w/h))throw new Error(`Generated image is ${size.width}×${size.height}; expected ${profile.aspectRatio}. Keep the original; do not crop or regenerate automatically.`);
  if(profile.resolution==='2K'&&Math.max(size.width,size.height)<2048)throw new Error(`Generated image is ${size.width}×${size.height}, below the requested 2K output. Do not upscale or regenerate automatically.`);
  return size;
}

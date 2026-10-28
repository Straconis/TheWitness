import {defaultAudioTool} from "./speech-cleanup";
import {createHash,randomUUID} from "node:crypto";
import {mkdir,readFile,writeFile,rename,stat,rm,statfs,readdir} from "node:fs/promises";
import path from "node:path";
import {existsSync} from "node:fs";
import {runTool} from "./process";
export type IntroScope="server"|"recording";
export function introRecordingID(scope:IntroScope|undefined,sessionID:string):string|undefined{
 if(scope!==undefined&&scope!=="server"&&scope!=="recording")throw Error("Invalid intro source.");
 if(scope==="recording"){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(sessionID))throw Error("Invalid recording ID.");return sessionID;}
}
export interface ServerIntro {id:string;name:string;seconds:number;channelID?:string}
// Intro conversion runs one at a time; later uploads wait their turn instead of failing and losing their chunks.
let introQueue:Promise<void>=Promise.resolve(),introWaiting=0;
const MAX_WAITING_INTROS=16;
/** Bounds what anyone holding a recording link can store: finished custom intros kept, and uploads in progress. */
export const MAX_CUSTOM_INTROS=3,MAX_CUSTOM_UPLOADS=3,STALE_UPLOAD_MS=3600000;
/**
 * Per-recording critical sections (in-process; the bot runs one process). Claiming an upload slot, pruning custom intros,
 * and an export validating and pinning a custom intro never interleave for the same recording.
 */
const recordingLocks=new Map<string,Promise<void>>(),lockHolders=new Map<string,number>();
export async function withRecordingIntros<T>(recordingID:string,action:()=>Promise<T>):Promise<T>{
 const previous=recordingLocks.get(recordingID)??Promise.resolve();let release!:()=>void;const current=new Promise<void>(resolve=>{release=resolve;});
 const tail=previous.then(()=>current);recordingLocks.set(recordingID,tail);lockHolders.set(recordingID,(lockHolders.get(recordingID)??0)+1);
 try{await previous;return await action();}
 finally{release();const count=(lockHolders.get(recordingID)??1)-1;if(count>0)lockHolders.set(recordingID,count);else lockHolders.delete(recordingID);if(recordingLocks.get(recordingID)===tail)recordingLocks.delete(recordingID);}
}
/** Lock key shared by server/channel intro lookups and their sweep (those intros are not tied to one recording). */
export const SERVER_INTROS_LOCK="server-intros";
/** Holders plus waiters for a recording's critical section; lets tests order interleavings deterministically. */
export function recordingIntroLockDepth(recordingID:string):number{return lockHolders.get(recordingID)??0;}
/** Intro IDs held by exports being submitted, before their job is registered; and providers of IDs registered jobs use. */
const pins=new Map<string,number>(),referenceProviders=new Set<()=>Set<string>>();
export function pinIntro(id:string):()=>void{pins.set(id,(pins.get(id)??0)+1);let released=false;return ()=>{if(released)return;released=true;const count=(pins.get(id)??1)-1;if(count>0)pins.set(id,count);else pins.delete(id);};}
export function registerIntroReferences(provider:()=>Set<string>):()=>void{referenceProviders.add(provider);return ()=>{referenceProviders.delete(provider);};}
/** Read at deletion time, inside the recording's critical section, so it reflects exports accepted up to that moment. */
export function introInUse(id:string):boolean{return pins.has(id)||[...referenceProviders].some(provider=>provider().has(id));}
/** Keeps the newest finished custom intros plus any an export uses or is validating; removes the rest. */
async function pruneCustomIntros(dir:string,keep:Set<string>):Promise<void>{
 const saved=[];for(const name of await readdir(dir))if(/^[a-f0-9-]{36}\.json$/i.test(name)){const id=name.slice(0,-5);saved.push({id,time:(await stat(path.join(dir,name))).mtimeMs});}
 saved.sort((a,b)=>b.time-a.time||(a.id<b.id?-1:1));
 for(const [index,intro] of saved.entries())if(index>=MAX_CUSTOM_INTROS&&!keep.has(intro.id)&&!introInUse(intro.id)){await rm(path.join(dir,intro.id+".json"),{force:true});await rm(path.join(dir,intro.id+".pcm"),{force:true});}
}
const idPattern=/^[a-f0-9-]{36}$/i;
function directory(root:string,guild:string,recordingID?:string,channelID?:string):string{
 if(recordingID){introRecordingID("recording",recordingID);return path.join(root,recordingID,"intros",createHash("sha256").update(guild).digest("hex"));}
 return path.join(root,"server-intros",createHash("sha256").update(channelID?`channel:${guild}:${channelID}`:guild).digest("hex"));
}
/** With a channel, falls back to the server default unless inherit is false (used to show what a channel itself has). */
export async function getServerIntro(root:string,guild:string,id?:string,recordingID?:string,channelID?:string,inherit=true):Promise<ServerIntro|undefined>{
 if(recordingID&&!id)return;
 if(id&&!idPattern.test(id))throw Error("Invalid intro ID.");
 try{const intro=JSON.parse(await readFile(path.join(directory(root,guild,recordingID,channelID),id?`${id}.json`:"current.json"),"utf8"));if(!idPattern.test(intro.id)||!Number.isFinite(intro.seconds)||intro.seconds<=0||intro.seconds>300||typeof intro.name!=="string")throw Error("Invalid saved intro.");
  // Deletion removes the description first; a description whose audio is gone (interrupted deletion) is treated as missing.
  await stat(path.join(directory(root,guild,recordingID,intro.channelID??channelID),intro.id+".pcm"));return intro;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT"){if(channelID&&!recordingID&&inherit)return getServerIntro(root,guild,id);return;}throw error;}
}
export function introPCM(root:string,guild:string,id:string,recordingID?:string,channelID?:string):string{if(!idPattern.test(id))throw Error("Invalid intro ID.");return path.join(directory(root,guild,recordingID,channelID),id+".pcm");}
/**
 * Uploads in flight. Shutdown drains them (and refuses new ones) before export jobs stop protecting their intros,
 * because a finishing upload prunes custom intros.
 */
const introWork=new Set<Promise<unknown>>();let introWorkClosed=false;
export async function drainIntroWork():Promise<void>{introWorkClosed=true;while(introWork.size)await Promise.allSettled([...introWork]);}
/** Reopens uploads after a drain; for an in-process restart and tests. */
export function resumeIntroWork():void{introWorkClosed=false;}
export function uploadIntroChunk(root:string,guild:string,data:any,recordingID?:string,channelID?:string,options:{keep?:Set<string>}={}):Promise<{id:string;intro?:ServerIntro}>{
 if(introWorkClosed)return Promise.reject(Object.assign(Error("The Witness is restarting. Upload the intro again once it is back."),{code:"INTRO_WORK_CLOSED"}));
 const work=uploadIntroChunkNow(root,guild,data,recordingID,channelID,options);introWork.add(work);
 const forget=()=>{introWork.delete(work);};work.then(forget,forget);return work;
}
async function uploadIntroChunkNow(root:string,guild:string,data:any,recordingID:string|undefined,channelID:string|undefined,options:{keep?:Set<string>}):Promise<{id:string;intro?:ServerIntro}>{
 if(data.index===0&&data.id!==undefined)throw Error("New intro upload IDs are assigned by the server.");
 const dir=directory(root,guild,recordingID,channelID);
 if(recordingID){
  // Never recreate a recording folder: a chunk racing a deletion must not leave an orphan recording directory behind.
  for(const folder of [path.dirname(dir),dir])try{await mkdir(folder);}catch(error){const code=(error as NodeJS.ErrnoException).code;if(code==="ENOENT")throw Error("This recording no longer exists.");if(code!=="EEXIST")throw error;}
 }else await mkdir(dir,{recursive:true});
 const id=data.id??randomUUID();if(!idPattern.test(id)||!Number.isInteger(data.index)||data.index<0||data.index>=60||typeof data.bytes!=="string"||data.bytes.length>710000||!/^[A-Za-z0-9+/]+={0,2}$/.test(data.bytes))throw Error("Invalid intro upload.");
 const available=await statfs(dir);if(Number(available.bavail)*Number(available.bsize)<1024**3+64*1024**2)throw Error("Free disk space before uploading an intro.");
 const bytes=Buffer.from(data.bytes,"base64");if(!bytes.length||bytes.length>512*1024)throw Error("Invalid intro chunk size.");
 const upload=path.join(dir,"upload-"+id);
 const claim=async()=>{
  let active=0;for(const entry of await readdir(dir,{withFileTypes:true}))if(entry.isDirectory()&&entry.name.startsWith("upload-")){const started=path.join(dir,entry.name);if(Date.now()-(await stat(started)).mtimeMs>STALE_UPLOAD_MS)await rm(started,{recursive:true,force:true});else active++;}
  if(active>=MAX_CUSTOM_UPLOADS)throw Error("Several custom intro uploads are already in progress for this recording. Wait for them to finish, then try again.");
  await mkdir(upload);
 };
 // Counting slots and creating the upload folder happen in one critical section, so simultaneous starts cannot exceed the cap.
 if(data.index===0){if(recordingID)await withRecordingIntros(recordingID,claim);else await mkdir(upload);}else if(!data.id)throw Error("Missing upload ID.");
 try{await writeFile(path.join(upload,String(data.index)),bytes,{flag:"wx",mode:0o600});}catch(error){if(data.index===0)await rm(upload,{recursive:true,force:true});throw error;}
 if(data.final!==true)return {id};
 if(introWaiting>=MAX_WAITING_INTROS){await rm(upload,{recursive:true,force:true});throw Error("Too many intros are being processed. Upload again shortly.");}
 introWaiting++;const previous=introQueue;let release!:()=>void;introQueue=new Promise<void>(resolve=>{release=resolve;});
 try{
 await previous;
 // A missing chunk is reported without the server path (custom uploads are open to recording-link holders).
 const chunks=[];let size=0;for(let index=0;index<=data.index;index++){const chunk=await readFile(path.join(upload,String(index))).catch(error=>{throw (error as NodeJS.ErrnoException).code==="ENOENT"?Object.assign(Error("Part of this intro upload is missing. Start the upload again."),{code:"ENOENT"}):error;});size+=chunk.length;if(size>30*1024*1024)throw Error("Intro files must be under 30 MB.");chunks.push(chunk);}
 const header=chunks[0];let demux:string;if(header.toString("ascii",0,4)==="RIFF"||header.toString("ascii",0,4)==="RF64")demux="wav";else if(header.toString("ascii",0,4)==="fLaC")demux="flac";else if(header.toString("ascii",0,4)==="OggS")demux="ogg";else if(header.toString("ascii",0,3)==="ID3"||(header[0]===255&&(header[1]&224)===224))demux="mp3";else throw Error("Upload a WAV, FLAC, MP3, or Ogg audio intro.");
 const input=path.join(upload,"input"),pcm=path.join(upload,"intro.pcm");await writeFile(input,Buffer.concat(chunks));
 const ffmpeg=defaultAudioTool();
 await runTool(ffmpeg,["-nostdin","-v","error","-n","-protocol_whitelist","file,pipe","-f",demux,"-i",input,"-vn","-t","300.01","-ar","48000","-ac","2","-c:a","pcm_s16le","-f","s16le",pcm],undefined,120000);const seconds=(await stat(pcm)).size/192000;if(seconds<=0||seconds>300)throw Error("Intro must contain audio and be no longer than five minutes.");const intro={id,...(channelID?{channelID}:{}),name:typeof data.name==="string"?data.name.slice(0,150):"Server intro",seconds};await rename(pcm,introPCM(root,guild,id,recordingID,channelID));await writeFile(path.join(dir,id+".json"),JSON.stringify(intro),{flag:"wx",mode:0o600});if(!recordingID){const temporary=path.join(dir,"current-"+id+".tmp");await writeFile(temporary,JSON.stringify(intro),{mode:0o600});await rename(temporary,path.join(dir,"current.json"));}if(recordingID)await withRecordingIntros(recordingID,()=>pruneCustomIntros(dir,new Set([id,...(options.keep??[])])));return {id,intro};}finally{introWaiting--;release();await rm(upload,{recursive:true,force:true});}
}

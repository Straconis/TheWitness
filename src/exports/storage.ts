import {readFile,readdir,stat,rm,lstat} from "node:fs/promises";
import path from "node:path";
import type {ExportJob} from "./jobs";
import {resolveAudioFormat} from "./formats";
import {getServerIntro} from "./server-intro";
import {sessionIDPattern} from "../storage/sessions";
const exportName=/^export-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const EXPORT_RETENTION_MS=48*3600000,JOB_RETENTION_MS=7*86400000;
/** Estimated peak usage: output, project copy, corrected sources and one scratch track. */
export async function estimateExportBytes(root:string,job:ExportJob):Promise<number>{
 const metadata=JSON.parse(await readFile(path.join(root,job.sessionID,"session.json"),"utf8"));
 const elapsed=Number(metadata.durationSamples)/48000;
 let duration=Number.isFinite(elapsed)&&elapsed>0?elapsed:(Date.parse(metadata.endedAt)-Date.parse(metadata.startedAt))/1000;
 if(!Number.isFinite(duration)||duration<=0)duration=(metadata.durationHours??8)*3600;
 duration=Math.max(1,duration);
 const intro=job.introID?await getServerIntro(root,job.guildID,job.introID):undefined;
 // FLAC uses a conservative compression estimate, not a hard size bound; the live guard is the backstop.
 const format=resolveAudioFormat(job.format,job.trackFormat),rate=format==="wav"?192000:format==="flac"?140000:40000;
 const spans=job.edits?job.edits.tracks.map(track=>Math.max(...track.clips.map(clip=>clip.at+clip.end-clip.start))+(intro?.seconds??0)):metadata.tracks.map(()=>Math.max(1,Math.min(duration,job.trimEnd??duration)-(job.trimStart??0))+(intro?.seconds??0));
 if(intro)spans.push(intro.seconds);
 const maximum=Math.max(1,...spans);
 let output=spans.reduce((sum:number,seconds:number)=>sum+seconds*rate,0)+(job.mix?maximum*rate:0);
 if(job.includeRaw)output+=metadata.tracks.length*duration*140000;
 const project=["audition","audacity"].includes(job.format)||job.includeRaw;
 const corrected=job.sourceExport?0:metadata.tracks.length*duration*40000;
 const scratch=maximum*rate;
 // Corrected sources are removed before ZIP packaging; do not sum disjoint peaks.
 const peak=Math.max(output+corrected+scratch,output*(project?2:1)+(job.transcribe?maximum*64000:0));
 const bytes=Math.ceil(peak*1.15+1048576);
 if(!Number.isSafeInteger(bytes)||bytes<=0)throw Error("Cannot safely estimate export disk use.");
 return bytes;
}
async function directories(root:string){return (await readdir(root,{withFileTypes:true})).filter(entry=>entry.isDirectory()&&sessionIDPattern.test(entry.name));}
/** Startup only, before exporters start. Never remove originals or follow directory symlinks. */
export async function cleanTransientArtifacts(root:string):Promise<void>{
 for(const entry of await readdir(root,{withFileTypes:true}))if(entry.isDirectory()&&entry.name.startsWith(".deleted-")&&sessionIDPattern.test(entry.name.slice(9)))await rm(path.join(root,entry.name),{recursive:true,force:true});
 for(const entry of await directories(root))for(const child of await readdir(path.join(root,entry.name),{withFileTypes:true}))if(child.isDirectory()&&child.name.endsWith(".tmp")&&exportName.test(child.name.slice(0,-4)))await rm(path.join(root,entry.name,child.name),{recursive:true,force:true});
 try{for(const entry of await readdir(path.join(root,"jobs"),{withFileTypes:true}))if(entry.isFile()&&entry.name.endsWith(".json.tmp")&&sessionIDPattern.test(entry.name.slice(0,-9)))await rm(path.join(root,"jobs",entry.name));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
}
/** Age out regenerable artifacts; keep editor work and recursively retain its source exports. */
export async function sweepArtifacts(root:string,active:ExportJob[],introIDs:Set<string>,now=Date.now()):Promise<void>{
 for(const entry of await directories(root)){
  let ambiguous=false;const parent=path.join(root,entry.name),artifacts=new Map<string,{source?:string;keep:boolean}>();
  for(const child of await readdir(parent,{withFileTypes:true}))if(child.isDirectory()&&exportName.test(child.name)){
   const dir=path.join(parent,child.name);let manifest:any;
   try{manifest=JSON.parse(await readFile(path.join(dir,"manifest.json"),"utf8"));}catch{ambiguous=true;continue;} // preserve this session’s unknown source relationships
   if(!manifest||typeof manifest!=="object"||Array.isArray(manifest)||manifest.sessionID!==entry.name||!Array.isArray(manifest.tracks)||(manifest.sourceExport&&!exportName.test(manifest.sourceExport))){ambiguous=true;continue;}
   let editor=false;try{await lstat(path.join(dir,"editor-state.json"));editor=true;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
   artifacts.set(child.name,{source:manifest.sourceExport,keep:editor||!!manifest.edits||now-(await stat(dir)).mtimeMs<EXPORT_RETENTION_MS||active.some(job=>job.sessionID===entry.name&&(job.directory===child.name||job.sourceExport===child.name))});
  }
  if(ambiguous)continue;
  let changed=true;while(changed){changed=false;for(const item of artifacts.values())if(item.keep&&item.source){const source=artifacts.get(item.source);if(source&&!source.keep){source.keep=true;changed=true;}}}
  for(const [name,item] of artifacts)if(!item.keep)await rm(path.join(parent,name),{recursive:true,force:true});
 }
 const introRoot=path.join(root,"server-intros");let servers;try{servers=await readdir(introRoot,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
 for(const server of servers)if(server.isDirectory()&&/^[a-f0-9]{64}$/.test(server.name)){
  const dir=path.join(introRoot,server.name);let current:string|undefined;
  try{current=JSON.parse(await readFile(path.join(dir,"current.json"),"utf8")).id;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")continue;}
  for(const file of await readdir(dir,{withFileTypes:true})){
   const target=path.join(dir,file.name);let age:number;try{age=now-(await lstat(target)).mtimeMs;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")continue;throw error;}
   if(file.isDirectory()&&file.name.startsWith("upload-")&&sessionIDPattern.test(file.name.slice(7))&&age>3600000)await rm(target,{recursive:true,force:true});
   else if(file.isFile()&&file.name.endsWith(".json")&&sessionIDPattern.test(file.name.slice(0,-5))&&age>EXPORT_RETENTION_MS){const id=file.name.slice(0,-5);if(id!==current&&!introIDs.has(id)){await rm(path.join(dir,id+".pcm"),{force:true});await rm(target,{force:true});}}
   else if(file.isFile()&&file.name.endsWith(".pcm")&&sessionIDPattern.test(file.name.slice(0,-4))&&age>EXPORT_RETENTION_MS){const id=file.name.slice(0,-4);if(id!==current&&!introIDs.has(id)){try{await lstat(path.join(dir,id+".json"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;await rm(target,{force:true});}}}
  }
 }
}

/** Release export pressure before deciding whether emergency recording stops are necessary. */
export async function protectRecordingSpace(queue:Pick<import("./jobs").ExportQueue,"pauseForDisk">|undefined,check:()=>Promise<{critical:boolean}>,stop:()=>Promise<void>):Promise<void>{
 await queue?.pauseForDisk();if((await check()).critical){console.error("[Storage] Cannot continue recording safely: disk remains critical after export cleanup. Stopping recordings; saved audio is preserved.");await stop();}
}

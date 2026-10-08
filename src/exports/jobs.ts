import {estimateExportBytes,sweepArtifacts,JOB_RETENTION_MS} from "./storage";
import type {StorageSpace} from "../storage/space";
import {UserError} from "../errors";
import {resolveLoudness,TARGET_LUFS,TRUE_PEAK_DBTP} from "./normalization";
import {silenceSeconds} from "./silence";
import {getServerIntro} from "./server-intro";
import {validateMixExclusions} from "./mix-selection";
import {resolveAudioFormat,ProjectTrackFormat} from "./formats";
import { assertDeploymentIdle } from "../storage/deployment";
import { transcriptionConfig,transcriptionReady } from "../integrations/transcription-config";
import { AudioEdits,validateEdits } from "./edits";
import { CloudAccounts } from "../integrations/accounts";
import { writeProjectZip } from "./project-zip";
import { existsSync } from "node:fs";
import { transcribeExport } from "../integrations/transcription";
import { uploadFile, CloudProvider } from "../integrations/cloud";
import { randomUUID } from "node:crypto";
import { mkdir,readdir,readFile,writeFile,rename,rm,stat } from "node:fs/promises";
import path from "node:path";
import { exportSession, ExportFormat } from "./export";
import { getSession,sessionIDPattern } from "../storage/sessions";
type Extras={targetLUFS?:number;maxTruePeakDBTP?:number;normalizeAudio?:boolean;normalizeIntro?:boolean;trimSilence?:boolean;trimEndSilence?:boolean;silenceSeconds?:number;includeRaw?:boolean;includeIntro?:boolean;introID?:string;excludeFromMix?:number[];trackFormat?:ProjectTrackFormat;sourceExport?:string;edits?:AudioEdits;transcribe?:boolean;upload?:CloudProvider;trimStart?:number;trimEnd?:number};
export interface ExportJob extends Extras {id:string;sessionID:string;guildID:string;format:ExportFormat;mix:boolean;state:"queued"|"running"|"cancelling"|"cancelled"|"completed"|"failed";createdAt:string;queueOrder?:number;directory?:string;error?:string;stage?:string;retryOf?:string}
/** Like Craig's QUEUE_SIZE: how many exports run at once across every server; later jobs wait in order. */
export function exportConcurrency(value=process.env.EXPORT_CONCURRENCY?.trim()):number{if(!value)return 1;const limit=Number(value);if(!Number.isInteger(limit)||limit<1||limit>16)throw new Error("EXPORT_CONCURRENCY must be a whole number from 1 to 16.");return limit;}
export class ExportQueue {
 private jobs=new Map<string,ExportJob>();private dispatching?:Promise<void>;private redispatch=false;private running=new Map<string,Promise<void>>();private stopped=false;private submissions:Promise<unknown>=Promise.resolve();private active=new Map<string,AbortController>();private saves=new Map<string,Promise<void>>();private deleting=new Set<string>();
 private accounts:CloudAccounts;
 private started=false;private diskPaused=false;private diskAborted=new Set<string>();private reservations=new Map<string,number>();private diskPausing?:Promise<void>;private diskGuard?:NodeJS.Timeout;private maintenanceTimer?:NodeJS.Timeout;
 private cooldown?:NodeJS.Timeout;
 private sequence=0;
 private pendingPersistence=new Set<ExportJob>();
 private assertUploadAllowed(guildID:string):void{const allowed=(process.env.CLOUD_UPLOAD_GUILD_IDS??"").split(",").map(id=>id.trim()).filter(Boolean);if(allowed.length&&!allowed.includes(guildID))throw new UserError("Cloud uploads are not enabled for this server.");}
 constructor(private root:string,private exporter=exportSession,private diskCritical:()=>Promise<boolean>|boolean=()=>false,private concurrency=exportConcurrency(),private inspectSpace?:()=>Promise<StorageSpace>,private startSoundReferences:()=>Set<string>=()=>new Set()){if(!Number.isInteger(concurrency)||concurrency<1||concurrency>16)throw Error("EXPORT_CONCURRENCY must be a whole number from 1 to 16.");this.accounts=new CloudAccounts(root);}
 private save(job:ExportJob):Promise<void>{const body=JSON.stringify(job,null,2),file=path.join(this.root,"jobs",job.id+".json");const task=(this.saves.get(job.id)??Promise.resolve()).catch(()=>{}).then(async()=>{await writeFile(file+".tmp",body);await rename(file+".tmp",file);});this.saves.set(job.id,task);void task.finally(()=>{if(this.saves.get(job.id)===task)this.saves.delete(job.id);}).catch(()=>{});return task;}
 async load(start=true):Promise<void>{
  await mkdir(path.join(this.root,"jobs"),{recursive:true});
  for(const name of await readdir(path.join(this.root,"jobs"))){if(!/^[a-f0-9-]{36}\.json$/i.test(name))continue;
   try{const job=JSON.parse(await readFile(path.join(this.root,"jobs",name),"utf8")) as ExportJob;
    if(!job||typeof job.createdAt!=="string"||!Number.isFinite(Date.parse(job.createdAt))||(job.queueOrder!==undefined&&(!Number.isSafeInteger(job.queueOrder)||job.queueOrder<1))||!sessionIDPattern.test(job.id)||name!==job.id+".json"||!sessionIDPattern.test(job.sessionID)||typeof job.guildID!=="string"||typeof job.mix!=="boolean"||!["ogg","wav","flac","mp3","aac","audition","audacity"].includes(job.format)||!["queued","running","cancelling","cancelled","completed","failed"].includes(job.state))throw new Error("Invalid export job metadata.");
    resolveLoudness(job);silenceSeconds(job.silenceSeconds??30);resolveAudioFormat(job.format,job.trackFormat);validateMixExclusions(job.excludeFromMix);if(job.edits)validateEdits(job.edits);if(job.sourceExport&&!/^export-[a-f0-9-]{36}$/i.test(job.sourceExport))throw new Error("Invalid saved editor source.");
    if(job.state==="running")job.state="queued";if(job.state==="cancelling")job.state="cancelled";this.jobs.set(job.id,job);this.sequence=Math.max(this.sequence,job.queueOrder??0);
   }catch(error){console.warn(`[Export queue] Preserved unreadable job ${name}; skipped loading it.`,error);}
  }
  await this.maintenance().catch(error=>console.warn("[Storage] Startup artifact cleanup deferred.",error));
  this.maintenanceTimer=setInterval(()=>void this.maintenance().catch(error=>console.warn("[Storage] Artifact cleanup failed.",error)),3600000);this.maintenanceTimer.unref();
  if(this.inspectSpace){this.diskGuard=setInterval(()=>{if(this.running.size&&!this.diskPaused)void this.inspectSpace!().then(space=>{if(space.low||space.critical)return this.pauseForDisk();}).catch(error=>{console.error("[Storage] Export space guard failed.",error);return this.pauseForDisk();});},1000);this.diskGuard.unref();}
  if(start)this.start();
 }
 start():void{if(this.stopped)return;this.started=true;this.kick();}
 enqueue(sessionID:string,guildID:string,format:ExportFormat,mix=false,extras:Extras={}):Promise<ExportJob>{const task=this.submissions.catch(()=>{}).then(()=>this.submit(sessionID,guildID,format,mix,extras));this.submissions=task;return task;}
 private async submit(sessionID:string,guildID:string,format:ExportFormat,mix:boolean,extras:Extras):Promise<ExportJob>{
  extras={...extras,...resolveLoudness(extras)};
  await assertDeploymentIdle(this.root);
  if(this.stopped)throw new UserError("Export service is stopping.");if(await this.diskCritical())throw new UserError("Disk space is critically low, so new exports are paused. Free up space first.");if(this.deleting.has(sessionID))throw new UserError("This recording is being deleted.");const session=await getSession(this.root,sessionID,guildID);if(session.state!=="completed")throw new UserError("Only completed recordings can be exported.");
  if(!["ogg","wav","flac","mp3","aac","audition","audacity"].includes(format))throw new UserError("Invalid export format.");
  silenceSeconds(extras.silenceSeconds??30);if(extras.sourceExport&&(extras.includeRaw||extras.trimSilence||extras.trimEndSilence))throw new UserError("Choose raw recordings and silence trimming on the original recording download page.");
  const audioFormat=resolveAudioFormat(format,extras.trackFormat);extras={...extras,trackFormat:["audition","audacity"].includes(format)?audioFormat as ProjectTrackFormat:undefined};
  extras={...extras,excludeFromMix:(mix||extras.trimSilence||extras.trimEndSilence||extras.normalizeIntro)?validateMixExclusions(extras.excludeFromMix,session.tracks.map(track=>track.track)):undefined};
  if(extras.includeIntro){const intro=await getServerIntro(this.root,guildID,extras.introID);if(!intro)throw new UserError("Upload a server intro first.");extras={...extras,introID:intro.id};}
  if(extras.edits)validateEdits(extras.edits,session.tracks.map(track=>track.track));
  if(extras.trimStart!==undefined&&(!Number.isFinite(extras.trimStart)||extras.trimStart<0))throw new UserError("Invalid trim start.");if(extras.trimEnd!==undefined&&(!Number.isFinite(extras.trimEnd)||extras.trimEnd<=(extras.trimStart??0)))throw new UserError("Invalid trim end.");
  if(extras.transcribe&&!transcriptionReady())throw new UserError("Configure a local transcription executable and model first.");if(extras.upload&&!["dropbox","google","onedrive","box"].includes(extras.upload))throw new UserError("Invalid cloud provider.");if(extras.upload)this.assertUploadAllowed(guildID);if(extras.upload&&!await this.accounts.configured(extras.upload))throw new UserError("Configure the cloud account first.");
  if(this.deleting.has(sessionID))throw new UserError("This recording is being deleted.");
  if(this.stopped)throw new UserError("Export service is stopping.");await assertDeploymentIdle(this.root);
  const existing=[...this.jobs.values()].find(job=>job.sessionID===sessionID&&job.format===format&&job.mix===mix&&(job.targetLUFS??TARGET_LUFS)===extras.targetLUFS&&(job.maxTruePeakDBTP??TRUE_PEAK_DBTP)===extras.maxTruePeakDBTP&&!!job.normalizeAudio===!!extras.normalizeAudio&&!!job.normalizeIntro===!!extras.normalizeIntro&&!!job.trimSilence===!!extras.trimSilence&&!!job.trimEndSilence===!!extras.trimEndSilence&&(job.silenceSeconds??30)===(extras.silenceSeconds??30)&&!!job.includeRaw===!!extras.includeRaw&&job.introID===extras.introID&&JSON.stringify(job.excludeFromMix??[])===JSON.stringify(extras.excludeFromMix??[])&&job.trackFormat===extras.trackFormat&&job.transcribe===extras.transcribe&&job.upload===extras.upload&&job.trimStart===extras.trimStart&&job.trimEnd===extras.trimEnd&&job.sourceExport===extras.sourceExport&&JSON.stringify(job.edits)===JSON.stringify(extras.edits)&&["queued","running"].includes(job.state));if(existing)return existing;
  const job:ExportJob={id:randomUUID(),sessionID,guildID,format,mix,state:"queued",createdAt:new Date().toISOString(),queueOrder:++this.sequence,...extras};await this.save(job);this.jobs.set(job.id,job);this.kick();return job;
 }
 private owned(id:string,guildID:string):ExportJob{const job=this.jobs.get(id);if(!job||job.guildID!==guildID)throw new UserError("Export job not found in this server.");return job;}
 async cancel(id:string,guildID:string):Promise<ExportJob>{const job=this.owned(id,guildID);if(job.state==="queued"){job.state="cancelled";job.stage="Cancelled";}else if(job.state==="running"){job.state="cancelling";this.active.get(id)?.abort(new Error("Export cancelled."));}else if(!["cancelling","cancelled"].includes(job.state))throw new UserError("Only queued or running jobs can be cancelled.");await this.save(job);return job;}
 async retry(id:string,guildID:string):Promise<ExportJob>{const previous=this.owned(id,guildID);if(!["failed","cancelled"].includes(previous.state))throw new UserError("Only failed or cancelled jobs can be retried.");const {targetLUFS,maxTruePeakDBTP,transcribe,upload,trimStart,trimEnd,edits,sourceExport,trackFormat,excludeFromMix,includeIntro,introID,trimSilence,trimEndSilence,silenceSeconds,includeRaw,normalizeAudio,normalizeIntro}=previous;const job=await this.enqueue(previous.sessionID,guildID,previous.format,previous.mix,{targetLUFS,maxTruePeakDBTP,transcribe,upload,trimStart,trimEnd,edits,sourceExport,trackFormat,excludeFromMix,includeIntro,introID,trimSilence,trimEndSilence,silenceSeconds,includeRaw,normalizeAudio,normalizeIntro});job.retryOf=id;await this.save(job);return job;}
 async whileIdle<T>(sessionID:string,action:()=>Promise<T>):Promise<T>{await this.submissions.catch(()=>{});if(this.deleting.has(sessionID)||this.busy(sessionID))throw new UserError("Wait for this recording's exports to finish before deleting it.");this.deleting.add(sessionID);try{return await action();}finally{this.deleting.delete(sessionID);}}
 busy(sessionID:string):boolean{return [...this.jobs.values()].some(job=>job.sessionID===sessionID&&["queued","running","cancelling"].includes(job.state));}
 get(id:string):ExportJob|undefined{return this.jobs.get(id);}
 /** Oldest first, as Craig orders its queue, so a restart or retry cannot reshuffle waiting servers. */
 private queued():ExportJob[]{return [...this.jobs.values()].filter(job=>job.state==="queued").sort((a,b)=>Date.parse(a.createdAt)-Date.parse(b.createdAt)||(a.queueOrder??0)-(b.queueOrder??0)||a.id.localeCompare(b.id));}
 /** 1-based place among waiting jobs; undefined once the job is running or finished. */
 get stopping():boolean{return this.stopped;}
 position(id:string):number|undefined{const index=this.queued().findIndex(job=>job.id===id);return index<0?undefined:index+1;}
 private pause():void{if(this.stopped||this.cooldown)return;this.cooldown=setTimeout(()=>{this.cooldown=undefined;this.diskPaused=false;this.kick();},30000);this.cooldown.unref();}
 private kick():void{if(!this.started||this.stopped||this.diskPaused||this.cooldown)return;if(this.dispatching){this.redispatch=true;return;}this.dispatching=this.dispatch().catch(error=>{
  // A storage failure (for example a full disk) pauses the queue briefly; it must not stay dead until restart.
  console.error("[Export queue] Storage failed; retrying in 30 seconds.",error);if(!this.cooldown)this.pause();
 }).finally(()=>{this.dispatching=undefined;if(this.redispatch){this.redispatch=false;this.kick();}});}
 /** Start waiting jobs until the concurrency limit is reached; each finished job dispatches the next. */
 private async dispatch():Promise<void>{
  await this.submissions.catch(()=>{});for(const job of this.pendingPersistence){await this.save(job);this.pendingPersistence.delete(job);}
  while(!this.stopped&&!this.diskPaused&&!this.cooldown&&this.running.size<this.concurrency){
   if(await this.diskCritical()){this.pause();return;}
   if(this.stopped||this.diskPaused||this.cooldown)return;
   const job=this.queued()[0];if(!job)return;
   if(this.inspectSpace){
    let required:number;try{required=await estimateExportBytes(this.root,job);}catch(error){job.state="failed";job.stage="Failed";job.error=error instanceof Error?error.message:String(error);console.error(`[Export] Job ${job.id} failed during disk preflight:`,error);await this.save(job);continue;}
    const space=await this.inspectSpace();
    if(this.stopped||this.diskPaused||this.cooldown)return;
    const reserved=[...this.reservations.values()].reduce((sum,bytes)=>sum+bytes,0);
    if(space.availableBytes-space.warningBytes-reserved<required){const stage=`Waiting for disk space: estimated ${(required/1024**3).toFixed(2)} GiB needed; free space must also cover the recording reserve.`;if(job.stage!==stage){job.stage=stage;await this.save(job);}this.pause();return;}
    this.reservations.set(job.id,required);
   }
   const task=this.process(job);this.running.set(job.id,task);
   void task.catch(error=>{
    console.error("[Export queue] Storage failed; retrying in 30 seconds.",error);
    if(job.state==="running"){this.active.delete(job.id);job.state="queued";job.stage="Waiting to retry";}
    if(!this.cooldown)this.pause();
   }).finally(()=>{this.running.delete(job.id);this.reservations.delete(job.id);this.kick();});
  }
 }
 private async process(job:ExportJob):Promise<void>{const controller=new AbortController(),signal=controller.signal;this.active.set(job.id,controller);job.state="running";job.stage="Preparing audio";
  try{await this.save(job);}catch(error){this.active.delete(job.id);job.state=(job as ExportJob).state==="cancelling"?"cancelled":"queued";job.stage=job.state==="cancelled"?"Cancelled":"Waiting to retry";this.pendingPersistence.add(job);this.diskAborted.delete(job.id);throw error;}
  try{
   signal.throwIfAborted();const directory=await this.exporter(this.root,job.sessionID,{format:job.format,trackFormat:job.trackFormat,targetLUFS:job.targetLUFS,maxTruePeakDBTP:job.maxTruePeakDBTP,normalizeAudio:job.normalizeAudio,normalizeIntro:job.normalizeIntro,trimSilence:job.trimSilence,trimEndSilence:job.trimEndSilence,silenceSeconds:job.silenceSeconds,includeRaw:job.includeRaw,introID:job.introID,mix:job.mix,excludeFromMix:job.excludeFromMix,trimStart:job.trimStart,trimEnd:job.trimEnd,edits:job.edits,sourceExport:job.sourceExport,signal});job.directory=path.basename(directory);signal.throwIfAborted();
   if(job.transcribe){job.stage="Transcribing";await this.save(job);await transcribeExport(directory,{...transcriptionConfig(),ffmpeg:process.env.FFMPEG_PATH?.trim()||(existsSync(path.resolve(__dirname,"../../bin/ffmpeg"))?path.resolve(__dirname,"../../bin/ffmpeg"):"ffmpeg"),signal});}
   if(job.transcribe&&(["audition","audacity"].includes(job.format)||job.includeRaw)){await rm(path.join(directory,"project.zip"));await writeProjectZip(directory,signal);}
   if(job.upload){this.assertUploadAllowed(job.guildID);job.stage="Uploading";await this.save(job);for(const filename of await readdir(directory)){signal.throwIfAborted();if((["audition","audacity"].includes(job.format)||job.includeRaw)&&filename!=="project.zip")continue;if(!/^(track-\d+|mix|manifest|notes|transcript|session|project)\.(ogg|wav|flac|mp3|m4a|json|txt|srt|vtt|sesx|aup|zip)$/.test(filename))continue;const prefix=job.upload.toUpperCase();await uploadFile(job.upload,path.join(directory,filename),{token:await this.accounts.token(job.upload,signal),folder:process.env[`${prefix}_FOLDER`],name:`witness-${job.id}-${filename}`,signal});}}
   signal.throwIfAborted();job.state="completed";job.stage="Ready";
  }catch(error){job.state=signal.aborted?((this.stopped||this.diskAborted.has(job.id))&&(job as ExportJob).state!=="cancelling"?"queued":"cancelled"):"failed";job.error=signal.aborted?undefined:error instanceof Error?error.message:String(error);job.stage=job.state==="queued"?(this.diskAborted.has(job.id)?"Waiting for disk space":"Waiting for restart"):job.state==="cancelled"?"Cancelled":"Failed";if(this.diskAborted.has(job.id)&&job.directory&&/^export-[a-f0-9-]{36}$/i.test(job.directory)){await rm(path.join(this.root,job.sessionID,job.directory),{recursive:true,force:true});job.directory=undefined;}if(job.state==="failed")console.error(`[Export] Job ${job.id} failed:`,error);}
  finally{this.active.delete(job.id);this.diskAborted.delete(job.id);try{await this.save(job);}catch(error){this.pendingPersistence.add(job);throw error;}}
 }
 async pauseForDisk():Promise<void>{
  if(this.stopped)return;if(this.diskPausing)return this.diskPausing;this.diskPaused=true;
  const task=(async()=>{for(const [id,controller] of this.active){if(this.jobs.get(id)?.state!=="cancelling")this.diskAborted.add(id);controller.abort(new Error("Export paused to protect recording disk space."));}await Promise.allSettled([...this.running.values()]);this.pause();})();this.diskPausing=task;
  try{await task;}finally{if(this.diskPausing===task)this.diskPausing=undefined;}
 }
 maintenance(now=Date.now()):Promise<void>{
  const task=this.submissions.catch(()=>{}).then(async()=>{for(const [id,job] of this.jobs)if(["completed","failed","cancelled"].includes(job.state)&&!this.running.has(id)&&!this.saves.has(id)){try{const file=path.join(this.root,"jobs",id+".json");if(now-(await stat(file)).mtimeMs>JOB_RETENTION_MS){await rm(file);this.jobs.delete(id);}}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
   await sweepArtifacts(this.root,[...this.jobs.values()].filter(job=>["queued","running","cancelling"].includes(job.state)),new Set([...this.jobs.values()].map(job=>job.introID).filter((id):id is string=>!!id)),now,this.startSoundReferences());
  });this.submissions=task;return task;
 }
 async close():Promise<void>{this.stopped=true;if(this.diskGuard)clearInterval(this.diskGuard);if(this.maintenanceTimer)clearInterval(this.maintenanceTimer);if(this.cooldown){clearTimeout(this.cooldown);this.cooldown=undefined;}for(const controller of this.active.values())controller.abort(new Error("Export service stopping."));await this.submissions.catch(()=>{});await this.dispatching;await Promise.allSettled([...this.running.values()]);await Promise.all([...this.saves.values()]);for(const job of this.pendingPersistence)await this.save(job);this.pendingPersistence.clear();}
}

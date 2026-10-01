import { writeProjectZip } from "./project-zip";
import { existsSync } from "node:fs";
import { transcribeExport } from "../integrations/transcription";
import { uploadFile, CloudProvider } from "../integrations/cloud";
import { randomUUID } from "node:crypto";
import { mkdir,readdir,readFile,writeFile,rename,rm } from "node:fs/promises";
import path from "node:path";
import { exportSession, ExportFormat } from "./export";
import { getSession,sessionIDPattern } from "../storage/sessions";
type Extras={transcribe?:boolean;upload?:CloudProvider;trimStart?:number;trimEnd?:number};
export interface ExportJob extends Extras {id:string;sessionID:string;guildID:string;format:ExportFormat;mix:boolean;state:"queued"|"running"|"cancelling"|"cancelled"|"completed"|"failed";createdAt:string;directory?:string;error?:string;stage?:string;retryOf?:string}
export class ExportQueue {
 private jobs=new Map<string,ExportJob>();private worker?:Promise<void>;private stopped=false;private submissions:Promise<unknown>=Promise.resolve();private active=new Map<string,AbortController>();private saves=new Map<string,Promise<void>>();
 constructor(private root:string,private exporter=exportSession){}
 private save(job:ExportJob):Promise<void>{const body=JSON.stringify(job,null,2),file=path.join(this.root,"jobs",job.id+".json");const task=(this.saves.get(job.id)??Promise.resolve()).catch(()=>{}).then(async()=>{await writeFile(file+".tmp",body);await rename(file+".tmp",file);});this.saves.set(job.id,task);void task.finally(()=>{if(this.saves.get(job.id)===task)this.saves.delete(job.id);}).catch(()=>{});return task;}
 async load():Promise<void>{
  await mkdir(path.join(this.root,"jobs"),{recursive:true});
  for(const name of await readdir(path.join(this.root,"jobs"))){if(!/^[a-f0-9-]{36}\.json$/i.test(name))continue;
   try{const job=JSON.parse(await readFile(path.join(this.root,"jobs",name),"utf8")) as ExportJob;
    if(!job||!sessionIDPattern.test(job.id)||name!==job.id+".json"||!sessionIDPattern.test(job.sessionID)||typeof job.guildID!=="string"||typeof job.mix!=="boolean"||!["ogg","wav","flac","mp3","audition"].includes(job.format)||!["queued","running","cancelling","cancelled","completed","failed"].includes(job.state))throw new Error("Invalid export job metadata.");
    if(job.state==="running")job.state="queued";if(job.state==="cancelling")job.state="cancelled";this.jobs.set(job.id,job);
   }catch(error){console.warn(`[Export queue] Preserved unreadable job ${name}; skipped loading it.`,error);}
  }this.kick();
 }
 enqueue(sessionID:string,guildID:string,format:ExportFormat,mix=false,extras:Extras={}):Promise<ExportJob>{const task=this.submissions.catch(()=>{}).then(()=>this.submit(sessionID,guildID,format,mix,extras));this.submissions=task;return task;}
 private async submit(sessionID:string,guildID:string,format:ExportFormat,mix:boolean,extras:Extras):Promise<ExportJob>{
  if(this.stopped)throw new Error("Export service is stopping.");const session=await getSession(this.root,sessionID,guildID);if(session.state!=="completed")throw new Error("Only completed recordings can be exported.");
  if(!["ogg","wav","flac","mp3","audition"].includes(format))throw new Error("Invalid export format.");
  if(extras.trimStart!==undefined&&(!Number.isFinite(extras.trimStart)||extras.trimStart<0))throw new Error("Invalid trim start.");if(extras.trimEnd!==undefined&&(!Number.isFinite(extras.trimEnd)||extras.trimEnd<=(extras.trimStart??0)))throw new Error("Invalid trim end.");
  if(extras.transcribe&&(!process.env.TRANSCRIPTION_EXECUTABLE||!process.env.TRANSCRIPTION_MODEL))throw new Error("Configure a local transcription executable and model first.");if(extras.upload&&!["dropbox","google","onedrive","box"].includes(extras.upload))throw new Error("Invalid cloud provider.");if(extras.upload&&!process.env[`${extras.upload.toUpperCase()}_ACCESS_TOKEN`])throw new Error("Configure the cloud account first.");
  const existing=[...this.jobs.values()].find(job=>job.sessionID===sessionID&&job.format===format&&job.mix===mix&&job.transcribe===extras.transcribe&&job.upload===extras.upload&&job.trimStart===extras.trimStart&&job.trimEnd===extras.trimEnd&&["queued","running"].includes(job.state));if(existing)return existing;
  const job:ExportJob={id:randomUUID(),sessionID,guildID,format,mix,state:"queued",createdAt:new Date().toISOString(),...extras};await this.save(job);this.jobs.set(job.id,job);this.kick();return job;
 }
 private owned(id:string,guildID:string):ExportJob{const job=this.jobs.get(id);if(!job||job.guildID!==guildID)throw new Error("Export job not found in this server.");return job;}
 async cancel(id:string,guildID:string):Promise<ExportJob>{const job=this.owned(id,guildID);if(job.state==="queued"){job.state="cancelled";job.stage="Cancelled";}else if(job.state==="running"){job.state="cancelling";this.active.get(id)?.abort(new Error("Export cancelled."));}else if(!["cancelling","cancelled"].includes(job.state))throw new Error("Only queued or running jobs can be cancelled.");await this.save(job);return job;}
 async retry(id:string,guildID:string):Promise<ExportJob>{const previous=this.owned(id,guildID);if(!["failed","cancelled"].includes(previous.state))throw new Error("Only failed or cancelled jobs can be retried.");const {transcribe,upload,trimStart,trimEnd}=previous;const job=await this.enqueue(previous.sessionID,guildID,previous.format,previous.mix,{transcribe,upload,trimStart,trimEnd});job.retryOf=id;await this.save(job);return job;}
 busy(sessionID:string):boolean{return [...this.jobs.values()].some(job=>job.sessionID===sessionID&&["queued","running","cancelling"].includes(job.state));}
 get(id:string):ExportJob|undefined{return this.jobs.get(id);}
 private kick():void{if(this.worker||this.stopped)return;this.worker=this.run().catch(error=>{this.stopped=true;console.error("[Export queue] Storage failed; processing paused until restart.",error);}).finally(()=>{this.worker=undefined;if(!this.stopped&&[...this.jobs.values()].some(job=>job.state==="queued"))this.kick();});}
 private async run():Promise<void>{while(!this.stopped){const job=[...this.jobs.values()].find(job=>job.state==="queued");if(!job)return;const controller=new AbortController(),signal=controller.signal;this.active.set(job.id,controller);job.state="running";job.stage="Preparing audio";await this.save(job);
  try{
   const directory=await this.exporter(this.root,job.sessionID,{format:job.format,mix:job.mix,trimStart:job.trimStart,trimEnd:job.trimEnd,signal});job.directory=path.basename(directory);signal.throwIfAborted();
   if(job.transcribe){job.stage="Transcribing";await this.save(job);await transcribeExport(directory,{executable:process.env.TRANSCRIPTION_EXECUTABLE!,model:process.env.TRANSCRIPTION_MODEL!,ffmpeg:process.env.FFMPEG_PATH?.trim()||(existsSync(path.resolve(__dirname,"../../bin/ffmpeg"))?path.resolve(__dirname,"../../bin/ffmpeg"):"ffmpeg"),signal});}
   if(job.transcribe&&job.format==="audition"){await rm(path.join(directory,"project.zip"));await writeProjectZip(directory,signal);}
   if(job.upload){job.stage="Uploading";await this.save(job);for(const filename of await readdir(directory)){signal.throwIfAborted();if(!/^(track-\d+|mix|manifest|notes|transcript|session|project)\.(ogg|wav|flac|mp3|json|txt|srt|vtt|sesx|zip)$/.test(filename))continue;const prefix=job.upload.toUpperCase();await uploadFile(job.upload,path.join(directory,filename),{token:process.env[`${prefix}_ACCESS_TOKEN`]!,folder:process.env[`${prefix}_FOLDER`],name:`witness-${job.id}-${filename}`,signal});}}
   signal.throwIfAborted();job.state="completed";job.stage="Ready";
  }catch(error){job.state=signal.aborted?(this.stopped?"queued":"cancelled"):"failed";job.error=signal.aborted?undefined:error instanceof Error?error.message:String(error);job.stage=job.state==="queued"?"Waiting for restart":job.state==="cancelled"?"Cancelled":"Failed";}
  finally{this.active.delete(job.id);await this.save(job);}
 }}
 async close():Promise<void>{this.stopped=true;for(const controller of this.active.values())controller.abort(new Error("Export service stopping."));await this.submissions.catch(()=>{});await this.worker;await Promise.all([...this.saves.values()]);}
}

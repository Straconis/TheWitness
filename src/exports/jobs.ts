import { existsSync } from "node:fs";
import { transcribeExport } from "../integrations/transcription";
import { uploadFile, CloudProvider } from "../integrations/cloud";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { exportSession, ExportFormat } from "./export";
import { getSession, sessionIDPattern } from "../storage/sessions";
export interface ExportJob { id:string; sessionID:string; guildID:string; format:ExportFormat; mix:boolean; state:"queued"|"running"|"completed"|"failed"; createdAt:string; directory?:string; error?:string; transcribe?:boolean; upload?:CloudProvider; trimStart?:number; trimEnd?:number }
export class ExportQueue {
 private jobs=new Map<string,ExportJob>();private worker?:Promise<void>;private stopped=false;
 constructor(private root:string){}
 private async save(job:ExportJob):Promise<void>{const file=path.join(this.root,"jobs",job.id+".json");await writeFile(file+".tmp",JSON.stringify(job,null,2));await rename(file+".tmp",file);}
 async load():Promise<void>{
  await mkdir(path.join(this.root,"jobs"),{recursive:true});
  for(const name of await readdir(path.join(this.root,"jobs"))){
   if(!/^[a-f0-9-]{36}\.json$/i.test(name))continue;
   const job=JSON.parse(await readFile(path.join(this.root,"jobs",name),"utf8")) as ExportJob;
   if(!sessionIDPattern.test(job.id)||!sessionIDPattern.test(job.sessionID)||!["ogg","wav","flac","mp3"].includes(job.format))throw new Error("Invalid export job metadata.");
   if(job.state==="running")job.state="queued";
   this.jobs.set(job.id,job);
  }
  this.kick();
 }
 async enqueue(sessionID:string,guildID:string,format:ExportFormat,mix=false,extras:{transcribe?:boolean;upload?:CloudProvider;trimStart?:number;trimEnd?:number}={}):Promise<ExportJob>{
  if(this.stopped)throw new Error("Export service is stopping.");
  const session=await getSession(this.root,sessionID,guildID);
  if(session.state!=="completed")throw new Error("Only completed recordings can be exported.");
  if(!["ogg","wav","flac","mp3"].includes(format))throw new Error("Invalid export format.");
  if(extras.trimStart!==undefined&&(!Number.isFinite(extras.trimStart)||extras.trimStart<0))throw new Error("Invalid trim start.");
  if(extras.trimEnd!==undefined&&(!Number.isFinite(extras.trimEnd)||extras.trimEnd<=(extras.trimStart??0)))throw new Error("Invalid trim end.");
  if(extras.transcribe&&(!process.env.TRANSCRIPTION_EXECUTABLE||!process.env.TRANSCRIPTION_MODEL))throw new Error("Configure a local transcription executable and model first.");
  if(extras.upload&&!["dropbox","google","onedrive","box"].includes(extras.upload))throw new Error("Invalid cloud provider.");
  if(extras.upload&&!process.env[`${extras.upload.toUpperCase()}_ACCESS_TOKEN`])throw new Error("Configure the cloud account first.");
  const existing=[...this.jobs.values()].find(job=>job.sessionID===sessionID&&job.format===format&&job.mix===mix&&job.transcribe===extras.transcribe&&job.upload===extras.upload&&job.trimStart===extras.trimStart&&job.trimEnd===extras.trimEnd&&["queued","running"].includes(job.state));
  if(existing)return existing;
  const job:ExportJob={id:randomUUID(),sessionID,guildID,format,mix,state:"queued",createdAt:new Date().toISOString(),...extras};
  await this.save(job);this.jobs.set(job.id,job);this.kick();return job;
 }
 busy(sessionID:string):boolean{return [...this.jobs.values()].some(job=>job.sessionID===sessionID&&["queued","running"].includes(job.state));}
 get(id:string):ExportJob|undefined{return this.jobs.get(id);}
 private kick():void{
  if(this.worker||this.stopped)return;
  this.worker=this.run().catch(error=>console.error("[Export queue]",error)).finally(()=>{this.worker=undefined;if(!this.stopped&&[...this.jobs.values()].some(job=>job.state==="queued"))this.kick();});
 }
 private async run():Promise<void>{
  while(!this.stopped){
   const job=[...this.jobs.values()].find(job=>job.state==="queued");if(!job)return;
   job.state="running";await this.save(job);
   try{
    const directory=await exportSession(this.root,job.sessionID,{format:job.format,mix:job.mix,trimStart:job.trimStart,trimEnd:job.trimEnd});job.directory=path.basename(directory);
    if(job.transcribe)await transcribeExport(directory,{executable:process.env.TRANSCRIPTION_EXECUTABLE!,model:process.env.TRANSCRIPTION_MODEL!,ffmpeg:process.env.FFMPEG_PATH?.trim()||(existsSync(path.resolve(__dirname,"../../bin/ffmpeg"))?path.resolve(__dirname,"../../bin/ffmpeg"):"ffmpeg")});
    if(job.upload)for(const filename of await readdir(directory)){
      if(!/^(track-\d+|mix|manifest|notes|transcript)\.(ogg|wav|flac|mp3|json|txt|srt|vtt)$/.test(filename))continue;
      const prefix=job.upload.toUpperCase();await uploadFile(job.upload,path.join(directory,filename),{token:process.env[`${prefix}_ACCESS_TOKEN`]!,folder:process.env[`${prefix}_FOLDER`],name:`witness-${job.id}-${filename}`});
    }
    job.state="completed";
   }
   catch(error){job.state="failed";job.error=error instanceof Error?error.message:String(error);}
   await this.save(job);
  }
 }
 async close():Promise<void>{this.stopped=true;await this.worker;}
}

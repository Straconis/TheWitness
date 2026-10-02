import { randomUUID } from "node:crypto";
import { writeFile,rename } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OpusEncoder } from "@discordjs/opus";
import type {RecordingSession} from "./session";
export interface SyncSettings {enabled:boolean;mode:"start"|"end"|"both";startDelay:number;endDelay:number}
export interface SyncCue {id:string;sessionID:string;kind:"start"|"end";targetUTC:number;seconds:number;duration:number;state:"scheduled"|"captured"|"cancelled"}
export function validateSync(value:unknown):asserts value is SyncSettings {
 const s=value as SyncSettings;
 if(!s||typeof s.enabled!=="boolean"||!["start","end","both"].includes(s.mode)||![s.startDelay,s.endDelay].every(n=>Number.isFinite(n)&&n>=3&&n<=60))throw Error("Sync delays must be 3–60 seconds and placement must be start, end or both.");
}
export class SessionSync {
 readonly cues:SyncCue[]=[];private startAbort=new AbortController();private tasks:Promise<void>[]=[];private stopped?:Promise<void>;
 constructor(private session:RecordingSession,readonly settings:SyncSettings){}
 private async save(){const file=path.join(this.session.directory,"sync-cues.json");await writeFile(file+".tmp",JSON.stringify({version:1,sessionID:this.session.id,cues:this.cues},null,2));await rename(file+".tmp",file);}
 private async cue(kind:"start"|"end",seconds:number,signal?:AbortSignal){
  const sample=this.session.elapsedSamples()+BigInt(Math.round(seconds*48000));
  const cue:SyncCue={id:randomUUID(),sessionID:this.session.id,kind,targetUTC:Date.now()+seconds*1000,seconds:Number(sample)/48000,duration:0.3,state:"scheduled"};this.cues.push(cue);await this.save();
  try{await delay(Math.max(0,cue.targetUTC-Date.now()),undefined,{signal});
   const encoder=new OpusEncoder(48000,2);
   for(let frame=0;frame<15;frame++){
    const pcm=Buffer.alloc(3840);for(let i=0;i<960;i++){const n=frame*960+i;const envelope=Math.min(1,n/240,(14400-n)/240);const value=Math.round(Math.sin(n*2*Math.PI*1000/48000)*6000*envelope);pcm.writeInt16LE(value,i*4);pcm.writeInt16LE(value,i*4+2);}
    await this.session.append(encoder.encode(pcm),"witness-sync","Sync cues",Number((sample+BigInt(frame*960))&0xffffffffn),sample+BigInt(frame*960));
    await delay(20);
   }
   await this.session.note(`SYNC ${kind.toUpperCase()} ${cue.id}`,"witness-sync",sample);cue.state="captured";
  }catch(error){cue.state="cancelled";if(!signal?.aborted)throw error;}finally{await this.save();}
 }
 start(){if(this.settings.enabled&&this.settings.mode!=="end"){const task=this.cue("start",this.settings.startDelay,this.startAbort.signal);this.tasks.push(task);void task.catch(error=>console.warn('[Sync] Start cue failed:',error));}}
 stop(emit=true):Promise<void>{return this.stopped??=(async()=>{this.startAbort.abort();await Promise.allSettled(this.tasks);if(emit&&this.settings.enabled&&this.settings.mode!=="start")await this.cue("end",this.settings.endDelay);})();}
}

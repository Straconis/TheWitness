import {promisify} from "node:util";
import {execFile} from "node:child_process";
import {existsSync} from "node:fs";
import {rename,rm} from "node:fs/promises";
import path from "node:path";
import {runTool} from "./process";
import {UserError} from "../errors";
const inspect=promisify(execFile),support=new Map<string,Promise<boolean>>();
export function defaultAudioTool():string{
 if(process.env.FFMPEG_PATH?.trim())return process.env.FFMPEG_PATH.trim();
 for(const name of ["ffmpeg-portable","ffmpeg"]){const file=path.resolve(__dirname,"../../bin",name);if(existsSync(file))return file;}
 return "ffmpeg";
}
export function speechCleanupAvailable(tool=defaultAudioTool()):Promise<boolean>{
 let pending=support.get(tool);if(!pending){pending=Promise.all([
  inspect(tool,["-hide_banner","-filters"],{timeout:10000,maxBuffer:256000,killSignal:"SIGKILL"}),
  inspect(tool,["-hide_banner","-h","filter=alimiter"],{timeout:10000,maxBuffer:64000,killSignal:"SIGKILL"})
 ]).then(([filters,limiter])=>["afftdn","highpass","equalizer","alimiter"].every(name=>new RegExp(`\\b${name}\\b`).test(filters.stdout+filters.stderr))&&/\blatency\b/.test(limiter.stdout+limiter.stderr)).catch(()=>false);support.set(tool,pending);}return pending;
}
export async function assertSpeechCleanup(tool=defaultAudioTool()):Promise<void>{if(!await speechCleanupAvailable(tool))throw new UserError("Speech cleanup needs the updated audio tool. Install the current Witness audio bundle, or leave Clean up speech unchecked.");}
// Pinned FFmpeg afftdn has a 3/80-second window advancing 1/80 second: 25 ms latency.
// Flush that latency with padding and remove exactly the same samples, keeping all tracks aligned.
export const SPEECH_CLEANUP_FILTER="apad=pad_len=1200,highpass=f=70:p=2,afftdn=nr=6:nf=-50:tn=1:gs=3,atrim=start_sample=1200,asetpts=PTS-STARTPTS,equalizer=f=3000:t=q:w=0.7:g=1.5,alimiter=limit=0.95:level=false:latency=true";
export async function cleanSpeech(file:string,codec:string,tool:string,signal?:AbortSignal):Promise<void>{
 const output=path.join(path.dirname(file),"cleanup-"+path.basename(file));
 try{await runTool(tool,["-nostdin","-v","error","-n","-i",file,"-af",SPEECH_CLEANUP_FILTER,"-ar","48000","-c:a",codec,...(codec==="pcm_s16le"?["-rf64","auto"]:[]),...(codec==="aac"?["-f","mp4"]:[]),output],signal);await rename(output,file);}
 finally{await rm(output,{force:true});}
}

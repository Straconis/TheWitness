import {Worker} from "node:worker_threads";
import {open} from "node:fs/promises";
import path from "node:path";
import {projectSamples} from "./project-audio";
import {defaultAudioTool} from "./speech-cleanup";
import {UserError} from "../errors";
import type {NativeProjectInput,NativeTrackInput} from "./aup3-worker";
export interface NativeAudacityResult {file:string;bytes:number;blocks:number;silentBlocks:number;reusedBlocks:number}
export async function writeNativeAudacity(directory:string,tracks:Array<{file:string;username:string}>,notes:Array<{seconds:number;text:string}>=[],options:{project?:string;ffmpegPath?:string;signal?:AbortSignal;onProgress?:(stage:string,seconds:number,totalSeconds:number)=>void}={}):Promise<NativeAudacityResult>{
 options.signal?.throwIfAborted();if(!tracks.length)throw Error("Native Audacity projects need at least one track.");if(notes.some(n=>!Number.isFinite(n.seconds)||n.seconds<0||typeof n.text!=="string"))throw Error("Invalid native project note.");const project=options.project??"session";if(!/^[A-Za-z0-9-]+$/.test(project))throw Error("Invalid Audacity project name.");const file=project+".aup3",inputs:NativeTrackInput[]=[];
 for(const track of tracks){if(path.basename(track.file)!==track.file)throw Error("Invalid native project media path.");const filename=path.join(directory,track.file),frames=await projectSamples(filename),source=await open(filename,"r"),header=Buffer.alloc(128);let int16=false;
  try{await source.read(header,0,header.length,0);if(header.toString("ascii",0,4)==="fLaC")int16=Number(header.readBigUInt64BE(18)>>36n&31n)+1<=16;else{const fmt=header.indexOf(Buffer.from("fmt "),12);int16=fmt>=0&&fmt+24<=header.length&&header.readUInt16LE(fmt+22)===16;}}
  finally{await source.close();}inputs.push({file:filename,username:track.username,frames,format:int16?"int16":"float"});
 }
 const reserveGiB=Number(process.env.LOW_DISK_WARNING_GIB?.trim()||1);if(!Number.isFinite(reserveGiB)||reserveGiB<=0)throw Error("Invalid recording disk reserve.");
 const data:NativeProjectInput={output:path.join(directory,file),tracks:inputs,notes,ffmpeg:options.ffmpegPath??defaultAudioTool(),reserveBytes:reserveGiB*1024**3};
 return new Promise((resolve,reject)=>{
  const worker=new Worker(path.join(__dirname,"aup3-worker.js"),{workerData:data,resourceLimits:{maxOldGenerationSizeMb:256}}),children=new Set<number>();let result:NativeAudacityResult|undefined,error:Error|undefined,timer:NodeJS.Timeout|undefined;
  const abort=()=>{worker.postMessage({abort:true});timer=setTimeout(()=>{for(const pid of children)try{process.kill(pid,"SIGKILL");}catch{}void worker.terminate();},3000);timer.unref();};options.signal?.addEventListener("abort",abort,{once:true});if(options.signal?.aborted)abort();
  worker.on("message",message=>{if(message.type==="pid"&&message.pid)children.add(message.pid);if(message.type==="pid-closed")children.delete(message.pid);if(message.type==="progress")options.onProgress?.(`Writing Audacity project: speaker ${message.index} of ${message.count}: ${message.speaker}`,message.seconds,message.totalSeconds);if(message.type==="done")result={file,...message.result};if(message.type==="failed")error=message.disk?new UserError(message.message):new Error(message.message);});
  worker.on("error",failure=>{error=failure instanceof Error?failure:new Error(String(failure));});worker.on("exit",code=>{if(timer)clearTimeout(timer);options.signal?.removeEventListener("abort",abort);for(const pid of children)try{process.kill(pid,"SIGKILL");}catch{}if(options.signal?.aborted)reject(options.signal.reason);else if(error)reject(error);else if(code!==0||!result)reject(Error("Native Audacity writer stopped before completing the project."));else resolve(result);});
 });
}

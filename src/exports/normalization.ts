import {spawn} from "node:child_process";
import {once} from "node:events";
import {rename} from "node:fs/promises";
import path from "node:path";
import {runTool} from "./process";
export interface AudioLevel {rms:number;peak:number}
/** Measure RMS only in 100 ms windows containing audible audio, so pauses do not inflate gain. */
export async function measureLevel(file:string,ffmpeg:string,signal?:AbortSignal,raw=false):Promise<AudioLevel>{
 const combined=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(30*60*1000)]),child=spawn(ffmpeg,["-nostdin","-v","error",...(raw?["-f","s16le","-ar","48000","-ac","2"]:[]),"-i",file,"-ar","48000","-ac","2","-c:a","pcm_s16le","-f","s16le","pipe:1"],{stdio:["ignore","pipe","pipe"],signal:combined,killSignal:"SIGKILL"});let stderr="",pending=Buffer.alloc(0),peak=0,count=0,energy=0,windowPeak=0,windowCount=0,windowEnergy=0;child.stderr.on("data",chunk=>stderr=(stderr+chunk).slice(-2000));const closed=once(child,"close");closed.catch(()=>{});const flush=()=>{if(windowPeak>104){count+=windowCount;energy+=windowEnergy;}windowCount=0;windowEnergy=0;windowPeak=0;};
 try{for await(const chunk of child.stdout){const bytes=pending.length?Buffer.concat([pending,chunk]):chunk,length=bytes.length-bytes.length%2;for(let offset=0;offset<length;offset+=2){const value=bytes.readInt16LE(offset);peak=Math.max(peak,Math.abs(value));windowPeak=Math.max(windowPeak,Math.abs(value));windowEnergy+=value*value;windowCount++;if(windowCount===9600)flush();}pending=bytes.subarray(length);}flush();const [code]=await closed;if(code!==0)throw Error("Cannot measure audio level: "+stderr);return {rms:count?Math.sqrt(energy/count)/32768:0,peak:peak/32768};}catch(error){child.kill("SIGKILL");throw error;}
}
/** Constant gain preserves dynamics; cap boosts at 20 dB and peaks at -1 dBFS. */
export function normalizationGain(level:AudioLevel,target=0.1):number{return !level.rms||!level.peak?1:Math.min(target/level.rms,10,10**(-1/20)/level.peak);}
export async function applyGain(file:string,gain:number,codec:string,ffmpeg:string,signal?:AbortSignal):Promise<void>{
 if(Math.abs(gain-1)<0.0001)return;const output=path.join(path.dirname(file),"normalized-"+path.basename(file));await runTool(ffmpeg,["-nostdin","-v","error","-n","-i",file,"-af",`volume=${gain}`,"-c:a",codec,...(codec==="pcm_s16le"?["-rf64","auto"]:[]),...(codec==="aac"?["-f","mp4"]:[]),output],signal);await rename(output,file);
}

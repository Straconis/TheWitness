import {spawn} from "node:child_process";
import {once} from "node:events";
import {rename} from "node:fs/promises";
import path from "node:path";
import {runTool} from "./process";
export interface SilenceCut {start:number;end:number}
/** Detect activity per speaker, rather than summing waveforms that could cancel. 100 ms windows, -50 dBFS. */
export async function findSilenceCuts(files:string[],selected:Set<string>,ffmpeg:string,signal?:AbortSignal):Promise<{cuts:SilenceCut[];duration:number}>{
 const activity:number[]=[];let duration=0;
 for(const file of files){signal?.throwIfAborted();const combined=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(30*60*1000)]);const child=spawn(ffmpeg,["-nostdin","-v","error","-i",file,"-ar","48000","-ac","2","-c:a","pcm_s16le","-f","s16le","pipe:1"],{stdio:["ignore","pipe","pipe"],signal:combined,killSignal:"SIGKILL"});let stderr="",samples=0,pending=Buffer.alloc(0);child.stderr.on("data",chunk=>stderr=(stderr+chunk).slice(-2000));const closed=once(child,"close");closed.catch(()=>{});
 try{for await(const chunk of child.stdout){const bytes=pending.length?Buffer.concat([pending,chunk]):chunk;const length=bytes.length-(bytes.length%2);for(let offset=0;offset<length;offset+=2){if(selected.has(file)&&Math.abs(bytes.readInt16LE(offset))>104)activity[Math.floor(samples/9600)]=1;samples++;}pending=bytes.subarray(length);}const [code]=await closed;if(code!==0)throw Error("Cannot analyze silence: "+stderr);duration=Math.max(duration,samples/96000);}catch(error){child.kill("SIGKILL");throw error;}
 }
 const cuts:SilenceCut[]=[];let start:number|undefined;for(let window=0;window<Math.ceil(duration*10);window++){if(!activity[window])start??=window/10;else if(start!==undefined){const end=window/10;if(end-start>30)cuts.push({start,end});start=undefined;}}if(start!==undefined&&duration-start>30)cuts.push({start,end:duration});
 if(cuts.length>500)throw Error("This recording has too many silent pauses to trim in one export.");return {cuts,duration};
}
export function shiftedTime(seconds:number,cuts:SilenceCut[]):number{let removed=0;for(const cut of cuts){if(seconds>=cut.end)removed+=cut.end-cut.start;else if(seconds>cut.start){removed+=seconds-cut.start;break;}else break;}return Math.max(0,seconds-removed);}
export async function cutSharedSilence(files:string[],cuts:SilenceCut[],duration:number,codec:string,ffmpeg:string,signal?:AbortSignal):Promise<void>{
 if(!cuts.length)return;const ranges:Array<[number,number]>=[];let cursor=0;for(const cut of cuts){if(cut.start>cursor)ranges.push([cursor,cut.start]);cursor=cut.end;}if(cursor<duration)ranges.push([cursor,duration]);if(!ranges.length)throw Error("The selected speakers are silent throughout this recording; no audio would remain.");
 for(const file of files){const output=path.join(path.dirname(file),"silence-trimmed-"+path.basename(file));let kept=0;const graph=[`[0:a]apad=whole_dur=${duration},asplit=${ranges.length}${ranges.map((_,i)=>`[s${i}]`).join("")}`,...ranges.map(([start,end],i)=>{const at=kept;kept+=end-start;return `[s${i}]atrim=start=${start}:end=${end},asetpts=PTS-STARTPTS,adelay=${Math.round(at*48000)}S:all=1[c${i}]`;}),`${ranges.map((_,i)=>`[c${i}]`).join("")}amix=inputs=${ranges.length}:duration=longest:normalize=0[out]`].join(";");await runTool(ffmpeg,["-nostdin","-v","error","-n","-i",file,"-filter_complex",graph,"-map","[out]","-c:a",codec,...(codec==="pcm_s16le"?["-rf64","auto"]:[]),...(codec==="aac"?["-f","mp4"]:[]),output],signal);await rename(output,file);}
}

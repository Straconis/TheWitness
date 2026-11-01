import {checkExportSpace,exportProgressReporter} from "./workspace";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { setPriority } from "node:os";
/** Lower CPU priority so exports and transcription compete less with live recording. */
export function deprioritize<T extends ChildProcess>(child:T,priority=10):T{
 try{if(child.pid)setPriority(child.pid,priority);}catch{/* Unsupported platform or the process already exited. */}
 return child;
}
/** An error/abort event can precede close; cleanup must wait until the tool and pipes are gone. */
export function processClosed(child:ChildProcess):Promise<void>{return new Promise(resolve=>child.once("close",()=>resolve()));}
/** Bounded diagnostics and cancellation for optional local tools. */
export async function runTool(executable:string,args:string[],signal?:AbortSignal,timeoutMs=30*60*1000,idleTimeoutMs?:number):Promise<void>{
 const spaceCheck=checkExportSpace();if(spaceCheck)await spaceCheck;signal?.throwIfAborted();const stalled=new AbortController();let watchdog:NodeJS.Timeout|undefined;const resetWatchdog=()=>{if(idleTimeoutMs){clearTimeout(watchdog);watchdog=setTimeout(()=>stalled.abort(),idleTimeoutMs);watchdog.unref();}};const combined=AbortSignal.any([stalled.signal,...(signal?[signal]:[]),AbortSignal.timeout(timeoutMs)]);
 const report=/^ffmpeg(?:-portable)?(?:\.exe)?$/i.test(path.basename(executable))||idleTimeoutMs?exportProgressReporter():undefined;const monitor=!!idleTimeoutMs||!!report;
 const toolArgs=monitor?["-progress","pipe:1","-stats_period","1","-nostats",...args]:args;
 report?.(0);
 const child=spawn(executable,toolArgs,{stdio:["ignore",monitor?"pipe":"ignore","pipe"],signal:combined,killSignal:"SIGKILL"});deprioritize(child);const closed=processClosed(child);let stderr="";
 let progressBuffer="";
 resetWatchdog();let lastProgress=-1;
 if(monitor)child.stdout!.on("data",chunk=>{
  progressBuffer+=chunk.toString();const lines=progressBuffer.split("\n");progressBuffer=lines.pop()!.slice(-4096);
  for(const line of lines){const match=/^out_time_us=(\d+)$/.exec(line.trim());if(match){const seconds=Number(match[1])/1e6;if(Number.isFinite(seconds)&&seconds>=0){if(seconds>lastProgress){lastProgress=seconds;resetWatchdog();}report?.(seconds);}}}
 });
 child.stderr!.on("data",chunk=>{stderr=(stderr+chunk).slice(-8192);});
 try{const [code]=await once(child,"close");if(code!==0)throw new Error(`Audio tool failed (${code}): ${stderr}`);}
 catch(error){child.kill("SIGKILL");await closed;if(signal?.aborted)throw signal.reason;if(stalled.signal.aborted)throw new Error("Audio tool stalled: audio progress stopped.");if(combined.aborted)throw new Error("Audio tool timed out.");throw error;}finally{clearTimeout(watchdog);}
}

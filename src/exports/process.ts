import { spawn } from "node:child_process";
import { once } from "node:events";
/** Bounded diagnostics and cancellation for optional local tools. */
export async function runTool(executable:string,args:string[],signal?:AbortSignal,timeoutMs=30*60*1000):Promise<void>{
 signal?.throwIfAborted();const combined=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(timeoutMs)]);
 const child=spawn(executable,args,{stdio:["ignore","ignore","pipe"],signal:combined,killSignal:"SIGKILL"});let stderr="";
 child.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-8192);});
 try{const [code]=await once(child,"close");if(code!==0)throw new Error(`Audio tool failed (${code}): ${stderr}`);}
 catch(error){child.kill("SIGKILL");if(signal?.aborted)throw signal.reason;if(combined.aborted)throw new Error("Audio tool timed out.");throw error;}
}

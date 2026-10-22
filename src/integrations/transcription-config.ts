import { existsSync,statSync } from "node:fs";
import { spawn,ChildProcess } from "node:child_process";
import path from "node:path";

/**
 * whisper-cli capability probing. Pages, dashboards and export submission only read a cached result, so they never run or wait
 * for a child process: a slow probe must not stall the event loop that also processes live recordings.
 * - One probe at a time per executable version (path, size, modification time); concurrent callers share it.
 * - A completed probe is cached until the executable changes. A failed or timed-out probe is retried with exponential backoff
 *   (1 s doubling to 5 min), so repeated page views cannot cause a probe storm.
 * - Shutdown stops retries and kills any probe still running.
 */
type ProbeState={key:string;supported?:boolean;running?:Promise<boolean|undefined>;failures:number;retryAt:number;abort?:()=>void};
const probes=new Map<string,ProbeState>();
let probeTimeoutMs=10000,backoffBaseMs=1000,backoffMaxMs=300000,probingStopped=false;
/** Test and host-check hooks; production uses the defaults. */
export function configureVadProbe(options:{timeoutMs?:number;backoffBaseMs?:number;backoffMaxMs?:number}={}):void{
 if(options.timeoutMs!==undefined)probeTimeoutMs=options.timeoutMs;if(options.backoffBaseMs!==undefined)backoffBaseMs=options.backoffBaseMs;if(options.backoffMaxMs!==undefined)backoffMaxMs=options.backoffMaxMs;
}
function versionKey(executable:string):string|undefined{try{const info=statSync(executable);return `${executable}:${info.size}:${info.mtimeMs}`;}catch{return undefined;}}
/** Runs `whisper-cli --help` asynchronously; resolves true/false when it completes, undefined on spawn failure or timeout. */
function runProbe(state:ProbeState,executable:string):Promise<boolean|undefined>{
 return new Promise(resolve=>{
  let timer:ReturnType<typeof setTimeout>|undefined;
  let output="",settled=false;const finish=(value:boolean|undefined)=>{if(settled)return;settled=true;clearTimeout(timer);state.abort=undefined;resolve(value);};
  let child:ChildProcess;
  try{child=spawn(executable,["--help"],{stdio:["ignore","pipe","pipe"],detached:process.platform!=="win32"});}catch{finish(undefined);return;}
  // A configured executable may be a wrapper. Kill its process group on Unix so descendants cannot outlive the probe.
  // Destroy our pipe handles too: resolving the promise alone does not allow Node to exit.
  const killGroup=()=>{try{if(process.platform!=="win32"&&child.pid)process.kill(-child.pid,"SIGKILL");else child.kill("SIGKILL");}catch{child.kill("SIGKILL");}};
  state.abort=()=>{killGroup();child.stdout?.destroy();child.stderr?.destroy();finish(undefined);};
  // When the executable itself exits, stop anything it left running in its group: a leftover descendant would otherwise
  // keep running after the probe, and if it holds the output pipes, "close" (and the result) would wait for the timeout.
  child.once("exit",()=>{if(process.platform!=="win32")killGroup();});
  const collect=(chunk:Buffer)=>{if(output.length<4*1024*1024)output+=chunk.toString("utf8");};
  child.stdout?.on("data",collect);child.stderr?.on("data",collect);
  child.once("error",()=>finish(undefined));
  child.once("close",(code,signal)=>finish(signal?undefined:/--vad-model\b/.test(output)));
  timer=setTimeout(()=>state.abort?.(),probeTimeoutMs);timer.unref();
 });
}
/** Starts (or joins) the probe for this executable unless a result is cached or a retry is not yet due. */
export function probeVad(executable:string,options:{ignoreBackoff?:boolean}={}):Promise<boolean|undefined>{
 const key=versionKey(executable);if(!key)return Promise.resolve(false);
 let state=probes.get(executable);if(!state||state.key!==key){state?.abort?.();state={key,failures:0,retryAt:0};probes.set(executable,state);}
 if(state.supported!==undefined)return Promise.resolve(state.supported);
 if(state.running)return state.running;
 if(probingStopped||(!options.ignoreBackoff&&Date.now()<state.retryAt))return Promise.resolve(undefined);
 const current=state;
 // Spawn on a later turn: even starting a child (fork/exec) takes milliseconds under load and must not delay the caller.
 current.running=new Promise<void>(resolve=>setImmediate(resolve)).then(()=>probingStopped?undefined:runProbe(current,executable)).then(result=>{
  current.running=undefined;
  if(result===undefined){current.failures++;current.retryAt=Date.now()+Math.min(backoffMaxMs,backoffBaseMs*2**(current.failures-1));}
  else{current.supported=result;current.failures=0;}
  return result;
 });
 return current.running;
}
/** Cached VAD support without starting anything: true/false once probed, undefined while unknown. */
export function cachedVadSupport(executable:string):boolean|undefined{
 const key=versionKey(executable),state=probes.get(executable);return key&&state?.key===key?state.supported:undefined;
}
/** Shutdown: no further probes; a probe still running is killed. */
export function stopVadProbes():void{probingStopped=true;for(const state of probes.values())state.abort?.();}
/** For tests and in-process restarts. */
export function resetVadProbes():void{stopVadProbes();probes.clear();probingStopped=false;}

export function transcriptionConfig(){
 const bundled=path.resolve(__dirname,"../../bin"),executable=process.env.TRANSCRIPTION_EXECUTABLE?.trim()||(existsSync(path.join(bundled,"whisper-cli"))?path.join(bundled,"whisper-cli"):""),model=process.env.TRANSCRIPTION_MODEL?.trim()||["small.en","base.en"].map(name=>path.join(bundled,`models/ggml-${name}.bin`)).find(file=>existsSync(file))||"";
 // Speech detection is opt-in: an installed model is not used unless TRANSCRIPTION_VAD_MODEL names it (or "auto" selects the
 // bundled one). whisper.cpp 1.8.7's VAD measured 81.5 s of 86 s on an idle 2-core VPS, so installing the model must not enable it.
 const vadSetting=process.env.TRANSCRIPTION_VAD_MODEL?.trim(),bundledVad=path.join(bundled,"models/ggml-silero-v6.2.0.bin"),vadModel=!vadSetting||vadSetting.toLowerCase()==="off"?undefined:vadSetting.toLowerCase()==="auto"?bundledVad:vadSetting;
 const threads=Number(process.env.TRANSCRIPTION_THREADS||"2"),timeoutMs=Number(process.env.TRANSCRIPTION_TIMEOUT_MINUTES||"30")*60000,language=process.env.TRANSCRIPTION_LANGUAGE?.trim()||"en",prompt=process.env.TRANSCRIPTION_PROMPT?.trim();
 if(!Number.isInteger(threads)||threads<1||threads>32||!Number.isFinite(timeoutMs)||timeoutMs<60000||timeoutMs>86400000||!/^([a-z]{2,3}|auto)$/.test(language)||(prompt&&prompt.length>2000))throw Error("Invalid transcription configuration.");
 if(vadModel&&!existsSync(vadModel))throw Error("Transcription VAD model not found.");
 return {executable,model,vadModel,threads,timeoutMs,language,prompt};
}
const VAD_UNSUPPORTED="The configured whisper-cli does not support --vad. Install a VAD-capable whisper.cpp build (1.8.7 is verified) or set TRANSCRIPTION_VAD_MODEL=off.";
let reportedConfigError:string|undefined;
function report(message:string):void{if(reportedConfigError!==message){reportedConfigError=message;console.warn(`[Transcription] Disabled until the configuration is fixed: ${message}`);}}
/**
 * Never throws and never blocks: pages, dashboards and export submission call this. With a VAD model it uses the cached probe
 * and, when none is cached, starts one in the background and answers "not ready" until it finishes.
 */
export function transcriptionReady():boolean{
 try{
  const config=transcriptionConfig();if(!config.executable||!config.model||!existsSync(config.executable)||!existsSync(config.model))return false;
  if(!config.vadModel)return true;
  const supported=cachedVadSupport(config.executable);
  if(supported===undefined){void probeVad(config.executable).then(result=>{if(result===false)report(VAD_UNSUPPORTED);});return false;}
  if(!supported)report(VAD_UNSUPPORTED);
  return supported;
 }catch(error){report(error instanceof Error?error.message:String(error));return false;}
}
/** "checking" while a VAD probe result is not yet known, so callers can say so instead of "not configured". */
export function transcriptionStatus():"ready"|"checking"|"unavailable"{
 if(transcriptionReady())return "ready";
 try{const config=transcriptionConfig();if(config.vadModel&&config.executable&&config.model&&existsSync(config.executable)&&existsSync(config.model)&&cachedVadSupport(config.executable)===undefined)return "checking";}catch{/* unavailable */}
 return "unavailable";
}
/** Waits for the probe (bounded by its timeout); for startup, job processing and command-line checks, never request paths. */
export async function transcriptionReadyAsync():Promise<boolean>{
 try{const config=transcriptionConfig();if(config.vadModel&&config.executable&&existsSync(config.executable))await probeVad(config.executable);}catch{/* reported below */}
 return transcriptionReady();
}
/** The configuration for running a job: also requires a completed probe showing VAD support when VAD is enabled. */
export async function checkedTranscriptionConfig(){
 const config=transcriptionConfig();
 // A job may probe during backoff: jobs run one at a time, so this cannot storm, and a transient failure should not fail the job.
 if(config.vadModel){const supported=await probeVad(config.executable,{ignoreBackoff:true});if(supported===undefined)throw Error("Could not check whether whisper-cli supports --vad; it will be retried.");if(!supported)throw Error(VAD_UNSUPPORTED);}
 return config;
}

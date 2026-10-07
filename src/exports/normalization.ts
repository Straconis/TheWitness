import {promisify} from "node:util";
import {spawn,execFile} from "node:child_process";
import {once} from "node:events";
import {rename,rm} from "node:fs/promises";
import path from "node:path";
import {runTool,deprioritize,processClosed} from "./process";
const inspectTool=promisify(execFile);
const loudnessRanges=new Map<string,Promise<number>>();
/** Older host/CI builds cap LRA at 20; newer builds allow 50. Use the widest supported range. */
function loudnessRange(ffmpeg:string):Promise<number>{
 let pending=loudnessRanges.get(ffmpeg);
 if(!pending){pending=inspectTool(ffmpeg,["-hide_banner","-h","filter=loudnorm"],{timeout:10000,maxBuffer:32768,killSignal:"SIGKILL"}).then(({stdout,stderr})=>{
  const maximum=Number(/\bLRA\s+[^\n]*\(from 1 to (\d+)\)/.exec(stdout+stderr)?.[1]);
  if(!Number.isFinite(maximum)||maximum<1)throw Error("FFmpeg lacks compatible loudnorm support. Rebuild the bundled audio tool.");
  return Math.min(50,maximum);
 });loudnessRanges.set(ffmpeg,pending);void pending.catch(()=>loudnessRanges.delete(ffmpeg));}
 return pending;
}
export const TARGET_LUFS=-16;
export const TRUE_PEAK_DBTP=-1;
export const MAX_BOOST_DB=20;
export interface LoudnessSettings {targetLUFS?:number;maxTruePeakDBTP?:number}
export function resolveLoudness(settings:LoudnessSettings={}):Required<LoudnessSettings>{
 const targetLUFS=settings.targetLUFS??TARGET_LUFS,maxTruePeakDBTP=settings.maxTruePeakDBTP??TRUE_PEAK_DBTP;
 if(typeof targetLUFS!=="number"||!Number.isFinite(targetLUFS)||targetLUFS < -70||targetLUFS > -5)throw Error("Target loudness must be between -70 and -5 LUFS.");
 if(typeof maxTruePeakDBTP!=="number"||!Number.isFinite(maxTruePeakDBTP)||maxTruePeakDBTP < -9||maxTruePeakDBTP > 0)throw Error("Maximum true peak must be between -9 and 0 dBTP.");
 return {targetLUFS,maxTruePeakDBTP};
}
export interface AudioLevel {lufs:number;truePeak:number;lra:number;threshold:number;offset?:number}
export interface LoudnessMatch {before:AudioLevel;after:AudioLevel;targetLUFS:number;boostLimited:boolean}
/** BS.1770 / EBU R128 gated integrated loudness and oversampled true peak. */
export async function measureLevel(file:string,ffmpeg:string,signal?:AbortSignal,raw=false,settings:LoudnessSettings={}):Promise<AudioLevel>{
 const {targetLUFS,maxTruePeakDBTP}=resolveLoudness(settings);
 signal?.throwIfAborted();const range=await loudnessRange(ffmpeg);
 const combined=AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(30*60*1000)]);
 const child=deprioritize(spawn(ffmpeg,["-nostdin","-hide_banner","-v","info",...(raw?["-f","s16le","-ar","48000","-ac","2"]:[]),"-i",file,"-af",`loudnorm=I=${targetLUFS}:TP=${maxTruePeakDBTP}:LRA=${range}:print_format=json`,"-f","null","-"],{stdio:["ignore","ignore","pipe"],signal:combined,killSignal:"SIGKILL"}));
 const closed=processClosed(child);let stderr="";child.stderr.on("data",chunk=>stderr=(stderr+chunk).slice(-16384));
 try{
  const [code]=await once(child,"close");if(code!==0)throw Error("Cannot measure audio loudness: "+stderr);
  const json=/\{\s*"input_i"[\s\S]*?\}/.exec(stderr);if(!json)throw Error("Audio tool did not return loudness measurements. Rebuild the bundled FFmpeg with loudnorm enabled.");
  const data=JSON.parse(json[0]),numeric=(value:string):number=>value==="-inf"?-Infinity:value==="inf"?Infinity:Number(value),level={lufs:numeric(data.input_i),truePeak:numeric(data.input_tp),lra:numeric(data.input_lra),threshold:numeric(data.input_thresh),offset:numeric(data.target_offset)};
  if(Number.isNaN(level.lufs)||Number.isNaN(level.truePeak)||!Number.isFinite(level.lra)||(Number.isFinite(level.lufs)&&!Number.isFinite(level.threshold)))throw Error("Invalid loudness measurements.");
  return level;
 }catch(error){child.kill("SIGKILL");await closed;if(signal?.aborted)throw signal.reason;throw error;}
}
/** Constant gain for intro matching, capped by true peak and a 20 dB boost. */
export function normalizationGain(level:AudioLevel,target=TARGET_LUFS,truePeak=TRUE_PEAK_DBTP):number{
 if(!Number.isFinite(level.lufs)||!Number.isFinite(level.truePeak))return 1;
 return 10**(Math.min(target-level.lufs,MAX_BOOST_DB,truePeak-level.truePeak)/20);
}
function encoding(codec:string):string[]{return ["-ar","48000","-c:a",codec,...(codec==="pcm_s16le"?["-rf64","auto"]:[]),...(codec==="aac"?["-f","mp4"]:[])];}
async function filterFile(file:string,filter:string,codec:string,ffmpeg:string,signal?:AbortSignal):Promise<void>{
 const output=path.join(path.dirname(file),"normalized-"+path.basename(file));
 try{await runTool(ffmpeg,["-nostdin","-v","error","-n","-i",file,"-af",filter,...encoding(codec),output],signal);await rename(output,file);}
 finally{await rm(output,{force:true});}
}
export async function applyGain(file:string,gain:number,codec:string,ffmpeg:string,signal?:AbortSignal):Promise<void>{
 if(!Number.isFinite(gain)||gain<=0)throw Error("Invalid normalization gain.");
 if(Math.abs(gain-1)<0.0001)return;
 await filterFile(file,`volume=${gain}`,codec,ffmpeg,signal);
}
/** Two-pass loudness matching. Preserve dynamics when possible; limit peaks when needed. */
export async function matchLoudness(file:string,codec:string,ffmpeg:string,signal?:AbortSignal,measured?:AudioLevel,settings:LoudnessSettings={}):Promise<LoudnessMatch>{
 const {targetLUFS,maxTruePeakDBTP}=resolveLoudness(settings);
 const before=measured??await measureLevel(file,ffmpeg,signal,false,settings);
 if(!Number.isFinite(before.lufs)||!Number.isFinite(before.truePeak))return {before,after:before,targetLUFS,boostLimited:false};
 // loudnorm's accepted target range is -70 .. -5 LUFS. Never boost nearly silent tracks past the safety cap.
 const target=Math.min(targetLUFS,before.lufs+MAX_BOOST_DB);
 if(target < -70)return {before,after:before,targetLUFS:target,boostLimited:true};
 const range=await loudnessRange(ffmpeg);
 const filter=`loudnorm=I=${target}:TP=${maxTruePeakDBTP}:LRA=${range}:measured_I=${before.lufs}:measured_TP=${before.truePeak}:measured_LRA=${before.lra}:measured_thresh=${before.threshold}:offset=${Number.isFinite(before.offset)?before.offset:0}:linear=true`;
 await filterFile(file,filter,codec,ffmpeg,signal);
 return {before,after:await measureLevel(file,ffmpeg,signal,false,settings),targetLUFS:target,boostLimited:target<targetLUFS};
}

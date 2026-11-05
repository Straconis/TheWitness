import {spawn} from "node:child_process";
import {once} from "node:events";
import {rename,rm} from "node:fs/promises";
import path from "node:path";
import {deprioritize,processClosed} from "./process";
import {checkExportSpace,exportProgressReporter} from "./workspace";
export const BLEED_PRESET="cross-track-gate-v1",BLEED_ATTENUATION_DB=15;
export type BleedReport=Record<string,{reducedSeconds:number}>;
export interface BleedTrack {key:string;file:string;username:string}
/** Log-energy envelope of one speaker: 20 ms frames, overall level plus six speech bands, in whole dB. */
export interface BleedEnvelope {levels:Uint8Array;bands:Uint8Array}
const RATE=8000,FFT=256,HOP=160,FRAME_SECONDS=HOP/RATE,BANDS=[250,500,800,1200,1800,2600,3600],COUNT=BANDS.length-1,OFFSET=100;
const CONTEXT=25,MAX_LAG=5,STEP=5,MARGIN_DB=8,CORRELATION=0.65,ACTIVE_DB=25,FILL_GAP=10,MINIMUM_RUN=5,RELEASE=Math.exp(-20/100),ATTACK=Math.exp(-20/30);
const window=Float64Array.from({length:FFT},(_,n)=>0.5-0.5*Math.cos(2*Math.PI*n/FFT));
const cosines=Float64Array.from({length:FFT/2},(_,n)=>Math.cos(2*Math.PI*n/FFT)),sines=Float64Array.from({length:FFT/2},(_,n)=>-Math.sin(2*Math.PI*n/FFT));
const reversed=Uint16Array.from({length:FFT},(_,n)=>{let out=0;for(let bit=0,size=FFT;size>1;bit++,size>>=1)out=out*2+(n>>bit&1);return out;});
function fft(real:Float64Array,imag:Float64Array):void{
 for(let i=0;i<FFT;i++){const j=reversed[i]!;if(j>i){const r=real[i]!;real[i]=real[j]!;real[j]=r;const m=imag[i]!;imag[i]=imag[j]!;imag[j]=m;}}
 for(let size=2;size<=FFT;size*=2){const half=size/2,step=FFT/size;for(let start=0;start<FFT;start+=size)for(let k=0;k<half;k++){const at=start+k,to=at+half,c=cosines[k*step]!,s=sines[k*step]!,r=real[to]!*c-imag[to]!*s,m=real[to]!*s+imag[to]!*c;real[to]=real[at]!-r;imag[to]=imag[at]!-m;real[at]=real[at]!+r;imag[at]=imag[at]!+m;}}
}
const toByte=(power:number)=>power>1e-10?Math.max(1,Math.min(255,Math.round(10*Math.log10(power))+OFFSET)):0;
export class EnvelopeBuilder {
 private history=new Float32Array(FFT);private filled=0;private frames=0;private levels=new Uint8Array(4096);private bands=new Uint8Array(4096*COUNT);private real=new Float64Array(FFT);private imag=new Float64Array(FFT);
 push(sample:number):void{this.history[this.filled++]=sample;if(this.filled===FFT){this.frame();this.history.copyWithin(0,HOP);this.filled=FFT-HOP;}}
 private frame():void{
  if(this.frames===this.levels.length){const levels=new Uint8Array(this.frames*2),bands=new Uint8Array(this.frames*2*COUNT);levels.set(this.levels);bands.set(this.bands);this.levels=levels;this.bands=bands;}
  this.real.set(this.history);for(let n=0;n<FFT;n++)this.real[n]=this.real[n]!*window[n]!;this.imag.fill(0);fft(this.real,this.imag);
  let total=0;for(let band=0;band<COUNT;band++){let power=0;for(let bin=Math.round(BANDS[band]!*FFT/RATE),end=Math.round(BANDS[band+1]!*FFT/RATE);bin<end;bin++)power+=this.real[bin]!*this.real[bin]!+this.imag[bin]!*this.imag[bin]!;total+=power;this.bands[this.frames*COUNT+band]=toByte(power);}
  this.levels[this.frames++]=toByte(total);
 }
 finish():BleedEnvelope{if(this.filled>FFT-HOP){this.history.fill(0,this.filled);this.frame();}return {levels:this.levels.subarray(0,this.frames),bands:this.bands.subarray(0,this.frames*COUNT)};}
}
/** Typical speaking level: the 95th percentile of frames that are not digital silence. */
function speakingLevel(levels:Uint8Array):number{
 const histogram=new Float64Array(256);let active=0;for(const level of levels)if(level){histogram[level]!++;active++;}
 let seen=0;for(let level=0;level<256;level++){seen+=histogram[level]!;if(seen>=active*0.95)return level;}return 0;
}
/** Band envelopes with each band's mean removed, so correlation follows timing and not the shared shape of speech. */
function correlate(target:BleedEnvelope,source:BleedEnvelope,frame:number,lag:number):number{
 const first=Math.max(CONTEXT<=frame?frame-CONTEXT:0,-lag),end=Math.min(frame+CONTEXT+1,target.levels.length,source.levels.length-lag);if(end-first<CONTEXT)return 0;
 const length=end-first;let product=0,targetEnergy=0,sourceEnergy=0;
 for(let band=0;band<COUNT;band++){
  let targetMean=0,sourceMean=0;for(let f=first;f<end;f++){targetMean+=target.bands[f*COUNT+band]!;sourceMean+=source.bands[(f+lag)*COUNT+band]!;}targetMean/=length;sourceMean/=length;
  for(let f=first;f<end;f++){const a=target.bands[f*COUNT+band]!-targetMean,b=source.bands[(f+lag)*COUNT+band]!-sourceMean;product+=a*b;targetEnergy+=a*a;sourceEnergy+=b*b;}
 }
 return targetEnergy>0&&sourceEnergy>0?product/Math.sqrt(targetEnergy*sourceEnergy):0;
}
/** A frame is bleed when another speaker is clearly louder and this track follows that speaker's envelope. */
export async function findBleed(envelopes:BleedEnvelope[],signal?:AbortSignal):Promise<Uint8Array[]>{
 signal?.throwIfAborted();
 const speaking=envelopes.map(envelope=>speakingLevel(envelope.levels));let deadline=performance.now()+5;
 const masks:Uint8Array[]=[];
 for(let index=0;index<envelopes.length;index++){
  const target=envelopes[index]!,mask=new Uint8Array(target.levels.length);
  for(let frame=0;frame<target.levels.length;frame+=STEP){
   // Yield on elapsed time even when every comparison matches or is skipped.
   if(performance.now()>=deadline){signal?.throwIfAborted();await new Promise(resolve=>setImmediate(resolve));deadline=performance.now()+5;}
   const level=target.levels[frame]!;if(!level)continue;
   search:for(let other=0;other<envelopes.length;other++){
    if(other===index)continue;const source=envelopes[other]!,near=source.levels[frame]??0;
    if(near<speaking[other]!-ACTIVE_DB||Math.max(near-level,near-speaking[other]!-level+speaking[index]!)<MARGIN_DB)continue;
    for(let lag=-MAX_LAG;lag<=MAX_LAG;lag++)if(correlate(target,source,frame,lag)>=CORRELATION){mask.fill(1,Math.max(0,frame-2),frame+3);break search;}
   }
  }
  masks.push(tidy(mask));
 }
 return masks;
}
function tidy(mask:Uint8Array):Uint8Array{
 let last=-1;for(let f=0;f<mask.length;f++)if(mask[f]){if(last>=0&&f-last-1<=FILL_GAP)mask.fill(1,last+1,f);last=f;}
 let start=-1;for(let f=0;f<=mask.length;f++){if(f<mask.length&&mask[f]){if(start<0)start=f;}else if(start>=0){if(f-start<MINIMUM_RUN)mask.fill(0,start,f);start=-1;}}
 return mask;
}
/** Linear gain per frame centre: reach the reduction just before bleed begins and recover smoothly after it ends. */
export function bleedGains(mask:Uint8Array):Float32Array{
 const decibels=new Float32Array(mask.length);let held=0;
 for(let f=0;f<mask.length;f++){held=Math.min(mask[f]?-BLEED_ATTENUATION_DB:0,held*RELEASE);decibels[f]=held;}
 held=0;for(let f=mask.length-1;f>=0;f--){held=Math.min(decibels[f]!,held*ATTACK);decibels[f]=held;}
 return decibels.map(value=>10**(value/20));
}
async function scan(track:BleedTrack,ffmpeg:string,signal?:AbortSignal):Promise<BleedEnvelope>{
 const child=deprioritize(spawn(ffmpeg,["-nostdin","-v","error","-i",track.file,"-ac","1","-ar",String(RATE),"-c:a","pcm_f32le","-f","f32le","pipe:1"],{stdio:["ignore","pipe","pipe"],signal,killSignal:"SIGKILL"})),closed=processClosed(child),builder=new EnvelopeBuilder(),report=exportProgressReporter();
 let stderr="",pending:Buffer=Buffer.alloc(0),samples=0;child.stderr.on("data",chunk=>stderr=(stderr+chunk).slice(-2000));const exit=once(child,"close");exit.catch(()=>{});
 try{for await(const chunk of child.stdout){const bytes=pending.length?Buffer.concat([pending,chunk]):chunk as Buffer,length=bytes.length-bytes.length%4;for(let at=0;at<length;at+=4)builder.push(bytes.readFloatLE(at));samples+=length/4;pending=bytes.subarray(length);report?.(samples/RATE);}
  const [code]=await exit;if(code!==0)throw Error("Cannot analyze microphone bleed: "+stderr);return builder.finish();
 }catch(error){child.kill("SIGKILL");await closed;throw error;}
}
function floatWavHeader():Buffer{
 const header=Buffer.alloc(44);header.write("RIFF");header.writeUInt32LE(0xffffffff,4);header.write("WAVEfmt ",8);header.writeUInt32LE(16,16);header.writeUInt16LE(3,20);header.writeUInt16LE(2,22);header.writeUInt32LE(48000,24);header.writeUInt32LE(384000,28);header.writeUInt16LE(8,32);header.writeUInt16LE(32,34);header.write("data",36);header.writeUInt32LE(0xffffffff,40);return header;
}
/** Rewrites the track with the gain curve applied; samples are only scaled, so its length and timing are unchanged. */
async function applyGains(file:string,gains:Float32Array,codec:string,ffmpeg:string,signal?:AbortSignal):Promise<void>{
 await checkExportSpace();
 const output=path.join(path.dirname(file),"bleed-"+path.basename(file)),report=exportProgressReporter();report?.(0);
 const decoder=deprioritize(spawn(ffmpeg,["-nostdin","-v","error","-i",file,"-ac","2","-ar","48000","-c:a","pcm_f32le","-f","f32le","pipe:1"],{stdio:["ignore","pipe","pipe"],signal,killSignal:"SIGKILL"}));
 const encoder=deprioritize(spawn(ffmpeg,["-nostdin","-v","error","-n","-f","wav","-i","pipe:0","-c:a",codec,...(codec==="pcm_s16le"?["-rf64","auto"]:[]),output],{stdio:["pipe","ignore","pipe"],signal,killSignal:"SIGKILL"}));
 const closed=Promise.all([processClosed(decoder),processClosed(encoder)]),decoded=once(decoder,"close"),encoded=once(encoder,"close");decoded.catch(()=>{});encoded.catch(()=>{});
 let stderr="";for(const child of [decoder,encoder])child.stderr.on("data",chunk=>stderr=(stderr+chunk).slice(-2000));encoder.stdin.on("error",()=>{});
 try{
  encoder.stdin.write(floatWavHeader());
  let pending:Buffer=Buffer.alloc(0),position=0;const scale=48000/RATE,centre=FFT/2*scale,spacing=HOP*scale;
  for await(const chunk of decoder.stdout){
   const bytes=pending.length?Buffer.concat([pending,chunk]):chunk as Buffer,length=bytes.length-bytes.length%8;
   if(length){const out=Buffer.allocUnsafe(length);for(let at=0;at<length;at+=8,position++){
     const place=(position-centre)/spacing,before=Math.floor(place),mix=place-before,low=gains[Math.max(0,Math.min(gains.length-1,before))]??1,high=gains[Math.max(0,Math.min(gains.length-1,before+1))]??1,gain=low+(high-low)*mix;
     out.writeFloatLE(bytes.readFloatLE(at)*gain,at);out.writeFloatLE(bytes.readFloatLE(at+4)*gain,at+4);
    }
    if(!encoder.stdin.write(out))await Promise.race([once(encoder.stdin,"drain"),encoded]);report?.(position/48000);}
   pending=bytes.subarray(length);
  }
  encoder.stdin.end();const [[first],[second]]=await Promise.all([decoded,encoded]);if(first!==0||second!==0)throw Error("Cannot reduce microphone bleed: "+stderr);
  await rename(output,file);
 }catch(error){decoder.kill("SIGKILL");encoder.kill("SIGKILL");await closed;throw error;}
 finally{await rm(output,{force:true});}
}
/** Turns down each listed track wherever another track shows that the sound is another speaker's voice. */
export async function reduceBleed(tracks:BleedTrack[],seconds:number,codec:string,ffmpeg:string,signal?:AbortSignal,onProgress?:(stage:string,totalSeconds?:number,workID?:string)=>void):Promise<BleedReport>{
 const report:BleedReport=Object.fromEntries(tracks.map(track=>[track.key,{reducedSeconds:0}]));if(tracks.length<2)return report;
 const work=(track:BleedTrack)=>String(Number(/^track-(\d+)/.exec(track.key)?.[1]));
 const envelopes:BleedEnvelope[]=[];for(const track of tracks){signal?.throwIfAborted();onProgress?.(`Comparing microphones: ${track.username}`,seconds,`bleed-scan:${work(track)}`);envelopes.push(await scan(track,ffmpeg,signal));}
 onProgress?.("Finding microphone bleed between speakers");const masks=await findBleed(envelopes,signal);
 for(const [index,track] of tracks.entries()){
  const mask=masks[index]!,frames=mask.reduce((sum,value)=>sum+value,0);report[track.key]={reducedSeconds:Math.round(frames*FRAME_SECONDS*100)/100};if(!frames)continue;
  onProgress?.(`Reducing microphone bleed: ${track.username}`,seconds,`bleed:${work(track)}`);await applyGains(track.file,bleedGains(mask),codec,ffmpeg,signal);
 }
 return report;
}

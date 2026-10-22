import { runTool } from "../exports/process";
import { measureLevel,AudioLevel } from "../exports/normalization";
import { open } from "node:fs/promises";
import { readFile,writeFile,rm } from "node:fs/promises";
import path from "node:path";
export interface TranscriptSegment {start:number;end:number;text:string;speaker:string}
/** 100 ms energy bins from the bounded 16 kHz mono PCM supplied to Whisper. */
/** Also returns each bin's mean-square energy, used to compare a segment with the chunk's background level. */
async function audioActivity(filename:string,start:number,bytes:number,gain=1):Promise<boolean[]&{energy:number[]}>{
 if(!Number.isSafeInteger(bytes)||bytes<0||bytes>300*32000||bytes%2)throw Error("Invalid transcription audio length.");
 const file=await open(filename,"r"),bins:boolean[]=[],energies:number[]=[],buffer=Buffer.alloc(3200);
 try{for(let position=0;position<bytes;position+=buffer.length){const length=Math.min(buffer.length,bytes-position),result=await file.read(buffer,0,length,start+position);if(result.bytesRead!==length)throw Error("Truncated transcription audio.");let energy=0,peak=0;for(let offset=0;offset<length;offset+=2){const sample=buffer.readInt16LE(offset);energy+=sample*sample;peak=Math.max(peak,Math.abs(sample));}energies.push(energy/(length/2));bins.push(energy/(length/2)>=256*gain*gain||peak>=128*gain);}}finally{await file.close();}
 return Object.assign(bins,{energy:energies});
}
/**
 * Audible part of a recognizer segment, padded to keep quiet word edges; undefined when the segment lies in near-silence.
 * Bounding both ends stops subtitles from staying on screen through silence that Whisper folded into a segment.
 */
function audibleSpan(bins:boolean[],start:number,end:number):[number,number]|undefined{
 const first=Math.max(0,Math.floor((start-.15)*10)),last=Math.min(bins.length,Math.ceil((end+.15)*10));
 let from=-1,to=-1;for(let index=first;index<last;index++)if(bins[index]){if(from<0)from=index;to=index;}
 if(from<0)return;
 const clippedStart=Math.max(start,from/10-.15),clippedEnd=Math.min(end,(to+1)/10+.25);
 return clippedEnd>clippedStart?[clippedStart,clippedEnd]:[start,Math.min(end,start+.25)];
}
/**
 * Analysis-only boost for quiet speakers (the exported audio is unchanged). Silero VAD and Whisper miss very quiet speech:
 * with JFK's sample attenuated 40 dB, VAD kept only the last half. Boost toward -20 LUFS, at most 40 dB, keeping peaks under -1 dBTP;
 * when gated loudness is unavailable (very quiet input), lift the peak to -6 dBFS instead.
 */
export function transcriptionGainDb(level?:AudioLevel):number{
 if(!level||!Number.isFinite(level.truePeak))return 0;
 const headroom=-1-level.truePeak,boost=Number.isFinite(level.lufs)?Math.min(-20-level.lufs,headroom):-6-level.truePeak;
 return Math.max(0,Math.min(40,headroom,boost));
}
/** Thresholds for marking a segment [inaudible]; measured on base.en with local samples, not tuned on real Discord tracks. */
export const MIN_SEGMENT_CONFIDENCE=0.6,MIN_SEGMENT_SNR_DB=6,MIN_SEGMENT_MODULATION_DB=6;
const percentile=(values:number[],fraction:number)=>{const sorted=[...values].sort((x,y)=>x-y);return sorted[Math.floor((sorted.length-1)*fraction)]!;};
/**
 * Whether a segment's audio is speech buried in steady background. Without VAD, Whisper turns such audio into fluent but wrong
 * words with high confidence, so confidence alone cannot catch it. Two conditions must both hold:
 * - the segment rises less than 6 dB above the chunk's background (20th-percentile 100 ms bin), and
 * - its level barely varies (90th vs 10th percentile bin under 6 dB): speech rises and falls between syllables, steady noise does not.
 * The second condition keeps speech that fills a whole chunk (its background estimate is speech). Chunks under 5 s are not
 * judged, and digital silence as background never triggers it, so clean quiet speech is unaffected.
 */
export function buriedInNoise(energy:number[],start:number,end:number):boolean{
 if(energy.length<50)return false;
 const floor=percentile(energy,0.2);if(floor<=0)return false;
 const bins=energy.slice(Math.max(0,Math.floor(start*10)),Math.ceil(end*10));if(bins.length<5)return false;
 const level=bins.reduce((sum,value)=>sum+value,0)/bins.length,low=percentile(bins,0.1),high=percentile(bins,0.9);
 return 10*Math.log10(level/floor)<MIN_SEGMENT_SNR_DB&&(low<=0?Infinity:10*Math.log10(high/low))<MIN_SEGMENT_MODULATION_DB;
}
/**
 * Whisper decodes very noisy, very quiet speech into confident-looking garble ("my fellow Americans and not my fellow
 * Americans and you and..."). Measured locally with base.en, garbled segments had mean token probability about 0.51-0.53,
 * while clear speech (even 50 dB down) stayed at 0.83 or above. Unreliable segments are shown as "[inaudible]" so readers know
 * someone spoke there, instead of as invented words.
 *
 * Repetition alone is not evidence: people repeat themselves ("I don't know. I don't know."), count, and repeat instructions.
 * A repetitive segment (12+ words, under 40% distinct) is suppressed only with independent evidence that the decoder looped:
 * more words than its audible audio could hold (over 6 per audible second), or weak confidence (mean token probability
 * under 0.75). Repetitive text with neither signal, or without token or audio data to judge, is kept as transcribed.
 */
/** audibleSeconds: length of the segment's audible part (first to last audible 100 ms bin, padded, as audibleSpan returns), so pauses between words count as speaking time. */
export interface SegmentEvidence {audibleSeconds?:number}
export const LOOP_MIN_WORDS=12,LOOP_MAX_DISTINCT=0.4,LOOP_MAX_CONFIDENCE=0.75,MAX_WORDS_PER_AUDIBLE_SECOND=6;
export function unreliableSegment(item:{text:string;tokens?:Array<{text?:string;p?:number}>},evidence:SegmentEvidence={}):boolean{
 const tokens=(item.tokens??[]).filter(token=>typeof token.p==="number"&&Number.isFinite(token.p)&&!/^\[_/.test(token.text??""));
 const confidence=tokens.length?tokens.reduce((sum,token)=>sum+token.p!,0)/tokens.length:undefined;
 if(confidence!==undefined&&confidence<MIN_SEGMENT_CONFIDENCE)return true;
 const words=item.text.toLowerCase().match(/[\p{L}\p{N}']+/gu)??[];
 if(words.length<LOOP_MIN_WORDS||new Set(words).size/words.length>=LOOP_MAX_DISTINCT)return false;
 if(evidence.audibleSeconds!==undefined&&words.length/Math.max(evidence.audibleSeconds,0.1)>MAX_WORDS_PER_AUDIBLE_SECOND)return true;
 return confidence!==undefined&&confidence<LOOP_MAX_CONFIDENCE;
}
/**
 * Whisper labels non-speech instead of staying silent: "[BLANK_AUDIO]", "[ Silence ]", "(engine revving)", "♪". Drop segments
 * with no words outside such labels (seen on real noise-only tracks); segments mixing a label with words are kept as spoken.
 */
export function nonSpeech(text:string):boolean{return !/[\p{L}\p{N}]/u.test(text.replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫]/g,""));}
function timestamp(seconds:number,separator:string):string{
 const ms=Math.max(0,Math.round(seconds*1000)),h=Math.floor(ms/3600000),m=Math.floor(ms/60000)%60,s=Math.floor(ms/1000)%60;
 return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}${separator}${String(ms%1000).padStart(3,"0")}`;
}
export function formatTranscript(segments:TranscriptSegment[],format:"txt"|"srt"|"vtt"):string{
 const sorted=[...segments].sort((a,b)=>a.start-b.start);
 return (format==="vtt"?"WEBVTT\n\n":"")+sorted.map((segment,index)=>{
  const text=`${segment.speaker}: ${segment.text.trim().replace(/[\r\n]+/g," ")}`;
  if(format==="txt")return `[${timestamp(segment.start,".")}] ${text}\n`;
  return `${index+1}\n${timestamp(segment.start,format==="srt"?",":".")} --> ${timestamp(segment.end,format==="srt"?",":".")}\n${text}\n`;
 }).join("\n");
}
/** Local whisper.cpp; no subscription checks or hosted-service dependency. */
export async function transcribeExport(directory:string,options:{executable:string;model:string;ffmpeg:string;signal?:AbortSignal;timeoutMs?:number;threads?:number;language?:string;prompt?:string;vadModel?:string}):Promise<void>{
 const manifest=JSON.parse(await readFile(path.join(directory,"manifest.json"),"utf8"));const segments:TranscriptSegment[]=[];
 for(const track of manifest.tracks){
  if(track.userID==="server-intro"||track.userID==="witness-sync")continue;
  const input=path.join(directory,track.file),temporary=path.join(directory,"transcription-input.wav"),output=path.join(directory,"transcription-result");
  // Five-minute chunks bound model memory and preserve per-speaker timestamps.
  // Measured once per track; activity thresholds are scaled by the same gain, so silence detection matches the unboosted audio.
  const gainDb=transcriptionGainDb(await measureLevel(input,options.ffmpeg,options.signal).catch(()=>undefined)),gain=10**(gainDb/20);
  for(let offset=track.userID!=="server-intro" ? Number(manifest.intro?.seconds??0) : 0;;offset+=300){
   options.signal?.throwIfAborted();
   try{
    await runTool(options.ffmpeg,["-nostdin","-v","error","-n","-ss",String(offset),"-i",input,"-t","300",...(gainDb>0?["-af",`volume=${gainDb.toFixed(2)}dB`]:[]),"-ar","16000","-ac","1","-c:a","pcm_s16le",temporary],options.signal,options.timeoutMs);
    const file=await open(temporary,"r");let audioBytes=0,audioStart=0;
    try{const length=(await file.stat()).size;let position=12;while(position+8<=length){const bytes=Buffer.alloc(8);await file.read(bytes,0,8,position);const size=bytes.readUInt32LE(4);if(bytes.toString("ascii",0,4)==="data"){audioBytes=size;audioStart=position+8;break;}position+=8+size+(size%2);}}finally{await file.close();}
    if(!audioBytes)break;
    // Only reject near-silent signal: VAD handles speech/noise, while this protects installations
    // without a VAD model and prevents hallucinated subtitles on silent portions of a chunk.
    const activity=await audioActivity(temporary,audioStart,audioBytes,gain);
    if(!activity.some(Boolean)){if(audioBytes<300*32000)break;continue;}
    await runTool(options.executable,["-m",options.model,"-f",temporary,"-ojf","-of",output,"-t",String(options.threads??2),"-l",options.language??"en",...(options.prompt?["--prompt",options.prompt]:[]),...(options.vadModel?["--vad","--vad-model",options.vadModel]:[])],options.signal,options.timeoutMs);
    const result=JSON.parse(await readFile(output+".json","utf8"));
    if(!Array.isArray(result.transcription))throw new Error("Invalid whisper.cpp output.");
    for(const item of result.transcription){
     const start=item.offsets?.from/1000,end=item.offsets?.to/1000;
     if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start||typeof item.text!=="string")throw new Error("Invalid transcript segment.");
     // Whisper can extend its final timestamp beyond the actual chunk.
     // Bound subtitles to the audio instead of failing the entire export.
     const duration=audioBytes/32000;
     const span=start<duration&&end>start?audibleSpan(activity,start,Math.min(end,duration)):undefined;
     if(span&&!nonSpeech(item.text))segments.push({start:span[0]+offset,end:span[1]+offset,text:unreliableSegment(item,{audibleSeconds:span[1]-span[0]})||buriedInNoise(activity.energy,span[0],span[1])?" [inaudible]":item.text,speaker:track.username});
    }
    if(audioBytes<300*32000)break;
   }finally{await rm(temporary,{force:true});await rm(output+".json",{force:true});}
  }
 }
 for(const format of ["txt","srt","vtt"] as const)await writeFile(path.join(directory,`transcript.${format}`),formatTranscript(segments,format));
 manifest.transcripts=["transcript.txt","transcript.srt","transcript.vtt"];
 await writeFile(path.join(directory,"manifest.json"),JSON.stringify(manifest,null,2));
}

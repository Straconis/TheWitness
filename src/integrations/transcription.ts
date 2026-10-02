import { runTool } from "../exports/process";
import { open } from "node:fs/promises";
import { readFile,writeFile,rm } from "node:fs/promises";
import path from "node:path";
export interface TranscriptSegment {start:number;end:number;text:string;speaker:string}
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
export async function transcribeExport(directory:string,options:{executable:string;model:string;ffmpeg:string;signal?:AbortSignal;timeoutMs?:number;threads?:number;language?:string;prompt?:string}):Promise<void>{
 const manifest=JSON.parse(await readFile(path.join(directory,"manifest.json"),"utf8"));const segments:TranscriptSegment[]=[];
 for(const track of manifest.tracks){
  const input=path.join(directory,track.file),temporary=path.join(directory,"transcription-input.wav"),output=path.join(directory,"transcription-result");
  // Five-minute chunks bound model memory and preserve per-speaker timestamps.
  for(let offset=track.userID!=="server-intro" ? Number(manifest.intro?.seconds??0) : 0;;offset+=300){
   options.signal?.throwIfAborted();
   try{
    await runTool(options.ffmpeg,["-nostdin","-v","error","-n","-ss",String(offset),"-i",input,"-t","300","-ar","16000","-ac","1","-c:a","pcm_s16le",temporary],options.signal,options.timeoutMs);
    const file=await open(temporary,"r");let audioBytes=0;
    try{const length=(await file.stat()).size;let position=12;while(position+8<=length){const bytes=Buffer.alloc(8);await file.read(bytes,0,8,position);const size=bytes.readUInt32LE(4);if(bytes.toString("ascii",0,4)==="data"){audioBytes=size;break;}position+=8+size+(size%2);}}finally{await file.close();}
    if(!audioBytes)break;
    await runTool(options.executable,["-m",options.model,"-f",temporary,"-oj","-of",output,"-t",String(options.threads??2),"-l",options.language??"en",...(options.prompt?["--prompt",options.prompt]:[])],options.signal,options.timeoutMs);
    const result=JSON.parse(await readFile(output+".json","utf8"));
    if(!Array.isArray(result.transcription))throw new Error("Invalid whisper.cpp output.");
    for(const item of result.transcription){
     const start=item.offsets?.from/1000,end=item.offsets?.to/1000;
     if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start||typeof item.text!=="string")throw new Error("Invalid transcript segment.");
     // Whisper can extend its final timestamp beyond the actual chunk.
     // Bound subtitles to the audio instead of failing the entire export.
     const duration=audioBytes/32000;
     if(start<duration&&end>start&&item.text.trim()&&!/^\s*\[BLANK_AUDIO\]\s*$/i.test(item.text))segments.push({start:start+offset,end:Math.min(end,duration)+offset,text:item.text,speaker:track.username});
    }
    if(audioBytes<300*32000)break;
   }finally{await rm(temporary,{force:true});await rm(output+".json",{force:true});}
  }
 }
 for(const format of ["txt","srt","vtt"] as const)await writeFile(path.join(directory,`transcript.${format}`),formatTranscript(segments,format));
 manifest.transcripts=["transcript.txt","transcript.srt","transcript.vtt"];
 await writeFile(path.join(directory,"manifest.json"),JSON.stringify(manifest,null,2));
}

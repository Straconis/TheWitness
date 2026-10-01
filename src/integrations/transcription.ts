import { spawn } from "node:child_process";
import { once } from "node:events";
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
async function run(executable:string,args:string[]):Promise<void>{
 const child=spawn(executable,args,{stdio:["ignore","ignore","pipe"]});let stderr="";
 child.stderr.on("data",chunk=>{stderr=(stderr+chunk).slice(-4096);});const [code]=await once(child,"close");
 if(code!==0)throw new Error(`Transcription process failed (${code}): ${stderr}`);
}
/** Local whisper.cpp; no subscription checks or hosted-service dependency. */
export async function transcribeExport(directory:string,options:{executable:string;model:string;ffmpeg:string}):Promise<void>{
 const manifest=JSON.parse(await readFile(path.join(directory,"manifest.json"),"utf8"));const segments:TranscriptSegment[]=[];
 for(const track of manifest.tracks){
  const input=path.join(directory,track.file),temporary=path.join(directory,"transcription-input.wav"),output=path.join(directory,"transcription-result");
  try{
   await run(options.ffmpeg,["-nostdin","-v","error","-n","-i",input,"-ar","16000","-ac","1",temporary]);
   await run(options.executable,["-m",options.model,"-f",temporary,"-oj","-of",output]);
   const result=JSON.parse(await readFile(output+".json","utf8"));
   if(!Array.isArray(result.transcription))throw new Error("Invalid whisper.cpp output.");
   for(const item of result.transcription){
    const start=item.offsets?.from/1000,end=item.offsets?.to/1000;
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<start||typeof item.text!=="string")throw new Error("Invalid transcript segment.");
    segments.push({start,end,text:item.text,speaker:track.username});
   }
  }finally{await rm(temporary,{force:true});await rm(output+".json",{force:true});}
 }
 for(const format of ["txt","srt","vtt"] as const)await writeFile(path.join(directory,`transcript.${format}`),formatTranscript(segments,format));
 manifest.transcripts=["transcript.txt","transcript.srt","transcript.vtt"];
 await writeFile(path.join(directory,"manifest.json"),JSON.stringify(manifest,null,2));
}

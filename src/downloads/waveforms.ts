import { deprioritize,processClosed } from "../exports/process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import { existsSync } from "node:fs";
export async function waveform(filename:string):Promise<{duration:number;step:number;peaks:number[]}>{
 const executable=process.env.FFMPEG_PATH?.trim()||(existsSync(path.resolve(__dirname,"../../bin/ffmpeg"))?path.resolve(__dirname,"../../bin/ffmpeg"):"ffmpeg");
 const child=spawn(executable,["-nostdin","-v","error","-i",filename,"-ar","8000","-ac","1","-f","s16le","pipe:1"],{stdio:["ignore","pipe","ignore"],signal:AbortSignal.timeout(600000),killSignal:"SIGKILL"});deprioritize(child);
 const closed=processClosed(child);const exit=once(child,"close");void exit.catch(()=>{});let carry=Buffer.alloc(0),peak=0,bucket=0,samples=0;const peaks:number[]=[];
 try{for await(const chunk of child.stdout){const bytes=Buffer.concat([carry,chunk]);let offset=0;for(;offset+1<bytes.length;offset+=2){peak=Math.max(peak,Math.abs(bytes.readInt16LE(offset))/32768);samples++;if(++bucket===800){peaks.push(Math.round(peak*1000)/1000);peak=0;bucket=0;}if(samples>8000*86400)throw Error("Waveform exceeds the 24-hour editor limit.");}carry=Buffer.from(bytes.subarray(offset));}const [code]=await exit;if(code!==0)throw Error("Could not prepare waveform.");if(bucket)peaks.push(Math.round(peak*1000)/1000);return {duration:samples/8000,step:0.1,peaks};}
 catch(error){child.kill("SIGKILL");await closed;await exit.catch(()=>{});throw error;}
}

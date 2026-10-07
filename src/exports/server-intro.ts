import {createHash,randomUUID} from "node:crypto";
import {mkdir,readFile,writeFile,rename,stat,rm} from "node:fs/promises";
import path from "node:path";
import {existsSync} from "node:fs";
import {runTool} from "./process";
export interface ServerIntro {id:string;name:string;seconds:number}
const idPattern=/^[a-f0-9-]{36}$/i;
function directory(root:string,guild:string):string{return path.join(root,"server-intros",createHash("sha256").update(guild).digest("hex"));}
export async function getServerIntro(root:string,guild:string,id?:string):Promise<ServerIntro|undefined>{
 if(id&&!idPattern.test(id))throw Error("Invalid intro ID.");
 try{const intro=JSON.parse(await readFile(path.join(directory(root,guild),id?`${id}.json`:"current.json"),"utf8"));if(!idPattern.test(intro.id)||!Number.isFinite(intro.seconds)||intro.seconds<=0||intro.seconds>300||typeof intro.name!=="string")throw Error("Invalid saved intro.");return intro;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
}
export function introPCM(root:string,guild:string,id:string):string{if(!idPattern.test(id))throw Error("Invalid intro ID.");return path.join(directory(root,guild),id+".pcm");}
export async function uploadIntroChunk(root:string,guild:string,data:any):Promise<{id:string;intro?:ServerIntro}>{
 const dir=directory(root,guild);await mkdir(dir,{recursive:true});
 const id=data.id??randomUUID();if(!idPattern.test(id)||!Number.isInteger(data.index)||data.index<0||data.index>=60||typeof data.bytes!=="string"||data.bytes.length>710000||!/^[A-Za-z0-9+/]+={0,2}$/.test(data.bytes))throw Error("Invalid intro upload.");
 const bytes=Buffer.from(data.bytes,"base64");if(!bytes.length||bytes.length>512*1024)throw Error("Invalid intro chunk size.");
 const upload=path.join(dir,"upload-"+id);if(data.index===0)await mkdir(upload);else if(!data.id)throw Error("Missing upload ID.");
 await writeFile(path.join(upload,String(data.index)),bytes,{flag:"wx",mode:0o600});
 if(data.final!==true)return {id};
 try{
 const chunks=[];let size=0;for(let index=0;index<=data.index;index++){const chunk=await readFile(path.join(upload,String(index)));size+=chunk.length;if(size>30*1024*1024)throw Error("Intro files must be under 30 MB.");chunks.push(chunk);}
 const header=chunks[0];let demux:string;if(header.toString("ascii",0,4)==="RIFF"||header.toString("ascii",0,4)==="RF64")demux="wav";else if(header.toString("ascii",0,4)==="fLaC")demux="flac";else if(header.toString("ascii",0,4)==="OggS")demux="ogg";else if(header.toString("ascii",0,3)==="ID3"||(header[0]===255&&(header[1]&224)===224))demux="mp3";else throw Error("Upload a WAV, FLAC, MP3, or Ogg audio intro.");
 const input=path.join(upload,"input"),pcm=path.join(upload,"intro.pcm");await writeFile(input,Buffer.concat(chunks));
 const ffmpeg=process.env.FFMPEG_PATH?.trim()||(existsSync(path.resolve(__dirname,"../../bin/ffmpeg"))?path.resolve(__dirname,"../../bin/ffmpeg"):"ffmpeg");
 await runTool(ffmpeg,["-nostdin","-v","error","-n","-protocol_whitelist","file,pipe","-f",demux,"-i",input,"-vn","-t","300.01","-ar","48000","-ac","2","-c:a","pcm_s16le","-f","s16le",pcm],undefined,120000);const seconds=(await stat(pcm)).size/192000;if(seconds<=0||seconds>300)throw Error("Intro must contain audio and be no longer than five minutes.");const intro={id,name:typeof data.name==="string"?data.name.slice(0,150):"Server intro",seconds};await rename(pcm,introPCM(root,guild,id));await writeFile(path.join(dir,id+".json"),JSON.stringify(intro),{flag:"wx",mode:0o600});const temporary=path.join(dir,"current-"+id+".tmp");await writeFile(temporary,JSON.stringify(intro),{mode:0o600});await rename(temporary,path.join(dir,"current.json"));return {id,intro};}finally{await rm(upload,{recursive:true,force:true});}
}

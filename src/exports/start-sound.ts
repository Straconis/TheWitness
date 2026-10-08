import {createHash,randomUUID} from "node:crypto";
import {mkdir,readFile,writeFile,rm,lstat,statfs} from "node:fs/promises";
import path from "node:path";
import {existsSync} from "node:fs";
import {OpusEncoder} from "@discordjs/opus";
import {runTool} from "./process";
import type {GuildSettings} from "../storage/settings";
import {sessionIDPattern} from "../storage/sessions";
export interface StartSound {id:string;name:string;seconds:number}
export const bundledStartSound=path.resolve(__dirname,"../../assets/audio/witness-start.ogg");
export function startSoundEnabled(value=process.env.START_SOUND?.trim()):boolean{if(value===undefined||value===""||value==="on")return true;if(value==="off")return false;throw Error("START_SOUND must be on or off.");}
export function validateStartSound(choice:GuildSettings["startSound"]):void{if(choice===undefined)return;if(!choice||typeof choice!=="object"||!["default","custom","off"].includes(choice.mode)||(choice.customID!==undefined&&!sessionIDPattern.test(choice.customID))||(choice.mode==="custom"&&!choice.customID))throw Error("Invalid start sound setting.");}
export function startSoundDirectory(root:string,guild:string):string{return path.join(root,"start-sounds",createHash("sha256").update(guild).digest("hex"));}
export function startSoundPath(root:string,guild:string,id:string):string{if(!sessionIDPattern.test(id))throw Error("Invalid start sound ID.");return path.join(startSoundDirectory(root,guild),id+".ogg");}
/** Bound parsing and validate the same packets the voice playback path consumes. */
export async function validateOggOpus(file:string):Promise<number>{
 const info=await lstat(file);if(!info.isFile()||info.size>1024**2||info.size<40)throw Error("Start sound must be a regular Ogg Opus file no larger than 1 MiB.");
 const bytes=await readFile(file);if(bytes.length>1024**2)throw Error("Start sound is too large.");
 let offset=0,serial:number|undefined,last=0n,ended=false,preSkip=0,head=false,tags=false,samples=0;let pending:Buffer[]=[];
 const decoder=new OpusEncoder(48000,2);
 while(offset<bytes.length){
  if(offset+27>bytes.length||bytes.toString("ascii",offset,offset+4)!=="OggS"||bytes[offset+4]!==0||ended)throw Error("Invalid Ogg stream.");
  const flags=bytes[offset+5],stream=bytes.readUInt32LE(offset+14),segments=bytes[offset+26];if(serial===undefined)serial=stream;if(serial!==stream||(flags&1))throw Error("Unsupported Ogg stream.");
  if(offset+27+segments>bytes.length)throw Error("Truncated Ogg page.");
  const granule=bytes.readBigUInt64LE(offset+6);if(granule!==0xffffffffffffffffn)last=granule;
  let cursor=offset+27+segments;
  for(let i=0;i<segments;i++){const size=bytes[offset+27+i];if(cursor+size>bytes.length)throw Error("Truncated Opus packet.");pending.push(bytes.subarray(cursor,cursor+size));cursor+=size;if(size<255){const packet=Buffer.concat(pending);pending=[];if(!head){if(packet.length<19||packet.toString("ascii",0,8)!=="OpusHead"||packet[9]!==2||packet[18]!==0)throw Error("A stereo Ogg Opus stream is required.");preSkip=packet.readUInt16LE(10);head=true;}else if(!tags){if(packet.toString("ascii",0,8)!=="OpusTags")throw Error("Invalid Opus tags.");tags=true;}else{const pcm=decoder.decode(packet);if(pcm.length!==3840)throw Error("Start sound needs 20 ms Opus frames.");samples+=960;if(samples>484800)throw Error("Start sound must be 0.2–10 seconds of Ogg Opus audio.");}}}
  if(pending.length)throw Error("Continued Ogg pages are not supported by voice playback.");
  offset=cursor;ended=!!(flags&4);
 }
 const seconds=Number(last-BigInt(preSkip))/48000;
 if(!ended||pending.length||!tags||samples===0||!Number.isFinite(seconds)||seconds<0.2||seconds>10||samples/48000<seconds||samples/48000-seconds>0.1)throw Error("Start sound must be 0.2–10 seconds of Ogg Opus audio.");
 return seconds;
}
export async function getStartSound(root:string,guild:string,id?:string):Promise<StartSound|undefined>{if(!id)return;if(!sessionIDPattern.test(id))throw Error("Invalid start sound ID.");try{const sound=JSON.parse(await readFile(path.join(startSoundDirectory(root,guild),id+".json"),"utf8"));if(sound.id!==id||typeof sound.name!=="string"||!Number.isFinite(sound.seconds)||sound.seconds<0.2||sound.seconds>10)throw Error("Invalid saved start sound.");return sound;}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}}
export async function resolveDefaultStartSound(override=process.env.START_SOUND_DEFAULT_PATH?.trim(),bundled=bundledStartSound):Promise<string|undefined>{if(override){try{await validateOggOpus(override);return override;}catch{console.warn("[Start sound] Invalid default override; using the bundled chime.");}}try{await validateOggOpus(bundled);return bundled;}catch{console.warn("[Start sound] Bundled chime unavailable; playback skipped.");}}
let defaultFile:Promise<string|undefined>|undefined;
export async function initializeStartSound():Promise<void>{if(startSoundEnabled())await(defaultFile??=resolveDefaultStartSound());}
const warnings=new WeakMap<object,{reported:boolean;clear:()=>void}>();
export function handleStartSoundError(connection:object,error:Error):boolean{const active=warnings.get(connection);if(!active)return false;if(!active.reported){active.reported=true;console.warn("[Start sound] Playback failed:",error);}return true;}
export async function playStartSound(connection:any,root:string,guild:string,choice:GuildSettings["startSound"],canSpeak:boolean,stillRecording:()=>boolean,resolveDefault:()=>Promise<string|undefined>=()=>defaultFile??=resolveDefaultStartSound()):Promise<void>{
 if(!startSoundEnabled()||choice?.mode==="off")return;if(!canSpeak){console.warn("[Start sound] Missing Speak permission; playback skipped.");return;}
 let file:string|undefined;
 if(choice?.mode==="custom"&&choice.customID){try{file=startSoundPath(root,guild,choice.customID);await validateOggOpus(file);}catch{console.warn("[Start sound] Custom chime unavailable; using the default.");file=undefined;}}
 file??=await resolveDefault();if(!file||!stillRecording()||connection.playing)return;
 const clear=()=>{clearTimeout(timer);connection.removeListener("end",clear);warnings.delete(connection);};const timer=setTimeout(clear,11000);timer.unref();warnings.set(connection,{reported:false,clear});connection.once("end",clear);
 try{connection.play(file,{format:"ogg"});}catch(error){handleStartSoundError(connection,error as Error);clear();}
}
let processing=false;
export async function uploadStartSoundChunk(root:string,guild:string,data:any):Promise<{id:string;sound?:StartSound}>{
 if(data.index===0&&data.id!==undefined)throw Error("New start sound IDs are assigned by the server.");
 const id=data.id??randomUUID();if(!sessionIDPattern.test(id)||!Number.isInteger(data.index)||data.index<0||data.index>=10||typeof data.bytes!=="string"||data.bytes.length>710000||!/^[A-Za-z0-9+/]+={0,2}$/.test(data.bytes))throw Error("Invalid start sound upload.");
 const bytes=Buffer.from(data.bytes,"base64");if(!bytes.length||bytes.length>512*1024)throw Error("Invalid start sound chunk.");
 const dir=startSoundDirectory(root,guild);await mkdir(dir,{recursive:true});const free=await statfs(dir);if(Number(free.bavail)*Number(free.bsize)<1024**3+64*1024**2)throw Error("Free disk space before uploading a start sound.");
 const upload=path.join(dir,"upload-"+id);if(data.index===0)await mkdir(upload);else if(!data.id)throw Error("Missing upload ID.");await writeFile(path.join(upload,String(data.index)),bytes,{flag:"wx",mode:0o600});if(data.final!==true)return {id};
 let owns=false;
 try{
  if(processing)throw Error("Another start sound is being processed. Try again shortly.");processing=true;owns=true;
  const chunks=[];let total=0;for(let index=0;index<=data.index;index++){const chunk=await readFile(path.join(upload,String(index)));total+=chunk.length;if(total>5*1024**2)throw Error("Start sounds must be no larger than 5 MB.");chunks.push(chunk);}
  const header=chunks[0];let demux:string;if(["RIFF","RF64"].includes(header.toString("ascii",0,4)))demux="wav";else if(header.toString("ascii",0,4)==="fLaC")demux="flac";else if(header.toString("ascii",0,4)==="OggS")demux="ogg";else if(header.toString("ascii",0,3)==="ID3"||(header[0]===255&&(header[1]&224)===224))demux="mp3";else throw Error("Upload WAV, FLAC, MP3 or Ogg audio.");
  const input=path.join(upload,"input"),output=path.join(upload,"sound.ogg");await writeFile(input,Buffer.concat(chunks),{mode:0o600});
  const ffmpeg=process.env.FFMPEG_PATH?.trim()||(existsSync(path.resolve(__dirname,"../../bin/ffmpeg"))?path.resolve(__dirname,"../../bin/ffmpeg"):"ffmpeg");
  await runTool(ffmpeg,["-nostdin","-v","error","-n","-protocol_whitelist","file,pipe","-f",demux,"-i",input,"-vn","-t","10.01","-af","loudnorm=I=-20:TP=-3:LRA=11","-ar","48000","-ac","2","-c:a","libopus","-b:a","96k","-application","audio","-frame_duration","20","-f","ogg",output],undefined,60000);
  const seconds=await validateOggOpus(output),sound={id,name:typeof data.name==="string"?data.name.replace(/[\x00-\x1f\x7f]/g,"").slice(0,150):"Start sound",seconds};
  // Server-assigned IDs, and exclusive metadata/file creation keep snapshots immutable.
  await writeFile(startSoundPath(root,guild,id),await readFile(output),{flag:"wx",mode:0o600});await writeFile(path.join(dir,id+".json"),JSON.stringify(sound),{flag:"wx",mode:0o600});return {id,sound};
 }finally{if(owns)processing=false;await rm(upload,{recursive:true,force:true});}
}

import {UserError} from "../errors";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, writeFile, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import crc32 from "./crc32";
import { getSession } from "../storage/sessions";
import { recordingFeatures } from "./features";

interface Page { bytes: Buffer; data: Buffer; track: number; sequence: number; time: bigint }
async function readExactly(file: FileHandle, size: number, position: number): Promise<Buffer | undefined> {
  const buffer=Buffer.alloc(size); let offset=0;
  while(offset<size) {
    const result=await file.read(buffer,offset,size-offset,position+offset);
    if(!result.bytesRead) return;
    offset+=result.bytesRead;
  }
  return buffer;
}
/** Stop at the first invalid page; never guess past corruption. */
async function* pages(filename: string): AsyncGenerator<Page> {
 const file=await open(filename,"r");
 try {
  let offset=0;
  while(true) {
   const header=await readExactly(file,27,offset);
   if(!header || header.toString("ascii",0,4)!=="OggS" || header[4]!==0) return;
   const segments=await readExactly(file,header[26]!,offset+27);
   if(!segments || !segments.length || segments[segments.length-1]===255) return;
   const size=[...segments].reduce((sum,n)=>sum+n,0);
   const data=await readExactly(file,size,offset+27+segments.length);
   if(!data) return;
   const bytes=Buffer.concat([header,segments,data]),expected=bytes.readUInt32LE(22);
   bytes.writeUInt32LE(0,22);
   if(crc32(bytes)!==expected) return;
   bytes.writeUInt32LE(expected,22);
   yield {bytes,data,track:bytes.readUInt32LE(14),sequence:bytes.readUInt32LE(18),time:bytes.readBigUInt64LE(6)};
   offset+=bytes.length;
  }
 } finally {await file.close();}
}
async function append(file: FileHandle, bytes: Buffer): Promise<void> {
 let offset=0;
 while(offset<bytes.length) {const result=await file.write(bytes,offset,bytes.length-offset,null);if(!result.bytesWritten)throw new Error("Recovery write failed.");offset+=result.bytesWritten;}
}

export async function recoverSession(root: string, sourceID: string, guildID: string): Promise<string> {
 const metadata=await getSession(root,sourceID,guildID);
 if(!["interrupted","failed"].includes(metadata.state)) throw new UserError("Only interrupted or failed sessions can be recovered.");
 const source=path.join(root,sourceID),id=randomUUID(),temporary=path.join(root,id+".tmp"),target=path.join(root,id);
 await mkdir(temporary);
 const output:FileHandle[]=[];
 try {
  const heads=new Map<number,Page>(),tags=new Map<number,Page>();
  for await(const page of pages(path.join(source,"audio.ogg.header1"))) if(page.data.toString("ascii",0,8)==="OpusHead" && page.sequence===0) heads.set(page.track,page);
  for await(const page of pages(path.join(source,"audio.ogg.header2"))) if(page.data.toString("ascii",0,8)==="OpusTags" && page.sequence===1) tags.set(page.track,page);
  const users=new Map<number,{id:string;username:string}>();
  for(const line of (await readFile(path.join(source,"audio.ogg.users"),"utf8")).split("\n")) {
   try {for(const [key,value] of Object.entries(JSON.parse("{"+line.replace(/^,/,"")+"}"))) {
    const user=value as {id:string;username:string};if(typeof user.id==="string" && typeof user.username==="string")users.set(Number(key),user);
   }} catch { /* Ignore the incomplete final user metadata line. */ }
  }
  const data=await open(path.join(temporary,"audio.ogg.data"),"wx");output.push(data);
  const tracks=new Set<number>(); let pending:Page|undefined,packets=0,retainedBytes=0;
  const nextSequence=new Map<number,number>();
  for await(const page of pages(path.join(source,"audio.ogg.data"))) {
   if(page.track===65536) continue;
   if(!heads.has(page.track)||!tags.has(page.track)||!users.has(page.track)) continue;
   if(pending) {
    if(page.track===pending.track && page.sequence===pending.sequence+1 && page.data.length===0) {
      const expected=nextSequence.get(page.track) ?? 2;
      if(pending.sequence!==expected) break;
      await append(data,pending.bytes);await append(data,page.bytes);
      retainedBytes+=pending.bytes.length+page.bytes.length;packets++;tracks.add(page.track);nextSequence.set(page.track,page.sequence+1);
      pending=undefined;continue;
    }
    break;
   }
   if(page.data.length) pending=page;
  }
  if(!packets) throw new UserError("No complete recoverable audio packets were found.");
  const trackList=[...tracks].sort((a,b)=>a-b);
  await writeFile(path.join(temporary,"audio.ogg.header1"),Buffer.concat(trackList.map(track=>heads.get(track)!.bytes)));
  await writeFile(path.join(temporary,"audio.ogg.header2"),Buffer.concat(trackList.map(track=>tags.get(track)!.bytes)));
  await writeFile(path.join(temporary,"audio.ogg.users"),'"0":{}\n'+trackList.map(track=>`,"${track}":${JSON.stringify({...users.get(track),discriminator:"0"})}\n`).join(""));
  const notes:unknown[]=[];
  try { for(const line of (await readFile(path.join(source,"notes.jsonl"),"utf8")).split("\n")) {
   try {const note=JSON.parse(line);if(typeof note.text==="string" && typeof note.seconds==="number")notes.push(note);}catch{}
  }} catch(error) {if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  await writeFile(path.join(temporary,"notes.jsonl"),notes.map(note=>JSON.stringify(note)+"\n").join(""));
  // Cue timing shares the preserved packet timeline; without it, exports cannot report sync cue positions.
  let sync;
  try {
   const parsed=JSON.parse(await readFile(path.join(source,"sync-cues.json"),"utf8"));
   if(!parsed||parsed.version!==1||parsed.sessionID!==sourceID||!Array.isArray(parsed.cues)||parsed.cues.some((cue:any)=>!cue||typeof cue.id!=="string"||cue.sessionID!==sourceID||!["start","end"].includes(cue.kind)||!["scheduled","captured","cancelled"].includes(cue.state)||!Number.isFinite(cue.seconds)||cue.seconds<0||!Number.isFinite(cue.duration)||cue.duration<=0||!Number.isFinite(cue.targetUTC)))throw Error("Invalid sync-cue metadata.");
   // Cue IDs and clock/timeline positions remain tied to the original capture for external sync.
   sync={...parsed,recoverySourceID:sourceID};
  }catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")console.warn("[Recovery] Preserved source but skipped unreadable optional sync-cue metadata.",error);}
  if(sync)await writeFile(path.join(temporary,"sync-cues.json"),JSON.stringify(sync,null,2));
  await writeFile(path.join(temporary,"audio.ogg.info"),JSON.stringify({format:1,guild:guildID,channel:metadata.channelID,startTime:metadata.startedAt,features:recordingFeatures},null,2));
  await data.sync();await data.close();output.pop();
  await writeFile(path.join(temporary,"session.json"),JSON.stringify({
   ...metadata,id,state:"completed",packets,notes:notes.length,endedAt:new Date().toISOString(),
   tracks:trackList.map(track=>({track,...users.get(track)})),
   recovery:{sourceID,recoveredAt:new Date().toISOString(),retainedAudioBytes:retainedBytes,policy:"Validated complete packet/timestamp pairs up to the first corruption; original retained."}
  },null,2));
  await rename(temporary,target);return id;
 } catch(error) {
  await Promise.allSettled(output.map(file=>file.close()));await rm(temporary,{recursive:true,force:true});throw error;
 }
}

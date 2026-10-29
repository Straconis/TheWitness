import {checkExportSpace} from "./workspace";
import { createReadStream } from "node:fs";
import { open,readFile,readdir,stat } from "node:fs/promises";
import {Transform} from "node:stream";
import {pipeline} from "node:stream/promises";
import path from "node:path";
// Native CRC-32: the former per-bit JavaScript loop ran at about 19 MB/s on the thread that also handles live recording.
import { crc32,createDeflateRaw } from "node:zlib";
import {packagedTrackNames} from "../downloads/names";
async function projectZipEntries(directory:string):Promise<Array<[file:string,member:string]>>{
  let entries=(await readdir(directory)).filter(name=>/^(session\.(sesx|aup3?|scraft)|backup-audition\.sesx|backup-audacity\.aup3?|BACKUP-PROJECTS\.txt|manifest\.json|notes\.json|transcript\.(txt|srt|vtt)|mix\.(ogg|wav|flac|mp3|m4a)|(?:raw-)?track-\d+\.(ogg|wav|flac|mp3|m4a))$/.test(name)).sort();
  if(entries.includes("session.aup3"))entries=entries.filter(name=>!/^track-\d+\.(wav|flac)$/.test(name));
  // Cached legacy Audacity projects read media from "<AUP name>_data"; that folder holds the only packaged copy, shared by every project in the ZIP.
  const media=entries.includes("session.aup")?"session_data":entries.includes("backup-audacity.aup")?"backup-audacity_data":undefined;
  if(media){entries=entries.filter(name=>!/^track-\d+\.(wav|flac)$/.test(name));entries.push(...(await readdir(path.join(directory,media))).filter(name=>/\.(wav|flac)$/.test(name)).sort().map(name=>media+"/"+name));}
 // Speaker audio is stored under speaker names; project files reference those same names.
 let manifest:{tracks?:unknown;rawTracks?:unknown}={};try{manifest=JSON.parse(await readFile(path.join(directory,"manifest.json"),"utf8"))??{};}catch{ /* Without a readable manifest, members keep their on-disk names. */ }
 const named=(value:unknown)=>Array.isArray(value)&&value.every(track=>typeof track?.file==="string"&&typeof track?.username==="string")?value as Array<{file:string;username:string}>:[];
 const members=packagedTrackNames(named(manifest.tracks),named(manifest.rawTracks));
 return entries.map(entry=>[entry,members.get(entry)??entry]);
}
/** Disk-streamed ZIP64: large sessions never need to fit in memory. */
export async function writeProjectZip(directory:string,signal?:AbortSignal):Promise<void>{
 // Reserve the exact stored ZIP payload before creating another copy of the media.
 const entries=await projectZipEntries(directory);
 let required=98;for(const [entry,member] of entries)required+=(entry.endsWith(".aup3")?16*1024**2:(await stat(path.join(directory,entry))).size)+256+Buffer.byteLength(member)*2;
 await checkExportSpace(required);
 const output=await open(path.join(directory,"project.zip"),"wx");let offset=0n;const records:Buffer[]=[];
 async function write(bytes:Buffer){signal?.throwIfAborted();let position=0;while(position<bytes.length){const result=await output.write(bytes,position,bytes.length-position,null);if(!result.bytesWritten)throw new Error("ZIP storage made no progress.");position+=result.bytesWritten;}offset+=BigInt(bytes.length);}
 try{
  for(const [entry,member] of entries){const filename=path.join(directory,entry),size=(await stat(filename)).size,name=Buffer.from(member),compressed=entry.endsWith(".aup3"),method=compressed?8:0;let value=0;
   const start=offset,local=Buffer.alloc(30),extra=Buffer.alloc(20);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(45,4);local.writeUInt16LE(0x808,6);local.writeUInt16LE(method,8);local.writeUInt16LE(0x21,12);local.writeUInt32LE(0xffffffff,18);local.writeUInt32LE(0xffffffff,22);local.writeUInt16LE(name.length,26);local.writeUInt16LE(extra.length,28);extra.writeUInt16LE(1);extra.writeUInt16LE(16,2);extra.writeBigUInt64LE(BigInt(size),4);
   await write(local);await write(name);await write(extra);const payloadStart=offset;let read=0,checkpoint=0n;
   const source=createReadStream(filename),count=new Transform({transform(chunk,encoding,callback){read+=chunk.length;value=crc32(chunk,value);callback(null,chunk);}}),transform=compressed?createDeflateRaw({level:1}):new Transform({transform(chunk,encoding,callback){callback(null,chunk);}});
   const pumping=pipeline(source,count,transform,{signal});void pumping.catch(()=>{});
   try{for await(const chunk of transform){if(offset>=checkpoint){await checkExportSpace(16*1024**2);checkpoint=offset+8n*1024n**2n;}await write(chunk);}await pumping;}finally{source.destroy();count.destroy();transform.destroy();await pumping.catch(()=>{});}
   if(read!==size)throw new Error("Project audio changed during packaging.");const packed=offset-payloadStart,descriptor=Buffer.alloc(24);descriptor.writeUInt32LE(0x08074b50);descriptor.writeUInt32LE(value,4);descriptor.writeBigUInt64LE(packed,8);descriptor.writeBigUInt64LE(BigInt(size),16);await write(descriptor);
   const record=Buffer.alloc(46),centralExtra=Buffer.alloc(28);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(45,4);record.writeUInt16LE(45,6);record.writeUInt16LE(0x808,8);record.writeUInt16LE(method,10);record.writeUInt16LE(0x21,14);record.writeUInt32LE(value,16);record.writeUInt32LE(0xffffffff,20);record.writeUInt32LE(0xffffffff,24);record.writeUInt16LE(name.length,28);record.writeUInt16LE(centralExtra.length,30);record.writeUInt32LE(0xffffffff,42);centralExtra.writeUInt16LE(1);centralExtra.writeUInt16LE(24,2);centralExtra.writeBigUInt64LE(BigInt(size),4);centralExtra.writeBigUInt64LE(packed,12);centralExtra.writeBigUInt64LE(start,20);records.push(record,name,centralExtra);
  }
  const centralStart=offset;for(const record of records)await write(record);const centralSize=offset-centralStart,zip64Offset=offset,count=BigInt(entries.length);
  const end64=Buffer.alloc(56);end64.writeUInt32LE(0x06064b50);end64.writeBigUInt64LE(44n,4);end64.writeUInt16LE(45,12);end64.writeUInt16LE(45,14);end64.writeBigUInt64LE(count,24);end64.writeBigUInt64LE(count,32);end64.writeBigUInt64LE(centralSize,40);end64.writeBigUInt64LE(centralStart,48);await write(end64);
  const locator=Buffer.alloc(20);locator.writeUInt32LE(0x07064b50);locator.writeBigUInt64LE(zip64Offset,8);locator.writeUInt32LE(1,16);await write(locator);
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(0xffff,8);end.writeUInt16LE(0xffff,10);end.writeUInt32LE(0xffffffff,12);end.writeUInt32LE(0xffffffff,16);await write(end);await output.sync();
 }finally{await output.close();}
}

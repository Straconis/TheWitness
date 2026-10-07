import { createReadStream } from "node:fs";
import { open,readdir,stat } from "node:fs/promises";
import path from "node:path";
// Native CRC-32: the former per-bit JavaScript loop ran at about 19 MB/s on the thread that also handles live recording.
import { crc32 } from "node:zlib";
/** Disk-streamed ZIP64: large sessions never need to fit in memory. */
export async function writeProjectZip(directory:string,signal?:AbortSignal):Promise<void>{
 const output=await open(path.join(directory,"project.zip"),"wx");let offset=0n;const records:Buffer[]=[];
 async function write(bytes:Buffer){signal?.throwIfAborted();let position=0;while(position<bytes.length){const result=await output.write(bytes,position,bytes.length-position,null);if(!result.bytesWritten)throw new Error("ZIP storage made no progress.");position+=result.bytesWritten;}offset+=BigInt(bytes.length);}
 try{
  let entries=(await readdir(directory)).filter(name=>/^(session\.(sesx|aup)|manifest\.json|notes\.json|transcript\.(txt|srt|vtt)|mix\.(ogg|wav|flac|mp3|m4a)|(?:raw-)?track-\d+\.(ogg|wav|flac|mp3|m4a))$/.test(name)).sort();
  if(entries.includes("session.aup")){entries=entries.filter(name=>!/^track-\d+\.(wav|flac)$/.test(name));entries.push(...(await readdir(path.join(directory,"session_data"))).filter(name=>/^track-\d+\.(wav|flac)$/.test(name)).map(name=>"session_data/"+name));}
  for(const entry of entries){const filename=path.join(directory,entry),size=(await stat(filename)).size,name=Buffer.from(entry);let value=0;
   for await(const chunk of createReadStream(filename)){signal?.throwIfAborted();value=crc32(chunk,value);}
   const start=offset,local=Buffer.alloc(30),extra=Buffer.alloc(20);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(45,4);local.writeUInt16LE(0x21,12);local.writeUInt32LE(value,14);local.writeUInt32LE(0xffffffff,18);local.writeUInt32LE(0xffffffff,22);local.writeUInt16LE(name.length,26);local.writeUInt16LE(extra.length,28);extra.writeUInt16LE(1);extra.writeUInt16LE(16,2);extra.writeBigUInt64LE(BigInt(size),4);extra.writeBigUInt64LE(BigInt(size),12);
   await write(local);await write(name);await write(extra);let written=0;for await(const chunk of createReadStream(filename)){written+=chunk.length;await write(chunk);}if(written!==size)throw new Error("Project audio changed during packaging.");
   const record=Buffer.alloc(46),centralExtra=Buffer.alloc(28);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(45,4);record.writeUInt16LE(45,6);record.writeUInt16LE(0x21,14);record.writeUInt32LE(value,16);record.writeUInt32LE(0xffffffff,20);record.writeUInt32LE(0xffffffff,24);record.writeUInt16LE(name.length,28);record.writeUInt16LE(centralExtra.length,30);record.writeUInt32LE(0xffffffff,42);centralExtra.writeUInt16LE(1);centralExtra.writeUInt16LE(24,2);centralExtra.writeBigUInt64LE(BigInt(size),4);centralExtra.writeBigUInt64LE(BigInt(size),12);centralExtra.writeBigUInt64LE(start,20);records.push(record,name,centralExtra);
  }
  const centralStart=offset;for(const record of records)await write(record);const centralSize=offset-centralStart,zip64Offset=offset,count=BigInt(entries.length);
  const end64=Buffer.alloc(56);end64.writeUInt32LE(0x06064b50);end64.writeBigUInt64LE(44n,4);end64.writeUInt16LE(45,12);end64.writeUInt16LE(45,14);end64.writeBigUInt64LE(count,24);end64.writeBigUInt64LE(count,32);end64.writeBigUInt64LE(centralSize,40);end64.writeBigUInt64LE(centralStart,48);await write(end64);
  const locator=Buffer.alloc(20);locator.writeUInt32LE(0x07064b50);locator.writeBigUInt64LE(zip64Offset,8);locator.writeUInt32LE(1,16);await write(locator);
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(0xffff,8);end.writeUInt16LE(0xffff,10);end.writeUInt32LE(0xffffffff,12);end.writeUInt32LE(0xffffffff,16);await write(end);await output.sync();
 }finally{await output.close();}
}

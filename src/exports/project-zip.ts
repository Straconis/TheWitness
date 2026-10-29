import {checkExportSpace} from "./workspace";
import { constants,createReadStream } from "node:fs";
import { open,readFile,readdir,stat,statfs,rename,rm } from "node:fs/promises";
import {randomUUID} from "node:crypto";
import {Readable,Transform} from "node:stream";
import {pipeline} from "node:stream/promises";
import path from "node:path";
// Native CRC-32: the former per-bit JavaScript loop ran at about 19 MB/s on the thread that also handles live recording.
import { crc32,createDeflateRaw } from "node:zlib";
import {packageFileData,packageNames} from "./package-names";
async function projectZipEntries(directory:string):Promise<Array<[file:string,member:string,data?:Buffer]>>{
  let entries=(await readdir(directory,{withFileTypes:true})).filter(entry=>entry.isFile()).map(entry=>entry.name).filter(name=>/^(session\.(sesx|aup3?|scraft)|backup-audition\.sesx|backup-audacity\.aup3?|BACKUP-PROJECTS\.txt|manifest\.json|notes\.json|transcript\.(txt|srt|vtt)|mix\.(ogg|wav|flac|mp3|m4a)|(?:raw-)?track-\d+\.(ogg|wav|flac|mp3|m4a))$/.test(name)).sort();
  if(entries.includes("session.aup3"))entries=entries.filter(name=>!/^track-\d+\.(wav|flac)$/.test(name));
  // Cached legacy Audacity projects read media from "<AUP name>_data"; that folder holds the only packaged copy, shared by every project in the ZIP.
  const media=entries.includes("session.aup")?"session_data":entries.includes("backup-audacity.aup")?"backup-audacity_data":undefined;
  if(media){entries=entries.filter(name=>!/^track-\d+\.(wav|flac)$/.test(name));entries.push(...(await readdir(path.join(directory,media))).filter(name=>/\.(wav|flac)$/.test(name)).sort().map(name=>media+"/"+name));}
 // Speaker audio is stored under speaker names; project files reference those same names.
 let manifest={};try{manifest=JSON.parse(await readFile(path.join(directory,"manifest.json"),"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
 const members=packageNames(manifest);
 return Promise.all(entries.map(async entry=>{
  if(/^(?:raw-)?track-\d+\./.test(entry)&&!members.has(entry))throw Error(`Speaker metadata is missing for ${entry}; refusing to package anonymous tracks.`);
  const data=entry==="manifest.json"||/\.(sesx|scraft)$/.test(entry)?packageFileData(entry,await readFile(path.join(directory,entry)),members):undefined;
  return [entry,members.get(entry)??entry,data] as [string,string,Buffer?];
 }));
}
/** Disk-streamed ZIP64: large sessions never need to fit in memory. */
export async function writeProjectZip(directory:string,signal?:AbortSignal):Promise<void>{
 await writeZip(directory,path.join(directory,"project.zip"),signal);
}
async function writeZip(directory:string,outputPath:string,signal?:AbortSignal,diskCheck?:(bytes:number)=>Promise<void>):Promise<void>{
 // Reserve the exact stored ZIP payload before creating another copy of the media.
 const entries=await projectZipEntries(directory);
 let required=98;for(const [entry,member,data] of entries)required+=(entry.endsWith(".aup3")?16*1024**2:data?.length??(await stat(path.join(directory,entry))).size)+256+Buffer.byteLength(member)*2;
 await checkExportSpace(required);
 await diskCheck?.(required);
 const output=await open(outputPath,"wx");let offset=0n;const records:Buffer[]=[];
 async function write(bytes:Buffer){signal?.throwIfAborted();let position=0;while(position<bytes.length){const result=await output.write(bytes,position,bytes.length-position,null);if(!result.bytesWritten)throw new Error("ZIP storage made no progress.");position+=result.bytesWritten;}offset+=BigInt(bytes.length);}
 try{
  for(const [entry,member,data] of entries){const filename=path.join(directory,entry),size=data?.length??(await stat(filename)).size,name=Buffer.from(member),compressed=entry.endsWith(".aup3"),method=compressed?8:0;let value=0;
   const start=offset,local=Buffer.alloc(30),extra=Buffer.alloc(20);local.writeUInt32LE(0x04034b50);local.writeUInt16LE(45,4);local.writeUInt16LE(0x808,6);local.writeUInt16LE(method,8);local.writeUInt16LE(0x21,12);local.writeUInt32LE(0xffffffff,18);local.writeUInt32LE(0xffffffff,22);local.writeUInt16LE(name.length,26);local.writeUInt16LE(extra.length,28);extra.writeUInt16LE(1);extra.writeUInt16LE(16,2);extra.writeBigUInt64LE(BigInt(size),4);
   await write(local);await write(name);await write(extra);const payloadStart=offset;let read=0,checkpoint=0n;
   const source=data?Readable.from([data]):createReadStream(filename),count=new Transform({transform(chunk,encoding,callback){read+=chunk.length;value=crc32(chunk,value);callback(null,chunk);}}),transform=compressed?createDeflateRaw({level:1}):new Transform({transform(chunk,encoding,callback){callback(null,chunk);}});
   const pumping=pipeline(source,count,transform,{signal});void pumping.catch(()=>{});
   try{for await(const chunk of transform){if(offset>=checkpoint){await checkExportSpace(16*1024**2);await diskCheck?.(16*1024**2);checkpoint=offset+8n*1024n**2n;}await write(chunk);}await pumping;}finally{source.destroy();count.destroy();transform.destroy();await pumping.catch(()=>{});}
   if(read!==size)throw new Error("Project audio changed during packaging.");const packed=offset-payloadStart,descriptor=Buffer.alloc(24);descriptor.writeUInt32LE(0x08074b50);descriptor.writeUInt32LE(value,4);descriptor.writeBigUInt64LE(packed,8);descriptor.writeBigUInt64LE(BigInt(size),16);await write(descriptor);
   const record=Buffer.alloc(46),centralExtra=Buffer.alloc(28);record.writeUInt32LE(0x02014b50);record.writeUInt16LE(45,4);record.writeUInt16LE(45,6);record.writeUInt16LE(0x808,8);record.writeUInt16LE(method,10);record.writeUInt16LE(0x21,14);record.writeUInt32LE(value,16);record.writeUInt32LE(0xffffffff,20);record.writeUInt32LE(0xffffffff,24);record.writeUInt16LE(name.length,28);record.writeUInt16LE(centralExtra.length,30);record.writeUInt32LE(0xffffffff,42);centralExtra.writeUInt16LE(1);centralExtra.writeUInt16LE(24,2);centralExtra.writeBigUInt64LE(BigInt(size),4);centralExtra.writeBigUInt64LE(packed,12);centralExtra.writeBigUInt64LE(start,20);records.push(record,name,centralExtra);
  }
  const centralStart=offset;for(const record of records)await write(record);const centralSize=offset-centralStart,zip64Offset=offset,count=BigInt(entries.length);
  const end64=Buffer.alloc(56);end64.writeUInt32LE(0x06064b50);end64.writeBigUInt64LE(44n,4);end64.writeUInt16LE(45,12);end64.writeUInt16LE(45,14);end64.writeBigUInt64LE(count,24);end64.writeBigUInt64LE(count,32);end64.writeBigUInt64LE(centralSize,40);end64.writeBigUInt64LE(centralStart,48);await write(end64);
  const locator=Buffer.alloc(20);locator.writeUInt32LE(0x07064b50);locator.writeBigUInt64LE(zip64Offset,8);locator.writeUInt32LE(1,16);await write(locator);
  const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(0xffff,8);end.writeUInt16LE(0xffff,10);end.writeUInt32LE(0xffffffff,12);end.writeUInt32LE(0xffffffff,16);await write(end);await output.sync();
 }finally{await output.close();}
}

/** Inspect the central directory only, without reading or decoding the audio payload. */
async function hasOutdatedMembers(filename:string,names:ReadonlyMap<string,string>):Promise<boolean>{
 const file=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  async function read(bytes:number,position:number):Promise<Buffer>{const data=Buffer.alloc(bytes);let offset=0;while(offset<bytes){const result=await file.read(data,offset,bytes-offset,position+offset);if(!result.bytesRead)throw Error("ZIP ended before its directory was complete.");offset+=result.bytesRead;}return data;}
  const info=await file.stat();if(!info.isFile())throw Error("Invalid project ZIP file.");
  const size=info.size,length=Math.min(size,65557),tail=await read(length,size-length);
  let end=tail.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
  while(end>=0&&(end+22>length||end+22+tail.readUInt16LE(end+20)!==length))end=end===0?-1:tail.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]),end-1);
  if(end<0)return false;
  let bytes=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16);
  if(bytes===0xffffffff||offset===0xffffffff){
   if(end<20||tail.readUInt32LE(end-20)!==0x07064b50)throw Error("Invalid ZIP64 directory.");
   const position=Number(tail.readBigUInt64LE(end-12));if(!Number.isSafeInteger(position)||position<0||position+56>size)throw Error("Invalid ZIP64 position.");
   const record=await read(56,position);
   if(record.readUInt32LE(0)!==0x06064b50)throw Error("Invalid ZIP64 directory.");
   bytes=Number(record.readBigUInt64LE(40));offset=Number(record.readBigUInt64LE(48));
  }
  if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(bytes)||offset<0||bytes<0||bytes>16*1024**2||offset+bytes>size)throw Error("Invalid ZIP directory size.");
  const central=await read(bytes,offset);
  for(let index=0;index<bytes;){
   if(index+46>bytes||central.readUInt32LE(index)!==0x02014b50)throw Error("Invalid ZIP directory entry.");
   const nameLength=central.readUInt16LE(index+28),next=index+46+nameLength+central.readUInt16LE(index+30)+central.readUInt16LE(index+32);
   if(next>bytes)throw Error("Invalid ZIP directory entry size.");
   const name=central.toString("utf8",index+46,index+46+nameLength);
   if(names.has(name)?names.get(name)!==name:/^(?:raw-)?track-\d+\.(ogg|wav|flac|mp3|m4a)$/.test(name))return true;
   index=next;
  }
  return false;
 }finally{await file.close();}
}
const upgrades=new Map<string,Promise<boolean>>();
let upgradeTail:Promise<unknown>=Promise.resolve();
/** Upgrade a saved ZIP atomically from the existing media; no audio processing is repeated. */
export async function ensureSpeakerProjectZip(directory:string):Promise<boolean>{
 const active=upgrades.get(directory);if(active)return active;
 const upgrade=(async()=>{
  const project=path.join(directory,"project.zip");
  let manifest={};try{manifest=JSON.parse(await readFile(path.join(directory,"manifest.json"),"utf8"));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
  const names=packageNames(manifest);
  if(!await hasOutdatedMembers(project,names))return false;
  const repair=upgradeTail.then(async()=>{
   const temporary=path.join(directory,`.speaker-project-${randomUUID()}.tmp`),reserveGiB=Number(process.env.LOW_DISK_WARNING_GIB?.trim()||1);
   if(!Number.isFinite(reserveGiB)||reserveGiB<=0)throw Error("Invalid recording disk reserve.");
   const diskCheck=async(bytes:number)=>{const space=await statfs(directory);if(Number(space.bavail)*Number(space.bsize)<reserveGiB*1024**3+bytes)throw Error("Not enough free space to update speaker filenames; the existing export is unchanged.");};
   try{await writeZip(directory,temporary,undefined,diskCheck);await rename(temporary,project);return true;}finally{await rm(temporary,{force:true});}
  });
  upgradeTail=repair.catch(()=>{});return repair;
 })();
 upgrades.set(directory,upgrade);try{return await upgrade;}finally{upgrades.delete(directory);}
}

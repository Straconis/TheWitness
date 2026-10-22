import {open} from "node:fs/promises";
export async function projectSamples(filename:string):Promise<number>{
 const file=await open(filename,"r");
 try{
  const header=Buffer.alloc(12);await file.read(header,0,12,0);
  if(header.toString("ascii",0,4)==="fLaC"){
   // STREAMINFO is the first FLAC metadata block; its packed fields give exact sample counts.
   if((header[4]&0x7f)!==0||header.readUIntBE(5,3)!==34)throw new Error("Invalid FLAC STREAMINFO.");
   const info=Buffer.alloc(34);const result=await file.read(info,0,34,8);
   if(result.bytesRead!==34)throw new Error("Truncated FLAC STREAMINFO.");
   const packed=info.readBigUInt64BE(10),rate=Number(packed>>44n),channels=Number((packed>>41n)&7n)+1,count=Number(packed&0xfffffffffn);
   if(rate!==48000||channels!==2||count===0)throw new Error("Project tracks must be complete 48 kHz stereo FLAC files.");
   return count;
  }
  if(!["RIFF","RF64"].includes(header.toString("ascii",0,4))||header.toString("ascii",8,12)!=="WAVE")throw new Error("Invalid project WAV file.");
  const length=(await file.stat()).size;let offset=12,align=0,largeSize:bigint|undefined;
  while(offset+8<=length){const chunk=Buffer.alloc(8);await file.read(chunk,0,8,offset);const kind=chunk.toString("ascii",0,4),size=chunk.readUInt32LE(4);offset+=8;
   if(kind==="ds64"){const data=Buffer.alloc(28);if(size<28)throw new Error("Invalid RF64 sizes.");await file.read(data,0,28,offset);largeSize=data.readBigUInt64LE(8);}
   if(kind==="fmt "){const data=Buffer.alloc(16);if(size<16)throw new Error("Invalid WAV format.");await file.read(data,0,16,offset);align=data.readUInt16LE(12);if(data.readUInt32LE(4)!==48000||data.readUInt16LE(2)!==2)throw new Error("Project tracks must be 48 kHz stereo.");}
   if(kind==="data"){const bytes=size===0xffffffff?Number(largeSize):size;if(!align||!Number.isSafeInteger(bytes)||bytes>length-offset||bytes%align)throw new Error("Invalid WAV data length.");return bytes/align;}
   offset+=size+(size%2);
  }throw new Error("WAV data missing.");
 }finally{await file.close();}
}

// SESX structure adapted from Craig commit 60d1a00.
// Copyright and permission notice: licenses/Craig-ISC.txt.
import { open,writeFile } from "node:fs/promises";
import path from "node:path";
const xml=(text:string)=>text.replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[char]!));
async function samples(filename:string):Promise<number>{
 const file=await open(filename,"r");
 try{
  const header=Buffer.alloc(12);await file.read(header,0,12,0);
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
export async function writeAudition(directory:string,tracks:Array<{file:string;username:string}>,notes:Array<{seconds:number;text:string}>=[],title?:string):Promise<void>{
 const durations=await Promise.all(tracks.map(track=>samples(path.join(directory,track.file))));
 const audio=tracks.map((track,index)=>`<audioTrack automationLaneOpenState="false" id="${10001+index}" index="${index+1}" select="false" visible="true"><trackParameters trackHeight="80" trackHue="${(index*47)%360}" trackMinimized="false"><name>${xml(track.username)}</name></trackParameters><trackAudioParameters audioChannelType="stereo" automationMode="1" monitoring="false" recordArmed="false" solo="false" soloSafe="false"><trackOutput outputID="10000" type="trackID"/><trackInput inputID="-1"/></trackAudioParameters><audioClip name="${xml(track.username)}" clipAutoCrossfade="false" startPoint="0" endPoint="${durations[index]}" fileID="${index}" hue="-1" id="${index+1}" lockedInTime="false" looped="false" offline="false" select="false" sourceInPoint="0" sourceOutPoint="${durations[index]}" zOrder="2"/></audioTrack>`).join("\n");
 const markers=notes.filter(note=>Number.isFinite(note.seconds)&&note.seconds>=0&&note.seconds*48000<=Math.max(...durations)).map(note=>`<rdf:li rdf:parseType="Resource"><xmpDM:startTime>${Math.round(note.seconds*48000)}</xmpDM:startTime><xmpDM:name>${xml(note.text)}</xmpDM:name></rdf:li>`).join("");
 const metadata=`<xmpMetadata><![CDATA[<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:xmpDM="http://ns.adobe.com/xmp/1.0/DynamicMedia/" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xml(title??"The Witness recording")}</rdf:li></rdf:Alt></dc:title><xmpDM:Tracks><rdf:Bag><rdf:li rdf:parseType="Resource"><xmpDM:trackName>The Witness Notes</xmpDM:trackName><xmpDM:trackType>Cue</xmpDM:trackType><xmpDM:frameRate>f48000</xmpDM:frameRate><xmpDM:markers><rdf:Seq>${markers}</rdf:Seq></xmpDM:markers></rdf:li></rdf:Bag></xmpDM:Tracks></rdf:Description></rdf:RDF></x:xmpmeta>]]></xmpMetadata>`;
 const output=`<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!DOCTYPE sesx>\n<sesx version="1.8"><session appBuild="13.0.0.519" appVersion="13.0" audioChannelType="stereo" bitDepth="32" duration="${Math.max(...durations)}" sampleRate="48000"><tracks>${audio}<masterTrack automationLaneOpenState="false" id="10000" index="${tracks.length+1}" select="false" visible="true"><trackParameters trackHeight="80" trackHue="-1" trackMinimized="false"><name>Master</name></trackParameters><trackAudioParameters audioChannelType="stereo" automationMode="1" monitoring="false" recordArmed="false" solo="false" soloSafe="true"><trackOutput outputID="1" type="hardwareOutput"/><trackInput inputID="-1"/></trackAudioParameters></masterTrack></tracks><sessionState ctiPosition="0" smpteStart="0"><timeFormatState beatsPerBar="4" beatsPerMinute="120" customFrameRate="12" linkToDefaultTimeSettings="true" noteLength="4" subdivisions="16" timeCodeDropFrame="false" timeCodeFrameRate="30" timeCodeNTSC="false" timeFormat="timeFormatDecimal"/><mixingOptionState defaultPanModeLogarithmic="false" panPower="-3" playOverlappingClips="false"/></sessionState>${metadata}</session><files>${tracks.map((track,index)=>`<file id="${index}" relativePath="${xml(track.file)}"/>`).join("")}</files></sesx>`;
 await writeFile(path.join(directory,"session.sesx"),output);
}

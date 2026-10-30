// Generated local audio only; never touches configured recording storage.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {OpusEncoder}=require('@discordjs/opus');
const {RecordingSession}=require('../dist/recording/session');
const {exportSession}=require('../dist/exports/export');
const {ExportStageProfiler}=require('../dist/exports/stage-profile');
(async()=>{const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-stage-profile-'));try{
 const session=await RecordingSession.create(root,'local-profile','local-profile');
 const encoders=[new OpusEncoder(48000,2),new OpusEncoder(48000,2)];
 for(let frame=0;frame<250;frame++)for(let speaker=0;speaker<2;speaker++){
  const pcm=Buffer.alloc(3840);for(let i=0;i<960;i++){const value=Math.round(6000*Math.sin((frame*960+i)*2*Math.PI*(220+speaker*110)/48000));pcm.writeInt16LE(value,i*4);pcm.writeInt16LE(value,i*4+2);}
  await session.append(encoders[speaker].encode(pcm),'speaker-'+speaker,'Synthetic '+speaker,frame*960,BigInt(frame*960+1));
 }
 await session.close();const profiler=new ExportStageProfiler();
 await exportSession(root,session.id,{format:'flac',includeRaw:true,mix:true,cleanupAudio:true,normalizeAudio:true,onProgress:(_,seconds,id)=>profiler.begin(id??undefined)});
 profiler.finish();console.log(JSON.stringify({synthetic:true,speakers:2,seconds:5,stageTimings:profiler.timings},null,2));
 }finally{await fs.rm(root,{recursive:true,force:true});}})().catch(error=>{console.error(error);process.exitCode=1;});

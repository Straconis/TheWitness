const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const capacity=require('../dist/exports/worker-capacity'),speech=require('../dist/exports/speech-cleanup'),{exportSession}=require('../dist/exports/export'),{RecordingSession}=require('../dist/recording/session'),{withExportProgress,withExportSpaceCheck}=require('../dist/exports/workspace');
test('production cleanup runs three bounded workers with identical output, combined progress and serial low-space fallback',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-parallel-')),snapshot=capacity.readWorkerResources,clean=speech.cleanSpeech,setting=process.env.EXPORT_PARALLEL_TRACKS;let active=0,peak=0;
 try{
  capacity.readWorkerResources=async()=>({cpuCores:6,memoryLimitBytes:6*1024**3,memoryAvailableBytes:5*1024**3,diskAvailableBytes:80*1024**3});
  speech.cleanSpeech=async(...args)=>{active++;peak=Math.max(peak,active);try{await new Promise(r=>setTimeout(r,30));await clean(...args);}finally{active--;}};
  const session=await RecordingSession.create(root,'guild','voice');for(let frame=0;frame<30;frame++)for(let n=0;n<4;n++)await session.append(Buffer.from([0xf8,0xff,0xfe]),'user'+n,'Speaker '+n,frame*960,BigInt(frame*960+1));await session.close();const metaFile=path.join(session.directory,"session.json"),meta=JSON.parse(await fs.readFile(metaFile));meta.durationSamples=30*960;await fs.writeFile(metaFile,JSON.stringify(meta));
  process.env.EXPORT_PARALLEL_TRACKS='off';const serial=await exportSession(root,session.id,{format:'flac',cleanupAudio:true});assert.equal(peak,1);
  peak=0;const progress=[],plan=[];process.env.EXPORT_PARALLEL_TRACKS='auto';const parallel=await withExportProgress(n=>progress.push(n),()=>exportSession(root,session.id,{format:'flac',cleanupAudio:true,onPlan:p=>plan.push(...p)}));assert.equal(peak,3);assert.ok(plan.some(w=>w.id==='cleanup-batch'));assert.ok(progress.some(n=>n>2));
  for(let n=1;n<=4;n++)assert.deepEqual(await fs.readFile(path.join(serial,`track-${n}.flac`)),await fs.readFile(path.join(parallel,`track-${n}.flac`)));
  peak=0;await withExportSpaceCheck(async()=>{},()=>exportSession(root,session.id,{format:'flac',cleanupAudio:true}));assert.equal(peak,1);
 }finally{capacity.readWorkerResources=snapshot;speech.cleanSpeech=clean;if(setting===undefined)delete process.env.EXPORT_PARALLEL_TRACKS;else process.env.EXPORT_PARALLEL_TRACKS=setting;await fs.rm(root,{recursive:true,force:true});}
});

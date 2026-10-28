const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {RecordingSession}=require('../dist/recording/session'),{OpusEncoder}=require('@discordjs/opus');
const {ExportQueue}=require('../dist/exports/jobs'),{estimateExportBytes,estimateSequentialWorkspace}=require('../dist/exports/storage');
const {writeProjectZip}=require('../dist/exports/project-zip'),{withExportSpaceCheck}=require('../dist/exports/workspace');
const until=async check=>{for(let i=0;i<1000;i++){if(check())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out');};
const space=availableBytes=>({availableBytes,totalBytes:34*1024**3,warningBytes:1024**3,low:false,critical:false,criticalBytes:0,checkedAt:new Date().toISOString()});
async function recording(root){const s=await RecordingSession.create(root,'guild','voice'),encoder=new OpusEncoder(48000,2),pcm=Buffer.alloc(3840);for(let frame=0;frame<20;frame++)for(let n=0;n<2;n++)await s.append(encoder.encode(pcm),'speaker'+n,'Speaker '+n,frame*960,BigInt(frame*960),pcm);await s.close();const file=path.join(s.directory,'session.json'),meta=JSON.parse(await fs.readFile(file));meta.durationSamples=4*3600*48000;await fs.writeFile(file,JSON.stringify(meta));return s;}
test('sequential FLAC exports complete when the bulk estimate exceeds capacity, with raw tracks, mixing and a valid ZIP',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-sequential-'));let queue;
 try{const s=await recording(root),options={sessionID:s.id,guildID:'guild',format:'audition',trackFormat:'flac',mix:true,includeRaw:true};const bulk=await estimateExportBytes(root,options),workspace=await estimateSequentialWorkspace(root,options);assert.ok(bulk>workspace+1024**3);
 let checks=0;queue=new ExportQueue(root,undefined,undefined,2,async()=>{checks++;return space(workspace+2*1024**3);});await queue.load(false);const job=await queue.enqueue(s.id,'guild','audition',true,{trackFormat:'flac',includeRaw:true});queue.start();await until(()=>['completed','failed'].includes(job.state));assert.equal(job.state,'completed',job.error);assert.ok(checks>=7,'checks before individual encodes and ZIP packaging');const dir=path.join(root,s.id,job.directory),files=await fs.readdir(dir);assert.ok(files.includes('project.zip'));assert.ok(files.includes('raw-track-1.flac'));assert.ok(!files.some(f=>f.endsWith('.ogg')));assert.equal((await fs.stat(path.join(dir,'raw-track-1.flac'))).ino,(await fs.stat(path.join(dir,'track-1.flac'))).ino,'unchanged raw and processed FLAC share initial storage');assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'manifest.json'))).sessionID,s.id);
 }finally{await queue?.close();queue?.releaseIntroReferences();await fs.rm(root,{recursive:true,force:true});}
});
test('a failed per-step space check removes partial output and preserves the source recording',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-sequential-space-'));let queue;
 try{const s=await recording(root),original=await fs.readFile(path.join(s.directory,'audio.ogg.data')),workspace=await estimateSequentialWorkspace(root,{sessionID:s.id,guildID:'guild',format:'audition'});let checks=0;
 queue=new ExportQueue(root,undefined,undefined,1,async()=>space(++checks<=2?workspace+2*1024**3:1024**3));await queue.load(false);const job=await queue.enqueue(s.id,'guild','audition',true,{includeRaw:true});queue.start();await until(()=>['completed','failed'].includes(job.state));assert.equal(job.state,'failed');assert.match(job.error,/next export step/);assert.ok(!(await fs.readdir(s.directory)).some(f=>f.startsWith('export-')));assert.deepEqual(await fs.readFile(path.join(s.directory,'audio.ogg.data')),original);
 }finally{await queue?.close();queue?.releaseIntroReferences();await fs.rm(root,{recursive:true,force:true});}
});
test('ZIP packaging checks actual stored file sizes before opening its output',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-exact-zip-'));
 try{await fs.writeFile(path.join(root,'track-1.flac'),Buffer.alloc(10000));let requested;
 await assert.rejects(withExportSpaceCheck(async bytes=>{requested=bytes;throw Error('No ZIP space');},()=>writeProjectZip(root)),/No ZIP space/);assert.ok(requested>10000&&requested<11000);await assert.rejects(fs.stat(path.join(root,'project.zip')),{code:'ENOENT'});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('audio encoders report actual output time through the export progress context',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-tool-progress-'));
 try{const {runTool}=require('../dist/exports/process'),{withExportProgress}=require('../dist/exports/workspace'),file=path.join(root,'input.wav');
 const pcm=Buffer.alloc(48000*4),header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(pcm.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(2,22);header.writeUInt32LE(48000,24);header.writeUInt32LE(192000,28);header.writeUInt16LE(4,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(pcm.length,40);await fs.writeFile(file,Buffer.concat([header,pcm]));const samples=[];
 await withExportProgress(seconds=>samples.push(seconds),()=>runTool(path.resolve(__dirname,'../bin/ffmpeg'),['-nostdin','-v','error','-i',file,'-c:a','flac',path.join(root,'output.flac')]));assert.ok(samples.some(seconds=>seconds>=0.9),'progress comes from encoded audio time');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('time estimates use measured audio speed and remain unavailable until enough data exists',()=>{
 const {estimateStepRemaining}=require('../dist/exports/progress');
 assert.equal(estimateStepRemaining(600,3600,10000),50);
 assert.equal(estimateStepRemaining(600,3600,3000),undefined);
 assert.equal(estimateStepRemaining(0,3600,10000),undefined);
 assert.equal(estimateStepRemaining(600,undefined,10000),undefined);
 assert.equal(estimateStepRemaining(3601,3600,10000),0);
 assert.equal(estimateStepRemaining(NaN,3600,10000),undefined);
});

test('a sequential export holds exclusive admission until its disk-sensitive work finishes',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-sequential-exclusive-'));let queue,release,entered;
 const gate=new Promise(resolve=>release=resolve),ready=new Promise(resolve=>entered=resolve);
 try{const s=await recording(root),workspace=await estimateSequentialWorkspace(root,{sessionID:s.id,guildID:'guild',format:'audition'});let calls=0;
 queue=new ExportQueue(root,undefined,undefined,2,async()=>{if(++calls===2){entered();await gate;}return space(workspace+2*1024**3);});await queue.load(false);
 const first=await queue.enqueue(s.id,'guild','audition',true,{includeRaw:true});queue.start();await ready;
 const second=await queue.enqueue(s.id,'guild','flac',false,{includeRaw:true});assert.equal(first.state,'running');assert.equal(second.state,'queued');assert.equal(queue.running.size,1);release();
 await until(()=>first.state==='completed'||first.state==='failed');assert.equal(first.state,'completed',first.error);
 }finally{release();await queue?.close();queue?.releaseIntroReferences();await fs.rm(root,{recursive:true,force:true});}
});

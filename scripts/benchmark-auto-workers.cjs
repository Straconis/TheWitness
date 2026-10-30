// Local experiment only. Production does not import or enable this worker pool.
// Run under systemd-run --user --scope with CPUQuota, MemoryMax and MemorySwapMax=0.
const fs=require('node:fs'),fsp=fs.promises,path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {runTool}=require('../dist/exports/process'),{cleanSpeech,defaultAudioTool}=require('../dist/exports/speech-cleanup'),{matchLoudness}=require('../dist/exports/normalization');
const {planWorkers,runAdaptiveWorkers,readWorkerResources,MiB}=require('../dist/exports/worker-capacity');
const arg=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i<0?fallback:process.argv[i+1];};
const seconds=Number(arg('seconds',30)),speakers=Number(arg('speakers',7)),rounds=Number(arg('rounds',2));
assert.ok(Number.isInteger(seconds)&&seconds>=5&&seconds<=180);assert.ok(Number.isInteger(speakers)&&speakers>=2&&speakers<=7);assert.ok(Number.isInteger(rounds)&&rounds>=1&&rounds<=4);
const root=path.resolve(__dirname,'..'),out=path.resolve(arg('out',path.join(root,'work','auto-workers',String(Date.now())))),media=path.join(out,'media'),tool=defaultAudioTool();
const group='/sys/fs/cgroup'+fs.readFileSync('/proc/self/cgroup','utf8').split('\n').find(line=>line.startsWith('0::')).slice(3);
const read=name=>fs.readFileSync(path.join(group,name),'utf8').trim(),cpu=()=>Number(/^usage_usec (\d+)$/m.exec(read('cpu.stat'))[1])/1e6;
assert.equal(read('memory.swap.max'),'0');assert.ok(Number(read('memory.max'))<=6*1024**3);assert.ok(read('cpu.max').split(' ')[0]!=='max','A hard CPU quota is required');
const report={seconds,speakers,rounds,limits:{cpuMax:read('cpu.max'),memoryMax:read('memory.max'),swapMax:read('memory.swap.max')},runs:[],sourceHashes:{},admissions:[],productionChanged:false};
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const median=values=>{const sorted=[...values].sort((a,b)=>a-b),i=Math.floor(sorted.length/2);return sorted.length%2?sorted[i]:(sorted[i-1]+sorted[i])/2;};
async function save(){await fsp.writeFile(path.join(out,'results.tmp'),JSON.stringify(report,null,2));await fsp.rename(path.join(out,'results.tmp'),path.join(out,'results.json'));}
function allocated(directory){let bytes=0;for(const entry of fs.readdirSync(directory,{withFileTypes:true})){const file=path.join(directory,entry.name);try{bytes+=entry.isDirectory()?allocated(file):fs.statSync(file).blocks*512;}catch(error){if(error.code!=='ENOENT')throw error;}}return bytes;}
(async()=>{await fsp.mkdir(path.dirname(out),{recursive:true});await fsp.mkdir(out);await fsp.mkdir(media);try{
 const source=path.join(media,'source');await fsp.mkdir(source);const sourceFiles=[];
 for(let i=0;i<speakers;i++){const file=path.join(source,`speaker-${i}.flac`);await runTool(tool,['-nostdin','-v','error','-n','-stream_loop','-1','-i',path.join(root,'assets/audio/witness-start.ogg'),'-t',String(seconds+137/48000),'-af',`volume=${.4+i*.05}`,'-ar','48000','-c:a','flac',file]);sourceFiles.push(file);report.sourceHashes[i]=hash(file);}
 const initial=await readWorkerResources(media);report.initialResources=initial;
 const policy={automatic:true,maxWorkers:3,cpuPerWorker:1.5,reserveCores:1,memoryPerWorkerBytes:256*MiB,reserveMemoryBytes:Math.max(512*MiB,Math.min(1024*MiB,initial.memoryLimitBytes/4)),temporaryBytesPerWorker:Math.ceil((seconds*48000+137)*8*1.1)+MiB,reserveDiskBytes:1024*MiB};
 report.policy=policy;report.initialPlan=planWorkers(initial,policy);await save();assert.ok(initial.diskAvailableBytes>policy.reserveDiskBytes+policy.temporaryBytesPerWorker*(speakers+3),'Preserve local disk reserve');
 let reference;
 for(let round=0;round<rounds;round++)for(const flow of round%2?['auto','serial']:['serial','auto']){
  const directory=path.join(media,`${round}-${flow}`);await fsp.mkdir(directory);const files=[];for(let i=0;i<speakers;i++){const file=path.join(directory,`speaker-${i}.flac`);await fsp.copyFile(sourceFiles[i],file);files.push(file);}
  let active=0,maxActive=0,peakDisk=allocated(directory);const admissionStart=report.admissions.length;
  const timer=setInterval(()=>{peakDisk=Math.max(peakDisk,allocated(directory));},10);const started=performance.now(),startCPU=cpu();const stages={};
  try{for(const stage of ['cleanup','loudness']){const began=performance.now();await runAdaptiveWorkers(files,{...policy,automatic:flow==='auto'},()=>readWorkerResources(directory),async(file,index,signal)=>{active++;maxActive=Math.max(maxActive,active);try{if(stage==='cleanup')await cleanSpeech(file,'flac',tool,signal);else await matchLoudness(file,'flac',tool,signal);}finally{active--; }},{onAdmission:event=>report.admissions.push({round,flow,stage,...event})});stages[stage]=(performance.now()-began)/1000;}}
  finally{clearInterval(timer);}
  const elapsedSeconds=(performance.now()-started)/1000,cpuSeconds=cpu()-startCPU,hashes=files.map(hash);
  if(!reference)reference=hashes;else assert.deepEqual(hashes,reference,'Every processed FLAC file is byte-identical to serial output');
  for(let i=0;i<speakers;i++)assert.equal(hash(sourceFiles[i]),report.sourceHashes[i],'Source remains unchanged');
  const row={round,flow,elapsedSeconds,cpuSeconds,maxActive,peakAllocatedWorkingBytes:Math.max(peakDisk,allocated(directory)),stages,byteIdentical:true};report.runs.push(row);await save();console.log(JSON.stringify(row));await fsp.rm(directory,{recursive:true,force:true});
 }
 const diskTest=path.join(media,'disk-budget');await fsp.mkdir(diskTest);const free=(await readWorkerResources(diskTest)).diskAvailableBytes;
 const diskPolicy={...policy,automatic:true,temporaryBytesPerWorker:8*MiB,reserveDiskBytes:free-10*MiB};let diskActive=0,diskPeak=0;
 await runAdaptiveWorkers([0,1,2,3],diskPolicy,()=>readWorkerResources(diskTest),async(item)=>{const file=path.join(diskTest,item+'.bin');diskActive++;diskPeak=Math.max(diskPeak,diskActive);try{await fsp.writeFile(file,Buffer.alloc(4*MiB));await new Promise(resolve=>setTimeout(resolve,20));}finally{await fsp.rm(file,{force:true});diskActive--;}});
 assert.equal(diskPeak,1,'Live filesystem budget must restrict admission to one worker');report.diskReservationTest={maxActive:diskPeak,temporaryPayloadBytes:4*MiB,allTemporaryFilesRemoved:(await fsp.readdir(diskTest)).length===0};
 if(report.initialPlan.workers>=2){
  const failureDir=path.join(media,'failure');await fsp.mkdir(failureDir);const files=[];for(let i=0;i<5;i++){const file=path.join(failureDir,i+'.flac');await fsp.copyFile(sourceFiles[i%sourceFiles.length],file);files.push(file);}const before=files.map(hash),finished=new Set(),started=[];
  await assert.rejects(runAdaptiveWorkers(files,policy,()=>readWorkerResources(failureDir),async(file,index,signal)=>{started.push(index);if(index===1){await new Promise(resolve=>setTimeout(resolve,100));throw Error('intentional benchmark failure');}await cleanSpeech(file,'flac',tool,signal);finished.add(index);}),/intentional benchmark failure/);
  const remaining=(await fsp.readdir(failureDir)).filter(name=>name.startsWith('cleanup-'));assert.equal(remaining.length,0,'No in-flight temporary file survives cancellation');for(let i=0;i<files.length;i++)if(!finished.has(i))assert.equal(hash(files[i]),before[i],'Interrupted input stays intact');
  report.failureTest={started,finishedBeforeFailure:[...finished],temporaryFilesRemaining:remaining.length,unfinishedInputsUnchanged:true};
 }
 const serial=report.runs.filter(row=>row.flow==='serial'),auto=report.runs.filter(row=>row.flow==='auto');
 const old=median(serial.map(row=>row.elapsedSeconds)),next=median(auto.map(row=>row.elapsedSeconds));
 report.summary={serialMedianSeconds:old,autoMedianSeconds:next,elapsedReductionPercent:100*(1-next/old),serialMedianCPUSeconds:median(serial.map(row=>row.cpuSeconds)),autoMedianCPUSeconds:median(auto.map(row=>row.cpuSeconds)),maxAutoWorkers:Math.max(...auto.map(row=>row.maxActive)),allFilesByteIdentical:true,sourcesUnchanged:true,cgroupMemoryPeakBytes:Number(read('memory.peak'))};await save();console.log(JSON.stringify(report.summary,null,2));
 }catch(error){report.error=error.stack;await save();throw error;}finally{await fsp.rm(media,{recursive:true,force:true});}
})().catch(error=>{console.error(error);process.exitCode=1;});

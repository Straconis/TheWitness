const test=require('node:test'),assert=require('node:assert/strict'),{exportFailureMessage,savedExportFailure}=require('../dist/exports/failure'),{UserError}=require('../dist/errors');
test('export failures explain timeouts, stalls and storage without exposing private diagnostics',()=>{
 assert.match(exportFailureMessage(Error('Audio tool timed out.'),'Cleaning speech: Alice'),/time limit during Cleaning speech: Alice/);
 assert.match(exportFailureMessage(Error('Audio tool stalled: audio progress stopped.'),'Cleaning speech: Alice'),/five minutes/);
 assert.match(exportFailureMessage(Object.assign(Error('private path'),{code:'ENOSPC'}),'Compressing download'),/free disk space during Compressing/);
 const secret='private-token=do-not-display';assert.ok(!exportFailureMessage(Error(secret),'Mixing speakers').includes(secret));
 assert.match(exportFailureMessage(Error('Audio tool failed (1): Invalid data found when processing input /private/file')),/could not decode/);
 assert.equal(exportFailureMessage(new UserError('Choose an intro.')),'Choose an intro.');
 assert.match(savedExportFailure({error:'Audio tool timed out.',stageTimings:{prepare:{},cleanup:{}}}),/time limit during speech cleanup/);
 assert.equal(savedExportFailure({publicError:'Specific reason'}),'Specific reason');
});

test('saved timeout jobs explain the reason through the signed status API without logs',async()=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{RecordingSession}=require('../dist/recording/session'),{ExportQueue}=require('../dist/exports/jobs'),{DownloadService}=require('../dist/downloads/service');const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-public-failure-'));let queue,service;
 try{
  const source=await RecordingSession.create(root,'guild','voice');await source.append(Buffer.from([0xf8,0xff,0xfe]),'user','Alice',0,1n);await source.close();
  queue=new ExportQueue(root,async(root,id,options)=>{options.onProgress('Cleaning speech: Alice',10,'clean:1');throw Error('Audio tool timed out.');});await queue.load();const job=await queue.enqueue(source.id,'guild','flac');for(let n=0;n<100&&job.state!=='failed';n++)await new Promise(r=>setTimeout(r,10));assert.equal(job.state,'failed');assert.match(job.publicError,/time limit during Cleaning speech: Alice/);
  service=await DownloadService.create(root,'http://localhost');service.attach(queue);const port=await service.listen(0,'127.0.0.1'),url=service.jobLink(job.id).replace('http://localhost',`http://127.0.0.1:${port}`);
  const result=await (await fetch(url,{headers:{Accept:'application/json'}})).json();assert.match(result.error,/time limit/);assert.match(result.error,/Alice/);assert.ok(!result.error.includes('logs'));
  job.publicError=undefined;job.failureStage=undefined;job.stageTimings={cleanup:{wallMs:1800000,segments:1}};const legacy=await (await fetch(url,{headers:{Accept:'application/json'}})).json();assert.match(legacy.error,/speech cleanup/);
 }finally{await service?.close();await queue?.close();queue?.releaseIntroReferences();await fs.rm(root,{recursive:true,force:true});}
});

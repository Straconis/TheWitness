const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {mkdtemp,mkdir,writeFile,rm,chmod}=require('node:fs/promises'),{existsSync}=require('node:fs');
const {uploadIntroChunk}=require('../dist/exports/server-intro'),{DownloadService}=require('../dist/downloads/service'),{SettingsStore}=require('../dist/storage/settings'),{ExportQueue}=require('../dist/exports/jobs');
function wav(seconds){const n=Math.round(seconds*48000),b=Buffer.alloc(44+n*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(192000,28);b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*4,40);return b;}
async function session(root,guild='g'){const id=require('node:crypto').randomUUID();await mkdir(path.join(root,id));await writeFile(path.join(root,id,'session.json'),JSON.stringify({id,guildID:guild,channelID:'c',startedAt:'2026-10-01T00:00:00Z',state:'completed',durationSamples:48000*60,tracks:[{track:1,id:'u',username:'Alice'}]}));return id;}

test('custom intro errors seen by recording-link holders do not reveal server paths',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-path-leak-'));let service,queue;
 try{const id=await session(root);const settings=new SettingsStore(path.join(root,'settings.json'));await settings.load();queue=new ExportQueue(root);await queue.load(false);
  service=await DownloadService.create(root,'https://example.com');service.attach(queue,settings,{sessions:new Map()});
  const port=await service.listen(0,'127.0.0.1'),link=service.recordingLink(id).replace('https://example.com',`http://127.0.0.1:${port}`);
  const post=async body=>{const response=await fetch(link,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const started=await post({action:'upload-custom-intro',index:0,final:false,bytes:wav(.1).toString('base64'),name:'x'});assert.equal(started.status,200);
  const skipped=await post({action:'upload-custom-intro',id:started.body.id,index:2,final:true,bytes:wav(.1).toString('base64')});
  assert.equal(skipped.status,400);assert.equal(skipped.body.error,'Part of this intro upload is missing. Start the upload again.');assert.ok(!skipped.body.error.includes(root));
  // Forged identifiers stay inside this recording's folder or are refused.
  for(const id of ['../../server-intros/x','00000000-0000-0000-0000-000000000000/../x'])assert.equal((await post({action:'upload-custom-intro',id,index:1,final:true,bytes:'AAAA'})).body.error,'Invalid intro upload.');
  assert.equal((await post({format:'wav',includeIntro:true,introScope:'recording',introID:'../../x'})).status,400);
  // Backup requests: wrong shapes are rejected, never coerced.
  for(const backupProjects of ['audition',[1],['audition','audition'],{0:'audition'},['audition','audacity','x']]){const result=await post({format:'soundcraft',backupProjects});assert.equal(result.status,400,JSON.stringify(backupProjects));assert.match(result.body.error,/Choose Adobe Audition, Audacity, both, or neither/);}
 }finally{await service?.close();await queue?.close();queue?.releaseIntroReferences();await rm(root,{recursive:true,force:true});}
});

test('a VAD capability probe that times out is retried rather than cached as unsupported',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-vad-probe-'));
 const config=require('../dist/integrations/transcription-config');
 try{config.resetVadProbes();config.configureVadProbe({timeoutMs:200,backoffBaseMs:50,backoffMaxMs:50});const slow=path.join(root,'slow');
  const executable=path.join(root,'whisper');await writeFile(executable,`#!/bin/sh\nif [ -e "${slow}" ]; then sleep 2; fi\necho "  -vm FNAME, --vad-model FNAME"\n`);await chmod(executable,0o755);
  await writeFile(slow,'');assert.equal(await config.probeVad(executable),undefined,'timed out');
  await rm(slow);await new Promise(resolve=>setTimeout(resolve,60));assert.equal(await config.probeVad(executable),true,'probe ran again after the backoff');
  await writeFile(slow,'');assert.equal(await config.probeVad(executable),true,'a completed result is cached');
  const missing=path.join(root,'missing-but-statted');await writeFile(missing,'not executable');assert.equal(await config.probeVad(missing),undefined,'a spawn failure is retried later, not cached');
 }finally{config.resetVadProbes();config.configureVadProbe({timeoutMs:10000,backoffBaseMs:1000,backoffMaxMs:300000});await rm(root,{recursive:true,force:true});}
});

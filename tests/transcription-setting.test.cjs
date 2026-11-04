const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {mkdtemp,writeFile,rm}=require('node:fs/promises');
const {RecordingSession}=require('../dist/recording/session'),{OpusEncoder}=require('@discordjs/opus'),{ExportQueue}=require('../dist/exports/jobs');
const {DownloadService}=require('../dist/downloads/service'),{BotStatusStore}=require('../dist/discord/bot-status'),{TranscriptionSetting}=require('../dist/storage/transcription-setting');
const {transcriptionAllowed,transcriptionReady,transcriptionStatus,setTranscriptionAllowed}=require('../dist/integrations/transcription-config');
const {landingPage}=require('../dist/downloads/landing-page'),{invitePage}=require('../dist/downloads/invite-page'),{editorPage}=require('../dist/downloads/editor-page'),{helpMessage}=require('../dist/discord/help');
const until=async(fn,label)=>{for(let i=0;i<3000;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out: '+label);};
test.afterEach(()=>setTranscriptionAllowed(true));

test('the owner setting defaults on, persists across restarts and overrides an installed engine',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-transcription-setting-')),saved={...process.env};
 try{
  const model=path.join(root,'model.bin'),executable=path.join(root,'whisper');await writeFile(model,'m');await writeFile(executable,'x');
  Object.assign(process.env,{TRANSCRIPTION_EXECUTABLE:executable,TRANSCRIPTION_MODEL:model,TRANSCRIPTION_VAD_MODEL:'off'});
  const file=path.join(root,'transcription-setting.json'),setting=new TranscriptionSetting(file);await setting.load();
  assert.equal(transcriptionAllowed(),true);assert.equal(transcriptionStatus(),'ready');
  await setting.update(false);assert.equal(transcriptionReady(),false);assert.equal(transcriptionStatus(),'off');
  setTranscriptionAllowed(true);await new TranscriptionSetting(file).load();assert.equal(transcriptionAllowed(),false);
  await assert.rejects(setting.update('no'),/on or off/);assert.equal(transcriptionAllowed(),false);
 }finally{for(const key of ['TRANSCRIPTION_EXECUTABLE','TRANSCRIPTION_MODEL','TRANSCRIPTION_VAD_MODEL'])if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];await rm(root,{recursive:true,force:true});}
});

test('public pages and help stop promising transcripts when they are off',()=>{
 const on=landingPage({demo:false,sample:false},'https://example.com'),off=landingPage({demo:false,sample:false},'https://example.com',false);
 assert.match(on,/transcripts included/);assert.match(on,/transcript\.vtt/);assert.match(on,/<th scope="row">Transcripts/);
 assert.doesNotMatch(off,/transcri/i);assert.match(off,/Hosted Discord recording, free for now/);assert.match(off,/session\.sesx\nnotes\.json/);
 assert.match(invitePage(),/optional local transcription/);assert.doesNotMatch(invitePage(false),/transcri/i);
 assert.match(editorPage('ask'),/id="transcribe"/);assert.doesNotMatch(editorPage('ask',false),/id="transcribe"/);
 const help=helpMessage('exports',{downloads:true,restricted:false,transcriptsOff:true}).embeds[0].description;
 assert.match(help,/turned off right now/);assert.doesNotMatch(help,/Whisper|speech engine/);assert.match(help,/`upload:dropbox/);
});

test('only the owner can flip the setting, and the landing page follows it at once',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-transcription-admin-'));let service;
 try{
  const status=new BotStatusStore(path.join(root,'status.json'));await status.load();const setting=new TranscriptionSetting(path.join(root,'transcription-setting.json'));await setting.load();
  service=await DownloadService.create(root,'https://example.com');service.setOwnerAdmin(status,()=>{});service.setTranscriptionSetting(setting);
  const port=await service.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${port}`,owner=service.adminLink().replace('https://example.com',base);
  const post=(url,body)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let response=await post(base+'/admin/control',{action:'transcription',enabled:false});assert.equal(response.status,403);await response.text();assert.equal(transcriptionAllowed(),true);
  assert.match(await(await fetch(owner)).text(),/Turn transcripts off/);
  response=await post(owner,{action:'transcription',enabled:false});assert.deepEqual(await response.json(),{enabled:false});
  assert.match(await(await fetch(owner)).text(),/Turn transcripts on/);assert.doesNotMatch(await(await fetch(base+'/')).text(),/transcri/i);
  response=await post(owner,{action:'transcription',enabled:'off'});assert.equal(response.status,400);await response.text();assert.equal(transcriptionAllowed(),false);
  response=await post(owner,{action:'transcription',enabled:true});assert.deepEqual(await response.json(),{enabled:true});assert.match(await(await fetch(base+'/')).text(),/transcripts included/);
 }finally{await service?.close();await rm(root,{recursive:true,force:true});}
});

test('new transcript requests are refused and queued ones fail before any heavy work',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-transcription-queue-')),saved={...process.env};let queue,rendered=0;
 try{
  const session=await RecordingSession.create(root,'g','voice'),encoder=new OpusEncoder(48000,2),pcm=Buffer.alloc(3840);for(let i=0;i<5;i++)await session.append(encoder.encode(pcm),'user','Alice',i*960,BigInt(i*960),pcm);await session.close();
  const model=path.join(root,'model.bin'),executable=path.join(root,'whisper');await writeFile(model,'m');await writeFile(executable,'x');
  Object.assign(process.env,{TRANSCRIPTION_EXECUTABLE:executable,TRANSCRIPTION_MODEL:model,TRANSCRIPTION_VAD_MODEL:'off'});
  queue=new ExportQueue(root,async()=>{rendered++;throw Error('should not render');});await queue.load(false);
  const job=await queue.enqueue(session.id,'g','flac',false,{transcribe:true});
  setTranscriptionAllowed(false);
  await assert.rejects(queue.enqueue(session.id,'g','wav',false,{transcribe:true}),/Transcripts are turned off/);
  queue.start();await until(()=>['completed','failed'].includes(queue.get(job.id).state),'queued job');
  assert.equal(queue.get(job.id).state,'failed');assert.match(queue.get(job.id).publicError,/Transcripts are turned off/);assert.equal(rendered,0);
 }finally{for(const key of ['TRANSCRIPTION_EXECUTABLE','TRANSCRIPTION_MODEL','TRANSCRIPTION_VAD_MODEL'])if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];await queue?.close();queue?.releaseIntroReferences();await rm(root,{recursive:true,force:true});}
});

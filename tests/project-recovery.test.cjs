const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{execFileSync}=require('node:child_process');
const {RecoveryStore,RECOVERY_CHUNK}=require('../dist/recovery/store');
const {DownloadService}=require('../dist/downloads/service');
const {OwnerLogin}=require('../dist/downloads/owner-login');
const {writeAudition}=require('../dist/exports/audition');
const {writeSoundcraft}=require('../dist/exports/soundcraft');
const {writeNativeAudacity}=require('../dist/exports/aup3');
const {writeProjectZip}=require('../dist/exports/project-zip');
const {exportSession}=require('../dist/exports/export');
const ffmpeg=path.resolve('bin/ffmpeg');
function decode(file){return execFileSync(ffmpeg,['-v','error','-i',file,'-f','s16le','-ac','2','-ar','48000','pipe:1']);}
async function fixture(dir,frames=48000){const pcm=Buffer.alloc(frames*4);for(let i=0;i<frames;i++){pcm.writeInt16LE(Math.round(Math.sin(i*.11)*4000),i*4);pcm.writeInt16LE(Math.round(Math.sin(i*.07)*3000),i*4+2);}execFileSync(ffmpeg,['-v','error','-f','s16le','-ar','48000','-ac','2','-i','pipe:0',path.join(dir,'track-1.flac')],{input:pcm});return pcm;}
async function upload(store,files,projectType='auto'){const job=await store.create({title:'Recovered test',projectType,files:files.map(f=>({name:f.name,size:f.bytes.length}))});for(let i=0;i<files.length;i++)for(let at=0;at<files[i].bytes.length;at+=RECOVERY_CHUNK)await store.chunk(job.id,i,at,files[i].bytes.subarray(at,at+RECOVERY_CHUNK).toString('base64'));return job;}
async function finished(store,id){const timeout=Date.now()+20000;while(Date.now()<timeout){const job=(await store.list()).find(j=>j.id===id);if(job.state!=='importing')return job;await new Promise(r=>setTimeout(r,20));}throw Error('Import did not finish');}
test('Soundcraft, Audition and native Audacity ZIP projects recover to ordinary sessions with lossless audio',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-recovery-formats-'));const store=new RecoveryStore(root);
 try{for(const format of ['soundcraft','audition','audacity']){
  const dir=path.join(root,format);await fs.mkdir(dir);const expected=await fixture(dir),tracks=[{file:'track-1.flac',username:'Speaker & Café',userID:'speaker'}];
  if(format==='soundcraft')await writeSoundcraft(dir,tracks,[{seconds:.25,text:'A note'}],'Soundcraft test');
  if(format==='audition')await writeAudition(dir,tracks,[{seconds:.25,text:'A note'}],'Audition test');
  if(format==='audacity')await writeNativeAudacity(dir,tracks,[{seconds:.25,text:'A note'}]);
  await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify({tracks}));await writeProjectZip(dir);const job=await upload(store,[{name:'project.zip',bytes:await fs.readFile(path.join(dir,'project.zip'))}],format);await store.start(job.id);const done=await finished(store,job.id);assert.equal(done.state,'ready',done.error);
  const session=path.join(root,done.sessionID),metadata=JSON.parse(await fs.readFile(path.join(session,'session.json')));assert.equal(metadata.sourceType,'audio-import');assert.equal(metadata.durationSamples,48000);assert.equal(metadata.tracks.length,1);assert.match(metadata.tracks[0].username,/Speaker/);assert.deepEqual(decode(path.join(session,'source-track-1.flac')),expected);
  const output=await exportSession(root,done.sessionID,{format:'flac',mix:true});assert.deepEqual(decode(path.join(output,'track-1.flac')),expected);assert.ok(JSON.parse(await fs.readFile(path.join(output,'manifest.json'))).mix);
 }}finally{await store.close();await fs.rm(root,{recursive:true,force:true});}
});
test('audio-only upload resumes across store restarts, retries chunks idempotently, and rejects overruns',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-recovery-upload-'));let store=new RecoveryStore(root);
 try{const bytes=Buffer.alloc(RECOVERY_CHUNK+123,0x35);bytes.fill(0x64,RECOVERY_CHUNK);const job=await store.create({title:'Resume',files:[{name:'input.wav',size:bytes.length}]});
  const first=bytes.subarray(0,RECOVERY_CHUNK).toString('base64');await store.chunk(job.id,0,0,first);assert.equal((await store.chunk(job.id,0,0,first)).received,RECOVERY_CHUNK);await store.close();store=new RecoveryStore(root);await store.chunk(job.id,0,RECOVERY_CHUNK,bytes.subarray(RECOVERY_CHUNK).toString('base64'));assert.deepEqual(await fs.readFile(path.join(root,'recovery',job.id,'files','0')),bytes);
  await assert.rejects(store.chunk(job.id,0,bytes.length,Buffer.from('bad').toString('base64')),/exceeds/);await assert.rejects(store.chunk(job.id,0,0,Buffer.from('wrong').toString('base64')),/does not match/);await assert.rejects(store.create({title:'Bad',files:[{name:'../input.wav',size:1}]}),/invalid/);await assert.rejects(store.create({title:'Huge',files:[{name:'x.wav',size:33*1024**3}]}));await store.remove(job.id);assert.equal((await store.list()).length,0);
 }finally{await store.close();await fs.rm(root,{recursive:true,force:true});}
});
test('missing media, unsafe ZIP paths, unsupported processing and ambiguous projects fail with actionable errors',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-recovery-errors-')),store=new RecoveryStore(root);
 try{const cases=[['missing.sesx',Buffer.from('<sesx><session sampleRate="48000"><tracks/></session><files><file id="1" relativePath="missing.wav"/></files></sesx>'),/Missing media/]];
 const zip=path.join(root,'unsafe.zip');execFileSync('python3',['-c','import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],"w");z.writestr("../escape.wav",b"bad");z.close()',zip]);cases.push(['unsafe.zip',await fs.readFile(zip),/unsafe path/]);
 for(const [name,bytes,error]of cases){const job=await upload(store,[{name,bytes}]);await store.start(job.id);const done=await finished(store,job.id);assert.equal(done.state,'failed');assert.match(done.error,error);}
 const dir=path.join(root,'fixture');await fs.mkdir(dir);await fixture(dir);await writeSoundcraft(dir,[{file:'track-1.flac',username:'Speaker'}]);const scraft=JSON.parse(await fs.readFile(path.join(dir,'session.scraft')));scraft.tracks[0].automation=[{something:true}];const session=Buffer.from(JSON.stringify(scraft));const job=await upload(store,[{name:'session.scraft',bytes:session},{name:'Speaker.flac',bytes:await fs.readFile(path.join(dir,'track-1.flac'))}]);await store.start(job.id);assert.match((await finished(store,job.id)).error,/automation/);
 }finally{await store.close();await fs.rm(root,{recursive:true,force:true});}
});
test('recovery HTTP is owner-only and returns ordinary signed recording links after audio import',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-recovery-http-'));let service;
 try{service=await DownloadService.create(root,'https://example.com');const port=await service.listen(0,'127.0.0.1'),base='http://127.0.0.1:'+port;
  const post=(data,cookie,origin)=>fetch(base+'/recovery',{method:'POST',headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...(origin?{Origin:origin}:{})},body:JSON.stringify(data)});
  assert.equal((await fetch(base+'/recovery',{headers:{Accept:'application/json'}})).status,403);assert.equal((await post({action:'create'})).status,403);assert.match(await(await fetch(base+'/recovery')).text(),/Owner sign-in/);
  const login=new OwnerLogin(root,await fs.readFile(path.join(root,'download-key')),true),key=await login.createKey();const response=await post({action:'sign-in',key});assert.equal(response.status,200);assert.match(response.headers.get('set-cookie'),/Path=\/recovery/);const cookie=response.headers.get('set-cookie').split(';')[0];
  assert.equal((await post({action:'create'},cookie,'https://attacker.test')).status,403);const input=path.join(root,'fixture');await fs.mkdir(input);await fixture(input);const bytes=await fs.readFile(path.join(input,'track-1.flac'));
  const create=await post({action:'create',title:'Recovered HTTP',files:[{name:'input.flac',size:bytes.length}]},cookie);assert.equal(create.status,201);const job=await create.json();assert.equal((await post({action:'chunk',id:job.id,index:0,offset:0,bytes:bytes.toString('base64')},cookie)).status,200);assert.equal((await post({action:'start',id:job.id},cookie)).status,202);
  let ready;for(let i=0;i<200;i++){ready=(await(await fetch(base+'/recovery',{headers:{Cookie:cookie,Accept:'application/json'}})).json()).jobs[0];if(ready.state!=='importing')break;await new Promise(r=>setTimeout(r,20));}
  assert.equal(ready.state,'ready',ready.error);assert.match(ready.recordingURL,/https:\/\/example.com\/recording\/[a-f0-9-]{36}\?expires=/);assert.match(ready.editorURL,/editor=1/);
 }finally{await service?.close();await fs.rm(root,{recursive:true,force:true});}
});
test('an official Audacity 3.7.9 resave with native numeric attributes and empty effect racks imports',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-native-recovery-')),store=new RecoveryStore(root);
 try{const job=await upload(store,[{name:'audacity.zip',bytes:await fs.readFile(path.join(__dirname,'fixtures/audacity-3.7.9-resaved.zip'))}]);await store.start(job.id);const done=await finished(store,job.id);assert.equal(done.state,'ready',done.error);const session=path.join(root,done.sessionID),metadata=JSON.parse(await fs.readFile(path.join(session,'session.json')));assert.equal(metadata.durationSamples,96000);assert.equal(metadata.tracks.length,1);assert.equal(metadata.tracks[0].username,'Alice & Café');assert.match(await fs.readFile(path.join(session,'notes.jsonl'),'utf8'),/A note/);assert.equal(decode(path.join(session,'source-track-1.flac')).length,96000*4);
 }finally{await store.close();await fs.rm(root,{recursive:true,force:true});}
});
test('Soundcraft and Audition imports preserve nonzero clip placement and source trims',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-recovery-offset-')),store=new RecoveryStore(root);
 try{const dir=path.join(root,'fixture');await fs.mkdir(dir);const pcm=await fixture(dir),source=await fs.readFile(path.join(dir,'track-1.flac'));
 for(const format of ['soundcraft','audition']){
  let session;if(format==='soundcraft'){await writeSoundcraft(dir,[{file:'track-1.flac',username:'Speaker'}]);const data=JSON.parse(await fs.readFile(path.join(dir,'session.scraft')));const clip=data.tracks[0].playlists[0].clips[0];clip.start=24000;clip.length=12000;clip.content.Audio.offset=12000;session=Buffer.from(JSON.stringify(data));}
  else session=Buffer.from('<sesx><session sampleRate="48000"><tracks><audioTrack><trackParameters><name>Speaker</name></trackParameters><audioClip startPoint="24000" endPoint="36000" sourceInPoint="12000" fileID="0"/></audioTrack></tracks></session><files><file id="0" relativePath="Speaker.flac"/></files></sesx>');
  const job=await upload(store,[{name:format==='soundcraft'?'session.scraft':'session.sesx',bytes:session},{name:'Speaker.flac',bytes:source}]);await store.start(job.id);const done=await finished(store,job.id);assert.equal(done.state,'ready',done.error);const result=decode(path.join(root,done.sessionID,'source-track-1.flac'));assert.deepEqual(result,Buffer.concat([Buffer.alloc(24000*4),pcm.subarray(12000*4,24000*4)]));
 }}finally{await store.close();await fs.rm(root,{recursive:true,force:true});}
});
test('cancelled imports drain their process tree; interrupted imports retain uploads and clean partial output on restart',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-recovery-cancel-'));let store=new RecoveryStore(root);
 try{const dir=path.join(root,'fixture');await fs.mkdir(dir);await fixture(dir);const bytes=await fs.readFile(path.join(dir,'track-1.flac'));
  const job=await upload(store,[{name:'input.flac',bytes}]);const importing=await store.start(job.id);await store.remove(job.id);assert.equal((await store.list()).length,0);await assert.rejects(fs.stat(path.join(root,'recovery-session-'+importing.sessionID)),e=>e.code==='ENOENT');
  const interrupted=await upload(store,[{name:'input.flac',bytes}]);await store.close();const file=path.join(root,'recovery',interrupted.id,'state.json'),state=JSON.parse(await fs.readFile(file));state.state='importing';state.sessionID=require('node:crypto').randomUUID();const partial=path.join(root,'recovery-session-'+state.sessionID);await fs.mkdir(partial);await fs.writeFile(path.join(partial,'partial.flac'),'partial');await fs.writeFile(file,JSON.stringify(state));
  store=new RecoveryStore(root);const recovered=(await store.list())[0];assert.equal(recovered.state,'failed');assert.match(recovered.error,/restarted/);assert.deepEqual(await fs.readFile(path.join(root,'recovery',interrupted.id,'files','0')),bytes);await assert.rejects(fs.stat(partial),e=>e.code==='ENOENT');await store.start(interrupted.id);assert.equal((await finished(store,interrupted.id)).state,'ready');
 }finally{await store.close();await fs.rm(root,{recursive:true,force:true});}
});
test('removing completed upload files preserves the recording; explicit recording deletion removes both',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-recovery-remove-')),store=new RecoveryStore(root);
 try{const dir=path.join(root,'fixture');await fs.mkdir(dir);await fixture(dir);const job=await upload(store,[{name:'input.flac',bytes:await fs.readFile(path.join(dir,'track-1.flac'))}]);await store.start(job.id);const done=await finished(store,job.id);assert.equal(done.state,'ready',done.error);await store.remove(job.id);assert.equal((await store.list())[0].state,'ready');assert.ok(await fs.stat(path.join(root,done.sessionID,'source-track-1.flac')));assert.equal((await store.list())[0].files.length,0);await store.deleteRecording(job.id);assert.equal((await store.list()).length,0);await assert.rejects(fs.stat(path.join(root,done.sessionID)),e=>e.code==='ENOENT');
 }finally{await store.close();await fs.rm(root,{recursive:true,force:true});}
});

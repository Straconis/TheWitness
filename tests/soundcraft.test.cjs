const test=require('node:test'),assert=require('node:assert/strict');
const {mkdtemp,mkdir,readFile,writeFile,rm,open}=require('node:fs/promises');
const path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process'),vm=require('node:vm');
const limits=require('../dist/exports/soundcraft-limits');
const {recordingPage}=require('../dist/downloads/recording-page'),{editorPage}=require('../dist/downloads/editor-page');
const {RecordingSession}=require('../dist/recording/session'),{exportSession}=require('../dist/exports/export');
const {ExportQueue}=require('../dist/exports/jobs'),{DownloadService}=require('../dist/downloads/service');
const {OpusEncoder}=require('@discordjs/opus');
const id='11111111-1111-4111-8111-111111111111';
const metadata=seconds=>({id,guildID:'guild',channelID:'voice',startedAt:'2026-10-01T00:00:00Z',state:'completed',durationSamples:seconds*48000,tracks:[{track:1,id:'user',username:'Alice'}]});

test('Soundcraft limit accepts its exact boundary, rejects one extra frame, and accounts for edits/intros',()=>{
 const {SOUNDCRAFT_MAX_SECONDS:max,soundcraftWarning,assertSoundcraftLength,soundcraftExportSeconds,recordingSeconds}=limits;
 assert.equal(soundcraftWarning(max),undefined);assert.throws(()=>assertSoundcraftLength(max+1/48000),/length limit.*loads audio directly into RAM/);
 assert.throws(()=>assertSoundcraftLength(NaN),/could not be verified/);
 assert.equal(recordingSeconds({...metadata(100),audioOrigin:48000}),99);
 assert.equal(recordingSeconds({startedAt:'2026-10-01T00:00:00Z',endedAt:'2026-10-01T01:00:00Z'}),3600);
 assert.equal(soundcraftExportSeconds(metadata(max+100),{trimStart:100,trimEnd:160}),60);
 assert.throws(()=>assertSoundcraftLength(soundcraftExportSeconds(metadata(max),{},1)),/length limit/);
 const edits={tracks:[{clips:[{start:10,end:20,at:max}]}]};
 assert.throws(()=>assertSoundcraftLength(soundcraftExportSeconds(metadata(10),{edits})),/length limit/);
 assert.equal(soundcraftExportSeconds(metadata(max+100),{edits:{tracks:[{clips:[{start:100,end:110,at:0}]}]}}),10);
});

test('recording page keeps Soundcraft disabled after request failures and updates for intro padding',async()=>{
 const {SOUNDCRAFT_MAX_SECONDS:max}=limits;
 const long=recordingPage(metadata(max+1),false);
 assert.match(long,/<button[^>]*data-format="soundcraft"[^>]*disabled/);
 assert.match(long,/<p id="soundcraft-warning"[^>]*>Soundcraft is unavailable because this audio exceeds/);
 const short=recordingPage(metadata(max-1),false,{seconds:2,name:'Intro'});
 const script=/<script>([\s\S]*?)<\/script>/.exec(short)[1];
 let refresh;
 const buttons=['soundcraft','wav'].map(format=>({dataset:{format,mixed:'false'},disabled:false,tagName:'BUTTON',textContent:format}));
 const notice={hidden:true},intro={checked:false,addEventListener:(name,fn)=>{refresh=fn;}},status={};
 const inputs={'#started':{dateTime:'2026-10-01T00:00:00Z'},'#intro':intro,'#soundcraft-warning':notice,'#status':status,'#expiry':{},'#target-lufs':{value:'-16',validity:{valid:true}},'#max-true-peak':{value:'-1',validity:{valid:true}},'#silence-seconds':{value:'30'},'#track':{value:''}};
 const document={querySelector:selector=>selector.startsWith('button[data-format="soundcraft"]')?buttons[0]:inputs[selector]??{checked:false},querySelectorAll:selector=>selector==='button[data-format]'?buttons:[]};
 const context=vm.createContext({document,URL,location:{href:'https://example.com'},fetch:async()=>{throw Error('Download failed');}});
 vm.runInContext(script,context);assert.equal(buttons[0].disabled,false);
 intro.checked=true;refresh();assert.equal(buttons[0].disabled,true);assert.match(notice.textContent,/loads audio directly into RAM/);
 await buttons[1].onclick();assert.equal(buttons[0].disabled,true);assert.equal(buttons[1].disabled,false);
 intro.checked=false;refresh();assert.equal(buttons[0].disabled,false);assert.equal(notice.hidden,true);
 const editor=editorPage();new vm.Script(/<script>([\s\S]*?)<\/script>/.exec(editor)[1]);assert.match(editor,/option value="soundcraft"[^>]*disabled/);
});

test('Soundcraft queue rejects long recordings, accepts bounded excerpts, and persists the new format',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-soundcraft-queue-'));let queue;
 try{
  await mkdir(path.join(root,id));await writeFile(path.join(root,id,'session.json'),JSON.stringify(metadata(limits.SOUNDCRAFT_MAX_SECONDS+1)));
  queue=new ExportQueue(root);await queue.load(false);
  await assert.rejects(queue.enqueue(id,'guild','soundcraft'),/length limit.*RAM/);
  const job=await queue.enqueue(id,'guild','soundcraft',false,{trimStart:10,trimEnd:20,backupProjects:[]});assert.equal(job.trackFormat,'wav');
  await queue.close();queue=new ExportQueue(root);await queue.load(false);assert.equal(queue.get(job.id).format,'soundcraft');
 }finally{await queue?.close();await rm(root,{recursive:true,force:true});}
});

test('Soundcraft exports WAV/FLAC sessions and rendered editor projects with portable ZIP media',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-soundcraft-export-'));
 try{
  const session=await RecordingSession.create(root,'guild','voice'),encoder=new OpusEncoder(48000,2),pcm=Buffer.alloc(3840);
  for(let i=0;i<20;i++)await session.append(encoder.encode(pcm),'user','Alice & friends 🎧',i*960,BigInt(i*960),pcm);
  await session.close();
  // Fix the note to synthetic audio time; wall-clock time varies under parallel test load.
  await writeFile(path.join(root,session.id,'notes.jsonl'),JSON.stringify({seconds:0.1,text:'A recording note',authorID:'user'})+'\n');
  for(const trackFormat of ['wav','flac']){
   const output=await exportSession(root,session.id,{format:'soundcraft',trackFormat,mix:true});
   const manifest=JSON.parse(await readFile(path.join(output,'manifest.json'))),doc=JSON.parse(await readFile(path.join(output,'session.scraft')));
   assert.equal(manifest.format,'soundcraft');assert.equal(manifest.project,'project.zip');assert.equal(doc.sources[0].path,'track-1.'+trackFormat);
   assert.equal(doc.sources[0].frames,19200);assert.equal(doc.tracks[0].name,'Alice & friends 🎧');assert.equal(doc.tracks[0].playlists[0].clips[0].start,0);
   assert.equal(doc.tracks.length,1);assert.equal(doc.markers.length,1);assert.ok(doc.next_id>doc.markers[0].id);
   const result=spawnSync('python3',['-c','import zipfile,sys,json\nz=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None\ns=json.loads(z.read("session.scraft"));assert all(x["path"] in z.namelist() for x in s["sources"])',path.join(output,'project.zip')],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
   const edits={tracks:[{track:1,name:'Edited Alice',gainDb:-6,pan:0,muted:false,solo:false,clips:[{start:0,end:0.2,at:0.3}]}],notes:[{seconds:0.4,text:'Edited note'}]};
   const edited=await exportSession(root,session.id,{format:'soundcraft',trackFormat,sourceExport:path.basename(output),edits});
   const editedDoc=JSON.parse(await readFile(path.join(edited,'session.scraft')));assert.equal(editedDoc.sources[0].frames,24000);assert.equal(editedDoc.tracks[0].mixer.volume_db,0);assert.equal(editedDoc.markers[0].start,19200);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

test('exact rendered frame check rejects an oversized source without reading its audio into RAM',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-soundcraft-limit-'));let file;
 try{
  // Sparse PCM file: only its header is physically written.
  const frames=limits.SOUNDCRAFT_MAX_FRAMES+1,bytes=frames*4,header=Buffer.alloc(44);
  header.write('RIFF');header.writeUInt32LE(bytes+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(2,22);header.writeUInt32LE(48000,24);header.writeUInt32LE(192000,28);header.writeUInt16LE(4,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(bytes,40);
  file=await open(path.join(root,'track-1.wav'),'wx');await file.write(header);await file.truncate(bytes+44);await file.close();file=undefined;
  await assert.rejects(require('../dist/exports/soundcraft').writeSoundcraft(root,[{file:'track-1.wav',username:'Long'}]),/length limit/);
 }finally{await file?.close();await rm(root,{recursive:true,force:true});}
});

test('private downloads deliver Soundcraft ZIP/session files and retain signed-link access checks',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-soundcraft-download-'));let service;
 const exp='export-22222222-2222-4222-8222-222222222222';
 try{
  const dir=path.join(root,id,exp);await mkdir(dir,{recursive:true});await writeFile(path.join(root,id,'session.json'),JSON.stringify(metadata(limits.SOUNDCRAFT_MAX_SECONDS+1)));
  await writeFile(path.join(dir,'session.scraft'),'session');await writeFile(path.join(dir,'project.zip'),'zip');await writeFile(path.join(dir,'track-1.wav'),'audio');
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify({sessionID:id,guildID:'guild',format:'soundcraft',tracks:[{file:'track-1.wav',username:'Alice'}],project:'project.zip'}));
  const settings=new (require('../dist/storage/settings').SettingsStore)(path.join(root,'settings.json'));await settings.load();
  service=await DownloadService.create(root,'https://example.com');service.attach({enqueue:async()=>({id})},settings,{});
  const port=await service.listen(0,'127.0.0.1'),local=url=>url.replace('https://example.com',`http://127.0.0.1:${port}`),url=local(service.link(id,exp));
  const pageResponse=await fetch(url),page=await pageResponse.text();assert.equal(pageResponse.status,200,page);new vm.Script(/<script>([\s\S]*?)<\/script>/.exec(page)[1]);assert.match(page,/Soundcraft session \(ZIP\)/);assert.match(page,/soundcraft-warning/);
  for(const name of ['session.scraft','project.zip']){const file=new URL(url);file.pathname+='/'+name;const response=await fetch(file);assert.equal(response.status,200);await response.text();file.searchParams.delete('signature');assert.equal((await fetch(file)).status,403);}
 }finally{await service?.close();await rm(root,{recursive:true,force:true});}
});

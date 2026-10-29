const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {mkdtemp,mkdir,writeFile,readFile,rm}=require('node:fs/promises');const {spawnSync}=require('node:child_process');
const backup=require('../dist/exports/soundcraft-backup');
const {RecordingSession}=require('../dist/recording/session'),{OpusEncoder}=require('@discordjs/opus');
const {exportSession}=require('../dist/exports/export'),{ExportQueue}=require('../dist/exports/jobs');
const {DownloadService}=require('../dist/downloads/service'),{SettingsStore}=require('../dist/storage/settings');
const {recordingPage}=require('../dist/downloads/recording-page'),{uploadIntroChunk}=require('../dist/exports/server-intro');
const until=async fn=>{for(let i=0;i<500;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timeout');};
function wav(seconds){const n=Math.round(seconds*48000),b=Buffer.alloc(44+n*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(192000,28);b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*4,40);for(let i=0;i<n;i++){const x=Math.round(3000*Math.sin(i*2*Math.PI*330/48000));b.writeInt16LE(x,44+i*4);b.writeInt16LE(x,46+i*4);}return b;}
async function recording(root,guild,frames=20){const session=await RecordingSession.create(root,guild,'voice'),encoder=new OpusEncoder(48000,2);for(let i=0;i<frames;i++){const pcm=Buffer.alloc(3840);for(let s=0;s<960;s++){const x=Math.round(2000*Math.sin((i*960+s)*2*Math.PI*440/48000));pcm.writeInt16LE(x,s*4);pcm.writeInt16LE(x,s*4+2);}await session.append(encoder.encode(pcm),'user','Alice & "Bob" <3',i*960,BigInt(i*960),pcm);}await session.close();return session;}
// Extracts the ZIP like a user would, then resolves every project's media the way each editor does.
const inspect=`
import json,os,sys,tempfile,zipfile,xml.etree.ElementTree as ET
z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None
out=tempfile.mkdtemp();z.extractall(out);names=sorted(z.namelist())
audio=[n for n in names if n.endswith(('.wav','.flac'))]
r={'names':names,'audio':audio}
s=json.load(open(os.path.join(out,'session.scraft')))
r['scraft']={'paths':[x['path'] for x in s['sources']],'exists':all(os.path.isfile(os.path.join(out,x['path'])) for x in s['sources']),'frames':[x['frames'] for x in s['sources']],'tracks':[t['name'] for t in s['tracks']],'starts':[t['playlists'][0]['clips'][0]['start'] for t in s['tracks']],'markers':[[m['start'],m['comments']] for m in s['markers']]}
if 'backup-audition.sesx' in names:
 x=ET.parse(os.path.join(out,'backup-audition.sesx')).getroot()
 rel=[f.get('relativePath') for f in x.iter('file')]
 meta=x.find('.//xmpMetadata').text
 r['audition']={'paths':rel,'exists':all(os.path.isfile(os.path.join(out,p)) for p in rel),'tracks':[t.find('trackParameters/name').text for t in x.iter('audioTrack')],'ends':[int(c.get('endPoint')) for c in x.iter('audioClip')],'starts':[int(c.get('startPoint')) for c in x.iter('audioClip')],'markers':meta.count('<xmpDM:startTime>'),'marker_times':[int(v.split('</')[0]) for v in meta.split('<xmpDM:startTime>')[1:]]}
if 'backup-audacity.aup3' in names:
 sys.path.insert(0,os.path.join(os.getcwd(),'tests/helpers'));from aup3 import native_project
 c,x=native_project(os.path.join(out,'backup-audacity.aup3'));waves=x.findall('wavetrack')[::2]
 r['audacity']={'names':[t.get('name') for t in waves],'offsets':[t.find('waveclip').get('offset') for t in waves],'labels':[[float(l.get('t')),l.get('title')] for l in x.findall('./labeltrack/label')]}
if 'BACKUP-PROJECTS.txt' in names:r['readme']=open(os.path.join(out,'BACKUP-PROJECTS.txt')).read()
print(json.dumps(r))`;
function zip(file){const result=spawnSync('python3',['-I','-c',inspect,file],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}

test('all five admin modes resolve backup projects and reject requests that contradict the setting',()=>{
 const {resolveBackupProjects:resolve}=backup;
 assert.deepEqual(resolve('audition','soundcraft'),['audition']);assert.deepEqual(resolve('audacity','soundcraft'),['audacity']);assert.deepEqual(resolve('both','soundcraft'),['audition','audacity']);
 assert.throws(()=>resolve('ask','soundcraft'),/Choose whether this Soundcraft export includes backup projects/);assert.deepEqual(resolve('none','soundcraft'),[]);
 assert.deepEqual(resolve('ask','soundcraft',['audacity','audition']),['audition','audacity']);assert.deepEqual(resolve('ask','soundcraft',['audacity']),['audacity']);assert.deepEqual(resolve('ask','soundcraft',[]),[]);
 assert.deepEqual(resolve('both','soundcraft',['audacity','audition']),['audition','audacity']);assert.deepEqual(resolve('none','soundcraft',[]),[]);
 assert.throws(()=>resolve('none','soundcraft',['audition']),/turned off/);assert.throws(()=>resolve('audition','soundcraft',['audacity']),/admin setting includes Adobe Audition/);assert.throws(()=>resolve('both','soundcraft',[]),/Adobe Audition and Audacity/);
 for(const bad of [['premiere'],['audition','audition'],'audition',{},['audition','audacity','audition']])assert.throws(()=>resolve('ask','soundcraft',bad),/Choose Adobe Audition, Audacity/);
 assert.equal(resolve('both','audition'),undefined);assert.equal(resolve('ask','wav',[]),undefined);assert.throws(()=>resolve('ask','audacity',['audition']),/only available with Soundcraft/);
 assert.throws(()=>resolve('sometimes','soundcraft'),/Choose Adobe Audition, Audacity, Both, Ask or None/);
 assert.equal(backup.DEFAULT_SOUNDCRAFT_BACKUP,'ask');assert.equal(backup.backupMode({}),'ask');
 assert.throws(()=>backup.validateSavedBackups(['audition'],'wav'),/only valid for Soundcraft/);
});

test('download page shows a choice only for Ask, describes fixed modes, and hides everything for None',async()=>{
 const session={id:'11111111-1111-4111-8111-111111111111',guildID:'g',channelID:'c',startedAt:'2026-10-01T00:00:00Z',state:'completed',durationSamples:48000*60,tracks:[{track:1,id:'u',username:'Alice'}]};
 const ask=recordingPage(session,false,undefined,'ask');assert.match(ask,/<select id="backup-projects">/);assert.match(ask,/Optional backup projects for Soundcraft testing/);
 const none=recordingPage(session,false,undefined,'none');assert.ok(!none.includes('<select id="backup-projects"')&&!none.includes('backup-projects-note')&&!/Optional backup projects|backup project for/i.test(none));
 for(const [mode,label] of [['audition','Adobe Audition backup project for'],['audacity','Audacity backup project for'],['both','Adobe Audition and Audacity backup projects for']]){const page=recordingPage(session,false,undefined,mode);assert.ok(!page.includes('<select id="backup-projects">'));assert.ok(page.includes(label),mode);new vm.Script(/<script>([\s\S]*?)<\/script>/.exec(page)[1]);}
 // Run the page script: Ask sends the chosen projects with Soundcraft only; fixed modes send nothing for the server to enforce.
 async function click(page,format,choice){const bodies=[];const buttons=['soundcraft','wav'].map(value=>({dataset:{format:value,mixed:'false'},disabled:false,textContent:value}));
  const values={'#backup-projects':{value:choice},'#target-lufs':{value:'-16',validity:{valid:true}},'#max-true-peak':{value:'-1',validity:{valid:true}},'#silence-seconds':{value:'30'},'#track':{value:''},'#intro-source':{value:'server'},'#started':{dateTime:'x'},'#soundcraft-warning':{},'#status':{},'#expiry':{},'#intro':{checked:false,addEventListener(){}},'#custom-intro-upload':{}};
  const document={querySelector:selector=>selector.startsWith('button[data-format="soundcraft"]')?buttons[0]:values[selector]??{checked:false,value:''},querySelectorAll:selector=>selector==='button[data-format]'?buttons:[]};
  const context=vm.createContext({document,URL,location:{href:'https://example.com/recording'},fetch:async(url,init)=>{bodies.push(JSON.parse(init.body));return {ok:true,json:async()=>({url:'https://example.com/job'})};}});
  vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(page)[1],context);await buttons.find(button=>button.dataset.format===format).onclick();return bodies[0];}
 assert.deepEqual((await click(ask,'soundcraft','both')).backupProjects,['audition','audacity']);assert.deepEqual((await click(ask,'soundcraft','audacity')).backupProjects,['audacity']);assert.deepEqual((await click(ask,'soundcraft','none')).backupProjects,[]);
 assert.equal((await click(ask,'wav','both')).backupProjects,undefined);assert.equal((await click(recordingPage(session,false,undefined,'audition'),'soundcraft')).backupProjects,undefined);assert.equal((await click(none,'soundcraft')).backupProjects,undefined);
});

test('managers set the backup mode per Discord server; the server enforces it on direct requests, queues and retries',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-backup-service-'));let service,queue;const calls=[];
 try{
  const one=await recording(root,'guild-one'),two=await recording(root,'guild-two');
  const settings=new SettingsStore(path.join(root,'settings.json'));await settings.load();
  const exporter=async(base,id,options)=>{calls.push(options);const dir=path.join(base,id,'export-'+require('node:crypto').randomUUID());await mkdir(dir);return dir;};
  const policy=guild=>backup.backupMode(settings.get(guild));
  queue=new ExportQueue(root,exporter);queue.setSoundcraftBackupPolicy(policy);await queue.load(false);
  service=await DownloadService.create(root,'https://example.com');service.attach(queue,settings,{sessions:new Map()});
  const port=await service.listen(0,'127.0.0.1'),local=url=>url.replace('https://example.com',`http://127.0.0.1:${port}`);
  const post=async(url,body)=>{const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const json=async url=>(await fetch(url,{headers:{Accept:'application/json'}})).json();
  const manager=guild=>local(service.dashboardLink(guild,true)),member=guild=>local(service.dashboardLink(guild));
  assert.equal((await json(manager('guild-one'))).soundcraftBackup,'ask');
  assert.match((await (await fetch(manager('guild-one'))).text()),/id="soundcraft-backup"/);assert.ok(!(await (await fetch(member('guild-one'))).text()).includes('id="soundcraft-backup"'));
  const denied=await post(member('guild-one'),{action:'soundcraft-backup',mode:'none'});assert.equal(denied.status,403);
  assert.equal((await post(manager('guild-one'),{action:'soundcraft-backup',mode:'always'})).status,400);
  assert.equal((await post(manager('guild-one'),{action:'soundcraft-backup',mode:'none'})).status,200);
  assert.equal(settings.get('guild-one').soundcraftBackup,'none');assert.equal(settings.get('guild-two').soundcraftBackup,undefined);
  const reloaded=new SettingsStore(path.join(root,'settings.json'));await reloaded.load();assert.equal(reloaded.get('guild-one').soundcraftBackup,'none');
  const recordingURL=session=>local(service.recordingLink(session.id));
  {const page=await (await fetch(recordingURL(one))).text();assert.ok(!page.includes('<select id="backup-projects"')&&!page.includes('backup-projects-note'));}assert.match(await (await fetch(recordingURL(two))).text(),/<select id="backup-projects">/);
  // Direct requests cannot add backups when a server turned them off; another server's Ask setting is unaffected.
  const forged=await post(recordingURL(one),{format:'soundcraft',backupProjects:['audition']});assert.equal(forged.status,400);assert.match(forged.body.error,/turned off/);
  const off=await post(recordingURL(one),{format:'soundcraft'});assert.equal(off.status,202);
  const asked=await post(recordingURL(two),{format:'soundcraft',backupProjects:['audacity']});assert.equal(asked.status,202);
  assert.equal((await post(recordingURL(two),{format:'wav',backupProjects:['audacity']})).status,400);
  const id=result=>new URL(result.body.url).pathname.split('/').pop();
  assert.deepEqual(queue.get(id(off)).backupProjects,[]);assert.deepEqual(queue.get(id(asked)).backupProjects,['audacity']);
  for(const [mode,expected] of [['audition',['audition']],['audacity',['audacity']],['both',['audition','audacity']]]){
   await settings.update('guild-one',{soundcraftBackup:mode});
   assert.match(await (await fetch(recordingURL(one))).text(),/backup-projects-note/);
   const wrong=await post(recordingURL(one),{format:'soundcraft',backupProjects:[]});assert.equal(wrong.status,400);
   const job=await queue.enqueue(one.id,'guild-one','soundcraft',false,{trimStart:0,trimEnd:0.2});assert.deepEqual(job.backupProjects,expected,mode);
  }
  // Every path uses the same server-side resolution: under Ask, a Soundcraft request without a choice is rejected.
  await assert.rejects(queue.enqueue(two.id,'guild-two','soundcraft',false,{trimStart:0.1}),/Choose whether this Soundcraft export includes backup projects/);
  // The resolved selection survives restart and retry even after the admin setting changes.
  await queue.close();queue=new ExportQueue(root,exporter);queue.setSoundcraftBackupPolicy(policy);await queue.load(false);
  assert.deepEqual(queue.get(id(asked)).backupProjects,['audacity']);
  await settings.update('guild-two',{soundcraftBackup:'none'});
  await queue.cancel(id(asked),'guild-two');const retried=await queue.retry(id(asked),'guild-two');assert.deepEqual(retried.backupProjects,['audacity']);
  await queue.close();queue=new ExportQueue(root,exporter);queue.setSoundcraftBackupPolicy(policy);await queue.load(false);assert.deepEqual(queue.get(retried.id).backupProjects,['audacity']);
  for(const job of [...queue.jobs.values()])if(job.id!==retried.id&&job.state==='queued')await queue.cancel(job.id,job.guildID);
  queue.start();await until(()=>queue.get(retried.id).state==='completed');assert.deepEqual(calls.at(-1).backupProjects,['audacity']);assert.equal(calls.at(-1).format,'soundcraft');
  // A corrupted saved selection is preserved on disk but not loaded.
  const file=path.join(root,'jobs',retried.id+'.json'),saved=JSON.parse(await readFile(file));saved.backupProjects=['premiere'];await writeFile(file,JSON.stringify(saved));
  await queue.close();queue=new ExportQueue(root,exporter);await queue.load(false);assert.equal(queue.get(retried.id),undefined);
 }finally{await service?.close();await queue?.close();await rm(root,{recursive:true,force:true});}
});

test('Soundcraft ZIPs include each selected backup project with shared, correctly linked audio, intro, names and markers',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-backup-zip-'));
 try{
  const session=await recording(root,'guild');await writeFile(path.join(root,session.id,'notes.jsonl'),JSON.stringify({seconds:0.1,text:'Ambush & <retreat>',authorID:'user'})+'\n');
  const intro=await uploadIntroChunk(root,'guild',{index:0,final:true,bytes:wav(0.5).toString('base64'),name:'Theme'});
  const introFrames=24000,speechFrames=19200;
  for(const [trackFormat,projects] of [['wav',[]],['wav',['audition']],['flac',['audacity']],['wav',['audition','audacity']],['flac',['audition','audacity']]]){
   const output=await exportSession(root,session.id,{format:'soundcraft',trackFormat,introID:intro.id,backupProjects:projects});
   const manifest=JSON.parse(await readFile(path.join(output,'manifest.json')));assert.deepEqual(manifest.backupProjects,projects.length?projects:undefined);
   const result=zip(path.join(output,'project.zip')),label=`${trackFormat} ${projects.join('+')||'none'}`;
   // One copy of each speaker/intro track, whatever the number of projects.
   assert.equal(result.audio.length,2,label);assert.ok(result.audio.every(name=>name.endsWith('.'+trackFormat)),label);
   const media='';
   assert.deepEqual(result.scraft.paths,['Alice & _Bob_ _3.'+trackFormat,'Intro - Theme.'+trackFormat],label);assert.ok(result.scraft.exists,label);
   assert.deepEqual(result.scraft.frames,[introFrames+speechFrames,introFrames],label);assert.deepEqual(result.scraft.starts,[0,0]);
   assert.deepEqual(result.scraft.tracks,['Alice & "Bob" <3','Intro: Theme']);assert.equal(result.scraft.markers.length,1);assert.ok(Math.abs(result.scraft.markers[0][0]-0.6*48000)<=2,label);assert.equal(result.scraft.markers[0][1],'Ambush & <retreat>');const marker=result.scraft.markers[0][0];
   assert.equal(result.names.includes('backup-audition.sesx'),projects.includes('audition'),label);assert.equal(result.names.includes('backup-audacity.aup3'),projects.includes('audacity'),label);
   assert.ok(!result.names.includes('session.sesx')&&!result.names.includes('session.aup'),label);
   if(projects.includes('audition')){const a=result.audition;assert.ok(a.exists,label);assert.deepEqual(a.paths,result.scraft.paths);assert.deepEqual(a.tracks,result.scraft.tracks);assert.deepEqual(a.starts,[0,0]);assert.deepEqual(a.ends,[introFrames+speechFrames,introFrames]);assert.deepEqual(a.marker_times,[marker]);}
   if(projects.includes('audacity')){const a=result.audacity;assert.deepEqual(a.names,result.scraft.tracks);assert.deepEqual(a.offsets,['0','0']);assert.equal(a.labels.length,1);assert.ok(Math.abs(a.labels[0][0]*48000-marker)<=1);assert.equal(a.labels[0][1],'Ambush & <retreat>');}
   if(projects.length){assert.match(result.readme,/optional backup projects for Soundcraft testing/);assert.match(result.readme,/Open session\.scraft in Soundcraft first/);}else assert.equal(result.readme,undefined);
  }
  // Editor exports keep the rendered edits, renamed tracks and moved notes in every backup project.
  const source=await exportSession(root,session.id,{format:'wav'});
  const edits={tracks:[{track:1,name:'Edited Alice',gainDb:0,pan:0,muted:false,solo:false,clips:[{start:0,end:0.2,at:0.3}]}],notes:[{seconds:0.4,text:'Moved note'}]};
  const edited=await exportSession(root,session.id,{format:'soundcraft',sourceExport:path.basename(source),edits,backupProjects:['audition','audacity']});
  const result=zip(path.join(edited,'project.zip'));assert.deepEqual(result.scraft.frames,[24000]);assert.deepEqual(result.audition.ends,[24000]);assert.deepEqual(result.audacity.names,['Edited Alice']);assert.deepEqual(result.audition.tracks,['Edited Alice']);assert.equal(result.audition.markers,1);assert.ok(Math.abs(result.audacity.labels[0][0]-0.4)<1e-9);
  assert.deepEqual(JSON.parse(await readFile(path.join(edited,'manifest.json'))).backupProjects,['audition','audacity']);
  // Standalone project exports are unchanged.
  const audacity=await exportSession(root,session.id,{format:'audacity'}),audition=await exportSession(root,session.id,{format:'audition'});
  const list=file=>JSON.parse(spawnSync('python3',['-I','-c','import zipfile,sys,json;print(json.dumps(sorted(zipfile.ZipFile(sys.argv[1]).namelist())))',file],{encoding:'utf8'}).stdout);
  const aup=list(path.join(audacity,'project.zip'));assert.ok(aup.includes('session.aup3')&&!aup.some(n=>n.endsWith('.wav'))&&!aup.includes('track-1.wav')&&!aup.some(name=>name.startsWith('backup')));
  assert.equal((await readFile(path.join(audacity,'session.aup3'))).subarray(0,15).toString(),'SQLite format 3');
  const sesx=list(path.join(audition,'project.zip'));assert.ok(sesx.includes('session.sesx')&&sesx.includes('Alice & _Bob_ _3.flac')&&!sesx.includes('track-1.flac')&&!sesx.some(name=>name.startsWith('backup')));
  assert.match(await readFile(path.join(audition,'session.sesx'),'utf8'),/relativePath="Alice &amp; _Bob_ _3\.flac"/);
 }finally{await rm(root,{recursive:true,force:true});}
});

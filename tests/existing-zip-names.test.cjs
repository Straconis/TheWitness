const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {DownloadService}=require('../dist/downloads/service'),{ensureSpeakerProjectZip,writeProjectZip}=require('../dist/exports/project-zip'),{archiveExport}=require('../dist/exports/archive'),{withExportSpaceCheck}=require('../dist/exports/workspace'),{downloadName,mixedTrackName,validateMixName}=require('../dist/downloads/names');
const sid='11111111-1111-4111-8111-111111111111',eid='export-22222222-2222-4222-8222-222222222222';
function python(code,...args){const r=spawnSync('python3',['-I','-c',code,...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim()?JSON.parse(r.stdout):undefined;}
async function fixture(root,intro=true,mixName){const dir=path.join(root,sid,eid);await fs.mkdir(dir,{recursive:true});
 const manifest={sessionID:sid,guildID:'guild',guildName:'Server',channelID:'voice',channelName:'Voice',startedAt:'2026-10-27T22:37:15.834Z',format:'audition',project:'project.zip',mix:'mix.flac',intro:intro?{name:'Theme',seconds:2}:undefined,mixName,tracks:[{file:'track-1.flac',username:'straconischannel'},{file:'track-2.flac',username:'太郎 & Bob'}],rawTracks:[{file:'raw-track-1.flac',username:'straconischannel'}]};
 await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest));
 for(const name of ['track-1.flac','track-2.flac','raw-track-1.flac','mix.flac'])await fs.writeFile(path.join(dir,name),Buffer.from('original lossless bytes: '+name));
 await fs.writeFile(path.join(dir,'session.sesx'),'<sesx><files><file id="0" relativePath="track-1.flac"/><file id="1" relativePath="track-2.flac"/></files></sesx>');
 await fs.writeFile(path.join(dir,'backup-audition.sesx'),await fs.readFile(path.join(dir,'session.sesx')));
 await fs.writeFile(path.join(dir,'session.scraft'),JSON.stringify({sources:manifest.tracks.map(t=>({path:t.file,name:t.username}))}));
 python('import pathlib,sys,zipfile,json\np=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(p/"project.zip","w") as z:\n for f in sorted(p.iterdir()):\n  if f.name!="project.zip":z.write(f,f.name)\nprint(json.dumps(True))',dir);
 return {dir,manifest};}
function inspect(zip){return python(`import zipfile,sys,json,xml.etree.ElementTree as ET
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 m=json.loads(z.read('manifest.json'));paths=[f.get('relativePath') for f in ET.fromstring(z.read('session.sesx')).findall('./files/file')]
 backup=[f.get('relativePath') for f in ET.fromstring(z.read('backup-audition.sesx')).findall('./files/file')]
 sound=[s['path'] for s in json.loads(z.read('session.scraft'))['sources']]
 assert all(p in z.namelist() for p in paths+backup+sound)
 assert all(t['file'] in z.namelist() for t in m['tracks']+m['rawTracks']);assert m['mix'] in z.namelist()
 print(json.dumps({'names':z.namelist(),'paths':paths,'mix':m['mix'],'audio':{t['username']:z.read(t['file']).decode() for t in m['tracks']},'raw':z.read(m['rawTracks'][0]['file']).decode()}))`,zip);}
test('an existing download is atomically upgraded with speaker filenames, linked projects, matching JSON, and dated intro mix',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-existing-names-'));let service;
 try{const {dir,manifest}=await fixture(root),old=await fs.readFile(path.join(dir,'project.zip')),audio=await fs.readFile(path.join(dir,'track-1.flac'));
  await assert.rejects(withExportSpaceCheck(async()=>{throw Error('No space for upgrade');},()=>ensureSpeakerProjectZip(dir)),/No space for upgrade/);
  assert.deepEqual(await fs.readFile(path.join(dir,'project.zip')),old);
  service=await DownloadService.create(root,'https://example.com');const port=await service.listen(0,'127.0.0.1'),url=new URL(service.link(sid,eid).replace('https://example.com',`http://127.0.0.1:${port}`));url.pathname+='/project.zip';
  const response=await fetch(url,{headers:{Range:'bytes=0-20'}});assert.equal(response.status,200,'an upgrade restarts a range download with the complete replacement');
  const downloaded=path.join(root,'downloaded.zip');await fs.writeFile(downloaded,Buffer.from(await response.arrayBuffer()));const info=inspect(downloaded);
  assert.deepEqual(info.paths,['straconischannel.flac','太郎 & Bob.flac']);assert.equal(info.mix,'2026-10-27 - mix w intro.flac');
  assert.ok(info.names.includes('straconischannel (uncut).flac'));assert.ok(!info.names.some(name=>/^(?:raw-)?track-\d+\./.test(name)));
  assert.equal(info.audio.straconischannel,'original lossless bytes: track-1.flac');assert.equal(info.raw,'original lossless bytes: raw-track-1.flac');
  assert.deepEqual(await fs.readFile(path.join(dir,'track-1.flac')),audio);assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'manifest.json'))),JSON.parse(JSON.stringify(manifest)));
  const before=(await fs.stat(path.join(dir,'project.zip'))).mtimeMs;assert.equal(await ensureSpeakerProjectZip(dir),false);assert.equal((await fs.stat(path.join(dir,'project.zip'))).mtimeMs,before);
  const replies=await Promise.all([fetch(url),fetch(url)]);for(const reply of replies)assert.deepEqual(Buffer.from(await reply.arrayBuffer()),await fs.readFile(downloaded));
  const mixURL=new URL(url);mixURL.pathname=mixURL.pathname.replace(/project.zip$/,'mix.flac');const mixReply=await fetch(mixURL);assert.equal(mixReply.headers.get('content-disposition'),'attachment; filename="2026-10-27 - mix w intro.flac"');await mixReply.text();
  const attachment=path.join(root,'attachment.zip');await fs.writeFile(attachment,await archiveExport(dir,1024*1024));assert.deepEqual(inspect(attachment).names,info.names);
  assert.ok(!(await fs.readdir(dir)).some(file=>file.startsWith('.speaker-project-')));
 }finally{await service?.close();await fs.rm(root,{recursive:true,force:true});}
});
test('ZIP64 legacy packages are upgraded without decoding audio and concurrent requests share one replacement',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-existing-zip64-'));
 try{const {dir,manifest}=await fixture(root,false);await fs.rm(path.join(dir,'project.zip'));
  await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify({...manifest,mix:undefined,tracks:manifest.tracks.map((t,i)=>({...t,username:'track-'+(i+1)})),rawTracks:manifest.rawTracks.map(t=>({...t,username:'original'}))}));
  await writeProjectZip(dir);await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify(manifest));
  assert.deepEqual(await Promise.all([ensureSpeakerProjectZip(dir),ensureSpeakerProjectZip(dir),ensureSpeakerProjectZip(dir)]),[true,true,true]);
  const info=inspect(path.join(dir,'project.zip'));assert.equal(info.mix,'2026-10-27 - mix.flac');assert.ok(info.names.includes('straconischannel.flac'));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('custom mix names override the automatic stem and retain the selected extension in ZIP and direct downloads',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-custom-mix-'));
 try{const {dir,manifest}=await fixture(root,true,'Finale 🌙.wav');await ensureSpeakerProjectZip(dir);const info=inspect(path.join(dir,'project.zip'));
  assert.equal(info.mix,'Finale 🌙.flac');assert.equal(downloadName('mix.flac',manifest,'date'),'Finale 🌙.flac');assert.equal(downloadName('mix.flac',manifest,'original'),'Finale 🌙.flac');
  assert.equal(mixedTrackName('mix.mp3',{startedAt:manifest.startedAt,intro:{}}),'2026-10-27 - mix w intro.mp3');
  assert.equal(mixedTrackName('mix.wav',{startedAt:manifest.startedAt,intro:{},mixHasIntro:false}),'2026-10-27 - mix.wav');
  assert.equal(validateMixName('   '),undefined);assert.equal(validateMixName(' CON.txt '),'CON_.txt');assert.throws(()=>validateMixName('x\r\ny'));assert.throws(()=>validateMixName('x'.repeat(121)));assert.throws(()=>validateMixName({}));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('missing speaker metadata refuses anonymous packaging and leaves the saved archive intact',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-missing-speaker-'));
 try{const {dir}=await fixture(root),old=await fs.readFile(path.join(dir,'project.zip'));await fs.writeFile(path.join(dir,'manifest.json'),'{"tracks":[]}');
  await assert.rejects(ensureSpeakerProjectZip(dir),/Speaker metadata is missing/);assert.deepEqual(await fs.readFile(path.join(dir,'project.zip')),old);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('mix filename overrides survive queue persistence, deduplication, restart, and retry',async()=>{
 const {ExportQueue}=require('../dist/exports/jobs'),root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-queued-mix-'));let queue,reloaded;
 try{await fs.mkdir(path.join(root,sid),{recursive:true});await fs.writeFile(path.join(root,sid,'session.json'),JSON.stringify({id:sid,guildID:'guild',channelID:'voice',startedAt:'2026-10-27T22:37:15.834Z',state:'completed',tracks:[{track:1,id:'speaker',username:'straconischannel'}]}));
  queue=new ExportQueue(root);await queue.load(false);
  const first=await queue.enqueue(sid,'guild','audition',true,{mixName:'Finale.flac'}),same=await queue.enqueue(sid,'guild','audition',true,{mixName:'Finale.flac'}),other=await queue.enqueue(sid,'guild','audition',true,{mixName:'Another mix'});
  assert.equal(first.id,same.id);assert.notEqual(first.id,other.id);assert.equal(first.mixName,'Finale.flac');
  await queue.cancel(first.id,'guild');const retry=await queue.retry(first.id,'guild');assert.equal(retry.mixName,'Finale.flac');
  await assert.rejects(queue.enqueue(sid,'guild','audition',true,{mixName:'bad\nname'}),/control characters/);
  await queue.close();queue.releaseIntroReferences();queue=undefined;
  reloaded=new ExportQueue(root);await reloaded.load(false);assert.equal(reloaded.get(retry.id).mixName,'Finale.flac');
 }finally{await queue?.close();queue?.releaseIntroReferences();await reloaded?.close();reloaded?.releaseIntroReferences();await fs.rm(root,{recursive:true,force:true});}
});

const test=require('node:test');const assert=require('node:assert/strict');const {mkdtemp,mkdir,readFile,writeFile,rm}=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const {spawnSync}=require('node:child_process');const {OpusEncoder}=require('@discordjs/opus');const {RecordingSession}=require('../dist/recording/session');const {exportSession}=require('../dist/exports/export');const {DownloadService}=require('../dist/downloads/service');const {SettingsStore}=require('../dist/storage/settings');const {ExportQueue}=require('../dist/exports/jobs');const {RecordingManager}=require('../dist/recording/manager');const {downloadName}=require('../dist/downloads/names');
test('Audition project ZIP contains valid XML, linked FLAC tracks and exact clip lengths',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-audition-'));
 try{const session=await RecordingSession.create(root,'guild','voice');const encoder=new OpusEncoder(48000,2),pcm=Buffer.alloc(3840);for(let frame=0;frame<20;frame++){await session.append(encoder.encode(pcm),'one','Alice & <friends>',frame*960,BigInt(frame*960),pcm);if(frame<15)await session.append(encoder.encode(pcm),'two','Bob',frame*960,BigInt(frame*960),pcm);}await session.close();const output=await exportSession(root,session.id,{format:'audition'});const manifest=JSON.parse(await readFile(path.join(output,'manifest.json')));assert.equal(manifest.format,'audition');assert.equal(manifest.project,'project.zip');
 const result=spawnSync('python3',['-c',`import zipfile,xml.etree.ElementTree as ET,sys
with zipfile.ZipFile(sys.argv[1]) as z:
 assert z.testzip() is None
 root=ET.fromstring(z.read('session.sesx'))
 tracks=root.findall('./session/tracks/audioTrack'); files=root.findall('./files/file')
 assert len(tracks)==2 and len(files)==2
 assert tracks[0].find('./trackParameters/name').text=='Alice & <friends>'
 assert root.find('session').get('duration')=='19200'
 for t,f in zip(tracks,files):
  clip=t.find('audioClip'); assert clip.get('fileID')==f.get('id'); assert clip.get('startPoint')=='0'
  assert f.get('relativePath').endswith('.flac')
  data=z.read(f.get('relativePath')); assert data[:4]==b'fLaC'
  packed=int.from_bytes(data[18:26],'big')
  assert packed>>44==48000 and ((packed>>41)&7)+1==2
  assert int(clip.get('endPoint'))==packed&0xfffffffff
 assert not any(name.endswith('.wav') for name in z.namelist())
`,path.join(output,'project.zip')],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('date naming persists, toggles without invalidating signed links, and leaves file bytes unchanged',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-names-')),settings=new SettingsStore(path.join(root,'settings.json')),queue=new ExportQueue(root),manager=new RecordingManager(root);let service;
 try{await settings.load();await settings.update('guild',{downloadNaming:'date'});const restarted=new SettingsStore(path.join(root,'settings.json'));await restarted.load();assert.equal(restarted.get('guild').downloadNaming,'date');
 const id='11111111-1111-4111-8111-111111111111',exp='export-22222222-2222-4222-8222-222222222222',directory=path.join(root,id,exp);await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'track-1.wav'),'audio');await writeFile(path.join(directory,'manifest.json'),JSON.stringify({sessionID:id,guildID:'guild',startedAt:'2026-09-30T22:45:12Z',format:'wav',tracks:[{file:'track-1.wav',username:'Alice'}]}));service=await DownloadService.create(root,'http://localhost');service.attach(queue,settings,manager);const port=await service.listen(0,'127.0.0.1'),base=service.link(id,exp).replace('http://localhost',`http://127.0.0.1:${port}`);const page=await (await fetch(base)).text();assert.ok(page.includes('names=original') && page.includes('Date + channel (UTC)'));assert.ok(page.includes('2026-09-30_22-45-12_UTC_Alice_track-1.wav'));
 const file=new URL(base);file.pathname+='/track-1.wav';const date=await fetch(file);assert.equal(date.headers.get('content-disposition'),'attachment; filename="2026-09-30_22-45-12_UTC_Alice_track-1.wav"');assert.equal(await date.text(),'audio');file.searchParams.set('names','original');const original=await fetch(file);assert.equal(original.headers.get('content-disposition'),'attachment; filename="track-1.wav"');assert.equal(await original.text(),'audio');
 const dashboard=service.dashboardLink('guild').replace('http://localhost',`http://127.0.0.1:${port}`);const saved=await fetch(dashboard,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'settings',autoJoin:false,autoRecord:false,downloadNaming:'original'})});assert.equal(saved.status,200);await saved.text();assert.equal(settings.get('guild').downloadNaming,'original');
 }finally{await service?.close();await queue.close();await manager.shutdown();await rm(root,{recursive:true,force:true});}
});
test('readable filenames sanitize names and distinguish clipped exports',()=>{
 const manifest={startedAt:'2026-09-30T22:45:12Z',tracks:[{file:'track-1.wav',username:'../../Alice\r\n"Bad'}],trim:{start:10,end:20}};const name=downloadName('track-1.wav',manifest,'date');assert.ok(!/[\/\\\r\n"]/.test(name));assert.ok(name.includes('clip-10-20'));assert.equal(downloadName('track-1.wav',{startedAt:'bad'},'date'),'track-1.wav');
});
test('Audition duration supports RF64 audio larger than four GiB without loading the media',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-rf64-'));let file;
 try{const {open}=require('node:fs/promises'),{writeAudition}=require('../dist/exports/audition'),bytes=0x100000000,header=Buffer.alloc(80);header.write('RF64');header.writeUInt32LE(0xffffffff,4);header.write('WAVE',8);header.write('ds64',12);header.writeUInt32LE(28,16);header.writeBigUInt64LE(BigInt(bytes+72),20);header.writeBigUInt64LE(BigInt(bytes),28);header.writeBigUInt64LE(BigInt(bytes/4),36);header.write('fmt ',48);header.writeUInt32LE(16,52);header.writeUInt16LE(1,56);header.writeUInt16LE(2,58);header.writeUInt32LE(48000,60);header.writeUInt32LE(192000,64);header.writeUInt16LE(4,68);header.writeUInt16LE(16,70);header.write('data',72);header.writeUInt32LE(0xffffffff,76);file=await open(path.join(root,'track-1.wav'),'wx');await file.write(header);await file.truncate(bytes+80);await file.close();file=undefined;await writeAudition(root,[{file:'track-1.wav',username:'Long session'}]);assert.ok((await readFile(path.join(root,'session.sesx'),'utf8')).includes('duration="1073741824"'));
 }finally{await file?.close();await rm(root,{recursive:true,force:true});}
});

const test=require('node:test'),assert=require('node:assert/strict');
const {mkdtemp,mkdir,writeFile,rm}=require('node:fs/promises');
const path=require('node:path'),os=require('node:os');
const {DownloadService}=require('../dist/downloads/service');
const {resolveAudioFormat}=require('../dist/exports/formats');
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
test('private recording page scopes exports to its signed recording and validates project tracks',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-panel-'));let service;const calls=[];
 try{await mkdir(path.join(root,id));await writeFile(path.join(root,id,'session.json'),JSON.stringify({id,guildID:'guild',channelID:'voice',title:'<script>title</script>',startedAt:'2026-10-01T00:00:00Z',state:'completed',tracks:[{track:1,id:'speaker',username:'name'}]}));
 service=await DownloadService.create(root,'https://example.com');service.attach({enqueue:async(...args)=>{calls.push(args);return {id:other};}}, {}, {});
 const port=await service.listen(0,'127.0.0.1'),local=url=>url.replace('https://example.com',`http://127.0.0.1:${port}`),link=local(service.recordingLink(id));
 const page=await fetch(link);assert.equal(page.status,200);const html=await page.text();assert.ok(html.includes('&lt;script&gt;title'));assert.ok(html.includes('Individual track format'));assert.ok(html.includes('value="wav"'));
 const post=data=>fetch(link,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.com'},body:JSON.stringify(data)});
 const exported=await post({session:other,guildID:'foreign',format:'audition',trackFormat:'wav'});assert.equal(exported.status,202);assert.ok((await exported.json()).url.includes('/job/'));assert.deepEqual(calls[0].slice(0,4),[id,'guild','audition',false]);assert.equal(calls[0][4].trackFormat,'wav');
 assert.equal((await post({format:'audition',trackFormat:'mp3'})).status,400);assert.equal(calls.length,1);
 assert.equal((await fetch(local(service.recordingLink(id,-1)))).status,403);
 const tampered=new URL(link);tampered.pathname='/recording/'+other;assert.equal((await fetch(tampered)).status,403);
 assert.equal((await fetch(link,{method:'POST',headers:{Origin:'https://foreign.example','Content-Type':'application/json'},body:'{}'})).status,403);
 }finally{await service?.close();await rm(root,{recursive:true,force:true});}
});
test('project track defaults and alternatives remain lossless',()=>{assert.equal(resolveAudioFormat('audition'),'flac');assert.equal(resolveAudioFormat('audacity'),'wav');assert.equal(resolveAudioFormat('audition','wav'),'wav');assert.equal(resolveAudioFormat('audacity','flac'),'flac');assert.throws(()=>resolveAudioFormat('mp3','wav'));});
test('Audition WAV and Audacity FLAC exports contain the selected audio and a project ZIP',async()=>{
 const {RecordingSession}=require('../dist/recording/session'),{OpusEncoder}=require('@discordjs/opus'),{exportSession}=require('../dist/exports/export'),{readFile}=require('node:fs/promises');
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-project-format-'));
 try{const session=await RecordingSession.create(root,'guild','voice'),encoder=new OpusEncoder(48000,2),pcm=Buffer.alloc(3840);
 for(let i=0;i<20;i++)await session.append(encoder.encode(pcm),'speaker','Speaker',i*960);await session.close();
 for(const [format,trackFormat] of [['audition','wav'],['audacity','flac']]){const directory=await exportSession(root,session.id,{format,trackFormat}),manifest=JSON.parse(await readFile(path.join(directory,'manifest.json')));assert.equal(manifest.trackFormat,trackFormat);assert.ok(manifest.tracks[0].file.endsWith('.'+trackFormat));const zip=await readFile(path.join(directory,'project.zip'));assert.equal(zip.subarray(0,2).toString(),'PK');if(format==='audacity')assert.ok(zip.includes(Buffer.from('session_data/'+manifest.tracks[0].file)));}
 }finally{await rm(root,{recursive:true,force:true});}
});

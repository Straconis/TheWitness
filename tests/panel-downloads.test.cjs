const test=require('node:test'),assert=require('node:assert/strict');
const {mkdtemp,mkdir,writeFile,rm}=require('node:fs/promises');
const path=require('node:path'),os=require('node:os');
const {DownloadService}=require('../dist/downloads/service');
const {resolveAudioFormat}=require('../dist/exports/formats');
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
test('private recording page scopes exports to its signed recording and validates project tracks',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-panel-'));let service;const calls=[];
 try{await mkdir(path.join(root,id));await writeFile(path.join(root,id,'session.json'),JSON.stringify({id,guildID:'guild',channelID:'voice',title:'<script>title</script>',startedAt:'2026-10-01T00:00:00Z',state:'completed',tracks:[{track:1,id:'speaker',username:'name'}]}));
 service=await DownloadService.create(root,'https://example.com');service.attach({enqueue:async(...args)=>{calls.push(args);return {id:other};}}, {get:()=>({autoJoin:false,autoRecord:false})}, {});
 const port=await service.listen(0,'127.0.0.1'),local=url=>url.replace('https://example.com',`http://127.0.0.1:${port}`),link=local(service.recordingLink(id));
 const page=await fetch(link);assert.equal(page.status,200);const html=await page.text();assert.ok(html.includes('&lt;script&gt;title'));assert.ok(html.includes('Individual recording file format inside project ZIPs'));assert.ok(html.includes('value="wav"'));assert.match(html,/id="target-lufs"[^>]*value="-16"/);assert.match(html,/id="max-true-peak"[^>]*value="-1"/);new (require('node:vm').Script)(/<script>([\s\S]*?)<\/script>/.exec(html)[1]);assert.ok(html.includes('Trim silence at the end'));assert.ok(html.includes('Clean up speech'));assert.ok(html.includes("cleanupAudio:document.querySelector('#cleanup-audio').checked"));assert.ok(html.includes('If a Sync cues track is present, uncheck it'));assert.ok(html.includes("trimEndSilence:document.querySelector('#end-silence').checked"));
 const post=data=>fetch(link,{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.com'},body:JSON.stringify(data)});
 const exported=await post({session:other,guildID:'foreign',format:'audition',trackFormat:'wav',targetLUFS:-23,maxTruePeakDBTP:-3,normalizeAudio:true,cleanupAudio:true,trimEndSilence:true,excludeFromMix:[]});assert.equal(exported.status,202);assert.ok((await exported.json()).url.includes('/job/'));assert.deepEqual(calls[0].slice(0,4),[id,'guild','audition',false]);assert.equal(calls[0][4].trackFormat,'wav');assert.equal(calls[0][4].targetLUFS,-23);assert.equal(calls[0][4].maxTruePeakDBTP,-3);assert.equal(calls[0][4].normalizeAudio,true);assert.equal(calls[0][4].cleanupAudio,true);assert.equal(calls[0][4].trimEndSilence,true);assert.deepEqual(calls[0][4].excludeFromMix,[]);
 assert.equal((await post({format:'audition',trackFormat:'mp3'})).status,400);assert.equal(calls.length,1);
 assert.equal((await fetch(local(service.recordingLink(id,-1)))).status,403);
 const expiredPost=await fetch(local(service.recordingLink(id,-1)),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({format:'audition'})});
 assert.equal(expiredPost.status,403);assert.match((await expiredPost.json()).error,/Open Downloads again/);
 const dashboardURL=new URL(local(service.dashboardLink('guild')));dashboardURL.searchParams.set('signature','0'.repeat(64));
 const expiredDashboard=await fetch(dashboardURL,{headers:{Accept:'application/json'}});
 assert.equal(expiredDashboard.status,403);assert.match((await expiredDashboard.json()).error,/new \/dashboard link/);
 // Use an expired recording URL for JSON GET requests too; authorization must run before data access.
 const expiredGet=await fetch(local(service.recordingLink(id,-1)),{headers:{Accept:'application/json'}});
 assert.equal(expiredGet.status,403);assert.match((await expiredGet.json()).error,/private link is invalid or expired/);

 const tampered=new URL(link);tampered.pathname='/recording/'+other;assert.equal((await fetch(tampered)).status,403);
 assert.equal((await fetch(link,{method:'POST',headers:{Origin:'https://foreign.example','Content-Type':'application/json'},body:'{}'})).status,403);
 }finally{await service?.close();await rm(root,{recursive:true,force:true});}
});
test('project track defaults and alternatives remain lossless',()=>{assert.equal(resolveAudioFormat('audition'),'flac');assert.equal(resolveAudioFormat('audacity'),'wav');assert.equal(resolveAudioFormat('audition','wav'),'wav');assert.equal(resolveAudioFormat('audacity','flac'),'flac');assert.throws(()=>resolveAudioFormat('mp3','wav'));});
test('Audition WAV and Audacity FLAC exports contain the selected audio and a project ZIP',async()=>{
 const {RecordingSession}=require('../dist/recording/session'),{OpusEncoder}=require('@discordjs/opus'),{exportSession}=require('../dist/exports/export'),{readFile}=require('node:fs/promises');
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-project-format-'));
 try{const session=await RecordingSession.create(root,'guild','voice'),encoder=new OpusEncoder(48000,2),pcm=Buffer.alloc(3840);
 for(let i=0;i<20;i++)await session.append(encoder.encode(pcm),'speaker','Speaker',i*960,BigInt(i*960+1));await session.close();
 for(const [format,trackFormat] of [['audition','wav'],['audacity','flac']]){const directory=await exportSession(root,session.id,{format,trackFormat}),manifest=JSON.parse(await readFile(path.join(directory,'manifest.json')));assert.equal(manifest.trackFormat,trackFormat);assert.ok(manifest.tracks[0].file.endsWith('.'+trackFormat));const zip=await readFile(path.join(directory,'project.zip'));assert.equal(zip.subarray(0,2).toString(),'PK');if(format==='audacity')assert.ok(zip.includes(Buffer.from('session.aup3')));}
 }finally{await rm(root,{recursive:true,force:true});}
});

test('two saved recordings keep distinct export jobs and expose the selected recording identity',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-session-routing-'));let service;
 const sessions=[{id,startedAt:'2026-10-20T22:33:44.608Z',channelName:'Lobby'},{id:other,startedAt:'2026-10-27T22:37:15.834Z',channelName:'Quests from the Infinite staircase'}];
 const jobs=new Map(),calls=[];
 try{
  for(const session of sessions){await mkdir(path.join(root,session.id));await writeFile(path.join(root,session.id,'session.json'),JSON.stringify({...session,guildID:'guild',channelID:'voice',state:'completed',tracks:[{track:1,id:'speaker',username:'Alice'}]}));}
  service=await DownloadService.create(root,'https://example.com');
  service.attach({enqueue:async(sessionID,guildID,format)=>{calls.push(sessionID);const job={id:sessionID,sessionID,guildID,format,state:'queued',stage:'Waiting'};jobs.set(job.id,job);return job;},get:key=>jobs.get(key),position:()=>1},{get:()=>({})},{});
  const port=await service.listen(0,'127.0.0.1'),local=url=>url.replace('https://example.com',`http://127.0.0.1:${port}`);
  for(const selected of sessions){
   const result=await fetch(local(service.recordingLink(selected.id)),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({format:'wav',sessionID:sessions.find(s=>s.id!==selected.id).id})});
   assert.equal(result.status,202);const {url}=await result.json();
   const status=await (await fetch(local(url),{headers:{Accept:'application/json'}})).json();
   assert.equal(status.recording.sessionID,selected.id);assert.equal(status.recording.startedAt,selected.startedAt);assert.equal(status.recording.channelName,selected.channelName);
   const html=await (await fetch(local(url))).text();new (require('node:vm').Script)(/<script>([\s\S]*?)<\/script>/.exec(html)[1]);assert.ok(html.includes('recording-summary'));
  }
  assert.deepEqual(calls,[id,other]);
 }finally{await service?.close();await rm(root,{recursive:true,force:true});}
});

const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {mkdtemp,writeFile,readFile,rm,utimes}=require('node:fs/promises');
const {uploadIntroChunk,getServerIntro,introPCM}=require('../dist/exports/server-intro');
const {RecordingSession}=require('../dist/recording/session'),{OpusEncoder}=require('@discordjs/opus');
const {ExportQueue}=require('../dist/exports/jobs'),{exportSession}=require('../dist/exports/export');
const {DownloadService}=require('../dist/downloads/service'),{SettingsStore}=require('../dist/storage/settings');
function wav(seconds=.2){const n=Math.round(seconds*48000),b=Buffer.alloc(44+n*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(192000,28);b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*4,40);for(let i=0;i<n;i++){const x=Math.round(2000*Math.sin(i*2*Math.PI*440/48000));b.writeInt16LE(x,44+i*4);b.writeInt16LE(x,46+i*4);}return b;}
const upload=(name,extra={})=>({index:0,final:true,bytes:wav().toString('base64'),name,...extra});
async function recording(root,guild,channel){const session=await RecordingSession.create(root,guild,channel),encoder=new OpusEncoder(48000,2);for(let i=0;i<20;i++)await session.append(encoder.encode(Buffer.alloc(3840)),'speaker','Speaker',i*960,BigInt(i*960),Buffer.alloc(3840));await session.close();return session;}

test('post-recording custom uploads and channel intros stay within their Discord and recording',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-custom-intro-'));let service,queue;
 try{
  const court=await recording(root,'court','court-voice'),other=await recording(root,'other','voice'),sibling=await recording(root,'other','another-voice');
  const theme=await uploadIntroChunk(root,'court',upload('Court of Dorks'));
  const settings=new SettingsStore(path.join(root,'settings.json'));await settings.load();queue=new ExportQueue(root);await queue.load(false);
  service=await DownloadService.create(root,'https://example.com');service.attach(queue,settings,{sessions:new Map()});service.setIntroChannels(guild=>guild==='other'?[{id:'voice',name:'Other voice'},{id:'another-voice',name:'Another voice'}]:[{id:'court-voice',name:'Court voice'}]);
  const port=await service.listen(0,'127.0.0.1'),local=url=>url.replace('https://example.com',`http://127.0.0.1:${port}`),link=session=>local(service.recordingLink(session.id));
  const post=(url,body)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const page=await (await fetch(link(other))).text();assert.ok(!page.includes('Court of Dorks'));assert.match(page,/Upload a custom intro/);new vm.Script(/<script>([\s\S]*?)<\/script>/.exec(page)[1]);
  assert.ok((await (await fetch(link(court))).text()).includes('Court of Dorks'));
  const forged=await post(link(other),{format:'wav',includeIntro:true,introID:theme.id,guildID:'court'});assert.equal(forged.status,400);await forged.text();
  const validCourt=await post(link(court),{format:'wav',includeIntro:true});assert.equal(validCourt.status,202);await validCourt.text();
  const uploaded=await post(link(other),{action:'upload-custom-intro',...upload('My intro')});assert.equal(uploaded.status,200);const custom=await uploaded.json();
  assert.equal(await getServerIntro(root,'other'),undefined);assert.equal((await getServerIntro(root,'court')).id,theme.id);
  assert.equal(await getServerIntro(root,'other',custom.id,sibling.id),undefined);
  const crossed=await post(link(sibling),{format:'wav',includeIntro:true,introScope:'recording',introID:custom.id});assert.equal(crossed.status,400);await crossed.text();
  const chosen=await post(link(other),{format:'wav',includeIntro:true,introScope:'recording',introID:custom.id});assert.equal(chosen.status,202);const jobID=new URL((await chosen.json()).url).pathname.split('/').pop();assert.equal(queue.get(jobID).introScope,'recording');
  const directory=await exportSession(root,other.id,{format:'wav',mix:true,introScope:'recording',introID:custom.id});const manifest=JSON.parse(await readFile(path.join(directory,'manifest.json')));assert.equal(manifest.intro.name,'My intro');assert.equal(manifest.tracks.length,2);
  const manager=local(service.dashboardLink('other',true)),ordinary=local(service.dashboardLink('other'));
  const adminPage=await (await fetch(manager)).text();assert.match(adminPage,/id="intro-channel"/);new vm.Script(/<script>([\s\S]*?)<\/script>/.exec(adminPage)[1]);
  const denied=await post(ordinary,{action:'upload-intro',channelID:'voice',...upload('Denied')});assert.equal(denied.status,403);await denied.text();
  const foreign=await post(manager,{action:'upload-intro',channelID:'court-voice',...upload('Wrong server')});assert.equal(foreign.status,400);await foreign.text();
  const assigned=await post(manager,{action:'upload-intro',channelID:'voice',...upload('Voice theme')});assert.equal(assigned.status,200);const channel=await assigned.json();
  const updated=await (await fetch(link(other))).text();assert.ok(updated.includes('Voice theme'));assert.ok(!(await (await fetch(link(sibling))).text()).includes('Voice theme'));
  assert.equal((await post(link(sibling),{format:'wav',includeIntro:true,introID:channel.id})).status,400);
  const withChannel=await queue.enqueue(other.id,'other','wav',false,{includeIntro:true});const output=await exportSession(root,other.id,{format:'wav',introID:withChannel.introID});assert.equal(JSON.parse(await readFile(path.join(output,'manifest.json'))).intro.name,'Voice theme');
  const readJSON=await (await fetch(local(service.dashboardLink('court')),{headers:{Accept:'application/json'}})).json();assert.equal(readJSON.intro,undefined);assert.equal(readJSON.introChannels,undefined);
  await queue.close();queue=new ExportQueue(root);await queue.load(false);assert.equal(queue.get(jobID).introScope,'recording');
 }finally{await service?.close();await queue?.close();await rm(root,{recursive:true,force:true});}
});

test('custom intro retention protects referenced files and reclaims expired unreferenced uploads',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-intro-retention-'));
 try{
  const session=await recording(root,'guild','voice'),result=await uploadIntroChunk(root,'guild',upload('Custom'),session.id),pcm=introPCM(root,'guild',result.id,session.id),json=pcm.replace(/\.pcm$/,'.json');
  const then=new Date(Date.now()-72*3600000);await utimes(pcm,then,then);await utimes(json,then,then);
  const {sweepArtifacts}=require('../dist/exports/storage');await sweepArtifacts(root,[],new Set([result.id]));assert.ok(await getServerIntro(root,'guild',result.id,session.id));
  await sweepArtifacts(root,[],new Set());assert.equal(await getServerIntro(root,'guild',result.id,session.id),undefined);await assert.rejects(readFile(pcm),{code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true});}
});

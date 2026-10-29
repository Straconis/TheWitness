const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, writeFile, readFile, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { downloadName } = require('../dist/downloads/names');
const { DownloadService } = require('../dist/downloads/service');
const { SettingsStore } = require('../dist/storage/settings');
const { RecordingSession } = require('../dist/recording/session');
const manifest = {startedAt:'2026-10-01T22:55:00-04:00',channelName:'#General Voice',channelID:'123',title:'A title',trim:{start:5,end:10},tracks:[]};
test('ZIP names are "date - server - channel" in UTC for both Discord and web base filenames',()=>{
 for(const file of ['witness-audition.zip','witness-wav.zip','project.zip']){
  assert.equal(downloadName(file,manifest,'date'),'2026-10-02 - #General Voice.zip');
  assert.equal(downloadName(file,{...manifest,guildName:'Court of Dorks'},'date'),'2026-10-02 - Court of Dorks - #General Voice.zip');
  assert.equal(downloadName(file,{...manifest,guildName:'Court of Dorks'},'date-channel'),'2026-10-02 - Court of Dorks - #General Voice.zip');
  assert.equal(downloadName(file,manifest,'original'),file);
 }
 assert.equal(downloadName('project.zip',{...manifest,guildName:'A/B: <Pod>?',channelName:'évil/"\r\nname.'},'date-channel'),'2026-10-02 - A_B - _Pod_ - évil_name.zip');
 assert.equal(downloadName('project.zip',{...manifest,guildID:'789',channelName:undefined},'date-channel'),'2026-10-02 - 789 - 123.zip');
 assert.equal(downloadName('project.zip',{startedAt:manifest.startedAt},'date-channel'),'2026-10-02.zip');
 assert.equal(downloadName('project.zip',{startedAt:'bad',guildName:'Server',channelName:'Voice'},'date'),'Server - Voice.zip');
 assert.equal(downloadName('project.zip',{startedAt:manifest.startedAt,guildName:'CON',channelName:'\u202egnp.exe'},'date'),'2026-10-02 - CON_ - _gnp.exe.zip');
 assert.equal(downloadName('project.zip',{startedAt:'bad'},'date'),'project.zip');
 assert.equal(downloadName('project.zip',{},'date'),'project.zip');
 assert.equal(downloadName('track-1.wav',manifest,'date'),'2026-10-02_02-55-00_UTC_A_title_clip-5-10_track-1.wav');
});
test('channel name is saved with recording metadata',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-channel-'));
 try{const session=await RecordingSession.create(root,'guild','123','General Voice');await session.close();
  assert.equal(JSON.parse(await readFile(path.join(session.directory,'session.json'),'utf8')).channelName,'General Voice');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('private web headers honor saved naming choice and per-link override',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-naming-'));let service;
 try{
  const id='11111111-1111-4111-8111-111111111111',exp='export-22222222-2222-4222-8222-222222222222';
  const dir=path.join(root,id,exp);await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'project.zip'),'zip');
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify({...manifest,guildID:'guild',format:'audition',project:'project.zip'}));
  const settings=new SettingsStore(path.join(root,'settings.json'));await settings.update('guild',{downloadNaming:'date-channel'});
  const restored=new SettingsStore(path.join(root,'settings.json'));await restored.load();assert.equal(restored.get('guild').downloadNaming,'date-channel');
  service=await DownloadService.create(root,'https://example.com');service.attach(undefined,restored);
  const port=await service.listen(0,'127.0.0.1');const page=new URL(service.link(id,exp).replace('https://example.com',`http://127.0.0.1:${port}`));
  const html=await (await fetch(page)).text();assert.ok(html.includes('Date + channel (UTC)'));assert.ok(html.includes('names=date-channel'));
  await writeFile(path.join(root,id,'session.json'),JSON.stringify({id,guildID:'guild',channelID:'456',startedAt:manifest.startedAt,state:'completed',tracks:[]}));
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify({...manifest,channelName:undefined,channelID:undefined,guildID:'guild',format:'audition',project:'project.zip'}));
  const file=new URL(page);file.pathname+='/project.zip';
  for(const [style,name] of [[null,'2026-10-02 - guild - 456.zip'],['date','2026-10-02 - guild - 456.zip'],['original','project.zip']]){
   if(style)file.searchParams.set('names',style);const response=await fetch(file);assert.equal(response.status,200);assert.equal(response.headers.get('content-disposition'),`attachment; filename="${name}"`);assert.equal(await response.text(),'zip');
  }
 }finally{await service?.close();await rm(root,{recursive:true,force:true});}
});

const {contentDisposition,packagedTrackNames,speakerLabels,safeFileStem}=require('../dist/downloads/names');
test('Content-Disposition keeps Unicode names via RFC 5987 with a safe ASCII fallback',()=>{
 assert.equal(contentDisposition('attachment','2026-10-02 - Guild - Voice.zip'),'attachment; filename="2026-10-02 - Guild - Voice.zip"');
 assert.equal(contentDisposition('attachment','2026-10-02 - Café 東京 - "Voice".zip'),`attachment; filename="2026-10-02 - Cafe __ - _Voice_.zip"; filename*=UTF-8''2026-10-02%20-%20Caf%C3%A9%20%E6%9D%B1%E4%BA%AC%20-%20%22Voice%22.zip`);
 assert.equal(contentDisposition('inline',"it's (1).wav"),`inline; filename="it's (1).wav"`);
});
test('speaker labels and ZIP member names keep speakers identifiable, unique and filesystem safe',()=>{
 const tracks=[{file:'track-1.flac',username:'Alice'},{file:'track-2.flac',username:'alice'},{file:'track-3.flac',username:'太郎/Taro: <mic>'},{file:'track-4.flac',username:'   '},{file:'track-5.flac',username:'mix'},{file:'track-6.flac',username:'Intro: Welcome'},{file:'track-7.flac',username:'A/B'},{file:'track-8.flac',username:'A_B'},{file:'track-9.flac',username:'nul'}];
 assert.deepEqual([...speakerLabels(tracks).values()],['Alice','alice (2)','太郎/Taro: <mic>','Speaker 4','mix','Intro: Welcome','A/B','A_B','nul']);
 const names=packagedTrackNames(tracks,[{file:'raw-track-1.flac',username:'Alice'},{file:'raw-track-2.flac',username:'Alice'}]);
 assert.deepEqual([...names.values()],['Alice.flac','alice (2).flac','太郎_Taro - _mic_.flac','Speaker 4.flac','mix (2).flac','Intro - Welcome.flac','A_B.flac','A_B (2).flac','nul_.flac','Alice (uncut).flac','Alice (2) (uncut).flac']);
 assert.equal(new Set([...names.values()].map(name=>name.toLowerCase())).size,names.size);
 assert.equal(safeFileStem('...','fallback'),'fallback');assert.equal(safeFileStem('x'.repeat(200),'f').length,80);assert.equal(safeFileStem('🎙️ Host','f'),'🎙️ Host');
});
test('individual downloads keep non-Latin, duplicate and uncut speaker names instead of generic track names',()=>{
 const named={...manifest,trim:undefined,title:undefined,tracks:[{file:'track-1.wav',username:'太郎'},{file:'track-2.wav',username:'Bob'},{file:'track-3.wav',username:'bob'}],rawTracks:[{file:'raw-track-1.flac',username:'太郎'}]};
 assert.equal(downloadName('track-1.wav',named,'date'),'太郎.wav');
 assert.equal(downloadName('track-3.wav',named,'date'),'bob (2).wav');
 assert.equal(downloadName('raw-track-1.flac',named,'date'),'太郎 (uncut).flac');
 assert.equal(downloadName('track-1.wav',named,'original'),'太郎.wav');
});
test('web downloads send Unicode server/channel ZIP names and use live Discord names for older recordings',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-naming-live-'));let service;
 try{
  const id='33333333-3333-4333-8333-333333333333',exp='export-44444444-4444-4444-8444-444444444444',dir=path.join(root,id,exp);await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'project.zip'),'zip');await writeFile(path.join(dir,'track-1.wav'),'wav');
  await writeFile(path.join(root,id,'session.json'),JSON.stringify({id,guildID:'guild',channelID:'456',startedAt:manifest.startedAt,state:'completed',tracks:[]}));
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify({startedAt:manifest.startedAt,sessionID:id,guildID:'guild',channelID:'456',format:'audition',project:'project.zip',tracks:[{file:'track-1.wav',username:'Zoë'}]}));
  service=await DownloadService.create(root,'https://example.com');service.setLiveNames((guildID,channelID)=>({guildName:guildID==='guild'?'Café Crew':undefined,channelName:channelID==='456'?'Lounge':undefined}));
  const port=await service.listen(0,'127.0.0.1');const page=new URL(service.link(id,exp).replace('https://example.com',`http://127.0.0.1:${port}`));
  const zip=new URL(page);zip.pathname+='/project.zip';
  assert.equal((await fetch(zip)).headers.get('content-disposition'),`attachment; filename="2026-10-02 - Cafe Crew - Lounge.zip"; filename*=UTF-8''2026-10-02%20-%20Caf%C3%A9%20Crew%20-%20Lounge.zip`);
  const track=new URL(page);track.pathname+='/track-1.wav';
  assert.equal((await fetch(track)).headers.get('content-disposition'),`attachment; filename="Zoe.wav"; filename*=UTF-8''Zo%C3%AB.wav`);
 }finally{await service?.close();await rm(root,{recursive:true,force:true});}
});

test('emoji truncation preserves valid Unicode in individual download headers',()=>{
 const username='😀'.repeat(23)+'a😀';
 const file=downloadName('track-1.wav',{startedAt:manifest.startedAt,tracks:[{file:'track-1.wav',username}]},'date');
 assert.equal(file,username+'.wav');
 assert.doesNotThrow(()=>contentDisposition('attachment',file));
 const long='😀'.repeat(81),truncated=downloadName('track-1.wav',{startedAt:manifest.startedAt,tracks:[{file:'track-1.wav',username:long}]},'date');
 assert.equal(truncated,'😀'.repeat(50)+'.wav');assert.ok(Buffer.byteLength(truncated)<=255);
 assert.doesNotThrow(()=>contentDisposition('attachment',truncated));
});
test('reserved Windows basenames remain safe when a speaker includes dots',()=>{
 for(const name of ['CON.txt','nul.backup','LPT1.notes','COM¹.audio']){
  const dot=name.indexOf('.');assert.equal(safeFileStem(name,'speaker'),name.slice(0,dot)+'_'+name.slice(dot));
 }
 assert.equal(safeFileStem('Console.txt','speaker'),'Console.txt');
});
test('generated speaker labels cannot collide with literal numbered display names',()=>{
 const tracks=['Alice','Alice','Alice (2)','alice'].map((username,index)=>({username,file:`track-${index+1}.wav`}));
 assert.deepEqual([...speakerLabels(tracks).values()],['Alice','Alice (2)','Alice (2) (2)','alice (3)']);
 assert.equal(new Set([...speakerLabels(tracks).values()].map(name=>name.toLowerCase())).size,tracks.length);
});

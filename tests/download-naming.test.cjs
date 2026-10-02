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
test('ZIP names use UTC recording date for both Discord and web base filenames',()=>{
 for(const file of ['witness-audition.zip','witness-wav.zip','project.zip']){
  assert.equal(downloadName(file,manifest,'date'),'2026-10-02.zip');
  assert.equal(downloadName(file,manifest,'date-channel'),'2026-10-02-General-Voice.zip');
  assert.equal(downloadName(file,manifest,'original'),file);
 }
 assert.equal(downloadName('project.zip',{...manifest,channelName:'évil/"\r\nname'},'date-channel'),'2026-10-02-evil-name.zip');
 assert.equal(downloadName('project.zip',{...manifest,channelName:undefined},'date-channel'),'2026-10-02-123.zip');
 assert.equal(downloadName('project.zip',{startedAt:manifest.startedAt},'date-channel'),'2026-10-02.zip');
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
  await writeFile(path.join(root,id,'session.json'),JSON.stringify({id,guildID:'guild',channelID:'456',startedAt:manifest.startedAt}));
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify({...manifest,channelName:undefined,channelID:undefined,guildID:'guild',format:'audition',project:'project.zip'}));
  const file=new URL(page);file.pathname+='/project.zip';
  for(const [style,name] of [[null,'2026-10-02-456.zip'],['date','2026-10-02.zip'],['original','project.zip']]){
   if(style)file.searchParams.set('names',style);const response=await fetch(file);assert.equal(response.status,200);assert.equal(response.headers.get('content-disposition'),`attachment; filename="${name}"`);assert.equal(await response.text(),'zip');
  }
 }finally{await service?.close();await rm(root,{recursive:true,force:true});}
});

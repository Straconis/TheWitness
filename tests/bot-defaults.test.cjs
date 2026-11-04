const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {mkdtemp,rm,writeFile}=require('node:fs/promises');
const {BotDefaultsStore,botDefaults,recordingHours}=require('../dist/storage/bot-defaults'),{SettingsStore}=require('../dist/storage/settings'),{silenceSeconds}=require('../dist/exports/silence');
const {DownloadService}=require('../dist/downloads/service'),{BotStatusStore}=require('../dist/discord/bot-status');
const {recordingPage}=require('../dist/downloads/recording-page'),{landingPage}=require('../dist/downloads/landing-page'),{helpMessage}=require('../dist/discord/help');
const help=topic=>helpMessage(topic,{downloads:true,restricted:false}).embeds[0].description;
const session={id:'session',channelID:'voice',startedAt:'2026-10-02T00:00:00Z',tracks:[]};
test('defaults start at 10 second silence trim and persist owner changes across restarts',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-defaults-'));
 try{
  const store=new BotDefaultsStore(root);await store.load();
  assert.deepEqual(botDefaults(),{silenceSeconds:10,recordingDefaultHours:8,recordingMaxHours:24});assert.equal(silenceSeconds(),10);assert.match(recordingPage(session,true),/id="silence-seconds"[^>]*value="10"/);assert.match(help('exports'),/Threshold: 10 seconds/);
  await store.save({silenceSeconds:45,recordingDefaultHours:4,recordingMaxHours:12});
  await new BotDefaultsStore(root).load();assert.equal(botDefaults().silenceSeconds,45);assert.equal(silenceSeconds(),45);assert.match(recordingPage(session,true),/id="silence-seconds"[^>]*value="45"/);
  assert.match(help('exports'),/Threshold: 45 seconds/);assert.match(help('recording'),/4 hours by default/);assert.match(help('recording'),/\(2, 4, 6, 8, or 12 hours\)/);
  const landing=landingPage({demo:false,sample:false},'https://example.com');assert.match(landing,/Records 4 hours by default/);assert.match(landing,/4 hours by default, up to 12/);
  assert.equal(recordingHours(),4);assert.equal(recordingHours(6),6);assert.equal(recordingHours(24),12);
  for(const bad of [{silenceSeconds:0},{silenceSeconds:'10'},{recordingDefaultHours:5},{recordingMaxHours:48},{recordingDefaultHours:16}])await assert.rejects(store.save(bad),/Silence length|Recording maximum|longer than/);
  assert.equal(botDefaults().silenceSeconds,45);
  await writeFile(path.join(root,'bot-defaults.json'),JSON.stringify({silenceSeconds:20}));await store.load();assert.deepEqual(botDefaults(),{silenceSeconds:20,recordingDefaultHours:8,recordingMaxHours:24});
 }finally{await new BotDefaultsStore(path.join(root,'missing')).load();await rm(root,{recursive:true,force:true});}
});
test('the owner page shows and saves defaults',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-defaults-admin-'));let service;
 try{
  const settings=new SettingsStore(path.join(root,'settings.json'));await settings.load();const status=new BotStatusStore(path.join(root,'bot-status.json'));await status.load();
  service=await DownloadService.create(root,'https://example.com');service.attach({},settings,{sessions:new Map()});service.setOwnerAdmin(status,()=>{});
  const port=await service.listen(0,'127.0.0.1'),url=service.adminLink().replace('https://example.com',`http://127.0.0.1:${port}`);
  assert.match(await(await fetch(url)).text(),/<section id="defaults"><h2>Defaults<\/h2>[\s\S]*id="default-silence"[^>]*value="10"/);
  const post=value=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'bot-defaults',...value})});
  assert.equal((await post({silenceSeconds:-1,recordingDefaultHours:8,recordingMaxHours:24})).status,400);
  assert.equal((await post({silenceSeconds:15,recordingDefaultHours:6,recordingMaxHours:16})).status,200);
  assert.deepEqual(botDefaults(),{silenceSeconds:15,recordingDefaultHours:6,recordingMaxHours:16});assert.match(await(await fetch(url)).text(),/id="default-silence"[^>]*value="15"/);
 }finally{await service?.close();await new BotDefaultsStore(path.join(root,'missing')).load();await rm(root,{recursive:true,force:true});}
});

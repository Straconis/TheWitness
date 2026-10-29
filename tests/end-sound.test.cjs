const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto'),{EventEmitter}=require('node:events');
const sound=require('../dist/exports/start-sound'),{SettingsStore}=require('../dist/storage/settings'),{DownloadService}=require('../dist/downloads/service'),{RecordingManager}=require('../dist/recording/manager');
test('end sound is custom/off, scoped to its server, and waits for playback to end',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-end-sound-'));try{
 const settings=new SettingsStore(path.join(root,'settings.json'));await settings.load();await assert.rejects(settings.update('guild',{endSound:{mode:'default'}}));await assert.rejects(settings.update('guild',{endSound:{mode:'custom'}}));
 const id=randomUUID();await fs.mkdir(sound.startSoundDirectory(root,'guild'),{recursive:true});await fs.copyFile(sound.bundledStartSound,sound.startSoundPath(root,'guild',id));await settings.update('guild',{endSound:{mode:'custom',customID:id}});const reload=new SettingsStore(path.join(root,'settings.json'));await reload.load();assert.equal(reload.get('guild').endSound.customID,id);
 const connection=new EventEmitter();let played=0,finished=false;connection.play=()=>{played++;setTimeout(()=>connection.emit('end'),20);};
 await sound.playEndSound(connection,root,'guild',undefined,true);await sound.playEndSound(connection,root,'guild',{mode:'off'},true);await sound.playEndSound(connection,root,'guild',settings.get('guild').endSound,false);assert.equal(played,0);
 const pending=sound.playEndSound(connection,root,'guild',settings.get('guild').endSound,true).then(()=>finished=true);assert.equal(finished,false);await pending;assert.equal(played,1);assert.equal(connection.listenerCount('end'),0);assert.equal(connection.listenerCount('error'),0);
 await assert.rejects(sound.playEndSound(connection,root,'other',settings.get('guild').endSound,true));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('recording capture is closed before the end notice, and failures and shutdown skip the notice',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-end-order-'));const manager=new RecordingManager(root);try{let notices=0;const guild={id:'guild',channels:new Map(),members:new Map()},connection=new EventEmitter(),receiver=new EventEmitter();connection.receive=()=>receiver;
 manager.onStopped=async session=>{assert.equal(session.state,'completed');assert.equal(receiver.listenerCount('data'),0);notices++;};
 await manager.start(guild,'voice',connection);await manager.stop('guild');assert.equal(notices,1);
 await manager.start(guild,'voice',connection);await assert.rejects(manager.stop('guild',Error('capture failed')),/capture failed/);assert.equal(notices,1);
 await manager.start(guild,'voice',connection);await manager.shutdown();assert.equal(notices,1);
 }finally{await manager.shutdown();await fs.rm(root,{recursive:true,force:true});}
});
test('end sound settings and uploads require a manager dashboard capability',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-end-web-'));let service;try{const settings=new SettingsStore(path.join(root,'settings.json'));service=await DownloadService.create(root,'https://example.com');service.attach({},settings,{sessions:new Map()});const port=await service.listen(0,'127.0.0.1'),local=url=>url.replace('https://example.com',`http://127.0.0.1:${port}`),reader=local(service.dashboardLink('guild')),manager=local(service.dashboardLink('guild',true));
 const post=(url,body)=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 for(const action of ['upload-end-sound','end-sound-mode'])assert.equal((await post(reader,{action,mode:'off'})).status,403);
 assert.equal((await post(manager,{action:'end-sound-mode',mode:'custom'})).status,400);
 const bytes=await fs.readFile(sound.bundledStartSound),uploaded=await post(manager,{action:'upload-end-sound',index:0,final:true,bytes:bytes.toString('base64'),name:'End notice.ogg'});assert.equal(uploaded.status,200);const result=await uploaded.json();assert.equal(settings.get('guild').endSound.mode,'off');assert.equal(settings.get('guild').startSound,undefined);
 assert.equal((await post(manager,{action:'end-sound-mode',mode:'custom'})).status,200);const data=await(await fetch(manager,{headers:{Accept:'application/json'}})).json();assert.equal(data.endSound.custom.id,result.id);assert.equal(data.endSound.mode,'custom');assert.equal((await fetch(local(data.endSound.previewURL))).status,200);assert.equal((await fetch(reader+'&preview-start-sound='+result.id)).status,403);
 const html=await(await fetch(manager)).text();assert.match(html,/Recording end sound/);new(require('node:vm').Script)(/<script>([\s\S]*?)<\/script>/.exec(html)[1]);
 }finally{await service?.close();await fs.rm(root,{recursive:true,force:true});}
});

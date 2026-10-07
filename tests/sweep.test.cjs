const test=require('node:test');const assert=require('node:assert/strict');
const {mkdtemp,mkdir,readFile,writeFile,rm}=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {EventEmitter,once}=require('node:events');
const {WebSocket}=require('ws');const {DownloadService}=require('../dist/downloads/service');const {RecordingManager}=require('../dist/recording/manager');const {SettingsStore}=require('../dist/storage/settings');const {ExportQueue}=require('../dist/exports/jobs');
const wait=async(predicate)=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('Timed out');};
function connection(){const receiver=new EventEmitter(),voice=new EventEmitter();voice.receive=()=>receiver;voice.disconnect=()=>{};return {voice,receiver};}

test('voice reconnection preserves the session and resumes capture',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-reconnect-'));const manager=new RecordingManager(root,[0,0,0]);
 try{const first=connection(),second=connection(),guild={id:'guild',members:new Map()};let attempts=0;
  const session=await manager.start(guild,'voice',first.voice,async()=>{attempts++;if(attempts===1)throw Error('temporary failure');return second.voice;});
  first.receiver.emit('data',Buffer.from([0xf8,0xff,0xfe]),'alice',100);
  first.voice.emit('disconnect',Error('network lost'));
  await wait(()=>second.receiver.listenerCount('data')===1);assert.equal(manager.sessions.get('guild'),session);assert.equal(session.voiceState,'connected');
  second.receiver.emit('data',Buffer.from([0xf8,0xff,0xfe]),'alice',1060);
  await manager.exclusive('guild',()=>manager.stop('guild'));assert.equal(session.packets,2);assert.equal(session.state,'completed');
 }finally{await manager.shutdown();await rm(root,{recursive:true,force:true});}
});

test('browser frames become speaker tracks; dashboard and export queue work together',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-browser-'));const manager=new RecordingManager(root),queue=new ExportQueue(root),settings=new SettingsStore(path.join(root,'settings.json'));let service;
 try{
  await settings.load();await queue.load();service=await DownloadService.create(root,'http://localhost');service.attach(queue,settings,manager,new (require('../dist/storage/space').StorageMonitor)(root));const port=await service.listen(0,'127.0.0.1');
  const local=url=>url.replace('http://localhost',`http://127.0.0.1:${port}`);
  const {voice}=connection();const session=await manager.start({id:'guild',members:new Map()},'voice',voice);
  const browser=local(service.browserLink(session.id));const page=await fetch(browser);assert.equal(page.status,200);assert.ok((await page.text()).includes('AudioWorklet'));
  const ws=new WebSocket(browser.replace('http:','ws:')+'&name=BrowserUser');await once(ws,'open');
  const packet=Buffer.alloc(1924);for(let i=0;i<960;i++)packet.writeInt16LE(Math.round(Math.sin(i*2*Math.PI*440/48000)*5000),4+i*2);ws.send(packet);
  await wait(()=>session.packets===1);assert.ok([...session.tracks.values()][0].id.startsWith('browser-'));
  ws.close();await once(ws,'close');await manager.exclusive('guild',()=>manager.stop('guild'));
  const dashboard=local(service.dashboardLink('guild',true));
  const state=await (await fetch(dashboard,{headers:{Accept:'application/json'}})).json();assert.equal(state.sessions.length,1);assert.ok(state.storage.availableBytes>=0);
  const named=await fetch(dashboard,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'title',session:session.id,title:'Session from dashboard'})});assert.equal(named.status,200);await named.text();assert.equal(JSON.parse(await readFile(path.join(session.directory,'session.json'))).title,'Session from dashboard');
  const saved=await fetch(dashboard,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'settings',autoJoin:false,autoRecord:true})});assert.equal(saved.status,200);await saved.text();assert.equal(settings.get('guild').autoJoin,true);
  const badOrigin=await fetch(dashboard,{method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:'{}'});assert.equal(badOrigin.status,403);await badOrigin.text();
  const job=await queue.enqueue(session.id,'guild','ogg');await wait(()=>queue.get(job.id)?.state==='completed');
  const status=await (await fetch(local(service.jobLink(job.id)),{headers:{Accept:'application/json'}})).json();assert.equal(status.state,'completed');assert.ok(status.url.includes('/download/'));
  const expired=await fetch(browser);assert.equal(expired.status,404);await expired.text();
  await queue.close();const restarted=new ExportQueue(root);await restarted.load();assert.equal(restarted.get(job.id).state,'completed');await restarted.close();
 }finally{await service?.close();await manager.shutdown();await queue.close();await rm(root,{recursive:true,force:true});}
});

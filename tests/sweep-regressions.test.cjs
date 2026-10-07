const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),net=require('node:net');
const {DownloadService}=require('../dist/downloads/service'),{RecordingSession}=require('../dist/recording/session');
const {getSession,listSessions}=require('../dist/storage/sessions');
const {uploadIntroChunk}=require('../dist/exports/server-intro');
test('malformed unauthenticated WebSocket upgrades are rejected without stopping the web service',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-upgrade-check-'));let service;
 try{service=await DownloadService.create(root,'http://localhost');const port=await service.listen(0,'127.0.0.1');
 const reply=await new Promise((resolve,reject)=>{let body='';const socket=net.connect(port,'127.0.0.1',()=>socket.write('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'));socket.setTimeout(2000,()=>socket.destroy(Error('Timeout')));socket.on('error',reject);socket.on('data',chunk=>body+=chunk);socket.on('end',()=>resolve(body));});
 assert.match(reply,/400 Bad Request/);assert.equal((await fetch('http://127.0.0.1:'+port+'/invite')).status,200);
 }finally{await service?.close();await fs.rm(root,{recursive:true,force:true});}
});
test('damaged session metadata cannot break the recording list or reach export/delete consumers',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-metadata-check-'));
 try{const good=await RecordingSession.create(root,'guild','voice');await good.close();const bad=await RecordingSession.create(root,'guild','voice');await bad.close();const file=path.join(bad.directory,'session.json'),base=JSON.parse(await fs.readFile(file));
 for(const change of [{startedAt:123},{startedAt:'invalid'},{tracks:null},{tracks:[null]},{tracks:[{track:1,id:'user',username:7}]}]){await fs.writeFile(file,JSON.stringify({...base,...change}));await assert.rejects(getSession(root,bad.id,'guild'),/metadata is damaged/);assert.deepEqual((await listSessions(root,'guild')).map(s=>s.id),[good.id]);}
 assert.ok((await fs.stat(bad.directory)).isDirectory(),'damaged recordings remain on disk');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('rejected final intro uploads remove their chunks and preserve the current intro',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-intro-cleanup-'));
 try{const first=await uploadIntroChunk(root,'guild',{index:0,bytes:Buffer.from('bad format').toString('base64')});const dirs=await fs.readdir(path.join(root,'server-intros'));const dir=path.join(root,'server-intros',dirs[0]);const current=JSON.stringify({id:'11111111-1111-4111-8111-111111111111',name:'Existing intro',seconds:1});await fs.writeFile(path.join(dir,'current.json'),current);await assert.rejects(uploadIntroChunk(root,'guild',{id:first.id,index:1,bytes:Buffer.from('still bad').toString('base64'),final:true}),/Upload a WAV/);
 assert.equal(await fs.readFile(path.join(dir,'current.json'),'utf8'),current);assert.ok(!(await fs.readdir(dir)).some(name=>name.startsWith('upload-')));
 const missing=await uploadIntroChunk(root,'guild',{index:0,bytes:Buffer.from('another bad').toString('base64')});await assert.rejects(uploadIntroChunk(root,'guild',{id:missing.id,index:2,bytes:Buffer.from('last').toString('base64'),final:true}),/ENOENT/);assert.ok(!(await fs.readdir(dir)).some(name=>name.startsWith('upload-')));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('processed export excerpts cannot silently use offsets from the original timeline',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-excerpt-check-'));let service;
 try{const session=await RecordingSession.create(root,'guild','voice');await session.close();const name='export-11111111-1111-4111-8111-111111111111',dir=path.join(session.directory,name);await fs.mkdir(dir);
 let queued=0;service=await DownloadService.create(root,'http://localhost');service.attach({enqueue:async()=>{queued++;return {id:'22222222-2222-4222-8222-222222222222'};}},undefined,undefined);
 const port=await service.listen(0,'127.0.0.1'),link=new URL(service.link(session.id,name));link.host='127.0.0.1:'+port;
 for(const change of [{intro:{seconds:5}},{silenceCuts:[{start:1,end:3}]},{trailingSilenceCut:{start:5,end:10}},{edits:{tracks:[]}}]){
 await fs.writeFile(path.join(dir,'manifest.json'),JSON.stringify({sessionID:session.id,guildID:'guild',tracks:[],format:'wav',...change}));
 const response=await fetch(link,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({start:2,end:4})});assert.equal(response.status,400);assert.match((await response.json()).error,/multitrack editor/);
 const html=await (await fetch(link)).text();assert.ok(!html.includes('<h2>Export an excerpt'));assert.match(html,/timeline changes/);
 }
 assert.equal(queued,0);
 }finally{await service?.close();await fs.rm(root,{recursive:true,force:true});}
});

test('two servers record independently while one exports and the other queues an export',async()=>{
 const {EventEmitter}=require('node:events'),{RecordingManager}=require('../dist/recording/manager'),{ExportQueue}=require('../dist/exports/jobs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-multi-server-')),manager=new RecordingManager(root);let queue,release;
 const until=async predicate=>{const deadline=Date.now()+10000;while(!predicate()){if(Date.now()>deadline)throw Error('Timeout');await new Promise(r=>setTimeout(r,10));}};
 const voice=()=>{const receiver=new EventEmitter(),connection=new EventEmitter();connection.receive=()=>receiver;return {receiver,connection};};
 try{const a=voice(),b=voice();const [one,two]=await Promise.all([manager.exclusive('a',()=>manager.start({id:'a',members:new Map()},'voice-a',a.connection)),manager.exclusive('b',()=>manager.start({id:'b',members:new Map()},'voice-b',b.connection))]);assert.notEqual(one.id,two.id);
 const packet=Buffer.from([0xf8,0xff,0xfe]);a.receiver.emit('data',packet,'alice',0);b.receiver.emit('data',packet,'bob',0);
 await manager.exclusive('a',()=>manager.stop('a'));assert.equal(two.state,'recording');assert.equal(manager.sessions.get('b'),two);
 queue=new ExportQueue(root,async(_root,id)=>{if(id===one.id)await new Promise(resolve=>release=resolve);return path.join(root,id,'export-11111111-1111-4111-8111-111111111111');});await queue.load();const first=await queue.enqueue(one.id,'a','wav');await until(()=>release);
 b.receiver.emit('data',packet,'bob',960);await manager.exclusive('b',()=>manager.stop('b'));assert.equal(two.packets,2);assert.equal(one.packets,1);assert.equal(one.tracks.has('bob'),false);assert.equal(two.tracks.has('alice'),false);
 const second=await queue.enqueue(two.id,'b','wav');assert.equal(queue.position(second.id),1);await assert.rejects(queue.cancel(first.id,'b'),/not found/);await assert.rejects(getSession(root,one.id,'b'),/not found/);
 release();await until(()=>first.state==='completed'&&second.state==='completed');assert.equal(manager.sessions.size,0);
 }finally{release?.();await manager.shutdown();await queue?.close();await fs.rm(root,{recursive:true,force:true});}
});

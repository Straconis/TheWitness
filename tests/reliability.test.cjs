const test=require('node:test');const assert=require('node:assert/strict');const {mkdtemp,mkdir,readFile,writeFile,rm,readdir}=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const {EventEmitter}=require('node:events');const {randomUUID}=require('node:crypto');
const {RecordingManager}=require('../dist/recording/manager');const {RecordingSession}=require('../dist/recording/session');const {ExportQueue}=require('../dist/exports/jobs');
function voice(){const receiver=new EventEmitter(),connection=new EventEmitter();connection.receive=()=>receiver;connection.disconnect=()=>{};return {connection,receiver};}
async function until(predicate){for(let i=0;i<200;i++){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out');}
for(const shutdown of [false,true])test(`queued reconnect is cancelled before its lock starts (${shutdown?'shutdown':'stop'})`,async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-cancel-')),manager=new RecordingManager(root,[0]);
 try{const first=voice();let attempts=0;const session=await manager.start({id:'guild',members:new Map()},'voice',first.connection,async()=>{attempts++;return voice().connection;});let release;const blocker=manager.exclusive('guild',()=>new Promise(r=>release=r));await until(()=>release);
 first.connection.emit('disconnect');assert.equal(session.voiceState,'reconnecting');manager.cancelReconnect('guild');const stopped=shutdown?manager.shutdown():manager.exclusive('guild',()=>manager.stop('guild'));release();await blocker;await stopped;assert.equal(attempts,0);assert.equal(manager.sessions.size,0);assert.equal(session.state,'completed');
 }finally{await manager.shutdown();await rm(root,{recursive:true,force:true});}
});
test('concurrent duplicate export submissions share one persistent job',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-dedupe-'));const queue=new ExportQueue(root);
 try{const session=await RecordingSession.create(root,'guild','voice');for(let i=0;i<20;i++)await session.append(Buffer.from([0xf8,0xff,0xfe]),'user','User',i*960,BigInt(i*960));await session.close();await queue.load();
 const jobs=await Promise.all(Array.from({length:12},()=>queue.enqueue(session.id,'guild','wav')));assert.equal(new Set(jobs.map(job=>job.id)).size,1);await until(()=>queue.get(jobs[0].id)?.state==='completed');assert.equal((await readdir(path.join(root,'jobs'))).filter(name=>name.endsWith('.json')).length,1);
 }finally{await queue.close();await rm(root,{recursive:true,force:true});}
});
test('restart resumes an interrupted export despite unrelated corrupted job metadata',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-jobs-'));const queue=new ExportQueue(root);
 try{const session=await RecordingSession.create(root,'guild','voice');for(let i=0;i<20;i++)await session.append(Buffer.from([0xf8,0xff,0xfe]),'user','User',i*960,BigInt(i*960));await session.close();await mkdir(path.join(root,'jobs'));const id=randomUUID(),bad=randomUUID();await writeFile(path.join(root,'jobs',id+'.json'),JSON.stringify({id,sessionID:session.id,guildID:'guild',format:'ogg',mix:false,state:'running',createdAt:new Date().toISOString()}));await writeFile(path.join(root,'jobs',bad+'.json'),'{truncated');
 await queue.load();await until(()=>queue.get(id)?.state==='completed');assert.equal(await readFile(path.join(root,'jobs',bad+'.json'),'utf8'),'{truncated');assert.equal(JSON.parse(await readFile(path.join(root,'jobs',id+'.json'))).state,'completed');
 }finally{await queue.close();await rm(root,{recursive:true,force:true});}
});
test('audio captured at sample zero is not mistaken for an Ogg header during export',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-zero-'));
 try{const session=await RecordingSession.create(root,'guild','voice');for(let frame=0;frame<50;frame++)for(const user of ['one','two'])await session.append(Buffer.from([0xf8,0xff,0xfe]),user,user,frame*960,BigInt(frame*960));await session.close();const {exportSession}=require('../dist/exports/export');const {spawnSync}=require('node:child_process');const directory=await exportSession(root,session.id,{format:'wav'});
 for(const track of [1,2]){const decoded=spawnSync(path.resolve(__dirname,'../bin/ffmpeg'),['-v','error','-i',path.join(directory,`track-${track}.wav`),'-f','s16le','-']);assert.equal(decoded.status,0,decoded.stderr.toString());assert.ok(decoded.stdout.length>=0.8*48000*4,'One second of capture retains audio after Opus pre-skip');}
 }finally{await rm(root,{recursive:true,force:true});}
});

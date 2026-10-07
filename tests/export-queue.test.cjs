const test=require('node:test'),assert=require('node:assert/strict');const {mkdtemp,rm}=require('node:fs/promises');const os=require('node:os'),path=require('node:path');const {RecordingSession}=require('../dist/recording/session');const {ExportQueue,exportConcurrency}=require('../dist/exports/jobs');
const until=async fn=>{for(let i=0;i<300;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timeout');};
async function recording(root,guild){const session=await RecordingSession.create(root,guild,'voice');for(let i=0;i<5;i++)await session.append(Buffer.from([0xf8,0xff,0xfe]),'user','User',i*960,BigInt(i*960+1));await session.close();return session.id;}
function gatedExporter(started){const gates=new Map();return {release:async id=>{await until(()=>gates.has(id));gates.get(id)();},exporter:async(root,id)=>{started.push(id);await new Promise(resolve=>gates.set(id,resolve));return path.join(root,id,'export-00000000-0000-4000-8000-000000000000');}};}
test('exports from several servers wait in order with Craig-style queue positions',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'witness-export-queue-'));let queue;try{
 const a=await recording(root,'guild-a'),b=await recording(root,'guild-b'),c=await recording(root,'guild-c');const started=[];const gate=gatedExporter(started);
 queue=new ExportQueue(root,gate.exporter,undefined,1);await queue.load();
 const first=await queue.enqueue(a,'guild-a','wav');await until(()=>first.state==='running');
 const second=await queue.enqueue(b,'guild-b','wav'),third=await queue.enqueue(c,'guild-c','wav');
 assert.equal(queue.position(first.id),undefined);assert.equal(queue.position(second.id),1);assert.equal(queue.position(third.id),2);
 await gate.release(a);await until(()=>second.state==='running');assert.equal(first.state,'completed');assert.equal(queue.position(third.id),1);
 await gate.release(b);await until(()=>third.state==='running');await gate.release(c);await until(()=>third.state==='completed');
 assert.deepEqual(started,[a,b,c]);
}finally{await queue?.close();await rm(root,{recursive:true,force:true});}});
test('EXPORT_CONCURRENCY lets several servers export at once and queues the rest',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'witness-export-concurrency-'));let queue;try{
 const ids=[];for(const guild of ['a','b','c'])ids.push(await recording(root,guild));const started=[];const gate=gatedExporter(started);
 queue=new ExportQueue(root,gate.exporter,undefined,2);await queue.load();
 const jobs=[];for(const [i,guild] of ['a','b','c'].entries())jobs.push(await queue.enqueue(ids[i],guild,'wav'));
 await until(()=>started.length===2);assert.equal(jobs[2].state,'queued');assert.equal(queue.position(jobs[2].id),1);
 await gate.release(ids[1]);await until(()=>jobs[2].state==='running');assert.equal(jobs[0].state,'running');
 await gate.release(ids[0]);await gate.release(ids[2]);await until(()=>jobs.every(job=>job.state==='completed'));
}finally{await queue?.close();await rm(root,{recursive:true,force:true});}});
test('cancelling a waiting job moves later servers up the queue',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'witness-export-cancel-queue-'));let queue;try{
 const a=await recording(root,'guild-a'),b=await recording(root,'guild-b'),c=await recording(root,'guild-c');const started=[];const gate=gatedExporter(started);
 queue=new ExportQueue(root,gate.exporter,undefined,1);await queue.load();
 const first=await queue.enqueue(a,'guild-a','wav');await until(()=>first.state==='running');const second=await queue.enqueue(b,'guild-b','wav'),third=await queue.enqueue(c,'guild-c','wav');
 await queue.cancel(second.id,'guild-b');assert.equal(queue.position(third.id),1);await gate.release(a);await until(()=>third.state==='running');await gate.release(c);await until(()=>third.state==='completed');assert.deepEqual(started,[a,c]);
}finally{await queue?.close();await rm(root,{recursive:true,force:true});}});
test('EXPORT_CONCURRENCY is validated',()=>{assert.equal(exportConcurrency(undefined),1);assert.equal(exportConcurrency('3'),3);for(const bad of ['0','17','1.5','two'])assert.throws(()=>exportConcurrency(bad),/EXPORT_CONCURRENCY/);});

test('shutdown during an asynchronous disk check starts no new exports',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-dispatch-stop-'));let release,checking=false,runs=0;
 const gate=new Promise(resolve=>release=resolve),queue=new ExportQueue(root,async()=>{runs++;return root;},async()=>{checking=true;await gate;return false;},2);
 try{await queue.load();const id=require('node:crypto').randomUUID();queue.jobs.set(id,{id,sessionID:id,guildID:'guild',format:'wav',mix:false,state:'queued',createdAt:new Date().toISOString()});await until(()=>checking);const closing=queue.close();release();await closing;assert.equal(runs,0);assert.equal(queue.get(id).state,'queued');assert.equal(queue.active.size,0);}finally{release();await queue.close();await rm(root,{recursive:true,force:true});}
});
test('same-timestamp FIFO order survives loading UUID-sorted job files',async()=>{
 const {writeFile,mkdir}=require('node:fs/promises');const root=await mkdtemp(path.join(os.tmpdir(),'witness-fifo-restart-')),started=[];let queue;
 try{const a=await recording(root,'a'),b=await recording(root,'b');await mkdir(path.join(root,'jobs'));const older='ffffffff-ffff-4fff-8fff-ffffffffffff',newer='00000000-0000-4000-8000-000000000000';
 for(const [id,sessionID,guildID,queueOrder] of [[older,a,'a',1],[newer,b,'b',2]])await writeFile(path.join(root,'jobs',id+'.json'),JSON.stringify({id,sessionID,guildID,queueOrder,format:'wav',mix:false,state:'queued',createdAt:'2026-10-07T10:00:00.000Z'}));
 queue=new ExportQueue(root,async(_root,id)=>{started.push(id);return root;});await queue.load();await until(()=>queue.get(newer).state==='completed');assert.deepEqual(started,[a,b]);
 }finally{await queue?.close();await rm(root,{recursive:true,force:true});}
});
test('cancellation during an initial persistence failure leaves no stuck cancelling job',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-save-cancel-'));let release,entered=false;const gate=new Promise(resolve=>release=resolve),queue=new ExportQueue(root,async()=>{throw Error('Must not run');});
 try{const session=await recording(root,'guild');await queue.load();const original=queue.save.bind(queue);queue.save=async job=>{if(job.state==='running'){entered=true;await gate;throw Error('Storage unavailable');}return original(job);};const job=await queue.enqueue(session,'guild','wav');await until(()=>entered);await queue.cancel(job.id,'guild');release();await until(()=>queue.cooldown);assert.equal(job.state,'cancelled');assert.equal(queue.active.size,0);queue.save=original;
 }finally{release();await queue.close();await rm(root,{recursive:true,force:true});}
});
test('one concurrent initial-save failure does not reset another running export',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-concurrent-storage-'));let release,entered=false,secondStarted=false;
 const gate=new Promise(resolve=>release=resolve),queue=new ExportQueue(root,async(_root,_id,options)=>{secondStarted=true;await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));return root;},undefined,2);
 try{const a=await recording(root,'a'),b=await recording(root,'b');await queue.load();const original=queue.save.bind(queue);queue.save=async job=>{if(job.sessionID===a&&job.state==='running'){entered=true;await gate;throw Error('Storage unavailable for first job');}return original(job);};const first=await queue.enqueue(a,'a','wav');await until(()=>entered);const second=await queue.enqueue(b,'b','wav');await until(()=>secondStarted);release();await until(()=>queue.cooldown);assert.equal(first.state,'queued');assert.equal(second.state,'running');assert.ok(queue.active.has(second.id));queue.save=original;
 }finally{release();await queue.close();await rm(root,{recursive:true,force:true});}
});
test('queued export failures reach operator logs without a Discord attachment waiter',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-export-failure-log-'));let queue;const errors=[],original=console.error;
 try{const session=await recording(root,'guild');queue=new ExportQueue(root,async()=>{throw Error('Synthetic encoder failure');});await queue.load();console.error=(...args)=>errors.push(args);const job=await queue.enqueue(session,'guild','wav');await until(()=>job.state==='failed');await queue.close();assert.ok(errors.some(args=>String(args[0]).includes(job.id)&&/failed/i.test(String(args[0]))&&args.some(arg=>String(arg).includes('Synthetic encoder failure'))),'Failed queue job must identify itself and its error in operator logs');}
 finally{console.error=original;await queue?.close();await rm(root,{recursive:true,force:true});}
});
test('operator failure logs exclude normal export cancellation and shutdown',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-export-normal-stop-'));const errors=[],original=console.error;let queue;
 try{const session=await recording(root,'guild');queue=new ExportQueue(root,async(_root,_id,options)=>{await new Promise((resolve,reject)=>{if(options.signal.aborted)reject(options.signal.reason);else options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});return root;});await queue.load();console.error=(...args)=>errors.push(args);const first=await queue.enqueue(session,'guild','wav');await until(()=>queue.active.has(first.id));await queue.cancel(first.id,'guild');await until(()=>first.state==='cancelled');const second=await queue.enqueue(session,'guild','wav');await until(()=>queue.active.has(second.id));await queue.close();assert.equal(second.state,'queued');assert.ok(!errors.some(args=>/Job .* failed/.test(String(args[0]))));}
 finally{console.error=original;await queue?.close();await rm(root,{recursive:true,force:true});}
});

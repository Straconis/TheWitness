const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {mkdtemp,mkdir,writeFile,rm,utimes}=require('node:fs/promises');
const intros=require('../dist/exports/server-intro');const {uploadIntroChunk,getServerIntro,introPCM,withRecordingIntros,recordingIntroLockDepth,introInUse}=intros;
const {ExportQueue}=require('../dist/exports/jobs');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function wav(seconds){const n=Math.round(seconds*48000),b=Buffer.alloc(44+n*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(192000,28);b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*4,40);for(let i=0;i<n;i++)b.writeInt16LE(1500,44+i*4);return b;}
const upload=name=>({index:0,final:true,bytes:wav(.2).toString('base64'),name});
async function session(root){const id=require('node:crypto').randomUUID();await mkdir(path.join(root,id));await writeFile(path.join(root,id,'session.json'),JSON.stringify({id,guildID:'g',channelID:'c',startedAt:'2026-10-01T00:00:00Z',state:'completed',durationSamples:48000*60,tracks:[{track:1,id:'u',username:'Alice'}]}));return id;}
async function customIntros(root,id,count){const ids=[];for(let i=0;i<count;i++){ids.push((await uploadIntroChunk(root,'g',upload('I'+i),id)).id);await wait(20);}return ids;}

test('a lock holder that throws releases the recording lock for the next caller',async()=>{
 const id=require('node:crypto').randomUUID();
 await assert.rejects(withRecordingIntros(id,async()=>{throw Error('boom');}),/boom/);assert.equal(recordingIntroLockDepth(id),0);
 const order=[];await Promise.all([withRecordingIntros(id,async()=>{await wait(20);order.push(1);}),withRecordingIntros(id,async()=>{order.push(2);}).catch(()=>{}),withRecordingIntros(id,async()=>{throw Error('x');}).catch(()=>{}),withRecordingIntros(id,async()=>{order.push(4);})]);
 assert.deepEqual(order,[1,2,4]);assert.equal(recordingIntroLockDepth(id),0);
});

test('pins are released after failed, deduplicated and successful submissions; cancelled jobs keep their intro',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-pins-'));let queue;
 try{const id=await session(root);const [a,b,c]=await customIntros(root,id,3);queue=new ExportQueue(root);await queue.load(false);
  const extras={includeIntro:true,introScope:'recording',introID:a};
  await assert.rejects(queue.enqueue(id,'g','wav',false,{...extras,trimStart:-5}),/Invalid trim start/);assert.equal(introInUse(a),false,'failed submission released its pin');
  const first=await queue.enqueue(id,'g','wav',false,extras),again=await queue.enqueue(id,'g','wav',false,extras);assert.equal(again.id,first.id,'deduplicated');
  await queue.cancel(first.id,'g');assert.equal(queue.get(first.id).state,'cancelled');assert.ok(introInUse(a),'a cancelled job can be retried, so its intro stays protected');
  await uploadIntroChunk(root,'g',upload('newer'),id);await wait(20);await uploadIntroChunk(root,'g',upload('newest'),id);assert.ok(await getServerIntro(root,'g',a,id),'oldest but referenced');assert.equal(await getServerIntro(root,'g',b,id),undefined,'unreferenced, beyond the newest three');
  const retried=await queue.retry(first.id,'g');assert.equal(retried.introID,a);
  queue.releaseIntroReferences();assert.equal(introInUse(a),false,'released provider and no leaked pins');
 }finally{await queue?.close();await rm(root,{recursive:true,force:true});}
});

test('an intro whose audio was removed (interrupted deletion) is treated as missing, not accepted',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-half-deleted-'));let queue;
 try{const id=await session(root);const [a]=await customIntros(root,id,1);await rm(introPCM(root,'g',a,id));
  assert.equal(await getServerIntro(root,'g',a,id),undefined);queue=new ExportQueue(root);await queue.load(false);
  await assert.rejects(queue.enqueue(id,'g','wav',false,{includeIntro:true,introScope:'recording',introID:a}),/Select or upload an intro/);
  // Server and channel intros get the same check.
  const server=await uploadIntroChunk(root,'g',upload('server'));await rm(introPCM(root,'g',server.id));assert.equal(await getServerIntro(root,'g'),undefined);
  const channel=await uploadIntroChunk(root,'g',upload('channel'),undefined,'c');assert.equal((await getServerIntro(root,'g',undefined,undefined,'c')).id,channel.id);
  await rm(introPCM(root,'g',channel.id,undefined,'c'));assert.equal(await getServerIntro(root,'g',undefined,undefined,'c'),undefined);
 }finally{await queue?.close();queue?.releaseIntroReferences();await rm(root,{recursive:true,force:true});}
});

test('the sweeper deletes an old unused custom intro description before its audio, and never one in use',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-sweep-order-'));
 try{const id=await session(root);const [a,b]=await customIntros(root,id,2);const old=new Date(Date.now()-72*3600000);
  for(const intro of [a,b]){const pcm=introPCM(root,'g',intro,id);await utimes(pcm,old,old);await utimes(pcm.replace(/pcm$/,'json'),old,old);}
  const unpin=intros.pinIntro(b);const {sweepArtifacts}=require('../dist/exports/storage');await sweepArtifacts(root,[],new Set());unpin();
  assert.equal(await getServerIntro(root,'g',a,id),undefined);assert.ok(await getServerIntro(root,'g',b,id));
  const {existsSync}=require('node:fs');assert.ok(!existsSync(introPCM(root,'g',a,id))&&!existsSync(introPCM(root,'g',a,id).replace(/pcm$/,'json')));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a custom intro chunk that races a recording deletion does not recreate the recording folder',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-deleted-recording-'));
 try{const id=await session(root);const started=(await uploadIntroChunk(root,'g',{index:0,final:false,bytes:wav(.1).toString('base64'),name:'x'},id)).id;
  await rm(path.join(root,id),{recursive:true,force:true});
  await assert.rejects(uploadIntroChunk(root,'g',{id:started,index:1,final:true,bytes:wav(.1).toString('base64')},id),/no longer exists/);
  await assert.rejects(uploadIntroChunk(root,'g',upload('new'),id),/no longer exists/);
  assert.equal(require('node:fs').existsSync(path.join(root,id)),false);
 }finally{await rm(root,{recursive:true,force:true});}
});

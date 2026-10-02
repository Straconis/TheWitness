const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,readFile,rm}=require('node:fs/promises');
const os=require('node:os');const path=require('node:path');const {EventEmitter}=require('node:events');
const {RecordingSession,MAX_RECORDING_DURATION_MS,MAX_RECORDING_SAMPLES}=require('../dist/recording/session');
const {RecordingManager}=require('../dist/recording/manager');
const {panelBody}=require('../dist/discord/panel');
const packet=Buffer.from([0xf8,0xff,0xfe]);
test('deadline guards Discord, browser PCM, future sync audio, and notes while preserving buffered pre-cap audio',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-limit-'));
 try{
  assert.equal(MAX_RECORDING_DURATION_MS,28800000);
  const session=await RecordingSession.create(root,'guild','voice');
  session.elapsedSamples=()=>MAX_RECORDING_SAMPLES-1n;
  await session.append(packet,'alice','Alice',0,MAX_RECORDING_SAMPLES-1n);
  await session.append(packet,'sync','Sync',0,MAX_RECORDING_SAMPLES);
  session.elapsedSamples=()=>MAX_RECORDING_SAMPLES;
  await session.append(packet,'browser','Browser',0,undefined,Buffer.alloc(3840));
  await session.append(packet,'alice','Alice',0,MAX_RECORDING_SAMPLES);
  await session.append(packet,'alice','Alice',0,MAX_RECORDING_SAMPLES-960n);
  await assert.rejects(session.note('Too late','alice'),/8-hour/);
  await session.close();assert.equal(session.packets,2);assert.equal(session.state,'completed');assert.equal(session.tracks.size,1);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('eight-hour timer finalizes idle/reconnecting sessions, skips end cue, clears listeners and reports saved cap',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-cap-'));const manager=new RecordingManager(root,[1000]);
 try{
  const receiver=new EventEmitter(),connection=new EventEmitter();connection.receive=()=>receiver;
  let attempts=0,notified=0;manager.onDurationLimit=async()=>{notified++;};
  const session=await manager.start({id:'guild',members:new Map()},'voice',connection,async()=>{attempts++;return connection;});
  receiver.emit('data',packet,'alice',0);
  let emitEnd;manager.syncSessions.set('guild',{stop:async emit=>{emitEnd=emit;}});
  connection.emit('disconnect');
  t.mock.timers.tick(MAX_RECORDING_DURATION_MS);
  // Drain the reconnect lock and duration-limit finalization without advancing time again.
  await manager.exclusive('guild',async()=>{});
  assert.equal(attempts,0);assert.equal(notified,1);assert.equal(emitEnd,false);assert.equal(manager.sessions.size,0);
  assert.equal(receiver.listenerCount('data'),0);assert.equal(session.state,'completed');assert.equal(session.packets,1);
  const saved=JSON.parse(await readFile(path.join(session.directory,'session.json')));assert.equal(saved.stopReason,'duration-limit');assert.equal(saved.error,undefined);
  assert.ok(panelBody(session).embeds[0].fields.some(field=>field.name==='8-hour session limit reached'));
 }finally{await manager.shutdown();t.mock.timers.reset();await rm(root,{recursive:true,force:true});}
});
test('manual stop cancels the deadline timer and cannot affect a replacement session',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const root=await mkdtemp(path.join(os.tmpdir(),'witness-cancel-cap-'));const manager=new RecordingManager(root);
 try{
  const connection=new EventEmitter();connection.receive=()=>new EventEmitter();const guild={id:'guild',members:new Map()};
  const first=await manager.start(guild,'voice',connection);await manager.stop('guild');
  t.mock.timers.tick(MAX_RECORDING_DURATION_MS/2);
  const second=await manager.start(guild,'voice',connection);let capped=0;manager.onDurationLimit=async()=>{capped++;};
  t.mock.timers.tick(MAX_RECORDING_DURATION_MS/2);await manager.exclusive('guild',async()=>{});
  assert.equal(first.stopReason,undefined);assert.equal(manager.sessions.get('guild'),second);assert.equal(capped,0);
 }finally{await manager.shutdown();t.mock.timers.reset();await rm(root,{recursive:true,force:true});}
});

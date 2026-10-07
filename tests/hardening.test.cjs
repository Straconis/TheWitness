const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, readFile, writeFile, rm, readdir } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { once, EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { spawnSync } = require('node:child_process');

const { startKeepAlive } = require('../dist/downloads/keepalive');
const { DownloadService, MAX_BROWSER_GUESTS } = require('../dist/downloads/service');
const { RecordingManager, DEFAULT_RECONNECT_DELAYS } = require('../dist/recording/manager');
const { RecordingSession, GUEST_BACKPRESSURE_BYTES } = require('../dist/recording/session');
const { markInterruptedSessions } = require('../dist/recording/recovery');
const { ExportQueue } = require('../dist/exports/jobs');
const { SettingsStore } = require('../dist/storage/settings');
const { StorageMonitor } = require('../dist/storage/space');

const OPUS = Buffer.from([0xf8, 0xff, 0xfe]);
const tick = () => new Promise(resolve => setImmediate(resolve));
async function spin(predicate, ms = 5000) { const deadline = Date.now() + ms; while (!predicate()) { if (Date.now() > deadline) throw Error('Timed out'); await tick(); } }
async function until(predicate, attempts = 400) { for (let i = 0; i < attempts; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('Timed out'); }
function voice() { const receiver = new EventEmitter(), connection = new EventEmitter(); connection.receive = () => receiver; connection.disconnect = () => {}; return { connection, receiver }; }
async function completedSession(root, guild = 'guild') {
  const session = await RecordingSession.create(root, guild, 'voice');
  await session.append(OPUS, 'one', 'One'); await session.close(); return session;
}

test('keepalive pings an answering peer, terminates a silent one and stops on close', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const socket = new EventEmitter(); let pings = 0, terminated = 0;
  socket.ping = () => { pings++; }; socket.terminate = () => { terminated++; };
  startKeepAlive(socket, 1000);
  t.mock.timers.tick(1000); assert.equal(pings, 1); socket.emit('pong');
  t.mock.timers.tick(1000); assert.equal(pings, 2); assert.equal(terminated, 0);
  t.mock.timers.tick(1000); assert.equal(terminated, 1, 'no pong since the last ping');
  const closing = new EventEmitter(); let more = 0; closing.ping = () => { more++; }; closing.terminate = () => {};
  startKeepAlive(closing, 1000); closing.emit('close'); t.mock.timers.tick(5000); assert.equal(more, 0);
});

test('request bodies keep multi-byte characters that arrive split across chunks, and enforce the size limit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'witness-body-'));
  try {
    const service = await DownloadService.create(root, 'http://localhost');
    const bytes = Buffer.from(JSON.stringify({ title: 'Dice \u{1F3B2} night' }));
    const middle = bytes.indexOf(0xf0) + 2; // split inside the 4-byte emoji
    const body = await service.readBody(Readable.from([bytes.subarray(0, middle), bytes.subarray(middle)]), 1024);
    assert.equal(JSON.parse(body).title, 'Dice \u{1F3B2} night');
    assert.equal(await service.readBody(Readable.from([Buffer.alloc(600), Buffer.alloc(600)]), 1024), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('browser microphone sockets are capped per recording and slots free up when a guest leaves', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'witness-guests-'));
  const manager = new RecordingManager(root), queue = new ExportQueue(root), settings = new SettingsStore(path.join(root, 'settings.json'));
  let service; const sockets = [];
  try {
    await settings.load(); await queue.load();
    service = await DownloadService.create(root, 'http://localhost'); service.attach(queue, settings, manager);
    const port = await service.listen(0, '127.0.0.1');
    const session = await manager.start({ id: 'guild', members: new Map() }, 'voice', voice().connection);
    const link = service.browserLink(session.id).replace('http://localhost', `ws://127.0.0.1:${port}`);
    for (let i = 0; i < MAX_BROWSER_GUESTS; i++) { const ws = new WebSocket(link); sockets.push(ws); await once(ws, 'open'); }
    const extra = new WebSocket(link); sockets.push(extra);
    const outcome = await new Promise(resolve => { extra.addEventListener('open', () => resolve('open')); extra.addEventListener('error', () => resolve('refused')); });
    assert.equal(outcome, 'refused');
    sockets[0].close(); await once(sockets[0], 'close');
    await until(() => !service.guestCounts.has(session.id) || service.guestCounts.get(session.id) < MAX_BROWSER_GUESTS);
    const replacement = new WebSocket(link); sockets.push(replacement); await once(replacement, 'open');
  } finally {
    for (const ws of sockets) try { ws.close(); } catch {}
    await service?.close(); await manager.shutdown(); await rm(root, { recursive: true, force: true });
  }
});

test('voice reconnect keeps trying well past the old three attempts, and the default schedule spans minutes', async () => {
  assert.ok(DEFAULT_RECONNECT_DELAYS.length > 3);
  assert.ok(DEFAULT_RECONNECT_DELAYS.reduce((a, b) => a + b, 0) >= 240000);
  const root = await mkdtemp(path.join(os.tmpdir(), 'witness-reconnect-')), manager = new RecordingManager(root, [0, 0, 0, 0, 0, 0]);
  try {
    const first = voice(); let attempts = 0;
    const session = await manager.start({ id: 'guild', members: new Map() }, 'voice', first.connection, async () => {
      attempts++; if (attempts <= 5) throw new Error('voice server unavailable'); return voice().connection;
    });
    first.connection.emit('disconnect');
    await until(() => attempts === 6 && session.voiceState === 'connected');
    assert.equal(session.state, 'recording', 'a five-failure outage must not fail the session');
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('browser guest audio is shed before it can fail the recording, while Discord audio is still accepted', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'witness-backpressure-'));
  try {
    const session = await RecordingSession.create(root, 'guild', 'voice');
    const pending = [], pcm = Buffer.alloc(3840);
    // Queue far more guest frames than the storage queue can drain synchronously.
    const frames = Math.ceil(GUEST_BACKPRESSURE_BYTES / (pcm.length + OPUS.length)) + 500;
    for (let i = 0; i < frames; i++) pending.push(session.append(OPUS, 'browser-1', 'Guest', i * 960, undefined, pcm));
    pending.push(session.append(OPUS, 'discord-1', 'Player')); // must still be accepted
    const results = await Promise.allSettled(pending);
    assert.ok(results.every(result => result.status === 'fulfilled'), 'nothing rejected');
    assert.ok(session.guestFramesDropped >= 400, 'excess guest frames were shed');
    await session.close(); assert.equal(session.state, 'completed');
    const saved = JSON.parse(await readFile(path.join(session.directory, 'session.json'), 'utf8'));
    assert.ok(saved.guestFramesDropped > 0); assert.ok(saved.tracks.some(track => track.id === 'discord-1'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('critical disk space stops active recordings cleanly and reports why', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'witness-lowdisk-')), manager = new RecordingManager(root);
  try {
    const hooks = []; manager.onDurationLimit = async session => { hooks.push(session.id); };
    const session = await manager.start({ id: 'guild', members: new Map() }, 'voice', voice().connection);
    await manager.stopForLowDisk();
    assert.equal(manager.sessions.size, 0); assert.equal(session.state, 'completed');
    assert.equal(session.stopReason, 'low-disk'); assert.deepEqual(hooks, [session.id]);
  } finally { await manager.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('storage monitor fires the critical handler once per transition and can be disabled', async () => {
  let available = 500, fired = 0; const alerts = [];
  const inspect = async () => ({ bavail: available, bsize: 1, blocks: 10000 });
  const monitor = new StorageMonitor('/unused', 1000, inspect, message => alerts.push(message), 100, () => { fired++; });
  await monitor.check(); assert.equal(monitor.status.critical, false); assert.equal(monitor.status.low, true); assert.equal(fired, 0);
  available = 50; await monitor.check(); await monitor.check(); assert.equal(fired, 1); assert.equal(monitor.status.critical, true);
  available = 600; await monitor.check(); assert.equal(monitor.status.critical, false);
  available = 10; await monitor.check(); assert.equal(fired, 2);
  let neverFired = 0; const off = new StorageMonitor('/unused', 1000, inspect, () => {}, 0, () => { neverFired++; });
  await off.check(); assert.equal(off.status.critical, false); assert.equal(neverFired, 0);
});

test('export queue refuses new exports when disk is critical and enforces the cloud-upload allowlist', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'witness-gates-')), previous = process.env.CLOUD_UPLOAD_GUILD_IDS;
  try {
    const session = await completedSession(root, '222');
    const full = new ExportQueue(root, async () => root, () => true); await full.load();
    await assert.rejects(full.enqueue(session.id, '222', 'wav'), /critically low/); await full.close();
    process.env.CLOUD_UPLOAD_GUILD_IDS = '111, 333';
    const queue = new ExportQueue(root, async () => root); await queue.load();
    await assert.rejects(queue.enqueue(session.id, '222', 'wav', false, { upload: 'dropbox' }), /not enabled for this server/);
    process.env.CLOUD_UPLOAD_GUILD_IDS = '222';
    await assert.rejects(queue.enqueue(session.id, '222', 'wav', false, { upload: 'dropbox' }), /Configure the cloud account/, 'allowed servers get past the allowlist');
    await queue.close();
  } finally {
    if (previous === undefined) delete process.env.CLOUD_UPLOAD_GUILD_IDS; else process.env.CLOUD_UPLOAD_GUILD_IDS = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('a storage failure pauses the export queue briefly instead of killing it until restart', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'witness-queue-recover-'));
  let queue;
  try {
    const session = await completedSession(root);
    let release, started = false, runs = 0; const gate = new Promise(resolve => { release = resolve; });
    queue = new ExportQueue(root, async () => { runs++; if (runs === 1) { started = true; await gate; } return path.join(root, 'out'); });
    await queue.load();
    await queue.enqueue(session.id, 'guild', 'wav');
    await spin(() => started);
    await rm(path.join(root, 'jobs'), { recursive: true, force: true }); // the next save will fail
    t.mock.timers.enable({ apis: ['setTimeout'] });
    release();
    await spin(() => queue.cooldown);
    await mkdir(path.join(root, 'jobs'));
    const second = await queue.enqueue(session.id, 'guild', 'flac'); // used to throw "Export service is stopping"
    assert.equal(second.state, 'queued');
    t.mock.timers.tick(30000);
    await spin(() => second.state === 'completed');
  } finally { t.mock.timers.reset(); await queue?.close(); await rm(root, { recursive: true, force: true }); }
});

test('startup skips malformed session metadata without modifying it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'witness-startup-'));
  try {
    const good = '11111111-1111-4111-8111-111111111111', bad = '22222222-2222-4222-8222-222222222222';
    await mkdir(path.join(root, good)); await mkdir(path.join(root, bad));
    await writeFile(path.join(root, good, 'session.json'), JSON.stringify({ id: good, state: 'recording' }));
    await writeFile(path.join(root, bad, 'session.json'), '{ truncated');
    assert.equal(await markInterruptedSessions(root), 1);
    assert.equal(JSON.parse(await readFile(path.join(root, good, 'session.json'), 'utf8')).state, 'interrupted');
    assert.equal(await readFile(path.join(root, bad, 'session.json'), 'utf8'), '{ truncated', 'bad file left untouched');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('deploy release pruning keeps the live release, rollback target, baseline and newest others', { skip: process.platform !== 'linux' }, async () => {
  const script = await readFile(path.join(__dirname, '..', 'scripts', 'deploy-github.sh'), 'utf8');
  const fn = /^prune_releases\(\) \{[\s\S]*?^\}/m.exec(script);
  assert.ok(fn, 'prune_releases is defined');
  const root = await mkdtemp(path.join(os.tmpdir(), 'witness-prune-'));
  try {
    const setup = `set -euo pipefail
cd "${root}"; mkdir -p .releases
for i in 1 2 3 4 5 6 7 8; do mkdir -p .releases/rev$i.AAAA/dist .releases/rev$i.AAAA/node_modules; touch -d "2026-09-0$i" .releases/rev$i.AAAA; done
mkdir -p .releases/baseline.ZZZZ/dist
ln -s "$PWD/.releases/rev8.AAAA/dist" dist; ln -s "$PWD/.releases/rev8.AAAA/node_modules" node_modules
app="$PWD"; old_dist="$PWD/.releases/rev2.AAAA/dist"; old_modules="$PWD/.releases/rev2.AAAA/node_modules"
${fn[0]}
prune_releases`;
    const run = spawnSync('bash', ['-c', setup], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const left = (await readdir(path.join(root, '.releases'))).sort();
    assert.deepEqual(left, ['baseline.ZZZZ', 'rev2.AAAA', 'rev5.AAAA', 'rev6.AAAA', 'rev7.AAAA', 'rev8.AAAA']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('critical storage blocks new recordings and queued exports resume when storage recovers',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-critical-gate-'));let critical=true,runs=0;const manager=new RecordingManager(root,[],undefined,()=>critical),queue=new ExportQueue(root,async()=>{runs++;return path.join(root,'out');},()=>critical);
 try{
  await assert.rejects(manager.start({id:'guild',members:new Map()},'voice',voice().connection),/critically low/);
  critical=false;const session=await completedSession(root);await queue.load();
  t.mock.timers.enable({apis:['setTimeout']});critical=true;
  // Simulate a previously persisted job at startup; it must also respect disk pressure.
  const id=require('node:crypto').randomUUID();queue.jobs.set(id,{id,sessionID:session.id,guildID:'guild',format:'wav',mix:false,state:'queued',createdAt:new Date().toISOString()});queue.kick();await spin(()=>queue.cooldown);assert.equal(runs,0);
  critical=false;t.mock.timers.tick(30000);await spin(()=>queue.get(id).state==='completed');assert.equal(runs,1);
 }finally{t.mock.timers.reset();await queue.close();await manager.shutdown();await rm(root,{recursive:true,force:true});}
});

test('failed final metadata writes retry persistence without repeating a completed export',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-terminal-save-'));let runs=0,release,started=false;const gate=new Promise(resolve=>release=resolve);const queue=new ExportQueue(root,async()=>{runs++;started=true;await gate;return path.join(root,'out');});
 try{await queue.load();const session=await completedSession(root),job=await queue.enqueue(session.id,'guild','wav');await spin(()=>started);await rm(path.join(root,'jobs'),{recursive:true,force:true});t.mock.timers.enable({apis:['setTimeout']});release();await spin(()=>queue.cooldown);assert.equal(job.state,'completed');await mkdir(path.join(root,'jobs'));t.mock.timers.tick(30000);await spin(()=>queue.pendingPersistence.size===0&&!queue.dispatching&&queue.running.size===0);assert.equal(runs,1);assert.equal(JSON.parse(await readFile(path.join(root,'jobs',job.id+'.json'))).state,'completed');
 }finally{t.mock.timers.reset();await queue.close();await rm(root,{recursive:true,force:true});}
});

test('malformed restricted settings never silently reset server access',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-access-safe-'));try{const file=path.join(root,'settings.json');const bytes=JSON.stringify({'guild':{autoJoin:true,autoRecord:false,restrictAccess:true}});await writeFile(file,bytes);await assert.rejects(new SettingsStore(file).load(),/Bot Wrangler/);assert.equal(await readFile(file,'utf8'),bytes);await writeFile(file,'{ truncated');await assert.rejects(new SettingsStore(file).load());assert.equal(await readFile(file,'utf8'),'{ truncated');}finally{await rm(root,{recursive:true,force:true});}
});

test('loudness choices distinguish jobs, persist to disk, reach the exporter, and survive retry',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-loudness-job-'));let release;const gate=new Promise(resolve=>release=resolve),seen=[];const queue=new ExportQueue(root,async(_root,_session,options)=>{seen.push(options);await gate;return path.join(root,'out');});
 try{await queue.load();const session=await completedSession(root);await assert.rejects(queue.enqueue(session.id,'guild','wav',false,{normalizeAudio:true,targetLUFS:-99}),/Target loudness/);
 const first=await queue.enqueue(session.id,'guild','wav',false,{normalizeAudio:true});await spin(()=>seen.length===1);
 const other=await queue.enqueue(session.id,'guild','wav',false,{normalizeAudio:true,targetLUFS:-23,maxTruePeakDBTP:-3});assert.notEqual(first.id,other.id);assert.equal((await queue.enqueue(session.id,'guild','wav',false,{normalizeAudio:true,targetLUFS:-23,maxTruePeakDBTP:-3})).id,other.id);
 await queue.cancel(other.id,'guild');const retry=await queue.retry(other.id,'guild');assert.equal(retry.targetLUFS,-23);assert.equal(retry.maxTruePeakDBTP,-3);const saved=JSON.parse(await readFile(path.join(root,'jobs',retry.id+'.json')));assert.equal(saved.targetLUFS,-23);assert.equal(saved.maxTruePeakDBTP,-3);release();await spin(()=>retry.state==='completed');assert.equal(seen[0].targetLUFS,-16);assert.equal(seen[0].maxTruePeakDBTP,-1);assert.equal(seen[1].targetLUFS,-23);assert.equal(seen[1].maxTruePeakDBTP,-3);
 }finally{release();await queue.close();await rm(root,{recursive:true,force:true});}
});

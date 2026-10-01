const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { RecordingSession } = require('../dist/recording/session');
const { RecordingManager } = require('../dist/recording/manager');

function pages(bytes) {
  const result = [];
  for (let offset = 0; offset < bytes.length;) {
    assert.equal(bytes.toString('ascii', offset, offset + 4), 'OggS');
    const count = bytes[offset + 26];
    const size = [...bytes.subarray(offset + 27, offset + 27 + count)].reduce((a,b) => a+b, 0);
    result.push({ track: bytes.readUInt32LE(offset + 14), sequence: bytes.readUInt32LE(offset + 18),
      time: bytes.readBigUInt64LE(offset + 6), data: bytes.subarray(offset + 27 + count, offset + 27 + count + size) });
    offset += 27 + count + size;
  }
  return result;
}

test('concurrent packets preserve speaker tracks and timestamp pairs, close drains writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'witness-test-'));
  try {
    const session = await RecordingSession.create(root, 'guild', 'voice');
    const pending = [session.append(Buffer.from([1,2]), 'alice', 'Alice', 100),
      session.append(Buffer.from([3]), 'bob', 'Bob', 200),
      session.append(Buffer.from([4]), 'alice', 'Alice', 300)];
    await session.close();
    await Promise.all(pending);
    await session.close();
    const metadata = JSON.parse(await readFile(path.join(session.directory, 'session.json')));
    assert.equal(metadata.state, 'completed');
    assert.equal(metadata.packets, 3);
    assert.equal(metadata.tracks.length, 2);
    const data = pages(await readFile(path.join(session.directory, 'audio.ogg.data')));
    assert.deepEqual(data.map(p => [p.track, p.sequence]), [[1,2],[1,3],[2,2],[2,3],[1,4],[1,5]]);
    assert.deepEqual(data.filter((_,i) => i%2).map(p => Number(p.time)), [100,200,300]);
    assert.ok(data.filter((_,i) => i%2).every(p => p.data.length === 0));
    const heads = pages(await readFile(path.join(session.directory, 'audio.ogg.header1')));
    assert.deepEqual(heads.map(p => p.data.toString('ascii',0,8)), ['OpusHead','OpusHead']);
    const users = JSON.parse('{' + await readFile(path.join(session.directory, 'audio.ogg.users'), 'utf8') + '}');
    assert.equal(users[1].id, 'alice');
    assert.equal(users[2].id, 'bob');
    await assert.rejects(session.append(Buffer.from([1]), 'alice', 'Alice', 400), /closed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('invalid packet fails session instead of reporting successful completion', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'witness-test-'));
  try {
    const session = await RecordingSession.create(root, 'guild', 'voice');
    await assert.rejects(session.append(Buffer.alloc(65025,1), 'alice', 'Alice', 1), RangeError);
    await assert.rejects(session.close(), RangeError);
    const metadata = JSON.parse(await readFile(path.join(session.directory, 'session.json')));
    assert.equal(metadata.state, 'failed');
    assert.ok(metadata.error);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('manager serializes starts and detaches receiver when stopped', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'witness-test-'));
  try {
    const manager = new RecordingManager(root);
    const receiver = new EventEmitter();
    const connection = new EventEmitter();
    connection.receive = () => receiver;
    const guild = { id: 'guild', members: new Map([['alice', { username: 'Alice' }]]) };
    const [first, second] = await Promise.all([1,2].map(() => manager.exclusive('guild', () => manager.start(guild, 'voice', connection))));
    assert.equal(first, second);
    assert.equal(receiver.listenerCount('data'), 1);
    await assert.rejects(manager.start(guild, 'other', connection), /Stop/);
    receiver.emit('data', Buffer.from([0xf8,0xff,0xfe]), 'alice', 50);
    await manager.exclusive('guild', () => manager.stop('guild'));
    assert.equal(first.packets, 1);
    assert.equal(receiver.listenerCount('data'), 0);
    assert.equal(connection.listenerCount('disconnect'), 0);
    assert.equal(manager.sessions.size, 0);
    await manager.shutdown();
    await assert.rejects(manager.exclusive('guild', async () => {}), /shutting down/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('startup marks interrupted recordings and preserves completed sessions and raw audio', async () => {
  const { markInterruptedSessions } = require('../dist/recording/recovery');
  const { writeFile } = require('node:fs/promises');
  const root = await mkdtemp(path.join(os.tmpdir(), 'witness-test-'));
  try {
    const session = await RecordingSession.create(root, 'guild', 'voice');
    await session.append(Buffer.from([0xf8,0xff,0xfe]), 'alice', 'Alice', 50);
    await session.close();
    const target = path.join(session.directory, 'session.json');
    const metadata = JSON.parse(await readFile(target));
    const data = await readFile(path.join(session.directory, 'audio.ogg.data'));
    assert.equal(await markInterruptedSessions(root), 0);
    await writeFile(target, JSON.stringify({ ...metadata, state: 'recording' }));
    assert.equal(await markInterruptedSessions(root), 1);
    assert.equal(JSON.parse(await readFile(target)).state, 'interrupted');
    assert.deepEqual(await readFile(path.join(session.directory, 'audio.ogg.data')), data);
    assert.equal(await markInterruptedSessions(root), 0);
    const info = JSON.parse(await readFile(path.join(session.directory, 'audio.ogg.info')));
    assert.ok(Object.values(info.features).every(enabled => enabled === true));
    assert.equal(Object.keys(info.features).length, 8);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('notes preserve timestamps and Craig note track and drain on close', async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-notes-'));
 try {
  const session=await RecordingSession.create(root,'guild','voice');
  await assert.rejects(session.note('   ','alice'),/Notes/);
  const pending=[session.note('First note','alice'),session.note('Second note','bob')];
  await session.close(); await Promise.all(pending);
  const notes=(await readFile(path.join(session.directory,'notes.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(notes.map(n=>n.text),['First note','Second note']);
  assert.ok(notes[1].seconds>=notes[0].seconds);
  const data=pages(await readFile(path.join(session.directory,'audio.ogg.data')));
  assert.deepEqual(data.map(p=>[p.track,p.sequence,p.data.toString()]),[[65536,1,'NOTEFirst note'],[65536,2,'NOTESecond note']]);
  await assert.rejects(session.note('Late note','alice'),/closed/);
 } finally { await rm(root,{recursive:true,force:true}); }
});

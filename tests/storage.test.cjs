const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, readFile, writeFile, mkdir, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { SettingsStore } = require('../dist/storage/settings');
const { getSession, listSessions } = require('../dist/storage/sessions');
const { archiveExport } = require('../dist/exports/archive');

test('automation updates serialize and survive a restart', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(),'witness-settings-'));
 try {
  const file = path.join(root,'settings.json'); const store = new SettingsStore(file);
  await store.load();
  await Promise.all([store.update('1',{autoJoin:true}),store.update('1',{autoRecord:true}),store.update('2',{autoJoin:true})]);
  const restarted = new SettingsStore(file); await restarted.load();
  assert.deepEqual(restarted.get('1'),{autoJoin:true,autoRecord:true});
  assert.deepEqual(restarted.get('2'),{autoJoin:true,autoRecord:false});
  const copy = restarted.get('1'); copy.autoJoin=false;
  assert.equal(restarted.get('1').autoJoin,true);
  const invalid = new SettingsStore(path.join(root,'missing','settings.json'));
  await assert.rejects(invalid.update('1',{autoJoin:true}));
  assert.equal(invalid.get('1').autoJoin,false);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('saved session access is scoped to the server and rejects traversal', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(),'witness-list-'));
 try {
  const id = '11111111-1111-4111-8111-111111111111';
  await mkdir(path.join(root,id));
  await writeFile(path.join(root,id,'session.json'),JSON.stringify({id,guildID:'one',startedAt:'2026-09-30',tracks:[],state:'completed'}));
  assert.equal((await listSessions(root,'one')).length,1);
  assert.equal((await listSessions(root,'two')).length,0);
  await assert.rejects(getSession(root,id,'two'),/not found/);
  await assert.rejects(getSession(root,'../settings.json','one'),/Invalid/);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('bounded download ZIP can be extracted with intact filenames and checksums', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(),'witness-zip-'));
 try {
  const track=Buffer.from([0,1,2,255]);
  await writeFile(path.join(root,'track-1.ogg'),track);
  await writeFile(path.join(root,'manifest.json'),'{}');
  await writeFile(path.join(root,'mix.wav'),track);
  await writeFile(path.join(root,'notes.json'),'[]');
  await writeFile(path.join(root,'secret.txt'),'excluded');
  const archive = await archiveExport(root,1024);
  await writeFile(path.join(root,'download.zip'),archive);
  const result = spawnSync('python3',['-c',`import zipfile,sys
with zipfile.ZipFile(sys.argv[1]) as z:
 assert sorted(z.namelist()) == ['manifest.json','mix.wav','notes.json','track-1.ogg']
 assert z.testzip() is None
 assert z.read('track-1.ogg') == bytes([0,1,2,255])`,path.join(root,'download.zip')],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  await assert.rejects(archiveExport(root,10),/too large/);
 } finally { await rm(root,{recursive:true,force:true}); }
});

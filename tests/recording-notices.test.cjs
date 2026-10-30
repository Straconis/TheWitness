const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {SettingsStore}=require('../dist/storage/settings'),{RecordingNotices}=require('../dist/storage/recording-notices');
test('shared defaults adopt existing files without copying audio or rewriting legacy settings',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-notice-defaults-'));try{
  const settings=new SettingsStore(path.join(root,'settings.json'));await settings.load();const start=randomUUID(),end=randomUUID();await settings.update('original',{startSound:{mode:'custom',customID:start},endSound:{mode:'custom',customID:end}});await settings.update('other',{autoJoin:true});const original=await fs.readFile(path.join(root,'settings.json'));
  for(const guild of ['original','other','brand-new']){
   assert.deepEqual(settings.recordingNotices.resolve('start',guild,settings.all()),{mode:'custom',sourceGuildID:'original',customID:start});
   assert.deepEqual(settings.recordingNotices.resolve('end',guild,settings.all()),{mode:'custom',sourceGuildID:'original',customID:end});
  }
  await assert.rejects(fs.stat(path.join(root,'recording-notices.json')),{code:'ENOENT'});
  await settings.recordingNotices.update('start',{mode:'off'});assert.deepEqual(await fs.readFile(path.join(root,'settings.json')),original);
  const loaded=new SettingsStore(path.join(root,'settings.json'));await loaded.load();assert.deepEqual(loaded.recordingNotices.resolve('start','brand-new',loaded.all()),{mode:'off'});
  assert.equal(loaded.recordingNotices.resolve('end','brand-new',loaded.all()).customID,end);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('conflicting existing sounds keep their playback until the owner selects a shared default',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-notice-conflict-'));try{const store=new RecordingNotices(root),a=randomUUID(),b=randomUUID(),legacy=[['one',{autoJoin:false,autoRecord:false,startSound:{mode:'custom',customID:a}}],['two',{autoJoin:false,autoRecord:false,startSound:{mode:'custom',customID:b}}]];
 assert.equal(store.defaults(legacy).start.needsSelection,true);assert.equal(store.resolve('start','one',legacy).customID,a);assert.equal(store.resolve('start','two',legacy).customID,b);
 await store.update('start',{mode:'custom',sourceGuildID:'one',customID:a});assert.equal(store.defaults(legacy).start.needsSelection,false);assert.deepEqual(store.resolve('start','two',legacy),{mode:'custom',sourceGuildID:'one',customID:a});assert.deepEqual(store.references(),[{sourceGuildID:'one',customID:a}]);
 assert.throws(()=>store.update('end',{mode:'default'}));assert.throws(()=>store.update('start',{mode:'custom',sourceGuildID:'../bad',customID:a}));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

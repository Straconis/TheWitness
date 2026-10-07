const test=require('node:test');const assert=require('node:assert/strict');
const {mkdtemp,readFile,writeFile,rm}=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {RecordingSession}=require('../dist/recording/session');const {recoverSession}=require('../dist/recording/salvage');const {exportSession}=require('../dist/exports/export');

test('recovery salvages only complete checksummed pairs and leaves original audio untouched',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-recover-'));
 try {
  const session=await RecordingSession.create(root,'guild','voice');
  await session.append(Buffer.from([0xf8,0xff,0xfe]),'alice','Alice',100);
  await session.append(Buffer.from([0xf8,0xff,0xfe]),'alice','Alice',1060);
  await session.note('Recovered note','alice');await session.close();
  const cues={version:1,sessionID:session.id,cues:[{id:'cue',sessionID:session.id,kind:'start',targetUTC:0,seconds:0.01,duration:0.3,state:'captured'}]};
  await writeFile(path.join(session.directory,'sync-cues.json'),JSON.stringify(cues));
  const file=path.join(session.directory,'audio.ogg.data');const audio=await readFile(file);
  // Remove the final note, then truncate the second packet timestamp page.
  let offset=0;const ends=[];
  while(offset<audio.length){const n=audio[offset+26];const size=[...audio.subarray(offset+27,offset+27+n)].reduce((a,b)=>a+b,0);offset+=27+n+size;ends.push(offset);}
  const broken=audio.subarray(0,ends[3]-5);await writeFile(file,broken);
  const metadata=JSON.parse(await readFile(path.join(session.directory,'session.json')));
  await writeFile(path.join(session.directory,'session.json'),JSON.stringify({...metadata,state:'interrupted',tracks:[],packets:0}));
  await assert.rejects(recoverSession(root,session.id,'other'),/not found/);
  const id=await recoverSession(root,session.id,'guild');
  const recovered=JSON.parse(await readFile(path.join(root,id,'session.json')));
  assert.equal(recovered.packets,1);assert.equal(recovered.tracks[0].id,'alice');assert.equal(recovered.recovery.sourceID,session.id);
  assert.deepEqual(await readFile(file),broken);
  assert.equal(JSON.parse(await readFile(path.join(session.directory,'session.json'))).state,'interrupted');
  const output=await exportSession(root,id);assert.ok((await readFile(path.join(output,'track-1.ogg'))).length>0);
  assert.deepEqual(JSON.parse(await readFile(path.join(output,'manifest.json'))).syncCues.cues.map(cue=>cue.id),['cue']);
  await writeFile(path.join(session.directory,'sync-cues.json'),'{ truncated');
  const recoveredWithoutCues=await recoverSession(root,session.id,'guild');
  const exportWithoutCues=await exportSession(root,recoveredWithoutCues);
  assert.equal(JSON.parse(await readFile(path.join(exportWithoutCues,'manifest.json'))).syncCues,undefined);
  assert.equal(await readFile(path.join(session.directory,'sync-cues.json'),'utf8'),'{ truncated');
  await assert.rejects(recoverSession(root,id,'guild'),/Only interrupted/);
  const corrupt=Buffer.from(broken);corrupt[28]^=1;await writeFile(file,corrupt);
  await assert.rejects(recoverSession(root,session.id,'guild'),/No complete/);
 }finally{await rm(root,{recursive:true,force:true});}
});

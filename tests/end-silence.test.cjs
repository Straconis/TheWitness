const test=require('node:test'),assert=require('node:assert/strict');
const {mkdtemp,writeFile,readFile,rm}=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {findSilenceCuts,cutSharedSilence}=require('../dist/exports/silence');
const ffmpeg=path.resolve(__dirname,'../bin/ffmpeg');
function pcm(seconds,regions){const bytes=Buffer.alloc(Math.round(seconds*48000)*4);for(const [start,end] of regions)for(let i=Math.round(start*48000);i<Math.round(end*48000);i++){const value=Math.round(3000*Math.sin(i*2*Math.PI*440/48000));bytes.writeInt16LE(value,i*4);bytes.writeInt16LE(value,i*4+2);}return bytes;}
function wav(seconds,regions){const audio=pcm(seconds,regions),header=Buffer.alloc(44);header.write('RIFF');header.writeUInt32LE(audio.length+36,4);header.write('WAVEfmt ',8);header.writeUInt32LE(16,16);header.writeUInt16LE(1,20);header.writeUInt16LE(2,22);header.writeUInt32LE(48000,24);header.writeUInt32LE(192000,28);header.writeUInt16LE(4,32);header.writeUInt16LE(16,34);header.write('data',36);header.writeUInt32LE(audio.length,40);return Buffer.concat([header,audio]);}
test('end-only trimming preserves leading/internal pauses, uses selected speakers and retains a half-second tail',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-end-silence-'));
 try{const a=path.join(root,'a.wav'),b=path.join(root,'b.wav');await writeFile(a,wav(8,[[1,2],[4,5]]));await writeFile(b,wav(8,[[6,7]]));
 assert.deepEqual((await findSilenceCuts([a,b],new Set([a,b]),ffmpeg,undefined,30,true,false)).cuts,[{start:7.5,end:8}]);
 const detected=await findSilenceCuts([a,b],new Set([a]),ffmpeg,undefined,30,true,false);assert.deepEqual(detected.cuts,[{start:5.5,end:8}]);
 const both=await findSilenceCuts([a,b],new Set([a]),ffmpeg,undefined,1,true,true);assert.deepEqual(both.cuts,[{start:2,end:4},{start:5.5,end:8}]);
 await cutSharedSilence([a,b],detected.cuts,detected.duration,'pcm_s16le',ffmpeg);assert.equal((await findSilenceCuts([a,b],new Set([a]),ffmpeg)).duration,5.5);
 await writeFile(a,wav(2,[]));assert.deepEqual((await findSilenceCuts([a],new Set([a]),ffmpeg,undefined,30,true,false)).cuts,[]);
 await writeFile(a,wav(2,[[0,2]]));assert.deepEqual((await findSilenceCuts([a],new Set([a]),ffmpeg,undefined,30,true,false)).cuts,[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('project exports trim the same tail on all tracks, preserve originals/intro and omit removed notes and cue positions',async()=>{
 const {RecordingSession}=require('../dist/recording/session'),{OpusEncoder}=require('@discordjs/opus'),{exportSession}=require('../dist/exports/export'),{uploadIntroChunk}=require('../dist/exports/server-intro');
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-end-export-'));
 try{const session=await RecordingSession.create(root,'guild','voice'),encoder=new OpusEncoder(48000,2),audio=pcm(6,[[0,1],[2,2.5]]);
 for(let i=0;i<300;i++){const frame=audio.subarray(i*3840,(i+1)*3840);await session.append(encoder.encode(frame),'human','Human',i*960,BigInt(i*960+1),frame);}
 await session.note('Internal quiet pause','human',72001n);await session.note('Removed tail note','human',264001n);await session.close();
 await writeFile(path.join(session.directory,'sync-cues.json'),JSON.stringify({cues:[{id:'late',state:'captured',seconds:5.5}]}));
 const intro=await uploadIntroChunk(root,'guild',{index:0,bytes:wav(.2,[[0,.2]]).toString('base64'),final:true,name:'Intro.wav'});
 const base=await exportSession(root,session.id,{format:'flac'});
 const target=await exportSession(root,session.id,{format:'audition',mix:true,trimEndSilence:true,includeRaw:true,introID:intro.id});
 const manifest=JSON.parse(await readFile(path.join(target,'manifest.json')));assert.equal(manifest.trimEndSilence,true);assert.deepEqual(manifest.silenceCuts,[{start:3,end:6}]);
 assert.deepEqual(await readFile(path.join(target,'raw-track-1.flac')),await readFile(path.join(base,'track-1.flac')));
 for(const file of ['track-1.flac','mix.flac']){const result=await findSilenceCuts([path.join(target,file)],new Set(),ffmpeg);assert.ok(Math.abs(result.duration-3.2)<.001,file);}
 assert.equal((await findSilenceCuts([path.join(target,'track-2.flac')],new Set(),ffmpeg)).duration,.2);
 const notes=JSON.parse(await readFile(path.join(target,'notes.json')));assert.deepEqual(notes.map(note=>note.text),['Internal quiet pause']);assert.ok(Math.abs(notes[0].seconds-1.7)<.001);
 assert.equal(manifest.syncCues.cues[0].exportSeconds,null);assert.ok((await readFile(path.join(target,'project.zip'))).includes(Buffer.from('raw-track-1.flac')));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('end-trim jobs retain speaker selection, distinguish duplicates, and survive retry/restart',async()=>{
 const {RecordingSession}=require('../dist/recording/session'),{ExportQueue}=require('../dist/exports/jobs');const root=await mkdtemp(path.join(os.tmpdir(),'witness-end-jobs-'));let queue,restarted;
 const until=async predicate=>{for(let i=0;i<500;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Timed out');};
 try{const session=await RecordingSession.create(root,'guild','voice');await session.append(Buffer.from([0xf8,0xff,0xfe]),'one','One');await session.append(Buffer.from([0xf8,0xff,0xfe]),'two','Two');await session.close();
 queue=new ExportQueue(root,async(_,__,options)=>new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});}));await queue.load();
 const plain=await queue.enqueue(session.id,'guild','wav');await until(()=>plain.state==='running');
 const trimmed=await queue.enqueue(session.id,'guild','wav',false,{trimEndSilence:true,excludeFromMix:[2]});const duplicate=await queue.enqueue(session.id,'guild','wav',false,{trimEndSilence:true,excludeFromMix:[2]});assert.equal(trimmed.id,duplicate.id);assert.notEqual(trimmed.id,plain.id);assert.deepEqual(trimmed.excludeFromMix,[2]);
 await queue.cancel(trimmed.id,'guild');const retry=await queue.retry(trimmed.id,'guild');assert.equal(retry.trimEndSilence,true);assert.deepEqual(retry.excludeFromMix,[2]);
 const saved=JSON.parse(await readFile(path.join(root,'jobs',retry.id+'.json')));assert.equal(saved.trimEndSilence,true);
 await assert.rejects(queue.enqueue(session.id,'guild','wav',false,{trimEndSilence:true,sourceExport:'export-'+session.id}),/original recording download page/);
 await queue.close();const forwarded=[];restarted=new ExportQueue(root,async(_,__,options)=>{forwarded.push(options);throw Error('Fixture export failure');});await restarted.load();await until(()=>restarted.get(retry.id)?.state==='failed');assert.ok(forwarded.some(options=>options.trimEndSilence===true&&options.excludeFromMix[0]===2));
 }finally{await queue?.close();await restarted?.close();await rm(root,{recursive:true,force:true});}
});

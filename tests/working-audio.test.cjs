const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {RecordingSession}=require('../dist/recording/session'),{OpusEncoder}=require('@discordjs/opus'),{exportSession}=require('../dist/exports/export'),{usesWorkingAudio}=require('../dist/exports/formats'),{buildExportPlan}=require('../dist/exports/progress');
const ffmpeg=path.resolve(__dirname,'../bin/ffmpeg');
async function recording(root){
 const session=await RecordingSession.create(root,'guild','voice'),encoder=new OpusEncoder(48000,2);
 for(const [user,tone] of [['1',440],['2',660]])for(let frame=0;frame<100;frame++){const pcm=Buffer.alloc(3840);for(let n=0;n<960;n++){const v=Math.round(5000*Math.sin(2*Math.PI*tone*(frame*960+n)/48000));pcm.writeInt16LE(v,n*4);pcm.writeInt16LE(v,n*4+2);}await session.append(encoder.encode(pcm),user,'speaker'+user,frame*960,BigInt(frame*960));}
 await session.close();return session;
}
/** Records each audio-tool call while running the real one. */
async function loggingTool(root){const log=path.join(root,'tool.log'),tool=path.join(root,'ffmpeg');await fs.writeFile(tool,`#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${ffmpeg}' "$@"\n`,{mode:0o755});return {tool,calls:async()=>(await fs.readFile(log,'utf8')).trim().split('\n')};}
test('a processed lossy export encodes each output exactly once, from lossless working files',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-working-'));
 try{const session=await recording(root),{tool,calls}=await loggingTool(root),output=await exportSession(root,session.id,{format:'mp3',mix:true,normalizeAudio:true,cleanupAudio:true,ffmpegPath:tool});
  const encodes=(await calls()).filter(call=>call.includes('libmp3lame'));assert.equal(encodes.length,3,encodes.join('\n'));for(const call of encodes)assert.match(call,/-i \S+\.flac/);
  const manifest=JSON.parse(await fs.readFile(path.join(output,'manifest.json'),'utf8'));assert.deepEqual(manifest.tracks.map(track=>track.file),['track-1.mp3','track-2.mp3']);assert.equal(manifest.mix,'mix.mp3');assert.deepEqual(Object.keys(manifest.loudness.tracks).sort(),['mix.mp3','track-1.mp3','track-2.mp3']);
  const left=await fs.readdir(output);assert.equal(left.some(file=>file.endsWith('.flac')),false);execFileSync(ffmpeg,['-v','error','-i',path.join(output,'mix.mp3'),'-f','null','-']);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('an untouched Opus export still copies the original stream, and its mix encodes once',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-opus-'));
 try{const session=await recording(root),{tool,calls}=await loggingTool(root),output=await exportSession(root,session.id,{format:'ogg',mix:true,ffmpegPath:tool});
  const encodes=(await calls()).filter(call=>call.includes('libopus'));assert.equal(encodes.length,1,encodes.join('\n'));assert.match(encodes[0],/amix/);assert.ok((await fs.stat(path.join(output,'track-1.ogg'))).size>0);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('FLAC and unprocessed exports do not add a working stage',()=>{
 assert.equal(usesWorkingAudio('flac',{normalizeAudio:true,mix:true}),false);assert.equal(usesWorkingAudio('wav',{mix:true}),false);assert.equal(usesWorkingAudio('ogg',{mix:true}),false);assert.equal(usesWorkingAudio('mp3',{}),false);
 assert.equal(usesWorkingAudio('mp3',{mix:true}),true);assert.equal(usesWorkingAudio('ogg',{mix:true,trimEnd:5}),true);assert.equal(usesWorkingAudio('ogg',{mix:true},true),true);assert.equal(usesWorkingAudio('wav',{cleanupAudio:true}),true);assert.equal(usesWorkingAudio('aac',{reduceBleed:true}),true);
});
test('the export plan includes final encodes and bleed work in pipeline order',()=>{
 const ids=buildExportPlan([{track:1,id:'a'},{track:2,id:'witness-sync'}],10,10,0,'mp3',{workingAudio:true,reduceBleed:true,mix:true,edits:{tracks:[{track:1,clips:[{at:0,start:0,end:5}]}]}}).map(task=>task.id);
 assert.ok(ids.indexOf('bleed-scan:1')<ids.indexOf('bleed:1'));assert.ok(ids.indexOf('bleed:1')<ids.indexOf('edit:1'));assert.ok(ids.indexOf('edit:1')<ids.indexOf('mix'));assert.ok(ids.indexOf('mix')<ids.indexOf('final:1'));assert.ok(ids.includes('final:mix'));assert.equal(ids.includes('bleed-scan:2'),false);
});
test('short edits reserve the full pre-edit timeline and editor bleed copies',async()=>{
 const {estimateExportBytes}=require('../dist/exports/storage');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-working-space-'));
 try{await fs.mkdir(path.join(root,'session'));await fs.writeFile(path.join(root,'session','session.json'),JSON.stringify({durationSamples:48000*3600,tracks:[{track:1},{track:2}]}));
  const edits={tracks:[1,2].map(track=>({track,clips:[{start:0,end:1,at:0}]}))},job={sessionID:'session',guildID:'guild',format:'mp3',mix:false,edits};
  assert.ok(await estimateExportBytes(root,job)>2*3600*140000,'full working timeline must be reserved');
  const plain=await estimateExportBytes(root,{...job,sourceExport:'export-source'}),bleed=await estimateExportBytes(root,{...job,sourceExport:'export-source',reduceBleed:true});
  assert.ok(bleed-plain>=2*3600*140000,'editor analysis copies must be reserved');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('processed browser-mic lossy exports read PCM and render edits after all tracks are prepared',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-working-pcm-'));
 try{const session=await recording(root),directory=path.join(root,session.id),metadataFile=path.join(directory,'session.json'),metadata=JSON.parse(await fs.readFile(metadataFile));metadata.tracks[0].pcmFile='browser-track-1.pcm';metadata.tracks[0].pcmStart=metadata.audioOrigin??0;await fs.writeFile(metadataFile,JSON.stringify(metadata));await fs.writeFile(path.join(directory,'browser-track-1.pcm'),Buffer.alloc(48000*2*4));
  const {tool,calls}=await loggingTool(root),edits={version:1,notes:[],tracks:[1,2].map(track=>({track,name:'speaker'+track,gainDb:0,pan:0,muted:false,solo:false,clips:[{id:'c'+track,at:0,start:0,end:1,fadeIn:0,fadeOut:0}]}))};
  await exportSession(root,session.id,{format:'mp3',reduceBleed:true,edits,ffmpegPath:tool});const commands=await calls();assert.ok(commands.some(call=>call.includes('-f s16le')&&call.includes('browser-track-1.pcm')&&call.includes('track-1.flac')));
  const scans=commands.map((call,i)=>call.includes('-ar 8000')?i:-1).filter(i=>i>=0),firstEdit=commands.findIndex(call=>call.includes('edited-track-'));assert.equal(scans.length,2);assert.ok(firstEdit>Math.max(...scans),'all microphones must be compared before edits');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

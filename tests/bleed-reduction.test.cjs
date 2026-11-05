const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {reduceBleed,bleedGains,BLEED_ATTENUATION_DB}=require('../dist/exports/bleed'),{RecordingSession}=require('../dist/recording/session'),{OpusEncoder}=require('@discordjs/opus'),{exportSession}=require('../dist/exports/export'),{ExportQueue}=require('../dist/exports/jobs');
const ffmpeg=path.resolve(__dirname,'../bin/ffmpeg'),RATE=48000;
/** Syllable-like bursts of filtered noise; each seed gives a different rhythm and spectrum, as different speech would. */
function voice(seconds,seed){
 const out=new Float32Array(seconds*RATE);let state=seed>>>0,low=0,band=0,gain=0,left=0,target=0,shape=.1;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/2**32;};
 for(let n=0;n<out.length;n++){if(left--<=0){left=Math.round((.06+random()*.22)*RATE);target=random()<.3?0:.2+random()*.8;shape=.03+random()*.3;}gain+=(target-gain)*.002;const white=random()*2-1;low+=shape*(white-low);band+=.5*(low-band);out[n]=(low-band*.6)*gain*.5;}
 return out;
}
const silence=(track,from,to)=>track.fill(0,from*RATE,to*RATE);
/** own voice, plus the other voice lowered and delayed as a neighbouring microphone would hear it, plus faint noise. */
function microphone(own,other,bleedDb,delayMs,seed){let state=seed>>>0;const delay=Math.round(delayMs*48),gain=10**(bleedDb/20),out=new Float32Array(own.length);for(let n=0;n<own.length;n++){state=(Math.imul(state,1664525)+1013904223)>>>0;out[n]=own[n]+(n>=delay?other[n-delay]*gain:0)+(state/2**32-.5)*.0004;}return out;}
function wav(samples){const b=Buffer.alloc(44+samples.length*8);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(3,20);b.writeUInt16LE(2,22);b.writeUInt32LE(RATE,24);b.writeUInt32LE(RATE*8,28);b.writeUInt16LE(8,32);b.writeUInt16LE(32,34);b.write('data',36);b.writeUInt32LE(samples.length*8,40);for(let n=0;n<samples.length;n++){b.writeFloatLE(samples[n],44+n*8);b.writeFloatLE(samples[n],48+n*8);}return b;}
const decode=file=>{const b=execFileSync(ffmpeg,['-v','error','-i',file,'-ac','1','-c:a','pcm_f32le','-f','f32le','-'],{maxBuffer:1e9});return new Float32Array(b.buffer.slice(b.byteOffset,b.byteOffset+b.length));};
const rms=(x,from,to)=>{let sum=0;for(let n=from*RATE;n<to*RATE;n++)sum+=x[n]*x[n];return 10*Math.log10(sum/((to-from)*RATE)+1e-12);};
test('turns down bleed while a neighbour talks and keeps own speech, length and timing',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-bleed-'));
 try{
  // Speaker A alone 0-10 s, speaker B alone 10-20 s, both talking 20-30 s.
  const a=voice(30,11),b=voice(30,77);silence(a,10,20);silence(b,0,10);
  const files=[path.join(root,'track-1.flac'),path.join(root,'track-2.flac')];
  for(const [index,samples] of [microphone(a,b,-18,12,3),microphone(b,a,-18,12,5)].entries()){const source=path.join(root,`m${index}.wav`);await fs.writeFile(source,wav(samples));execFileSync(ffmpeg,['-v','error','-i',source,'-c:a','flac',files[index]]);}
  const before=files.map(decode),report=await reduceBleed(files.map((file,i)=>({key:path.basename(file),file,username:'s'+i})),30,'flac',ffmpeg),after=files.map(decode);
  assert.equal(after[0].length,before[0].length);assert.equal(after[1].length,before[1].length);
  const change=(track,from,to)=>rms(after[track],from,to)-rms(before[track],from,to);
  assert.ok(change(1,1,9)<-10,`B's mic, A alone: ${change(1,1,9)}`);assert.ok(change(0,11,19)<-10,`A's mic, B alone: ${change(0,11,19)}`);
  assert.ok(Math.abs(change(0,1,9))<.5,`A's own speech: ${change(0,1,9)}`);assert.ok(Math.abs(change(1,11,19))<.5,`B's own speech: ${change(1,11,19)}`);
  assert.ok(change(0,21,29)>-2,`A overlap: ${change(0,21,29)}`);assert.ok(change(1,21,29)>-2,`B overlap: ${change(1,21,29)}`);
  assert.ok(report['track-1.flac'].reducedSeconds>5);assert.ok(report['track-2.flac'].reducedSeconds>5);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('leaves unrelated speakers alone, including a quiet talker beside a loud one',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-bleed-clean-'));
 try{
  const loud=voice(20,21),quiet=voice(20,99).map(value=>value*.1),files=[path.join(root,'track-1.flac'),path.join(root,'track-2.flac')];
  for(const [index,samples] of [loud,quiet].entries()){const source=path.join(root,`m${index}.wav`);await fs.writeFile(source,wav(samples));execFileSync(ffmpeg,['-v','error','-i',source,'-c:a','flac',files[index]]);}
  const before=files.map(decode);await reduceBleed(files.map((file,i)=>({key:path.basename(file),file,username:'s'+i})),20,'flac',ffmpeg);const after=files.map(decode);
  assert.ok(rms(after[1],0,20)-rms(before[1],0,20)>-1.5,'quiet speech was turned down');assert.ok(Math.abs(rms(after[0],0,20)-rms(before[0],0,20))<.1);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('a single speaker is never changed, and gain changes are smooth',async()=>{
 const report=await reduceBleed([{key:'track-1.flac',file:'/nonexistent',username:'solo'}],1,'flac',ffmpeg);assert.deepEqual(report,{'track-1.flac':{reducedSeconds:0}});
 const mask=new Uint8Array(200);mask.fill(1,50,150);const gains=bleedGains(mask);assert.ok(Math.abs(gains[100]-10**(-BLEED_ATTENUATION_DB/20))<.001);assert.ok(gains[5]>.99&&gains[195]>.99);for(let n=1;n<200;n++)assert.ok(Math.abs(20*Math.log10(gains[n]/gains[n-1]))<BLEED_ATTENUATION_DB);
});
test('exports report the option and queue it distinctly',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-bleed-export-'));let queue;
 try{const session=await RecordingSession.create(root,'guild','voice'),encoder=new OpusEncoder(48000,2);for(const [user,tone] of [['1',440],['2',660]])for(let frame=0;frame<100;frame++){const pcm=Buffer.alloc(3840);for(let n=0;n<960;n++){const v=Math.round(3000*Math.sin(2*Math.PI*tone*(frame*960+n)/48000));pcm.writeInt16LE(v,n*4);pcm.writeInt16LE(v,n*4+2);}await session.append(encoder.encode(pcm),user,'speaker'+user,frame*960,BigInt(frame*960));}await session.close();
  const output=await exportSession(root,session.id,{format:'mp3',reduceBleed:true,includeRaw:true,mix:true}),manifest=JSON.parse(await fs.readFile(path.join(output,'manifest.json'),'utf8'));
  assert.equal(manifest.bleedReduction.preset,'cross-track-gate-v1');assert.deepEqual(Object.keys(manifest.bleedReduction.tracks).sort(),['track-1.mp3','track-2.mp3']);
  const plain=await exportSession(root,session.id,{format:'mp3'});assert.equal(JSON.parse(await fs.readFile(path.join(plain,'manifest.json'),'utf8')).bleedReduction,undefined);
  queue=new ExportQueue(root);await queue.load(false);const a=await queue.enqueue(session.id,'guild','wav',false,{reduceBleed:true}),b=await queue.enqueue(session.id,'guild','wav',false,{reduceBleed:false});assert.notEqual(a.id,b.id);await queue.cancel(a.id,'guild');const retry=await queue.retry(a.id,'guild');assert.equal(retry.reduceBleed,true);await queue.cancel(retry.id,'guild');await queue.cancel(b.id,'guild');
 }finally{await queue?.close();queue?.releaseIntroReferences();await fs.rm(root,{recursive:true,force:true});}
});
test('editor exports reduce bleed once, before edits move clips, and encode each output once',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-bleed-editor-'));
 try{const session=await RecordingSession.create(root,'guild','voice'),encoder=new OpusEncoder(48000,2);for(const [user,tone] of [['1',440],['2',660]])for(let frame=0;frame<100;frame++){const pcm=Buffer.alloc(3840);for(let n=0;n<960;n++){const v=Math.round(3000*Math.sin(2*Math.PI*tone*(frame*960+n)/48000));pcm.writeInt16LE(v,n*4);pcm.writeInt16LE(v,n*4+2);}await session.append(encoder.encode(pcm),user,'speaker'+user,frame*960,BigInt(frame*960));}await session.close();
  const log=path.join(root,'tool.log'),tool=path.join(root,'ffmpeg');await fs.writeFile(tool,`#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${ffmpeg}' "$@"\n`,{mode:0o755});
  const source=await exportSession(root,session.id,{format:'flac'}),clip=track=>({track,name:'speaker'+track,gainDb:0,pan:0,muted:false,solo:false,clips:[{id:'c'+track,at:track===2?.5:0,start:0,end:1,fadeIn:0,fadeOut:0}]}),edits={version:1,tracks:[clip(1),clip(2)],notes:[]};
  const first=await exportSession(root,session.id,{format:'mp3',mix:true,sourceExport:path.basename(source),edits,reduceBleed:true,ffmpegPath:tool}),manifest=JSON.parse(await fs.readFile(path.join(first,'manifest.json'),'utf8'));
  assert.deepEqual(Object.keys(manifest.bleedReduction.tracks).sort(),['track-1.mp3','track-2.mp3']);assert.deepEqual(manifest.tracks.map(track=>track.file),['track-1.mp3','track-2.mp3']);assert.equal(manifest.mix,'mix.mp3');
  assert.equal((await fs.readFile(log,'utf8')).split('\n').filter(call=>call.includes('libmp3lame')).length,3);
  assert.equal((await fs.readdir(first)).some(file=>file.endsWith('.flac')),false);
  await fs.rm(log);const second=await exportSession(root,session.id,{format:'mp3',sourceExport:path.basename(first),edits,reduceBleed:true,ffmpegPath:tool});assert.deepEqual(JSON.parse(await fs.readFile(path.join(second,'manifest.json'),'utf8')).bleedReduction,manifest.bleedReduction);assert.equal((await fs.readFile(log,'utf8')).includes('bleed-source'),false);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('matching and skipped bleed comparisons yield to recording callbacks and cancellation',async()=>{
 const {findBleed}=require('../dist/exports/bleed');
 const frames=100000,envelope=offset=>({levels:Uint8Array.from({length:frames},(_,i)=>80+offset+i%17),bands:Uint8Array.from({length:frames*6},(_,i)=>50+offset+i%31)});
 for(const envelopes of [[envelope(0),envelope(20)],Array.from({length:12},()=>({levels:new Uint8Array(frames),bands:new Uint8Array(frames*6)}))]){
  const controller=new AbortController();let callback=false;
  setImmediate(()=>{callback=true;controller.abort(new Error('recording callback ran'));});
  await assert.rejects(findBleed(envelopes,controller.signal),/recording callback ran/);assert.equal(callback,true);
 }
});

const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {mkdtemp,writeFile,readFile,chmod,rm}=require('node:fs/promises'),{spawnSync}=require('node:child_process');
const {RecordingSession}=require('../dist/recording/session'),{OpusEncoder}=require('@discordjs/opus'),{ExportQueue}=require('../dist/exports/jobs');
const {nonSpeech,transcribeExport}=require('../dist/integrations/transcription');
const until=async(fn,label)=>{for(let i=0;i<3000;i++){if(fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('Timed out: '+label);};
async function recording(root){const session=await RecordingSession.create(root,'g','voice'),encoder=new OpusEncoder(48000,2);for(let i=0;i<25;i++){const pcm=Buffer.alloc(3840);for(let s=0;s<960;s++){const x=Math.round(2000*Math.sin((i*960+s)*2*Math.PI*440/48000));pcm.writeInt16LE(x,s*4);pcm.writeInt16LE(x,s*4+2);}await session.append(encoder.encode(pcm),'user','Alice',i*960,BigInt(i*960),pcm);}await session.close();return session.id;}

test('Whisper non-speech labels are dropped; labelled speech is kept',()=>{
 for(const text of ['[BLANK_AUDIO]',' [ Silence ] ','(engine revving)','[MUSIC] (applause)','♪ ♪','*sigh*','  '])assert.equal(nonSpeech(text),true,text);
 for(const text of ['Hello','(laughs) Okay, fine','[inaudible] we should go','It costs 5 gold','¿Qué?'])assert.equal(nonSpeech(text),false,text);
});

test('a queued Soundcraft export with both backups and a transcript re-packages one copy of each track plus the transcript',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-sweep-pipeline-'));const saved={...process.env};let queue;
 try{const id=await recording(root);
  const executable=path.join(root,'recognizer'),model=path.join(root,'model.bin');await writeFile(model,'m');
  await writeFile(executable,'#!'+process.execPath+'\nconst fs=require("node:fs"),args=process.argv.slice(2);if(args.includes("--help")){console.log("--vad-model");process.exit(0);}fs.writeFileSync(args[args.indexOf("-of")+1]+".json",JSON.stringify({transcription:[{offsets:{from:0,to:400},text:" Spoken words"},{offsets:{from:100,to:300},text:" [ Silence ]"}]}));\n');await chmod(executable,0o755);
  Object.assign(process.env,{TRANSCRIPTION_EXECUTABLE:executable,TRANSCRIPTION_MODEL:model,TRANSCRIPTION_VAD_MODEL:'off',FFMPEG_PATH:path.join(__dirname,'../bin/ffmpeg')});
  queue=new ExportQueue(root);await queue.load(false);queue.setSoundcraftBackupPolicy(()=>'ask');
  const job=await queue.enqueue(id,'g','soundcraft',false,{transcribe:true,backupProjects:['audacity','audition']});queue.start();
  await until(()=>['completed','failed'].includes(queue.get(job.id).state),'export');assert.equal(queue.get(job.id).state,'completed',queue.get(job.id).error);
  const zip=path.join(root,id,queue.get(job.id).directory,'project.zip');
  const listed=spawnSync('python3',['-I','-c','import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps(sorted(z.namelist())))',zip],{encoding:'utf8'});assert.equal(listed.status,0,listed.stderr);
  const names=JSON.parse(listed.stdout);
  for(const name of ['session.scraft','backup-audition.sesx','backup-audacity.aup','BACKUP-PROJECTS.txt','transcript.txt','transcript.srt','transcript.vtt','backup-audacity_data/Alice.wav','manifest.json'])assert.ok(names.includes(name),name+' in '+names);
  assert.deepEqual(names.filter(name=>/\.(wav|flac)$/.test(name)),['backup-audacity_data/Alice.wav'],'one copy of the audio');
  const transcript=await readFile(path.join(root,id,queue.get(job.id).directory,'transcript.txt'),'utf8');assert.match(transcript,/Spoken words/);assert.ok(!/Silence/.test(transcript));
 }finally{for(const key of ['TRANSCRIPTION_EXECUTABLE','TRANSCRIPTION_MODEL','TRANSCRIPTION_VAD_MODEL','FFMPEG_PATH'])if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];await queue?.close();queue?.releaseIntroReferences();await rm(root,{recursive:true,force:true});}
});

test('unreliable segments become [inaudible]: low token confidence, decoding loops, or speech not above the background',async()=>{
 const {unreliableSegment,buriedInNoise}=require('../dist/integrations/transcription');
 const tokens=(p,count=6)=>[{text:'[_BEG_]',p:0.1},...Array.from({length:count},(_,i)=>({text:' w'+i,p}))];
 assert.equal(unreliableSegment({text:'my fellow country in the news',tokens:tokens(0.52)}),true);
 assert.equal(unreliableSegment({text:'ask not what your country can do',tokens:tokens(0.86)}),false);
 assert.equal(unreliableSegment({text:'no token data at all'}),false,'older output is kept');
 const loopText='my fellow Americans and not my fellow Americans and you and my fellow Americans and you and';assert.equal(unreliableSegment({text:loopText,tokens:tokens(0.9)},{audibleSeconds:1.5}),true,'loop: too many words for its audio');assert.equal(unreliableSegment({text:loopText,tokens:tokens(0.53)},{audibleSeconds:6}),true,'the observed loop (p 0.53)');assert.equal(unreliableSegment({text:loopText,tokens:tokens(0.9)},{audibleSeconds:6}),false,'repetition alone is kept');
 assert.equal(unreliableSegment({text:'yeah yeah yeah yeah',tokens:tokens(0.9)}),false,'short repetition is ordinary speech');
 const steady=(n,value)=>Array.from({length:n},(_,i)=>value*(1+0.05*Math.sin(i)));
 const speechLike=(n,value)=>Array.from({length:n},(_,i)=>value*(i%3===0?20:i%3===1?3:0.5));
 let energy=steady(100,1e4);for(let i=40;i<60;i++)energy[i]*=1.4;assert.equal(buriedInNoise(energy,4,6),true,'faint, steady rise over steady noise');
 energy=steady(100,1e4);energy.splice(40,20,...speechLike(20,1e5));assert.equal(buriedInNoise(energy,4,6),false,'speech clearly above noise');
 assert.equal(buriedInNoise(speechLike(3000,1e5),100,110),false,'speech filling the whole chunk (background estimate is speech)');
 energy=Array(100).fill(0);for(let i=40;i<60;i++)energy[i]=1e3;assert.equal(buriedInNoise(energy,4,6),false,'digital-silence background');
 assert.equal(buriedInNoise(steady(30,1e4),0,3),false,'chunks under 5 s are not judged');
 // End to end with a fake recognizer: a garbled low-confidence segment and one over pure noise become [inaudible].
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-inaudible-'));
 try{const n=48000*6,b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);
  let seed=3;for(let i=0;i<n;i++){seed=(seed*1103515245+12345)&0x7fffffff;let x=(seed/0x7fffffff*2-1)*800;if(i<48000&&Math.floor(i/4800)%2===0)x+=Math.sin(i*2*Math.PI*300/48000)*12000;b.writeInt16LE(Math.round(x),44+i*2);}
  await writeFile(path.join(root,'track-1.wav'),b);await writeFile(path.join(root,'manifest.json'),JSON.stringify({tracks:[{file:'track-1.wav',userID:'u',username:'Alice'}]}));
  const executable=path.join(root,'recognizer');await writeFile(executable,'#!'+process.execPath+'\nconst fs=require("node:fs"),args=process.argv.slice(2);fs.writeFileSync(args[args.indexOf("-of")+1]+".json",JSON.stringify({transcription:[{offsets:{from:0,to:900},text:" Clear words",tokens:[{text:" Clear",p:0.9},{text:" words",p:0.95}]},{offsets:{from:2000,to:4000},text:" Invented over noise",tokens:[{text:" Invented",p:0.9}]},{offsets:{from:200,to:800},text:" Garbled",tokens:[{text:" Garbled",p:0.4}]}]}));\n');await chmod(executable,0o755);
  await transcribeExport(root,{executable,model:'m',ffmpeg:path.join(__dirname,'../bin/ffmpeg')});
  const text=await readFile(path.join(root,'transcript.txt'),'utf8');assert.match(text,/Alice: Clear words/);assert.ok(!/Invented|Garbled/.test(text),text);assert.equal(text.match(/\[inaudible\]/g).length,2,text);
 }finally{await rm(root,{recursive:true,force:true});}
});

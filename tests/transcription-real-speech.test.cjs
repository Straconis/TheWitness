// Accuracy check on natural speech, not synthetic tones. Runs only where whisper.cpp, base.en, the Silero model and
// whisper.cpp's own samples/jfk.wav are installed locally (all gitignored), and only when WITNESS_REAL_SPEECH=1, because it takes
// a few minutes of CPU: `WITNESS_REAL_SPEECH=1 node --test tests/transcription-real-speech.test.cjs`.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {mkdtemp,writeFile,readFile,rm}=require('node:fs/promises'),{existsSync}=require('node:fs'),{spawnSync}=require('node:child_process');
const {transcribeExport,transcriptionGainDb}=require('../dist/integrations/transcription');
const bin=path.resolve(__dirname,'../bin'),sample=path.resolve(__dirname,'../work/transcription/whisper.cpp/samples/jfk.wav');
const tools={executable:path.join(bin,'whisper-cli'),model:path.join(bin,'models/ggml-base.en.bin'),vad:path.join(bin,'models/ggml-silero-v6.2.0.bin'),ffmpeg:path.join(bin,'ffmpeg')};
const missing=[...Object.values(tools),sample].filter(file=>!existsSync(file));
const words=text=>text.toLowerCase().replace(/[^a-z' ]/g,' ').split(/\s+/).filter(Boolean);
const seconds=value=>{const [h,m,rest]=value.split(':'),[s,ms]=rest.split(',');return (+h*60+ +m)*60+ +s+ +ms/1000;};
// JFK speaks from about 0.3 s to 10.7 s of the sample; we place it 2 s into the track with 3 s of silence after it.
const SPEECH_START=2,SPEECH_END=12.7;

async function transcribe(attenuationDb,vad){
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-real-speech-'));
 try{
  const make=spawnSync(tools.ffmpeg,['-v','error','-i',sample,'-af',`volume=-${attenuationDb}dB,adelay=${SPEECH_START*1000}:all=1,apad=pad_dur=3`,'-ar','48000','-ac','2','-c:a','pcm_s16le',path.join(root,'track-1.wav')]);assert.equal(make.status,0,String(make.stderr));
  await writeFile(path.join(root,'manifest.json'),JSON.stringify({tracks:[{file:'track-1.wav',userID:'speaker',username:'JFK'}]}));
  await transcribeExport(root,{executable:tools.executable,model:tools.model,ffmpeg:tools.ffmpeg,threads:2,...(vad?{vadModel:tools.vad}:{})});
  const srt=existsSync(path.join(root,'transcript.srt'))?await readFile(path.join(root,'transcript.srt'),'utf8'):'';
  const cues=[...srt.matchAll(/(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)\nJFK: (.*)/g)].map(([,from,to,text])=>({from:seconds(from),to:seconds(to),text}));
  return {cues,words:words(cues.map(cue=>cue.text).join(' '))};
 }finally{await rm(root,{recursive:true,force:true});}
}

test('quiet natural speech keeps every word and its boundaries through silence filtering and VAD',{skip:process.env.WITNESS_REAL_SPEECH!=='1'?'set WITNESS_REAL_SPEECH=1 to run':missing.length?`needs ${missing.map(file=>path.basename(file)).join(', ')}`:false,timeout:900000},async()=>{
 for(const [db,vad] of [[30,false],[30,true],[40,true],[50,false],[50,true]]){
  const {cues,words:heard}=await transcribe(db,vad),label=`-${db} dB${vad?' with VAD':''}`;
  assert.ok(cues.length,label+': no transcript');
  // First and last words survive the padding, and the key phrase is complete (recognition errors such as "America" are allowed).
  for(const word of ['and','so','my','fellow','not','what','your','country','can','do','for','you'])assert.ok(heard.includes(word),`${label}: missing "${word}" in ${heard.join(' ')}`);
  assert.equal(heard.at(-1),'country',label);
  // Timing follows the speech: nothing starts in the leading silence or runs into the trailing silence.
  assert.ok(cues[0].from>=SPEECH_START-.2,`${label}: starts at ${cues[0].from}`);assert.ok(cues.at(-1).to<=SPEECH_END+.4,`${label}: ends at ${cues.at(-1).to}`);
  for(const cue of cues)assert.ok(cue.to>cue.from,label);
 }
});

test('the transcription boost is analysis-only and bounded',()=>{
 assert.equal(transcriptionGainDb(undefined),0);
 assert.equal(transcriptionGainDb({lufs:-16,truePeak:-1,lra:1,threshold:-26}),0,'already loud enough');
 assert.equal(transcriptionGainDb({lufs:-50,truePeak:-30,lra:1,threshold:-60}),29,'capped by peak headroom');
 assert.equal(transcriptionGainDb({lufs:-80,truePeak:-60,lra:0,threshold:-90}),40,'capped at 40 dB');
 assert.equal(transcriptionGainDb({lufs:-Infinity,truePeak:-50,lra:0,threshold:-Infinity}),40,'gated-out speech lifts the peak toward -6 dBFS');
 assert.equal(transcriptionGainDb({lufs:-Infinity,truePeak:-Infinity,lra:0,threshold:-Infinity}),0,'digital silence is not boosted');
});

test('noise-only tracks produce no transcript text, with or without VAD (boost and non-speech label filtering)',{skip:process.env.WITNESS_REAL_SPEECH!=='1'?'set WITNESS_REAL_SPEECH=1 to run':missing.length?'needs local whisper.cpp files':false,timeout:900000},async()=>{
 for(const vad of [false,true]){
  const root=await mkdtemp(path.join(os.tmpdir(),'witness-real-noise-'));
  try{
   // 20 s of low-passed white noise at about -55 dBFS RMS, no speech (the bundled FFmpeg has no noise generator).
   const n=48000*20,b=Buffer.alloc(44+n*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(192000,28);b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*4,40);
   let seed=7,low=0;for(let i=0;i<n;i++){seed=(seed*1103515245+12345)&0x7fffffff;low=.97*low+.03*(seed/0x7fffffff*2-1);const v=Math.round(low*32767*.03);b.writeInt16LE(v,44+i*4);b.writeInt16LE(v,46+i*4);}
   await writeFile(path.join(root,'track-1.wav'),b);await writeFile(path.join(root,'manifest.json'),JSON.stringify({tracks:[{file:'track-1.wav',userID:'speaker',username:'Noise'}]}));
   await transcribeExport(root,{executable:tools.executable,model:tools.model,ffmpeg:tools.ffmpeg,threads:2,...(vad?{vadModel:tools.vad}:{})});
   const text=existsSync(path.join(root,'transcript.txt'))?await readFile(path.join(root,'transcript.txt'),'utf8'):'';
   assert.ok(!/Noise:/.test(text),`${vad?'with':'without'} VAD: ${text}`);
  }finally{await rm(root,{recursive:true,force:true});}
 }
});

test('speech under background noise: intelligible speech keeps its words, buried speech becomes [inaudible] instead of invented words',{skip:process.env.WITNESS_REAL_SPEECH!=='1'?'set WITNESS_REAL_SPEECH=1 to run':missing.length?'needs local whisper.cpp files':false,timeout:1800000},async()=>{
 const jfk=spawnSync(tools.ffmpeg,['-v','error','-i',sample,'-ar','48000','-ac','1','-f','s16le','-'],{maxBuffer:1e8}).stdout;
 for(const [speechDb,vad,expect] of [[30,false,'words'],[30,true,'words'],[40,false,'inaudible'],[40,true,'inaudible']]){
  const root=await mkdtemp(path.join(os.tmpdir(),'witness-real-noisy-'));
  try{
   // Low-passed white noise (about -55 dBFS RMS) for 20 s, with JFK attenuated by speechDb starting at 4 s.
   const n=48000*20,b=Buffer.alloc(44+n*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(192000,28);b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*4,40);
   let seed=7,low=0;const gain=10**(-speechDb/20);for(let i=0;i<n;i++){seed=(seed*1103515245+12345)&0x7fffffff;low=.97*low+.03*(seed/0x7fffffff*2-1);let x=low*32767*.03;const j=i-48000*4;if(j>=0&&j*2<jfk.length)x+=jfk.readInt16LE(j*2)*gain;const v=Math.max(-32768,Math.min(32767,Math.round(x)));b.writeInt16LE(v,44+i*4);b.writeInt16LE(v,46+i*4);}
   await writeFile(path.join(root,'track-1.wav'),b);await writeFile(path.join(root,'manifest.json'),JSON.stringify({tracks:[{file:'track-1.wav',userID:'speaker',username:'JFK'}]}));
   await transcribeExport(root,{executable:tools.executable,model:tools.model,ffmpeg:tools.ffmpeg,threads:2,...(vad?{vadModel:tools.vad}:{})});
   const text=existsSync(path.join(root,'transcript.txt'))?await readFile(path.join(root,'transcript.txt'),'utf8'):'',label=`-${speechDb} dB under noise${vad?' with VAD':''}`;
   if(expect==='words')for(const word of ['fellow','country','do','for','you'])assert.ok(words(text).includes(word),`${label}: ${text}`);
   else{assert.ok(text.includes('[inaudible]'),`${label}: ${text}`);assert.ok(!/fellow|americans|news|used/i.test(text),`${label} invented words: ${text}`);}
  }finally{await rm(root,{recursive:true,force:true});}
 }
});

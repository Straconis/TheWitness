const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {mkdtemp,mkdir,writeFile,readFile,rm,chmod}=require('node:fs/promises'),{existsSync,readFileSync}=require('node:fs');
const config=require('../dist/integrations/transcription-config');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const KEYS=['TRANSCRIPTION_EXECUTABLE','TRANSCRIPTION_MODEL','TRANSCRIPTION_VAD_MODEL'];
/** A fake whisper-cli: logs each --help call, optionally sleeps (exec, so a kill reaches it), then prints its options. */
async function fakeWhisper(root,{sleep=0,vad=true}={}){
 const executable=path.join(root,'whisper'),calls=path.join(root,'calls'),model=path.join(root,'model.bin'),silero=path.join(root,'silero.bin');
 await writeFile(model,'m');await writeFile(silero,'v');
 await writeFile(executable,`#!/bin/sh\necho call >> "${calls}"\n${sleep?`sleep ${sleep}\n`:''}echo "${vad?'  -vm FNAME, --vad-model FNAME':'  -m FNAME, --model FNAME'}"\n`);await chmod(executable,0o755);
 Object.assign(process.env,{TRANSCRIPTION_EXECUTABLE:executable,TRANSCRIPTION_MODEL:model,TRANSCRIPTION_VAD_MODEL:silero});
 return {executable,count:()=>existsSync(calls)?readFileSync(calls,'utf8').trim().split('\n').length:0};
}
async function withProbeEnv(name,fn){const root=await mkdtemp(path.join(os.tmpdir(),'witness-probe-'+name+'-')),saved=Object.fromEntries(KEYS.map(key=>[key,process.env[key]])),warn=console.warn;console.warn=()=>{};
 config.resetVadProbes();config.configureVadProbe({timeoutMs:10000,backoffBaseMs:1000,backoffMaxMs:300000});
 try{await fn(root);}finally{config.resetVadProbes();console.warn=warn;for(const key of KEYS)if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];await rm(root,{recursive:true,force:true});}}

test('a slow whisper-cli probe never blocks the event loop; readiness answers immediately and becomes true when the probe finishes',async()=>withProbeEnv('loop',async root=>{
 const fake=await fakeWhisper(root,{sleep:1.5});
 const started=performance.now();assert.equal(config.transcriptionReady(),false,'not ready while unknown');const callMs=performance.now()-started;assert.ok(callMs<50,`transcriptionReady took ${callMs} ms`);
 // Timers keep firing on schedule while the probe sleeps.
 let lateBy=0;for(let i=0;i<20;i++){const due=performance.now()+50;await wait(50);lateBy=Math.max(lateBy,performance.now()-due);}
 assert.ok(lateBy<150,`a 50 ms timer ran ${lateBy.toFixed(0)} ms late during the probe`);
 assert.equal(await config.transcriptionReadyAsync(),true);assert.equal(config.transcriptionReady(),true);assert.equal(fake.count(),1);
}));

test('concurrent readiness checks share one probe, and a completed result is cached until the executable changes',async()=>withProbeEnv('share',async root=>{
 const fake=await fakeWhisper(root,{sleep:0.5});
 const answers=[];for(let i=0;i<50;i++)answers.push(config.transcriptionReady());assert.ok(answers.every(answer=>answer===false));
 const results=await Promise.all([...Array.from({length:10},()=>config.transcriptionReadyAsync()),...Array.from({length:5},()=>config.probeVad(fake.executable))]);
 assert.ok(results.every(Boolean));assert.equal(fake.count(),1,'one probe for 65 concurrent checks');
 for(let i=0;i<20;i++)assert.equal(config.transcriptionReady(),true);assert.equal(fake.count(),1,'cached');
 // Replacing the executable (new size/mtime) probes again; an older build without --vad is then reported not ready.
 await wait(20);await fakeWhisper(root,{vad:false});assert.equal(await config.transcriptionReadyAsync(),false);assert.equal(fake.count(),2);
 assert.equal(config.transcriptionReady(),false);assert.equal(fake.count(),2,'a definite "unsupported" is cached too');
 await assert.rejects(config.checkedTranscriptionConfig(),/does not support --vad/);
 // VAD off: no probe at all, ready immediately.
 process.env.TRANSCRIPTION_VAD_MODEL='off';assert.equal(config.transcriptionReady(),true);assert.equal(fake.count(),2);assert.equal((await config.checkedTranscriptionConfig()).vadModel,undefined);
}));

test('failed or timed-out probes back off instead of storming, and recover once the executable works',async()=>withProbeEnv('storm',async root=>{
 const fake=await fakeWhisper(root,{sleep:5});config.configureVadProbe({timeoutMs:100,backoffBaseMs:200,backoffMaxMs:400});
 const until=performance.now()+1500;let checks=0;while(performance.now()<until){config.transcriptionReady();checks++;await wait(5);}
 // Attempts near 0, 300, 800 and 1300 ms: about four, never one per check.
 assert.ok(checks>=30,'many page views');assert.ok(fake.count()>=2&&fake.count()<=5,`${fake.count()} probes for ${checks} checks`);
 // A job (one at a time) may probe during the backoff rather than fail on a stale failure; it gets exactly one probe.
 const before=fake.count();await assert.rejects(config.checkedTranscriptionConfig(),/Could not check whether whisper-cli supports --vad/);assert.ok(fake.count()<=before+1,'at most one probe for the job (it joins one already running)');
 assert.equal(config.transcriptionStatus(),'checking','unknown, not "not configured"');
 await wait(20);await fakeWhisper(root);await wait(450);assert.equal(await config.transcriptionReadyAsync(),true,'a working executable is probed after the backoff');
}));

test('shutdown stops probing: a running probe is killed and no new probe starts',async()=>withProbeEnv('stop',async root=>{
 const fake=await fakeWhisper(root,{sleep:30});
 const running=config.probeVad(fake.executable);await wait(100);const started=performance.now();config.stopVadProbes();
 assert.equal(await running,undefined);assert.ok(performance.now()-started<1000,'the probe was killed, not waited for');
 for(let i=0;i<10;i++)assert.equal(config.transcriptionReady(),false);await wait(50);assert.equal(fake.count(),1,'no probe after shutdown');
}));

test('the recording page and export submission do not wait for a pending probe',async()=>withProbeEnv('http',async root=>{
 const fake=await fakeWhisper(root,{sleep:3});
 const {DownloadService}=require('../dist/downloads/service'),{SettingsStore}=require('../dist/storage/settings'),{ExportQueue}=require('../dist/exports/jobs');
 const data=path.join(root,'recordings'),id=require('node:crypto').randomUUID();await mkdir(path.join(data,id),{recursive:true});await writeFile(path.join(data,id,'session.json'),JSON.stringify({id,guildID:'g',channelID:'c',startedAt:'2026-10-01T00:00:00Z',state:'completed',durationSamples:48000*60,tracks:[{track:1,id:'u',username:'Alice'}]}));
 const settings=new SettingsStore(path.join(data,'settings.json'));await settings.load();const queue=new ExportQueue(data);await queue.load(false);
 const service=await DownloadService.create(data,'https://example.com');service.attach(queue,settings,{sessions:new Map()});
 try{const port=await service.listen(0,'127.0.0.1'),link=service.recordingLink(id).replace('https://example.com',`http://127.0.0.1:${port}`);
  let started=performance.now();const page=await (await fetch(link)).text();assert.ok(performance.now()-started<1000);assert.match(page,/Transcription is not configured on this host yet/);
  started=performance.now();const response=await fetch(link,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({format:'wav',transcribe:true})});
  assert.equal(response.status,400);assert.match((await response.json()).error,/still being checked on this host/);assert.ok(performance.now()-started<1000);
  assert.equal(fake.count(),1,'one background probe for both requests');
  assert.equal(await config.transcriptionReadyAsync(),true);assert.match(await (await fetch(link)).text(),/Include a transcript with this download/);
 }finally{await service.close();await queue.close();queue.releaseIntroReferences();}
}));

// Repetition: legitimate dialogue is kept; only repetition with independent evidence of a decoding loop is suppressed.
test('repeated dialogue survives into TXT, SRT and VTT; decoding loops with independent evidence become [inaudible]',async()=>{
 const {unreliableSegment,transcribeExport}=require('../dist/integrations/transcription');
 const tokens=p=>[{text:'[_BEG_]',p:0.01},{text:' a',p},{text:' b',p},{text:' c',p}];
 const knowing="I don't know. I don't know. I don't know. I don't know.";
 assert.equal(unreliableSegment({text:knowing,tokens:tokens(0.99)},{audibleSeconds:4}),false,'GPT reproduction: confident, plausible pace');
 assert.equal(unreliableSegment({text:knowing,tokens:tokens(0.99)}),false,'no audio evidence: kept');
 assert.equal(unreliableSegment({text:knowing}),false,'no token data: kept');
 assert.equal(unreliableSegment({text:knowing,tokens:tokens(0.7)},{audibleSeconds:4}),true,'repetitive and weakly confident');
 assert.equal(unreliableSegment({text:knowing,tokens:tokens(0.99)},{audibleSeconds:1}),true,'12 words in 1 audible second');
 assert.equal(unreliableSegment({text:'my fellow country in the news',tokens:tokens(0.52)},{audibleSeconds:3}),true,'low confidence alone still suppresses');
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-repetition-'));
 try{
  // 30 s mono: speech-like bursts (300 ms tone, 100 ms gap) only where each segment should be audible; digital silence elsewhere.
  const audible=[[0,4],[5,9],[10,14],[15,19],[20,21],[22,26],[26.5,30]],n=48000*30,b=Buffer.alloc(44+n*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2,40);
  for(let i=0;i<n;i++){const t=i/48000;if(audible.some(([from,to])=>t>=from&&t<to)&&(t%0.4)<0.3)b.writeInt16LE(Math.round(8000*Math.sin(i*2*Math.PI*220/48000)),44+i*2);}
  await writeFile(path.join(root,'track-1.wav'),b);await writeFile(path.join(root,'manifest.json'),JSON.stringify({tracks:[{file:'track-1.wav',userID:'u',username:'Alice'}]}));
  const segment=(from,to,text,p)=>({offsets:{from:from*1000,to:to*1000},text:' '+text,...(p===undefined?{}:{tokens:[{text:'[_BEG_]',p:0.01},...text.split(' ').map(word=>({text:' '+word,p}))]})});
  const loop='my fellow Americans and you and my fellow Americans and you and my fellow Americans and you and my fellow Americans and you and my fellow Americans and you';
  const output={transcription:[
   segment(0,4,knowing,0.99),
   segment(5,9,'No, no, no, no, no, no, no, no, no, no, no, no.',0.95),
   segment(10,14,'One, two, one, two, one, two, one, two, one, two, one, two.',0.97),
   segment(15,19,'Roll again. Roll again. Roll again. Roll again. Roll again. Roll again.',0.96),
   segment(20,21,loop,0.9),
   segment(22,26,'and you and you and you and you and you and you and you',0.7),
   segment(26.5,30,'Left, left, left, right, left, left, left, right, left, left, left, right.')]};
  const executable=path.join(root,'recognizer');await writeFile(executable,'#!'+process.execPath+'\nconst fs=require("node:fs"),args=process.argv.slice(2);fs.writeFileSync(args[args.indexOf("-of")+1]+".json",'+JSON.stringify(JSON.stringify(output))+');\n');await chmod(executable,0o755);
  await transcribeExport(root,{executable,model:'m',ffmpeg:path.join(__dirname,'../bin/ffmpeg')});
  for(const format of ['txt','srt','vtt']){
   const text=await readFile(path.join(root,'transcript.'+format),'utf8');
   for(const kept of [knowing,'No, no, no, no, no, no, no, no, no, no, no, no.','One, two, one, two','Roll again. Roll again. Roll again. Roll again. Roll again. Roll again.','Left, left, left, right'])assert.ok(text.includes(kept),`${format} keeps "${kept}":\n${text}`);
   assert.equal((text.match(/\[inaudible\]/g)??[]).length,2,`${format}: the fast loop and the weakly confident loop:\n${text}`);assert.ok(!text.includes('my fellow Americans'),format);
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

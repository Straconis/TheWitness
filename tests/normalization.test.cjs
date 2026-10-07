const test=require('node:test'),assert=require('node:assert/strict'),{mkdtemp,writeFile,rm}=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {measureLevel,normalizationGain,matchLoudness}=require('../dist/exports/normalization');const ffmpeg=path.resolve(__dirname,'../bin/ffmpeg');
function wav(amplitude,seconds=3,active=seconds,frequency=440){const frames=48000*seconds,b=Buffer.alloc(44+frames*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(192000,28);b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(frames*4,40);for(let i=0;i<48000*active;i++){const v=Math.round(amplitude*Math.sin(i*2*Math.PI*frequency/48000));b.writeInt16LE(v,44+i*4);b.writeInt16LE(v,46+i*4);}return b;}
test('two-pass loudness matching balances levels, gates long pauses, preserves duration and measures true peak',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'witness-lufs-'));try{
 const loud=path.join(root,'loud.wav'),quiet=path.join(root,'quiet.wav'),paused=path.join(root,'paused.wav');
 await writeFile(loud,wav(16000));await writeFile(quiet,wav(2000));await writeFile(paused,wav(2000,12,3));
 const b=await measureLevel(quiet,ffmpeg),c=await measureLevel(paused,ffmpeg);assert.ok(Math.abs(b.lufs-c.lufs)<.5,'pauses are gated');
 for(const file of [loud,quiet,paused]){const report=await matchLoudness(file,'pcm_s16le',ffmpeg);assert.ok(Math.abs(report.after.lufs+16)<.5,JSON.stringify(report));assert.ok(report.after.truePeak<=-.9);}
 const {waveform}=require('../dist/downloads/waveforms');assert.equal((await waveform(paused)).duration,12);
 assert.equal(normalizationGain({lufs:-Infinity,truePeak:-Infinity}),1);assert.ok(normalizationGain({lufs:-60,truePeak:-30})<=10);assert.ok(normalizationGain({lufs:-30,truePeak:0})<1);
 }finally{await rm(root,{recursive:true,force:true});}});
test('frequency weighting matches perceived loudness and silence stays untouched',async()=>{const root=await mkdtemp(path.join(os.tmpdir(),'witness-weighting-'));try{
 const low=path.join(root,'low.wav'),high=path.join(root,'high.wav'),silent=path.join(root,'silent.wav');await writeFile(low,wav(4000,3,3,100));await writeFile(high,wav(4000,3,3,4000));const original=wav(0);await writeFile(silent,original);
 const a=await measureLevel(low,ffmpeg),b=await measureLevel(high,ffmpeg);assert.ok(b.lufs-a.lufs>2,'K weighting distinguishes equal-RMS frequencies');
 await matchLoudness(low,'pcm_s16le',ffmpeg);await matchLoudness(high,'pcm_s16le',ffmpeg);assert.ok(Math.abs((await measureLevel(low,ffmpeg)).lufs-(await measureLevel(high,ffmpeg)).lufs)<.3);
 const report=await matchLoudness(silent,'pcm_s16le',ffmpeg);assert.equal(report.before.lufs,-Infinity);assert.deepEqual(await require('node:fs/promises').readFile(silent),original);
 }finally{await rm(root,{recursive:true,force:true});}});

test('peak limiting handles a quiet track with a loud transient and boost caps protect faint audio',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-peak-'));try{
  const transient=path.join(root,'transient.wav'),faint=path.join(root,'faint.wav');const audio=wav(1200,6);for(let frame=96000;frame<96048;frame++){audio.writeInt16LE(frame%2?30000:-30000,44+frame*4);audio.writeInt16LE(frame%2?30000:-30000,46+frame*4);}await writeFile(transient,audio);const report=await matchLoudness(transient,'pcm_s16le',ffmpeg);assert.ok(Math.abs(report.after.lufs+16)<1,JSON.stringify(report));assert.ok(report.after.truePeak<=-.9,JSON.stringify(report));
  await writeFile(faint,wav(40));const capped=await matchLoudness(faint,'pcm_s16le',ffmpeg);assert.equal(capped.boostLimited,true);assert.ok(capped.after.lufs-capped.before.lufs<=20.5);assert.ok(capped.after.lufs<-16);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('custom loudness and true peak settings are validated and applied to real audio',async()=>{
 const {resolveLoudness}=require('../dist/exports/normalization');assert.deepEqual(resolveLoudness(),{targetLUFS:-16,maxTruePeakDBTP:-1});for(const settings of [{targetLUFS:NaN},{targetLUFS:-71},{targetLUFS:-4},{targetLUFS:'-16'},{maxTruePeakDBTP:1},{maxTruePeakDBTP:-10}])assert.throws(()=>resolveLoudness(settings));
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-custom-lufs-'));try{const file=path.join(root,'custom.wav');await writeFile(file,wav(2000));const report=await matchLoudness(file,'pcm_s16le',ffmpeg,undefined,undefined,{targetLUFS:-23,maxTruePeakDBTP:-3});assert.equal(report.targetLUFS,-23);assert.ok(Math.abs(report.after.lufs+23)<.5);assert.ok(report.after.truePeak<=-2.9);}finally{await rm(root,{recursive:true,force:true});}
});

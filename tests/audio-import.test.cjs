const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {execFileSync}=require('node:child_process');
const {exportSession}=require('../dist/exports/export');
const ffmpeg=path.resolve('bin/ffmpeg');
function pcm(file){return execFileSync(ffmpeg,['-v','error','-i',file,'-f','s16le','-ac','2','-ar','48000','pipe:1']);}
test('imported lossless tracks export without Craig files and preserve samples and originals',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-import-')),id=randomUUID(),dir=path.join(root,id);
 try{
  await fs.mkdir(dir);
  const source=path.join(dir,'source-track-1.flac');
  const samples=Buffer.alloc(48000*4);for(let i=0;i<48000;i++){const value=Math.round(Math.sin(i*440*2*Math.PI/48000)*4000);samples.writeInt16LE(value,i*4);samples.writeInt16LE(value,i*4+2);}execFileSync(ffmpeg,['-v','error','-f','s16le','-ar','48000','-ac','2','-i','pipe:0',source],{input:samples});
  const original=await fs.readFile(source);
  const metadata={id,guildID:'local',channelID:'import',startedAt:new Date().toISOString(),state:'completed',sourceType:'audio-import',durationSamples:48000,tracks:[{track:1,id:'speaker',username:'Speaker',sourceFile:'source-track-1.flac'}]};
  await fs.writeFile(path.join(dir,'session.json'),JSON.stringify(metadata));
  for(const format of ['flac','wav','ogg']){
   const out=await exportSession(root,id,{format,ffmpegPath:ffmpeg,includeRaw:true});
   assert.deepEqual(pcm(path.join(out,'raw-track-1.flac')),pcm(source));
   if(format!=='ogg')assert.deepEqual(pcm(path.join(out,`track-1.${format}`)),pcm(source));
   assert.deepEqual(await fs.readFile(source),original);
   assert.equal(JSON.parse(await fs.readFile(path.join(out,'manifest.json'))).tracks[0].username,'Speaker');
  }
  metadata.tracks[0].sourceFile='../outside.flac';await fs.writeFile(path.join(dir,'session.json'),JSON.stringify(metadata));
  await assert.rejects(exportSession(root,id,{format:'flac',ffmpegPath:ffmpeg}),/Invalid imported source/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

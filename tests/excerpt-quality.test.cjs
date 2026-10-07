const test=require('node:test');const assert=require('node:assert/strict');
const {mkdtemp,readFile,rm}=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {spawnSync}=require('node:child_process');
const {OpusEncoder}=require('@discordjs/opus');const {RecordingSession}=require('../dist/recording/session');const {exportSession}=require('../dist/exports/export');
const ffmpeg=process.env.FFMPEG_PATH||(require('node:fs').existsSync(path.resolve(__dirname,'../bin/ffmpeg'))?path.resolve(__dirname,'../bin/ffmpeg'):'ffmpeg');
test('lossless excerpts match the full export without another Opus generation',{skip:spawnSync(ffmpeg,['-version']).status!==0},async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-excerpt-'));
 try{
  const session=await RecordingSession.create(root,'guild','voice'),encoder=new OpusEncoder(48000,2),pcm=Buffer.alloc(3840);
  // Timestamps are explicit, so the recording does not depend on timer accuracy.
  for(let frame=0;frame<100;frame++){
   for(let i=0;i<960;i++){const n=frame*960+i,value=Math.round((Math.sin(n*2*Math.PI*440/48000)+0.5*Math.sin(n*2*Math.PI*1330/48000))*7000);pcm.writeInt16LE(value,i*4);pcm.writeInt16LE(value,i*4+2);}
   await session.append(encoder.encode(pcm),'alice','Alice',frame*960,BigInt(1+frame*960));
  }
  await session.close();
  const decode=async(directory,file)=>{const result=spawnSync(ffmpeg,['-v','error','-i',path.join(directory,file),'-f','s16le','-'],{maxBuffer:64*1024*1024});assert.equal(result.status,0,result.stderr?.toString());return result.stdout;};
  const full=await exportSession(root,session.id,{format:'wav',ffmpegPath:ffmpeg}),excerpt=await exportSession(root,session.id,{format:'wav',trimStart:0.5,trimEnd:1.5,ffmpegPath:ffmpeg});
  const track=JSON.parse(await readFile(path.join(full,'manifest.json'))).tracks[0].file;
  const whole=await decode(full,track),part=await decode(excerpt,track),offset=0.5*48000*4;
  assert.ok(Math.abs(part.length-48000*4)<=960*4,'excerpt is about one second long');
  let error=0,signal=0;for(let i=0;i+1<part.length&&offset+i+1<whole.length;i+=2){const a=whole.readInt16LE(offset+i),b=part.readInt16LE(i);error+=(a-b)**2;signal+=a**2;}
  assert.ok(signal>0);assert.ok(error/signal<1e-6,`excerpt differs from the full export (relative error ${(error/signal).toExponential(2)})`);
 }finally{await rm(root,{recursive:true,force:true});}
});

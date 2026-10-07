const test=require('node:test');const assert=require('node:assert/strict');
const {mkdtemp,readFile,rm}=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {spawnSync}=require('node:child_process');const {EventEmitter}=require('node:events');const {OpusEncoder}=require('@discordjs/opus');
const {RecordingSession}=require('../dist/recording/session');const {RecordingManager}=require('../dist/recording/manager');const {exportSession}=require('../dist/exports/export');const {deleteSession}=require('../dist/storage/delete');const {formatTranscript}=require('../dist/integrations/transcription');
const ffmpeg=path.resolve(__dirname,'../bin/ffmpeg');
test('browser WAV and FLAC preserve every original PCM sample and crop accurately',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-lossless-'));
 try{const session=await RecordingSession.create(root,'guild','voice');const encoder=new OpusEncoder(48000,2),frames=[];
 for(let frame=0;frame<20;frame++){const pcm=Buffer.alloc(3840);for(let i=0;i<960;i++){const value=Math.round(Math.sin((frame*960+i)*2*Math.PI*440/48000)*12000);pcm.writeInt16LE(value,i*4);pcm.writeInt16LE(value,i*4+2);}frames.push(pcm);await session.append(encoder.encode(pcm),'browser-user','Browser',frame*960,BigInt(frame*960),pcm);}
 await session.close();const expected=Buffer.concat(frames);
 for(const format of ['wav','flac']){const output=await exportSession(root,session.id,{format});const audio=spawnSync(ffmpeg,['-v','error','-i',path.join(output,`track-1.${format}`),'-f','s16le','-']);assert.equal(audio.status,0,audio.stderr.toString());assert.deepEqual(audio.stdout,expected);}
 const output=await exportSession(root,session.id,{format:'wav',trimStart:0.1,trimEnd:0.3});const audio=spawnSync(ffmpeg,['-v','error','-i',path.join(output,'track-1.wav'),'-f','s16le','-']);assert.equal(audio.status,0,audio.stderr.toString());assert.deepEqual(audio.stdout,expected.subarray(4800*4,14400*4));
 await assert.rejects(deleteSession(root,session.id,'other-guild'));await deleteSession(root,session.id,'guild');await assert.rejects(readFile(path.join(session.directory,'session.json')),{code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true});}
});
test('exhausted reconnect attempts finalize a failed recording with original audio intact',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-retry-'));const manager=new RecordingManager(root,[0,0]);
 try{const receiver=new EventEmitter(),voice=new EventEmitter();voice.receive=()=>receiver;voice.disconnect=()=>{};let attempts=0;
 const session=await manager.start({id:'guild',members:new Map()},'voice',voice,async()=>{attempts++;throw Error('offline');});receiver.emit('data',Buffer.from([0xf8,0xff,0xfe]),'user',0);voice.emit('disconnect',new Error('Network lost'));
 for(let i=0;i<100&&manager.sessions.size;i++)await new Promise(r=>setTimeout(r,10));assert.equal(attempts,2);assert.equal(manager.sessions.size,0);const metadata=JSON.parse(await readFile(path.join(session.directory,'session.json')));assert.equal(metadata.state,'failed');assert.equal(metadata.packets,1);assert.ok((await readFile(path.join(session.directory,'audio.ogg.data'))).length>0);
 }finally{await manager.shutdown();await rm(root,{recursive:true,force:true});}
});
test('subtitle outputs order speakers and preserve millisecond timestamps',()=>{
 const segments=[{start:61.234,end:62.5,text:' hello\nworld ',speaker:'Bob'},{start:0,end:1,text:'Start',speaker:'Alice'}];const srt=formatTranscript(segments,'srt');assert.ok(srt.startsWith('1\n00:00:00,000 --> 00:00:01,000\nAlice: Start'));assert.ok(srt.includes('00:01:01,234 --> 00:01:02,500\nBob: hello world'));assert.ok(formatTranscript(segments,'vtt').startsWith('WEBVTT\n\n'));assert.ok(formatTranscript(segments,'txt').includes('[00:01:01.234] Bob: hello world'));
});

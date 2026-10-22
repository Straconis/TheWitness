const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {mkdtemp,writeFile,readFile,readdir,chmod,rm}=require('node:fs/promises');
const {transcribeExport}=require('../dist/integrations/transcription');
function audio(active){const frames=48000*3,b=Buffer.alloc(44+frames*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(frames*2,40);if(active)for(let i=0;i<48000*.6;i++)b.writeInt16LE(Math.round(2000*Math.sin(i*2*Math.PI*440/48000)),44+i*2);return b;}
test('transcription skips silent speaker audio, intro music and cues, and removes hallucinations in quiet gaps',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-transcription-silence-'));
 try{
  await writeFile(path.join(root,'track-1.wav'),audio(true));await writeFile(path.join(root,'track-2.wav'),audio(false));await writeFile(path.join(root,'track-3.wav'),audio(true));await writeFile(path.join(root,'track-4.wav'),audio(true));
  await writeFile(path.join(root,'manifest.json'),JSON.stringify({tracks:[{file:'track-1.wav',userID:'speaker',username:'Alice'},{file:'track-2.wav',userID:'silent',username:'Bob'},{file:'track-3.wav',userID:'server-intro',username:'Music'},{file:'track-4.wav',userID:'witness-sync',username:'Sync cues'}]}));
  const executable=path.join(root,'recognizer'),argsFile=path.join(root,'calls.jsonl');await writeFile(executable,'#!'+process.execPath+'\nconst fs=require("node:fs"),args=process.argv.slice(2);fs.appendFileSync('+JSON.stringify(argsFile)+',JSON.stringify(args)+"\\n");fs.writeFileSync(args[args.indexOf("-of")+1]+".json",JSON.stringify({transcription:[{offsets:{from:100,to:400},text:"Actual words"},{offsets:{from:2000,to:2400},text:"Invented in silence"}]}));\n');await chmod(executable,0o755);
  await transcribeExport(root,{executable,model:'test-model',vadModel:'test-vad-model',ffmpeg:path.resolve(__dirname,'../bin/ffmpeg')});
  const text=await readFile(path.join(root,'transcript.txt'),'utf8');assert.match(text,/Alice: Actual words/);assert.ok(!text.includes('Invented'));assert.ok(!text.includes('Bob:'));assert.ok(!text.includes('Music:'));assert.ok(!text.includes('Sync cues:'));
  const calls=(await readFile(argsFile,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.length,1);assert.ok(calls[0].includes('--vad'));assert.equal(calls[0][calls[0].indexOf('--vad-model')+1],'test-vad-model');
  assert.ok(!(await readdir(root)).some(name=>name.startsWith('transcription-')));
 }finally{await rm(root,{recursive:true,force:true});}
});

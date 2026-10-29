const test=require('node:test'),assert=require('node:assert/strict'),{mkdtemp,readFile,rm}=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process'),{OpusEncoder}=require('@discordjs/opus');
const {RecordingSession}=require('../dist/recording/session'),{exportSession}=require('../dist/exports/export'),{archiveExport}=require('../dist/exports/archive');
const ffmpeg=path.resolve(__dirname,'../bin/ffmpeg');
// Two different people share a display name; a third uses a non-Latin name that ASCII-only names used to drop.
async function recording(root){const session=await RecordingSession.create(root,'guild','voice','General',undefined,'Court of Dorks'),encoder=new OpusEncoder(48000,2),pcm=Buffer.alloc(3840);
 for(let i=0;i<20;i++){await session.append(encoder.encode(pcm),'one','Alice',i*960,BigInt(i*960),pcm);await session.append(encoder.encode(pcm),'two','Alice',i*960,BigInt(i*960),pcm);await session.append(encoder.encode(pcm),'three','太郎/Taro',i*960,BigInt(i*960),pcm);}
 await session.close();return session;}
function python(script,...args){const result=spawnSync('python3',['-I','-c',script,...args],{encoding:'utf8',cwd:path.resolve(__dirname,'..')});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);}
const zipNames=file=>python('import zipfile,sys,json;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(json.dumps(z.namelist()))',file);
test('project ZIPs store speaker-named audio that the Audition project links to, with distinct duplicate names',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-speaker-files-'));
 try{const session=await recording(root),output=await exportSession(root,session.id,{format:'audition',ffmpegPath:ffmpeg});
  const result=python(`import zipfile,sys,json,xml.etree.ElementTree as ET
z=zipfile.ZipFile(sys.argv[1]);root=ET.fromstring(z.read('session.sesx'))
paths=[f.get('relativePath') for f in root.findall('./files/file')]
assert all(p in z.namelist() for p in paths)
print(json.dumps({'names':sorted(n for n in z.namelist() if n.endswith('.flac')),'paths':paths,'tracks':[t.find('./trackParameters/name').text for t in root.findall('./session/tracks/audioTrack')]}))`,path.join(output,'project.zip'));
  assert.deepEqual(result.paths,['Alice.flac','Alice (2).flac','太郎_Taro.flac']);assert.deepEqual(result.names,['Alice (2).flac','Alice.flac','太郎_Taro.flac']);
  assert.deepEqual(result.tracks,['Alice','Alice (2)','太郎/Taro']);
  // On-disk names stay stable for private URLs, the editor and older tooling.
  assert.deepEqual(JSON.parse(await readFile(path.join(output,'manifest.json'))).tracks.map(track=>track.file),['track-1.flac','track-2.flac','track-3.flac']);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('native Audacity projects name every track after its speaker, and raw and Discord ZIPs keep speaker filenames',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-speaker-aup3-'));
 try{const session=await recording(root),project=await exportSession(root,session.id,{format:'audacity',ffmpegPath:ffmpeg});
  const tracks=python(`import sys,json;sys.path.insert(0,'tests/helpers');from aup3 import native_project;c,p=native_project(sys.argv[1]);print(json.dumps([t.get('name') for t in p.iter('wavetrack')]))`,path.join(project,'session.aup3'));
  assert.deepEqual(tracks,['Alice','Alice','Alice (2)','Alice (2)','太郎/Taro','太郎/Taro']);
  const raw=await exportSession(root,session.id,{format:'wav',includeRaw:true,ffmpegPath:ffmpeg});
  assert.deepEqual(zipNames(path.join(raw,'project.zip')).filter(name=>/\.(wav|flac)$/.test(name)).sort(),['Alice (2) (uncut).flac','Alice (2).wav','Alice (uncut).flac','Alice.wav','太郎_Taro (uncut).flac','太郎_Taro.wav']);
  const ogg=await exportSession(root,session.id,{format:'ogg',ffmpegPath:ffmpeg}),archive=path.join(root,'discord.zip');
  await require('node:fs/promises').writeFile(archive,await archiveExport(ogg,8*1024*1024));
  assert.deepEqual(zipNames(archive).filter(name=>name.endsWith('.ogg')).sort(),['Alice (2).ogg','Alice.ogg','太郎_Taro.ogg']);
 }finally{await rm(root,{recursive:true,force:true});}
});

const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {mkdtemp,mkdir,writeFile,readFile,readdir,rm}=require('node:fs/promises'),{spawn}=require('node:child_process');
const intros=require('../dist/exports/server-intro');const {uploadIntroChunk,getServerIntro,withRecordingIntros,recordingIntroLockDepth,introInUse,resumeIntroWork}=intros;
const {ExportQueue}=require('../dist/exports/jobs'),{shutdownInOrder,introShutdownStages}=require('../dist/shutdown');
const {RecordingSession}=require('../dist/recording/session'),{OpusEncoder}=require('@discordjs/opus');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(fn,label)=>{for(let i=0;i<2000;i++){if(await fn())return;await wait(5);}throw Error('Timed out waiting for '+label);};
function wav(seconds){const n=Math.round(seconds*48000),b=Buffer.alloc(44+n*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(192000,28);b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*4,40);for(let i=0;i<n;i++){const x=Math.round(2000*Math.sin(i*2*Math.PI*440/48000));b.writeInt16LE(x,44+i*4);b.writeInt16LE(x,46+i*4);}return b;}
const upload=(name,extra={})=>({index:0,final:true,bytes:wav(.2).toString('base64'),name,...extra});
const uuid=()=>require('node:crypto').randomUUID();
async function session(root){const id=uuid();await mkdir(path.join(root,id),{recursive:true});await writeFile(path.join(root,id,'session.json'),JSON.stringify({id,guildID:'g',channelID:'c',startedAt:'2026-10-01T00:00:00Z',state:'completed',durationSamples:48000*60,tracks:[{track:1,id:'u',username:'Alice'}]}));return id;}
async function customIntros(root,id,names){const result=[];for(const name of names){result.push((await uploadIntroChunk(root,'g',upload(name),id)).id);await wait(20);}return result;}
async function hold(id){let release;const gate=new Promise(resolve=>{release=resolve;});const held=withRecordingIntros(id,()=>gate);await until(()=>recordingIntroLockDepth(id)===1,'gate');return {release,held};}
/** Claims D's slot now; returns a function that sends D's final chunk (conversion, then prune under the recording lock). */
async function startD(root,id){const audio=wav(.2),half=audio.length/2;const {id:upload}=await uploadIntroChunk(root,'g',{index:0,final:false,bytes:audio.subarray(0,half).toString('base64'),name:'D'},id);return ()=>uploadIntroChunk(root,'g',{id:upload,index:1,final:true,bytes:audio.subarray(half).toString('base64')},id);}
const drained=async()=>{try{await uploadIntroChunk('/nonexistent','g',upload('probe'));return false;}catch(error){return error.code==='INTRO_WORK_CLOSED';}};

test('shutdown keeps a persisted export\'s custom intro until a converting upload has finished pruning',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-shutdown-intro-'));let queue,restarted;
 try{const id=await session(root);const [a,b,c]=await customIntros(root,id,['A','B','C']);
  queue=new ExportQueue(root);await queue.load(false);
  const job=await queue.enqueue(id,'g','wav',false,{includeIntro:true,introScope:'recording',introID:a});
  const finishD=await startD(root,id),gate=await hold(id);
  // D converts while the gate is held, then waits to prune: lock depth 2.
  const finishing=finishD();await until(()=>recordingIntroLockDepth(id)===2,'D waiting to prune');
  // Shut down in the bot's order: exports close, downloads close, then intro uploads drain, then references are released.
  const order=[];const stages=[{name:'exports',close:async()=>{await queue.close();order.push('exports');}},{name:'downloads',close:()=>order.push('downloads')},...introShutdownStages(queue).map(stage=>({name:stage.name,close:async()=>{await stage.close();order.push(stage.name);}}))];
  const shutdown=shutdownInOrder(stages,(name,error)=>{throw error;});
  await until(drained,'drain to start');assert.deepEqual(order,['exports','downloads'],'references are still registered while D is pending');assert.ok(introInUse(a));
  gate.release();await gate.held;const d=(await finishing).id;await shutdown;
  assert.deepEqual(order,['exports','downloads','intro uploads','intro references','transcription probes']);
  for(const intro of [a,b,c,d])assert.ok(await getServerIntro(root,'g',intro,id),'A belongs to the persisted export; B, C, D are the newest three');
  assert.equal(introInUse(a),false,'the closed queue no longer registers references after release');
  // Restart: the saved job still references A, A exists, and the new queue protects it again.
  resumeIntroWork();restarted=new ExportQueue(root);await restarted.load(false);
  const saved=restarted.get(job.id);assert.equal(saved.state,'queued');assert.equal(saved.introID,a);assert.ok(introInUse(a));
  await uploadIntroChunk(root,'g',upload('E'),id);assert.ok(await getServerIntro(root,'g',a,id),'still protected after restart');assert.equal(await getServerIntro(root,'g',b,id),undefined,'unreferenced oldest pruned');
 }finally{resumeIntroWork();await queue?.close();queue?.releaseIntroReferences();await restarted?.close();restarted?.releaseIntroReferences();await rm(root,{recursive:true,force:true});}
});

test('shutdown error paths still drain uploads and release references last',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-shutdown-errors-'));let queue;
 try{const id=await session(root);queue=new ExportQueue(root);await queue.load(false);
  const failing=(await uploadIntroChunk(root,'g',{index:0,final:false,bytes:wav(.1).toString('base64'),name:'x'},id)).id;const gate=await hold(id);
  // A final chunk that fails during conversion (missing chunk 1) is still in flight while shutdown proceeds, and a stage throws.
  const broken=uploadIntroChunk(root,'g',{id:failing,index:2,final:true,bytes:wav(.1).toString('base64')},id);broken.catch(()=>{});
  const order=[],errors=[];
  const shutdown=shutdownInOrder([{name:'exports',close:async()=>{await queue.close();order.push('exports');throw Error('exports failed');}},{name:'downloads',close:async()=>{order.push('downloads');throw Error('downloads failed');}},...introShutdownStages(queue).map(stage=>({name:stage.name,close:async()=>{await stage.close();order.push(stage.name);}}))],name=>errors.push(name));
  gate.release();await gate.held;await shutdown;
  assert.deepEqual(order,['exports','downloads','intro uploads','intro references','transcription probes']);assert.deepEqual(errors,['exports','downloads']);
  await assert.rejects(broken,{code:'ENOENT'});await assert.rejects(uploadIntroChunk(root,'g',upload('late'),id),{code:'INTRO_WORK_CLOSED'});
  resumeIntroWork();assert.ok((await uploadIntroChunk(root,'g',upload('after restart'),id)).intro);
 }finally{resumeIntroWork();await queue?.close();queue?.releaseIntroReferences();await rm(root,{recursive:true,force:true});}
});

test('the bot shuts down intro uploads and references after downloads',async()=>{
 const source=await readFile(path.join(__dirname,'../src/index.ts'),'utf8');
 const downloads=source.indexOf('{name:"downloads"'),introStages=source.indexOf('...introShutdownStages(exportQueue)'),exports=source.indexOf('{name:"exports"');
 assert.ok(exports>0&&downloads>exports&&introStages>downloads,'exports, then downloads, then intro uploads and references');
 assert.ok(!/close\(\):Promise<void>\{this\.stopped=true;this\.unregisterIntroReferences/.test(await readFile(path.join(__dirname,'../src/exports/jobs.ts'),'utf8')),'close() must not release references');
});

// CLI: the real entry point in a child process, with its own recordings folder and settings.
async function recording(root){const session=await RecordingSession.create(root,'cli-guild','voice'),encoder=new OpusEncoder(48000,2);for(let i=0;i<10;i++){const pcm=Buffer.alloc(3840);for(let s=0;s<960;s++){const x=Math.round(2000*Math.sin((i*960+s)*2*Math.PI*440/48000));pcm.writeInt16LE(x,s*4);pcm.writeInt16LE(x,s*4+2);}await session.append(encoder.encode(pcm),'user','Alice',i*960,BigInt(i*960),pcm);}await session.close();return session.id;}
function cli(root,args){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(__dirname,'../dist/exports/cli.js'),...args],{cwd:root,env:{...process.env,RECORDING_PATH:root,FFMPEG_PATH:path.join(__dirname,'../bin/ffmpeg')}});let stdout='',stderr='';child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));});}
async function exported(result){assert.equal(result.code,0,result.stderr);const directory=/Export saved: (.*)/.exec(result.stdout)[1].trim();return {manifest:JSON.parse(await readFile(path.join(directory,'manifest.json'))),files:await readdir(directory)};}

test('CLI exports resolve Soundcraft backups against the recording\'s Discord-server setting',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-cli-backups-'));
 try{const id=await recording(root);const setMode=mode=>writeFile(path.join(root,'settings.json'),JSON.stringify({'cli-guild':{autoJoin:false,autoRecord:false,soundcraftBackup:mode},'other-guild':{autoJoin:false,autoRecord:false,soundcraftBackup:'both'}}));
  // No settings file: the default is Ask, which requires a choice.
  let result=await cli(root,[id,'soundcraft']);assert.equal(result.code,1);assert.match(result.stderr,/set to Ask\. Add --backup=audition, --backup=audacity, --backup=both or --backup=none/);
  await setMode('ask');
  result=await cli(root,[id,'soundcraft']);assert.equal(result.code,1);assert.match(result.stderr,/--backup=/);
  for(const [choice,expected] of [['audition',['audition']],['audacity',['audacity']],['both',['audition','audacity']],['none',undefined]]){
   const {manifest,files}=await exported(await cli(root,[id,'soundcraft',`--backup=${choice}`]));assert.deepEqual(manifest.backupProjects,expected,choice);
   assert.equal(files.includes('backup-audition.sesx'),!!expected?.includes('audition'),choice);assert.equal(files.includes('backup-audacity.aup'),!!expected?.includes('audacity'),choice);assert.ok(files.includes('session.scraft')&&files.includes('project.zip'));
  }
  // Fixed modes apply without a choice and reject a contradicting one; the other server's setting is not used.
  await setMode('audacity');assert.deepEqual((await exported(await cli(root,[id,'soundcraft']))).manifest.backupProjects,['audacity']);
  result=await cli(root,[id,'soundcraft','--backup=audacity']);assert.equal(result.code,0,result.stderr);
  result=await cli(root,[id,'soundcraft','--backup=both']);assert.equal(result.code,1);assert.match(result.stderr,/admin setting includes Audacity/);
  await setMode('both');assert.deepEqual((await exported(await cli(root,[id,'soundcraft','--mix']))).manifest.backupProjects,['audition','audacity']);
  await setMode('none');{const {manifest,files}=await exported(await cli(root,[id,'soundcraft']));assert.equal(manifest.backupProjects,undefined);assert.ok(!files.some(file=>file.startsWith('backup-')));}
  result=await cli(root,[id,'soundcraft','--backup=audition']);assert.equal(result.code,1);assert.match(result.stderr,/turned off/);
  // Ordinary audio and project exports are unchanged and never need a choice.
  await setMode('ask');
  for(const format of ['wav','flac','audition','audacity']){const {manifest}=await exported(await cli(root,[id,format]));assert.equal(manifest.format,format);assert.equal(manifest.backupProjects,undefined);}
  assert.ok((await exported(await cli(root,[id]))).manifest.tracks[0].file.endsWith('.ogg'),'default format is still Ogg');
  result=await cli(root,[id,'wav','--backup=both']);assert.equal(result.code,1);assert.match(result.stderr,/only available with Soundcraft/);
  result=await cli(root,[id,'soundcraft','--backup=premiere']);assert.equal(result.code,1);assert.match(result.stderr,/Unknown --backup choice/);
  result=await cli(root,[id,'soundcraft','--bakup=both']);assert.equal(result.code,1);assert.match(result.stderr,/Unknown option --bakup=both[\s\S]*Usage/);
  result=await cli(root,[]);assert.equal(result.code,1);assert.match(result.stderr,/Usage: npm run export/);
 }finally{await rm(root,{recursive:true,force:true});}
});

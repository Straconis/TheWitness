const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {mkdtemp,mkdir,writeFile,readFile,rm,chmod,utimes}=require('node:fs/promises');
const intros=require('../dist/exports/server-intro');const {uploadIntroChunk,getServerIntro,withRecordingIntros,recordingIntroLockDepth,MAX_CUSTOM_UPLOADS}=intros;
const {ExportQueue}=require('../dist/exports/jobs'),{DownloadService}=require('../dist/downloads/service'),{SettingsStore}=require('../dist/storage/settings');
const {editorPage}=require('../dist/downloads/editor-page'),{dashboardPage}=require('../dist/downloads/dashboard-page');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async(fn,label)=>{for(let i=0;i<1000;i++){if(fn())return;await wait(5);}throw Error('Timed out waiting for '+label);};
function wav(seconds){const n=Math.round(seconds*48000),b=Buffer.alloc(44+n*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(192000,28);b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*4,40);for(let i=0;i<n;i++){const x=Math.round(2000*Math.sin(i*2*Math.PI*440/48000));b.writeInt16LE(x,44+i*4);b.writeInt16LE(x,46+i*4);}return b;}
const upload=(name,extra={})=>({index:0,final:true,bytes:wav(.2).toString('base64'),name,...extra});
const uuid=()=>require('node:crypto').randomUUID();
async function session(root,guild='g',channel='c'){const id=uuid();await mkdir(path.join(root,id),{recursive:true});await writeFile(path.join(root,id,'session.json'),JSON.stringify({id,guildID:guild,channelID:channel,startedAt:'2026-10-01T00:00:00Z',state:'completed',durationSamples:48000*60,tracks:[{track:1,id:'u',username:'Alice'}]}));return id;}
async function customIntros(root,id,names){const result=[];for(const name of names){result.push((await uploadIntroChunk(root,'g',upload(name),id)).id);await wait(20);}return result;}
/** Holds the recording's critical section until release() so other operations queue behind it in a known order. */
async function hold(id){let release;const gate=new Promise(resolve=>{release=resolve;});const held=withRecordingIntros(id,()=>gate);await until(()=>recordingIntroLockDepth(id)===1,'gate');return {release,held};}

/** D's upload claims its slot now; only its final chunk (conversion, then prune) takes the lock later. */
async function startD(root,id){const audio=wav(.2),first=audio.subarray(0,audio.length/2),rest=audio.subarray(audio.length/2);const {id:upload}=await uploadIntroChunk(root,'g',{index:0,final:false,bytes:first.toString('base64'),name:'D'},id);return ()=>uploadIntroChunk(root,'g',{id:upload,index:1,final:true,bytes:rest.toString('base64')},id);}

test('an export accepted before a finishing upload prunes keeps its custom intro (enqueue first)',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-prune-race-a-'));let queue;
 try{const id=await session(root);const [a,b,c]=await customIntros(root,id,['A','B','C']);
  queue=new ExportQueue(root);await queue.load(false);const finishD=await startD(root,id);
  const gate=await hold(id);
  // 1. The export's validation queues first. 2. D's prune queues second (its conversion runs while the gate is held).
  const accepted=queue.enqueue(id,'g','wav',false,{includeIntro:true,introScope:'recording',introID:a});await until(()=>recordingIntroLockDepth(id)===2,'enqueue waiting');
  const finishing=finishD();await until(()=>recordingIntroLockDepth(id)===3,'prune waiting');
  gate.release();await gate.held;const job=await accepted;const d=(await finishing).id;
  assert.equal(job.introID,a);
  for(const intro of [a,b,c,d])assert.ok(await getServerIntro(root,'g',intro,id),'A is referenced by the accepted export; B, C, D are the newest three');
 }finally{await queue?.close();queue?.releaseIntroReferences();await rm(root,{recursive:true,force:true});}
});

test('an export that validates after a prune is rejected rather than accepted without its intro (prune first)',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-prune-race-b-'));let queue;
 try{const id=await session(root);const [a]=await customIntros(root,id,['A','B','C']);
  queue=new ExportQueue(root);await queue.load(false);const finishD=await startD(root,id);
  const gate=await hold(id);
  const finishing=finishD();await until(()=>recordingIntroLockDepth(id)===2,'prune waiting');
  const late=queue.enqueue(id,'g','wav',false,{includeIntro:true,introScope:'recording',introID:a});late.catch(()=>{});await until(()=>recordingIntroLockDepth(id)===3,'enqueue waiting');
  gate.release();await gate.held;await finishing;
  await assert.rejects(late,/Select or upload an intro/);assert.equal(await getServerIntro(root,'g',a,id),undefined);
  assert.equal([...queue.jobs.values()].length,0,'no job may be accepted for a missing intro');
 }finally{await queue?.close();queue?.releaseIntroReferences();await rm(root,{recursive:true,force:true});}
});

test('the sweeper never deletes a custom intro an accepted export uses, even across a pin',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-prune-race-c-'));let queue;
 try{const id=await session(root);const [a]=await customIntros(root,id,['A']);const old=new Date(Date.now()-72*3600000),pcm=intros.introPCM(root,'g',a,id);await utimes(pcm,old,old);await utimes(pcm.replace(/pcm$/,'json'),old,old);
  const unpin=intros.pinIntro(a);queue=new ExportQueue(root);await queue.load(false);
  const {sweepArtifacts}=require('../dist/exports/storage');await sweepArtifacts(root,[],new Set());assert.ok(await getServerIntro(root,'g',a,id),'pinned intro survives the sweep');
  const job=await queue.enqueue(id,'g','wav',false,{includeIntro:true,introScope:'recording',introID:a});unpin();
  await sweepArtifacts(root,[],new Set());assert.ok(await getServerIntro(root,'g',a,id),'intro of a registered job survives the sweep');
  await queue.cancel(job.id,'g');await queue.close();assert.ok(await getServerIntro(root,'g',a,id),'a closed queue keeps protecting until released');await sweepArtifacts(root,[],new Set());assert.ok(await getServerIntro(root,'g',a,id));queue.releaseIntroReferences();queue=undefined;await sweepArtifacts(root,[],new Set());assert.equal(await getServerIntro(root,'g',a,id),undefined,'unreferenced old intro is reclaimed');
 }finally{await queue?.close();queue?.releaseIntroReferences();await rm(root,{recursive:true,force:true});}
});

test('simultaneous custom-intro starts never exceed the per-recording cap, and slots are released or reclaimed',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-upload-slots-'));
 try{const id=await session(root),other=await session(root);
  const start=recording=>uploadIntroChunk(root,'g',{index:0,final:false,bytes:wav(.1).toString('base64'),name:'p'},recording);
  const results=await Promise.allSettled(Array.from({length:12},()=>start(id)));
  const started=results.filter(result=>result.status==='fulfilled').map(result=>result.value.id);
  assert.equal(started.length,MAX_CUSTOM_UPLOADS);assert.ok(results.filter(result=>result.status==='rejected').every(result=>/already in progress/.test(result.reason.message)));
  assert.equal((await Promise.allSettled(Array.from({length:6},()=>start(other)))).filter(result=>result.status==='fulfilled').length,MAX_CUSTOM_UPLOADS,'other recordings have their own slots');
  await assert.rejects(start(id),/already in progress/);
  // Finishing an upload releases its slot.
  const done=await uploadIntroChunk(root,'g',{id:started[0],index:1,final:true,bytes:wav(.1).toString('base64')},id);assert.ok(done.intro);
  const replacement=await start(id);assert.ok(replacement.id);await assert.rejects(start(id),/already in progress/);
  // A failed conversion also releases its slot.
  await assert.rejects(uploadIntroChunk(root,'g',{id:started[1],index:2,final:true,bytes:wav(.1).toString('base64')},id),{code:'ENOENT'});
  const afterFailure=(await Promise.allSettled([start(id),start(id)])).filter(result=>result.status==='fulfilled');assert.equal(afterFailure.length,1);
  // A stale slot is reclaimed by the next start, under the same lock.
  const [scope]=await require('node:fs/promises').readdir(path.join(root,id,'intros')),old=new Date(Date.now()-2*3600000);await utimes(path.join(root,id,'intros',scope,'upload-'+started[2]),old,old);
  const reclaimed=(await Promise.allSettled([start(id),start(id),start(id)])).filter(result=>result.status==='fulfilled');assert.equal(reclaimed.length,1);
 }finally{await rm(root,{recursive:true,force:true});}
});

// Shared minimal DOM for running page scripts.
function fakeDocument(values={}){const elements=new Map(Object.entries(values));const make=tag=>({tagName:String(tag).toUpperCase(),children:[],dataset:{},style:{},value:'',checked:false,disabled:false,hidden:false,textContent:'',innerHTML:'',files:[],append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=[...items];},setAttribute(){},addEventListener(){},select(){}});
 return {elements,document:{createElement:make,querySelector(selector){if(!elements.has(selector))elements.set(selector,make('x'));return elements.get(selector);},querySelectorAll:()=>[]}};}
const find=(el,predicate)=>predicate(el)?el:el.children?.map(child=>find(child,predicate)).find(Boolean);

test('Ask is presented and forwarded on the editor, excerpt and dashboard export paths; fixed modes and None send nothing',async()=>{
 // Editor page: chooser markup per mode, and the export request is built from the shared helper with the server's mode.
 for(const mode of ['ask','audition','audacity','both','none']){
  const page=editorPage(mode);assert.equal(page.includes('<select id="backup-projects">'),mode==='ask',mode);assert.equal(page.includes('backup-projects-note'),!['ask','none'].includes(mode),mode);
  assert.ok(page.includes(`backupProjects:selectedBackupProjects(${JSON.stringify(mode)},format)`),mode);
 }
 {const select={value:'both'},context=vm.createContext({document:{querySelector:selector=>selector==='#backup-projects'?select:{}},window:{}});
  try{vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(editorPage('ask'))[1],context);}catch{/* the editor needs a real DOM after its helpers are declared */}
  const pick=(mode,format,value)=>{select.value=value;const result=context.selectedBackupProjects(mode,format);return result&&[...result];};
  assert.deepEqual(pick('ask','soundcraft','both'),['audition','audacity']);assert.deepEqual(pick('ask','soundcraft','audition'),['audition']);assert.deepEqual(pick('ask','soundcraft','audacity'),['audacity']);assert.deepEqual(pick('ask','soundcraft','none'),[]);
  assert.equal(pick('ask','wav','both'),undefined);assert.equal(pick('both','soundcraft','none'),undefined);assert.equal(pick('none','soundcraft','both'),undefined);assert.throws(()=>pick('ask','soundcraft',''),/Choose whether/);}
 // Dashboard: the chooser follows the server's mode after loading, and the export request carries the choice.
 for(const [mode,expected] of [['ask',['audition']],['audacity',undefined],['none',undefined]]){
  const dom=fakeDocument(),requests=[];const data={canManage:false,soundcraftBackup:mode,settings:{autoJoin:false,autoRecord:false},integrations:{cloud:[]},sessions:[{id:'s1',startedAt:'2026-10-01T00:00:00Z',state:'completed',tracks:[],durationSamples:48000*60}]};
  const context=vm.createContext({document:dom.document,location:{href:'https://example.com/dashboard/g'},fetch:async(url,init)=>{if(init?.body)requests.push(JSON.parse(init.body));return {ok:true,json:async()=>init?.body?{url:'https://example.com/job'}:data};},navigator:{},btoa,Math,Number,JSON,String,Error,console});
  vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(dashboardPage(false))[1],context);await wait(20);
  const html=dom.elements.get('#export-backups').innerHTML;assert.equal(html.includes('<select id="backup-projects">'),mode==='ask',mode);assert.equal(html,mode==='none'?'':html);
  dom.document.querySelector('#backup-projects').value='audition';
  const card=dom.elements.get('#sessions').children[0],format=find(card,el=>el.tagName==='SELECT'&&find(el,child=>child.value==='soundcraft'));format.value='soundcraft';
  await find(card,el=>el.tagName==='BUTTON'&&el.textContent==='Prepare export').onclick();
  const sent=requests.find(body=>body.action==='export');assert.deepEqual(sent.backupProjects,expected,mode);
 }
});

test('every server-side Soundcraft path requires a choice under Ask and applies fixed modes without one',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-ask-paths-'));let service,queue;
 try{const id=await session(root,'g','c');const exportName='export-'+uuid(),dir=path.join(root,id,exportName);await mkdir(dir);await writeFile(path.join(dir,'track-1.wav'),wav(.2));
  await writeFile(path.join(dir,'manifest.json'),JSON.stringify({sessionID:id,guildID:'g',format:'wav',tracks:[{file:'track-1.wav',userID:'u',username:'Alice'}]}));
  const settings=new SettingsStore(path.join(root,'settings.json'));await settings.load();
  queue=new ExportQueue(root);queue.setSoundcraftBackupPolicy(guild=>settings.get(guild).soundcraftBackup??'ask');await queue.load(false);
  service=await DownloadService.create(root,'https://example.com');service.attach(queue,settings,{sessions:new Map()});
  const port=await service.listen(0,'127.0.0.1'),local=url=>url.replace('https://example.com',`http://127.0.0.1:${port}`);
  const post=async(url,body)=>{const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  const exportURL=local(service.link(id,exportName)),dashboard=local(service.dashboardLink('g')),recording=local(service.recordingLink(id));
  const edits={tracks:[{track:1,name:'Alice',gainDb:0,pan:0,muted:false,solo:false,clips:[{start:0,end:0.2,at:0}]}],notes:[]};
  const paths={recording:extra=>post(recording,{format:'soundcraft',...extra}),dashboard:extra=>post(dashboard,{action:'export',session:id,format:'soundcraft',...extra}),editor:extra=>post(exportURL,{action:'editor-export',edits,format:'soundcraft',...extra}),excerpt:extra=>post(exportURL,{start:0,end:0.1,format:'soundcraft',...extra})};
  const excerptPage=await (await fetch(exportURL)).text();assert.match(excerptPage,/<select id="backup-projects">/);new vm.Script(/<script>([\s\S]*?)<\/script>/.exec(excerptPage)[1]);
  const jobOf=result=>queue.get(new URL(result.body.url).pathname.split('/').pop());
  for(const [name,send] of Object.entries(paths)){
   const missing=await send({});assert.equal(missing.status,400,name);assert.match(missing.body.error,/Choose whether this Soundcraft export includes backup projects/,name);
   const chosen=await send({backupProjects:['audacity']});assert.equal(chosen.status,202,name+': '+JSON.stringify(chosen.body));assert.deepEqual(jobOf(chosen).backupProjects,['audacity'],name);
  }
  await settings.update('g',{soundcraftBackup:'both'});
  assert.match(await (await fetch(exportURL)).text(),/backup-projects-note/);
  for(const [name,send] of Object.entries(paths)){const result=await send({mix:true});assert.equal(result.status,202,name);assert.deepEqual(jobOf(result).backupProjects,['audition','audacity'],name);assert.equal((await send({backupProjects:['audition']})).status,400,name);}
  await settings.update('g',{soundcraftBackup:'none'});
  {const page=await (await fetch(exportURL)).text();assert.ok(!page.includes('<select id="backup-projects"')&&!page.includes('backup-projects-note'));}
  for(const [name,send] of Object.entries(paths)){const plain=await send({});assert.equal(plain.status,202,name+': '+JSON.stringify(plain.body));assert.deepEqual(jobOf(plain).backupProjects,[],name);assert.equal((await send({backupProjects:['audition']})).status,400,name);}
  // Non-Soundcraft exports never need a choice.
  assert.equal((await post(dashboard,{action:'export',session:id,format:'wav'})).status,202);
 }finally{await service?.close();await queue?.close();await rm(root,{recursive:true,force:true});}
});

test('Discord /export offers the backup choice for Ask',()=>{
 const source=require('node:fs').readFileSync(path.join(__dirname,'../dist/discord/client.js'),'utf8');
 assert.match(source,/name: "backup", description: "Soundcraft only: backup projects for Soundcraft testing"/);assert.match(source,/backupProjects\s*}\)|backupProjects }\)/);
});

test('an installed whisper-cli without --vad is reported not ready when a VAD model is enabled',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-vad-support-'));const saved={...process.env};const warn=console.warn;console.warn=()=>{};
 try{const old=path.join(root,'old-whisper'),current=path.join(root,'whisper'),model=path.join(root,'model.bin'),vad=path.join(root,'silero.bin');await writeFile(model,'m');await writeFile(vad,'v');
  await writeFile(old,'#!/bin/sh\necho "usage: whisper-cli [options] file0.wav\n  -m FNAME, --model FNAME"\n');await writeFile(current,'#!/bin/sh\necho "  --vad  enable VAD\n  -vm FNAME, --vad-model FNAME"\n');await chmod(old,0o755);await chmod(current,0o755);
  const config=require('../dist/integrations/transcription-config');
  config.resetVadProbes();Object.assign(process.env,{TRANSCRIPTION_EXECUTABLE:old,TRANSCRIPTION_MODEL:model,TRANSCRIPTION_VAD_MODEL:vad});assert.equal(await config.transcriptionReadyAsync(),false);assert.equal(config.transcriptionReady(),false);await assert.rejects(config.checkedTranscriptionConfig(),/does not support --vad/);
  process.env.TRANSCRIPTION_EXECUTABLE=current;assert.equal(await config.transcriptionReadyAsync(),true);assert.equal(config.transcriptionReady(),true);
  process.env.TRANSCRIPTION_EXECUTABLE=old;process.env.TRANSCRIPTION_VAD_MODEL='off';assert.equal(config.transcriptionReady(),true,'without a VAD model an older build is fine');
 }finally{console.warn=warn;for(const key of ['TRANSCRIPTION_EXECUTABLE','TRANSCRIPTION_MODEL','TRANSCRIPTION_VAD_MODEL'])if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];await rm(root,{recursive:true,force:true});}
});

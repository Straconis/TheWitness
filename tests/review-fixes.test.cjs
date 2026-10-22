const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {mkdtemp,mkdir,writeFile,readFile,rm,chmod,utimes,readdir}=require('node:fs/promises');
const {uploadIntroChunk,getServerIntro,MAX_CUSTOM_INTROS,MAX_CUSTOM_UPLOADS}=require('../dist/exports/server-intro');
const {dashboardPage}=require('../dist/downloads/dashboard-page'),{recordingPage}=require('../dist/downloads/recording-page');
const {DownloadService}=require('../dist/downloads/service'),{SettingsStore}=require('../dist/storage/settings');
const {ExportQueue}=require('../dist/exports/jobs'),{transcribeExport}=require('../dist/integrations/transcription');
const limits=require('../dist/exports/soundcraft-limits');
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function wav(seconds,silent=false,rate=48000,channels=2){const n=Math.round(seconds*rate),b=Buffer.alloc(44+n*2*channels);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(channels,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*2*channels,28);b.writeUInt16LE(2*channels,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(n*2*channels,40);if(!silent)for(let i=0;i<n;i++)for(let c=0;c<channels;c++)b.writeInt16LE(Math.round(2000*Math.sin(i*2*Math.PI*440/rate)),44+(i*channels+c)*2);return b;}
const upload=(name,extra={})=>({index:0,final:true,bytes:wav(.2).toString('base64'),name,...extra});
const uuid=()=>require('node:crypto').randomUUID();
async function session(root,guild,channel,extra={}){const id=uuid();await mkdir(path.join(root,id),{recursive:true});await writeFile(path.join(root,id,'session.json'),JSON.stringify({id,guildID:guild,channelID:channel,startedAt:'2026-10-01T00:00:00Z',state:'completed',durationSamples:48000,tracks:[{track:1,id:'u',username:'Alice'}],...extra}));return id;}

// Minimal DOM: enough for the dashboard script to load data and run its click handlers.
function fakeDocument(){const elements=new Map();
 const make=tag=>{const el={tagName:String(tag).toUpperCase(),children:[],dataset:{},style:{},value:'',checked:false,disabled:false,hidden:false,textContent:'',files:[],
  append(...items){this.children.push(...items);},prepend(...items){this.children.unshift(...items);},replaceChildren(...items){this.children=[...items];},setAttribute(){},addEventListener(){},select(){}};return el;};
 return {elements,make,document:{createElement:make,querySelector(selector){if(!elements.has(selector))elements.set(selector,make('x'));return elements.get(selector);},querySelectorAll:()=>[]}};}
const find=(el,predicate)=>predicate(el)?el:el.children?.map(child=>find(child,predicate)).find(Boolean);

test('dashboard start-sound upload runs without a ReferenceError and offers Soundcraft only within its length limit',async()=>{
 const dom=fakeDocument(),requests=[];
 const sessions=[{id:'short',startedAt:'2026-10-01T00:00:00Z',state:'completed',tracks:[],durationSamples:48000*60},{id:'long',startedAt:'2026-10-01T00:00:00Z',state:'completed',tracks:[],durationSamples:limits.SOUNDCRAFT_MAX_FRAMES+48001,audioOrigin:0},{id:'unknown',startedAt:'2026-10-01T00:00:00Z',state:'completed',tracks:[]}];
 const data={canManage:true,soundcraftBackup:'ask',startSound:{mode:'default'},intro:{name:'Server theme',seconds:2},introChannels:[{id:'c1',name:'Voice'}],settings:{autoJoin:false,autoRecord:false},integrations:{cloud:[]},sessions};
 const fetch=async(url,init)=>{requests.push(init?.body?JSON.parse(init.body):undefined);return {ok:true,json:async()=>init?.method==='POST'?{id:'11111111-1111-4111-8111-111111111111'}:data};};
 const context=vm.createContext({document:dom.document,location:{href:'https://example.com/dashboard/g?manager=1'},fetch,navigator:{},btoa,Math,Number,JSON,Uint8Array,String,Error,console});
 vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(dashboardPage(true))[1],context);await wait(20);
 const cards=dom.elements.get('#sessions').children;assert.equal(cards.length,3);
 const option=(card)=>find(card,el=>el.tagName==='OPTION'&&el.value==='soundcraft');
 assert.equal(option(cards[0]).disabled,false);assert.equal(option(cards[1]).disabled,true);assert.match(option(cards[1]).title,/length limit/);assert.equal(option(cards[2]).disabled,true);assert.match(option(cards[2]).title,/could not be verified/);
 // Channel without its own intro: the label names the inherited server default instead of pretending the channel has one.
 dom.elements.get('#intro-channel').value='c1';dom.elements.get('#intro-channel').onchange();assert.match(dom.elements.get('#intro-name').textContent,/No intro saved for this channel\. Its recordings use the server default: Server theme/);
 const bytes=new Uint8Array(1024);dom.document.querySelector('#start-sound-file').files=[{size:bytes.length,name:'chime.ogg',slice:(a,b)=>({arrayBuffer:async()=>bytes.slice(a,b).buffer})}];
 await dom.elements.get('#start-sound-upload').onclick();
 assert.equal(dom.elements.get('#start-sound-status').textContent,'Sound uploaded. Select Custom and save to use it.');assert.equal(dom.elements.get('#start-sound-upload').disabled,false);
 assert.ok(requests.some(body=>body?.action==='upload-start-sound'&&body.final===true));
});

test('concurrent intro uploads wait their turn instead of failing and deleting chunks',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-intro-concurrent-'));
 try{const a=await session(root,'g','c'),b=await session(root,'g','c'),c=await session(root,'other','c');
  const results=await Promise.all([uploadIntroChunk(root,'g',upload('A'),a),uploadIntroChunk(root,'g',upload('B'),b),uploadIntroChunk(root,'other',upload('Server C')),uploadIntroChunk(root,'g',upload('Channel'),undefined,'c')]);
  assert.deepEqual(results.map(result=>result.intro.name),['A','B','Server C','Channel']);
  assert.ok(await getServerIntro(root,'g',results[0].id,a));assert.ok(await getServerIntro(root,'g',results[1].id,b));assert.equal((await getServerIntro(root,'other')).name,'Server C');assert.equal((await getServerIntro(root,'g',undefined,undefined,'c')).name,'Channel');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('custom intros per recording are capped, keep job references, and limit uploads in progress',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-intro-cap-'));
 try{const id=await session(root,'g','c');const saved=[];
  for(let i=0;i<MAX_CUSTOM_INTROS+2;i++){saved.push((await uploadIntroChunk(root,'g',upload('Intro '+i),id,undefined,{keep:new Set(saved.slice(0,1))})).id);await wait(25);}
  const present=[];for(const intro of saved)present.push(!!await getServerIntro(root,'g',intro,id));
  assert.deepEqual(present,[true,false,true,true,true]);
  const partial=[];for(let i=0;i<MAX_CUSTOM_UPLOADS;i++)partial.push((await uploadIntroChunk(root,'g',{index:0,final:false,bytes:wav(.1).toString('base64'),name:'p'},id)).id);
  await assert.rejects(uploadIntroChunk(root,'g',{index:0,final:false,bytes:wav(.1).toString('base64'),name:'p'},id),/already in progress/);
  // Server and channel uploads are managers' and are not capped this way.
  for(let i=0;i<MAX_CUSTOM_UPLOADS+1;i++)await uploadIntroChunk(root,'g',{index:0,final:false,bytes:wav(.1).toString('base64'),name:'s'});
  const dir=path.join(root,id,'intros');const [scope]=await readdir(dir),old=new Date(Date.now()-2*3600000);await utimes(path.join(dir,scope,'upload-'+partial[0]),old,old);
  const resumed=await uploadIntroChunk(root,'g',{index:0,final:false,bytes:wav(.1).toString('base64'),name:'p'},id);assert.ok(resumed.id);
  // Continuing an upload already in progress is unaffected by the limit.
  assert.equal((await uploadIntroChunk(root,'g',{id:partial[1],index:1,final:true,bytes:wav(.1).toString('base64')},id)).intro.seconds>0,true);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a missing VAD model disables transcription without breaking the download page',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-vad-config-'));let service;const previous=process.env.TRANSCRIPTION_VAD_MODEL;const warn=console.warn;const warnings=[];
 try{process.env.TRANSCRIPTION_VAD_MODEL=path.join(root,'missing-silero.bin');console.warn=(...args)=>warnings.push(args.join(' '));
  const {transcriptionReady,transcriptionConfig}=require('../dist/integrations/transcription-config');
  assert.equal(transcriptionReady(),false);assert.equal(transcriptionReady(),false);assert.equal(warnings.filter(text=>text.includes('VAD model not found')).length,1);assert.throws(()=>transcriptionConfig(),/VAD model not found/);
  const id=await session(root,'g','c');const settings=new SettingsStore(path.join(root,'settings.json'));await settings.load();
  service=await DownloadService.create(root,'https://example.com');service.attach({enqueue:async()=>({id})},settings,{sessions:new Map()});
  const port=await service.listen(0,'127.0.0.1'),local=url=>url.replace('https://example.com',`http://127.0.0.1:${port}`);
  const page=await fetch(local(service.recordingLink(id)));assert.equal(page.status,200);assert.match(await page.text(),/Transcription is not configured on this host yet/);
  const dashboard=await fetch(local(service.dashboardLink('g')),{headers:{Accept:'application/json'}});assert.equal(dashboard.status,200);assert.equal((await dashboard.json()).integrations.transcription,false);
 }finally{console.warn=warn;if(previous===undefined)delete process.env.TRANSCRIPTION_VAD_MODEL;else process.env.TRANSCRIPTION_VAD_MODEL=previous;await service?.close();await rm(root,{recursive:true,force:true});}
});

test('transcript segments are trimmed to their audible part instead of spanning silence',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-transcript-trim-'));
 try{
  // 0.6 s of tone, then silence; Whisper returns one segment spanning speech and 2.3 s of silence, and one starting early.
  const audio=wav(3,true,48000,1);for(let i=0;i<48000*.6;i++)audio.writeInt16LE(Math.round(2000*Math.sin(i*2*Math.PI*440/48000)),44+i*2);
  await writeFile(path.join(root,'track-1.wav'),audio);await writeFile(path.join(root,'manifest.json'),JSON.stringify({tracks:[{file:'track-1.wav',userID:'speaker',username:'Alice'}]}));
  const executable=path.join(root,'recognizer');await writeFile(executable,'#!'+process.execPath+'\nconst fs=require("node:fs"),args=process.argv.slice(2);fs.writeFileSync(args[args.indexOf("-of")+1]+".json",JSON.stringify({transcription:[{offsets:{from:100,to:2900},text:"Spoken then quiet"}]}));\n');await chmod(executable,0o755);
  await transcribeExport(root,{executable,model:'m',ffmpeg:path.resolve(__dirname,'../bin/ffmpeg')});
  const srt=await readFile(path.join(root,'transcript.srt'),'utf8'),[,from,to]=/(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)/.exec(srt);
  const ms=value=>{const [h,m,rest]=value.split(':'),[s,milli]=rest.split(',');return ((+h*60+ +m)*60+ +s)*1000+ +milli;};
  assert.equal(ms(from),100);assert.ok(ms(to)>=600&&ms(to)<=900,`end ${to}`);assert.match(srt,/Alice: Spoken then quiet/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('recording page exports the intro it displayed, even after the default changes',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-displayed-intro-'));let queue;
 try{const id=await session(root,'g','c');const first=await uploadIntroChunk(root,'g',upload('First'),undefined,'c');
  const page=recordingPage(JSON.parse(await readFile(path.join(root,id,'session.json'))),false,first.intro,'none');
  const bodies=[],buttons=[{dataset:{format:'wav',mixed:'false'},disabled:false,textContent:'WAV'}];
  const values={'#target-lufs':{value:'-16',validity:{valid:true}},'#max-true-peak':{value:'-1',validity:{valid:true}},'#silence-seconds':{value:'30'},'#track':{value:''},'#intro-source':{value:'server'},'#intro':{checked:true,addEventListener(){}},'#started':{dateTime:'x'}};
  const document={querySelector:selector=>values[selector]??{checked:false,value:'',dataset:{},addEventListener(){}},querySelectorAll:selector=>selector==='button[data-format]'?buttons:[]};
  vm.runInContext(/<script>([\s\S]*?)<\/script>/.exec(page)[1],vm.createContext({document,URL,location:{href:'https://example.com/r'},fetch:async(url,init)=>{bodies.push(JSON.parse(init.body));return {ok:true,json:async()=>({url:'https://example.com/j'})};}}));
  await buttons[0].onclick();assert.equal(bodies[0].introID,first.id);assert.equal(bodies[0].introScope,'server');
  await uploadIntroChunk(root,'g',upload('Second'),undefined,'c');assert.equal((await getServerIntro(root,'g',undefined,undefined,'c')).name,'Second');
  queue=new ExportQueue(root);await queue.load(false);const job=await queue.enqueue(id,'g','wav',false,{includeIntro:true,introScope:'server',introID:bodies[0].introID});assert.equal(job.introID,first.id);
  const other=await uploadIntroChunk(root,'g',upload('Other channel'),undefined,'c2');await assert.rejects(queue.enqueue(id,'g','wav',false,{includeIntro:true,introScope:'server',introID:other.id}),/Select or upload an intro/);
 }finally{await queue?.close();await rm(root,{recursive:true,force:true});}
});

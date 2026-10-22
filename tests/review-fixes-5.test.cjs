const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),vm=require('node:vm'),{spawn}=require('node:child_process');

test('speech diagnostic writes its report using the checked configuration',async()=>{
 const writes=new Map(),logs=[],proc={argv:['node','script','speech.wav','report.json']};let checked=0,transcribed;
 const fakeFs={mkdtemp:async()=>'/tmp/diagnostic',copyFile:async()=>{},writeFile:async(p,v)=>writes.set(p,v),readFile:async()=> 'Speech retained.',rm:async()=>{}};
 const config={model:'/models/base.en.bin',executable:'/bin/whisper'};
 const source=fs.readFileSync(path.join(__dirname,'../scripts/check-transcription.cjs'),'utf8');
 const modules={'dotenv/config':{},'node:fs/promises':fakeFs,'node:path':path,'node:os':os,'../dist/integrations/transcription-config':{transcriptionReadyAsync:async()=>true,checkedTranscriptionConfig:async()=>{checked++;return config;}},'../dist/integrations/transcription':{transcribeExport:async(dir,options)=>{transcribed=options;}}};
 await vm.runInNewContext(source,{require:id=>{assert.ok(id in modules,id);return modules[id];},process:proc,__dirname:path.join(__dirname,'../scripts'),console:{log:message=>logs.push(message),error:message=>logs.push(message)}});
 assert.equal(proc.exitCode,undefined,logs.join('\n'));assert.equal(checked,1);assert.equal(transcribed.model,config.model);
 const report=JSON.parse(writes.get('report.json'));assert.equal(report.model,'base.en.bin');assert.equal(report.transcript,'Speech retained.');
});

for(const mode of ['shutdown','timeout'])test(`probe ${mode} allows actual process exit and stops wrapper descendants`,{skip:process.platform!=='linux'},async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'witness-probe-exit-')),executable=path.join(root,'wrapper'),pidFile=path.join(root,'pid');let descendant;
 try{
  await fsp.writeFile(executable,`#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nwait\n`);await fsp.chmod(executable,0o755);
  const modulePath=path.join(__dirname,'../dist/integrations/transcription-config');
  const source=`const fs=require('node:fs'),c=require(${JSON.stringify(modulePath)});c.configureVadProbe({timeoutMs:${mode==='timeout'?250:10000}});const running=c.probeVad(${JSON.stringify(executable)});${mode==='shutdown'?`const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})){clearInterval(timer);c.stopVadProbes();}},10);`:''}running.then(value=>{if(value!==undefined)process.exitCode=1;});`;
  const started=performance.now();const child=spawn(process.execPath,['-e',source],{stdio:['ignore','pipe','pipe']});let stderr='';child.stderr.on('data',b=>stderr+=b);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('probe kept Node alive for 3 seconds'));},3000);child.once('error',error=>{clearTimeout(timer);reject(error);});child.once('close',(code)=>{clearTimeout(timer);code===0?resolve():reject(Error(stderr||`exit ${code}`));});});
  assert.ok(performance.now()-started<3000);descendant=Number(await fsp.readFile(pidFile,'utf8'));
  // A killed process may briefly remain as a zombie until PID 1 reaps it; it must not be running.
  const statFile=`/proc/${descendant}/stat`;if(fs.existsSync(statFile))assert.equal(fs.readFileSync(statFile,'utf8').split(') ')[1][0],'Z','descendant still running');
 }finally{if(!descendant&&fs.existsSync(pidFile))descendant=Number(fs.readFileSync(pidFile,'utf8'));if(descendant)try{process.kill(descendant,'SIGKILL');}catch{}await fsp.rm(root,{recursive:true,force:true});}
});

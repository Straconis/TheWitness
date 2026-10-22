const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),{spawn}=require('node:child_process');
const running=pid=>{try{return fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1][0]!=='Z';}catch{return false;}};
/** Runs probeVad in a separate Node process and returns its result, elapsed time and whether that process exited by itself. */
function probeInChild(executable,timeoutMs){
 const source=`const c=require(${JSON.stringify(path.join(__dirname,'../dist/integrations/transcription-config'))});c.configureVadProbe({timeoutMs:${timeoutMs}});const started=Date.now();c.probeVad(${JSON.stringify(executable)}).then(value=>console.log(JSON.stringify({value:value===undefined?'undefined':value,ms:Date.now()-started})));`;
 return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e',source],{stdio:['ignore','pipe','pipe']});let out='',err='';child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('probe kept Node alive for 5 seconds'));},5000);child.once('close',code=>{clearTimeout(timer);code===0?resolve(JSON.parse(out)):reject(Error(err||`exit ${code}`));});});
}

test('a wrapper that exits normally does not leave descendants running after the probe',{skip:process.platform!=='linux'},async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'witness-probe-leftover-')),pidFile=path.join(root,'pid');let descendant;
 try{
  // The descendant does not hold our pipes, so the probe completes normally; it must still not outlive the probe.
  const executable=path.join(root,'wrapper');await fsp.writeFile(executable,`#!/bin/sh\nsleep 30 >/dev/null 2>&1 </dev/null &\necho $! > '${pidFile}'\necho "  -vm FNAME, --vad-model FNAME"\n`);await fsp.chmod(executable,0o755);
  const result=await probeInChild(executable,10000);assert.equal(result.value,true);descendant=Number(await fsp.readFile(pidFile,'utf8'));
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal(running(descendant),false,'leftover descendant stopped');
 }finally{if(descendant)try{process.kill(descendant,'SIGKILL');}catch{}await fsp.rm(root,{recursive:true,force:true});}
});

test('a wrapper that exits while a descendant still holds the output pipes is answered promptly, not after the timeout',{skip:process.platform!=='linux'},async()=>{
 const root=await fsp.mkdtemp(path.join(os.tmpdir(),'witness-probe-pipes-')),pidFile=path.join(root,'pid');let descendant;
 try{
  const executable=path.join(root,'wrapper');await fsp.writeFile(executable,`#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\necho "  -vm FNAME, --vad-model FNAME"\n`);await fsp.chmod(executable,0o755);
  const result=await probeInChild(executable,4000);assert.equal(result.value,true,'the help text it printed counts');assert.ok(result.ms<2000,`answered after ${result.ms} ms`);
  descendant=Number(await fsp.readFile(pidFile,'utf8'));await new Promise(resolve=>setTimeout(resolve,100));assert.equal(running(descendant),false);
 }finally{if(descendant)try{process.kill(descendant,'SIGKILL');}catch{}await fsp.rm(root,{recursive:true,force:true});}
});

test('speech detection is opt-in: an installed model is not used unless TRANSCRIPTION_VAD_MODEL enables it',async()=>{
 const config=require('../dist/integrations/transcription-config'),saved=process.env.TRANSCRIPTION_VAD_MODEL,root=await fsp.mkdtemp(path.join(os.tmpdir(),'witness-vad-optin-'));
 const bundled=path.resolve(__dirname,'../bin/models/ggml-silero-v6.2.0.bin');
 try{
  delete process.env.TRANSCRIPTION_VAD_MODEL;assert.equal(config.transcriptionConfig().vadModel,undefined,'unset: off even if the model file is installed');
  for(const value of ['off','OFF',' off ',''])process.env.TRANSCRIPTION_VAD_MODEL=value,assert.equal(config.transcriptionConfig().vadModel,undefined,JSON.stringify(value));
  const model=path.join(root,'silero.bin');await fsp.writeFile(model,'v');process.env.TRANSCRIPTION_VAD_MODEL=model;assert.equal(config.transcriptionConfig().vadModel,model,'explicit path');
  process.env.TRANSCRIPTION_VAD_MODEL='auto';
  if(fs.existsSync(bundled))assert.equal(config.transcriptionConfig().vadModel,bundled,'auto selects the bundled model');
  else assert.throws(()=>config.transcriptionConfig(),/VAD model not found/,'auto without the bundled model is a configuration error');
  process.env.TRANSCRIPTION_VAD_MODEL=path.join(root,'missing.bin');assert.throws(()=>config.transcriptionConfig(),/VAD model not found/);
 }finally{if(saved===undefined)delete process.env.TRANSCRIPTION_VAD_MODEL;else process.env.TRANSCRIPTION_VAD_MODEL=saved;await fsp.rm(root,{recursive:true,force:true});}
});

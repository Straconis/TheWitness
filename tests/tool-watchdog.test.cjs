const test=require('node:test'),assert=require('node:assert/strict'),{mkdtemp,writeFile,chmod,rm}=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {runTool}=require('../dist/exports/process');
test('cleanup watchdog allows continuing progress, stops repeated timestamps, and preserves cancellation',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-watchdog-'));
 try{
  const tool=path.join(root,'audio-fixture');
  await writeFile(tool,`#!${process.execPath}\nlet n=0;setInterval(()=>{console.log('out_time_us='+ (++n*100000));if(n===12)process.exit(0)},200);`);await chmod(tool,0o755);
  await runTool(tool,[],undefined,10000,1000);
  await writeFile(tool,`#!${process.execPath}\nsetInterval(()=>console.log('out_time_us=0'),30);`);
  await assert.rejects(runTool(tool,[],undefined,10000,1000),/stalled/);
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(Error('operator cancelled')),150);
  try{await assert.rejects(runTool(tool,[],controller.signal,10000,2000),/operator cancelled/);}finally{clearTimeout(timer);}
 }finally{await rm(root,{recursive:true,force:true});}
});

const test=require('node:test'),assert=require('node:assert/strict');
const {ExportStageProfiler}=require('../dist/exports/stage-profile');
test('sequential stage wall times separate raw conversion, cleanup, loudness and packaging without retaining names',()=>{
 let time=0;const p=new ExportStageProfiler(()=>time);time=5;p.begin('raw:1');time=15;p.begin('clean:1');time=35;p.begin('clean:2');time=65;p.begin('level:1');time=105;p.begin('package');time=155;p.finish();time=999;p.finish();p.begin('raw:3');
 assert.deepEqual(p.timings,{prepare:{wallMs:5,segments:1},originals:{wallMs:10,segments:1},cleanup:{wallMs:50,segments:2},loudness:{wallMs:40,segments:1},packaging:{wallMs:50,segments:1}});
 assert.equal(Object.values(p.timings).reduce((n,r)=>n+r.wallMs,0),155);
});
test('unidentified boundaries do not charge their work to the previous operation',()=>{
 let time=0;const p=new ExportStageProfiler(()=>time);p.begin('clean:1');time=10;p.begin();time=20;p.begin('project');time=30;p.finish();assert.equal(p.timings.cleanup.wallMs,10);assert.equal(p.timings.other.wallMs,10);assert.equal(p.timings.project.wallMs,10);
});
test('queue persists timings on completed and failed exports',async()=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
 const {RecordingSession}=require('../dist/recording/session'),{ExportQueue}=require('../dist/exports/jobs');
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-stage-ledger-'));let queue;
 try{const source=await RecordingSession.create(root,'guild','voice');await source.append(Buffer.from([0xf8,0xff,0xfe]),'u','User',0,1n);await source.close();
 queue=new ExportQueue(root,async(base,id,options)=>{options.onProgress('Cleaning',1,'clean:1');await new Promise(r=>setTimeout(r,15));if(options.mix)throw Error('injected failure');return path.join(base,id,'export-result');});await queue.load();
 for(const mix of [false,true]){const job=await queue.enqueue(source.id,'guild','wav',mix);const deadline=Date.now()+5000;while(!['completed','failed'].includes(job.state)&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));await queue.close();const saved=JSON.parse(await fs.readFile(path.join(root,'jobs',job.id+'.json'),'utf8'));assert.equal(saved.state,mix?'failed':'completed');assert.ok(saved.stageTimings.cleanup.wallMs>=10);if(!mix){queue.releaseIntroReferences();queue=new ExportQueue(root,queue.exporter);await queue.load();}}
 }finally{await queue?.close();queue?.releaseIntroReferences();await fs.rm(root,{recursive:true,force:true});}
});

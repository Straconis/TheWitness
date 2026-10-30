const test=require('node:test'),assert=require('node:assert/strict');
const {cpuCounters,cpuInterval,pressure,blockInterval,counterDelta}=require('../dist/storage/host-metrics');
const {HostDiagnostics}=require('../dist/storage/host-diagnostics');
const waitFor=async check=>{const end=Date.now()+1000;while(!check()){if(Date.now()>end)throw Error('Sampler did not progress');await new Promise(resolve=>setTimeout(resolve,5));}};
test('host CPU separates actual work, I/O wait and steal without double-counting guest time',()=>{
 const before=cpuCounters('cpu 10 0 10 40 20 5 5 10 9999 9999\ncpu0 10 0 10 40 20 5 5 10');
 const after=cpuCounters('cpu 30 0 30 70 40 10 10 10 99999 99999');
 assert.equal(before.cpu.total,100);assert.deepEqual(cpuInterval(before.cpu,after.cpu),{busyPercent:50,ioWaitPercent:20,stealPercent:0});
 assert.equal(cpuInterval(after.cpu,before.cpu),null);assert.equal(cpuInterval(undefined,after.cpu),null);
 assert.equal(cpuInterval(before.cpu,before.cpu),null);assert.deepEqual(cpuCounters('cpu nope'),{});
 assert.equal(counterDelta(undefined,2),null);assert.equal(counterDelta(5,4),null);
});
test('disk sampling uses 512-byte sectors and distinguishes latency, queue depth and busy time',()=>{
 const before=[10,0,100,100,10,0,200,100,0,100,100];
 const after=[12,0,104,120,12,0,208,120,0,1100,2100];
 assert.deepEqual(blockInterval(before,after,2),{readBytesPerSecond:1024,writeBytesPerSecond:2048,busyPercent:50,averageRequestMS:10,averageQueueDepth:1});
 assert.equal(blockInterval(after,before,2),null);assert.equal(blockInterval(undefined,after,2),null);
 assert.equal(blockInterval(before,after,0),null);
 assert.deepEqual(pressure('some avg10=1.25 avg60=2.0 total=100\nfull avg10=0.00 avg60=0 total=0'),{someAvg10:1.25,fullAvg10:0});
 assert.equal(pressure(undefined),null);assert.equal(pressure('unsupported'),null);
});
test('background history is bounded, records without dashboard requests, and journals active work plus its final interval',async()=>{
 let count=0,active=true;const logs=[];
 const monitor=new HostDiagnostics({sample:async()=>({sampledAt:String(++count),cpuPercent:50})},()=>({recordings:0,exports:{running:active?1:0,queued:0},jobs:active?[{id:'job',format:'flac',stage:'Matching loudness'}]:[]}),line=>logs.push(line),5,3);
 monitor.start();try{await waitFor(()=>count>=3);active=false;await waitFor(()=>count>=6);}finally{await monitor.stop();}
 const history=monitor.history();assert.equal(history.samples.length,3);assert.ok(history.samples.every(row=>row.exports.running===0));
 const records=logs.filter(line=>line.startsWith('[Host metrics] {')).map(line=>JSON.parse(line.slice('[Host metrics] '.length)));
 assert.ok(records.some(row=>row.jobs[0]?.stage==='Matching loudness'));assert.equal(records.filter(row=>row.exports.running===0).length,1);
 const finalCount=count;await new Promise(resolve=>setTimeout(resolve,20));assert.equal(count,finalCount);
});
test('shutdown drains an in-flight sample without logging or scheduling more work',async()=>{
 let release,calls=0;const logs=[];
 const monitor=new HostDiagnostics({sample:()=>{calls++;return new Promise(resolve=>{release=resolve;});}},()=>({recordings:1,exports:{running:0,queued:0},jobs:[]}),line=>logs.push(line),5);
 monitor.start();const stopping=monitor.stop();release({sampledAt:'now'});await stopping;
 assert.equal(calls,1);assert.deepEqual(logs,[]);assert.equal(monitor.history().samples.length,0);
});
test('sampling failures retry and warn once while the failure persists',async()=>{
 let calls=0;const logs=[];const monitor=new HostDiagnostics({sample:async()=>{calls++;throw Error('private path');}},()=>({recordings:0,exports:{running:0,queued:0},jobs:[]}),line=>logs.push(line),5);
 monitor.start();try{await waitFor(()=>calls>=3);}finally{await monitor.stop();}
 assert.equal(logs.length,1);assert.ok(!logs[0].includes('private path'));
});

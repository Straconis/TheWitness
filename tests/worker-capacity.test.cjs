const test=require('node:test'),assert=require('node:assert/strict');
const {planWorkers,runAdaptiveWorkers,visibleCgroupLimits,MiB}=require('../dist/exports/worker-capacity');
const policy={automatic:true,maxWorkers:3,cpuPerWorker:1.5,reserveCores:1,memoryPerWorkerBytes:256*MiB,reserveMemoryBytes:512*MiB,temporaryBytesPerWorker:128*MiB,reserveDiskBytes:1024*MiB};
const resources=(cpu=6)=>({cpuCores:cpu,memoryLimitBytes:6*1024*MiB,memoryAvailableBytes:5*1024*MiB,diskAvailableBytes:20*1024*MiB});
test('automatic admission remains sequential at 2 CPUs and respects CPU quotas, memory, disk and low-space mode',()=>{
 assert.equal(planWorkers(resources(2),policy).workers,1);assert.equal(planWorkers(resources(6),policy).workers,3);
 assert.equal(planWorkers(resources(1.5),policy).workers,1);assert.equal(planWorkers(resources(0),policy).workers,0);
 assert.equal(planWorkers(resources(6),{...policy,automatic:false}).workers,1);
 assert.equal(planWorkers({...resources(),lowSpaceMode:true},policy).workers,1);
 assert.equal(planWorkers({...resources(),memoryAvailableBytes:768*MiB},policy).workers,1);
 assert.equal(planWorkers({...resources(),memoryAvailableBytes:512*MiB},policy).workers,0);
 assert.equal(planWorkers({...resources(),diskAvailableBytes:1152*MiB},policy).workers,1);
 assert.equal(planWorkers({...resources(),diskAvailableBytes:1024*MiB},policy).workers,0);
 assert.throws(()=>planWorkers(resources(),{...policy,maxWorkers:NaN}));
});
test('worker admissions reserve resources and downshift without killing in-flight tasks',async()=>{
 let low=false,active=0,peak=0;const admissions=[],finished=[];
 await runAdaptiveWorkers([0,1,2,3,4],policy,async()=>({...resources(),lowSpaceMode:low}),async(item)=>{active++;peak=Math.max(peak,active);if(item===1)low=true;await new Promise(r=>setTimeout(r,10));finished.push(item);active--;},{onAdmission:r=>admissions.push(r)});
 assert.ok(peak<=3&&peak>=2);assert.equal(finished.length,5);for(const row of admissions.filter(r=>r.index>=3))assert.equal(row.active,1);
});
test('parallel failure aborts and drains other children before returning; queued work is never started',async()=>{
 const started=[],closed=[];
 await assert.rejects(runAdaptiveWorkers([0,1,2,3,4],policy,async()=>resources(),async(item,index,signal)=>{
  started.push(item);try{if(item===1){await new Promise(r=>setTimeout(r,5));throw Error('failed child');}await new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>setTimeout(()=>reject(signal.reason),10),{once:true});});}finally{closed.push(item);}
 }),/failed child/);
 assert.ok(started.length<=3);assert.deepEqual([...closed].sort(),[...started].sort());
});
test('external cancellation stops admission and drains active workers',async()=>{
 const controller=new AbortController();let started=0,closed=0;
 const pending=runAdaptiveWorkers([0,1,2,3],policy,async()=>resources(),async(item,index,signal)=>{started++;try{await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}finally{closed++;}},{signal:controller.signal});
 await new Promise(r=>setTimeout(r,10));controller.abort(Error('user cancelled'));await assert.rejects(pending,/user cancelled/);assert.equal(closed,started);assert.ok(started<=3);
});
test('insufficient resources defer admission without launching a worker',async()=>{
 let launched=false;await assert.rejects(runAdaptiveWorkers([0],policy,async()=>({...resources(),diskAvailableBytes:1}),async()=>{launched=true;}),/admission deferred/);assert.equal(launched,false);
});

test('a six-core child still obeys its two-core parent and tighter parent RAM budget',async()=>{
 const files={'/sys/fs/cgroup/parent/child/cpu.max':'600000 100000','/sys/fs/cgroup/parent/cpu.max':'200000 100000','/sys/fs/cgroup/parent/child/memory.max':String(6*1024*MiB),'/sys/fs/cgroup/parent/child/memory.current':String(100*MiB),'/sys/fs/cgroup/parent/memory.max':String(2*1024*MiB),'/sys/fs/cgroup/parent/memory.current':String(1280*MiB)};
 const limits=await visibleCgroupLimits('/parent/child',async file=>files[file]);assert.equal(limits.cpuCores,2);assert.equal(limits.memoryLimitBytes,2*1024*MiB);assert.equal(limits.memoryAvailableBytes,768*MiB);assert.equal(planWorkers({...resources(),...limits},policy).workers,1);
 await assert.rejects(visibleCgroupLimits('../../outside',async()=>undefined),/Invalid cgroup path/);
 await assert.rejects(visibleCgroupLimits('/child',async file=>file.endsWith('cpu.max')?'bad quota':undefined),/Invalid CPU quota/);
});

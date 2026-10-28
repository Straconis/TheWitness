const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm');
const {OverallExportProgress,buildExportPlan}=require('../dist/exports/progress');
const {exportProgressPage}=require('../dist/downloads/export-progress-page');
test('overall estimate includes later operations rather than only the current pass',()=>{
 let now=0;const model=new OverallExportProgress(()=>now);model.setPlan([{id:'s',kind:'sync',seconds:100},{id:'e1',kind:'encode',seconds:100},{id:'e2',kind:'encode',seconds:100},{id:'n',kind:'normalize',seconds:100,passes:3},{id:'m',kind:'mix',seconds:100}]);model.begin('s');assert.equal(model.estimate(),undefined);now=1000;model.begin('e1');now=11000;model.progress(50);const eta=model.estimate();assert.ok(eta.remainingSeconds>500);assert.ok(eta.minimumSeconds<eta.remainingSeconds);assert.ok(eta.maximumSeconds>eta.remainingSeconds);assert.equal(eta.provisional,true);
});
test('multi-pass loudness work remains in the overall estimate across per-pass clock resets',()=>{
 let now=0;const model=new OverallExportProgress(()=>now);model.setPlan([{id:'n1',kind:'normalize',seconds:100,passes:3},{id:'n2',kind:'normalize',seconds:100,passes:3}]);model.begin('n1');for(let pass=1;pass<=3;pass++){model.progress(0);now=pass*10000;model.progress(100);}assert.equal(model.estimate().remainingSeconds,30);
});
test('estimates adapt to observed speed and skip optional operations that did not run',()=>{
 let now=0;const model=new OverallExportProgress(()=>now);model.setPlan([{id:'a',kind:'encode',seconds:100},{id:'unused-cut',kind:'encode',seconds:1000},{id:'b',kind:'encode',seconds:100},{id:'c',kind:'encode',seconds:100}]);model.begin('a');now=10000;model.progress(100);model.begin('b');now=20000;model.progress(50);const slower=model.estimate().remainingSeconds;now=25000;model.progress(100);const faster=model.estimate().remainingSeconds;assert.ok(slower<100,'skipped cut must not remain in the estimate');assert.ok(faster<slower);
});
test('export plans account for raw tracks, cleanup-independent silence passes, intro matching and the mixed audio',()=>{
 const plan=buildExportPlan([{track:1},{track:2}],3600,3600,285,'flac',{includeRaw:true,mix:true,trimSilence:true,normalizeAudio:true,normalizeIntro:true});const ids=plan.map(t=>t.id);for(const id of ['raw:1','scan:2','cut:1','level:2','intro-level','pad:1','intro','mix-level','mix-intro-level','mix-combine','mix-normalize','package'])assert.ok(ids.includes(id),id);assert.equal(plan.find(t=>t.id==='level:1').passes,3);assert.equal(plan.find(t=>t.id==='encode:1').seconds,0);
});
test('the preparation page shows an overall completion range separately from a short current-pass ETA',async()=>{
 const elements=new Map();const document={querySelector:id=>{if(!elements.has(id))elements.set(id,{hidden:false,textContent:'',after(){}});return elements.get(id);}};
 const data={state:'running',stage:'Converting speaker 1 of 7',progress:{remainingSeconds:10},overallEstimate:{minimumSeconds:600,maximumSeconds:1200,updatedAt:new Date().toISOString(),provisional:true}};
 const script=/<script>([\s\S]*?)<\/script>/.exec(exportProgressPage())[1];vm.runInNewContext(script,{document,fetch:async()=>({ok:true,json:async()=>data}),location:{href:'https://example.com/job'},setInterval:()=>1,clearInterval(){},setTimeout:()=>1,Date,Number,Math});await new Promise(r=>setImmediate(r));assert.match(elements.get('#overall-estimate').textContent,/until your download is ready/);assert.match(elements.get('#overall-estimate').textContent,/10 min–20 min remaining/);assert.match(elements.get('#estimate').textContent,/under a minute/);
});
test('progress polling reconnects automatically after a network error without calling it an export failure',async()=>{
 const elements=new Map(),timers=new Map();let next=0,fail=false;
 const document={querySelector:id=>{if(!elements.has(id))elements.set(id,{hidden:false,textContent:''});return elements.get(id);}};
 const script=/<script>([\s\S]*?)<\/script>/.exec(exportProgressPage())[1];
 vm.runInNewContext(script,{document,fetch:async()=>{if(fail)throw Error('Failed to fetch');return {ok:true,json:async()=>({state:'running',stage:'Matching loudness: Alice'})};},location:{href:'https://example.com/job'},setInterval:()=>1,clearInterval(){},setTimeout:(fn,ms)=>{timers.set(++next,{fn,ms});return next;},clearTimeout:id=>timers.delete(id),Date,Number,Math});
 await new Promise(r=>setImmediate(r));assert.equal(elements.get('#status').textContent,'Matching loudness: Alice');
 fail=true;await elements.get('#check-again').onclick();assert.equal(elements.get('#status').textContent,'Matching loudness: Alice');assert.match(elements.get('#connection-status').textContent,/export may still be running/);assert.equal(elements.get('#check-again').hidden,false);
 const retry=[...timers.values()].at(-1);assert.equal(retry.ms,2000);fail=false;await retry.fn();assert.equal(elements.get('#connection-status').hidden,true);assert.equal(elements.get('#check-again').hidden,true);assert.equal(elements.get('#status').textContent,'Matching loudness: Alice');
});

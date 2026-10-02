const test=require('node:test'),assert=require('node:assert/strict');const {EventRecording}=require('../dist/discord/event-recording');
const event={id:'456',guildID:'123',channelID:'voice',entityType:2,status:2,name:'Campaign'};
function fixture(rules=[]){let starts=0,stops=0;const manager={sessions:new Map(),exclusive:async(_,fn)=>fn(),cancelReconnect:()=>{}},settings={get:()=>({eventRecordings:rules})};const service=new EventRecording(settings,manager,async e=>{starts++;manager.sessions.set(e.guildID,{id:'owned'});return 'owned';},async guild=>{stops++;manager.sessions.delete(guild);});return {service,manager,counts:()=>({starts,stops})};}
test('event recording stays off by default and ignores unrelated/external events',async()=>{const f=fixture();await f.service.update(event);assert.equal(f.counts().starts,0);const g=fixture([{eventID:'456',stopOnEnd:false}]);await g.service.update({...event,id:'789'});await g.service.update({...event,entityType:3,channelID:null});assert.equal(g.counts().starts,0);});
test('selected active event starts once; manual stop stays stopped; auto-stop is opt in',async()=>{const f=fixture([{eventID:'456',stopOnEnd:false}]);await f.service.update(event);await f.service.update(event);assert.equal(f.counts().starts,1);f.manager.sessions.delete('123');await f.service.update(event);assert.equal(f.counts().starts,1);await f.service.update({...event,status:3});assert.equal(f.counts().stops,0);const g=fixture([{eventID:'456',stopOnEnd:true}]);await g.service.update(event);await g.service.update({...event,status:3});assert.deepEqual(g.counts(),{starts:1,stops:1});});
test('event rules never take over a manual recording or stop a later unrelated session',async()=>{const f=fixture([{eventID:'456',stopOnEnd:true}]);f.manager.sessions.set('123',{id:'manual'});await f.service.update(event);await f.service.update({...event,status:3});assert.deepEqual(f.counts(),{starts:0,stops:0});const g=fixture([{eventID:'456',stopOnEnd:true}]);await g.service.update(event);g.manager.sessions.set('123',{id:'later-manual'});await g.service.update({...event,status:3});assert.equal(g.counts().stops,0);});

function occupancyFixture(present=true,stopOnEnd=false){
 let stops=0,cancels=0;const manager={sessions:new Map(),exclusive:async(_,fn)=>fn(),cancelReconnect:()=>{cancels++;}};
 const service=new EventRecording({get:()=>({eventRecordings:[{eventID:'456',stopOnEnd}]})},manager,async()=>{manager.sessions.set('123',{id:'owned'});return 'owned';},async guildID=>{stops++;manager.sessions.delete(guildID);},()=>present);
 return {service,manager,setPresent:value=>present=value,counts:()=>({stops,cancels})};
}
test('event-owned recording saves after 60 continuous empty seconds even when event-end stop is off',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=occupancyFixture();
 try{await f.service.update(event);f.setPresent(false);f.service.voiceChanged('123','voice');t.mock.timers.tick(59999);await Promise.resolve();assert.equal(f.counts().stops,0);t.mock.timers.tick(1);await f.service.close();assert.deepEqual(f.counts(),{stops:1,cancels:1});}
 finally{await f.service.close();t.mock.timers.reset();}
});
test('a rejoin resets the empty countdown; unrelated channels and unknown gateway state do not stop recordings',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=occupancyFixture();
 try{await f.service.update(event);f.setPresent(false);f.service.voiceChanged('123','other');t.mock.timers.tick(60000);assert.equal(f.counts().stops,0);
 f.service.voiceChanged('123','voice');t.mock.timers.tick(59000);f.setPresent(true);f.service.voiceChanged('123','voice');t.mock.timers.tick(60000);assert.equal(f.counts().stops,0);
 f.setPresent(false);f.service.voiceChanged('123','voice');t.mock.timers.tick(59000);f.setPresent(undefined);t.mock.timers.tick(1000);assert.equal(f.counts().stops,0);
 f.setPresent(false);f.service.recheck();t.mock.timers.tick(59999);assert.equal(f.counts().stops,0);t.mock.timers.tick(1);await f.service.close();assert.equal(f.counts().stops,1);
 }finally{await f.service.close();t.mock.timers.reset();}
});
test('event completion without stop_on_end still allows empty-channel cleanup',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=occupancyFixture();
 try{await f.service.update(event);await f.service.update({...event,status:3});f.setPresent(false);f.service.recheck();t.mock.timers.tick(60000);await f.service.close();assert.equal(f.counts().stops,1);}
 finally{await f.service.close();t.mock.timers.reset();}
});
test('empty-channel timers never stop a later manual session and close cancels pending timers',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=occupancyFixture(false);
 try{await f.service.update(event);f.manager.sessions.set('123',{id:'manual'});t.mock.timers.tick(60000);await f.service.close();assert.equal(f.counts().stops,0);assert.equal(f.manager.sessions.get('123').id,'manual');
 const g=occupancyFixture(false);await g.service.update(event);await g.service.close();t.mock.timers.tick(60000);assert.equal(g.counts().stops,0);}
 finally{await f.service.close();t.mock.timers.reset();}
});
test('a rejoin while expiration waits for the guild lock invalidates the old countdown',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const f=occupancyFixture(false);
 try{await f.service.update(event);let queued;f.manager.exclusive=(_,fn)=>new Promise(resolve=>queued=async()=>{await fn();resolve();});
 t.mock.timers.tick(60000);f.setPresent(true);f.service.voiceChanged('123','voice');f.setPresent(false);f.service.voiceChanged('123','voice');await queued();assert.equal(f.counts().stops,0);
 t.mock.timers.tick(60000);await queued();assert.equal(f.counts().stops,1);
 }finally{await f.service.close();t.mock.timers.reset();}
});

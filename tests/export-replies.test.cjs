const test=require('node:test'),assert=require('node:assert/strict');
const {mkdtemp,rm}=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
test('attachment replies retain the job ID, change to processing, and explain cancellation',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-export-replies-'));process.env.DISCORD_TOKEN='offline-test-token';process.env.RECORDING_PATH=root;
 const {RecordingSession}=require('../dist/recording/session');
 const {createDiscordClient,recordings,settingsStore,closeRecordingPanels}=require('../dist/discord/client');
 let timer;
 try{
  const session=await RecordingSession.create(root,'123','555');await session.close();await settingsStore.load();
  const job={id:'11111111-1111-4111-8111-111111111111',state:'queued'};let polls=0;
  const queue={stopping:false,enqueue:async()=>job,get:()=>{job.state=['queued','running','cancelled'][Math.min(polls++,2)];return job;},position:()=>job.state==='queued'?1:undefined};
  const client=createDiscordClient(undefined,queue);client.user={id:'bot',username:'Offline Witness'};
  client.guilds.set('123',{id:'123',name:'Offline guild',members:new Map(),roles:new Map(),channels:new Map()});
  const messages=[];let done;const finished=new Promise(resolve=>done=resolve);
  client.emit('interactionCreate',{type:2,data:{name:'export',options:[{name:'session',value:session.id},{name:'format',value:'wav'}]},guildID:'123',member:{id:'member',roles:[],permissions:{has:()=>true}},channel:{id:'text'},acknowledged:false,defer:async function(){this.acknowledged=true;},editOriginalMessage:async body=>{messages.push(body.content);if(body.content.includes('was cancelled'))done();}});
  await Promise.race([finished,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Export reply timeout: '+messages.join(' | '))),12000))]);
  assert.ok(messages.some(text=>text.includes('position 1')&&text.includes(job.id)));
  assert.ok(messages.some(text=>text.includes('now processing')&&text.includes(job.id)));
  assert.equal(messages.at(-1),`Export job ${job.id} was cancelled.`);
  assert.ok(!messages.some(text=>text.includes('Could not export')));
 }finally{clearTimeout(timer);await recordings.shutdown();await closeRecordingPanels();await rm(root,{recursive:true,force:true});}
});

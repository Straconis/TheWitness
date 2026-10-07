const test=require('node:test');const assert=require('node:assert/strict');
const {mkdtemp,rm}=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
test('commands register per server, survive one server failing, and reach servers added later',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-commands-'));process.env.DISCORD_TOKEN='offline-test-token';process.env.RECORDING_PATH=root;
 const {createDiscordClient,recordings,settingsStore,closeRecordingPanels}=require('../dist/discord/client');
 try{
  await settingsStore.load();const client=createDiscordClient();client.user={id:'bot',username:'Offline Witness'};
  for(const id of ['broken','working'])client.guilds.set(id,{id,name:id,channels:new Map(),members:new Map()});
  const registered=[];let notify;client.bulkEditGuildCommands=async id=>{if(id==='broken')throw Error('Missing Access');registered.push(id);notify?.();};
  const next=()=>new Promise(resolve=>notify=resolve);
  let waiting=next();client.emit('ready');await waiting;assert.deepEqual(registered,['working']);
  waiting=next();client.emit('guildCreate',{id:'new',name:'new',channels:new Map(),members:new Map()});await waiting;assert.deepEqual(registered,['working','new']);
 }finally{await recordings.shutdown();await closeRecordingPanels();await rm(root,{recursive:true,force:true});}
});

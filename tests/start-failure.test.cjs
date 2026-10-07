const test=require('node:test');const assert=require('node:assert/strict');
const {mkdtemp,rm,writeFile}=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {EventEmitter}=require('node:events');
test('a recording that cannot start leaves the voice channel it joined',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-start-failure-'));process.env.DISCORD_TOKEN='offline-test-token';process.env.RECORDING_PATH=root;
 const {createDiscordClient,recordings,settingsStore,closeRecordingPanels}=require('../dist/discord/client');
 try{
  await settingsStore.load();const client=createDiscordClient();let leaves=0;
  const voiceChannel={id:'voice',type:2,name:'General Voice',permissionsOf:()=>({has:()=>true}),leave:()=>leaves++};
  const guild={id:'123',name:'Offline guild',members:new Map(),channels:new Map([['voice',voiceChannel]])};client.guilds.set(guild.id,guild);
  client.user={id:'bot',username:'Offline Witness'};client.createMessage=async()=>({id:'panel'});client.editMessage=async()=>({});
  client.joinVoiceChannel=async()=>{const voice=new EventEmitter();voice.receive=()=>new EventEmitter();voice.disconnect=()=>{};return voice;};
  async function dispatch(){let done,timer;const completed=new Promise(resolve=>done=resolve);client.emit('interactionCreate',{type:2,data:{name:'record',options:[{name:'channel',value:'voice'}]},guildID:guild.id,member:{id:'member',roles:[]},channel:{id:'text'},defer:async()=>{},createMessage:async body=>done(body),editOriginalMessage:async body=>done(body)});
   try{return await Promise.race([completed,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Record command timed out')),2000))]);}finally{clearTimeout(timer);}
  }
  // A pending deployment refuses new recordings after the bot has already joined voice.
  await writeFile(path.join(root,'.deploy-pending'),'');
  assert.ok((await dispatch()).content.includes('could not start'));
  assert.equal(recordings.sessions.size,0);assert.equal(leaves,1);
  // If the bot was already in voice (auto-join without auto-record), a failed start keeps that connection.
  client.voiceConnections.set(guild.id,{channelID:'voice'});
  assert.ok((await dispatch()).content.includes('could not start'));assert.equal(leaves,1);
 }finally{await recordings.shutdown();await closeRecordingPanels();await rm(root,{recursive:true,force:true});}
});

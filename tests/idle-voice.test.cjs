const test=require('node:test'),assert=require('node:assert/strict'),{IdleVoice}=require('../dist/discord/idle-voice');
test('autojoin leaves only its own idle empty connection after a continuous minute',t=>{
 t.mock.timers.enable({apis:['setTimeout']});const connection={},other={};let humans=true,recording=false,current=connection,leaves=0;
 const idle=new IdleVoice((guild,owner)=>({sameConnection:current===owner.connection,hasHumans:humans,recording}),()=>{leaves++;});
 idle.own('guild','voice',connection);t.mock.timers.tick(60000);assert.equal(leaves,0);
 humans=false;idle.changed('guild','voice');t.mock.timers.tick(59000);assert.equal(leaves,0);humans=true;idle.changed('guild','voice');t.mock.timers.tick(1000);assert.equal(leaves,0);
 humans=false;idle.changed('guild','voice');t.mock.timers.tick(60000);assert.equal(leaves,1);
 idle.own('guild','voice',connection);recording=true;idle.recheck();t.mock.timers.tick(60000);assert.equal(leaves,1);
 recording=false;idle.recheck();current=other;t.mock.timers.tick(60000);assert.equal(leaves,1,'replacement manual connection is protected');
 current=connection;humans=undefined;idle.own('guild','voice',connection);t.mock.timers.tick(60000);assert.equal(leaves,1,'unknown gateway occupancy is protected');
 humans=false;idle.recheck();idle.close();t.mock.timers.tick(60000);assert.equal(leaves,1);
});

test('Discord autojoin leave and switch events disconnect idle connections without event rules',async t=>{
 const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');const root=await fs.mkdtemp(path.join(os.tmpdir(),'witness-idle-wiring-'));process.env.DISCORD_TOKEN='offline-test-token';process.env.RECORDING_PATH=root;
 const {createDiscordClient,settingsStore,recordings,closeRecordingPanels}=require('../dist/discord/client');t.mock.timers.enable({apis:['setTimeout']});
 try{
  await settingsStore.load();await settingsStore.update('123',{autoJoin:true,autoRecord:false});const client=createDiscordClient(),people=new Map();let leaves=0;
  const channel={id:'voice',type:2,name:'Voice',voiceMembers:{some:f=>[...people.values()].some(f)},leave:()=>{leaves++;client.voiceConnections.delete('123');}},other={id:'other',type:2};const guild={id:'123',name:'Test',shard:{ready:true},channels:new Map([['voice',channel],['other',other]])};channel.guild=guild;other.guild=guild;client.guilds.set(guild.id,guild);client.user={id:'bot'};
  client.joinVoiceChannel=async()=>{const connection={channelID:'voice'};client.voiceConnections.set(guild.id,connection);return connection;};const human={id:'human',bot:false,roles:[],username:'Alice'};
  for(const kind of ['leave','switch']){
   people.set(human.id,human);client.emit('voiceChannelJoin',human,channel);for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r));assert.ok(client.voiceConnections.has(guild.id));
   people.delete(human.id);if(kind==='leave')client.emit('voiceChannelLeave',human,channel);else client.emit('voiceChannelSwitch',human,other,channel);
   t.mock.timers.tick(59000);assert.equal(leaves,kind==='leave'?0:1);t.mock.timers.tick(1000);assert.equal(leaves,kind==='leave'?1:2);
  }
  assert.equal(recordings.sessions.size,0);
 }finally{await closeRecordingPanels();await recordings.shutdown();t.mock.timers.reset();await fs.rm(root,{recursive:true,force:true});}
});

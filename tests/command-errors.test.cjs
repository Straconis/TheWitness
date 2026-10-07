const test=require('node:test');const assert=require('node:assert/strict');
const {mkdtemp,rm}=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
test('commands show their own validation messages but keep unexpected failures generic',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-command-errors-'));process.env.DISCORD_TOKEN='offline-test-token';process.env.RECORDING_PATH=root;
 const {createDiscordClient,recordings,settingsStore,closeRecordingPanels}=require('../dist/discord/client');
 try{
  await settingsStore.load();const client=createDiscordClient();client.user={id:'bot',username:'Offline Witness'};
  const guild={id:'123',name:'Offline guild',members:new Map(),roles:new Map(),channels:new Map([['555',{id:'555',type:2}]])};client.guilds.set(guild.id,guild);
  async function dispatch(name,options){let done,timer;const completed=new Promise(resolve=>done=resolve);client.emit('interactionCreate',{type:2,data:{name,options},guildID:guild.id,member:{id:'member',roles:[],permissions:{has:()=>true}},channel:{id:'text'},acknowledged:false,defer:async function(){this.acknowledged=true;},createMessage:async body=>done(body),editOriginalMessage:async body=>done(body)});
   try{return (await Promise.race([completed,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error(name+' timed out')),2000))])).content;}finally{clearTimeout(timer);}
  }
  assert.match(await dispatch('retention',[{name:'days',value:7}]),/confirm:true/);
  assert.match(await dispatch('schedule',[{name:'action',value:'add'},{name:'channel',value:'555'},{name:'time',value:'19:00'},{name:'days',value:'5'},{name:'timezone',value:'Mars/Olympus_Mons'},{name:'minutes',value:240}]),/Unknown time zone/);
  client.getGuildScheduledEvents=async()=>{throw new TypeError("Cannot read properties of undefined (reading 'id')");};
  assert.equal(await dispatch('eventrecord',[{name:'mode',value:'enable'},{name:'event',value:'123456'}]),'The command failed. Check the bot logs and try again.');
 }finally{await recordings.shutdown();await closeRecordingPanels();await rm(root,{recursive:true,force:true});}
});

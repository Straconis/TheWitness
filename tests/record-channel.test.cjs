const test=require('node:test');const assert=require('node:assert/strict');
const {mkdtemp,rm}=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {EventEmitter}=require('node:events');
test('/record requires a voice channel, checks access, and can start it from text chat',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-channel-command-'));process.env.DISCORD_TOKEN='offline-test-token';process.env.RECORDING_PATH=root;
 const {createDiscordClient,recordings,settingsStore,closeRecordingPanels}=require('../dist/discord/client');
 try{
  await settingsStore.load();const client=createDiscordClient();let permitted=true;const joined=[];
  const voiceChannel={id:'voice',type:2,name:'General Voice',permissionsOf:member=>{assert.equal(member.id,'member');return{has:()=>permitted};}};
  const guild={id:'123',name:'Offline guild',members:new Map(),channels:new Map([['voice',voiceChannel],['text',{id:'text',type:0}]])};client.guilds.set(guild.id,guild);
  client.user={id:'bot',username:'Offline Witness'};client.createMessage=async()=>({id:'panel'});client.editMessage=async()=>({});
  client.joinVoiceChannel=async id=>{joined.push(id);const voice=new EventEmitter();voice.receive=()=>new EventEmitter();voice.disconnect=()=>{};return voice;};
  let commandList,registered;const registration=new Promise(resolve=>registered=resolve);client.bulkEditGuildCommands=async(id,commands)=>{commandList=commands;registered();};
  client.emit('ready');await registration;const record=commandList.find(command=>command.name==='record');
  assert.deepEqual(record.options[0],{type:7,name:'channel',description:'Voice channel to record',required:true,channel_types:[2]});assert.equal(record.options[1].name,'title');
  async function dispatch(options){let done,timer;const completed=new Promise(resolve=>done=resolve);client.emit('interactionCreate',{type:2,data:{name:'record',options},guildID:guild.id,member:{id:'member',roles:[]},channel:{id:'text'},defer:async()=>{},createMessage:async body=>done(body),editOriginalMessage:async body=>done(body)});
   try{return await Promise.race([completed,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Record command timed out')),2000))]);}finally{clearTimeout(timer);}
  }
  assert.ok((await dispatch([])).content.includes('Choose a voice channel'));
  assert.ok((await dispatch([{name:'channel',value:'text'}])).content.includes('Choose a voice channel'));
  assert.ok((await dispatch([{name:'channel',value:'another-server-channel'}])).content.includes('Choose a voice channel'));
  permitted=false;assert.ok((await dispatch([{name:'channel',value:'voice'}])).content.includes('permission'));assert.equal(joined.length,0);
  permitted=true;const reply=await dispatch([{name:'channel',value:'voice'},{name:'title',value:'Session 12'}]);assert.ok(reply.content.includes('is recording'));assert.ok(reply.content.includes('<#voice>'));assert.deepEqual(joined,['voice']);
  const session=recordings.sessions.get(guild.id);assert.equal(session.channelID,'voice');assert.equal(session.channelName,'General Voice');assert.equal(session.title,'Session 12');assert.equal(guild.members.size,0);
 }finally{await recordings.shutdown();await closeRecordingPanels();await rm(root,{recursive:true,force:true});}
});

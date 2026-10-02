const test=require('node:test'),assert=require('node:assert/strict');
const {mkdtemp,readFile,rm}=require('node:fs/promises');const os=require('node:os'),path=require('node:path');const {EventEmitter}=require('node:events');
async function until(predicate){const deadline=Date.now()+5000;while(!predicate()){if(Date.now()>deadline)throw Error('Timed out');await new Promise(resolve=>setImmediate(resolve));}}
test('Discord leave and channel-switch wiring ignores bots, cancels on rejoin, and saves real event sessions',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-empty-event-'));process.env.DISCORD_TOKEN='offline-test-token';process.env.RECORDING_PATH=root;
 const {createDiscordClient,recordings,settingsStore,closeRecordingPanels}=require('../dist/discord/client');
 t.mock.timers.enable({apis:['setTimeout']});
 try{
  await settingsStore.load();await settingsStore.update('123',{eventRecordings:[{eventID:'456',stopOnEnd:false},{eventID:'789',stopOnEnd:false}]});
  const client=createDiscordClient();const people=new Map();let leaves=0,panels=0;const edits=[];
  const channel={id:'voice',type:2,name:'Session',voiceMembers:{some:fn=>[...people.values()].some(fn)},leave:()=>{leaves++;}};
  const other={id:'other',type:2};const guild={id:'123',name:'Test',shard:{ready:true},members:new Map(),channels:new Map([['voice',channel],['other',other]])};channel.guild=guild;other.guild=guild;client.guilds.set('123',guild);client.user={id:'bot',username:'Witness'};
  client.createMessage=async()=>{panels++;return{id:'panel-'+panels};};client.editMessage=async(_,__,body)=>{edits.push(body);};
  let receiver;client.joinVoiceChannel=async()=>{const connection=new EventEmitter();receiver=new EventEmitter();connection.receive=()=>receiver;return connection;};
  const human={id:'human',bot:false},bot={id:'bot',bot:true};people.set(bot.id,bot);
  for(const [index,kind] of ['leave','switch'].entries()){
   people.set(human.id,human);client.emit('guildScheduledEventUpdate',{id:index?'789':'456',guild,channel,entityType:2,status:2,name:'Unattended game'});
   await until(()=>panels===index+1);await new Promise(resolve=>setImmediate(resolve));
   const session=recordings.sessions.get('123');receiver.emit('data',Buffer.from([0xf8,0xff,0xfe]),'human',0);
   const leave=()=>{people.delete(human.id);if(kind==='leave')client.emit('voiceChannelLeave',human,channel);else client.emit('voiceChannelSwitch',human,other,channel);};
   leave();t.mock.timers.tick(59000);assert.equal(recordings.sessions.get('123'),session);
   people.set(human.id,human);if(kind==='leave')client.emit('voiceChannelJoin',human,channel);else client.emit('voiceChannelSwitch',human,channel,other);
   t.mock.timers.tick(60000);assert.equal(recordings.sessions.get('123'),session);
   leave();t.mock.timers.tick(60000);await until(()=>leaves===index+1&&recordings.sessions.size===0&&edits.some(body=>body.embeds[0].fields.some(field=>field.name==='Voice channel empty')));
   const saved=JSON.parse(await readFile(path.join(session.directory,'session.json')));assert.equal(saved.state,'completed');assert.equal(saved.stopReason,'empty-channel');assert.equal(saved.packets,1);assert.equal(saved.error,undefined);
   assert.equal(receiver.listenerCount('data'),0);
  }
 }finally{await closeRecordingPanels();await recordings.shutdown();t.mock.timers.reset();await rm(root,{recursive:true,force:true});}
});

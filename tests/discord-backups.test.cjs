const test=require('node:test'),assert=require('node:assert/strict');
const {mkdtemp,rm}=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
test('Discord /export applies the Soundcraft backup setting on the queued and the direct paths',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-discord-backups-'));process.env.DISCORD_TOKEN='offline-test-token';process.env.RECORDING_PATH=root;process.env.FFMPEG_PATH=path.join(__dirname,'../bin/ffmpeg');
 const {RecordingSession}=require('../dist/recording/session'),{OpusEncoder}=require('@discordjs/opus'),{ExportQueue}=require('../dist/exports/jobs'),{backupMode}=require('../dist/exports/soundcraft-backup');
 const {createDiscordClient,recordings,settingsStore,closeRecordingPanels}=require('../dist/discord/client');let queue;
 try{
  const session=await RecordingSession.create(root,'123','555'),encoder=new OpusEncoder(48000,2);for(let i=0;i<10;i++){const pcm=Buffer.alloc(3840).fill(3);await session.append(encoder.encode(pcm),'u','Alice',i*960,BigInt(i*960),pcm);}await session.close();await settingsStore.load();
  queue=new ExportQueue(root);queue.setSoundcraftBackupPolicy(guild=>backupMode(settingsStore.get(guild)));await queue.load(false);
  const command=async(client,options)=>{const messages=[];await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('timeout: '+messages.join(' | '))),20000);client.emit('interactionCreate',{type:2,data:{name:'export',options:[{name:'session',value:session.id},...options]},guildID:'123',member:{id:'member',roles:[],permissions:{has:()=>true}},channel:{id:'text'},acknowledged:false,defer:async function(){this.acknowledged=true;},editOriginalMessage:async body=>{messages.push(body.content);if(/queued|ready|Choose whether|only available|admin setting|turned off|Could not export/i.test(body.content)){clearTimeout(timer);resolve();}}});});return messages.at(-1);};
  const setup=client=>{client.user={id:'bot',username:'Offline Witness'};client.guilds.set('123',{id:'123',name:'Offline guild',members:new Map(),roles:new Map(),channels:new Map()});return client;};
  const queued=setup(createDiscordClient({jobLink:id=>'https://example.com/job/'+id,link:()=>'https://example.com/x'},queue));
  // Ask (the default): Soundcraft needs backup:, other formats do not.
  assert.match(await command(queued,[{name:'format',value:'soundcraft'}]),/Choose whether this Soundcraft export includes backup projects.*Add the backup: option to \/export\./);
  let reply=await command(queued,[{name:'format',value:'soundcraft'},{name:'backup',value:'audacity'}]);assert.match(reply,/queued/);const jobID=/Job: ([0-9a-f-]{36})/.exec(reply)[1];assert.deepEqual(queue.get(jobID).backupProjects,['audacity']);
  reply=await command(queued,[{name:'format',value:'soundcraft'},{name:'backup',value:'none'}]);assert.deepEqual(queue.get(/Job: ([0-9a-f-]{36})/.exec(reply)[1]).backupProjects,[]);
  assert.match(await command(queued,[{name:'format',value:'wav'}]),/queued/);
  assert.match(await command(queued,[{name:'format',value:'wav'},{name:'backup',value:'both'}]),/only available with Soundcraft/);
  await settingsStore.update('123',{soundcraftBackup:'both'});
  reply=await command(queued,[{name:'format',value:'soundcraft'}]);assert.deepEqual(queue.get(/Job: ([0-9a-f-]{36})/.exec(reply)[1]).backupProjects,['audition','audacity']);
  assert.match(await command(queued,[{name:'format',value:'soundcraft'},{name:'backup',value:'audition'}]),/admin setting includes Adobe Audition and Audacity/);
  // Direct (no queue, no web downloads): exports immediately and attaches; the same policy applies.
  await settingsStore.update('123',{soundcraftBackup:'ask'});
  const direct=setup(createDiscordClient(undefined,undefined));
  assert.match(await command(direct,[{name:'format',value:'soundcraft'}]),/Choose whether this Soundcraft export includes backup projects/);
  await settingsStore.update('123',{soundcraftBackup:'none'});
  assert.match(await command(direct,[{name:'format',value:'soundcraft'},{name:'backup',value:'both'}]),/turned off/);
 }finally{await queue?.close();queue?.releaseIntroReferences();await recordings.shutdown();await closeRecordingPanels();await rm(root,{recursive:true,force:true});}
});

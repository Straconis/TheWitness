const test=require('node:test');const assert=require('node:assert/strict');
const {mkdtemp,rm}=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {helpMessage,helpTopics}=require('../dist/discord/help');
test('help pages fit Discord limits and navigation preserves private, mention-free presentation',()=>{
 const expected=['record','stop','status','note','recordings','export','access','autojoin','autorecord','eventrecord','schedule','channelrules','retention','exportjob','title','downloadnames','delete','webapp','dashboard','recover','help'];
 const text=helpTopics.map(topic=>{
  const body=helpMessage(topic.value,{downloads:true,restricted:false});assert.equal(body.flags,64);assert.deepEqual(body.allowedMentions,{parse:[]});
  const embed=body.embeds[0];assert.ok(embed.title.length<=256);assert.ok(embed.description.length<=4096);assert.ok(embed.description.length+embed.title.length+embed.footer.text.length+embed.fields[0].value.length<6000);
  const menu=body.components[0].components[0];assert.ok(menu.options.length<=25);assert.equal(menu.options.filter(option=>option.default).length,1);assert.equal(menu.options.find(option=>option.default).value,topic.value);
  for(const option of menu.options){assert.ok(option.label.length<=100);assert.ok(option.description.length<=100);}
  return embed.description;
 }).join('\n');
 for(const name of expected)assert.ok(new RegExp('/'+name+'\\b').test(text),`Missing /${name}`);
 assert.equal(helpMessage('unknown',{downloads:false,restricted:true}).embeds[0].title,'The Witness · Quick start');
 assert.ok(helpMessage('downloads',{downloads:false,restricted:true}).embeds[0].fields[0].value.includes('not enabled'));
});
test('restricted members can open and navigate help, but operational commands remain gated',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-help-'));
 process.env.DISCORD_TOKEN='offline-test-token';process.env.RECORDING_PATH=root;
 const {createDiscordClient,settingsStore,closeRecordingPanels,recordings}=require('../dist/discord/client');
 try{
  await settingsStore.load();await settingsStore.update('123',{restrictAccess:true,accessRoleID:'456'});
  const client=createDiscordClient();
  async function dispatch(type,data){let done,timer;const result=new Promise(resolve=>done=resolve);const interaction={type,data,guildID:'123',member:{roles:[]},createMessage:async body=>done({kind:'create',body}),editParent:async body=>done({kind:'update',body})};
   client.emit('interactionCreate',interaction);try{return await Promise.race([result,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Help interaction timed out')),2000))]);}finally{clearTimeout(timer);}
  }
  const start=await dispatch(2,{name:'help'});assert.equal(start.kind,'create');assert.equal(start.body.flags,64);assert.ok(start.body.embeds[0].description.includes('**6. Or export by command:**'));assert.ok(start.body.embeds[0].fields[0].value.includes('Bot Wrangler'));
  const direct=await dispatch(2,{name:'help',options:[{name:'topic',value:'permissions'}]});assert.equal(direct.body.embeds[0].title,'The Witness · Permissions & privacy');
  const select=await dispatch(3,{custom_id:'witness:help',values:['exports']});assert.equal(select.kind,'update');assert.equal(select.body.flags,undefined);assert.equal(select.body.embeds[0].title,'The Witness · Exports & formats');
  const invalid=await dispatch(3,{custom_id:'witness:help',values:['<@everyone>']});assert.equal(invalid.body.embeds[0].title,'The Witness · Quick start');
  assert.ok((await dispatch(2,{name:'record'})).body.content.includes('restricted'));assert.ok((await dispatch(3,{custom_id:'witness:stop:11111111-1111-4111-8111-111111111111'})).body.content.includes('restricted'));
  assert.equal(recordings.sessions.size,0);assert.equal(settingsStore.get('123').restrictAccess,true);
 }finally{await recordings.shutdown();await closeRecordingPanels();await rm(root,{recursive:true,force:true});}
});

test('export help explains project track choice, exclusions, reusable intros, and synchronized silence trimming',()=>{const description=helpMessage('exports',{downloads:true,restricted:false}).embeds[0].description;for(const text of ['track_format','Zelvik','Server intro','30 seconds','same cuts','defaults off','Normalize speaker audio','Match intro volume'])assert.ok(description.includes(text),text);assert.ok(description.length<=4096);});

 test('help documents the recording cap and configured hosted transcription',()=>{
 const recording=helpMessage('recording',{downloads:true,restricted:false}).embeds[0].description;
 for(const text of ['8-hour maximum','stops automatically','saved for export','Start a new recording','skips the sync end cue'])assert.ok(recording.includes(text),text);
 const exports=helpMessage('exports',{downloads:true,restricted:false}).embeds[0].description;
 for(const text of ['Whisper on the server','TXT, SRT, and VTT','without user setup','Self-hosting'])assert.ok(exports.includes(text),text);
});

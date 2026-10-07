const test=require('node:test'),assert=require('node:assert/strict');
const {shutdownInOrder}=require('../dist/shutdown');
const {commandErrorMessage,UserError}=require('../dist/errors');
test('shutdown attempts all stages in order even when automation, panels or disconnect fails',async()=>{
 const calls=[],errors=[];
 const names=['retention','automation','recordings','panels','exports','Discord','downloads'];
 await shutdownInOrder(names.map(name=>({name,close:async()=>{calls.push(name);if(['automation','panels','Discord'].includes(name))throw Error(name);}})),(name)=>errors.push(name));
 assert.deepEqual(calls,names);assert.deepEqual(errors,['automation','panels','Discord']);
});
test('unclassified plain errors remain private and explicit user errors have mentions disabled by the caller',()=>{
 const generic='The command failed. Check the bot logs and try again.';
 assert.equal(commandErrorMessage(new Error('Private credential or path detail')),generic);
 assert.equal(commandErrorMessage(new TypeError('Internal detail')),generic);
 assert.equal(commandErrorMessage(new UserError('Choose a voice channel.')),'Choose a voice channel.');
 assert.equal(commandErrorMessage(new UserError('x'.repeat(501))),generic);
});
test('shutdown final recording card shows saved state and disables recording controls',async()=>{
 const {mkdtemp,rm}=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
 const {RecordingManager}=require('../dist/recording/manager'),{RecordingPanels}=require('../dist/discord/panel'),{EventEmitter}=require('node:events');
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-shutdown-panel-')),manager=new RecordingManager(root);let last;
 const panels=new RecordingPanels({createMessage:async(_channel,body)=>{last=body;return{id:'card'};},editMessage:async(_channel,_id,body)=>{last=body;}},{status:undefined});
 try{const connection=new EventEmitter();connection.receive=()=>new EventEmitter();const session=await manager.start({id:'guild',members:new Map()},'voice',connection);await session.append(Buffer.from([0xf8,0xff,0xfe]),'speaker','Speaker');await panels.ensure('text',session);assert.match(last.embeds[0].title,/Recording/);
 await shutdownInOrder([{name:'recordings',close:()=>manager.shutdown()},{name:'panels',close:()=>panels.close()}],(_name,error)=>{throw error;});
 assert.match(last.embeds[0].title,/Recording saved/);assert.ok(last.components[0].components.every(button=>button.disabled));
 }finally{await manager.shutdown();await panels.close();await rm(root,{recursive:true,force:true});}
});
test('final panel edit waits for an in-flight live edit before publishing saved state',async()=>{
 const {RecordingPanels}=require('../dist/discord/panel');let release,last,hold=false;
 const gate=new Promise(resolve=>release=resolve);
 const panels=new RecordingPanels({createMessage:async(_channel,body)=>{last=body;return{id:'card'};},editMessage:async(_channel,_id,body)=>{if(hold){hold=false;await gate;}last=body;}},{status:undefined});
 const session={id:'session',guildID:'guild',channelID:'voice',state:'recording',voiceState:'connected',startedAt:new Date().toISOString(),tracks:new Map(),notes:0,packetStats:{duplicatesDropped:0,latePacketsDropped:0}};
 try{await panels.ensure('text',session);hold=true;const liveUpdate=panels.update();session.state='completed';const closing=panels.close();release();await liveUpdate;await closing;assert.match(last.embeds[0].title,/Recording saved/);}finally{release();await panels.close();}
});

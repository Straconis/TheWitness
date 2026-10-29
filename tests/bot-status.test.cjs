const test=require('node:test'),assert=require('node:assert/strict');
const {mkdtemp,rm}=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {BotStatusStore,validateBotStatus,statusActivities,isApplicationOwner}=require('../dist/discord/bot-status');
const {DownloadService}=require('../dist/downloads/service');
test('status validation, custom activity payloads and owner checks fail closed',()=>{
 assert.deepEqual(statusActivities({enabled:false,type:4,text:'saved'}),[]);
 assert.deepEqual(statusActivities({enabled:true,type:4,text:'Ready 🐉'}),[{name:'Custom Status',type:4,state:'Ready 🐉'}]);
 assert.deepEqual(statusActivities({enabled:true,type:3,text:'your adventures'}),[{name:'your adventures',type:3}]);
 for(const value of [{enabled:true,type:4,text:''},{enabled:true,type:1,text:'stream'},{enabled:true,type:4,text:'x\nunsafe'},{enabled:true,type:4,text:'x'.repeat(129)},null])assert.throws(()=>validateBotStatus(value));
 assert.equal(isApplicationOwner({owner:{id:'owner'}},'owner'),true);assert.equal(isApplicationOwner({owner:{id:'owner'}},'manager'),false);
 assert.equal(isApplicationOwner({owner:{id:'bot'},team:{owner_user_id:'team-owner'}},'team-owner'),true);assert.equal(isApplicationOwner({owner:{id:'bot'},team:{owner_user_id:'team-owner'}},'bot'),false);assert.equal(isApplicationOwner({},''),false);
});
test('owner HTTP route enforces signed scope, expiry, origin, validation and persists status updates',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-owner-'));let service;
 try{const store=new BotStatusStore(path.join(root,'bot-status.json'));await store.load();let updates=0;
 service=await DownloadService.create(root,'https://example.com');service.setOwnerAdmin(store,()=>updates++);const port=await service.listen(0,'127.0.0.1'),local=url=>url.replace('https://example.com',`http://127.0.0.1:${port}`),url=local(service.adminLink());
 let response=await fetch(url);assert.equal(response.status,200);assert.match(await response.text(),/Discord status message/);
 assert.equal((await fetch(`http://127.0.0.1:${port}/admin/control`)).status,403);
 const wrong=new URL(local(service.dashboardLink('server',true)));wrong.pathname='/admin/control';assert.equal((await fetch(wrong)).status,403);
 const expired=new URL(url);expired.searchParams.set('expires','1');assert.equal((await fetch(expired)).status,403);
 const post=(value,headers={})=>fetch(url,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(value)});
 const value={enabled:true,type:4,text:'Your adventures 🐉'};
 assert.equal((await post(value,{Origin:'https://attacker.example'})).status,403);assert.equal((await post({...value,text:''})).status,400);assert.equal(updates,0);
 assert.equal((await post(value)).status,200);assert.equal(updates,1);const restarted=new BotStatusStore(path.join(root,'bot-status.json'));await restarted.load();assert.deepEqual(restarted.get(),value);
 assert.equal((await post({...value,enabled:false})).status,200);assert.equal(updates,2);assert.deepEqual(statusActivities(store.get()),[]);assert.equal(store.get().text,value.text);
 await post({...value,text:'<script>bad()</script>'});response=await fetch(url);const html=await response.text();assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;'));assert.ok(!html.includes('value="<script>'));
 }finally{await service?.close();await rm(root,{recursive:true,force:true});}
});
test('Discord /admin verifies the application owner even with server permissions or a restricted role',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-owner-command-'));process.env.DISCORD_TOKEN='offline-test-token';process.env.RECORDING_PATH=root;
 const {createDiscordClient,settingsStore,closeRecordingPanels}=require('../dist/discord/client');let service;
 try{await settingsStore.load();await settingsStore.update('123',{restrictAccess:true,accessRoleID:'456'});const store=new BotStatusStore(path.join(root,'bot-status.json'));await store.load();service=await DownloadService.create(root,'https://example.com');const client=createDiscordClient(service,undefined,store);client.getOAuthApplication=async()=>({owner:{id:'owner'},team:null});
 async function command(id){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('No reply')),2000);const interaction={type:2,data:{name:'admin'},guildID:'123',member:{id,roles:[],permissions:{has:()=>true}},acknowledged:false,defer:async()=>{interaction.acknowledged=true;},editOriginalMessage:async body=>{clearTimeout(timer);resolve(body);},createMessage:async body=>{clearTimeout(timer);resolve(body);}};client.emit('interactionCreate',interaction);});}
 assert.match((await command('manager')).content,/Only the Discord application owner/);assert.match((await command('owner')).content,/https:\/\/example.com\/admin\/control\?/);
 }finally{await service?.close();await closeRecordingPanels();await rm(root,{recursive:true,force:true});}
});

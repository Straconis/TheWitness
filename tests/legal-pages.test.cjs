const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,rm}=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {DownloadService}=require('../dist/downloads/service');
test('policy routes are public, support HEAD, reject mutations and preserve private access',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-legal-'));let service;
 try{
  service=await DownloadService.create(root,'https://example.com');
  const port=await service.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${port}`;
  for(const route of ['/terms','/privacy','/terms/','/privacy/']){
   const response=await fetch(base+route);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/html/);
   const html=await response.text();assert.match(html,/self-hosted/);assert.match(html,/<main/);assert.match(html,/mailto:support@thewitness.dev/);assert.match(html,/href="\/privacy"/);
   assert.equal(response.headers.get('referrer-policy'),'no-referrer');
   const head=await fetch(base+route,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
   const post=await fetch(base+route,{method:'POST'});assert.equal(post.status,405);await post.text();
  }
  const invite=await fetch(base+'/invite');assert.equal(invite.status,200);
  const inviteHTML=await invite.text();assert.match(inviteHTML,/Add to Discord/);assert.match(inviteHTML,/client_id=1542557380594761778/);assert.match(inviteHTML,/scope=bot%20applications.commands/);
  assert.equal((await fetch(base+'/invite',{method:'HEAD'})).status,200);
  assert.equal((await fetch(base+'/invite',{method:'POST'})).status,405);
  const denied=await fetch(base+'/recording/11111111-1111-4111-8111-111111111111');assert.equal(denied.status,403);await denied.text();
  const unknown=await fetch(base+'/privacy-extra');assert.equal(unknown.status,404);await unknown.text();
 }finally{await service?.close();await rm(root,{recursive:true,force:true});}
});

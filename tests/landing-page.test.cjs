const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,rm}=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {DownloadService}=require('../dist/downloads/service');
const {landingPage}=require('../dist/downloads/landing-page');
test('landing page is public, uses the official invite and loads nothing from third parties',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-landing-'));let service;
 try{
  service=await DownloadService.create(root,'https://example.com');
  const port=await service.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${port}`;
  const response=await fetch(base+'/');assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/html/);
  const html=await response.text();
  assert.match(html,/client_id=1542557380594761778/);assert.match(html,/href="\/privacy"/);assert.match(html,/https:\/\/example\.com\/assets\/witness-banner\.png/);
  for(const [,url] of html.matchAll(/<(?:img|script|link|video|source|iframe)\b[^>]*\b(?:src|href)="([^"]+)"/g))if(!url.startsWith('/')&&!url.startsWith('https://example.com/'))assert.fail('external resource '+url);
  assert.equal((await fetch(base+'/',{method:'HEAD'})).status,200);
  assert.equal((await fetch(base+'/',{method:'POST'})).status,405);
 }finally{await service?.close();await rm(root,{recursive:true,force:true});}
});
test('placeholders disappear once the real demo and sample are present',()=>{
 const missing=landingPage({demo:false,sample:false},'https://example.com');
 assert.match(missing,/data-placeholder="demo"/);assert.match(missing,/data-placeholder="sample"/);assert.doesNotMatch(missing,/<video/);assert.doesNotMatch(missing,/sample-export\.zip/);
 const present=landingPage({demo:true,sample:true},'https://example.com');
 assert.doesNotMatch(present,/data-placeholder/);assert.match(present,/<video[^>]+\/assets\/landing\/demo\.mp4/);assert.match(present,/\/assets\/landing\/sample-export\.zip/);
});
test('landing assets support ranges and stay limited to their fixed names',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-landing-'));let service;
 try{
  service=await DownloadService.create(root,'https://example.com');
  const port=await service.listen(0,'127.0.0.1'),base=`http://127.0.0.1:${port}`,route=base+'/assets/landing/banner.webp';
  const full=await fetch(route);assert.equal(full.status,200);assert.equal(full.headers.get('content-type'),'image/webp');assert.equal(full.headers.get('accept-ranges'),'bytes');await full.arrayBuffer();
  const part=await fetch(route,{headers:{range:'bytes=0-3'}});assert.equal(part.status,206);assert.equal(Buffer.from(await part.arrayBuffer()).toString(),'RIFF');
  const bad=await fetch(route,{headers:{range:'bytes=999999999-'}});assert.equal(bad.status,416);await bad.text();
  assert.equal((await fetch(route,{method:'POST'})).status,405);
  for(const other of ['/assets/landing/README.md','/assets/landing/..%2f..%2fpackage.json']){const response=await fetch(base+other);assert.equal(response.status,404);await response.text();}
 }finally{await service?.close();await rm(root,{recursive:true,force:true});}
});

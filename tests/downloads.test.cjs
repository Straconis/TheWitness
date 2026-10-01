const test = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp,mkdir,writeFile,rm,symlink } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DownloadService } = require('../dist/downloads/service');
const id = '11111111-1111-4111-8111-111111111111';
const exportName = 'export-22222222-2222-4222-8222-222222222222';

test('private downloads authenticate, stream ranges and preserve signing keys across restarts', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(),'witness-download-'));
 let service;
 try {
  const directory=path.join(root,id,exportName); await mkdir(directory,{recursive:true});
  await writeFile(path.join(directory,'track-1.ogg'),'0123456789');
  await writeFile(path.join(directory,'manifest.json'),JSON.stringify({format:'ogg',tracks:[{file:'track-1.ogg',username:'<script>bad</script>'}]}));
  service = await DownloadService.create(root,'https://example.com');
  const port = await service.listen(0,'127.0.0.1');
  const local = url => url.replace('https://example.com',`http://127.0.0.1:${port}`);
  const link=local(service.link(id,exportName));
  const page=await fetch(link); assert.equal(page.status,200);
  const html=await page.text(); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
  assert.equal(page.headers.get('referrer-policy'),'no-referrer');
  const url=new URL(link); url.pathname+='/track-1.ogg';
  const audio=await fetch(url); assert.equal(await audio.text(),'0123456789');
  const partial=await fetch(url,{headers:{Range:'bytes=2-5'}});
  assert.equal(partial.status,206); assert.equal(partial.headers.get('content-range'),'bytes 2-5/10'); assert.equal(await partial.text(),'2345');
  const head=await fetch(url,{method:'HEAD'}); assert.equal(head.status,200); assert.equal(head.headers.get('content-length'),'10'); assert.equal(await head.text(),'');
  const invalidRange=await fetch(url,{headers:{Range:'bytes=20-30'}}); assert.equal(invalidRange.status,416); await invalidRange.text();
  const tampered=new URL(link); tampered.searchParams.set('signature','0'.repeat(64));
  const rejected=await fetch(tampered); assert.equal(rejected.status,403); await rejected.text();
  const expired=await fetch(local(service.link(id,exportName,-10))); assert.equal(expired.status,403); await expired.text();
  const missing=new URL(link); missing.pathname+='/session.json';
  const denied=await fetch(missing); assert.equal(denied.status,404); await denied.text();
  const noKey=new URL(link); noKey.search=''; const forbidden=await fetch(noKey); assert.equal(forbidden.status,403); await forbidden.text();
  await rm(path.join(directory,'track-1.ogg'));
  await writeFile(path.join(root,'secret'),'do not expose');
  await symlink(path.join(root,'secret'),path.join(directory,'track-1.ogg'));
  const noSymlink=await fetch(url); assert.notEqual(noSymlink.status,200); assert.ok(!(await noSymlink.text()).includes('do not expose'));
  await service.close();
  service=await DownloadService.create(root,'https://example.com');
  const nextPort=await service.listen(0,'127.0.0.1');
  const restored=await fetch(link.replace(`:${port}`,`:${nextPort}`)); assert.equal(restored.status,200); await restored.text();
 } finally { await service?.close(); await rm(root,{recursive:true,force:true}); }
});

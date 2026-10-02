const test=require('node:test'),assert=require('node:assert/strict');
const {mkdtemp,mkdir,writeFile,rm}=require('node:fs/promises');
const os=require('node:os'),path=require('node:path');
const {DownloadService}=require('../dist/downloads/service');
const {recordingPage}=require('../dist/downloads/recording-page');
test('completed project jobs deliver a signed ZIP and retain recording, mixer and file navigation',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-delivery-'));let service;
 const sessionID='11111111-1111-4111-8111-111111111111',jobID='22222222-2222-4222-8222-222222222222',directory='export-33333333-3333-4333-8333-333333333333';
 const job={id:jobID,sessionID,guildID:'guild',state:'completed',directory,format:'audacity'};
 try{
  await mkdir(path.join(root,sessionID,directory),{recursive:true});
  await writeFile(path.join(root,sessionID,directory,'project.zip'),'PK-fixture');
  await writeFile(path.join(root,sessionID,directory,'manifest.json'),JSON.stringify({format:'audacity',project:'project.zip',startedAt:'2026-10-02T12:00:00Z',tracks:[]}));
  service=await DownloadService.create(root,'https://example.com');service.attach({get:()=>job},{get:()=>({})},{});
  const port=await service.listen(0,'127.0.0.1');const local=url=>url.replace('https://example.com',`http://127.0.0.1:${port}`);
  for(const format of ['audacity','audition']){
   job.format=format;const response=await fetch(local(service.jobLink(jobID)),{headers:{Accept:'application/json'}});assert.equal(response.status,200);const data=await response.json();
   assert.equal(new URL(data.downloadURL).pathname,`/download/${sessionID}/${directory}/project.zip`);
   assert.equal(new URL(data.mixerURL).searchParams.get('editor'),'1');assert.equal(new URL(data.recordingURL).pathname,`/recording/${sessionID}`);
   const zip=await fetch(local(data.downloadURL));assert.equal(zip.status,200);assert.equal(await zip.text(),'PK-fixture');assert.match(zip.headers.get('content-disposition'),/attachment; filename="2026-10-02.zip"/);
   const altered=new URL(data.downloadURL);altered.searchParams.set('signature','0'.repeat(64));assert.equal((await fetch(local(altered.toString()))).status,403);
  }
  job.sourceExport='export-44444444-4444-4444-8444-444444444444';const edited=await (await fetch(local(service.jobLink(jobID)),{headers:{Accept:'application/json'}})).json();assert.ok(edited.mixerURL.includes(job.sourceExport));
  job.state='running';const pending=await (await fetch(local(service.jobLink(jobID)),{headers:{Accept:'application/json'}})).json();assert.equal(pending.downloadURL,undefined);
 }finally{await service?.close();await rm(root,{recursive:true,force:true});}
});
test('export settings precede format actions',()=>{const html=recordingPage({id:'session',channelID:'voice',startedAt:'2026-10-02T00:00:00Z',tracks:[]},true);assert.ok(html.indexOf('id="normalize"')<html.indexOf('data-format="audacity"'));assert.ok(html.indexOf('id="transcribe"')<html.indexOf('data-format="audacity"'));});

const test=require('node:test');const assert=require('node:assert/strict');
const {mkdtemp,writeFile,utimes,rm}=require('node:fs/promises');const path=require('node:path');const os=require('node:os');
const {assertDeploymentIdle}=require('../dist/storage/deployment');
test('pending deployment pauses new work and stale markers expire',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'witness-deploy-'));
 try{
  await assertDeploymentIdle(root);const marker=path.join(root,'.deploy-pending');await writeFile(marker,'pending');
  await assert.rejects(assertDeploymentIdle(root),/update is being prepared/);
  const stale=new Date(Date.now()-41*60*1000);await utimes(marker,stale,stale);await assertDeploymentIdle(root);
 }finally{await rm(root,{recursive:true,force:true});}
});

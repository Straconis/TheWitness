// Run from the production application directory so its .env selects the data directory.
const fs=require('node:fs');const path=require('node:path');
try{
 const {config}=require(path.join(process.cwd(),'dist/config'));
 const root=config.recordingPath;
 if(process.argv[2]==='prepare'){fs.writeFileSync(path.join(root,'.deploy-pending'),'GitHub deployment pending\n');process.exit(0);}
 if(process.argv[2]==='clear'){fs.rmSync(path.join(root,'.deploy-pending'),{force:true});process.exit(0);}
 for(const entry of fs.readdirSync(root,{withFileTypes:true})){
  if(!entry.isDirectory()||!/^[0-9a-f-]{36}$/i.test(entry.name))continue;
  const metadata=JSON.parse(fs.readFileSync(path.join(root,entry.name,'session.json'),'utf8'));
  if(metadata.state==='recording')process.exit(1);
 }
 const jobs=path.join(root,'jobs');
 if(fs.existsSync(jobs))for(const name of fs.readdirSync(jobs)){
  if(!name.endsWith('.json'))continue;
  const job=JSON.parse(fs.readFileSync(path.join(jobs,name),'utf8'));
  if(['queued','running','cancelling'].includes(job.state))process.exit(1);
 }
}catch(error){console.error('Cannot confirm deployment is idle:',error.message);process.exit(1);}

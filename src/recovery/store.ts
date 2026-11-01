import {deleteSession} from "../storage/delete";
import {spawn,ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,readdir,rm,statfs,open,stat,link} from 'node:fs/promises';
import path from 'node:path';
import {assertDeploymentIdle} from '../storage/deployment';
import {defaultAudioTool} from '../exports/speech-cleanup';
import {deprioritize} from '../exports/process';
import {sessionIDPattern} from '../storage/sessions';
export const RECOVERY_CHUNK=512*1024;
const LIMIT=32*1024**3;
interface UploadFile {name:string;size:number;received:number}
export interface RecoveryJob {id:string;title:string;projectType:string;state:'uploading'|'importing'|'ready'|'failed'|'cancelled';createdAt:string;updatedAt:string;files:UploadFile[];stage:string;error?:string;sessionID?:string;sourceExport?:string;warnings?:string[]}
/** Owner-only persistent uploads; one bounded offline importer runs at a time. */
export class RecoveryStore {
 private loading?:Promise<void>;private jobs=new Map<string,RecoveryJob>();private pending:Promise<unknown>=Promise.resolve();private active?:{id:string;child:ChildProcess;done:Promise<void>};private closed=false;
 constructor(private root:string){}
 private base(id:string){if(!sessionIDPattern.test(id))throw Error('Invalid recovery ID.');return path.join(this.root,'recovery',id);}
 private async save(job:RecoveryJob){job.updatedAt=new Date().toISOString();const file=path.join(this.base(job.id),'state.json');await writeFile(file+'.tmp',JSON.stringify(job),{mode:0o600});await rename(file+'.tmp',file);}
 private serial<T>(task:()=>Promise<T>):Promise<T>{const result=this.pending.then(task);this.pending=result.catch(()=>{});return result;}
 private init(){return this.loading??=this.load();}
 private async load(){
  await mkdir(path.join(this.root,'recovery'),{recursive:true,mode:0o700});
  for(const item of await readdir(path.join(this.root,'recovery'),{withFileTypes:true}))if(item.isDirectory()&&sessionIDPattern.test(item.name)){
   try{const job=JSON.parse(await readFile(path.join(this.base(item.name),'state.json'),'utf8')) as RecoveryJob;if(job.id!==item.name||!Array.isArray(job.files)||!['uploading','importing','ready','failed','cancelled'].includes(job.state))throw Error('Invalid recovery state');
    if(job.state==='importing'){
     // A completed atomic publication survives a crash just before the status save.
     let committed=false;if(job.sessionID&&sessionIDPattern.test(job.sessionID))try{const saved=JSON.parse(await readFile(path.join(this.root,job.sessionID,'session.json'),'utf8'));committed=saved.id===job.sessionID&&saved.recoveryID===job.id;}catch{}
     if(!committed&&job.sessionID&&sessionIDPattern.test(job.sessionID))await rm(path.join(this.root,'recovery-session-'+job.sessionID),{recursive:true,force:true});
     job.state=committed?'ready':'failed';job.stage=committed?'Audio ready':'Import interrupted by restart';job.error=committed?undefined:'The service restarted during import. Your uploaded files are retained; retry the import.';await this.save(job);
    }
    this.jobs.set(job.id,job);
   }catch(error){console.warn('[Recovery] Skipped unreadable recovery state',item.name);}
  }
 }
 async list(){await this.init();return [...this.jobs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(j=>structuredClone(j));}
 private owned(id:string){this.base(id);const job=this.jobs.get(id);if(!job)throw Error('Recovery not found.');return job;}
 private reserve(){const gib=Number(process.env.LOW_DISK_WARNING_GIB?.trim()||1);if(!Number.isFinite(gib)||gib<=0)throw Error('Invalid recording disk reserve.');return gib*1024**3;}
 private async space(extra=0){const s=await statfs(this.root);if(Number(s.bavail)*Number(s.bsize)<this.reserve()+extra)throw Error('Not enough free disk space for this upload while preserving the recording reserve.');}
 async create(data:any){await this.init();return this.serial(async()=>{
  await assertDeploymentIdle(this.root);if(this.closed)throw Error('Recovery service is stopping.');
  if(this.jobs.size>=100)throw Error('Remove an old recovery before starting another.');
  if([...this.jobs.values()].filter(j=>['uploading','importing'].includes(j.state)).length>=4)throw Error('Finish or remove an existing upload before starting another.');
  const title=typeof data.title==='string'?data.title.trim():'';
  if(!title||title.length>120||/[\x00-\x1f\x7f]/.test(title))throw Error('Enter a title of 1–120 characters.');
  const projectType=data.projectType??'auto';if(!['auto','soundcraft','audition','audacity','audio'].includes(projectType))throw Error('Invalid project type.');
  if(!Array.isArray(data.files)||!data.files.length||data.files.length>200)throw Error('Choose between 1 and 200 files or ZIP bundles.');
  const names=new Set<string>();let total=0;
  const files:UploadFile[]=data.files.map((f:any)=>{
   if(typeof f.name!=='string'||f.name.length>500||/[\x00-\x1f\x7f]/.test(f.name)||f.name.startsWith('/')||f.name.includes('\\')||f.name.split('/').some((part:string)=>part==='..'||!part)||f.name.includes(':')||!Number.isSafeInteger(f.size)||f.size<=0||f.size>LIMIT||!(/\.(zip|scraftz|scraft|sesx|aup3|wav|flac|ogg|mp3|m4a|aac|opus)$/i.test(f.name)))throw Error('Unsupported file or invalid file size/path. Use audio, .sesx, .scraft, .scraftz, .aup3 or ZIP.');
   if(names.has(f.name))throw Error('Duplicate upload filename. Use folder upload to preserve distinct media paths.');names.add(f.name);total+=f.size;return {name:f.name,size:f.size,received:0};
  });
  if(total>LIMIT)throw Error('Recovery uploads are limited to 32 GiB total.');
  const reserved=[...this.jobs.values()].filter(j=>j.state==='uploading').reduce((n,j)=>n+j.files.reduce((sum,f)=>sum+f.size-f.received,0),0);await this.space(total+reserved);
  const now=new Date().toISOString(),job:RecoveryJob={id:randomUUID(),title,projectType,state:'uploading',createdAt:now,updatedAt:now,files,stage:'Waiting for upload'};
  await mkdir(path.join(this.base(job.id),'files'),{recursive:true,mode:0o700});await this.save(job);this.jobs.set(job.id,job);return structuredClone(job);
 });}
 async chunk(id:string,index:number,offset:number,encoded:string){await this.init();return this.serial(async()=>{
  const job=this.owned(id);if(job.state!=='uploading')throw Error('This upload is no longer accepting files.');
  if(!Number.isSafeInteger(index)||!job.files[index]||!Number.isSafeInteger(offset)||offset<0||typeof encoded!=='string'||encoded.length>Math.ceil(RECOVERY_CHUNK/3)*4||!(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)))throw Error('Invalid upload chunk.');
  const bytes=Buffer.from(encoded,'base64'),file=job.files[index]!;
  if(!bytes.length||bytes.length>RECOVERY_CHUNK||offset+bytes.length>file.size)throw Error('Upload chunk exceeds the declared file size.');
  const target=path.join(this.base(id),'files',String(index));
  // Reconcile a crash after writing bytes but before saving the received offset.
  let size=0;try{size=(await stat(target)).size;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(size>file.size)throw Error('Stored upload size is invalid. Remove this upload and start again.');
  file.received=size;
  if(offset<size){const handle=await open(target,'r');try{const previous=Buffer.alloc(bytes.length);const read=await handle.read(previous,0,bytes.length,offset);if(read.bytesRead!==bytes.length||!previous.equals(bytes))throw Error('Retry data does not match the uploaded chunk.');}finally{await handle.close();}await this.save(job);return {received:size};}
  if(offset!==size)throw Error('Upload offset mismatch. Refresh and resume using the same files.');
  await this.space(bytes.length);const handle=await open(target,size?'r+':'wx',0o600);try{let written=0;while(written<bytes.length){const result=await handle.write(bytes,written,bytes.length-written,size+written);if(!result.bytesWritten)throw Error('Upload write did not advance.');written+=result.bytesWritten;}await handle.sync();}finally{await handle.close();}
  file.received=size+bytes.length;job.stage='Uploading files';await this.save(job);return {received:file.received};
 });}
 async start(id:string){await this.init();return this.serial(async()=>{
  await assertDeploymentIdle(this.root);if(this.closed)throw Error('Recovery service is stopping.');if(this.active)throw Error('Another recovery is preparing audio. Wait for it to finish.');
  const job=this.owned(id);if(!['uploading','failed'].includes(job.state))throw Error('This recovery cannot be imported now.');
  for(let i=0;i<job.files.length;i++){const size=(await stat(path.join(this.base(id),'files',String(i)))).size;if(size!==job.files[i]!.size)throw Error('Finish uploading every file before importing.');job.files[i]!.received=size;}
  await this.space();job.state='importing';job.stage='Preparing import';job.error=undefined;job.sessionID??=randomUUID();job.sourceExport??='export-'+randomUUID();await this.save(job);
  const temporary=path.join(this.root,'recovery-session-'+job.sessionID);await rm(temporary,{recursive:true,force:true});await mkdir(temporary,{mode:0o700});
  const request={files:job.files.map((f,index)=>({name:f.name,path:path.join(this.base(id),'files',String(index))})),projectType:job.projectType,reserveBytes:this.reserve()};
  const requestFile=path.join(this.base(id),'request.json');await writeFile(requestFile,JSON.stringify(request),{mode:0o600});
  const child=spawn('python3',[path.resolve(__dirname,'../../scripts/recover-audio.py'),requestFile,temporary,defaultAudioTool()],{stdio:['ignore','pipe','pipe'],detached:process.platform!=='win32'});deprioritize(child);
  let lines='',stderr='',publicError:string|undefined,spawnError:Error|undefined,killed=false;
  const kill=()=>{killed=true;try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{}};
  const timeout=setTimeout(kill,24*3600*1000);timeout.unref();
  const guard=setInterval(()=>{void this.space().catch(()=>{publicError='Import stopped because storage reached the recording reserve. Uploaded originals are retained.';kill();});},3000);guard.unref();
  child.stdout!.on('data',chunk=>{lines+=chunk.toString();const complete=lines.split('\n');lines=complete.pop()!.slice(-8192);for(const line of complete)try{const data=JSON.parse(line);if(typeof data.error==='string')publicError=data.error.slice(0,500);if(typeof data.stage==='string'){job.stage=data.stage.slice(0,250);void this.serial(()=>this.save(job)).catch(()=>{});}}catch{}});
  child.stderr!.on('data',chunk=>stderr=(stderr+chunk).slice(-8192));child.on('error',error=>{spawnError=error;});
  const done=new Promise<void>(resolve=>child.once('close',code=>{void this.serial(async()=>{
   clearTimeout(timeout);clearInterval(guard);
   try{
    if(job.state==='cancelled'){await rm(temporary,{recursive:true,force:true});return;}
    if(code!==0||spawnError||killed)throw Error(publicError??(spawnError?'Recovery requires Python 3 on the host.':'Import stopped before completion. Your uploads are retained; retry the import.'));
    const result=JSON.parse(await readFile(path.join(temporary,'result.json'),'utf8'));
    if(!Array.isArray(result.tracks)||!result.tracks.length||!Number.isSafeInteger(result.durationSamples)||result.durationSamples<=0)throw Error('Invalid imported audio result.');
    const metadata={id:job.sessionID,title:job.title,guildID:'owner-recovery',guildName:'Owner recovery',channelID:'recovered-audio',channelName:'Recovered project',startedAt:job.createdAt,state:'completed',audioOrigin:0,durationSamples:result.durationSamples,sourceType:'audio-import',recoveryID:job.id,recoveryWarnings:result.warnings,tracks:result.tracks};
    await writeFile(path.join(temporary,'session.json'),JSON.stringify(metadata,null,2));
    await writeFile(path.join(temporary,'recovery-import.json'),JSON.stringify({files:job.files.map(({name,size})=>({name,size})),projectType:job.projectType,warnings:result.warnings},null,2));
    if(result.notes?.length)await writeFile(path.join(temporary,'notes.jsonl'),result.notes.map((n:any)=>JSON.stringify(n)).join('\n')+'\n');
    const seed=path.join(temporary,job.sourceExport!);await mkdir(seed);
    const tracks=result.tracks.map((t:any)=>({file:`track-${t.track}.flac`,userID:t.id,username:t.username}));
    for(const t of result.tracks)await link(path.join(temporary,t.sourceFile),path.join(seed,`track-${t.track}.flac`));
    await writeFile(path.join(seed,'manifest.json'),JSON.stringify({...metadata,sessionID:job.sessionID,format:'flac',tracks,normalizeAudio:false,cleanupAudio:false}));
    await rename(temporary,path.join(this.root,job.sessionID!));job.state='ready';job.stage='Audio ready';job.warnings=result.warnings;
   }catch(error){job.state='failed';job.error=error instanceof Error?error.message:'Import failed.';job.stage='Import failed';await rm(temporary,{recursive:true,force:true});console.warn('[Recovery] Import failed',job.id,stderr);}
   finally{await this.save(job);this.active=undefined;}
  }).catch(error=>console.error('[Recovery] Could not save import result',error)).finally(resolve);}));
  this.active={id,child,done};return structuredClone(job);
 });}
 async remove(id:string){await this.init();
  // Stop the process tree before deleting its workspace or upload inputs.
  if(this.active?.id===id){const active=this.active;await this.serial(async()=>{const job=this.owned(id);job.state='cancelled';job.stage='Cancelled';await this.save(job);try{if(active.child.pid&&process.platform!=='win32')process.kill(-active.child.pid,'SIGKILL');else active.child.kill('SIGKILL');}catch{}});await active.done;}
  return this.serial(async()=>{const job=this.owned(id);if(job.state==='ready'){await rm(path.join(this.base(id),'files'),{recursive:true,force:true});await rm(path.join(this.base(id),'request.json'),{force:true});job.files=[];await this.save(job);return {removed:true};}if(job.sessionID&&sessionIDPattern.test(job.sessionID))await rm(path.join(this.root,'recovery-session-'+job.sessionID),{recursive:true,force:true});await rm(this.base(id),{recursive:true,force:true});this.jobs.delete(id);return {removed:true};});
 }
 async readySession(id:string){await this.init();const job=this.owned(id);if(job.state!=='ready'||!job.sessionID)throw Error('Recovered recording is not ready.');return job.sessionID;}
 async deleteRecording(id:string){await this.init();return this.serial(async()=>{const job=this.owned(id);if(job.state!=='ready'||!job.sessionID)throw Error('Recovered recording is not ready.');const metadata=JSON.parse(await readFile(path.join(this.root,job.sessionID,'session.json'),'utf8'));if(metadata.recoveryID!==id)throw Error('Recovery ownership does not match.');await deleteSession(this.root,job.sessionID,'owner-recovery');await rm(this.base(id),{recursive:true,force:true});this.jobs.delete(id);return {deleted:true};});}
 async close(){this.closed=true;await this.pending;if(this.active){const active=this.active;try{if(active.child.pid&&process.platform!=='win32')process.kill(-active.child.pid,'SIGKILL');else active.child.kill('SIGKILL');}catch{}await active.done;}await this.pending;}
}

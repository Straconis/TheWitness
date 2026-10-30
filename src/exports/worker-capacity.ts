/** Experimental admission policy and worker pool. Not connected to production exports. */
import {availableParallelism,totalmem,freemem} from "node:os";
import {readFile,statfs} from "node:fs/promises";
import path from "node:path";
export const MiB=1024**2;
export interface WorkerResources {cpuCores:number;memoryLimitBytes:number;memoryAvailableBytes:number;diskAvailableBytes:number;lowSpaceMode?:boolean}
export interface WorkerPolicy {automatic?:boolean;maxWorkers:number;cpuPerWorker:number;reserveCores:number;memoryPerWorkerBytes:number;reserveMemoryBytes:number;temporaryBytesPerWorker:number;reserveDiskBytes:number}
export function planWorkers(resources:WorkerResources,policy:WorkerPolicy){
 for(const [key,value] of Object.entries({...resources,...policy}))if(typeof value==="number"&&(!Number.isFinite(value)||value<0))throw Error('Invalid resource budget: '+key);
 if(!Number.isInteger(policy.maxWorkers)||policy.maxWorkers<1||policy.cpuPerWorker<=0||policy.memoryPerWorkerBytes<=0||policy.temporaryBytesPerWorker<=0)throw Error('Invalid worker policy');
 const cpu=Math.max(0,resources.cpuCores),memory=Math.floor(Math.max(0,Math.min(resources.memoryLimitBytes,resources.memoryAvailableBytes)-policy.reserveMemoryBytes)/policy.memoryPerWorkerBytes),disk=Math.floor(Math.max(0,resources.diskAvailableBytes-policy.reserveDiskBytes)/policy.temporaryBytesPerWorker);
 const cpuWorkers=cpu>0?Math.max(1,Math.floor(Math.max(0,cpu-policy.reserveCores)/policy.cpuPerWorker)):0;
 const cap=policy.automatic&&!resources.lowSpaceMode?policy.maxWorkers:1;
 const workers=Math.min(cap,cpuWorkers,memory,disk);
 return {workers,cpuWorkers,memoryWorkers:memory,diskWorkers:disk,reason:workers===0?'insufficient resources':resources.lowSpaceMode?'low-space serial':!policy.automatic?'parallel disabled':workers===1?'serial capacity':'bounded parallel'};
}
export async function runAdaptiveWorkers<T>(items:readonly T[],policy:WorkerPolicy,snapshot:()=>Promise<WorkerResources>,work:(item:T,index:number,signal:AbortSignal)=>Promise<void>,options:{signal?:AbortSignal;onAdmission?:(row:{index:number;active:number;decision:ReturnType<typeof planWorkers>})=>void}={}){
 const controller=new AbortController(),signal=options.signal?AbortSignal.any([options.signal,controller.signal]):controller.signal;
 const active=new Set<Promise<void>>();let cursor=0,failure:unknown;
 try{
  while(cursor<items.length||active.size){
   signal.throwIfAborted();
   let launched=false;
   if(cursor<items.length){
    const resources=await snapshot();signal.throwIfAborted();const decision=planWorkers(resources,policy);
    // Reserve each active worker's full potential extra allocation. This deliberately
    // double-counts already-consumed resources rather than risking over-admission.
    const memoryOK=resources.memoryAvailableBytes-policy.reserveMemoryBytes>=(active.size+1)*policy.memoryPerWorkerBytes;
    const diskOK=resources.diskAvailableBytes-policy.reserveDiskBytes>=(active.size+1)*policy.temporaryBytesPerWorker;
    if(active.size<decision.workers&&memoryOK&&diskOK){
     const index=cursor++;options.onAdmission?.({index,active:active.size+1,decision});
     let pending:Promise<void>;
     pending=Promise.resolve().then(()=>{signal.throwIfAborted();return work(items[index]!,index,signal);}).catch(error=>{if(failure===undefined)failure=error;controller.abort(error);}).finally(()=>active.delete(pending));active.add(pending);launched=true;
    }else if(!active.size)throw Error('Worker admission deferred: '+decision.reason);
   }
   if(!launched&&active.size)await Promise.race(active);
   if(failure!==undefined)throw failure;
  }
 }finally{controller.abort();await Promise.allSettled([...active]);}
}
const maybeRead=async(file:string)=>{try{return await readFile(file,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw error;}};
/** A child quota cannot override any visible ancestor. Missing controllers are unrestricted. */
export async function visibleCgroupLimits(relative:string,reader:(file:string)=>Promise<string|undefined>=maybeRead){
 const base='/sys/fs/cgroup';let directory=path.join(base,relative),cpu=Infinity,memory=Infinity,available=Infinity;
 if(directory!==base&&!directory.startsWith(base+'/'))throw Error('Invalid cgroup path');
 for(;;){
  const [cpuMax,memMax,memCurrent]=await Promise.all([reader(path.join(directory,'cpu.max')),reader(path.join(directory,'memory.max')),reader(path.join(directory,'memory.current'))]);
  if(cpuMax){const [quota,period]=cpuMax.trim().split(/\s+/);if(quota!=='max'){const cores=Number(quota)/Number(period);if(!Number.isFinite(cores)||cores<=0)throw Error('Invalid CPU quota');cpu=Math.min(cpu,cores);}}
  if(memMax&&memMax.trim()!=='max'){const maximum=Number(memMax),current=Number(memCurrent);if(!Number.isFinite(maximum)||maximum<=0||memCurrent===undefined||!Number.isFinite(current)||current<0)throw Error('Invalid memory limit');memory=Math.min(memory,maximum);available=Math.min(available,Math.max(0,maximum-current));}
  if(directory===base)break;directory=path.dirname(directory);
 }
 return {cpuCores:cpu,memoryLimitBytes:memory,memoryAvailableBytes:available};
}
/** Live snapshots respect affinity, every visible cgroup limit, host memory and recording disk. */
export async function readWorkerResources(root:string):Promise<WorkerResources>{
 const memory=await maybeRead('/proc/meminfo');let available=Number(/^MemAvailable:\s+(\d+) kB$/m.exec(memory??'')?.[1])*1024;
 if(!Number.isFinite(available))available=freemem();let limit=totalmem(),cpu=availableParallelism();
 try{
  const membership=await maybeRead('/proc/self/cgroup'),relative=membership?.split('\n').find(line=>line.startsWith('0::'))?.slice(3);
  if(relative===undefined)throw Error('No cgroup v2 view');
  const limits=await visibleCgroupLimits(relative);cpu=Math.min(cpu,limits.cpuCores);limit=Math.min(limit,limits.memoryLimitBytes);available=Math.min(available,limits.memoryAvailableBytes);
 }catch{cpu=Math.min(cpu,1);available=Math.min(available,512*MiB);}
 const disk=await statfs(root);return {cpuCores:cpu,memoryLimitBytes:limit,memoryAvailableBytes:Math.min(available,limit),diskAvailableBytes:Number(disk.bavail)*Number(disk.bsize)};
}

import {exportFailureMessage} from "./failure";
import {runAdaptiveWorkers,readWorkerResources,planWorkers,WorkerPolicy,MiB} from "./worker-capacity";
import {exportProgressReporter,withExportProgress,exportSpaceChecksActive} from "./workspace";
import {UserError} from "../errors";
export async function trackWorkerPolicy(root:string,seconds:number):Promise<WorkerPolicy>{
 const setting=process.env.EXPORT_PARALLEL_TRACKS?.trim()??"auto";
 if(!["auto","off"].includes(setting))throw new UserError("EXPORT_PARALLEL_TRACKS must be auto or off.");
 const policy:WorkerPolicy={automatic:setting==="auto"&&!exportSpaceChecksActive(),maxWorkers:3,cpuPerWorker:1.5,reserveCores:1,memoryPerWorkerBytes:512*MiB,reserveMemoryBytes:1024*MiB,temporaryBytesPerWorker:Math.max(64*MiB,seconds*288000*2),reserveDiskBytes:Math.max(1024*MiB,Number(process.env.LOW_DISK_WARNING_GIB||1)*1024*MiB)};
 const decision=planWorkers(await readWorkerResources(root),policy);
 return {...policy,automatic:decision.workers>1};
}
/** Aggregate clocks per worker so simultaneous encoders never overwrite each other's progress. */
export async function runTrackWorkers<T>(root:string,items:readonly T[],policy:WorkerPolicy,duration:(item:T)=>number,passes:number,work:(item:T,signal:AbortSignal)=>Promise<void>,signal?:AbortSignal):Promise<void>{
 const report=exportProgressReporter(),clocks=items.map(()=>({offset:0,last:0}));
 const emit=()=>report?.(clocks.reduce((n,c)=>n+c.offset+c.last,0));
 await runAdaptiveWorkers(items,policy,()=>readWorkerResources(root),async(item,index,childSignal)=>{
  try{await withExportProgress(seconds=>{const c=clocks[index]!;if(seconds===0&&c.last>0){c.offset+=c.last;c.last=0;}else c.last=Math.max(c.last,seconds);emit();},()=>work(item,childSignal));}
  catch(error){throw new UserError(exportFailureMessage(error,`speech cleanup for ${(item as {username?:string}).username??index+1}`));}
  clocks[index]={offset:duration(item)*passes,last:0};emit();
 },{signal});
}

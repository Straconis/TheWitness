import {cpus,freemem,totalmem,loadavg,uptime} from "node:os";
import {statfs} from "node:fs/promises";
import {LinuxMetrics,cpuInterval,counterDelta,blockInterval} from "./host-metrics";
export function cpuUsage(previous:{idle:number;total:number},current:{idle:number;total:number}):number|null{const total=current.total-previous.total,idle=current.idle-previous.idle;return total>0&&idle>=0&&idle<=total?Math.max(0,Math.min(100,(1-idle/total)*100)):null;}
const cpuSnapshot=()=>cpus().reduce((sum,cpu)=>({idle:sum.idle+cpu.times.idle,total:sum.total+Object.values(cpu.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0});
export class ServerLoad {
 private linux:LinuxMetrics;private previous?:{time:number;linux:Awaited<ReturnType<LinuxMetrics["read"]>>;cpu:ReturnType<typeof cpuSnapshot>};
 private sampling?:Promise<Awaited<ReturnType<ServerLoad["collect"]>>>;
 constructor(private root:string){this.linux=new LinuxMetrics(root);}
 sample(){return this.sampling??=this.collect().finally(()=>{this.sampling=undefined;});}
 private async collect(){
 const [linux,disk]=await Promise.all([this.linux.read(),statfs(this.root)]),current=cpuSnapshot(),now=performance.now(),previous=this.previous,seconds=previous?(now-previous.time)/1000:0,valid=seconds>=.5;
 const cpu=valid?cpuInterval(previous!.linux.cpu.cpu,linux.cpu.cpu):null;
 const perCore=valid?Object.entries(linux.cpu).filter(([key])=>key!=="cpu").map(([key,value])=>cpuInterval(previous!.linux.cpu[key],value)?.busyPercent).filter((n):n is number=>n!==undefined):[];
 const rate=(before:number|undefined,after:number|undefined)=>{const delta=valid?counterDelta(before,after):null;return delta===null?null:delta/seconds;};
 const total=totalmem(),available=linux.memory.MemAvailable!==undefined?linux.memory.MemAvailable*1024:freemem(),diskTotal=Number(disk.blocks)*Number(disk.bsize),diskAvailable=Number(disk.bavail)*Number(disk.bsize);
 const usage=rate(previous?.linux.serviceCPU.usage_usec,linux.serviceCPU.usage_usec),throttled=valid?counterDelta(previous?.linux.serviceCPU.throttled_usec,linux.serviceCPU.throttled_usec):null;
 const result={cpuPercent:cpu?.busyPercent??(valid?cpuUsage(previous!.cpu,current):null),cpuCores:cpus().length,busiestCorePercent:perCore.length?Math.max(...perCore):null,ioWaitPercent:cpu?.ioWaitPercent??null,stealPercent:cpu?.stealPercent??null,
 loadAverage:loadavg(),memory:{totalBytes:total,usedBytes:Math.min(total,Math.max(0,total-available))},swap:{totalBytes:linux.memory.SwapTotal===undefined?null:linux.memory.SwapTotal*1024,usedBytes:linux.memory.SwapTotal===undefined||linux.memory.SwapFree===undefined?null:(linux.memory.SwapTotal-linux.memory.SwapFree)*1024,inPagesPerSecond:rate(previous?.linux.vm.pswpin,linux.vm.pswpin),outPagesPerSecond:rate(previous?.linux.vm.pswpout,linux.vm.pswpout)},
 pressure:linux.pressure,blockIO:valid?blockInterval(previous!.linux.block,linux.block,seconds):null,
 service:{cpuCoresUsed:usage===null?null:usage/1e6,cpuQuotaCores:linux.serviceQuotaCores,throttledSeconds:throttled===null?null:throttled/1e6,memoryBytes:linux.serviceMemoryBytes,memoryEvents:linux.serviceMemoryEvents},
 disk:{totalBytes:diskTotal,usedBytes:diskTotal-diskAvailable,availableBytes:diskAvailable},processMemoryBytes:process.memoryUsage().rss,uptimeSeconds:uptime(),sampledAt:new Date().toISOString(),intervalSeconds:valid?seconds:null};
 if(!previous||valid)this.previous={time:now,linux,cpu:current};return result;
 }
}

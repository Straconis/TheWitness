import {cpus,freemem,totalmem,loadavg,uptime} from "node:os";
import {readFile,statfs} from "node:fs/promises";
export function cpuUsage(previous:{idle:number;total:number},current:{idle:number;total:number}):number|null{const total=current.total-previous.total,idle=current.idle-previous.idle;return total>0&&idle>=0&&idle<=total?Math.max(0,Math.min(100,(1-idle/total)*100)):null;}
const cpuSnapshot=()=>cpus().reduce((sum,cpu)=>({idle:sum.idle+cpu.times.idle,total:sum.total+Object.values(cpu.times).reduce((a,b)=>a+b,0)}),{idle:0,total:0});
export class ServerLoad {
 private previous=cpuSnapshot();private sampledAt=Date.now();
 constructor(private root:string){}
 async sample(){const current=cpuSnapshot(),now=Date.now(),cpuPercent=now-this.sampledAt>=500?cpuUsage(this.previous,current):null;if(cpuPercent!==null){this.previous=current;this.sampledAt=now;}
 const total=totalmem();let available=freemem();try{const info=await readFile('/proc/meminfo','utf8'),match=/^MemAvailable:\s+(\d+) kB$/m.exec(info);if(match)available=Number(match[1])*1024;}catch{}
 const disk=await statfs(this.root),diskTotal=Number(disk.blocks)*Number(disk.bsize),diskAvailable=Number(disk.bavail)*Number(disk.bsize);
 return {cpuPercent,cpuCores:cpus().length,loadAverage:loadavg(),memory:{totalBytes:total,usedBytes:Math.max(0,total-available)},disk:{totalBytes:diskTotal,usedBytes:diskTotal-diskAvailable,availableBytes:diskAvailable},processMemoryBytes:process.memoryUsage().rss,uptimeSeconds:uptime(),sampledAt:new Date(now).toISOString()};
 }
}

import {readFile,stat} from "node:fs/promises";
import path from "node:path";
export const optionalText=async(file:string):Promise<string|undefined>=>{try{return await readFile(file,"utf8");}catch{return undefined;}};
export function counters(text:string|undefined):Record<string,number>{const values:Record<string,number>={};for(const line of (text??"").split("\n")){const [key,value]=line.trim().split(/\s+/);if(key&&value!==undefined&&Number.isFinite(Number(value))&&Number(value)>=0)values[key]=Number(value);}return values;}
export interface CPUCounters{busy:number;idle:number;wait:number;steal:number;total:number}
export function cpuCounters(text:string|undefined):Record<string,CPUCounters>{const result:Record<string,CPUCounters>={};for(const line of (text??"").split("\n")){const [name,...fields]=line.trim().split(/\s+/);if(!/^cpu\d*$/.test(name??""))continue;const values=fields.slice(0,8).map(Number);if(values.length!==8||!values.every(n=>Number.isFinite(n)&&n>=0))continue;const [user,nice,system,idle,wait,irq,softirq,steal]=values;result[name]={busy:user!+nice!+system!+irq!+softirq!,idle:idle!,wait:wait!,steal:steal!,total:values.reduce((a,b)=>a+b,0)};}return result;}
export function counterDelta(before:number|undefined,after:number|undefined):number|null{return before!==undefined&&after!==undefined&&Number.isFinite(before)&&Number.isFinite(after)&&after>=before?after-before:null;}
export function cpuInterval(before:CPUCounters|undefined,after:CPUCounters|undefined){if(!before||!after)return null;const total=counterDelta(before.total,after.total),busy=counterDelta(before.busy,after.busy),wait=counterDelta(before.wait,after.wait),steal=counterDelta(before.steal,after.steal);if(!total||busy===null||wait===null||steal===null||busy+wait+steal>total)return null;return {busyPercent:100*busy/total,ioWaitPercent:100*wait/total,stealPercent:100*steal/total};}
export function pressure(text:string|undefined){if(!text)return null;const value=(kind:string)=>{const match=new RegExp(`^${kind}\\s+.*?avg10=([\\d.]+)`,"m").exec(text);return match&&Number.isFinite(Number(match[1]))?Number(match[1]):null;};const some=value("some"),full=value("full");return some===null&&full===null?null:{someAvg10:some,fullAvg10:full};}
export function blockInterval(before:number[]|undefined,after:number[]|undefined,seconds:number){if(!before||!after||before.length<11||after.length<11||seconds<=0)return null;const delta=(i:number)=>counterDelta(before[i],after[i]),reads=delta(0),writes=delta(4),readSectors=delta(2),writeSectors=delta(6),readMS=delta(3),writeMS=delta(7),busyMS=delta(9),weightedMS=delta(10);if([reads,writes,readSectors,writeSectors,readMS,writeMS,busyMS,weightedMS].some(n=>n===null))return null;const count=reads!+writes!;return {readBytesPerSecond:readSectors!*512/seconds,writeBytesPerSecond:writeSectors!*512/seconds,busyPercent:Math.min(100,busyMS!/(seconds*10)),averageRequestMS:count?(readMS!+writeMS!)/count:null,averageQueueDepth:weightedMS!/(seconds*1000)};}
export class LinuxMetrics {
 private group?:Promise<string|undefined>;private device?:Promise<string|undefined>;
 constructor(private root:string,private proc="/proc",private sys="/sys"){}
 async read(){
  this.group??=(async()=>{const info=await optionalText(path.join(this.proc,"self/cgroup")),group=info?.split("\n").find(line=>line.startsWith("0::"))?.slice(3);return group?path.join(this.sys,"fs/cgroup",group):undefined;})();
  this.device??=(async()=>{try{const dev=BigInt((await stat(this.root)).dev),major=((dev>>8n)&0xfffn)|((dev>>32n)&0xfffff000n),minor=(dev&0xffn)|((dev>>12n)&0xffffff00n);return `${major}:${minor}`;}catch{return undefined;}})();
  const [group,device]=await Promise.all([this.group,this.device]);
  const [cpu,memory,vm,cpuPSI,memoryPSI,ioPSI,block,serviceCPU,quota,serviceMemory,events]=await Promise.all([
   optionalText(path.join(this.proc,"stat")),optionalText(path.join(this.proc,"meminfo")),optionalText(path.join(this.proc,"vmstat")),
   ...["cpu","memory","io"].map(name=>optionalText(path.join(this.proc,"pressure",name))),
   device?optionalText(path.join(this.sys,"dev/block",device,"stat")):undefined,
   group?optionalText(path.join(group,"cpu.stat")):undefined,group?optionalText(path.join(group,"cpu.max")):undefined,
   group?optionalText(path.join(group,"memory.current")):undefined,group?optionalText(path.join(group,"memory.events")):undefined,
  ]);
  const mem=counters(memory?.replace(/:/g,"")),quotaParts=quota?.trim().split(/\s+/).map(Number);
  const blockValues=block?.trim().split(/\s+/).map(Number);
  return {cpu:cpuCounters(cpu),memory:mem,vm:counters(vm),pressure:{cpu:pressure(cpuPSI),memory:pressure(memoryPSI),io:pressure(ioPSI)},
   block:blockValues?.every(n=>Number.isFinite(n)&&n>=0)?blockValues:undefined,blockDevice:device,
   serviceCPU:counters(serviceCPU),serviceQuotaCores:quotaParts&&Number.isFinite(quotaParts[0])&&quotaParts[1]!>0?quotaParts[0]!/quotaParts[1]!:null,
   serviceMemoryBytes:serviceMemory&&Number.isFinite(Number(serviceMemory))?Number(serviceMemory):null,serviceMemoryEvents:counters(events)};
 }
}

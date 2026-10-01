import { statfs } from "node:fs/promises";
export interface StorageSpace {availableBytes:number;totalBytes:number;warningBytes:number;low:boolean;checkedAt:string}
export class StorageMonitor {
 private latest?:StorageSpace;private timer?:NodeJS.Timeout;private warned=false;private checking?:Promise<StorageSpace>;
 constructor(private root:string,private warningBytes=1024**3,private inspect=statfs,private alert:(message:string)=>void=console.warn){}
 get status():StorageSpace|undefined{return this.latest?{...this.latest}:undefined;}
 check():Promise<StorageSpace>{
  if(this.checking)return this.checking;
  const task=(async()=>{const space=await this.inspect(this.root),availableBytes=Number(space.bavail)*Number(space.bsize),totalBytes=Number(space.blocks)*Number(space.bsize);
   this.latest={availableBytes,totalBytes,warningBytes:this.warningBytes,low:availableBytes<this.warningBytes,checkedAt:new Date().toISOString()};
   if(this.latest.low&&!this.warned)this.alert(`[Storage] Low disk space: ${(availableBytes/1024**3).toFixed(2)} GiB available. Download or remove unwanted recordings before the disk fills. No recordings were deleted.`);
   this.warned=this.latest.low;return {...this.latest};})();this.checking=task;
  void task.finally(()=>{this.checking=undefined;}).catch(()=>{});return task;
 }
 async start():Promise<void>{await this.check();if(this.timer)return;this.timer=setInterval(()=>{void this.check().catch(error=>console.warn("[Storage] Could not check disk space.",error));},60000);this.timer.unref();}
 close():void{if(this.timer)clearInterval(this.timer);this.timer=undefined;}
}

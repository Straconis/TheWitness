import { statfs } from "node:fs/promises";
export interface StorageSpace {availableBytes:number;totalBytes:number;warningBytes:number;low:boolean;criticalBytes:number;critical:boolean;checkedAt:string}
export class StorageMonitor {
 private latest?:StorageSpace;private timer?:NodeJS.Timeout;private warned=false;private criticalFired=false;private checking?:Promise<StorageSpace>;
 /** `criticalBytes` of 0 disables the emergency stop; `onCritical` fires once per transition into the critical state. */
 constructor(private root:string,private warningBytes=1024**3,private inspect=statfs,private alert:(message:string)=>void=console.warn,private criticalBytes=0,private onCritical:()=>void=()=>{}){}
 get status():StorageSpace|undefined{return this.latest?{...this.latest}:undefined;}
 check():Promise<StorageSpace>{
  if(this.checking)return this.checking;
  const task=(async()=>{const space=await this.inspect(this.root),availableBytes=Number(space.bavail)*Number(space.bsize),totalBytes=Number(space.blocks)*Number(space.bsize);
   const critical=this.criticalBytes>0&&availableBytes<this.criticalBytes;
   this.latest={availableBytes,totalBytes,warningBytes:this.warningBytes,low:availableBytes<this.warningBytes,criticalBytes:this.criticalBytes,critical,checkedAt:new Date().toISOString()};
   if(this.latest.low&&!this.warned)this.alert(`[Storage] Low disk space: ${(availableBytes/1024**3).toFixed(2)} GiB available. Download or remove unwanted recordings before the disk fills. No recordings were deleted.`);
   this.warned=this.latest.low;
   if(critical&&!this.criticalFired){
    this.alert(`[Storage] Critically low disk space: ${(availableBytes/1024**2).toFixed(0)} MiB available. Stopping active recordings to protect saved audio; new exports are paused. No recordings were deleted.`);
    try{this.onCritical();}catch(error){console.error("[Storage] Critical-space handler failed.",error);}
   }
   this.criticalFired=critical;return {...this.latest};})();this.checking=task;
  void task.finally(()=>{this.checking=undefined;}).catch(()=>{});return task;
 }
 async start():Promise<void>{await this.check();if(this.timer)return;this.timer=setInterval(()=>{void this.check().catch(error=>console.warn("[Storage] Could not check disk space.",error));},10000);this.timer.unref();}
 close():void{if(this.timer)clearInterval(this.timer);this.timer=undefined;}
}

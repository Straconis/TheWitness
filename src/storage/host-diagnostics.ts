import {ServerLoad} from "./server-load";
export interface DiagnosticWorkload{recordings:number;exports:{running:number;queued:number};jobs:Array<{id:string;format:string;stage:string}>}
/** Small in-memory history; active-work samples persist in the existing system journal. */
export class HostDiagnostics {
 private timer?:NodeJS.Timeout;private pending?:Promise<void>;private closed=true;private active=false;private warned=false;
 private samples:Array<Awaited<ReturnType<ServerLoad["sample"]>>&DiagnosticWorkload>=[];
 constructor(private sampler:Pick<ServerLoad,"sample">,private workload:()=>DiagnosticWorkload,private log:(line:string)=>void=console.info,private intervalMS=15000,private limit=240){}
 history(){return {intervalSeconds:this.intervalMS/1000,maximumSamples:this.limit,samples:this.samples.slice()};}
 start(){if(!this.closed)return;this.closed=false;this.run();}
 private run(){this.pending=(async()=>{try{const sample={...await this.sampler.sample(),...this.workload()};if(this.closed)return;this.samples.push(sample);if(this.samples.length>this.limit)this.samples.splice(0,this.samples.length-this.limit);const active=sample.recordings>0||sample.exports.running>0;if(active||this.active)this.log("[Host metrics] "+JSON.stringify(sample));this.active=active;this.warned=false;}catch{if(!this.closed&&!this.warned){this.log("[Host metrics] Sampling unavailable; retrying.");this.warned=true;}}finally{if(!this.closed){this.timer=setTimeout(()=>this.run(),this.intervalMS);this.timer.unref();}}})();}
 async stop(){this.closed=true;clearTimeout(this.timer);await this.pending;}
}

import { randomUUID } from "node:crypto";
import { readFile,writeFile,rename } from "node:fs/promises";
import path from "node:path";
import type { RecordingManager } from "../recording/manager";
import type { SettingsStore } from "../storage/settings";
export interface RecordingSchedule {id:string;channelID:string;title:string;days:number[];time:string;timezone:string;durationMinutes:number}
export function validateSchedule(rule:RecordingSchedule):void{
 if(!rule||!/^[a-f0-9-]{36}$/i.test(rule.id)||!/^\d{1,25}$/.test(rule.channelID)||typeof rule.title!=="string"||rule.title.length>120||/[\x00-\x1f\x7f]/.test(rule.title)||!Array.isArray(rule.days)||!rule.days.length||rule.days.some(day=>!Number.isInteger(day)||day<0||day>6)||new Set(rule.days).size!==rule.days.length||!/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time)||typeof rule.timezone!=="string"||!Number.isInteger(rule.durationMinutes)||rule.durationMinutes<1||rule.durationMinutes>1440)throw Error("Invalid recording schedule. Choose weekdays, HH:MM, a time zone and 1–1440 minutes.");
 try{new Intl.DateTimeFormat("en-US",{timeZone:rule.timezone}).format();}catch{throw Error("Unknown time zone. Use a name such as America/New_York or UTC.");}
}
export function newSchedule(input:Omit<RecordingSchedule,"id">):RecordingSchedule{const rule={...input,id:randomUUID()};validateSchedule(rule);return rule;}
function localTime(now:Date,zone:string){const parts=new Intl.DateTimeFormat("en-US",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(now);const value=(type:string)=>parts.find(part=>part.type===type)!.value;return {date:value("year")+"-"+value("month")+"-"+value("day"),day:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(value("weekday")),time:value("hour")+":"+value("minute")};}
type State={slots:Record<string,string>;owners:Record<string,{sessionID:string;endsAt:number;ruleID:string}>};
/** Missed starts are not replayed; DST fallback does not record the same local slot twice. */
export class ScheduleRunner {
 private state:State={slots:{},owners:{}};private pending:Promise<void>=Promise.resolve();private timer?:NodeJS.Timeout;
 constructor(private root:string,private settings:SettingsStore,private manager:RecordingManager,private start:(guildID:string,rule:RecordingSchedule)=>Promise<string>,private stop:(guildID:string)=>Promise<void>){}
 async load(){try{this.state=JSON.parse(await readFile(path.join(this.root,"schedule-state.json"),"utf8"));if(!this.state.slots||!this.state.owners)throw Error("Invalid schedule state.");}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
 private async save(){const file=path.join(this.root,"schedule-state.json");await writeFile(file+".tmp",JSON.stringify(this.state));await rename(file+".tmp",file);}
 tick(now=new Date()):Promise<void>{const task=this.pending.catch(()=>{}).then(()=>this.run(now));this.pending=task;return task;}
 private async run(now:Date){
  for(const [guildID,owner] of Object.entries(this.state.owners))if(owner.endsAt<=now.getTime()){
   if(this.manager.sessions.get(guildID)?.id===owner.sessionID)this.manager.cancelReconnect(guildID);
   await this.manager.exclusive(guildID,async()=>{if(this.manager.sessions.get(guildID)?.id===owner.sessionID)await this.stop(guildID);});delete this.state.owners[guildID];await this.save();
  }
  for(const [guildID,settings] of this.settings.all())for(const rule of settings.schedules??[]){
   const local=localTime(now,rule.timezone),key=guildID+":"+rule.id;
   if(!rule.days.includes(local.day)||local.time!==rule.time||this.state.slots[key]===local.date)continue;
   this.state.slots[key]=local.date;await this.save();
   await this.manager.exclusive(guildID,async()=>{
    if(!this.settings.get(guildID).schedules?.some(current=>current.id===rule.id)||this.manager.sessions.has(guildID))return;
    try{const sessionID=await this.start(guildID,rule);this.state.owners[guildID]={sessionID,endsAt:now.getTime()+rule.durationMinutes*60000,ruleID:rule.id};await this.save();}catch(error){console.warn("[Schedule] Could not start selected recording.",error);}
   });
  }
  const active=new Set(this.settings.all().flatMap(([guildID,settings])=>(settings.schedules??[]).map(rule=>guildID+":"+rule.id)));for(const key of Object.keys(this.state.slots))if(!active.has(key))delete this.state.slots[key];
 }
 startTimer(){if(this.timer)return;this.timer=setInterval(()=>void this.tick().catch(error=>console.error("[Schedule]",error)),15000);this.timer.unref();void this.tick().catch(error=>console.error("[Schedule]",error));}
 async close(){if(this.timer)clearInterval(this.timer);await this.pending;}
}

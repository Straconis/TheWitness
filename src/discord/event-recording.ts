import type { SettingsStore } from "../storage/settings";
import type { RecordingManager } from "../recording/manager";
export interface RecordingEvent {id:string;guildID:string;channelID:string|null;entityType:number;status:number;name:string}
export const EMPTY_EVENT_CHANNEL_GRACE_MS = 60_000;
interface EventOwner {eventID:string;sessionID:string;channelID:string;stopOnEnd:boolean}
/** Only explicitly selected voice events start recording; manual stops stay stopped. */
export class EventRecording {
 private handled=new Set<string>();private owners=new Map<string,EventOwner>();
 private emptyTimers=new Map<string,NodeJS.Timeout>();private closed=false;private pending=new Set<Promise<void>>();
 constructor(private settings:SettingsStore,private manager:RecordingManager,private start:(event:RecordingEvent)=>Promise<string>,private stop:(guildID:string)=>Promise<void>,private hasParticipants:(guildID:string,channelID:string)=>boolean|undefined=()=>undefined){}
 private clearEmpty(guildID:string):void{clearTimeout(this.emptyTimers.get(guildID));this.emptyTimers.delete(guildID);}
 /** Undefined occupancy means the gateway/cache cannot currently be trusted. */
 voiceChanged(guildID:string,channelID:string):void{
  const owner=this.owners.get(guildID);if(this.closed||!owner||owner.channelID!==channelID)return;
  if(this.manager.sessions.get(guildID)?.id!==owner.sessionID){this.clearEmpty(guildID);this.owners.delete(guildID);return;}
  if(this.hasParticipants(guildID,channelID)!==false){this.clearEmpty(guildID);return;}
  if(this.emptyTimers.has(guildID))return;
  const timer=setTimeout(()=>{
   if(this.closed||this.owners.get(guildID)!==owner||this.hasParticipants(guildID,channelID)!==false){this.clearEmpty(guildID);return;}
   if(this.manager.sessions.get(guildID)?.id===owner.sessionID)this.manager.cancelReconnect(guildID);
   const task=this.manager.exclusive(guildID,async()=>{
    if(this.closed||this.emptyTimers.get(guildID)!==timer||this.owners.get(guildID)!==owner||this.manager.sessions.get(guildID)?.id!==owner.sessionID||this.hasParticipants(guildID,channelID)!==false)return;
    this.clearEmpty(guildID);this.owners.delete(guildID);
    const session=this.manager.sessions.get(guildID)!;session.stopReason="empty-channel";
    await this.stop(guildID);
   });
   this.pending.add(task);void task.catch(error=>console.error("[Event recording] Empty-channel stop failed:",error)).finally(()=>this.pending.delete(task));
  },EMPTY_EVENT_CHANNEL_GRACE_MS);timer.unref();this.emptyTimers.set(guildID,timer);
 }
 recheck():void{for(const [guildID,owner] of this.owners)this.voiceChanged(guildID,owner.channelID);}
 async close():Promise<void>{this.closed=true;for(const guildID of this.emptyTimers.keys())this.clearEmpty(guildID);await Promise.allSettled(this.pending);}

 async update(event:RecordingEvent):Promise<void>{
  if(this.closed)return;
  const key=event.guildID+':'+event.id;
  if(event.status===2){
   const rule=this.settings.get(event.guildID).eventRecordings?.find(rule=>rule.eventID===event.id);
   if(!rule||event.entityType!==2||!event.channelID||this.handled.has(key))return;
   this.handled.add(key);
   await this.manager.exclusive(event.guildID,async()=>{
    // Never adopt, rename or stop a manually started recording.
    if(!this.settings.get(event.guildID).eventRecordings?.some(rule=>rule.eventID===event.id)||this.manager.sessions.has(event.guildID))return;
    try{const sessionID=await this.start(event);this.owners.set(event.guildID,{eventID:event.id,sessionID,channelID:event.channelID!,stopOnEnd:rule.stopOnEnd});this.voiceChanged(event.guildID,event.channelID!);}
    catch(error){this.handled.delete(key);throw error;}
   });
  }else if(event.status===3||event.status===4){
   this.handled.delete(key);const owner=this.owners.get(event.guildID);
   if(!owner||owner.eventID!==event.id)return;
   if(!owner.stopOnEnd)return;
   this.owners.delete(event.guildID);this.clearEmpty(event.guildID);
   if(this.manager.sessions.get(event.guildID)?.id===owner.sessionID)this.manager.cancelReconnect(event.guildID);
   await this.manager.exclusive(event.guildID,async()=>{if(this.manager.sessions.get(event.guildID)?.id===owner.sessionID)await this.stop(event.guildID);});
  }
 }
}

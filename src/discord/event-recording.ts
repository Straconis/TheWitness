import type { SettingsStore } from "../storage/settings";
import type { RecordingManager } from "../recording/manager";
export interface RecordingEvent {id:string;guildID:string;channelID:string|null;entityType:number;status:number;name:string}
/** Only explicitly selected voice events start recording; manual stops stay stopped. */
export class EventRecording {
 private handled=new Set<string>();private owners=new Map<string,{eventID:string;sessionID:string;stopOnEnd:boolean}>();
 constructor(private settings:SettingsStore,private manager:RecordingManager,private start:(event:RecordingEvent)=>Promise<string>,private stop:(guildID:string)=>Promise<void>){}
 async update(event:RecordingEvent):Promise<void>{
  const key=event.guildID+':'+event.id;
  if(event.status===2){
   const rule=this.settings.get(event.guildID).eventRecordings?.find(rule=>rule.eventID===event.id);
   if(!rule||event.entityType!==2||!event.channelID||this.handled.has(key))return;
   this.handled.add(key);
   await this.manager.exclusive(event.guildID,async()=>{
    // Never adopt, rename or stop a manually started recording.
    if(!this.settings.get(event.guildID).eventRecordings?.some(rule=>rule.eventID===event.id)||this.manager.sessions.has(event.guildID))return;
    try{const sessionID=await this.start(event);this.owners.set(event.guildID,{eventID:event.id,sessionID,stopOnEnd:rule.stopOnEnd});}
    catch(error){this.handled.delete(key);throw error;}
   });
  }else if(event.status===3||event.status===4){
   this.handled.delete(key);const owner=this.owners.get(event.guildID);
   if(!owner||owner.eventID!==event.id)return;
   this.owners.delete(event.guildID);
   if(!owner.stopOnEnd)return;
   if(this.manager.sessions.get(event.guildID)?.id===owner.sessionID)this.manager.cancelReconnect(event.guildID);
   await this.manager.exclusive(event.guildID,async()=>{if(this.manager.sessions.get(event.guildID)?.id===owner.sessionID)await this.stop(event.guildID);});
  }
 }
}

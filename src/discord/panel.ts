import type { RecordingSession } from "../recording/session";
import type { StorageMonitor } from "../storage/space";
interface Transport {createMessage(channel:string,body:any):Promise<{id:string}>;editMessage(channel:string,id:string,body:any):Promise<unknown>}
export function panelBody(session:RecordingSession,lowSpace=false,now=Date.now()):any{
 const duration=Math.max(0,Math.floor((now-Date.parse(session.startedAt))/1000)),minutes=Math.floor(duration/60),seconds=duration%60;
 const active=session.state==="recording",state=active?(session.voiceState==="reconnecting"?"🟠 Reconnecting — saved audio preserved":"🔴 Recording · Connected"):(session.state==="completed"?"✅ Recording saved":"⚠️ Recording stopped with an error — audio preserved for recovery");
 return {content:`**${state}**\n${session.title?session.title+' · ':''}${minutes}m ${String(seconds).padStart(2,'0')}s · ${session.tracks.size} tracks · ${session.notes} notes\n${lowSpace?'⚠️ Low disk space · ':''}Packet drops: ${session.packetStats.duplicatesDropped+session.packetStats.latePacketsDropped}\nSession: \`${session.id}\``,allowedMentions:{parse:[]},components:[{type:1,components:[{type:2,style:2,label:'Status',custom_id:`witness:status:${session.id}`,disabled:!active},{type:2,style:1,label:'Add note',custom_id:`witness:note:${session.id}`,disabled:!active},{type:2,style:4,label:'Stop',custom_id:`witness:stop:${session.id}`,disabled:!active}]}]};
}
/** Uses bot message edits, so long recordings do not depend on expiring interaction tokens. */
export class RecordingPanels {
 private panels=new Map<string,{session:RecordingSession;channel:string;id:string}>();private timer?:NodeJS.Timeout;private updating?:Promise<void>;private starts=new Map<string,Promise<void>>();
 constructor(private transport:Transport,private space:StorageMonitor){}
 ensure(channel:string,session:RecordingSession):Promise<void>{
  if(this.panels.get(session.guildID)?.session.id===session.id)return Promise.resolve();const existing=this.starts.get(session.guildID);if(existing)return existing;
  const task=(async()=>{if(this.panels.has(session.guildID))await this.update();const message=await this.transport.createMessage(channel,panelBody(session,this.space.status?.low));this.panels.set(session.guildID,{session,channel,id:message.id});if(!this.timer){this.timer=setInterval(()=>{void this.update().catch(error=>console.warn('[Panel] Update failed.',error));},10000);this.timer.unref();}})();this.starts.set(session.guildID,task);void task.finally(()=>this.starts.delete(session.guildID)).catch(()=>{});return task;
 }
 update():Promise<void>{
  if(this.updating)return this.updating;
  const task=(async()=>{for(const [guild,panel] of this.panels){try{await this.transport.editMessage(panel.channel,panel.id,panelBody(panel.session,this.space.status?.low));if(panel.session.state!=="recording")this.panels.delete(guild);}catch(error){console.warn('[Panel] Could not edit status message.',error);if([10008,50013].includes((error as {code?:number}).code??0))this.panels.delete(guild);}}
   if(!this.panels.size&&this.timer){clearInterval(this.timer);this.timer=undefined;}})();this.updating=task;void task.finally(()=>this.updating=undefined).catch(()=>{});return task;
 }
 async close():Promise<void>{if(this.timer)clearInterval(this.timer);this.timer=undefined;await Promise.allSettled([...this.starts.values()]);await this.update();if(this.timer)clearInterval(this.timer);this.timer=undefined;}
}

import type { RecordingSession } from "../recording/session";
import type { StorageMonitor } from "../storage/space";
interface Transport {createMessage(channel:string,body:any):Promise<{id:string}>;editMessage(channel:string,id:string,body:any):Promise<unknown>}
export interface PanelContext {serverName?:string;serverIcon?:string}

export function panelBody(session:RecordingSession,lowSpace=false,now=Date.now(),context:PanelContext={}):any{
 const duration=Math.max(0,Math.floor(((session.endedAt?Date.parse(session.endedAt):now)-Date.parse(session.startedAt))/1000)),minutes=Math.floor(duration/60),seconds=duration%60;
 const active=session.state==="recording",state=active?(session.voiceState==="reconnecting"?"🟠 Reconnecting — saved audio preserved":"🔴 Recording · Connected"):(session.state==="completed"?"✅ Recording saved":"⚠️ Recording stopped with an error — audio preserved for recovery");
 const warning=lowSpace||(!active&&session.state!=="completed"),color=warning?0xfaa61a:active?(session.voiceState==="reconnecting"?0xfaa61a:0xed4245):0x57f287;
 const title=session.title?.replace(/[\\`*_~|]/g,"\\$&");
 const started=Math.floor(Date.parse(session.startedAt)/1000);
 const fields=[
  {name:"Duration",value:`${minutes}m ${String(seconds).padStart(2,'0')}s`,inline:true},
  {name:"Speaker tracks",value:String(session.tracks.size),inline:true},
  {name:"Notes",value:String(session.notes),inline:true},
  {name:"Voice channel",value:`<#${session.channelID}>`,inline:true},
  {name:"Started",value:Number.isFinite(started)?`<t:${started}:f>`:"Unknown",inline:true},
  {name:"Packet drops",value:String(session.packetStats.duplicatesDropped+session.packetStats.latePacketsDropped),inline:true},
  {name:"Session",value:`\`${session.id}\``}
 ];
 if(lowSpace)fields.push({name:"⚠️ Low disk space",value:"Recording storage is running low. Ask the host operator to review available space."});
 if(context.serverName)fields.unshift({name:"Server",value:context.serverName.replace(/[\\`*_~|]/g,"\\$&").slice(0,256)});
 if(session.state==="completed")fields.push({name:"Downloads",value:session.tracks.size?"Use Download to open your private recording page and choose export formats there.":"No audio was captured, so there are no speaker tracks to download."});
 const downloadControls=session.state==="completed"?[{type:1,components:[{type:2,style:1,label:"Download",custom_id:`witness:download:${session.id}`,disabled:!session.tracks.size}]}]:[];
 return {content:"",embeds:[{title:state,description:title?`**${title}**`:"Untitled recording",color,fields,...(context.serverIcon?{thumbnail:{url:context.serverIcon}}:{}),footer:{text:"The Witness remembers."}}],allowedMentions:{parse:[]},components:[{type:1,components:[{type:2,style:2,label:'Status',custom_id:`witness:status:${session.id}`,disabled:!active},{type:2,style:1,label:'Add note',custom_id:`witness:note:${session.id}`,disabled:!active},{type:2,style:4,label:'Stop',custom_id:`witness:stop:${session.id}`,disabled:!active}]},...downloadControls]};
}
/** Uses bot message edits, so long recordings do not depend on expiring interaction tokens. */
export class RecordingPanels {
 private panels=new Map<string,{session:RecordingSession;channel:string;id:string}>();private timer?:NodeJS.Timeout;private updating?:Promise<void>;private starts=new Map<string,Promise<void>>();
 constructor(private transport:Transport,private space:StorageMonitor,private context:(session:RecordingSession)=>PanelContext=()=>({})){}
 ensure(channel:string,session:RecordingSession):Promise<void>{
  if(this.panels.get(session.guildID)?.session.id===session.id)return Promise.resolve();const existing=this.starts.get(session.guildID);if(existing)return existing;
  const task=(async()=>{if(this.panels.has(session.guildID))await this.update();const message=await this.transport.createMessage(channel,panelBody(session,this.space.status?.low,Date.now(),this.context(session)));this.panels.set(session.guildID,{session,channel,id:message.id});if(!this.timer){this.timer=setInterval(()=>{void this.update().catch(error=>console.warn('[Panel] Update failed.',error));},10000);this.timer.unref();}})();this.starts.set(session.guildID,task);void task.finally(()=>this.starts.delete(session.guildID)).catch(()=>{});return task;
 }
 update():Promise<void>{
  if(this.updating)return this.updating;
  const task=(async()=>{for(const [guild,panel] of this.panels){try{await this.transport.editMessage(panel.channel,panel.id,panelBody(panel.session,this.space.status?.low,Date.now(),this.context(panel.session)));if(panel.session.state!=="recording")this.panels.delete(guild);}catch(error){console.warn('[Panel] Could not edit status message.',error);if([10008,50013].includes((error as {code?:number}).code??0))this.panels.delete(guild);}}
   if(!this.panels.size&&this.timer){clearInterval(this.timer);this.timer=undefined;}})();this.updating=task;void task.finally(()=>this.updating=undefined).catch(()=>{});return task;
 }
 async close():Promise<void>{if(this.timer)clearInterval(this.timer);this.timer=undefined;await Promise.allSettled([...this.starts.values()]);await this.update();if(this.timer)clearInterval(this.timer);this.timer=undefined;}
}

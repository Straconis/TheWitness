import { listAllSessions } from "../storage/sessions";
import { deleteSession } from "../storage/delete";
import { deletionTime } from "../storage/retention-policy";
import type { SettingsStore } from "../storage/settings";
import type { RecordingManager } from "../recording/manager";
import type { ExportQueue } from "../exports/jobs";
/** Deletes recordings past their retention time, including those of servers the bot has left. Active, busy and owner-recovery sessions are preserved. */
export class RetentionRunner {
 private pending:Promise<void>=Promise.resolve();private timer?:NodeJS.Timeout;
 constructor(private root:string,private settings:SettingsStore,private manager:RecordingManager,private queue:ExportQueue){}
 sweep(now=Date.now()):Promise<void>{const task=this.pending.catch(()=>{}).then(async()=>{
  for(const session of await listAllSessions(this.root)){
   const guildID=session.guildID;if(guildID==="owner-recovery")continue;
   const due=()=>{const at=deletionTime(session,this.settings.get(guildID).retentionDays,this.settings.retentionPolicy.get());return at!==undefined&&at<now&&!this.queue.busy(session.id)&&this.manager.sessions.get(guildID)?.id!==session.id;};
   if(!due())continue;
   await this.queue.whileIdle(session.id,()=>this.manager.exclusive(guildID,async()=>{if(!due())return;await deleteSession(this.root,session.id,guildID);console.log(`[Retention] Deleted recording ${session.id}.`);})).catch(error=>console.warn(`[Retention] Could not delete ${session.id}.`,error));
  }
 });this.pending=task;return task;}
 start(){this.timer=setInterval(()=>void this.sweep().catch(error=>console.warn("[Retention]",error)),3600000);this.timer.unref();void this.sweep().catch(error=>console.warn("[Retention]",error));}
 async close(){if(this.timer)clearInterval(this.timer);await this.pending;}
}

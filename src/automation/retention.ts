import { readFile } from "node:fs/promises";
import path from "node:path";
import { listSessions } from "../storage/sessions";
import { deleteSession } from "../storage/delete";
import type { SettingsStore } from "../storage/settings";
import type { RecordingManager } from "../recording/manager";
import type { ExportQueue } from "../exports/jobs";
/** Opt-in retention uses completion time; active, failed and interrupted recordings are preserved. */
export class RetentionRunner {
 private pending:Promise<void>=Promise.resolve();private timer?:NodeJS.Timeout;
 constructor(private root:string,private settings:SettingsStore,private manager:RecordingManager,private queue:ExportQueue){}
 sweep(now=Date.now()):Promise<void>{const task=this.pending.catch(()=>{}).then(async()=>{
  for(const [guildID,settings] of this.settings.all()){
   if(!settings.retentionDays)continue;const cutoff=now-settings.retentionDays*86400000;
   for(const session of await listSessions(this.root,guildID)){
    if(session.state!=="completed"||this.queue.busy(session.id)||this.manager.sessions.get(guildID)?.id===session.id)continue;
    const metadata=JSON.parse(await readFile(path.join(this.root,session.id,"session.json"),"utf8")),ended=Date.parse(metadata.endedAt);
    if(!Number.isFinite(ended)||ended>=cutoff)continue;
    await this.queue.whileIdle(session.id,()=>this.manager.exclusive(guildID,async()=>{const days=this.settings.get(guildID).retentionDays;if(!days||ended>=now-days*86400000||this.queue.busy(session.id)||this.manager.sessions.get(guildID)?.id===session.id)return;await deleteSession(this.root,session.id,guildID);console.log(`[Retention] Deleted completed recording ${session.id}.`);}));
   }
  }
 });this.pending=task;return task;}
 start(){this.timer=setInterval(()=>void this.sweep().catch(error=>console.warn("[Retention]",error)),3600000);this.timer.unref();void this.sweep().catch(error=>console.warn("[Retention]",error));}
 async close(){if(this.timer)clearInterval(this.timer);await this.pending;}
}

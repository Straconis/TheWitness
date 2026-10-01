import { validateSchedule,RecordingSchedule } from "../automation/schedules";
import { validateAccess } from "../discord/access";
import { readFile, writeFile, rename } from "node:fs/promises";
export interface GuildSettings { schedules?:RecordingSchedule[]; autoJoinChannels?:string[]; retentionDays?:number; autoJoin: boolean; autoRecord: boolean; downloadNaming?: "date" | "original"; restrictAccess?:boolean; accessRoleID?:string; eventRecordings?:Array<{eventID:string;stopOnEnd:boolean}> }
function validateEvents(settings:GuildSettings):void{
 if(settings.retentionDays!==undefined&&(!Number.isInteger(settings.retentionDays)||settings.retentionDays<0||settings.retentionDays>3650))throw Error("Retention must be 0 (off) or 1–3650 days.");
 if(settings.autoJoinChannels!==undefined&&(!Array.isArray(settings.autoJoinChannels)||settings.autoJoinChannels.length>100||settings.autoJoinChannels.some(id=>!/^\d{1,25}$/.test(id))))throw Error("Invalid autojoin channel list.");
 if(settings.schedules!==undefined){if(!Array.isArray(settings.schedules)||settings.schedules.length>100||new Set(settings.schedules.map(rule=>rule.id)).size!==settings.schedules.length)throw Error("Invalid schedule list.");for(const rule of settings.schedules)validateSchedule(rule);}

 if(settings.eventRecordings===undefined)return;
 if(!Array.isArray(settings.eventRecordings)||settings.eventRecordings.length>100||settings.eventRecordings.some(rule=>!rule||!/^\d{1,25}$/.test(rule.eventID)||typeof rule.stopOnEnd!=="boolean")||new Set(settings.eventRecordings.map(rule=>rule.eventID)).size!==settings.eventRecordings.length)throw new Error("Invalid event recording rules.");
}
export class SettingsStore {
  private values: Record<string, GuildSettings> = {};
  private queue: Promise<void> = Promise.resolve();
  constructor(private file: string) {}
  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.file,"utf8"));
      for (const [id, value] of Object.entries(data)) {
        const settings = value as GuildSettings;
        if (typeof settings.autoJoin !== "boolean" || typeof settings.autoRecord !== "boolean") throw new Error("Invalid saved automation settings.");
        validateAccess(settings);validateEvents(settings);
        if(settings.downloadNaming!==undefined&&!["date","original"].includes(settings.downloadNaming))throw new Error("Invalid download naming setting.");
      }
      this.values = data;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  all():Array<[string,GuildSettings]>{return Object.keys(this.values).map(id=>[id,this.get(id)]);}
  get(id:string):GuildSettings{return structuredClone(this.values[id]??{autoJoin:false,autoRecord:false});}
  update(id: string, change: Partial<GuildSettings>): Promise<void> {
    const task = this.queue.then(async () => {
      if(change.downloadNaming!==undefined&&!["date","original"].includes(change.downloadNaming))throw new Error("Invalid download naming setting.");
      const next = { ...this.values, [id]: { ...this.get(id), ...structuredClone(change) } };
      validateAccess(next[id]);validateEvents(next[id]);
      await writeFile(this.file + ".tmp", JSON.stringify(next,null,2));
      await rename(this.file + ".tmp",this.file);
      this.values = next;
    });
    this.queue = task.catch(() => {});
    return task;
  }
}

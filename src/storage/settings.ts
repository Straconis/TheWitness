import { validateAccess } from "../discord/access";
import { readFile, writeFile, rename } from "node:fs/promises";
export interface GuildSettings { autoJoin: boolean; autoRecord: boolean; downloadNaming?: "date" | "original"; restrictAccess?:boolean; accessRoleID?:string }
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
        validateAccess(settings);
        if(settings.downloadNaming!==undefined&&!["date","original"].includes(settings.downloadNaming))throw new Error("Invalid download naming setting.");
      }
      this.values = data;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  get(id: string): GuildSettings { return { ...(this.values[id] ?? { autoJoin: false, autoRecord: false }) }; }
  update(id: string, change: Partial<GuildSettings>): Promise<void> {
    const task = this.queue.then(async () => {
      if(change.downloadNaming!==undefined&&!["date","original"].includes(change.downloadNaming))throw new Error("Invalid download naming setting.");
      const next = { ...this.values, [id]: { ...this.get(id), ...change } };
      validateAccess(next[id]);
      await writeFile(this.file + ".tmp", JSON.stringify(next,null,2));
      await rename(this.file + ".tmp",this.file);
      this.values = next;
    });
    this.queue = task.catch(() => {});
    return task;
  }
}

import {writeFile} from "node:fs/promises";
import path from "node:path";
import {UserError} from "../errors";
import {writeSoundcraft} from "./soundcraft";
import {writeAudition} from "./audition";
import {writeAudacity} from "./audacity";

/** Per-server admin choice for fallback projects packaged with Soundcraft exports while Soundcraft support is tested. */
export type SoundcraftBackupMode="audition"|"audacity"|"both"|"ask"|"none";
export type BackupProject="audition"|"audacity";
export const SOUNDCRAFT_BACKUP_MODES:readonly SoundcraftBackupMode[]=["audition","audacity","both","ask","none"];
export const DEFAULT_SOUNDCRAFT_BACKUP:SoundcraftBackupMode="ask";
// Native Audacity backups embed audio; the other project formats reference the root media.
export const AUDACITY_BACKUP_PROJECT="backup-audacity.aup3",AUDACITY_BACKUP_MEDIA="backup-audacity_data",AUDITION_BACKUP_PROJECT="backup-audition.sesx",BACKUP_README="BACKUP-PROJECTS.txt";
const order:BackupProject[]=["audition","audacity"];
const STALE_PAGE_HINT=" If a download page was open before a server manager changed this setting, reload it.";
/** Prefix of the Ask-without-choice error; Discord and the CLI add how to choose there. */
export const ASK_CHOICE_REQUIRED="Choose whether this Soundcraft export includes backup projects";
const labels:Record<BackupProject,string>={audition:"Adobe Audition",audacity:"Audacity"};
export const backupLabel=(projects:BackupProject[])=>projects.length?projects.map(project=>labels[project]).join(" and "):"no backup project";

export function validateBackupMode(mode:unknown):asserts mode is SoundcraftBackupMode{
 if(!SOUNDCRAFT_BACKUP_MODES.includes(mode as SoundcraftBackupMode))throw new UserError("Choose Adobe Audition, Audacity, Both, Ask or None for Soundcraft backup projects.");
}
export function backupMode(settings:{soundcraftBackup?:SoundcraftBackupMode}):SoundcraftBackupMode{return settings.soundcraftBackup??DEFAULT_SOUNDCRAFT_BACKUP;}
/** Projects a mode always includes; Ask has none until the person preparing the export chooses (every Soundcraft path must send a choice). */
export function forcedBackups(mode:SoundcraftBackupMode):BackupProject[]|undefined{
 return mode==="both"?[...order]:mode==="audition"||mode==="audacity"?[mode]:mode==="none"?[]:undefined;
}
function parseBackups(value:unknown):BackupProject[]{
 if(!Array.isArray(value)||value.length>2||value.some(item=>!order.includes(item))||new Set(value).size!==value.length)throw new UserError("Choose Adobe Audition, Audacity, both, or neither as Soundcraft backup projects.");
 return order.filter(project=>value.includes(project));
}
/**
 * Resolves a request against the server's admin setting. Fixed modes ignore nothing silently:
 * a direct request that disagrees with the setting is rejected, so stale pages and forged requests fail clearly.
 */
export function resolveBackupProjects(mode:SoundcraftBackupMode,format:string,requested:unknown):BackupProject[]|undefined{
 validateBackupMode(mode);
 const choice=requested===undefined?undefined:parseBackups(requested);
 if(format!=="soundcraft"){if(choice?.length)throw new UserError("Backup projects are only available with Soundcraft exports.");return undefined;}
 const forced=forcedBackups(mode);
 if(!forced){if(!choice)throw new UserError(ASK_CHOICE_REQUIRED+" for Soundcraft testing: Adobe Audition, Audacity, both, or neither.");return choice;}
 if(choice&&choice.join()!==forced.join())throw new UserError((forced.length?`This Discord server's admin setting includes ${backupLabel(forced)} with Soundcraft exports; leave out the backup choice or match it.`:"Backup projects are turned off for this Discord server; leave out the backup choice.")+STALE_PAGE_HINT);
 return forced;
}
/** Validates a resolved selection restored from a saved job. */
export function validateSavedBackups(value:unknown,format:string):BackupProject[]|undefined{
 if(value===undefined)return undefined;
 if(format!=="soundcraft")throw new Error("Backup projects are only valid for Soundcraft jobs.");
 return parseBackups(value);
}

/** Writes session.scraft plus any selected backup projects; Audacity embeds audio, while Soundcraft and Audition reference shared media. */
export async function writeSoundcraftProject(directory:string,tracks:Array<{file:string;username:string}>,notes:Array<{seconds:number;text:string}>,title:string|undefined,backups:BackupProject[]=[],options:Parameters<typeof writeAudacity>[3]={}):Promise<void>{
 const projects=validateSavedBackups(backups,"soundcraft")!;
 if(projects.includes("audacity"))await writeAudacity(directory,tracks,notes,{...options,project:"backup-audacity"});
 await writeSoundcraft(directory,tracks,notes,title);
 if(projects.includes("audition"))await writeAudition(directory,tracks,notes,title,{filename:AUDITION_BACKUP_PROJECT});
 if(!projects.length)return;
 const lines=["The Witness: optional backup projects for Soundcraft testing","",
  "Open session.scraft in Soundcraft first. These backup projects are included only as a fallback while Soundcraft support is being tested.",""];
 if(projects.includes("audition"))lines.push(`- ${AUDITION_BACKUP_PROJECT}: Adobe Audition backup project.`);
 if(projects.includes("audacity"))lines.push(`- ${AUDACITY_BACKUP_PROJECT}: Native Audacity project with embedded audio; open it directly.`);
 lines.push("","Audacity projects contain their own audio. Soundcraft and Audition share the separate speaker files. Extract the whole ZIP and keep its folder layout.");
 await writeFile(path.join(directory,BACKUP_README),lines.join("\r\n")+"\r\n");
}

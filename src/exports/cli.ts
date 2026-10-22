import "dotenv/config";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { exportSession, ExportFormat } from "./export";
import { SettingsStore } from "../storage/settings";
import { sessionIDPattern } from "../storage/sessions";
import { backupMode,resolveBackupProjects } from "./soundcraft-backup";
const usage="Usage: npm run export -- <session UUID> [ogg|wav|flac|mp3|aac|audition|audacity|soundcraft] [--mix] [--backup=audition|audacity|both|none]\n"+
 "--backup chooses Soundcraft backup projects for Soundcraft testing. It is required for Soundcraft when the recording's Discord server has backups set to Ask in /dashboard, and must match a fixed setting.";
const choices:Record<string,string[]>={audition:["audition"],audacity:["audacity"],both:["audition","audacity"],none:[]};
/** Same recordings folder as the bot (RECORDING_PATH, default ./recordings); its settings.json holds each server's backup mode. */
async function main():Promise<void>{
 const positional:string[]=[];let mix=false,backup:string|undefined;
 for(const arg of process.argv.slice(2)){
  if(arg==="--mix")mix=true;
  else if(arg.startsWith("--backup=")){backup=arg.slice(9);if(!(backup in choices))throw Error(`Unknown --backup choice "${backup}". Use audition, audacity, both or none.`);}
  else if(arg.startsWith("--"))throw Error(`Unknown option ${arg}.`);
  else positional.push(arg);
 }
 const [sessionID,format="ogg"]=positional;
 if(!sessionID||positional.length>2)throw Error("Missing or extra arguments.");
 if(!sessionIDPattern.test(sessionID))throw Error("Invalid session ID.");
 const root=path.resolve(process.cwd(),process.env.RECORDING_PATH?.trim()||"recordings");
 const {guildID}=JSON.parse(await readFile(path.join(root,sessionID,"session.json"),"utf8"));
 if(typeof guildID!=="string")throw Error("This recording has no Discord server ID.");
 const settings=new SettingsStore(path.join(root,"settings.json"));await settings.load();
 const mode=backupMode(settings.get(guildID));
 if(format==="soundcraft"&&mode==="ask"&&backup===undefined)throw Error("This recording's Discord server has Soundcraft backup projects set to Ask. Add --backup=audition, --backup=audacity, --backup=both or --backup=none.");
 const backupProjects=resolveBackupProjects(mode,format,backup===undefined?undefined:choices[backup]);
 const directory=await exportSession(root,sessionID,{format:format as ExportFormat,mix,backupProjects});
 console.log(`Export saved: ${directory}`);
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));if(/arguments|Unknown option/.test(String(error?.message)))console.error(usage);process.exitCode=1;});

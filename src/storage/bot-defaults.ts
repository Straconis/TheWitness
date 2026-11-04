import {readFile,rename,writeFile} from "node:fs/promises";
import path from "node:path";
import {UserError} from "../errors";
import {DEFAULT_RECORDING_DURATION_HOURS,RECORDING_DURATION_HOURS,validateRecordingDuration} from "../recording/duration";
export interface BotDefaults {silenceSeconds:number;recordingDefaultHours:number;recordingMaxHours:number}
const FALLBACK:BotDefaults={silenceSeconds:10,recordingDefaultHours:DEFAULT_RECORDING_DURATION_HOURS,recordingMaxHours:RECORDING_DURATION_HOURS[RECORDING_DURATION_HOURS.length-1]};
let current:BotDefaults=FALLBACK;
export function botDefaults():BotDefaults{return current;}
export function validateSilenceSeconds(value:unknown):number{if(typeof value!=="number"||!Number.isFinite(value)||value<0.1||value>3600)throw new UserError("Silence length must be between 0.1 and 3600 seconds.");return value;}
/** A server's own /recordinglimit wins over the bot default, but never over the bot maximum. */
export function recordingHours(serverHours?:number):number{return Math.min(serverHours??current.recordingDefaultHours,current.recordingMaxHours);}
function validate(value:Partial<BotDefaults>):BotDefaults{
 const next={silenceSeconds:validateSilenceSeconds(value.silenceSeconds),recordingDefaultHours:validateRecordingDuration(value.recordingDefaultHours),recordingMaxHours:validateRecordingDuration(value.recordingMaxHours)};
 if(next.recordingDefaultHours>next.recordingMaxHours)throw new UserError("The default recording length cannot be longer than the maximum.");
 return next;
}
/** Bot-wide starting values set on /admin, kept across restarts. Fields never saved keep the built-in value, so a new default needs no migration. */
export class BotDefaultsStore {
 private pending:Promise<void>=Promise.resolve();private file:string;
 constructor(root:string){this.file=path.join(root,"bot-defaults.json");}
 async load():Promise<void>{try{current=validate({...FALLBACK,...JSON.parse(await readFile(this.file,"utf8"))});}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;current=FALLBACK;}}
 save(change:Partial<BotDefaults>):Promise<BotDefaults>{
  const task=this.pending.catch(()=>{}).then(async()=>{const next=validate({...current,...change});await writeFile(this.file+".tmp",JSON.stringify(next,null,2));await rename(this.file+".tmp",this.file);current=next;return next;});
  this.pending=task.then(()=>{},()=>{});return task;
 }
}

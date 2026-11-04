import {UserError} from "../errors";
import {lstat,readdir,readFile,rename,writeFile} from "node:fs/promises";
import path from "node:path";
import {listSessions} from "./sessions";
export const SUGGESTED_RETENTION_DAYS=31,SUGGESTED_STORAGE_CAP_GIB=10;
const DAY_MS=86400000,GIB=1024**3;
/** Zero turns a limit off. appliedAt is when the current day limit last started counting, so a new or shorter limit never deletes without a full period's notice. */
export interface RetentionLimits {days:number;storageCapGiB:number;appliedAt?:string}
function validate(value:unknown):RetentionLimits{
 const limits=value as RetentionLimits;
 if(!limits||typeof limits!=="object"||!Number.isInteger(limits.days)||limits.days<0||limits.days>3650)throw new UserError("Retention must be 0 (off) or 1–3650 days.");
 if(!Number.isInteger(limits.storageCapGiB)||limits.storageCapGiB<0||limits.storageCapGiB>100000)throw new UserError("The storage cap must be 0 (off) or a whole number of GB up to 100000.");
 if(limits.appliedAt!==undefined&&!Number.isFinite(Date.parse(limits.appliedAt)))throw new UserError("Invalid retention start date.");
 if(limits.days&&limits.appliedAt===undefined)throw new UserError("Invalid retention start date.");
 return {days:limits.days,storageCapGiB:limits.storageCapGiB,...(limits.appliedAt?{appliedAt:limits.appliedAt}:{})};
}
/** Bot-wide limits set on /admin. Off until the owner saves them, so self-hosted recordings are never deleted by surprise. */
export class RetentionPolicy {
 private limits:RetentionLimits={days:0,storageCapGiB:0};private saved=false;private pending:Promise<void>=Promise.resolve();private file:string;
 constructor(root:string){this.file=path.join(root,"retention-policy.json");}
 async load(){try{this.limits=validate(JSON.parse(await readFile(this.file,"utf8")));this.saved=true;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
 get():RetentionLimits{return {...this.limits};}
 configured():boolean{return this.saved;}
 save(change:{days:number;storageCapGiB:number},now=Date.now()):Promise<RetentionLimits>{
  const task=this.pending.catch(()=>{}).then(async()=>{
   const previous=this.limits,restart=change?.days>0&&(!previous.days||change.days<previous.days),appliedAt=change?.days>0?(restart?new Date(now).toISOString():previous.appliedAt):undefined,next=validate({days:change?.days,storageCapGiB:change?.storageCapGiB,...(appliedAt?{appliedAt}:{})});
   await writeFile(this.file+".tmp",JSON.stringify(next,null,2));await rename(this.file+".tmp",this.file);this.limits=next;this.saved=true;return {...next};
  });this.pending=task.then(()=>{},()=>{});return task;
 }
}
/** When a recording becomes due for deletion, or undefined if it is kept. A server's own shorter setting covers completed recordings only; the bot-wide limit covers failed and interrupted ones too. */
export function deletionTime(session:{state:string;startedAt:string;endedAt?:string},serverDays:number|undefined,limits:RetentionLimits):number|undefined{
 if(session.state==="recording")return undefined;
 const ended=Date.parse(session.endedAt??""),finished=Number.isFinite(ended);
 if(session.state==="completed"&&serverDays&&(!limits.days||serverDays<limits.days))return finished?ended+serverDays*DAY_MS:undefined;
 if(!limits.days)return undefined;
 const base=finished?ended:Date.parse(session.startedAt);
 return Number.isFinite(base)?Math.max(base,Date.parse(limits.appliedAt!))+limits.days*DAY_MS:undefined;
}
async function directoryBytes(directory:string):Promise<number>{
 let total=0;
 for(const entry of await readdir(directory,{withFileTypes:true}).catch(()=>[])){const target=path.join(directory,entry.name);if(entry.isDirectory())total+=await directoryBytes(target);else if(entry.isFile())total+=await lstat(target).then(info=>info.size,()=>0);}
 return total;
}
export async function guildStorageBytes(root:string,guildID:string):Promise<number>{
 let total=0;for(const session of await listSessions(root,guildID))total+=await directoryBytes(path.join(root,session.id));return total;
}
export async function assertStorageCap(root:string,guildID:string,limits:RetentionLimits):Promise<void>{
 if(!limits.storageCapGiB)return;const used=await guildStorageBytes(root,guildID);
 if(used>=limits.storageCapGiB*GIB)throw new UserError(`This server has used ${(used/GIB).toFixed(1)} GB of its ${limits.storageCapGiB} GB recording storage. Remove recordings with /delete, or wait for older ones to expire, then start again.`);
}

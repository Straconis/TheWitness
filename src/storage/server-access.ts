import {readFile,writeFile,rename} from "node:fs/promises";
import {UserError} from "../errors";
export const SERVER_BLOCKED_MESSAGE="The bot owner has restricted access for this Discord server.";
export class ServerAccessStore {
 private blocked=new Set<string>();private pending:Promise<void>=Promise.resolve();
 constructor(private file:string){}
 async load():Promise<void>{try{const data=JSON.parse(await readFile(this.file,"utf8"));if(!Array.isArray(data)||data.some(id=>typeof id!=="string"||!/^\d{1,25}$/.test(id)))throw Error("Invalid owner server access settings.");this.blocked=new Set(data);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
 allowed(id:string):boolean{return !this.blocked.has(id);}
 assertAllowed(id:string):void{if(!this.allowed(id))throw new UserError(SERVER_BLOCKED_MESSAGE);}
 setAllowed(id:unknown,allowed:unknown):Promise<void>{if(typeof id!=="string"||!/^\d{1,25}$/.test(id)||typeof allowed!=="boolean")throw new UserError("Choose a Discord server and an access setting.");const task=this.pending.then(async()=>{const next=new Set(this.blocked);if(allowed)next.delete(id);else next.add(id);await writeFile(this.file+".tmp",JSON.stringify([...next].sort()),{mode:0o600});await rename(this.file+".tmp",this.file);this.blocked=next;});this.pending=task.catch(()=>{});return task;}
}
export interface AdminServer {id:string;name:string;memberCount:number|null;unavailable:boolean}

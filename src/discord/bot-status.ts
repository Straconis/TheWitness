import {readFile,writeFile,rename} from "node:fs/promises";
export interface BotStatus {enabled:boolean;type:0|2|3|4|5;text:string}
export function validateBotStatus(value:unknown):BotStatus {
 const data=value as BotStatus;
 if(!data||typeof data.enabled!=="boolean"||![0,2,3,4,5].includes(data.type)||typeof data.text!=="string"||data.text.length>128||/[\x00-\x1f\x7f-\x9f]/.test(data.text))throw Error("Choose a status type and a message up to 128 characters, without control characters.");
 const text=data.text.trim();if(data.enabled&&!text)throw Error("Enter a status message before enabling it.");
 return {enabled:data.enabled,type:data.type,text};
}
export function statusActivities(status:BotStatus):Array<{name:string;type:BotStatus["type"];state?:string}>{return status.enabled?[status.type===4?{name:"Custom Status",type:4,state:status.text}:{name:status.text,type:status.type}]:[];}
export function isApplicationOwner(application:{owner?:{id:string};team?:{owner_user_id:string}|null},userID:string):boolean{return !!userID&&(application.team?application.team.owner_user_id===userID:application.owner?.id===userID);}
export class BotStatusStore {
 private value:BotStatus={enabled:false,type:4,text:""};private pending:Promise<void>=Promise.resolve();
 constructor(private file:string){}
 async load():Promise<void>{try{this.value=validateBotStatus(JSON.parse(await readFile(this.file,"utf8")));}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
 get():BotStatus{return {...this.value};}
 update(value:unknown):Promise<void>{const next=validateBotStatus(value);const task=this.pending.then(async()=>{await writeFile(this.file+".tmp",JSON.stringify(next,null,2),{mode:0o600});await rename(this.file+".tmp",this.file);this.value=next;});this.pending=task.catch(()=>{});return task;}
}

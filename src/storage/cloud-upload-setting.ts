import {readFile,writeFile,rename} from "node:fs/promises";
let allowed=true;
export function cloudUploadAllowed():boolean{return allowed;}
/** Bot-wide owner switch for cloud uploads, kept across restarts. On unless the owner turned it off. */
export class CloudUploadSetting {
 private pending:Promise<void>=Promise.resolve();
 constructor(private file:string){}
 async load():Promise<void>{try{const data=JSON.parse(await readFile(this.file,"utf8"));if(typeof data?.enabled!=="boolean")throw Error("Invalid cloud upload setting.");allowed=data.enabled;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;allowed=true;}}
 update(enabled:unknown):Promise<void>{if(typeof enabled!=="boolean")return Promise.reject(Error("Choose whether cloud uploads are on or off."));const task=this.pending.then(async()=>{await writeFile(this.file+".tmp",JSON.stringify({enabled},null,2),{mode:0o600});await rename(this.file+".tmp",this.file);allowed=enabled;});this.pending=task.catch(()=>{});return task;}
}

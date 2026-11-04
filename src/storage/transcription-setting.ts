import {readFile,writeFile,rename} from "node:fs/promises";
import {setTranscriptionAllowed} from "../integrations/transcription-config";
/** Bot-wide owner switch for transcripts, kept across restarts. On unless the owner turned it off. */
export class TranscriptionSetting {
 private pending:Promise<void>=Promise.resolve();
 constructor(private file:string){}
 async load():Promise<void>{try{const data=JSON.parse(await readFile(this.file,"utf8"));if(typeof data?.enabled!=="boolean")throw Error("Invalid transcription setting.");setTranscriptionAllowed(data.enabled);}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;setTranscriptionAllowed(true);}}
 update(enabled:unknown):Promise<void>{if(typeof enabled!=="boolean")return Promise.reject(Error("Choose whether transcripts are on or off."));const task=this.pending.then(async()=>{await writeFile(this.file+".tmp",JSON.stringify({enabled},null,2),{mode:0o600});await rename(this.file+".tmp",this.file);setTranscriptionAllowed(enabled);});this.pending=task.catch(()=>{});return task;}
}

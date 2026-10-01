import { readFile,writeFile,rename } from "node:fs/promises";
import path from "node:path";
import { getSession } from "./sessions";
export function validateTitle(value:unknown):string{
 if(typeof value!=="string")throw new Error("Choose a recording title.");
 const title=value.trim();if(!title||title.length>120||/[\u0000-\u001f\u007f]/.test(title))throw new Error("Titles must contain 1–120 characters and no control characters.");return title;
}
/** Caller holds the guild recording lock; active sessions use their writer instead. */
export async function renameSession(root:string,id:string,guildID:string,value:unknown):Promise<void>{
 const title=validateTitle(value);await getSession(root,id,guildID);const filename=path.join(root,id,"session.json"),metadata=JSON.parse(await readFile(filename,"utf8"));
 if(metadata.state==="recording")throw new Error("Rename active recordings through their session writer.");
 metadata.title=title;await writeFile(filename+".tmp",JSON.stringify(metadata,null,2));await rename(filename+".tmp",filename);
}

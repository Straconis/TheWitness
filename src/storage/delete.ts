import {UserError} from "../errors";
import { rename,rm } from "node:fs/promises";
import path from "node:path";
import { getSession } from "./sessions";
/** Explicitly requested deletion is scoped to the server and never touches active files. */
export async function deleteSession(root:string,id:string,guildID:string):Promise<void>{
 const metadata=await getSession(root,id,guildID);
 if(metadata.state==="recording")throw new UserError("Stop the recording before deleting it.");
 const source=path.join(root,id),trash=path.join(root,".deleted-"+id);
 await rename(source,trash);await rm(trash,{recursive:true,force:true});
}

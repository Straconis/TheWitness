import { stat } from "node:fs/promises";
import path from "node:path";
/** A deployment blocks new work while existing recordings and exports drain. */
export async function assertDeploymentIdle(root:string):Promise<void>{
 let pending;
 try{pending=await stat(path.join(root,".deploy-pending"));}
 catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}
 // A crashed deployment must not permanently block recording.
 if(Date.now()-pending.mtimeMs<40*60*1000)throw new Error("An update is being prepared. Please try again shortly.");
}

import {readFile,rm,stat} from "node:fs/promises";
import path from "node:path";
import {downloadName} from "../downloads/names";
import {CloudAccounts} from "../integrations/accounts";
import {googleFolderID,uploadFile,type CloudProvider} from "../integrations/cloud";
import {writeProjectZip} from "./project-zip";
const CLOUD_FOLDER="The Witness";
/** Uploads one ZIP named like a download, using only this server's own connected account. Returns the uploaded name. */
export async function deliverToCloud(root:string,directory:string,guildID:string,provider:CloudProvider,signal:AbortSignal):Promise<string>{
 const zip=path.join(directory,"project.zip"),packaged=await stat(zip).then(()=>true,()=>false);
 if(!packaged)await writeProjectZip(directory,signal);
 try{
  const manifest=JSON.parse(await readFile(path.join(directory,"manifest.json"),"utf8")),name=downloadName("project.zip",manifest,"date-channel");
  const token=await new CloudAccounts(root,{},{guildID}).token(provider,signal);
  // Dropbox and OneDrive apps already write inside their own app folder.
  const folder=provider==="google"?await googleFolderID(CLOUD_FOLDER,{token,signal}):undefined;
  await uploadFile(provider,zip,{token,folder,name,signal});
  return name;
 }finally{if(!packaged)await rm(zip,{force:true});}
}

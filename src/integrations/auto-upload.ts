import {CloudAccounts} from "./accounts";
import type {CloudProvider} from "./cloud";
import {savedExportFailure} from "../exports/failure";
import type {ExportJob,ExportQueue} from "../exports/jobs";
import {cloudUploadAllowed} from "../storage/cloud-upload-setting";
import type {SettingsStore} from "../storage/settings";
export const HOSTED_CLOUD_PROVIDERS:CloudProvider[]=["google","dropbox"];
export const CLOUD_LABELS:Record<CloudProvider,string>={google:"Google Drive",dropbox:"Dropbox",onedrive:"OneDrive",box:"Box"};
export const MIN_AUTO_UPLOAD_SECONDS=60;
export function uploadServerAllowed(guildID:string):boolean{const allowed=(process.env.CLOUD_UPLOAD_GUILD_IDS??"").split(",").map(id=>id.trim()).filter(Boolean);return !allowed.length||allowed.includes(guildID);}
interface FinishedRecording {id:string;guildID:string;channelID:string;startedAt:string;packets:number;stopReason?:string}
/** Sends each finished recording to its own server's connected account, and always says when one is skipped. */
export class AutoUploader {
 constructor(private root:string,private settings:SettingsStore,private queue:ExportQueue,private say:(channelID:string,message:string)=>Promise<unknown>,private now:()=>number=Date.now){queue.setUploadNotifier(job=>this.jobFinished(job));}
 private accounts(guildID:string):CloudAccounts{return new CloudAccounts(this.root,{},{guildID});}
 /** Why this finished recording will not upload, or undefined when it should. */
 private skipReason(recording:FinishedRecording,error?:Error):string|undefined{
  if(error)return "the recording ended with an error. Try /recover if audio is missing";
  if(recording.stopReason==="low-disk")return "the bot was low on disk space when it stopped. The recording is saved, so you can /export it later";
  if(!cloudUploadAllowed())return "cloud uploads are paused on this bot right now. The recording is saved, so you can /export it later";
  if(!uploadServerAllowed(recording.guildID))return "cloud uploads aren't enabled for this server yet";
  if(!recording.packets)return "no audio was captured";
  if((this.now()-Date.parse(recording.startedAt))/1000<MIN_AUTO_UPLOAD_SECONDS)return `it was shorter than ${MIN_AUTO_UPLOAD_SECONDS} seconds. You can still /export it`;
 }
 async recordingFinished(recording:FinishedRecording,error?:Error):Promise<void>{
  const choice=this.settings.get(recording.guildID).cloudUpload;if(!choice?.auto||!choice.provider)return;
  const label=CLOUD_LABELS[choice.provider];let reason=this.skipReason(recording,error);
  if(!reason&&!await this.accounts(recording.guildID).configured(choice.provider).catch(()=>false))reason=`${label} isn't connected any more. Reconnect it with /cloud action:connect`;
  if(!reason)try{await this.queue.enqueue(recording.id,recording.guildID,"flac",false,{upload:choice.provider,automatic:true,notifyChannelID:recording.channelID});return;}catch(failure){reason=failure instanceof Error?failure.message:"the upload could not be queued";}
  await this.say(recording.channelID,`This recording was not uploaded to ${label}: ${reason}.`);
 }
 private async jobFinished(job:ExportJob):Promise<void>{
  if(!job.automatic||!job.notifyChannelID||!job.upload)return;const label=CLOUD_LABELS[job.upload];
  if(job.state==="completed")await this.say(job.notifyChannelID,`Recording uploaded to ${label}: ${job.uploadedAs??"your connected account"}.`);
  else if(job.state==="cancelled")await this.say(job.notifyChannelID,`The upload to ${label} was cancelled. The recording is still saved.`);
  else if(job.state==="failed")await this.say(job.notifyChannelID,`The upload to ${label} failed: ${savedExportFailure(job)} The recording is still saved. Try again with /exportjob action:retry job:${job.id}`);
 }
 /** Starts a sign-in for this server. The link is only ever shown privately to the person who asked. */
 connectLink(guildID:string,provider:CloudProvider,origin:string,channelID:string,userID:string):Promise<string>{return this.accounts(guildID).connect(provider,origin,{channelID,userID});}
 /** A server has one destination, so connecting replaces any earlier account. */
 async connected(details:{provider:CloudProvider;guildID:string;channelID?:string;userID?:string}):Promise<void>{
  const accounts=this.accounts(details.guildID);for(const provider of HOSTED_CLOUD_PROVIDERS)if(provider!==details.provider&&await accounts.configured(provider))await accounts.disconnect(provider);
  const current=this.settings.get(details.guildID).cloudUpload;await this.settings.update(details.guildID,{cloudUpload:{...current,provider:details.provider}});
  // The account is already connected, so a missing channel permission must not read as a failed sign-in.
  if(details.channelID)await this.say(details.channelID,`${details.userID?`<@${details.userID}>`:"A server manager"} connected ${CLOUD_LABELS[details.provider]} to this server. Exports sent to the cloud from this server now go to that account. Automatic upload is ${current?.auto?"on":"off"}.`).catch(error=>console.warn("[Cloud] Could not post a connection notice:",error));
 }
 async setAuto(guildID:string,auto:boolean):Promise<void>{
  const current=this.settings.get(guildID).cloudUpload;if(auto&&!current?.provider)throw Error("Connect an account first with /cloud action:connect.");
  await this.settings.update(guildID,{cloudUpload:{...current,auto}});
 }
 /** Removes the server's connection and asks the provider to revoke it. Files already uploaded stay in that account. */
 async disconnect(guildID:string):Promise<void>{const accounts=this.accounts(guildID);for(const provider of HOSTED_CLOUD_PROVIDERS)await accounts.disconnect(provider);await this.settings.update(guildID,{cloudUpload:undefined});}
 status(guildID:string):{provider?:CloudProvider;auto:boolean}{const choice=this.settings.get(guildID).cloudUpload;return {provider:choice?.provider,auto:!!choice?.auto};}
 /** Text for the live recording panel, so people in the call can see that a copy will leave the bot. */
 panelNotice(guildID:string):string|undefined{const choice=this.settings.get(guildID).cloudUpload;return choice?.auto&&choice.provider&&cloudUploadAllowed()&&uploadServerAllowed(guildID)?`When this recording ends, a copy goes to the ${CLOUD_LABELS[choice.provider]} account connected to this server.`:undefined;}
}

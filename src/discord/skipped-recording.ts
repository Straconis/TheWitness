import {UserError} from "../errors";
const NOTICE_INTERVAL_MS=3600000,lastNotice=new Map<string,number>();
/** Tells a voice channel's chat why an automatic start did not happen. At most hourly per server, since members joining an auto-record channel retry the start. */
export async function noticeSkippedRecording(transport:{createMessage(channel:string,body:any):Promise<unknown>},guildID:string,channelID:string,error:unknown,now=Date.now()):Promise<void>{
 const last=lastNotice.get(guildID);if(last!==undefined&&now-last<NOTICE_INTERVAL_MS)return;lastNotice.set(guildID,now);
 const message=error instanceof Error?error.message:"",reason=error instanceof UserError||message.startsWith("Disk space")?message:"The bot could not start it.";
 await transport.createMessage(channelID,{content:`⚠️ **Automatic recording skipped.** ${reason}`,allowedMentions:{parse:[]}}).catch(failure=>console.warn("[Recording] Could not post a skipped-recording notice.",failure));
}

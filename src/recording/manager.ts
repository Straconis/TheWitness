import { SessionSync } from "./sync";
import type {SettingsStore} from "../storage/settings";
import { assertDeploymentIdle } from "../storage/deployment";
import { EventEmitter } from "node:events";
import type Eris from "eris";
import { setTimeout as delay } from "node:timers/promises";
import { PacketBuffer, VoicePacket } from "./jitter";
import { RecordingSession } from "./session";
type Connector = () => Promise<Eris.VoiceConnection>;
/** Roughly five minutes of backoff: Discord voice-server moves and brief outages can outlast a few seconds. */
export const DEFAULT_RECONNECT_DELAYS = [1000,2000,4000,8000,15000,30000,30000,30000,60000,60000,60000];

export class RecordingManager {
 onDurationWarning?: (session:RecordingSession,minutes:number) => Promise<void>;
 onDurationLimit?: (session:RecordingSession) => Promise<void>;
 readonly sessions=new Map<string,RecordingSession>();
 private cleanup=new Map<string,()=>void>();private buffers=new Map<string,PacketBuffer>();
 private locks=new Map<string,Promise<unknown>>();private reconnecting=new Map<string,AbortController>();private shuttingDown=false;
 readonly syncSessions=new Map<string,SessionSync>();
 onDisconnected?: (session:RecordingSession)=>Promise<void>;
 constructor(private root:string,private retryDelays=DEFAULT_RECONNECT_DELAYS,private settings?:SettingsStore,private diskCritical:()=>Promise<boolean>|boolean=()=>false){}
 exclusive<T>(guildID:string,action:()=>Promise<T>):Promise<T>{
  if(this.shuttingDown)return Promise.reject(new Error("The Witness is shutting down."));
  const task=(this.locks.get(guildID)??Promise.resolve()).catch(()=>{}).then(action);this.locks.set(guildID,task);
  void task.finally(()=>{if(this.locks.get(guildID)===task)this.locks.delete(guildID);}).catch(()=>{});return task;
 }
 cancelReconnect(guildID:string):void{this.reconnecting.get(guildID)?.abort();}
 async start(guild:Eris.Guild,channelID:string,connection:Eris.VoiceConnection,connector?:Connector):Promise<RecordingSession>{
  const existing=this.sessions.get(guild.id);
  if(existing){if(existing.channelID!==channelID)throw new Error("Stop the existing recording before changing channels.");return existing;}
  await assertDeploymentIdle(this.root);
  if(await this.diskCritical())throw Error("Disk space is critically low. Free up space before starting a recording.");
  if(this.shuttingDown)throw Error("The Witness is shutting down.");
  await assertDeploymentIdle(this.root);
  const session=await RecordingSession.create(this.root,guild.id,channelID,guild.channels?.get(channelID)?.name,this.settings?.get(guild.id).recordingDurationHours);
  try{if(this.shuttingDown)throw Error("The Witness is shutting down.");await assertDeploymentIdle(this.root);this.bind(guild,connection,session,connector);}catch(error){await session.close(error as Error).catch(()=>{});throw error;}
  this.sessions.set(guild.id,session);
  session.onDurationWarning=async minutes=>{if(this.sessions.get(guild.id)===session)await this.onDurationWarning?.(session,minutes);};
  session.onDurationLimit=async()=>{
   this.cancelReconnect(guild.id);
   await this.exclusive(guild.id,async()=>{
    if(this.sessions.get(guild.id)!==session)return;
    try{await this.stop(guild.id);}finally{await this.onDurationLimit?.(session);}
   });
  };
  this.syncSessions.delete(guild.id);
  const sync=this.settings?.get(guild.id).sync;if(sync?.enabled){const slate=new SessionSync(session,sync);this.syncSessions.set(guild.id,slate);slate.start();}
  return session;
 }
 private bind(guild:Eris.Guild,connection:Eris.VoiceConnection,session:RecordingSession,connector?:Connector):void{
  const receiver=connection.receive("opus") as unknown as EventEmitter;
  const buffer=this.buffers.get(guild.id)??new PacketBuffer();this.buffers.set(guild.id,buffer);session.packetStats=buffer.stats;
  let failing=false;
  const fail=(error:Error)=>{if(failing)return;failing=true;console.error("[Recording] Capture failed:",error);void this.exclusive(guild.id,()=>this.stop(guild.id,error)).catch(error=>console.error("[Recording] Finalization failed:",error));};
  const write=(packets:VoicePacket[])=>{for(const packet of packets)void session.append(packet.data,packet.userID,packet.username,packet.timestamp,packet.arrival).catch(fail);};
  const onData=(data:Buffer,userID:string,timestamp:number)=>{if(!userID||failing)return;try{write(buffer.push({data,userID,username:guild.members.get(userID)?.username??userID,timestamp,arrival:session.elapsedSamples()}));}catch(error){fail(error as Error);}};
  const timer=setInterval(()=>{if(!failing)write(buffer.flushAged(session.elapsedSamples()));},50);timer.unref();
  const onError=(error:Error)=>console.error(`[Voice ${session.id}]`,error);
  const onDisconnect=(error?:Error)=>{
   if(this.reconnecting.has(guild.id)||this.shuttingDown)return;
   if(!error){
    this.cleanup.get(guild.id)?.();this.cleanup.delete(guild.id);
    session.stopReason="disconnected";
    void this.exclusive(guild.id,async()=>{if(this.sessions.get(guild.id)!==session)return;try{await this.stop(guild.id);}finally{await this.onDisconnected?.(session);}}).catch(error=>console.error("[Voice] Clean-disconnect finalization failed:",error));
    return;
   }
   const controller=new AbortController();this.reconnecting.set(guild.id,controller);
   session.voiceState="reconnecting";
   this.cleanup.get(guild.id)?.();this.cleanup.delete(guild.id);
   void this.exclusive(guild.id,async()=>{if(connector)await this.reconnect(guild,session,connector,controller,error);else {this.reconnecting.delete(guild.id);await this.stop(guild.id,error??new Error("Voice connection disconnected."));}}).catch(error=>console.error("[Voice]",error));
  };
  receiver.on("data",onData);receiver.on("error",fail);connection.on("error",onError);connection.on("disconnect",onDisconnect);
  session.voiceState="connected";
  this.cleanup.set(guild.id,()=>{clearInterval(timer);receiver.removeListener("data",onData);receiver.removeListener("error",fail);connection.removeListener("error",onError);connection.removeListener("disconnect",onDisconnect);});
 }
 private async reconnect(guild:Eris.Guild,session:RecordingSession,connector:Connector,controller:AbortController,cause?:Error):Promise<void>{
  if(this.sessions.get(guild.id)!==session||controller.signal.aborted||this.shuttingDown){this.reconnecting.delete(guild.id);return;}
  let failure=cause??new Error("Voice connection lost.");
  try{
   for(const wait of this.retryDelays){
    await delay(wait,undefined,{signal:controller.signal});
    if(this.sessions.get(guild.id)!==session)return;
    try{
     const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]);
     const attempted=connector();
     // Disconnect a connection that finishes after cancellation/timeout.
     void attempted.then(connection=>{if(signal.aborted)connection.disconnect();}).catch(()=>{});
     const connection=await Promise.race([attempted,new Promise<never>((_,reject)=>signal.addEventListener("abort",()=>reject(new Error("Voice reconnect cancelled or timed out.")),{once:true}))]);
     this.bind(guild,connection,session,connector);return;
    }catch(error){failure=error as Error;if(controller.signal.aborted)return;}
   }
   await this.stop(guild.id,failure);
  }catch(error){if(!controller.signal.aborted)throw error;}
  finally{this.reconnecting.delete(guild.id);}
 }
 async stop(guildID:string,error?:Error):Promise<RecordingSession|undefined>{
  this.cancelReconnect(guildID);const session=this.sessions.get(guildID);if(!session)return;
  session.cancelDurationTimers();
  try{await this.syncSessions.get(guildID)?.stop(!error&&!this.shuttingDown&&session.stopReason!=="duration-limit"&&session.stopReason!=="low-disk"&&session.stopReason!=="disconnected");}catch(cueError){console.warn('[Sync] End cue failed:',cueError);}
  this.cleanup.get(guildID)?.();this.cleanup.delete(guildID);
  const buffer=this.buffers.get(guildID);this.buffers.delete(guildID);let finalError=error;
  for(const packet of buffer?.flush()??[]){try{await session.append(packet.data,packet.userID,packet.username,packet.timestamp,packet.arrival);}catch(error){finalError??=error as Error;}}
  try{await session.close(finalError);}finally{this.sessions.delete(guildID);}return session;
 }
 /** Finalize independent servers together; a slow reconnect must not delay every stop. */
 async stopForLowDisk():Promise<void>{
  await Promise.allSettled([...this.sessions.values()].map(session=>{
   this.cancelReconnect(session.guildID);
   return this.exclusive(session.guildID,async()=>{
    if(this.sessions.get(session.guildID)!==session)return;
    session.stopReason="low-disk";
    try{await this.stop(session.guildID);}finally{await this.onDurationLimit?.(session);}
   }).catch(error=>console.error("[Recording] Low-disk stop failed:",error));
  }));
 }
 async shutdown():Promise<void>{
  this.shuttingDown=true;for(const controller of this.reconnecting.values())controller.abort();await Promise.allSettled([...this.locks.values()]);
  const results=await Promise.allSettled([...this.sessions.keys()].map(id=>this.stop(id)));
  if(results.some(result=>result.status==="rejected"))throw new Error("One or more recordings failed to finalize.");
 }
}

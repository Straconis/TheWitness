interface Owner {channelID:string;connection:object}
/** Only idle connections created by Auto Join are eligible; active recordings are never stopped. */
export class IdleVoice {
 private owners=new Map<string,Owner>();private timers=new Map<string,NodeJS.Timeout>();private closed=false;
 constructor(private snapshot:(guildID:string,owner:Owner)=>{sameConnection:boolean;hasHumans:boolean|undefined;recording:boolean},private leave:(guildID:string)=>void){}
 own(guildID:string,channelID:string,connection:object):void{if(this.closed)return;this.clear(guildID);this.owners.set(guildID,{channelID,connection});this.changed(guildID,channelID);}
 private clear(id:string):void{clearTimeout(this.timers.get(id));this.timers.delete(id);}
 changed(guildID:string,channelID:string):void{
  const owner=this.owners.get(guildID);if(this.closed||!owner||owner.channelID!==channelID)return;
  const state=this.snapshot(guildID,owner);
  if(!state.sameConnection){this.clear(guildID);this.owners.delete(guildID);return;}
  if(state.recording||state.hasHumans!==false){this.clear(guildID);return;}
  if(this.timers.has(guildID))return;
  const timer=setTimeout(()=>{
   this.clear(guildID);if(this.closed||this.owners.get(guildID)!==owner)return;
   const current=this.snapshot(guildID,owner);
   if(!current.sameConnection){this.owners.delete(guildID);return;}
   if(current.recording||current.hasHumans!==false)return;
   this.owners.delete(guildID);this.leave(guildID);
  },60_000);timer.unref();this.timers.set(guildID,timer);
 }
 recheck():void{for(const [id,owner] of this.owners)this.changed(id,owner.channelID);}
 close():void{this.closed=true;for(const id of this.timers.keys())this.clear(id);this.owners.clear();}
}

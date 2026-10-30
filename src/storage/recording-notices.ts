import {readFile,writeFile,rename} from "node:fs/promises";
import path from "node:path";
import type {GuildSettings} from "./settings";
import {sessionIDPattern} from "./sessions";
export type NoticeKind="start"|"end";
export type NoticeChoice={mode:"default"}|{mode:"off"}|{mode:"custom";sourceGuildID:string;customID:string};
type Legacy=Array<[string,GuildSettings]>;
export function validateNotice(which:NoticeKind,value:unknown):NoticeChoice{
 const choice=value as NoticeChoice;
 if(!choice||typeof choice!=="object"||!["default","off","custom"].includes(choice.mode)||which==="end"&&choice.mode==="default")throw Error("Invalid recording notice default.");
 if(choice.mode==="custom"){
  if(typeof choice.sourceGuildID!=="string"||!(/^[a-zA-Z0-9_-]{1,64}$/).test(choice.sourceGuildID)||typeof choice.customID!=="string"||!sessionIDPattern.test(choice.customID))throw Error("Choose an existing recording notice.");
  return {mode:"custom",sourceGuildID:choice.sourceGuildID,customID:choice.customID};
 }
 return choice.mode==="off"?{mode:"off"}:{mode:"default"};
}
/** Bot-wide defaults reference retained files in place; no audio copying or legacy-setting rewrite. */
export class RecordingNotices {
 private overrides:Partial<Record<NoticeKind,NoticeChoice>>={};private pending:Promise<void>=Promise.resolve();private file:string;
 constructor(root:string){this.file=path.join(root,"recording-notices.json");}
 async load(){try{const data=JSON.parse(await readFile(this.file,"utf8"));if(!data||typeof data!=="object"||Array.isArray(data))throw Error("Invalid recording notice defaults.");const next:typeof this.overrides={};for(const which of ["start","end"] as const)if(data[which]!==undefined)next[which]=validateNotice(which,data[which]);this.overrides=next;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
 private inherited(which:NoticeKind,legacy:Legacy){
  const custom=new Map<string,NoticeChoice>();for(const [guild,settings] of legacy){const choice=settings[which==="start"?"startSound":"endSound"];if(choice?.mode==="custom"&&choice.customID)custom.set(guild+":"+choice.customID,{mode:"custom",sourceGuildID:guild,customID:choice.customID});}
  if(custom.size===1)return {choice:[...custom.values()][0]!,needsSelection:false};
  const mode=which==="start"&&(!legacy.length||legacy.some(([,settings])=>settings.startSound?.mode!=="off"))?"default":"off";
  return {choice:{mode} as NoticeChoice,needsSelection:custom.size>1};
 }
 defaults(legacy:Legacy){const result={} as Record<NoticeKind,{choice:NoticeChoice;needsSelection:boolean}>;for(const which of ["start","end"] as const)result[which]=this.overrides[which]?{choice:structuredClone(this.overrides[which]!),needsSelection:false}:this.inherited(which,legacy);return result;}
 resolve(which:NoticeKind,guild:string,legacy:Legacy):NoticeChoice{
  const selected=this.defaults(legacy)[which];if(!selected.needsSelection)return selected.choice;
  // Conflicting old custom notices retain playback until the owner chooses a shared default.
  const old=legacy.find(([id])=>id===guild)?.[1][which==="start"?"startSound":"endSound"];
  return old?.mode==="custom"&&old.customID?{mode:"custom",sourceGuildID:guild,customID:old.customID}:(old?.mode==="off"||which==="end"?{mode:"off"}:{mode:"default"});
 }
 references(){return Object.values(this.overrides).filter((choice):choice is Extract<NoticeChoice,{mode:"custom"}>=>choice?.mode==="custom").map(choice=>({sourceGuildID:choice.sourceGuildID,customID:choice.customID}));}
 update(which:NoticeKind,value:unknown){const choice=validateNotice(which,value);const task=this.pending.then(async()=>{const next={...this.overrides,[which]:choice};await writeFile(this.file+".tmp",JSON.stringify(next,null,2),{mode:0o600});await rename(this.file+".tmp",this.file);this.overrides=next;});this.pending=task.catch(()=>{});return task;}
}

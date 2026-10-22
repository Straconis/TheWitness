import {drainIntroWork} from "./exports/server-intro";
import {stopVadProbes} from "./integrations/transcription-config";
/**
 * Final stages, after downloads close: wait for intro uploads still converting or pruning (refusing new ones),
 * and only then let the export queue stop protecting the intros its persisted jobs reference.
 */
export function introShutdownStages(queue:{releaseIntroReferences():void}):Array<{name:string;close:()=>Promise<unknown>|unknown}>{
 return [{name:"intro uploads",close:()=>drainIntroWork()},{name:"intro references",close:()=>queue.releaseIntroReferences()},{name:"transcription probes",close:()=>stopVadProbes()}];
}
/** Preserve cleanup order, but attempt every stage even if an earlier stage fails. */
export async function shutdownInOrder(stages:Array<{name:string;close:()=>Promise<unknown>|unknown}>,report:(name:string,error:unknown)=>void):Promise<void>{
 for(const stage of stages){try{await stage.close();}catch(error){report(stage.name,error);}}
}

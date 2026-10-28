import {writeNativeAudacity} from "./aup3";
import {exportProgressReporter} from "./workspace";
/** A self-contained native project: rendered media and its exact timeline are embedded. */
export async function writeAudacity(directory:string,tracks:Array<{file:string;username:string}>,notes:Array<{seconds:number;text:string}>=[],options:{project?:string;ffmpegPath?:string;signal?:AbortSignal;onProgress?:(stage:string,totalSeconds?:number,workID?:string)=>void}={}):Promise<void>{
 let started=false,lastStage="";
 const report=exportProgressReporter();
 await writeNativeAudacity(directory,tracks,notes,{...options,onProgress:(stage,seconds,total)=>{if(stage!==lastStage){options.onProgress?.(stage,total,"aup3");lastStage=stage;}if(!started){report?.(0);started=true;}report?.(seconds);}});
}

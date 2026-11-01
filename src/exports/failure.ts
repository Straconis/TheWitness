import {UserError} from "../errors";
/** Keep technical diagnostics private while giving the recording owner an actionable reason. */
export function exportFailureMessage(error:unknown,stage?:string):string{
 const message=error instanceof Error?error.message:String(error),code=(error as NodeJS.ErrnoException|undefined)?.code;
 const step=stage&&!["Failed","Ready"].includes(stage)?` during ${stage.slice(0,180)}`:"";
 if(error instanceof UserError)return message;
 if(/Audio tool timed out/.test(message))return `Audio processing exceeded its time limit${step}. Long recordings can take longer than this limit. Retry the export; if speech cleanup was selected, try turning it off. Your original recording is preserved.`;
 if(/Audio tool stalled/.test(message))return `Audio processing stopped making progress${step} and was stopped after five minutes. Retry the export; if speech cleanup was selected, try turning it off. Your original recording is preserved.`;
 if(code==="ENOSPC"||/No space left on device/.test(message))return `The server ran out of free disk space${step}. Free space or remove old exports, then retry. Your original recording is preserved.`;
 if(code==="ENOENT")return `A required audio tool or recording file was unavailable${step}. The server administrator needs to restore it before you retry.`;
 if(code==="EACCES"||code==="EPERM")return `The server could not access a required file or audio tool${step}. The server administrator needs to correct its permissions before you retry.`;
 if(/Audio tool failed/.test(message)){
  if(/Invalid data found|Error while decoding|Invalid packet|corrupt/i.test(message))return `The audio tool could not decode the audio${step}. Try another format; if it repeats, ask the administrator to check the recording's audio integrity.`;
  return `The audio tool could not complete processing${step}. Try another format or disable optional speech cleanup, then retry. Your original recording is preserved.`;
 }
 return `An unexpected processing error occurred${step}. Your original recording is preserved. Retry the export; if it repeats, share the export ID with the server administrator.`;
}
/** Also explains older saved failures that predate public failure reasons. */
export function savedExportFailure(job:{publicError?:string;error?:string;failureStage?:string;stageTimings?:Record<string,unknown>}):string{
 const labels:Record<string,string>={cleanup:"speech cleanup",synchronize:"speaker synchronization",originals:"original audio conversion",conversion:"audio conversion",silence:"silence trimming",loudness:"loudness matching",intro:"intro preparation",mix:"mixing",project:"project creation",packaging:"ZIP packaging",transcription:"transcription",upload:"cloud upload",prepare:"export preparation"};
 const last=Object.keys(job.stageTimings??{}).at(-1);
 return job.publicError??exportFailureMessage(new Error(job.error??""),job.failureStage??(last?labels[last]:undefined));
}

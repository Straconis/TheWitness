import {UserError} from "../errors";
export function validateMixExclusions(value:unknown,available?:number[]):number[]{
 if(value===undefined)return [];
 if(!Array.isArray(value)||value.length>1000||value.some(track=>!Number.isSafeInteger(track)||track<1)||new Set(value).size!==value.length)throw new UserError("Invalid mixdown track selection.");
 if(available&&value.some(track=>!available.includes(track)))throw new UserError("A selected track does not belong to this recording.");
 if(available&&available.every(track=>value.includes(track)))throw new UserError("Keep at least one speaker in the mixdown.");
 return [...value].sort((a,b)=>a-b);
}

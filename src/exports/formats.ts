import {UserError} from "../errors";
export type ProjectTrackFormat="wav"|"flac";
export function resolveAudioFormat(format:string,trackFormat?:string):"ogg"|"wav"|"flac"|"mp3"|"aac"{
 if(format==="audition"||format==="audacity"||format==="soundcraft"){
  if(trackFormat!==undefined&&trackFormat!=="wav"&&trackFormat!=="flac")throw new UserError("Project track format must be WAV or FLAC.");
  return trackFormat??(format==="audition"?"flac":"wav");
 }
 if(trackFormat!==undefined)throw new UserError("Choose a project export before selecting a project track format.");
 if(!["ogg","wav","flac","mp3","aac"].includes(format))throw new UserError("Invalid export format.");
 return format as "ogg"|"wav"|"flac"|"mp3"|"aac";
}
export function trackProcessingRequested(options:{edits?:unknown;cleanupAudio?:boolean;reduceBleed?:boolean;trimSilence?:boolean;trimEndSilence?:boolean;normalizeAudio?:boolean;introID?:string}):boolean{return !!(options.edits||options.cleanupAudio||options.reduceBleed||options.trimSilence||options.trimEndSilence||options.normalizeAudio||options.introID);}
/**
 * Processing steps share lossless FLAC working files, so a lossy format is encoded exactly once, at the end.
 * FLAC output needs no separate final encode. Tracks that are not processed go straight to their final format,
 * which keeps untouched Opus as the original stream; a mix needs working tracks only if those would be re-encoded lossily first.
 */
export function usesWorkingAudio(format:string,options:{edits?:unknown;cleanupAudio?:boolean;reduceBleed?:boolean;trimSilence?:boolean;trimEndSilence?:boolean;normalizeAudio?:boolean;introID?:string;mix?:boolean;trimStart?:number;trimEnd?:number},imported=false):boolean{
 if(format==="flac")return false;
 if(trackProcessingRequested(options))return true;
 return !!options.mix&&(format==="mp3"||format==="aac"||format==="ogg"&&(imported||!!options.trimStart||options.trimEnd!==undefined));
}

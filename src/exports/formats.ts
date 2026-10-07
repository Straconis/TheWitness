import {UserError} from "../errors";
export type ProjectTrackFormat="wav"|"flac";
export function resolveAudioFormat(format:string,trackFormat?:string):"ogg"|"wav"|"flac"|"mp3"|"aac"{
 if(format==="audition"||format==="audacity"){
  if(trackFormat!==undefined&&trackFormat!=="wav"&&trackFormat!=="flac")throw new UserError("Project track format must be WAV or FLAC.");
  return trackFormat??(format==="audition"?"flac":"wav");
 }
 if(trackFormat!==undefined)throw new UserError("Choose a project export before selecting a project track format.");
 if(!["ogg","wav","flac","mp3","aac"].includes(format))throw new UserError("Invalid export format.");
 return format as "ogg"|"wav"|"flac"|"mp3"|"aac";
}

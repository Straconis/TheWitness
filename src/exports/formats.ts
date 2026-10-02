export type ProjectTrackFormat="wav"|"flac";
export function resolveAudioFormat(format:string,trackFormat?:string):"ogg"|"wav"|"flac"|"mp3"|"aac"{
 if(format==="audition"||format==="audacity"){
  if(trackFormat!==undefined&&trackFormat!=="wav"&&trackFormat!=="flac")throw Error("Project track format must be WAV or FLAC.");
  return trackFormat??(format==="audition"?"flac":"wav");
 }
 if(trackFormat!==undefined)throw Error("Choose a project export before selecting a project track format.");
 if(!["ogg","wav","flac","mp3","aac"].includes(format))throw Error("Invalid export format.");
 return format as "ogg"|"wav"|"flac"|"mp3"|"aac";
}

import {UserError} from "../errors";
export type DownloadNaming = "date" | "date-channel" | "original";
export interface NamingManifest {startedAt?:string;guildName?:string;guildID?:string;channelName?:string;channelID?:string;title?:string;sessionID?:string;tracks?:Array<{file:string;username:string}>;rawTracks?:Array<{file:string;username:string}>;mix?:string;mixName?:string;mixHasIntro?:boolean;intro?:unknown;trim?:{start:number;end?:number}}
type NamedTrack={file:string;username:string};
const trackNumber=(file:string)=>/track-(\d+)\./.exec(file)?.[1];
/** Windows, macOS and Linux safe; Unicode letters stay, separators, controls and bidi overrides do not. */
export function safeFileStem(text:string,fallback:string,max=80):string{
 const clean=(value:string)=>value.normalize("NFC").replace(/\s*:\s*/g," - ").replace(/[\x00-\x1f\x7f-\x9f<>"/\\|?*\u200b\u200c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g,"_").replace(/\s+/g," ").replace(/^[\s.]+|[\s.]+$/g,"");
 let name="",bytes=0;for(const char of Array.from(clean(text)).slice(0,max)){bytes+=Buffer.byteLength(char);if(bytes>200)break;name+=char;}name=name.replace(/[\s.]+$/g,"");
 if(!/[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(name))name=clean(fallback);
 return /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?=\.|$)/i.test(name)?name.replace(/^(.*?)($|\.)/,"$1_$2"):name;
}
/** Display names for project tracks; repeated speaker names get " (2)", " (3)" so tracks stay distinguishable. */
export function speakerLabels(tracks:NamedTrack[]):Map<string,string>{
 const labels=new Map<string,string>(),seen=new Set<string>();
 for(const [index,track] of tracks.entries()){
  const base=track.username.replace(/[\x00-\x1f\x7f]/g,"").replace(/\s+/g," ").trim()||`Speaker ${trackNumber(track.file)??index+1}`,key=(value:string)=>value.normalize("NFC").toLowerCase();
  let label=base;for(let count=2;seen.has(key(label));count++)label=`${base} (${count})`;
  seen.add(key(label));labels.set(track.file,label);
 }
 return labels;
}
/** ZIP member names for speaker audio; on-disk files keep track-N names that private URLs and the editor rely on. */
export function packagedTrackNames(tracks:NamedTrack[],rawTracks:NamedTrack[]=[]):Map<string,string>{
 // Case-insensitive: Windows and macOS extract "Mix.wav" over "mix.wav".
 const names=new Map<string,string>(),used=new Set(["ogg","wav","flac","mp3","m4a"].map(extension=>"mix."+extension));
 const add=(labels:Map<string,string>,suffix:string)=>{for(const [file,label] of labels){
  const extension=file.slice(file.lastIndexOf(".")).toLowerCase(),stem=safeFileStem(label,`Speaker ${trackNumber(file)??names.size+1}`)+suffix;let name=stem+extension;
  for(let count=2;used.has(name.toLowerCase());count++)name=`${stem} (${count})${extension}`;used.add(name.toLowerCase());names.set(file,name);
 }};
 add(speakerLabels(tracks),"");add(speakerLabels(rawTracks)," (uncut)");
 return names;
}
/** ASCII fallback plus RFC 5987 UTF-8 name, so browsers keep Unicode server, channel and speaker names. */
export function contentDisposition(type:"attachment"|"inline",filename:string):string{
 const ascii=filename.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^\x20-\x7e]|["\\]/g,"_");
 return ascii===filename?`${type}; filename="${ascii}"`:`${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename).replace(/['()*]/g,char=>"%"+char.charCodeAt(0).toString(16).toUpperCase())}`;
}
/** Presentation names only: private URLs and on-disk identifiers stay unchanged. */
export function validateMixName(value:unknown):string|undefined{
 if(value===undefined||value==="")return undefined;
 if(typeof value!=="string"||value.length>120||/[\x00-\x1f\x7f-\x9f]/.test(value))throw new UserError("Mix filenames must be text up to 120 characters, without control characters.");
 const text=value.trim();if(!text)return undefined;
 const name=safeFileStem(text,"",120);if(!name)throw new UserError("Use letters, numbers, or emoji in the mix filename.");return name;
}
export function mixedTrackName(file:string,manifest:NamingManifest):string{
 const date=new Date(manifest.startedAt??"");
 const extension=file.slice(file.lastIndexOf('.')),stem=validateMixName(manifest.mixName)?.replace(/\.(ogg|wav|flac|mp3|m4a|aac)$/i,"")??`${Number.isFinite(date.getTime())?date.toISOString().slice(0,10)+" - ":""}mix${(manifest.mixHasIntro??!!manifest.intro)?" w intro":""}`;
 const used=new Set([...packagedTrackNames(manifest.tracks??[],manifest.rawTracks??[]).values()].map(name=>name.toLowerCase()));let name=stem+extension;
 for(let count=2;used.has(name.toLowerCase());count++)name=stem+` (${count})`+extension;
 return name;
}
export function downloadName(file:string,manifest:NamingManifest,style:DownloadNaming):string{
 if(file===manifest.mix)return mixedTrackName(file,manifest);
 const member=packagedTrackNames(manifest.tracks??[],manifest.rawTracks??[]).get(file);if(member)return member;
 if(style==="original")return file;
 const date=manifest.startedAt?new Date(manifest.startedAt):undefined,valid=!!date&&Number.isFinite(date.getTime());
 if(file.toLowerCase().endsWith(".zip")){
  // "date - server - channel"; IDs stand in for names that older recordings never saved, and missing parts are left out.
  const parts=[valid?date!.toISOString().slice(0,10):"",manifest.guildName?.trim()||manifest.guildID||"",manifest.channelName?.trim()||manifest.channelID||""].filter(Boolean).map(part=>safeFileStem(part,"",80)).filter(Boolean);
  return parts.length?parts.join(" - ")+".zip":file;
 }
 if(!valid)return file;
 const prefix=date!.toISOString().slice(0,19).replace('T','_').replace(/:/g,'-')+'_UTC';
 const title=manifest.title?.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-zA-Z0-9_-]+/g,"_").replace(/^_+|_+$/g,"").slice(0,48);
 const clip=manifest.trim?`_clip-${manifest.trim.start}${manifest.trim.end!==undefined?'-'+manifest.trim.end:''}`:'';
 return `${prefix}${title?"_"+title:""}${clip}_${file}`;
}

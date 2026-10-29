export type DownloadNaming = "date" | "date-channel" | "original";
export interface NamingManifest {startedAt?:string;guildName?:string;guildID?:string;channelName?:string;channelID?:string;title?:string;sessionID?:string;tracks?:Array<{file:string;username:string}>;rawTracks?:Array<{file:string;username:string}>;trim?:{start:number;end?:number}}
type NamedTrack={file:string;username:string};
const speakerName=(name:string)=>Array.from(name.normalize('NFC').replace(/[^\p{L}\p{M}\p{N}\p{Extended_Pictographic}\u200d\ufe0f_-]+/gu,'_').replace(/^_+|_+$/g,'')).slice(0,48).join('');
const trackNumber=(file:string)=>/track-(\d+)\./.exec(file)?.[1];
/** Windows, macOS and Linux safe; Unicode letters stay, separators, controls and bidi overrides do not. */
export function safeFileStem(text:string,fallback:string,max=80):string{
 const clean=(value:string)=>value.normalize("NFC").replace(/\s*:\s*/g," - ").replace(/[\x00-\x1f\x7f-\x9f<>"/\\|?*\u200b\u200c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]+/g,"_").replace(/\s+/g," ").replace(/^[\s.]+|[\s.]+$/g,"");
 let name=Array.from(clean(text)).slice(0,max).join("").replace(/[\s.]+$/g,"");
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
export function downloadName(file:string,manifest:NamingManifest,style:DownloadNaming):string{
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
 const extension=file.slice(file.lastIndexOf('.'));
 const raw=manifest.rawTracks?.some(track=>track.file===file),group=(raw?manifest.rawTracks:manifest.tracks)??[];
 const speaker=speakerName(group.find(track=>track.file===file)?.username??'');
 const duplicates=speaker?group.filter(track=>speakerName(track.username).toLowerCase()===speaker.toLowerCase()):undefined;
 const suffix=(duplicates&&duplicates.length>1?'_'+(duplicates.findIndex(track=>track.file===file)+1):'')+(raw?'_uncut':'');
 return `${prefix}${title?"_"+title:""}${clip}${speaker?'_'+speaker+suffix+extension:'_'+file}`;
}

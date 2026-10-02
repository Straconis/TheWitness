export type DownloadNaming = "date" | "date-channel" | "original";
export interface NamingManifest {startedAt?:string;channelName?:string;channelID?:string;title?:string;sessionID?:string;tracks?:Array<{file:string;username:string}>;trim?:{start:number;end?:number}}
/** Presentation names only: private URLs and on-disk identifiers stay unchanged. */
export function downloadName(file:string,manifest:NamingManifest,style:DownloadNaming):string{
 if(style==="original"||!manifest.startedAt)return file;
 const date=new Date(manifest.startedAt);if(!Number.isFinite(date.getTime()))return file;
 if(file.toLowerCase().endsWith(".zip")){
  const day=date.toISOString().slice(0,10);
  const channel=(manifest.channelName||manifest.channelID||"").normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-zA-Z0-9_-]+/g,"-").replace(/^-+|-+$/g,"").slice(0,80);
  return `${day}${style==="date-channel"&&channel?"-"+channel:""}.zip`;
 }
 const prefix=date.toISOString().slice(0,19).replace('T','_').replace(/:/g,'-')+'_UTC';
 const title=manifest.title?.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-zA-Z0-9_-]+/g,"_").replace(/^_+|_+$/g,"").slice(0,48);
 const speaker=manifest.tracks?.find(track=>track.file===file)?.username.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-zA-Z0-9_-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,48);
 const clip=manifest.trim?`_clip-${manifest.trim.start}${manifest.trim.end!==undefined?'-'+manifest.trim.end:''}`:'';
 return `${prefix}${title?"_"+title:""}${clip}${speaker?'_'+speaker:''}_${file}`;
}

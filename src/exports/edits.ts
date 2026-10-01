import { runTool } from "./process";
export interface EditClip {start:number;end:number;at:number;fadeIn?:number;fadeOut?:number}
export interface TrackEdit {track:number;name?:string;gainDb:number;pan:number;muted:boolean;solo:boolean;clips:EditClip[]}
export interface AudioEdits {tracks:TrackEdit[];notes?:Array<{seconds:number;text:string}>}
export function validateEdits(edits:AudioEdits,available?:number[]):void{
 if(!edits||!Array.isArray(edits.tracks)||!edits.tracks.length||edits.tracks.length>100||new Set(edits.tracks.map(track=>track.track)).size!==edits.tracks.length)throw Error("Invalid editor tracks.");
 if(edits.notes!==undefined&&(!Array.isArray(edits.notes)||edits.notes.length>1000||edits.notes.some(note=>!Number.isFinite(note.seconds)||note.seconds<0||note.seconds>86400||typeof note.text!=="string"||!note.text.trim()||note.text.length>2000)))throw Error("Invalid editor notes.");
 let count=0;for(const track of edits.tracks){
  if(!Number.isInteger(track.track)||track.track<1||(available&&!available.includes(track.track))||!Number.isFinite(track.gainDb)||track.gainDb< -60||track.gainDb>24||!Number.isFinite(track.pan)||Math.abs(track.pan)>1||typeof track.muted!=="boolean"||typeof track.solo!=="boolean"||(track.name!==undefined&&(typeof track.name!=="string"||track.name.length>120||/[\x00-\x1f\x7f]/.test(track.name)))||!Array.isArray(track.clips)||!track.clips.length)throw Error("Invalid track settings.");
  for(const clip of track.clips){count++;if(![clip.start,clip.end,clip.at].every(Number.isFinite)||clip.start<0||clip.end<=clip.start||clip.at<0||clip.end>86400||clip.at+clip.end-clip.start>86400||[clip.fadeIn??0,clip.fadeOut??0].some(value=>!Number.isFinite(value)||value<0||value>clip.end-clip.start))throw Error("Invalid clip bounds or fades.");}
 }if(count>500)throw Error("An edit may contain at most 500 clips.");
}
export async function renderEdits(input:string,output:string,edit:TrackEdit,soloActive:boolean,codec:string,ffmpeg:string,signal?:AbortSignal):Promise<void>{
 const volume=edit.muted||(soloActive&&!edit.solo)?0:10**(edit.gainDb/20),left=edit.pan>0?1-edit.pan:1,right=edit.pan<0?1+edit.pan:1;
 const filters:string[]=[];filters.push(`[0:a]asplit=${edit.clips.length}${edit.clips.map((_,index)=>`[s${index}]`).join("")}`);
 for(const [index,clip] of edit.clips.entries()){
  const duration=clip.end-clip.start;
  filters.push(`[s${index}]atrim=start=${clip.start}:end=${clip.end},asetpts=PTS-STARTPTS,volume=${volume},pan=stereo|c0=${left}*c0|c1=${right}*c1${clip.fadeIn?`,afade=t=in:d=${clip.fadeIn}`:""}${clip.fadeOut?`,afade=t=out:st=${duration-clip.fadeOut}:d=${clip.fadeOut}`:""},adelay=${Math.round(clip.at*48000)}S:all=1[c${index}]`);
 }
 filters.push(`${edit.clips.map((_,index)=>`[c${index}]`).join("")}amix=inputs=${edit.clips.length}:duration=longest:normalize=0[out]`);
 await runTool(ffmpeg,["-nostdin","-v","error","-n","-i",input,"-filter_complex",filters.join(";"),"-map","[out]","-c:a",codec,...(codec==="pcm_s16le"?["-rf64","auto"]:[]),...(codec==="aac"?["-f","mp4"]:[]),output],signal);
}

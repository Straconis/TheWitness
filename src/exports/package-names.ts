import {mixedTrackName,packagedTrackNames} from "../downloads/names";

export function packageNames(manifest:any):Map<string,string>{
 const tracks=(value:any)=>Array.isArray(value)&&value.every(track=>typeof track?.file==="string"&&typeof track?.username==="string")?value:[];
 const names=packagedTrackNames(tracks(manifest.tracks),tracks(manifest.rawTracks));
 if(typeof manifest.mix==="string"&&/^mix\.(ogg|wav|flac|mp3|m4a)$/.test(manifest.mix)){
  const base=mixedTrackName(manifest.mix,manifest),dot=base.lastIndexOf('.'),used=new Set([...names.values()].map(name=>name.toLowerCase()));let name=base;
  for(let count=2;used.has(name.toLowerCase());count++)name=base.slice(0,dot)+` (${count})`+base.slice(dot);
  names.set(manifest.mix,name);
 }
 return names;
}
const xml=(text:string)=>text.replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[char]!));
/** Package metadata references the delivered filenames; the host's private file identifiers stay stable. */
export function packageFileData(file:string,data:Buffer,names:ReadonlyMap<string,string>):Buffer{
 if(file==="manifest.json"){
  const manifest=JSON.parse(data.toString("utf8"));
  for(const key of ["tracks","rawTracks"])if(Array.isArray(manifest[key]))manifest[key]=manifest[key].map((track:any)=>({...track,file:names.get(track.file)??track.file}));
  if(manifest.mix)manifest.mix=names.get(manifest.mix)??manifest.mix;
  if(manifest.loudness?.tracks)manifest.loudness.tracks=Object.fromEntries(Object.entries(manifest.loudness.tracks).map(([name,value])=>[names.get(name)??name,value]));
  return Buffer.from(JSON.stringify(manifest,null,2));
 }
 if(file.endsWith(".sesx"))return Buffer.from(data.toString("utf8").replace(/relativePath="([^"]*)"/g,(attribute,name:string)=>names.has(name)?`relativePath="${xml(names.get(name)!)}"`:attribute));
 if(file.endsWith(".scraft")){
  const project=JSON.parse(data.toString("utf8"));
  for(const source of project.sources??[])if(typeof source.path==="string")source.path=names.get(source.path)??source.path;
  return Buffer.from(JSON.stringify(project));
 }
 return data;
}

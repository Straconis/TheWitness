// Legacy AUP import-project structure adapted from Craig 60d1a00 cook.sh.
// Copyright/permission: licenses/Craig-ISC.txt. Open in Audacity, then save in its native format.
import { mkdir,link,writeFile,readdir } from "node:fs/promises";
import path from "node:path";
const xml=(text:string)=>text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g,"").replace(/[&<>"']/g,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[char]!));
export async function writeAudacity(directory:string,tracks:Array<{file:string;username:string}>,notes:Array<{seconds:number;text:string}>=[],options:{project?:string}={}):Promise<Array<{file:string;username:string}>>{
 // Audacity looks for <import> files in "<AUP name>_data"; the folder name must follow the project filename.
 const project=options.project??"session",data=project+"_data";if(!/^[A-Za-z0-9-]+$/.test(project))throw new Error("Invalid Audacity project name.");
 await mkdir(path.join(directory,data));
 const imports=[];const used=new Set((await readdir(directory)).map(name=>name.toLowerCase()));
 for(const track of tracks){
  // Audacity names imported tracks from the media basename, ignoring the import name attribute.
  const base=track.username.normalize("NFKC").replace(/[\x00-\x1f<>:"/\\|?*]/g,"_").replace(/[\uFFFE\uFFFF]/g,"").replace(/[. ]+$/g,"").slice(0,100)||"Speaker";
  let name=base+path.extname(track.file),suffix=2;while(used.has(name.toLowerCase()))name=base+" ("+suffix+++")"+path.extname(track.file);used.add(name.toLowerCase());
  await link(path.join(directory,track.file),path.join(directory,data,name));
  imports.push({...track,file:name});
 }

 const labels=notes.length?`<labeltrack name="Recording notes" numlabels="${notes.length}" height="150" minimized="0">${notes.map(note=>`<label t="${note.seconds}" t1="${note.seconds}" title="${xml(note.text)}"/>`).join("")}</labeltrack>`:"";
 await writeFile(path.join(directory,project+".aup"),`<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n<!DOCTYPE project PUBLIC "-//audacityproject-1.3.0//DTD//EN" "http://audacity.sourceforge.net/xml/audacityproject-1.3.0.dtd">\n<project xmlns="http://audacity.sourceforge.net/xml/" projname="${data}" version="1.3.0" audacityversion="2.2.2" rate="48000.0"><tags/>${labels}${imports.map(track=>`<import filename="${xml(track.file)}" name="${xml(track.username)}" offset="0" mute="0" solo="0" height="150" minimized="0" gain="1" pan="0"/>`).join("\n")}</project>`);
 return imports;
}

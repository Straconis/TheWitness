import { mkdir,readFile,writeFile,rename,rm,realpath } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ExportOptions } from "./export";
import { renderEdits,validateEdits } from "./edits";
import { runTool } from "./process";
import { writeAudition } from "./audition";
import { writeAudacity } from "./audacity";
import { writeProjectZip } from "./project-zip";
import { existsSync } from "node:fs";
export async function exportEdited(root:string,sessionID:string,options:ExportOptions):Promise<string>{
 if(!/^export-[a-f0-9-]{36}$/i.test(options.sourceExport??""))throw Error("Invalid editor source.");
 const parent=await realpath(path.join(root,sessionID)),source=await realpath(path.join(parent,options.sourceExport!));if(!source.startsWith(parent+path.sep))throw Error("Invalid editor source.");
 const metadata=JSON.parse(await readFile(path.join(parent,"session.json"),"utf8"));if(metadata.state!=="completed")throw Error("Only completed recordings can be edited.");
 const manifest=JSON.parse(await readFile(path.join(source,"manifest.json"),"utf8"));if(manifest.sessionID!==sessionID||manifest.guildID!==metadata.guildID||!Array.isArray(manifest.tracks))throw Error("Invalid editor manifest.");
 validateEdits(options.edits!,manifest.tracks.map((track:any)=>Number(/^track-(\d+)\.(ogg|wav|flac|mp3|m4a)$/.exec(track.file)?.[1])));
 const requested=options.format??"wav",format=requested==="audition"?"flac":requested==="audacity"?"wav":requested,codecs={wav:"pcm_s16le",flac:"flac",ogg:"libopus",mp3:"libmp3lame",aac:"aac"};if(!(format in codecs))throw Error("Invalid editor format.");
 const codec=codecs[format],ffmpeg=options.ffmpegPath??(process.env.FFMPEG_PATH?.trim()||(existsSync(path.resolve(__dirname,"../../bin/ffmpeg"))?path.resolve(__dirname,"../../bin/ffmpeg"):"ffmpeg"));
 const id=randomUUID(),temporary=path.join(parent,`export-${id}.tmp`),target=path.join(parent,`export-${id}`);await mkdir(temporary);
 try{
  const tracks:Array<{file:string;userID:string;username:string}>=[];
  for(const track of manifest.tracks){options.signal?.throwIfAborted();const number=Number(/^track-(\d+)\.(ogg|wav|flac|mp3|m4a)$/.exec(track.file)?.[1]);if(!number)throw Error("Invalid editor track file.");const input=await realpath(path.join(source,track.file));if(!input.startsWith(source+path.sep))throw Error("Invalid editor track source.");const file=`track-${number}.${format==="aac"?"m4a":format}`,edit=options.edits!.tracks.find(edit=>edit.track===number);
   if(!edit)throw Error("Every source track needs editor settings.");
   await renderEdits(input,path.join(temporary,file),edit,options.edits!.tracks.some(track=>track.solo),codec,ffmpeg,options.signal);tracks.push({file,userID:track.userID,username:edit.name||track.username});
  }
  let mix:string|undefined;if(options.mix){mix=`mix.${format==="aac"?"m4a":format}`;await runTool(ffmpeg,["-nostdin","-v","error","-n",...tracks.flatMap(track=>["-i",path.join(temporary,track.file)]),"-filter_complex",`amix=inputs=${tracks.length}:duration=longest:normalize=0`,"-c:a",codec,...(format==="wav"?["-rf64","auto"]:[]),...(format==="aac"?["-f","mp4"]:[]),path.join(temporary,mix)],options.signal);}
  const notes=options.edits!.notes??[];if(notes.length)await writeFile(path.join(temporary,"notes.json"),JSON.stringify(notes,null,2));
  if(requested==="audition")await writeAudition(temporary,tracks,notes,manifest.title);if(requested==="audacity")await writeAudacity(temporary,tracks,notes);
  await writeFile(path.join(temporary,"manifest.json"),JSON.stringify({sessionID,guildID:metadata.guildID,startedAt:metadata.startedAt, channelName:metadata.channelName, channelID:metadata.channelID,title:manifest.title,format:requested,tracks,mix,notes:notes.length?"notes.json":undefined,project:["audition","audacity"].includes(requested)?"project.zip":undefined,sourceExport:options.sourceExport,edits:options.edits},null,2));
  if(["audition","audacity"].includes(requested))await writeProjectZip(temporary,options.signal);options.signal?.throwIfAborted();await rename(temporary,target);return target;
 }catch(error){await rm(temporary,{recursive:true,force:true});throw error;}
}

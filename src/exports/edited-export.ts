import {validateMixName} from "../downloads/names";
import {assertSpeechCleanup,cleanSpeech,defaultAudioTool} from "./speech-cleanup";
import type {ExportWork} from "./progress";
import {assertSoundcraftLength,soundcraftExportSeconds} from "./soundcraft-limits";
import {writeSoundcraftProject,validateSavedBackups} from "./soundcraft-backup";
import {validateMixExclusions} from "./mix-selection";
import {resolveAudioFormat,usesWorkingAudio} from "./formats";
import {reduceBleed,BLEED_PRESET,BLEED_ATTENUATION_DB,BleedReport} from "./bleed";
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
 options={...options,mixName:options.mix?validateMixName(options.mixName):undefined};
 if(!/^export-[a-f0-9-]{36}$/i.test(options.sourceExport??""))throw Error("Invalid editor source.");
 const parent=await realpath(path.join(root,sessionID)),source=await realpath(path.join(parent,options.sourceExport!));if(!source.startsWith(parent+path.sep))throw Error("Invalid editor source.");
 const metadata=JSON.parse(await readFile(path.join(parent,"session.json"),"utf8"));if(metadata.state!=="completed")throw Error("Only completed recordings can be edited.");
 const manifest=JSON.parse(await readFile(path.join(source,"manifest.json"),"utf8"));if(manifest.sessionID!==sessionID||manifest.guildID!==metadata.guildID||!Array.isArray(manifest.tracks))throw Error("Invalid editor manifest.");
 validateEdits(options.edits!,manifest.tracks.map((track:any)=>Number(/^track-(\d+)\.(ogg|wav|flac|mp3|m4a)$/.exec(track.file)?.[1])));
 const requested=options.format??"wav",format=resolveAudioFormat(requested,options.trackFormat),codecs={wav:"pcm_s16le",flac:"flac",ogg:"libopus",mp3:"libmp3lame",aac:"aac"};if(!(format in codecs))throw Error("Invalid editor format.");
 if(requested==="soundcraft")assertSoundcraftLength(soundcraftExportSeconds(metadata,options));
 const finalCodec=codecs[format],finalExtension=format==="aac"?"m4a":format,working=usesWorkingAudio(format,options),codec=working?"flac":finalCodec,extension=working?"flac":finalExtension,encode=["-c:a",codec,...(codec==="pcm_s16le"?["-rf64","auto"]:[])],ffmpeg=options.ffmpegPath??defaultAudioTool(),bleed=!!options.reduceBleed&&!manifest.bleedReduction;
 if(options.cleanupAudio&&!manifest.cleanupAudio)await assertSpeechCleanup(ffmpeg);
 const id=randomUUID(),temporary=path.join(parent,`export-${id}.tmp`),target=path.join(parent,`export-${id}`);await mkdir(temporary);
 try{
  const speakers=manifest.tracks.filter((track:any)=>track.userID!=="witness-sync"&&track.userID!=="server-intro"),trackNumber=(track:{file:string})=>Number(/^track-(\d+)/.exec(track.file)?.[1]),sourceDuration=Math.max(...options.edits!.tracks.map(edit=>Math.max(...edit.clips.map(c=>c.end))));
  const plan:ExportWork[]=[...(bleed?speakers.flatMap((track:any)=>[{id:`bleed-source:${trackNumber(track)}`,kind:"encode" as const,seconds:sourceDuration},{id:`bleed-scan:${trackNumber(track)}`,kind:"analyze" as const,seconds:sourceDuration},{id:`bleed:${trackNumber(track)}`,kind:"encode" as const,seconds:sourceDuration}]):[]),...options.edits!.tracks.map(edit=>({id:`edit:${edit.track}`,kind:"encode" as const,seconds:Math.max(...edit.clips.map(c=>c.at+c.end-c.start))}))];
  if(options.cleanupAudio&&!manifest.cleanupAudio)for(const track of manifest.tracks){if(track.userID==="witness-sync"||track.userID==="server-intro")continue;const number=Number(/^track-(\d+)/.exec(track.file)?.[1]),index=plan.findIndex(task=>task.id===`edit:${number}`);plan.splice(index+1,0,{id:`clean:${number}`,kind:"cleanup",seconds:plan[index]!.seconds});}
  const duration=Math.max(...plan.map(task=>task.seconds));if(options.mix)plan.push({id:"mix",kind:"mix",seconds:duration});if(working){for(const track of options.edits!.tracks)plan.push({id:`final:${track.track}`,kind:"encode",seconds:Math.max(...track.clips.map(c=>c.at+c.end-c.start))});if(options.mix)plan.push({id:"final:mix",kind:"encode",seconds:duration});}if(requested==="audacity"||requested==="soundcraft"&&options.backupProjects?.includes("audacity"))plan.push({id:"aup3",kind:"project",seconds:options.edits!.tracks.reduce((n,t)=>n+Math.max(...t.clips.map(c=>c.at+c.end-c.start)),0)});plan.push({id:"package",kind:"package",seconds:plan.reduce((sum,task)=>sum+task.seconds,0)});options.onPlan?.(plan);
  const tracks:Array<{file:string;userID:string;username:string}>=[];
  // Compare speakers on the export's own timeline, before this edit moves any clips.
  const reduced=new Map<number,string>();let bleedTracks:BleedReport|undefined;
  if(bleed){for(const track of speakers){const number=trackNumber(track);if(!/^track-\d+\.(ogg|wav|flac|mp3|m4a)$/.test(track.file))throw Error("Invalid editor track file.");const input=await realpath(path.join(source,track.file));if(!input.startsWith(source+path.sep))throw Error("Invalid editor track source.");const copy=path.join(temporary,`bleed-source-${number}.flac`);options.onProgress?.(`Preparing bleed reduction: ${track.username}`,sourceDuration,`bleed-source:${number}`);await runTool(ffmpeg,["-nostdin","-v","error","-n","-i",input,"-c:a","flac",copy],options.signal);reduced.set(number,copy);}
   const report=await reduceBleed(speakers.map((track:any)=>({key:track.file,file:reduced.get(trackNumber(track))!,username:track.username})),sourceDuration,"flac",ffmpeg,options.signal,options.onProgress);bleedTracks={};for(const track of speakers)bleedTracks[`track-${trackNumber(track)}.${finalExtension}`]=report[track.file]!;}
  for(const track of manifest.tracks){options.signal?.throwIfAborted();const number=Number(/^track-(\d+)\.(ogg|wav|flac|mp3|m4a)$/.exec(track.file)?.[1]);if(!number)throw Error("Invalid editor track file.");const input=reduced.get(number)??await realpath(path.join(source,track.file));if(!reduced.has(number)&&!input.startsWith(source+path.sep))throw Error("Invalid editor track source.");const file=`track-${number}.${extension}`,edit=options.edits!.tracks.find(edit=>edit.track===number);
   if(!edit)throw Error("Every source track needs editor settings.");
   options.onProgress?.(`Rendering speaker ${tracks.length+1} of ${manifest.tracks.length}: ${track.username}`,Math.max(...edit.clips.map(clip=>clip.at+clip.end-clip.start)),`edit:${number}`);
   await renderEdits(input,path.join(temporary,file),edit,options.edits!.tracks.some(track=>track.solo),codec,ffmpeg,options.signal);if(options.cleanupAudio&&!manifest.cleanupAudio&&track.userID!=="witness-sync"&&track.userID!=="server-intro"){options.onProgress?.(`Cleaning speech: ${edit.name||track.username}`,Math.max(...edit.clips.map(c=>c.at+c.end-c.start)),`clean:${number}`);await cleanSpeech(path.join(temporary,file),codec,ffmpeg,options.signal);}const copy=reduced.get(number);if(copy)await rm(copy);tracks.push({file,userID:track.userID,username:edit.name||track.username});
  }
  let mix:string|undefined,mixHasIntro=false;if(options.mix){options.onProgress?.("Mixing edited speakers",duration,"mix");const excluded=validateMixExclusions(options.excludeFromMix,tracks.map(track=>Number(/^track-(\d+)/.exec(track.file)![1]))),mixedTracks=tracks.filter(track=>!excluded.includes(Number(/^track-(\d+)/.exec(track.file)![1])));mixHasIntro=!!manifest.intro&&mixedTracks.some(track=>{const edit=options.edits!.tracks.find(edit=>edit.track===Number(/^track-(\d+)/.exec(track.file)![1]));return track.userID==="server-intro"&&!edit?.muted&&(!options.edits!.tracks.some(track=>track.solo)||edit?.solo);});mix=`mix.${extension}`;await runTool(ffmpeg,["-nostdin","-v","error","-n",...mixedTracks.flatMap(track=>["-i",path.join(temporary,track.file)]),"-filter_complex",`amix=inputs=${mixedTracks.length}:duration=longest:normalize=0`,...encode,...(extension==="m4a"?["-f","mp4"]:[]),path.join(temporary,mix)],options.signal);}
  if(working){
   const finish=async(file:string,label:string,workID:string,seconds:number):Promise<string>=>{const output=file.replace(/\.flac$/,`.${finalExtension}`);options.onProgress?.(`Encoding final audio: ${label}`,seconds,`final:${workID}`);await runTool(ffmpeg,["-nostdin","-v","error","-n","-i",path.join(temporary,file),"-c:a",finalCodec,...(format==="wav"?["-rf64","auto"]:[]),...(format==="aac"?["-f","mp4"]:[]),path.join(temporary,output)],options.signal);await rm(path.join(temporary,file));return output;};
   for(const track of tracks){const number=trackNumber(track);track.file=await finish(track.file,track.username,String(number),Math.max(...options.edits!.tracks.find(edit=>edit.track===number)!.clips.map(c=>c.at+c.end-c.start)));}
   if(mix)mix=await finish(mix,"mix","mix",duration);
  }

  options.onProgress?.("Building project");
  const notes=options.edits!.notes??[];if(notes.length)await writeFile(path.join(temporary,"notes.json"),JSON.stringify(notes,null,2));
  const backupProjects=validateSavedBackups(options.backupProjects,requested);
  if(requested==="soundcraft")await writeSoundcraftProject(temporary,tracks,notes,manifest.title,backupProjects,{ffmpegPath:ffmpeg,signal:options.signal,onProgress:options.onProgress});
  if(requested==="audition")await writeAudition(temporary,tracks,notes,manifest.title);if(requested==="audacity")await writeAudacity(temporary,tracks,notes,{ffmpegPath:ffmpeg,signal:options.signal,onProgress:options.onProgress});
  await writeFile(path.join(temporary,"manifest.json"),JSON.stringify({sessionID,guildID:metadata.guildID,guildName:metadata.guildName,startedAt:metadata.startedAt, channelName:metadata.channelName, channelID:metadata.channelID,title:manifest.title,format:requested,cleanupAudio:!!options.cleanupAudio||!!manifest.cleanupAudio,cleanupPreset:options.cleanupAudio||manifest.cleanupAudio?"gentle-speech-v1":undefined,bleedReduction:bleedTracks?{preset:BLEED_PRESET,attenuationDb:BLEED_ATTENUATION_DB,tracks:bleedTracks}:manifest.bleedReduction,backupProjects:backupProjects?.length?backupProjects:undefined,trackFormat:["audition","audacity","soundcraft"].includes(requested)?format:undefined,tracks,mix,mixName:options.mixName,intro:manifest.intro,mixHasIntro:mix?mixHasIntro:undefined,notes:notes.length?"notes.json":undefined,project:["audition","audacity","soundcraft"].includes(requested)?"project.zip":undefined,sourceExport:options.sourceExport,edits:options.edits},null,2));
  if(["audition","audacity","soundcraft"].includes(requested)){options.onProgress?.("Compressing and packaging download",undefined,"package");await writeProjectZip(temporary,options.signal);}options.signal?.throwIfAborted();await rename(temporary,target);return target;
 }catch(error){await rm(temporary,{recursive:true,force:true});throw error;}
}

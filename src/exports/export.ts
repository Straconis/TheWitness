import { deprioritize,processClosed } from "./process";
import {measureLevel,normalizationGain,applyGain,AudioLevel,matchLoudness,LoudnessMatch,resolveLoudness} from "./normalization";
import {findSilenceCuts,cutSharedSilence,shiftedTime,SilenceCut,silenceSeconds} from "./silence";
import {getServerIntro,introPCM} from "./server-intro";
import {validateMixExclusions} from "./mix-selection";
import {resolveAudioFormat,ProjectTrackFormat} from "./formats";
import { exportEdited } from "./edited-export";
import { AudioEdits,validateEdits,renderEdits } from "./edits";
import { writeAudacity } from "./audacity";
import { runTool } from "./process";
import { writeAudition } from "./audition";
import { writeProjectZip } from "./project-zip";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type ExportFormat = "ogg" | "wav" | "flac" | "mp3" | "aac" | "audition" | "audacity";
export interface ExportOptions { format?: ExportFormat; trackFormat?:ProjectTrackFormat; targetLUFS?:number;maxTruePeakDBTP?:number;normalizeAudio?:boolean; normalizeIntro?:boolean; trimSilence?:boolean;trimEndSilence?:boolean;silenceSeconds?:number;includeRaw?:boolean; introID?:string; mix?: boolean; excludeFromMix?:number[]; trimStart?: number; trimEnd?: number; correctorPath?: string; ffmpegPath?: string; signal?:AbortSignal; edits?:AudioEdits; sourceExport?:string }

/** Feed Craig's two-pass correction without loading an entire recording into memory. */
async function correct(directory: string, track: number, target: string, executable: string,signal?:AbortSignal): Promise<void> {
  const child = spawn(executable, [String(track)], { stdio: ["pipe", "pipe", "pipe"],signal,killSignal:"SIGKILL" });
  deprioritize(child);
  const closed=processClosed(child);
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
  const exited = once(child, "close").then(([code]) => {
    if (code !== 0) throw new Error(`Craig correction failed (${code}): ${stderr}`);
  });
  const output = pipeline(child.stdout, createWriteStream(target, { flags: "wx" }));
  async function* chunks() {
    for (let pass = 0; pass < 2; pass++) {
      for (const suffix of ["header1", "header2", "data"]) {
        yield* createReadStream(path.join(directory, `audio.ogg.${suffix}`));
      }
    }
  }
  const input = pipeline(Readable.from(chunks()), child.stdin);
  try { await Promise.all([exited, output, input]); }
  catch (error) {
    child.kill("SIGKILL");
    child.stdin.destroy();
    await Promise.allSettled([closed, exited, output, input]);
    throw error;
  }
}

const codecs = { wav: "pcm_s16le", flac: "flac", mp3: "libmp3lame", ogg: "libopus", aac: "aac" };
function ffmpegPath(options: ExportOptions): string {
  return options.ffmpegPath ?? (process.env.FFMPEG_PATH?.trim() || (existsSync(path.resolve(__dirname,"../../bin/ffmpeg")) ? path.resolve(__dirname,"../../bin/ffmpeg") : "ffmpeg"));
}
async function convert(args:string[],executable:string,signal?:AbortSignal):Promise<void>{if(args.at(-1)?.endsWith(".m4a"))args.splice(args.length-1,0,"-f","mp4");await runTool(executable,["-nostdin","-v","error","-n",...args],signal);}

export async function exportSession(root: string, sessionID: string, options: ExportOptions = {}): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionID)) {
    throw new Error("Invalid session ID.");
  }
  const loudnessSettings=resolveLoudness(options);
  silenceSeconds(options.silenceSeconds??30);
  if(options.sourceExport)return exportEdited(root,sessionID,options);
  options.signal?.throwIfAborted();
  const requestedFormat=options.format??"ogg";
  const format=resolveAudioFormat(requestedFormat,options.trackFormat);
  if (!["ogg", "wav", "flac", "mp3", "aac"].includes(format)) throw new Error("Unsupported export format.");
  const start=options.trimStart??0,end=options.trimEnd;
  if(!Number.isFinite(start)||start<0||(end!==undefined&&(!Number.isFinite(end)||end<=start)))throw new Error("Invalid trim range.");
  const directory = path.join(root, sessionID);
  const metadata = JSON.parse(await readFile(path.join(directory, "session.json"), "utf8"));
  if (metadata.state !== "completed") throw new Error("Only completed sessions can be exported; interrupted or failed sessions require recovery.");
  if (!Array.isArray(metadata.tracks) || !metadata.tracks.length) throw new Error("Session has no audio tracks.");
  const users = JSON.parse("{" + await readFile(path.join(directory, "audio.ogg.users"), "utf8") + "}");
  const id = randomUUID();
  const temporary = path.join(directory, `export-${id}.tmp`);
  const target = path.join(directory, `export-${id}`);
  await mkdir(temporary);
  try {
    if(options.edits)validateEdits(options.edits,metadata.tracks.map((track:any)=>track.track));
    const intro=options.introID?await getServerIntro(root,metadata.guildID,options.introID):undefined;if(options.introID&&!intro)throw Error("Saved intro not found.");
    const rawTracks:Array<{file:string;userID:string;username:string}>=[];
    const manifest: Array<{ file: string; userID: string; username: string }> = [];
    for (const track of metadata.tracks) {
      options.signal?.throwIfAborted();
      if (!Number.isInteger(track.track) || track.track < 1 || !users[track.track]) throw new Error("Invalid session track metadata.");
      const ogg = path.join(temporary, `track-${track.track}.ogg`);
      await correct(directory, track.track, ogg, options.correctorPath ?? path.resolve(__dirname, "../../bin/oggcorrect"),options.signal);
      if ((await stat(ogg)).size === 0) throw new Error(`Track ${track.track} produced no audio.`);
      if(options.includeRaw){
        const file=`raw-track-${track.track}.flac`;
        if(track.pcmFile){
          if(!/^browser-track-\d+\.pcm$/.test(track.pcmFile))throw Error("Invalid browser source.");
          const delay=Math.max(0,Math.round((track.pcmStart??0)-(metadata.audioOrigin??0)));
          await convert(["-f","s16le","-ar","48000","-ac","2","-i",path.join(directory,track.pcmFile),"-af",`adelay=${delay}S:all=1`,"-c:a","flac",path.join(temporary,file)],ffmpegPath(options),options.signal);
        }else await convert(["-i",ogg,"-c:a","flac",path.join(temporary,file)],ffmpegPath(options),options.signal);
        rawTracks.push({file,userID:track.id,username:track.username});
      }
      const excerpt=[...(start>0?["-ss",String(start)]:[]),...(end!==undefined?["-t",String(end-start)]:[])];
      // Only Ogg output needs a trimmed Opus file; other formats trim while decoding, avoiding a second lossy Opus generation.
      if(excerpt.length&&format==="ogg"){
        const trimmed=path.join(temporary,`trim-${track.track}.ogg`);
        await convert(["-i",ogg,...excerpt,"-c:a","libopus",trimmed],ffmpegPath(options),options.signal);
        await rename(trimmed,ogg);
      }
      const file = `track-${track.track}.${format==="aac"?"m4a":format}`;
      if (format !== "ogg") {
        if(track.pcmFile&&["wav","flac"].includes(format)){
          if(!/^browser-track-\d+\.pcm$/.test(track.pcmFile))throw new Error("Invalid browser source.");
          const delay=Math.max(0,Math.round((track.pcmStart??0)-(metadata.audioOrigin??0)));
          const args=["-f","s16le","-ar","48000","-ac","2","-i",path.join(directory,track.pcmFile),"-af",`adelay=${delay}S:all=1`];
          await convert([...args,...excerpt,"-c:a",codecs[format],...(format==="wav"?["-rf64","auto"]:[]),path.join(temporary,file)],ffmpegPath(options),options.signal);
        }else await convert(["-i",ogg,...excerpt,"-c:a",codecs[format],...(format==="wav"?["-rf64","auto"]:[]),path.join(temporary,file)],ffmpegPath(options),options.signal);
      }
      const edit=options.edits?.tracks.find(edit=>edit.track===track.track);
      if(edit){const edited=path.join(temporary,`edited-${track.track}.${format==="aac"?"m4a":format}`);await renderEdits(path.join(temporary,file),edited,edit,options.edits!.tracks.some(track=>track.solo),codecs[format],ffmpegPath(options),options.signal);await rename(edited,path.join(temporary,file));}

      manifest.push({ file, userID: track.id, username: edit?.name||track.username });
    }
    let silenceCuts:SilenceCut[]=[];let trailingSilenceCut:SilenceCut|undefined;
    if(options.trimSilence||options.trimEndSilence){const excluded=validateMixExclusions(options.excludeFromMix,metadata.tracks.map((track:{track:number})=>track.track)),files=manifest.map(track=>path.join(temporary,track.file)),selected=new Set(manifest.filter(track=>!excluded.includes(Number(/^track-(\d+)/.exec(track.file)![1]))).map(track=>path.join(temporary,track.file)));const detected=await findSilenceCuts(files,selected,ffmpegPath(options),options.signal,options.silenceSeconds??30,options.trimEndSilence,!!options.trimSilence);silenceCuts=detected.cuts;trailingSilenceCut=detected.trailingCut;await cutSharedSilence(files,silenceCuts,detected.duration,codecs[format],ffmpegPath(options),options.signal);}
    let introGain=1;
    const loudnessMatches:Record<string,LoudnessMatch>={};
    if(options.normalizeAudio||(intro&&options.normalizeIntro)){
      const levels=new Map<string,AudioLevel>();for(const track of manifest){const file=path.join(temporary,track.file),level=await measureLevel(file,ffmpegPath(options),options.signal,false,loudnessSettings);if(options.normalizeAudio){const matched=await matchLoudness(file,codecs[format],ffmpegPath(options),options.signal,level,loudnessSettings);loudnessMatches[track.file]=matched;levels.set(track.file,matched.after);}else levels.set(track.file,level);}
      if(intro&&options.normalizeIntro){const selected=manifest.filter(track=>!(options.excludeFromMix??[]).includes(Number(/^track-(\d+)/.exec(track.file)![1]))).map(track=>levels.get(track.file)!).filter(level=>Number.isFinite(level.lufs));if(selected.length){const target=10*Math.log10(selected.reduce((sum,level)=>sum+10**(level.lufs/10),0)/selected.length),level=await measureLevel(introPCM(root,metadata.guildID,intro.id),ffmpegPath(options),options.signal,true,loudnessSettings);introGain=normalizationGain(level,target,loudnessSettings.maxTruePeakDBTP);}}
    }
    if(intro)for(const track of manifest){const file=track.file;if(intro){const shifted=path.join(temporary,`shifted-${file}`);await convert(["-i",path.join(temporary,file),"-af",`adelay=${Math.round(intro.seconds*48000)}S:all=1`,"-c:a",codecs[format],...(format==="wav"?["-rf64","auto"]:[]),shifted],ffmpegPath(options),options.signal);await rename(shifted,path.join(temporary,file));}}
    if(intro){const number=Math.max(...metadata.tracks.map((track:{track:number})=>track.track))+1,file=`track-${number}.${format==="aac"?"m4a":format}`;await convert(["-f","s16le","-ar","48000","-ac","2","-i",introPCM(root,metadata.guildID,intro.id),"-af",`volume=${introGain}`,"-c:a",codecs[format],...(format==="wav"?["-rf64","auto"]:[]),path.join(temporary,file)],ffmpegPath(options),options.signal);manifest.push({file,userID:"server-intro",username:"Intro: "+intro.name});}
    let mix: string | undefined;
    if (options.mix) {
      mix = `mix.${format==="aac"?"m4a":format}`;
      const excluded=validateMixExclusions(options.excludeFromMix,metadata.tracks.map((track:{track:number})=>track.track));
      const mixedTracks=manifest.filter(track=>track.userID!=="server-intro"&&!excluded.includes(Number(/^track-(\d+)/.exec(track.file)![1])));
      const inputs = mixedTracks.flatMap(track => ["-i",path.join(temporary,track.file)]);
      await convert([...inputs,"-filter_complex",`amix=inputs=${mixedTracks.length}:duration=longest:normalize=1`,"-c:a",codecs[format],...(format==="wav"?["-rf64","auto"]:[]),path.join(temporary,mix)],ffmpegPath(options),options.signal);
      if(intro){const introTrack=manifest.find(track=>track.userID==="server-intro")!,introFile=path.join(temporary,introTrack.file),mixFile=path.join(temporary,mix);
        if(options.normalizeIntro){const target=await measureLevel(mixFile,ffmpegPath(options),options.signal,false,loudnessSettings),level=await measureLevel(introFile,ffmpegPath(options),options.signal,false,loudnessSettings);if(Number.isFinite(target.lufs)){const gain=normalizationGain(level,target.lufs,loudnessSettings.maxTruePeakDBTP);await applyGain(introFile,gain,codecs[format],ffmpegPath(options),options.signal);introGain*=gain;}}
        const combined=path.join(temporary,"intro-"+mix);await convert(["-i",mixFile,"-i",introFile,"-filter_complex","amix=inputs=2:duration=longest:normalize=0","-c:a",codecs[format],...(format==="wav"?["-rf64","auto"]:[]),combined],ffmpegPath(options),options.signal);await rename(combined,mixFile);
      }
    }
    if(options.normalizeAudio&&mix)loudnessMatches[mix]=await matchLoudness(path.join(temporary,mix),codecs[format],ffmpegPath(options),options.signal,undefined,loudnessSettings);
    if (format !== "ogg") for (const track of metadata.tracks) await rm(path.join(temporary,`track-${track.track}.ogg`));
    let notes: string | undefined;
    let exportedNotes:Array<{seconds:number;text:string;authorID?:string}>=[];
    try {
      const lines = (await readFile(path.join(directory,"notes.jsonl"),"utf8")).trim();
      if (lines) {
        const origin=(metadata.audioOrigin??0)/48000;
        exportedNotes=lines.split("\n").map(line=>JSON.parse(line)).map(note=>{if(!Number.isFinite(note.seconds)||typeof note.text!=="string")throw new Error("Invalid recording note.");return {...note,seconds:note.seconds-origin};}).filter(note=>note.seconds>=start&&(end===undefined||note.seconds<end)&&(!trailingSilenceCut||note.seconds-start<trailingSilenceCut.start)).map(note=>({...note,seconds:shiftedTime(note.seconds-start,silenceCuts)+(intro?.seconds??0)}));
        if(exportedNotes.length){notes="notes.json";await writeFile(path.join(temporary,notes),JSON.stringify(exportedNotes,null,2));}
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    let syncCues;
    try{const sync=JSON.parse(await readFile(path.join(directory,"sync-cues.json"),"utf8"));syncCues={version:1,sessionID,cues:sync.cues.filter((cue:any)=>cue.state==="captured").map((cue:any)=>{const audioSeconds=cue.seconds-(metadata.audioOrigin??0)/48000;return {...cue,recordingSeconds:cue.seconds,originalAudioSeconds:audioSeconds,exportSeconds:!options.edits&&audioSeconds>=start&&(end===undefined||audioSeconds<end)&&(!trailingSilenceCut||audioSeconds-start<trailingSilenceCut.start)?shiftedTime(audioSeconds-start,silenceCuts)+(intro?.seconds??0):null};}),timingModified:!!(options.edits||options.trimSilence||options.trimEndSilence||intro||start||end!==undefined),note:"Cues identify timing differences; edits and processing can change alignment. For sync, use original audio and visual cue positions."};}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}
    if(requestedFormat==="audacity")await writeAudacity(temporary,manifest,exportedNotes);
    if(requestedFormat==="audition")await writeAudition(temporary,manifest,exportedNotes,metadata.title);
    await writeFile(path.join(temporary, "manifest.json"), JSON.stringify({ syncCues, sessionID, guildID: metadata.guildID, startedAt: metadata.startedAt, channelName:metadata.channelName, channelID:metadata.channelID, title:metadata.title, edits:options.edits, format:requestedFormat, trackFormat:["audition","audacity"].includes(requestedFormat)?format:undefined, project:(["audition","audacity"].includes(requestedFormat)||options.includeRaw)?"project.zip":undefined, normalizeAudio:options.normalizeAudio??false, loudness:(options.normalizeAudio||options.normalizeIntro)?{standard:"EBU R128 / ITU-R BS.1770",targetLUFS:loudnessSettings.targetLUFS,truePeakDBTP:loudnessSettings.maxTruePeakDBTP,tracks:loudnessMatches}:undefined, normalizeIntro:!!intro&&!!options.normalizeIntro, introGain, silenceSeconds:options.trimSilence?(options.silenceSeconds??30):undefined, rawTracks:options.includeRaw?rawTracks:undefined, trimEndSilence:options.trimEndSilence??false, trailingSilenceCut, silenceCuts, intro, tracks: manifest, mix, excludeFromMix:(options.mix||options.trimSilence||options.trimEndSilence)?options.excludeFromMix:undefined, notes, trim: (start>0||end!==undefined)?{start,end}:undefined }, null, 2));
    if(["audition","audacity"].includes(requestedFormat)||options.includeRaw)await writeProjectZip(temporary,options.signal);
    options.signal?.throwIfAborted();
    await rename(temporary, target);
    return target;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

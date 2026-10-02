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
export interface ExportOptions { format?: ExportFormat; mix?: boolean; trimStart?: number; trimEnd?: number; correctorPath?: string; ffmpegPath?: string; signal?:AbortSignal; edits?:AudioEdits; sourceExport?:string }

/** Feed Craig's two-pass correction without loading an entire recording into memory. */
async function correct(directory: string, track: number, target: string, executable: string,signal?:AbortSignal): Promise<void> {
  const child = spawn(executable, [String(track)], { stdio: ["pipe", "pipe", "pipe"],signal,killSignal:"SIGKILL" });
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
    child.kill();
    child.stdin.destroy();
    await Promise.allSettled([exited, output, input]);
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
  if(options.sourceExport)return exportEdited(root,sessionID,options);
  options.signal?.throwIfAborted();
  const requestedFormat=options.format??"ogg";
  const format=requestedFormat==="audition"?"flac":requestedFormat==="audacity"?"wav":requestedFormat;
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
    const manifest: Array<{ file: string; userID: string; username: string }> = [];
    for (const track of metadata.tracks) {
      options.signal?.throwIfAborted();
      if (!Number.isInteger(track.track) || track.track < 1 || !users[track.track]) throw new Error("Invalid session track metadata.");
      const ogg = path.join(temporary, `track-${track.track}.ogg`);
      await correct(directory, track.track, ogg, options.correctorPath ?? path.resolve(__dirname, "../../bin/oggcorrect"),options.signal);
      if ((await stat(ogg)).size === 0) throw new Error(`Track ${track.track} produced no audio.`);
      if(start>0||end!==undefined){
        const trimmed=path.join(temporary,`trim-${track.track}.ogg`);
        await convert(["-i",ogg,"-ss",String(start),...(end!==undefined?["-t",String(end-start)]:[]),"-c:a","libopus",trimmed],ffmpegPath(options),options.signal);
        await rename(trimmed,ogg);
      }
      const file = `track-${track.track}.${format==="aac"?"m4a":format}`;
      if (format !== "ogg") {
        if(track.pcmFile&&["wav","flac"].includes(format)){
          if(!/^browser-track-\d+\.pcm$/.test(track.pcmFile))throw new Error("Invalid browser source.");
          const delay=Math.max(0,Math.round((track.pcmStart??0)-(metadata.audioOrigin??0)));
          const args=["-f","s16le","-ar","48000","-ac","2","-i",path.join(directory,track.pcmFile),"-af",`adelay=${delay}S:all=1`];
          if(start>0)args.push("-ss",String(start));if(end!==undefined)args.push("-t",String(end-start));
          await convert([...args,"-c:a",codecs[format],...(format==="wav"?["-rf64","auto"]:[]),path.join(temporary,file)],ffmpegPath(options),options.signal);
        }else await convert(["-i",ogg,"-c:a",codecs[format],...(format==="wav"?["-rf64","auto"]:[]),path.join(temporary,file)],ffmpegPath(options),options.signal);
      }
      const edit=options.edits?.tracks.find(edit=>edit.track===track.track);
      if(edit){const edited=path.join(temporary,`edited-${track.track}.${format==="aac"?"m4a":format}`);await renderEdits(path.join(temporary,file),edited,edit,options.edits!.tracks.some(track=>track.solo),codecs[format],ffmpegPath(options),options.signal);await rename(edited,path.join(temporary,file));}
      manifest.push({ file, userID: track.id, username: edit?.name||track.username });
    }
    let mix: string | undefined;
    if (options.mix) {
      mix = `mix.${format==="aac"?"m4a":format}`;
      const inputs = manifest.flatMap(track => ["-i",path.join(temporary,track.file)]);
      await convert([...inputs,"-filter_complex",`amix=inputs=${metadata.tracks.length}:duration=longest:normalize=1`,"-c:a",codecs[format],...(format==="wav"?["-rf64","auto"]:[]),path.join(temporary,mix)],ffmpegPath(options),options.signal);
    }
    if (format !== "ogg") for (const track of metadata.tracks) await rm(path.join(temporary,`track-${track.track}.ogg`));
    let notes: string | undefined;
    let exportedNotes:Array<{seconds:number;text:string;authorID?:string}>=[];
    try {
      const lines = (await readFile(path.join(directory,"notes.jsonl"),"utf8")).trim();
      if (lines) {
        const origin=(metadata.audioOrigin??0)/48000;
        exportedNotes=lines.split("\n").map(line=>JSON.parse(line)).map(note=>{if(!Number.isFinite(note.seconds)||typeof note.text!=="string")throw new Error("Invalid recording note.");return {...note,seconds:note.seconds-origin};}).filter(note=>note.seconds>=start&&(end===undefined||note.seconds<end)).map(note=>({...note,seconds:note.seconds-start}));
        if(exportedNotes.length){notes="notes.json";await writeFile(path.join(temporary,notes),JSON.stringify(exportedNotes,null,2));}
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if(requestedFormat==="audacity")await writeAudacity(temporary,manifest,exportedNotes);
    if(requestedFormat==="audition")await writeAudition(temporary,manifest,exportedNotes,metadata.title);
    await writeFile(path.join(temporary, "manifest.json"), JSON.stringify({ sessionID, guildID: metadata.guildID, startedAt: metadata.startedAt, channelName:metadata.channelName, channelID:metadata.channelID, title:metadata.title, edits:options.edits, format:requestedFormat, project:["audition","audacity"].includes(requestedFormat)?"project.zip":undefined, tracks: manifest, mix, notes, trim: (start>0||end!==undefined)?{start,end}:undefined }, null, 2));
    if(["audition","audacity"].includes(requestedFormat))await writeProjectZip(temporary,options.signal);
    options.signal?.throwIfAborted();
    await rename(temporary, target);
    return target;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

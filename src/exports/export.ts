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

export type ExportFormat = "ogg" | "wav" | "flac" | "mp3" | "audition";
export interface ExportOptions { format?: ExportFormat; mix?: boolean; trimStart?: number; trimEnd?: number; correctorPath?: string; ffmpegPath?: string }

/** Feed Craig's two-pass correction without loading an entire recording into memory. */
async function correct(directory: string, track: number, target: string, executable: string): Promise<void> {
  const child = spawn(executable, [String(track)], { stdio: ["pipe", "pipe", "pipe"] });
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

const codecs = { wav: "pcm_s16le", flac: "flac", mp3: "libmp3lame", ogg: "libopus" };
function ffmpegPath(options: ExportOptions): string {
  return options.ffmpegPath ?? (process.env.FFMPEG_PATH?.trim() || (existsSync(path.resolve(__dirname,"../../bin/ffmpeg")) ? path.resolve(__dirname,"../../bin/ffmpeg") : "ffmpeg"));
}
async function convert(args: string[], executable: string): Promise<void> {
  const child = spawn(executable,["-nostdin","-v","error","-n",...args],{stdio:["ignore","ignore","pipe"]});
  let stderr = "";
  child.stderr.on("data",chunk => { stderr = (stderr+chunk).slice(-8192); });
  const [code] = await once(child,"close");
  if (code !== 0) throw new Error(`Audio conversion failed (${code}): ${stderr}`);
}

export async function exportSession(root: string, sessionID: string, options: ExportOptions = {}): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionID)) {
    throw new Error("Invalid session ID.");
  }
  const requestedFormat=options.format??"ogg";
  const format=requestedFormat==="audition"?"wav":requestedFormat;
  if (!["ogg", "wav", "flac", "mp3"].includes(format)) throw new Error("Unsupported export format.");
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
    const manifest: Array<{ file: string; userID: string; username: string }> = [];
    for (const track of metadata.tracks) {
      if (!Number.isInteger(track.track) || track.track < 1 || !users[track.track]) throw new Error("Invalid session track metadata.");
      const ogg = path.join(temporary, `track-${track.track}.ogg`);
      await correct(directory, track.track, ogg, options.correctorPath ?? path.resolve(__dirname, "../../bin/oggcorrect"));
      if ((await stat(ogg)).size === 0) throw new Error(`Track ${track.track} produced no audio.`);
      if(start>0||end!==undefined){
        const trimmed=path.join(temporary,`trim-${track.track}.ogg`);
        await convert(["-i",ogg,"-ss",String(start),...(end!==undefined?["-t",String(end-start)]:[]),"-c:a","libopus",trimmed],ffmpegPath(options));
        await rename(trimmed,ogg);
      }
      const file = `track-${track.track}.${format}`;
      if (format !== "ogg") {
        if(track.pcmFile&&["wav","flac"].includes(format)){
          if(!/^browser-track-\d+\.pcm$/.test(track.pcmFile))throw new Error("Invalid browser source.");
          const delay=Math.max(0,Math.round((track.pcmStart??0)-(metadata.audioOrigin??0)));
          const args=["-f","s16le","-ar","48000","-ac","2","-i",path.join(directory,track.pcmFile),"-af",`adelay=${delay}S:all=1`];
          if(start>0)args.push("-ss",String(start));if(end!==undefined)args.push("-t",String(end-start));
          await convert([...args,"-c:a",codecs[format],...(format==="wav"?["-rf64","auto"]:[]),path.join(temporary,file)],ffmpegPath(options));
        }else await convert(["-i",ogg,"-c:a",codecs[format],...(format==="wav"?["-rf64","auto"]:[]),path.join(temporary,file)],ffmpegPath(options));
      }
      manifest.push({ file, userID: track.id, username: track.username });
    }
    let mix: string | undefined;
    if (options.mix) {
      mix = `mix.${format}`;
      const inputs = metadata.tracks.flatMap((track: any) => ["-i",path.join(temporary,`track-${track.track}.ogg`)]);
      await convert([...inputs,"-filter_complex",`amix=inputs=${metadata.tracks.length}:duration=longest:normalize=1`,"-c:a",codecs[format],...(format==="wav"?["-rf64","auto"]:[]),path.join(temporary,mix)],ffmpegPath(options));
    }
    if (format !== "ogg") for (const track of metadata.tracks) await rm(path.join(temporary,`track-${track.track}.ogg`));
    let notes: string | undefined;
    try {
      const lines = (await readFile(path.join(directory,"notes.jsonl"),"utf8")).trim();
      if (lines) {
        notes = "notes.json";
        await writeFile(path.join(temporary,notes),JSON.stringify(lines.split("\n").map(line => JSON.parse(line)),null,2));
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if(requestedFormat==="audition")await writeAudition(temporary,manifest);
    await writeFile(path.join(temporary, "manifest.json"), JSON.stringify({ sessionID, guildID: metadata.guildID, startedAt: metadata.startedAt, format:requestedFormat, project:requestedFormat==="audition"?"project.zip":undefined, tracks: manifest, mix, notes, trim: (start>0||end!==undefined)?{start,end}:undefined }, null, 2));
    if(requestedFormat==="audition")await writeProjectZip(temporary);
    await rename(temporary, target);
    return target;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

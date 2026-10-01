import { spawn } from "node:child_process";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { once } from "node:events";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type ExportFormat = "ogg" | "wav" | "flac" | "mp3";
export interface ExportOptions { format?: ExportFormat; correctorPath?: string; ffmpegPath?: string }

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

async function transcode(input: string, output: string, format: ExportFormat, executable: string): Promise<void> {
  const codec = { wav: "pcm_s16le", flac: "flac", mp3: "libmp3lame", ogg: "libopus" }[format];
  const child = spawn(executable, ["-nostdin", "-v", "error", "-n", "-i", input, "-c:a", codec, output], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-8192); });
  const [code] = await once(child, "close");
  if (code !== 0) throw new Error(`Audio conversion failed (${code}): ${stderr}`);
}

export async function exportSession(root: string, sessionID: string, options: ExportOptions = {}): Promise<string> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionID)) {
    throw new Error("Invalid session ID.");
  }
  const format = options.format ?? "ogg";
  if (!["ogg", "wav", "flac", "mp3"].includes(format)) throw new Error("Unsupported export format.");
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
      const file = `track-${track.track}.${format}`;
      if (format !== "ogg") {
        await transcode(ogg, path.join(temporary, file), format, options.ffmpegPath ?? (process.env.FFMPEG_PATH?.trim() || (existsSync(path.resolve(__dirname, "../../bin/ffmpeg")) ? path.resolve(__dirname, "../../bin/ffmpeg") : "ffmpeg")));
        await rm(ogg);
      }
      manifest.push({ file, userID: track.id, username: track.username });
    }
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(temporary, "manifest.json"), JSON.stringify({ sessionID, format, tracks: manifest }, null, 2));
    await rename(temporary, target);
    return target;
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

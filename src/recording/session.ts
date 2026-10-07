import { DEFAULT_RECORDING_DURATION_HOURS, DURATION_WARNING_MINUTES, validateRecordingDuration } from "./duration";
// Craig split-file layout and Opus headers adapted from commit 60d1a00.
// See licenses/Craig-ISC.txt for copyright and permission notice.
import { validateTitle } from "../storage/titles";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { recordingFeatures } from "./features";
import { BOS, encodeOggPage } from "./ogg";

export const MAX_RECORDING_DURATION_MS = 8 * 60 * 60 * 1000;
export const MAX_RECORDING_SAMPLES = BigInt(MAX_RECORDING_DURATION_MS) * 48n;
/** Shed browser audio first to reserve queue capacity for Discord audio. */
export const GUEST_BACKPRESSURE_BYTES = 8 * 1024 * 1024;

const OPUS_HEAD = Buffer.from([0x4f,0x70,0x75,0x73,0x48,0x65,0x61,0x64,1,2,0,15,0x80,0xbb,0,0,0,0,0]);
const OPUS_TAGS = Buffer.from([0x4f,0x70,0x75,0x73,0x54,0x61,0x67,0x73,9,0,0,0,0x6e,0x6f,0x64,0x65,0x2d,0x6f,0x70,0x75,0x73,0,0,0,0,0xff]);
interface Track { id: string; username: string; track: number; packet: number; pcmFile?:string; pcmSamples?:number; pcmStart?:number }

export class RecordingSession {
  title?:string;
  stopReason?: "duration-limit" | "empty-channel" | "low-disk";
  onDurationLimit?: () => Promise<void>;
  onDurationWarning?: (minutes:number) => Promise<void>;
  private warningTimers:NodeJS.Timeout[] = [];
  get maxDurationMs():number{return this.durationHours*60*60*1000;}
  get maxSamples():bigint{return BigInt(this.maxDurationMs)*48n;}
  cancelDurationTimers():void{clearTimeout(this.durationTimer);for(const timer of this.warningTimers)clearTimeout(timer);this.warningTimers=[];}
  private durationTimer?: NodeJS.Timeout;
  readonly id = randomUUID();
  endedAt?: string;
  readonly startedAt = new Date().toISOString();
  readonly tracks = new Map<string, Track>();
  readonly directory: string;
  voiceState: "connected" | "reconnecting" = "connected";
  state: "recording" | "completed" | "failed" = "recording";
  packetStats = { duplicatesDropped: 0, latePacketsDropped: 0 };
  guestFramesDropped = 0;
  audioOrigin?:number;
  packets = 0;
  notes = 0;
  private notePacket = 0;
  private start = process.hrtime.bigint();
  private files = new Map<string, FileHandle>();
  private queue: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private closing?: Promise<void>;
  private accepting = true;
  private failure?: Error;

  private constructor(root: string, readonly guildID: string, readonly channelID: string, readonly channelName?: string, readonly durationHours = DEFAULT_RECORDING_DURATION_HOURS) {
    this.directory = path.join(root, this.id);
  }

  static async create(root: string, guildID: string, channelID: string, channelName?: string, durationHours = DEFAULT_RECORDING_DURATION_HOURS): Promise<RecordingSession> {
    const session = new RecordingSession(root, guildID, channelID, channelName, validateRecordingDuration(durationHours));
    await mkdir(session.directory, { recursive: true });
    try {
      for (const name of ["header1", "header2", "data", "users", "notes"]) {
        session.files.set(name, await open(path.join(session.directory, name === "notes" ? "notes.jsonl" : `audio.ogg.${name}`), "wx"));
      }
      await session.write("users", Buffer.from('"0":{}\n'));
      await writeFile(path.join(session.directory, "audio.ogg.info"), JSON.stringify({
        format: 1, guild: guildID, channel: channelID,
        guildExtra: { id: guildID, name: guildID },
        channelExtra: { id: channelID, name: channelName ?? channelID, type: 2 },
        startTime: session.startedAt, features: recordingFeatures
      }, null, 2));
      await session.metadata();
      session.durationTimer = setTimeout(() => {
        session.stopReason = "duration-limit";
        void (session.onDurationLimit?.() ?? session.close()).catch(error => console.error("[Recording] Duration-limit finalization failed:", error));
      }, Math.max(0, session.maxDurationMs - Number(session.elapsedSamples()) / 48));
      session.durationTimer.unref();
      for(const minutes of DURATION_WARNING_MINUTES){
        const wait=session.maxDurationMs-minutes*60*1000-Number(session.elapsedSamples())/48;
        if(wait<=0)continue;
        const timer=setTimeout(()=>{if(session.accepting && !session.stopReason)void session.onDurationWarning?.(minutes).catch(error=>console.warn("[Recording] Duration warning failed:",error));},wait);
        timer.unref();session.warningTimers.push(timer);
      }
      return session;
    } catch (error) {
      await Promise.allSettled([...session.files.values()].map(file => file.close()));
      throw error;
    }
  }

  private async write(name: string, bytes: Buffer): Promise<void> {
    const file = this.files.get(name)!;
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, null);
      if (!bytesWritten) throw new Error("Storage write made no progress.");
      offset += bytesWritten;
    }
  }

  private async metadata(endedAt?: string): Promise<void> {
    const target = path.join(this.directory, "session.json");
    await writeFile(target + ".tmp", JSON.stringify({
      id: this.id, title:this.title, guildID: this.guildID, channelID: this.channelID, channelName: this.channelName,
      startedAt: this.startedAt, endedAt, state: this.state, packets: this.packets, notes: this.notes, audioOrigin: this.audioOrigin, packetStats: this.packetStats, guestFramesDropped: this.guestFramesDropped || undefined,
      durationHours:this.durationHours, diagnosticStopReason:this.stopReason==="duration-limit"?"max_duration":this.stopReason, error: this.failure?.message, stopReason: this.stopReason, tracks: [...this.tracks.values()].map(({ packet, ...track }) => track)
    }, null, 2));
    await rename(target + ".tmp", target);
  }

  setTitle(value:unknown):Promise<void>{
    const title=validateTitle(value);
    if(!this.accepting||this.failure)return Promise.reject(new Error("Session is closed."));
    const task=this.queue.then(async()=>{this.title=title;await this.metadata();});
    this.queue=task.catch(error=>{this.failure=error instanceof Error?error:new Error(String(error));});return task;
  }

  elapsedSamples(): bigint { return (process.hrtime.bigint() - this.start) * 48000n / 1000000000n; }

  append(data: Buffer, userID: string, username: string, timestamp = 0, arrival?: bigint, originalPCM?:Buffer): Promise<void> {
    if (!this.accepting || this.failure) return Promise.reject(this.failure ?? new Error("Session is closed."));
    // Guard every input path even if the deadline timer is delayed or a stop is queued.
    const capturedTime = arrival ?? this.elapsedSamples();
    if (capturedTime >= this.maxSamples) return Promise.resolve();
    if (!userID || !data.length) return Promise.resolve();
    if (originalPCM && this.pendingBytes > GUEST_BACKPRESSURE_BYTES) { this.guestFramesDropped++; return Promise.resolve(); }
    if (this.pendingBytes + data.length + (originalPCM?.length??0) > 16 * 1024 * 1024) {
      this.failure = new Error("Recording storage cannot keep up with incoming audio.");
      return Promise.reject(this.failure);
    }
    const packet = Buffer.from(data);
    const pcm=originalPCM?Buffer.from(originalPCM):undefined;
    // Craig reserves granule zero for headers; audio must begin at sample one or later.
    const time = capturedTime > 0n ? capturedTime : 1n;
    this.pendingBytes += packet.length+(pcm?.length??0);
    const task = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      let track = this.tracks.get(userID);
      if (!track) {
        track = { id: userID, username, track: this.tracks.size + 1, packet: 2 };
        this.tracks.set(userID, track);
        await this.write("header1", encodeOggPage(0, track.track, 0, OPUS_HEAD, BOS));
        await this.write("header2", encodeOggPage(0, track.track, 1, OPUS_TAGS));
        await this.write("users", Buffer.from(`,"${track.track}":${JSON.stringify({ id: userID, username, discriminator: "0" })}\n`));
      }
      this.audioOrigin ??= Number(time);
      if(pcm){
        if(pcm.length%4!==0)throw new Error("Invalid stereo PCM frame.");
        if(!track.pcmFile){track.pcmFile=`browser-track-${track.track}.pcm`;track.pcmStart=Number(time);track.pcmSamples=0;this.files.set(track.pcmFile,await open(path.join(this.directory,track.pcmFile),"wx"));}
        await this.write(track.pcmFile,pcm);track.pcmSamples!+=pcm.length/4;
      }
      // Craig stores arrival time and the original RTP timestamp in paired pages.
      await this.write("data", encodeOggPage(time, track.track, track.packet++, packet));
      await this.write("data", encodeOggPage(timestamp >>> 0, track.track, track.packet++, Buffer.alloc(0)));
      this.packets++;
    });
    this.queue = task.catch(error => { this.failure = error instanceof Error ? error : new Error(String(error)); })
      .finally(() => { this.pendingBytes -= packet.length+(pcm?.length??0); });
    return task;
  }

  note(text: string, authorID: string, atSamples?:bigint): Promise<void> {
    if (!this.accepting || this.failure) return Promise.reject(this.failure ?? new Error("Session is closed."));
    if (this.elapsedSamples() >= this.maxSamples || (atSamples !== undefined && atSamples >= this.maxSamples)) return Promise.reject(new Error(`The ${this.durationHours}-hour recording limit has been reached.`));
    if (!text.trim() || text.length > 2000) return Promise.reject(new Error("Notes must contain between 1 and 2000 characters."));
    const time = atSamples ?? this.elapsedSamples();
    const task = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      if (this.notePacket === 0) await this.write("header1", encodeOggPage(0,65536,this.notePacket++,Buffer.from("STREAMNOTE"),BOS));
      await this.write("data",encodeOggPage(time,65536,this.notePacket++,Buffer.from("NOTE"+text)));
      await this.write("notes",Buffer.from(JSON.stringify({ seconds: Number(time)/48000, text, authorID })+"\n"));
      this.notes++;
    });
    this.queue = task.catch(error => { this.failure = error instanceof Error ? error : new Error(String(error)); });
    return task;
  }

  close(error?: Error): Promise<void> {
    if (this.closing) return this.closing;
    this.accepting = false;
    this.cancelDurationTimers();
    this.closing = (async () => {
      await this.queue;
      if (error) this.failure ??= error;
      try {
        for (const file of this.files.values()) await file.sync();
      } catch (error) { this.failure ??= error as Error; }
      const results = await Promise.allSettled([...this.files.values()].map(file => file.close()));
      for (const result of results) if (result.status === "rejected") this.failure ??= result.reason;
      this.state = this.failure ? "failed" : "completed";
      this.endedAt=new Date().toISOString();
      await this.metadata(this.endedAt);
      if (this.failure) throw this.failure;
    })();
    return this.closing;
  }
}

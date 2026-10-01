// Craig split-file layout and Opus headers adapted from commit 60d1a00.
// See licenses/Craig-ISC.txt for copyright and permission notice.
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { recordingFeatures } from "./features";
import { BOS, encodeOggPage } from "./ogg";

const OPUS_HEAD = Buffer.from([0x4f,0x70,0x75,0x73,0x48,0x65,0x61,0x64,1,2,0,15,0x80,0xbb,0,0,0,0,0]);
const OPUS_TAGS = Buffer.from([0x4f,0x70,0x75,0x73,0x54,0x61,0x67,0x73,9,0,0,0,0x6e,0x6f,0x64,0x65,0x2d,0x6f,0x70,0x75,0x73,0,0,0,0,0xff]);
interface Track { id: string; username: string; track: number; packet: number }

export class RecordingSession {
  readonly id = randomUUID();
  readonly startedAt = new Date().toISOString();
  readonly tracks = new Map<string, Track>();
  readonly directory: string;
  state: "recording" | "completed" | "failed" = "recording";
  packets = 0;
  private start = process.hrtime.bigint();
  private files = new Map<string, FileHandle>();
  private queue: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private closing?: Promise<void>;
  private accepting = true;
  private failure?: Error;

  private constructor(root: string, readonly guildID: string, readonly channelID: string) {
    this.directory = path.join(root, this.id);
  }

  static async create(root: string, guildID: string, channelID: string): Promise<RecordingSession> {
    const session = new RecordingSession(root, guildID, channelID);
    await mkdir(session.directory, { recursive: true });
    try {
      for (const name of ["header1", "header2", "data", "users"]) {
        session.files.set(name, await open(path.join(session.directory, `audio.ogg.${name}`), "wx"));
      }
      await session.write("users", Buffer.from('"0":{}\n'));
      await writeFile(path.join(session.directory, "audio.ogg.info"), JSON.stringify({
        format: 1, guild: guildID, channel: channelID,
        guildExtra: { id: guildID, name: guildID },
        channelExtra: { id: channelID, name: channelID, type: 2 },
        startTime: session.startedAt, features: recordingFeatures
      }, null, 2));
      await session.metadata();
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
      id: this.id, guildID: this.guildID, channelID: this.channelID,
      startedAt: this.startedAt, endedAt, state: this.state, packets: this.packets,
      error: this.failure?.message, tracks: [...this.tracks.values()].map(({ packet, ...track }) => track)
    }, null, 2));
    await rename(target + ".tmp", target);
  }

  append(data: Buffer, userID: string, username: string, timestamp = 0): Promise<void> {
    if (!this.accepting || this.failure) return Promise.reject(this.failure ?? new Error("Session is closed."));
    if (!userID || !data.length) return Promise.resolve();
    if (this.pendingBytes + data.length > 16 * 1024 * 1024) {
      this.failure = new Error("Recording storage cannot keep up with incoming audio.");
      return Promise.reject(this.failure);
    }
    const packet = Buffer.from(data);
    const time = (process.hrtime.bigint() - this.start) * 48000n / 1000000000n;
    this.pendingBytes += packet.length;
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
      // Craig stores arrival time and the original RTP timestamp in paired pages.
      await this.write("data", encodeOggPage(time, track.track, track.packet++, packet));
      await this.write("data", encodeOggPage(timestamp >>> 0, track.track, track.packet++, Buffer.alloc(0)));
      this.packets++;
    });
    this.queue = task.catch(error => { this.failure = error instanceof Error ? error : new Error(String(error)); })
      .finally(() => { this.pendingBytes -= packet.length; });
    return task;
  }

  close(error?: Error): Promise<void> {
    if (this.closing) return this.closing;
    this.accepting = false;
    this.closing = (async () => {
      await this.queue;
      if (error) this.failure ??= error;
      try {
        for (const file of this.files.values()) await file.sync();
      } catch (error) { this.failure ??= error as Error; }
      const results = await Promise.allSettled([...this.files.values()].map(file => file.close()));
      for (const result of results) if (result.status === "rejected") this.failure ??= result.reason;
      this.state = this.failure ? "failed" : "completed";
      await this.metadata(new Date().toISOString());
      if (this.failure) throw this.failure;
    })();
    return this.closing;
  }
}

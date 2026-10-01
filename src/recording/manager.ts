import type Eris from "eris";
import { PacketBuffer, VoicePacket } from "./jitter";
import { RecordingSession } from "./session";

export class RecordingManager {
  readonly sessions = new Map<string, RecordingSession>();
  private cleanup = new Map<string, () => void>();
  private buffers = new Map<string, PacketBuffer>();
  private locks = new Map<string, Promise<unknown>>();
  private shuttingDown = false;
  constructor(private root: string) {}

  exclusive<T>(guildID: string, action: () => Promise<T>): Promise<T> {
    if (this.shuttingDown) return Promise.reject(new Error("The Witness is shutting down."));
    const previous = this.locks.get(guildID) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(action);
    this.locks.set(guildID, task);
    void task.finally(() => {
      if (this.locks.get(guildID) === task) this.locks.delete(guildID);
    }).catch(() => {});
    return task;
  }

  async start(guild: Eris.Guild, channelID: string, connection: Eris.VoiceConnection): Promise<RecordingSession> {
    const existing = this.sessions.get(guild.id);
    if (existing) {
      if (existing.channelID !== channelID) throw new Error("Stop the existing recording before changing channels.");
      return existing;
    }
    const session = await RecordingSession.create(this.root, guild.id, channelID);
    let receiver: ReturnType<Eris.VoiceConnection["receive"]>;
    try { receiver = connection.receive("opus"); }
    catch (error) {
      await session.close(error instanceof Error ? error : new Error(String(error))).catch(() => {});
      throw error;
    }
    const buffer = new PacketBuffer();
    this.buffers.set(guild.id,buffer);
    session.packetStats = buffer.stats;
    let failing = false;
    const fail = (error: Error) => {
      if (failing) return;
      failing = true;
      console.error("[Recording] Capture failed:",error);
      void this.exclusive(guild.id, () => this.stop(guild.id,error)).catch(error => console.error("[Recording] Finalization failed:",error));
    };
    const write = (packets: VoicePacket[]) => {
      for (const packet of packets) void session.append(packet.data,packet.userID,packet.username,packet.timestamp,packet.arrival).catch(fail);
    };
    const onData = (data: Buffer, userID: string, timestamp: number) => {
      if (!userID || failing) return;
      try { write(buffer.push({ data,userID,username:guild.members.get(userID)?.username ?? userID,timestamp,arrival:session.elapsedSamples() })); }
      catch (error) { fail(error as Error); }
    };
    const timer = setInterval(() => { if (!failing) write(buffer.flushAged(session.elapsedSamples())); },50);
    timer.unref();
    const onDisconnect = (error?: Error) => {
      void this.exclusive(guild.id, () => this.stop(guild.id, error ?? new Error("Voice connection disconnected.")))
        .catch(error => console.error("[Recording] Disconnected:", error));
    };
    this.sessions.set(guild.id, session);
    receiver.on("data", onData);
    connection.on("disconnect", onDisconnect);
    this.cleanup.set(guild.id, () => {
      clearInterval(timer);
      receiver.removeListener("data", onData);
      connection.removeListener("disconnect", onDisconnect);
    });
    return session;
  }

  async stop(guildID: string, error?: Error): Promise<RecordingSession | undefined> {
    const session = this.sessions.get(guildID);
    if (!session) return;
    this.cleanup.get(guildID)?.();
    this.cleanup.delete(guildID);
    const buffer = this.buffers.get(guildID);
    this.buffers.delete(guildID);
    let finalError = error;
    for (const packet of buffer?.flush() ?? []) {
      try { await session.append(packet.data,packet.userID,packet.username,packet.timestamp,packet.arrival); }
      catch (error) { finalError ??= error as Error; }
    }
    try { await session.close(finalError); }
    finally { this.sessions.delete(guildID); }
    return session;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    await Promise.allSettled([...this.locks.values()]);
    const results = await Promise.allSettled([...this.sessions.keys()].map(id => this.stop(id)));
    const errors = results.filter(result => result.status === "rejected");
    if (errors.length) throw new Error(`${errors.length} recording(s) failed to finalize.`);
  }
}

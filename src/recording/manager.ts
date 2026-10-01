import type Eris from "eris";
import { RecordingSession } from "./session";

export class RecordingManager {
  readonly sessions = new Map<string, RecordingSession>();
  private cleanup = new Map<string, () => void>();
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
    const receiver = connection.receive("opus");
    const onData = (data: Buffer, userID: string, timestamp: number) => {
      if (!userID) return;
      void session.append(data, userID, guild.members.get(userID)?.username ?? userID, timestamp).catch(error => {
        console.error("[Recording] Capture failed:", error);
        void this.exclusive(guild.id, () => this.stop(guild.id, error)).catch(error => console.error("[Recording] Finalization failed:", error));
      });
    };
    const onDisconnect = (error?: Error) => {
      void this.exclusive(guild.id, () => this.stop(guild.id, error ?? new Error("Voice connection disconnected.")))
        .catch(error => console.error("[Recording] Disconnected:", error));
    };
    this.sessions.set(guild.id, session);
    receiver.on("data", onData);
    connection.on("disconnect", onDisconnect);
    this.cleanup.set(guild.id, () => {
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
    try { await session.close(error); }
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

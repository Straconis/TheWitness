import {UserError} from "../errors";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
export const sessionIDPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface SavedSession { id: string; title?: string; guildID: string; channelID: string; channelName?: string; startedAt: string; state: string; tracks: Array<{ track: number; id: string; username: string }> }
export async function getSession(root: string, id: string, guildID: string): Promise<SavedSession> {
  if (!sessionIDPattern.test(id)) throw new UserError("Invalid session ID.");
  const session = JSON.parse(await readFile(path.join(root, id, "session.json"), "utf8")) as SavedSession;
  if (session.guildID !== guildID || session.id !== id) throw new UserError("Recording not found in this server.");
  return session;
}
export async function listSessions(root: string, guildID: string): Promise<SavedSession[]> {
  const sessions: SavedSession[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !sessionIDPattern.test(entry.name)) continue;
    try { sessions.push(await getSession(root, entry.name, guildID)); }
    catch (error) {
      // Other guilds and incomplete/corrupt metadata must not break the listing.
      if ((error as NodeJS.ErrnoException).code === "EACCES") throw error;
    }
  }
  return sessions.sort((a,b) => b.startedAt.localeCompare(a.startedAt));
}

import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Preserve raw audio after an unclean exit; never silently label it complete. */
export async function markInterruptedSessions(root: string): Promise<number> {
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const target = path.join(root, entry.name, "session.json");
    let contents: string;
    try { contents = await readFile(target, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let metadata;
    // One unreadable file must not stop the whole bot from starting.
    try { metadata = JSON.parse(contents); }
    catch (error) { console.warn(`[Recovery] Skipping unreadable session metadata in ${entry.name}.`, error); continue; }
    if (!metadata || typeof metadata !== "object" || metadata.state !== "recording") continue;
    metadata.state = "interrupted";
    metadata.recoveredAt = new Date().toISOString();
    await writeFile(target + ".tmp", JSON.stringify(metadata, null, 2));
    await rename(target + ".tmp", target);
    count++;
  }
  return count;
}

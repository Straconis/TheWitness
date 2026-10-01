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
    const metadata = JSON.parse(contents);
    if (metadata.state !== "recording") continue;
    metadata.state = "interrupted";
    metadata.recoveredAt = new Date().toISOString();
    await writeFile(target + ".tmp", JSON.stringify(metadata, null, 2));
    await rename(target + ".tmp", target);
    count++;
  }
  return count;
}

import { DownloadService } from "./downloads/service";
import { mkdir } from "node:fs/promises";

import { markInterruptedSessions } from "./recording/recovery";
import { config } from "./config";
import { createDiscordClient, recordings, settingsStore } from "./discord/client";

async function main(): Promise<void> {
  console.log("The Witness v0.1.0");
  console.log("==================");

  await mkdir(config.recordingPath, {
    recursive: true
  });

  await settingsStore.load();

  const interrupted = await markInterruptedSessions(config.recordingPath);
  if (interrupted) console.warn(`[Recovery] Preserved ${interrupted} interrupted session(s).`);

  console.log(`[Storage] Recordings: ${config.recordingPath}`);

  const downloads = config.downloadPort
    ? await DownloadService.create(config.recordingPath, config.downloadPublicURL!) : undefined;
  if (downloads) await downloads.listen(config.downloadPort!);
  const client = createDiscordClient(downloads);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { await recordings.shutdown(); }
    catch (error) { console.error("[Shutdown]", error); process.exitCode = 1; }
    finally { client.disconnect({ reconnect: false }); await downloads?.close(); }
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });

  console.log("[Discord] Connecting...");
  try { await client.connect(); }
  catch (error) { await shutdown(); throw error; }
}

main().catch((error) => {
  console.error("[Fatal]", error);
  process.exitCode = 1;
});

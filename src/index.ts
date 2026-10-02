import { RetentionRunner } from "./automation/retention";
import { ExportQueue } from "./exports/jobs";
import { DownloadService } from "./downloads/service";
import { mkdir } from "node:fs/promises";

import { markInterruptedSessions } from "./recording/recovery";
import { config } from "./config";
import { createDiscordClient, recordings, settingsStore, storageMonitor, closeRecordingPanels } from "./discord/client";

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

  await storageMonitor.start().catch(error=>console.warn("[Storage] Disk-space check unavailable.",error));
  const exportQueue = new ExportQueue(config.recordingPath);
  await exportQueue.load();
  const retention=new RetentionRunner(config.recordingPath,settingsStore,recordings,exportQueue);retention.start();
  const downloads = config.downloadPort
    ? await DownloadService.create(config.recordingPath, config.downloadPublicURL!) : undefined;
  if (downloads) { downloads.attach(exportQueue,settingsStore,recordings,storageMonitor); await downloads.listen(config.downloadPort!,config.downloadHost); }
  const client = createDiscordClient(downloads,exportQueue);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    storageMonitor.close();
    try { await retention.close(); await closeRecordingPanels(); await recordings.shutdown(); await exportQueue.close(); }
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

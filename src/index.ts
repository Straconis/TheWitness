import {ServerAccessStore} from "./storage/server-access";
import {BotStatusStore} from "./discord/bot-status";
import path from "node:path";
import { transcriptionReadyAsync } from "./integrations/transcription-config";
import { backupMode } from "./exports/soundcraft-backup";
import {initializeStartSound} from "./exports/start-sound";
import {cleanTransientArtifacts} from "./exports/storage";
import {shutdownInOrder,introShutdownStages} from "./shutdown";
import { RetentionRunner } from "./automation/retention";
import { ExportQueue } from "./exports/jobs";
import { DownloadService } from "./downloads/service";
import { mkdir } from "node:fs/promises";

import { markInterruptedSessions } from "./recording/recovery";
import { config } from "./config";
import { createDiscordClient, recordings, settingsStore, storageMonitor, closeAutomation, closePanels,setStorageExportQueue } from "./discord/client";

async function main(): Promise<void> {
  console.log(`The Witness v${require("../package.json").version}`);
  console.log("==================");

  await mkdir(config.recordingPath, {
    recursive: true
  });

  await settingsStore.load();
  const serverAccess=new ServerAccessStore(path.join(config.recordingPath,"server-access.json"));await serverAccess.load();
  recordings.setServerAccess(serverAccess);
  // Probe whisper-cli in the background so pages and export checks read a cached answer instead of waiting for it.
  void transcriptionReadyAsync();
  await initializeStartSound();

  await cleanTransientArtifacts(config.recordingPath).catch(error=>console.warn("[Storage] Startup temporary cleanup deferred.",error));
  const exportQueue = new ExportQueue(config.recordingPath,undefined,async()=>(await storageMonitor.check()).critical,undefined,()=>storageMonitor.check(),()=>new Set(settingsStore.all().map(([,settings])=>[settings.startSound?.customID,settings.endSound?.customID]).flat().filter((id):id is string=>!!id)));
  exportQueue.setServerAccess(serverAccess);
  exportQueue.setSoundcraftBackupPolicy(guildID=>backupMode(settingsStore.get(guildID)));
  setStorageExportQueue(exportQueue);
  // Cleanup may reclaim space needed to persist recovery metadata, before workers start.
  await exportQueue.load(false);
  const interrupted = await markInterruptedSessions(config.recordingPath);
  if (interrupted) console.warn(`[Recovery] Preserved ${interrupted} interrupted session(s).`);
  console.log(`[Storage] Recordings: ${config.recordingPath}`);
  await storageMonitor.start().catch(error=>console.warn("[Storage] Disk-space check unavailable.",error));
  exportQueue.start();
  const retention=new RetentionRunner(config.recordingPath,settingsStore,recordings,exportQueue);retention.start();
  const downloads = config.downloadPort
    ? await DownloadService.create(config.recordingPath, config.downloadPublicURL!) : undefined;
  if (downloads) { downloads.attach(exportQueue,settingsStore,recordings,storageMonitor); await downloads.listen(config.downloadPort!,config.downloadHost); }
  const botStatus=new BotStatusStore(path.join(config.recordingPath,"bot-status.json"));
  await botStatus.load();
  const client = createDiscordClient(downloads,exportQueue,botStatus,serverAccess);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    storageMonitor.close();
    await shutdownInOrder([
      {name:"retention",close:()=>retention.close()},
      {name:"automation",close:()=>closeAutomation()},
      {name:"recordings",close:()=>recordings.shutdown()},
      {name:"panels",close:()=>closePanels()},
      {name:"exports",close:()=>exportQueue.close()},
      {name:"Discord",close:()=>client.disconnect({reconnect:false})},
      {name:"downloads",close:()=>downloads?.close()},
      ...introShutdownStages(exportQueue)
    ],(name,error)=>{console.error(`[Shutdown] ${name}:`,error);process.exitCode=1;});
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

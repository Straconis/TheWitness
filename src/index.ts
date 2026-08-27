import { mkdir } from "node:fs/promises";

import { config } from "./config";
import { createDiscordClient } from "./discord/client";

async function main(): Promise<void> {
  console.log("The Witness v0.1.0");
  console.log("==================");

  await mkdir(config.recordingPath, {
    recursive: true
  });

  console.log(`[Storage] Recordings: ${config.recordingPath}`);

  const client = createDiscordClient();

  console.log("[Discord] Connecting...");
  await client.connect();
}

main().catch((error) => {
  console.error("[Fatal]", error);
  process.exitCode = 1;
});

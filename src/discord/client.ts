import Eris from "eris";

import { config } from "../config";

export function createDiscordClient(): Eris.Client {
  const client = new Eris.Client(config.discordToken, {
    intents: [
      "guilds",
      "guildVoiceStates"
    ]
  });

  client.on("ready", () => {
    console.log(
      `[Discord] Logged in as ${client.user.username} (${client.user.id})`
    );
  });

  client.on("error", (error) => {
    console.error("[Discord] Error:", error);
  });

  return client;
}

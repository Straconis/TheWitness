import Eris from "eris";

import { config } from "../config";

interface GuildSettings {
  autoJoin: boolean;
  autoRecord: boolean;
}

const activeVoiceChannels = new Map<string, string>();
const guildSettings = new Map<string, GuildSettings>();

function getSettings(guildID: string): GuildSettings {
  let settings = guildSettings.get(guildID);

  if (!settings) {
    settings = {
      autoJoin: false,
      autoRecord: false
    };

    guildSettings.set(guildID, settings);
  }

  return settings;
}

async function registerCommands(client: Eris.Client): Promise<void> {
  for (const guild of client.guilds.values()) {
    await client.bulkEditGuildCommands(guild.id, [
      {
        type: 1,
        name: "record",
        description: "Join your voice channel and begin recording."
      },
      {
        type: 1,
        name: "stop",
        description: "Stop recording and leave the voice channel."
      },
      {
        type: 1,
        name: "status",
        description: "Show The Witness status."
      },
      {
        type: 1,
        name: "help",
        description: "Show The Witness commands and recording help."
      },
      {
        type: 1,
        name: "autojoin",
        description: "Configure automatic voice-channel joining.",
        options: [
          {
            type: 3,
            name: "mode",
            description: "Enable, disable, or show status.",
            required: true,
            choices: [
              { name: "Enable", value: "enable" },
              { name: "Disable", value: "disable" },
              { name: "Status", value: "status" }
            ]
          }
        ]
      },
      {
        type: 1,
        name: "autorecord",
        description: "Configure automatic recording.",
        options: [
          {
            type: 3,
            name: "mode",
            description: "Enable, disable, or show status.",
            required: true,
            choices: [
              { name: "Enable", value: "enable" },
              { name: "Disable", value: "disable" },
              { name: "Status", value: "status" }
            ]
          }
        ]
      }
    ]);

    console.log(
      `[Discord] Registered commands in ${guild.name} (${guild.id})`
    );
  }
}

async function joinVoiceChannel(
  guild: Eris.Guild,
  channelID: string
): Promise<void> {
  const currentChannelID = activeVoiceChannels.get(guild.id);

  if (currentChannelID === channelID) {
    return;
  }

  if (currentChannelID) {
    const oldChannel = guild.channels.get(currentChannelID);

    if (oldChannel && "leave" in oldChannel) {
      (oldChannel as any).leave();
    }
  }

  const channel = guild.channels.get(channelID);

  if (!channel || !("join" in channel)) {
    throw new Error(`Voice channel ${channelID} cannot be joined.`);
  }

  await (channel as any).join({
    opusOnly: true
  });

  activeVoiceChannels.set(guild.id, channelID);

  console.log(
    `[Voice] Joined ${channel.name} (${channelID}) in ${guild.name}`
  );
}

function leaveVoiceChannel(guild: Eris.Guild): boolean {
  const channelID = activeVoiceChannels.get(guild.id);

  if (!channelID) {
    return false;
  }

  const channel = guild.channels.get(channelID);

  if (channel && "leave" in channel) {
    (channel as any).leave();
  }

  activeVoiceChannels.delete(guild.id);

  console.log(`[Voice] Left ${channelID} in ${guild.name}`);

  return true;
}

export function createDiscordClient(): Eris.Client {
  const client = new Eris.Client(config.discordToken, {
    gateway: { intents: ["guilds", "guildVoiceStates"] }
  });

  client.on("ready", async () => {
    console.log(
      `[Discord] Logged in as ${client.user.username} (${client.user.id})`
    );

    try {
      await registerCommands(client);
    } catch (error) {
      console.error("[Discord] Failed to register commands:", error);
    }
  });

  client.on("voiceChannelJoin", async (member, channel) => {
    if (member.id === client.user.id) {
      return;
    }

    const guild = channel.guild;
    const settings = getSettings(guild.id);

    if (!settings.autoJoin) {
      return;
    }

    if (activeVoiceChannels.has(guild.id)) {
      return;
    }

    try {
      console.log(
        `[AutoJoin] ${member.username} entered ${channel.name}`
      );

      await joinVoiceChannel(guild, channel.id);

      if (settings.autoRecord) {
        console.log(
          `[AutoRecord] Recording requested in ${channel.name}`
        );
      }
    } catch (error) {
      console.error("[AutoJoin] Failed:", error);
    }
  });

  client.on("interactionCreate", async (interaction: any) => {
    if (interaction.type !== 2) {
      return;
    }

    const commandName = interaction.data?.name;
    const guildID = interaction.guildID;

    if (commandName === "help") {
      await interaction.createMessage({
        content:
          "## The Witness\n" +
          "Private multitrack Discord voice recording.\n\n" +
          "### Recording\n" +
          "**`/record`** - Join your voice channel and begin recording.\n" +
          "**`/stop`** - Stop recording and leave voice.\n" +
          "**`/status`** - Show current status.\n\n" +
          "### Automation\n" +
          "**`/autojoin enable|disable|status`** - Automatically join voice.\n" +
          "**`/autorecord enable|disable|status`** - Automatically begin recording.\n\n" +
          "**`/help`** - Show this message.\n\n" +
          "*The Witness remembers.*"
      });

      return;
    }

    if (!guildID) {
      await interaction.createMessage({
        content: "The Witness can only be used inside a server.",
        flags: 64
      });
      return;
    }

    const guild = client.guilds.get(guildID);

    if (!guild) {
      await interaction.createMessage({
        content: "I could not resolve this server.",
        flags: 64
      });
      return;
    }

    const settings = getSettings(guildID);

    if (commandName === "status") {
      const voiceChannelID = activeVoiceChannels.get(guildID);

      await interaction.createMessage({
        content:
          "## The Witness Status\n" +
          `**Voice:** ${
            voiceChannelID ? `<#${voiceChannelID}>` : "Not connected"
          }\n` +
          `**Auto Join:** ${settings.autoJoin ? "Enabled" : "Disabled"}\n` +
          `**Auto Record:** ${settings.autoRecord ? "Enabled" : "Disabled"}\n` +
          "**Recording:** Engine not connected yet"
      });

      return;
    }

    if (commandName === "autojoin") {
      const mode = interaction.data?.options?.[0]?.value;

      if (mode === "enable") {
        settings.autoJoin = true;

        await interaction.createMessage({
          content: "**Auto Join enabled.**"
        });
      } else if (mode === "disable") {
        settings.autoJoin = false;

        await interaction.createMessage({
          content: "**Auto Join disabled.**"
        });
      } else {
        await interaction.createMessage({
          content:
            `**Auto Join:** ${settings.autoJoin ? "Enabled" : "Disabled"}`
        });
      }

      return;
    }

    if (commandName === "autorecord") {
      const mode = interaction.data?.options?.[0]?.value;

      if (mode === "enable") {
        settings.autoRecord = true;
        settings.autoJoin = true;

        await interaction.createMessage({
          content:
            "**Auto Record enabled.**\n" +
            "Auto Join was also enabled."
        });
      } else if (mode === "disable") {
        settings.autoRecord = false;

        await interaction.createMessage({
          content: "**Auto Record disabled.**"
        });
      } else {
        await interaction.createMessage({
          content:
            `**Auto Record:** ${settings.autoRecord ? "Enabled" : "Disabled"}`
        });
      }

      return;
    }

    if (commandName === "record") {
      const memberID = interaction.member?.id;

      const member = memberID
        ? guild.members.get(memberID)
        : undefined;

      const voiceChannelID = member?.voiceState.channelID;

      if (!voiceChannelID) {
        await interaction.createMessage({
          content: "You need to be in a voice channel first.",
          flags: 64
        });
        return;
      }

      try {
        await joinVoiceChannel(guild, voiceChannelID);

        await interaction.createMessage({
          content:
            "**The Witness is listening.**\n" +
            `Voice channel: <#${voiceChannelID}>`
        });
      } catch (error) {
        console.error("[Voice] Failed to join:", error);

        await interaction.createMessage({
          content: "I could not connect to your voice channel.",
          flags: 64
        });
      }

      return;
    }

    if (commandName === "stop") {
      if (!leaveVoiceChannel(guild)) {
        await interaction.createMessage({
          content: "The Witness is not currently listening.",
          flags: 64
        });
        return;
      }

      await interaction.createMessage({
        content: "**The Witness has stopped listening.**"
      });
    }
  });

  client.on("error", (error) => {
    console.error("[Discord] Error:", error);
  });

  return client;
}



import Eris from "eris";

import { config } from "../config";
import { RecordingManager } from "../recording/manager";

export const recordings = new RecordingManager(config.recordingPath);

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
  client: Eris.Client, guild: Eris.Guild, channelID: string
): Promise<Eris.VoiceConnection> {
  const session = recordings.sessions.get(guild.id);
  if (session && session.channelID !== channelID) {
    throw new Error("Stop the existing recording before changing channels.");
  }
  const connection = await client.joinVoiceChannel(channelID, {
    opusOnly: true, selfDeaf: false, selfMute: false
  });
  activeVoiceChannels.set(guild.id, channelID);
  return connection;
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
    if (member.bot || member.id === client.user.id) {
      return;
    }

    const guild = channel.guild;
    const settings = getSettings(guild.id);

    if (!settings.autoJoin) {
      return;
    }

    if (client.voiceConnections.has(guild.id)) {
      return;
    }

    try {
      console.log(
        `[AutoJoin] ${member.username} entered ${channel.name}`
      );

      await recordings.exclusive(guild.id, async () => {
        if (client.voiceConnections.has(guild.id)) return;
        const connection = await joinVoiceChannel(client, guild, channel.id);
        if (settings.autoRecord) {
          const session = await recordings.start(guild, channel.id, connection);
          console.log(`[AutoRecord] Started session ${session.id}`);
        }
      });
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
      const voiceChannelID = client.voiceConnections.get(guildID)?.channelID;
      const session = recordings.sessions.get(guildID);

      await interaction.createMessage({
        content:
          "## The Witness Status\n" +
          `**Voice:** ${
            voiceChannelID ? `<#${voiceChannelID}>` : "Not connected"
          }\n` +
          `**Auto Join:** ${settings.autoJoin ? "Enabled" : "Disabled"}\n` +
          `**Auto Record:** ${settings.autoRecord ? "Enabled" : "Disabled"}\n` +
          `**Recording:** ${session ? `Active (${session.id}) — ${session.tracks.size} tracks, ${session.packets} packets saved` : "Inactive"}`
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

      await interaction.defer();
      try {
        const session = await recordings.exclusive(guildID, async () => {
          const connection = await joinVoiceChannel(client, guild, voiceChannelID);
          return recordings.start(guild, voiceChannelID, connection);
        });
        await interaction.editOriginalMessage({
          content: `**The Witness is recording.**\nVoice channel: <#${voiceChannelID}>\nSession: ${session.id}`
        });
      } catch (error) {
        console.error("[Recording] Failed to start:", error);
        await interaction.editOriginalMessage({
          content: "Recording could not start. Check the bot logs; if another channel is recording, stop it first."
        });
      }

      return;
    }

    if (commandName === "stop") {
      await interaction.defer();
      try {
        const session = await recordings.exclusive(guildID, async () => {
          try { return await recordings.stop(guildID); }
          finally { leaveVoiceChannel(guild); }
        });
        await interaction.editOriginalMessage({
          content: session
            ? `**Recording saved.**\nSession: ${session.id}\nTracks: ${session.tracks.size}; audio packets: ${session.packets}.`
            : "The Witness is not recording. Voice connection closed."
        });
      } catch (error) {
        console.error("[Recording] Failed to stop:", error);
        await interaction.editOriginalMessage({ content: "Recording stopped with a storage error. Check the bot logs before using the session files." });
      }
    }
  });

  client.on("error", (error) => {
    console.error("[Discord] Error:", error);
  });

  return client;
}



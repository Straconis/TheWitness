import Eris from "eris";
import { StorageMonitor } from "../storage/space";
import { renameSession,validateTitle } from "../storage/titles";
import { downloadName } from "../downloads/names";
import { deleteSession } from "../storage/delete";
import { ExportQueue } from "../exports/jobs";
import { recoverSession } from "../recording/salvage";
import type { DownloadService } from "../downloads/service";
import path from "node:path";
import { SettingsStore } from "../storage/settings";
import { getSession, listSessions } from "../storage/sessions";
import { exportSession, ExportFormat } from "../exports/export";
import { archiveExport } from "../exports/archive";

import { config } from "../config";
import { RecordingManager } from "../recording/manager";

export const storageMonitor=new StorageMonitor(config.recordingPath,config.lowDiskWarningBytes);
export const recordings = new RecordingManager(config.recordingPath);

export const settingsStore = new SettingsStore(path.join(config.recordingPath, "settings.json"));
const activeVoiceChannels = new Map<string, string>();
const getSettings = (guildID: string) => settingsStore.get(guildID);
const exportJobs = new Set<string>();

async function registerCommands(client: Eris.Client): Promise<void> {
  for (const guild of client.guilds.values()) {
    await client.bulkEditGuildCommands(guild.id, [
      {type:1,name:"title",description:"Name the active recording or a saved session.",options:[{type:3,name:"text",description:"Recording title",required:true,max_length:120},{type:3,name:"session",description:"Saved session ID (omit for the active recording)"}]},
      {type:1,name:"downloadnames",description:"Choose recording date/time or original download filenames.",options:[{type:3,name:"style",description:"Naming style",required:true,choices:[{name:"Recording date/time (UTC)",value:"date"},{name:"Original filenames",value:"original"}]}]},
      { type:1,name:"delete",description:"Permanently delete a saved recording and its exports.",options:[{type:3,name:"session",description:"Session ID to delete",required:true},{type:5,name:"confirm",description:"Confirm permanent deletion",required:true}] },
      { type:1,name:"webapp",description:"Get a private browser microphone link for the current recording." },
      { type:1,name:"dashboard",description:"Open the private recording dashboard for this server." },
      { type: 1, name: "recover", description: "Recover saved audio from an interrupted recording.", options: [{ type: 3, name: "session", description: "Interrupted session ID", required: true }] },
      { type: 1, name: "note", description: "Add a timestamped note to the current recording.", options: [{ type: 3, name: "text", description: "Your session note", required: true, max_length: 2000 }] },
      { type: 1, name: "recordings", description: "List the latest recordings in this server." },
      { type: 1, name: "export", description: "Download a completed recording as separate speaker tracks.", options: [
        { type: 3, name: "session", description: "Session ID from /recordings", required: true },
        { type: 3, name: "format", description: "Project or audio format", choices: ["audition","ogg","wav","flac","mp3"].map(value => ({ name: value==="audition"?"Adobe Audition project (ZIP)":value.toUpperCase(), value })) },
        { type: 5, name: "mix", description: "Also include mixed session audio" },
        { type: 5, name: "transcribe", description: "Create transcripts using your configured local model" },
        { type: 3, name: "upload", description: "Upload to your configured cloud account", choices:["dropbox","google","onedrive","box"].map(value=>({name:value,value})) }
      ] },
      {
        type: 1,
        name: "record",
        description: "Join your voice channel and begin recording.",
        options:[{type:3,name:"title",description:"Optional recording title",max_length:120}]
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

export function createDiscordClient(downloads?: DownloadService, exportQueue?: ExportQueue): Eris.Client {
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
          const session = await recordings.start(guild, channel.id, connection, () => client.joinVoiceChannel(channel.id, {opusOnly:true,selfDeaf:false}));
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

    try {
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
          "**`/status`** - Show current status.\n" +
          "**`/note`** - Add a timestamped session note.\n" +
          "**`/recordings`** - List saved sessions.\n" +
          "**`/export`** - Download completed speaker tracks.\n\n" +
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

    if(commandName==="title"){
      const options=interaction.data?.options??[],text=validateTitle(options.find((option:any)=>option.name==="text")?.value),id=options.find((option:any)=>option.name==="session")?.value;
      await interaction.defer(64);await recordings.exclusive(guildID,async()=>{const active=recordings.sessions.get(guildID);if(active&&(!id||active.id===id))await active.setTitle(text);else if(id)await renameSession(config.recordingPath,id,guildID,text);else throw new Error("Start a recording or provide a saved session ID.");});
      await interaction.editOriginalMessage({content:`Recording title saved: ${text}`,allowedMentions:{parse:[]}});return;
    }
    if(commandName==="downloadnames"){
      const style=interaction.data?.options?.find((option:any)=>option.name==="style")?.value;
      if(!["date","original"].includes(style))throw new Error("Invalid naming style.");
      await interaction.defer(64);await settingsStore.update(guildID,{downloadNaming:style});
      await interaction.editOriginalMessage({content:`Download names now use ${style==="date"?"the recording start date/time (UTC)":"original filenames"}. You can also switch styles on each download page.`});return;
    }
    if(commandName==="delete"){
      const options=interaction.data?.options??[],id=options.find((option:any)=>option.name==="session")?.value;
      if(options.find((option:any)=>option.name==="confirm")?.value!==true){await interaction.createMessage({content:"Set confirm:true to permanently delete this session and its exports.",flags:64});return;}
      if(!interaction.member?.permissions?.has("manageGuild")){await interaction.createMessage({content:"Manage Server permission is required to delete recordings.",flags:64});return;}
      await interaction.defer(64);
      if(exportQueue?.busy(id))throw new Error("Wait for this recording's export to finish before deleting it.");
      await recordings.exclusive(guildID,()=>deleteSession(config.recordingPath,id,guildID));
      await interaction.editOriginalMessage({content:"Recording and exports permanently deleted."});return;
    }
    if (commandName === "webapp" || commandName === "dashboard") {
      if(!downloads) {await interaction.createMessage({content:"Configure the public download service to enable browser access.",flags:64});return;}
      const session=recordings.sessions.get(guildID);
      if(commandName==="webapp"&&!session){await interaction.createMessage({content:"Start a recording before connecting a browser microphone.",flags:64});return;}
      const link=commandName==="webapp"?downloads.browserLink(session!.id):downloads.dashboardLink(guildID);
      await interaction.createMessage({content:`[Open ${commandName==="webapp"?"browser recording":"your dashboard"}](${link})\nThis private link expires in 24 hours.`,flags:64});return;
    }
    if (commandName === "recover") {
      await interaction.defer(64);
      const sourceID = interaction.data?.options?.find((option: any) => option.name === "session")?.value;
      const id = await recordings.exclusive(guildID, () => recoverSession(config.recordingPath,sourceID,guildID));
      await interaction.editOriginalMessage({ content: `Recovered saved audio into session \`${id}\`. The original files were preserved. You can export the recovered session.` });
      return;
    }
    if (commandName === "note") {
      await interaction.defer(64);
      const text = interaction.data?.options?.find((option: any) => option.name === "text")?.value;
      const result = await recordings.exclusive(guildID, async () => {
        const session = recordings.sessions.get(guildID);
        if (!session) return false;
        await session.note(text, interaction.member?.id ?? "unknown");
        return true;
      });
      await interaction.editOriginalMessage({ content: result ? "Note saved at the current recording timestamp." : "Start a recording before adding a note." });
      return;
    }
    if (commandName === "recordings") {
      await interaction.defer(64);
      try {
        const sessions = (await listSessions(config.recordingPath, guildID)).slice(0, 10);
        await interaction.editOriginalMessage({ content: sessions.length
          ? "**Recent recordings**\n" + sessions.map(session => `\`${session.id}\` — ${session.title?session.title+" — ":""}${session.state}, ${session.tracks.length} tracks\n${session.startedAt}`).join("\n")
          : "No saved recordings in this server yet." });
      } catch (error) {
        console.error("[Recordings]", error);
        await interaction.editOriginalMessage({ content: "Could not load recordings." });
      }
      return;
    }
    if (commandName === "export") {
      await interaction.defer(64);
      if (exportJobs.size) {
        await interaction.editOriginalMessage({ content: "An export is already processing. Please try again when it finishes." });
        return;
      }
      exportJobs.add(guildID);
      try {
        const options = interaction.data?.options ?? [];
        const id = options.find((option: any) => option.name === "session")?.value;
        const format = (options.find((option: any) => option.name === "format")?.value ?? "audition") as ExportFormat;
        const sourceSession=await getSession(config.recordingPath, id, guildID);
        const mix = options.find((option: any) => option.name === "mix")?.value === true;
        if(downloads&&exportQueue){
          const transcribe=options.find((option:any)=>option.name==="transcribe")?.value===true;
          const upload=options.find((option:any)=>option.name==="upload")?.value;
          const job=await exportQueue.enqueue(id,guildID,format,mix,{transcribe,upload});
          await interaction.editOriginalMessage({content:`Your export is queued.\n[Open export status](${downloads.jobLink(job.id)})`});return;
        }
        if(options.find((option:any)=>option.name==="transcribe")?.value===true||options.find((option:any)=>option.name==="upload")?.value){
          await interaction.editOriginalMessage({content:"Enable the download service to use queued transcription or cloud uploads."});return;
        }
        const directory = await exportSession(config.recordingPath, id, { format, mix });
        if (downloads) {
          const link = downloads.link(id, path.basename(directory));
          await interaction.editOriginalMessage({ content: `Your speaker tracks are ready.\n[Open private downloads](${link})\nThis link expires in 24 hours. Share it only with your group.` });
          return;
        }
        const archive = await archiveExport(directory, 8 * 1024 * 1024);
        await interaction.editOriginalMessage({ content: "Your speaker tracks and participant manifest are ready.", attachments: [{ file: archive, filename: downloadName(`witness-${settings.downloadNaming==="original"?id:format}.zip`,{startedAt:sourceSession.startedAt,title:sourceSession.title},settings.downloadNaming??"date") }] });
      } catch (error) {
        console.error("[Export]", error);
        await interaction.editOriginalMessage({ content: error instanceof Error && error.message.startsWith("Export is too large")
          ? "This export is too large to attach in Discord. It is saved on the host; enable the download service to retrieve large recordings."
          : "Could not export this recording. Choose a completed session from this server and check the bot logs if the problem continues." });
      } finally { exportJobs.delete(guildID); }
      return;
    }

    if (commandName === "status") {
      const disk=await storageMonitor.check().catch(()=>undefined);
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
          `**Disk space:** ${disk?`${(disk.availableBytes/1024**3).toFixed(2)} GiB available${disk.low?" — LOW SPACE":""}`:"Unavailable"}\n` +
          `**Title:** ${session?.title??"Untitled"}\n` +
          `**Recording:** ${session ? `${session.voiceState === "reconnecting" ? "Reconnecting" : "Active"} (${session.id}) — ${session.tracks.size} tracks, ${session.packets} packets saved` : "Inactive"}`
      });

      return;
    }

    if (commandName === "autojoin") {
      const mode = interaction.data?.options?.[0]?.value;

      if (mode === "enable") {
        await settingsStore.update(guildID, { autoJoin: true });

        await interaction.createMessage({
          content: "**Auto Join enabled.**"
        });
      } else if (mode === "disable") {
        await settingsStore.update(guildID, { autoJoin: false, autoRecord: false });

        await interaction.createMessage({
          content: "**Auto Join and Auto Record disabled.**"
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
        await settingsStore.update(guildID, { autoRecord: true, autoJoin: true });

        await interaction.createMessage({
          content:
            "**Auto Record enabled.**\n" +
            "Auto Join was also enabled."
        });
      } else if (mode === "disable") {
        await settingsStore.update(guildID, { autoRecord: false });

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

      const proposedTitle=interaction.data?.options?.find((option:any)=>option.name==="title")?.value;
      const title=proposedTitle===undefined?undefined:validateTitle(proposedTitle);
      await interaction.defer();
      try {
        const session = await recordings.exclusive(guildID, async () => {
          const connection = await joinVoiceChannel(client, guild, voiceChannelID);
          const session=await recordings.start(guild, voiceChannelID, connection, () => client.joinVoiceChannel(voiceChannelID, {opusOnly:true,selfDeaf:false}));
          if(title)await session.setTitle(title);return session;
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
      recordings.cancelReconnect(guildID);
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
    } catch (error) {
      console.error("[Command]", error);
      try {
        if (interaction.acknowledged) await interaction.editOriginalMessage({ content: "The command failed. Check the bot logs and try again." });
        else await interaction.createMessage({ content: "The command failed. Check the bot logs and try again.", flags: 64 });
      } catch (responseError) { console.error("[Command] Could not send error response:", responseError); }
    }
  });

  client.on("error", (error) => {
    console.error("[Discord] Error:", error);
  });

  return client;
}



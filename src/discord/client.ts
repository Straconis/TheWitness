import { helpMessage,helpTopics } from "./help";
import { ScheduleRunner,newSchedule } from "../automation/schedules";
import Eris from "eris";
import { EventRecording } from "./event-recording";
import { mayUseBot } from "./access";
import { RecordingPanels,panelBody } from "./panel";
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
let recordingPanels:RecordingPanels|undefined;
let scheduleRunner:ScheduleRunner|undefined;
export async function closeRecordingPanels():Promise<void>{await scheduleRunner?.close();await recordingPanels?.close();}
const exportJobs = new Set<string>();

async function registerCommands(client: Eris.Client): Promise<void> {
  for (const guild of client.guilds.values()) {
    await client.bulkEditGuildCommands(guild.id, [
      {type:1,name:"schedule",description:"Opt into recurring recording (Manage Server required).",options:[{type:3,name:"action",description:"Schedule action",required:true,choices:[{name:"Add",value:"add"},{name:"Remove",value:"remove"},{name:"List",value:"list"}]},{type:7,name:"channel",description:"Voice channel",channel_types:[2]},{type:3,name:"time",description:"Start HH:MM in the selected time zone"},{type:3,name:"days",description:"Weekdays as numbers: 0=Sun, 1=Mon, … 6=Sat (comma-separated)"},{type:3,name:"timezone",description:"IANA time zone, e.g. America/New_York (default UTC)"},{type:4,name:"minutes",description:"Recording duration in minutes",min_value:1,max_value:1440},{type:3,name:"title",description:"Recording title",max_length:120},{type:3,name:"id",description:"Schedule ID to remove"}]},
      {type:1,name:"retention",description:"Opt into deleting old completed recordings (Manage Server required).",options:[{type:4,name:"days",description:"Keep completed recordings this many days; 0 disables cleanup",required:true,min_value:0,max_value:3650},{type:5,name:"confirm",description:"Confirm automatic permanent deletion"}]},
      {type:1,name:"channelrules",description:"Limit automatic joining to selected channels (Manage Server required).",options:[{type:3,name:"mode",description:"Channel policy",required:true,choices:[{name:"Any channel",value:"all"},{name:"Add channel",value:"add"},{name:"Remove channel",value:"remove"},{name:"Show channels",value:"status"}]},{type:7,name:"channel",description:"Voice channel",channel_types:[2]}]},
      {type:1,name:"exportjob",description:"Inspect, cancel or retry an export job.",options:[{type:3,name:"action",description:"Job action",required:true,choices:[{name:"Status",value:"status"},{name:"Cancel",value:"cancel"},{name:"Retry",value:"retry"}]},{type:3,name:"job",description:"Export job ID",required:true}]},
      {type:1,name:"eventrecord",description:"Opt into recording a selected Discord voice event.",options:[{type:3,name:"mode",description:"Event recording rule",required:true,choices:[{name:"Enable",value:"enable"},{name:"Disable",value:"disable"},{name:"Show rules",value:"status"}]},{type:3,name:"event",description:"Discord event ID or event link"},{type:5,name:"stop_on_end",description:"Also stop this event's recording when the event ends (default off)"}]},
      {type:1,name:"access",description:"Manage who may use The Witness (Manage Server required).",options:[{type:3,name:"mode",description:"Access policy",required:true,choices:[{name:"Everyone",value:"everyone"},{name:"Bot Wrangler role",value:"role"},{name:"Show current policy",value:"status"}]},{type:8,name:"role",description:"Role allowed to control the bot (required for role mode)"}]},
      {type:1,name:"title",description:"Name the active recording or a saved session.",options:[{type:3,name:"text",description:"Recording title",required:true,max_length:120},{type:3,name:"session",description:"Saved session ID (omit for the active recording)"}]},
      {type:1,name:"downloadnames",description:"Choose date, date + channel, or original ZIP names.",options:[{type:3,name:"style",description:"Naming style",required:true,choices:[{name:"Date only (UTC)",value:"date"},{name:"Date + channel (UTC)",value:"date-channel"},{name:"Original filenames",value:"original"}]}]},
      { type:1,name:"delete",description:"Permanently delete a saved recording and its exports.",options:[{type:3,name:"session",description:"Session ID to delete",required:true},{type:5,name:"confirm",description:"Confirm permanent deletion",required:true}] },
      { type:1,name:"webapp",description:"Get a private browser microphone link for the current recording." },
      { type:1,name:"dashboard",description:"Open the private recording dashboard for this server." },
      { type: 1, name: "recover", description: "Recover saved audio from an interrupted recording.", options: [{ type: 3, name: "session", description: "Interrupted session ID", required: true }] },
      { type: 1, name: "note", description: "Add a timestamped note to the current recording.", options: [{ type: 3, name: "text", description: "Your session note", required: true, max_length: 2000 }] },
      { type: 1, name: "recordings", description: "List the latest recordings in this server." },
      { type: 1, name: "export", description: "Download a completed recording as separate speaker tracks.", options: [
        { type: 3, name: "session", description: "Session ID from /recordings", required: true },
        { type: 3, name: "format", description: "Project or audio format", choices: ["audition","audacity","ogg","wav","flac","mp3","aac"].map(value => ({ name: value==="audition"?"Adobe Audition project (ZIP)":value==="audacity"?"Audacity import project (ZIP)":value.toUpperCase(), value })) },
        { type: 5, name: "mix", description: "Also include mixed session audio" },
        { type: 5, name: "transcribe", description: "Create transcripts using your configured local model" },
        { type: 3, name: "upload", description: "Upload to your configured cloud account", choices:["dropbox","google","onedrive","box"].map(value=>({name:value,value})) }
      ] },
      {
        type: 1,
        name: "record",
        description: "Join the selected voice channel and begin recording.",
        options:[{type:7,name:"channel",description:"Voice channel to record",required:true,channel_types:[2]},{type:3,name:"title",description:"Optional recording title",max_length:120}]
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
        description: "Recording quick start, command guides, examples, and troubleshooting.",
        options:[{type:3,name:"topic",description:"Choose a help topic",choices:helpTopics.map(topic=>({name:topic.name,value:topic.value}))}]
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
    gateway: { intents: ["guilds", "guildVoiceStates", "guildScheduledEvents"] }
  });

  const panels=new RecordingPanels(client,storageMonitor);recordingPanels=panels;

  const events=new EventRecording(settingsStore,recordings,async event=>{
    const guild=client.guilds.get(event.guildID);if(!guild||!event.channelID)throw new Error("Event voice channel unavailable.");
    const connection=await joinVoiceChannel(client,guild,event.channelID);
    const session=await recordings.start(guild,event.channelID,connection,()=>client.joinVoiceChannel(event.channelID!,{opusOnly:true,selfDeaf:false}));
    await session.setTitle(event.name.replace(/[\x00-\x1f\x7f]/g," ").trim().slice(0,120)||"Discord event");
    await panels.ensure(event.channelID,session).catch(error=>console.warn("[Event panel]",error));return session.id;
  },async guildID=>{try{await recordings.stop(guildID);}finally{const guild=client.guilds.get(guildID);if(guild)leaveVoiceChannel(guild);}await panels.update();});
  client.on("guildScheduledEventUpdate",event=>{void events.update({id:event.id,guildID:event.guild.id,channelID:(event as unknown as {channel?:{id:string}}).channel?.id??null,entityType:event.entityType,status:event.status,name:event.name}).catch(error=>console.error("[Event recording]",error));});

  const schedules=new ScheduleRunner(config.recordingPath,settingsStore,recordings,async(guildID,rule)=>{
    const guild=client.guilds.get(guildID),channel=guild?.channels.get(rule.channelID);if(!guild||!channel||channel.type!==2)throw Error("Scheduled voice channel unavailable.");
    const connection=await joinVoiceChannel(client,guild,rule.channelID),session=await recordings.start(guild,rule.channelID,connection,()=>client.joinVoiceChannel(rule.channelID,{opusOnly:true,selfDeaf:false}));
    if(rule.title)await session.setTitle(rule.title);await panels.ensure(rule.channelID,session).catch(error=>console.warn("[Schedule panel]",error));return session.id;
  },async guildID=>{try{await recordings.stop(guildID);}finally{const guild=client.guilds.get(guildID);if(guild)leaveVoiceChannel(guild);}await panels.update();});scheduleRunner=schedules;let schedulesStarted=false;
  client.on("ready", async () => {
    console.log(
      `[Discord] Logged in as ${client.user.username} (${client.user.id})`
    );

    try {
      if(!schedulesStarted){await schedules.load();schedules.startTimer();schedulesStarted=true;}
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

    if (!settings.autoJoin || (settings.autoJoinChannels!==undefined&&!settings.autoJoinChannels.includes(channel.id)) || !mayUseBot(settings,member.roles)) {
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
          await panels.ensure(channel.id,session).catch(error=>console.warn("[Panel] Could not post in voice-channel chat; /status remains available.",error));
        }
      });
    } catch (error) {
      console.error("[AutoJoin] Failed:", error);
    }
  });

  client.on("interactionCreate", async (interaction: any) => {
    const wranglerSettings=interaction.guildID?settingsStore.get(interaction.guildID):undefined;
    // Help is informational and remains available even when bot controls are restricted.
    const readingHelp=(interaction.type===2&&interaction.data?.name==="help")||(interaction.type===3&&interaction.data?.custom_id==="witness:help");
    if(readingHelp){
      try{
        const topic=interaction.type===3?interaction.data?.values?.[0]:interaction.data?.options?.find((option:any)=>option.name==="topic")?.value;
        const body=helpMessage(topic,{downloads:Boolean(downloads),restricted:Boolean(wranglerSettings?.restrictAccess)});
        if(interaction.type===3){const {flags,...update}=body;await interaction.editParent(update);}else await interaction.createMessage(body);
      }catch(error){console.warn("[Help] Could not display help.",error);}
      return;
    }
    // Access-policy configuration bypasses the role gate; its handler requires Manage Server.
    const configuringAccess=interaction.type===2&&interaction.data?.name==="access";
    if([2,3,5].includes(interaction.type)&&wranglerSettings&&!configuringAccess&&!mayUseBot(wranglerSettings,interaction.member?.roles)){
      try{await interaction.createMessage({content:"The Witness is restricted to the configured Bot Wrangler role. Ask a server manager to assign you the role or switch access to everyone.",flags:64});}catch(error){console.warn("[Access] Could not send access response.",error);}return;
    }
    if(interaction.type===3||interaction.type===5){
      const match=/^witness:(status|note|stop|note-submit):([a-f0-9-]{36})$/i.exec(interaction.data?.custom_id??"");if(!match)return;
      try{
        const session=recordings.sessions.get(interaction.guildID);
        if(!session||session.id!==match[2]){await interaction.createMessage({content:"This recording is no longer active.",flags:64});return;}
        if(match[1]==="note"&&interaction.type===3){await interaction.createModal({title:"Add a session note",custom_id:`witness:note-submit:${session.id}`,components:[{type:1,components:[{type:4,custom_id:"note",style:2,label:"Note",required:true,max_length:2000}]}]});return;}
        await interaction.defer(64);
        if(match[1]==="status"){await interaction.editOriginalMessage({content:panelBody(session,storageMonitor.status?.low).content,allowedMentions:{parse:[]}});return;}
        if(match[1]==="note-submit"&&interaction.type===5){const text=interaction.data?.components?.flatMap((row:any)=>row.components??[]).find((item:any)=>item.custom_id==="note")?.value;await recordings.exclusive(session.guildID,async()=>{if(recordings.sessions.get(session.guildID)!==session)throw new Error("Recording has stopped.");await session.note(text,interaction.member?.id??"unknown");});await interaction.editOriginalMessage({content:"Timestamped note saved."});await panels.update();return;}
        if(match[1]==="stop"&&interaction.type===3){recordings.cancelReconnect(session.guildID);await recordings.exclusive(session.guildID,async()=>{if(recordings.sessions.get(session.guildID)!==session)return;try{await recordings.stop(session.guildID);}finally{const guild=client.guilds.get(session.guildID);if(guild)leaveVoiceChannel(guild);}});await interaction.editOriginalMessage({content:"Recording stopped and saved."});await panels.update();return;}
        await interaction.editOriginalMessage({content:"Unsupported panel action."});
      }catch(error){console.error('[Panel action]',error);try{const body={content:"The action failed. Check recording status and the bot logs.",flags:64};if(interaction.acknowledged)await interaction.editOriginalMessage(body);else await interaction.createMessage(body);}catch{}}
      return;
    }
    if (interaction.type !== 2)return;

    try {
    const commandName = interaction.data?.name;
    const guildID = interaction.guildID;

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

    if(["schedule","retention","channelrules"].includes(commandName)){
      if(!interaction.member?.permissions?.has("manageGuild")){await interaction.createMessage({content:"Manage Server permission is required for automation settings.",flags:64});return;}
      const options=interaction.data?.options??[],value=(name:string)=>options.find((option:any)=>option.name===name)?.value;await interaction.defer(64);
      if(commandName==="retention"){const days=value("days");if(days>0&&value("confirm")!==true)throw Error("Set confirm:true to enable permanent automatic deletion. Use days:0 to keep cleanup off.");await settingsStore.update(guildID,{retentionDays:days});await interaction.editOriginalMessage({content:days?`Automatic cleanup enabled: completed recordings and their exports older than ${days} days will be permanently deleted. Active, failed and interrupted recordings are preserved.`:"Automatic cleanup is off."});return;}
      if(commandName==="channelrules"){const mode=value("mode");if(mode==="status"){await interaction.editOriginalMessage({content:settings.autoJoinChannels===undefined?"Automatic joining may use any voice channel when enabled.":settings.autoJoinChannels.length?"Allowed channels: "+settings.autoJoinChannels.map(id=>`<#${id}>`).join(", "):"No channels allowed for automatic joining."});return;}if(mode==="all")await settingsStore.update(guildID,{autoJoinChannels:undefined});else{const channel=value("channel");if(guild.channels.get(channel)?.type!==2)throw Error("Choose a voice channel.");const channels=settings.autoJoinChannels??[];await settingsStore.update(guildID,{autoJoinChannels:mode==="add"?[...new Set([...channels,channel])]:channels.filter(id=>id!==channel)});}await interaction.editOriginalMessage({content:"Channel policy saved. Autojoin and autorecord remain at their current settings."});return;}
      const rules=settings.schedules??[],action=value("action");if(action==="list"){await interaction.editOriginalMessage({content:rules.length?rules.map(rule=>`${rule.id}: <#${rule.channelID}> at ${rule.time} ${rule.timezone}; days ${rule.days.join(",")}; ${rule.durationMinutes} minutes`).join("\n"):"No recurring recordings are enabled.",allowedMentions:{parse:[]}});return;}
      if(action==="remove"){if(!rules.some(rule=>rule.id===value("id")))throw Error("Schedule not found.");await settingsStore.update(guildID,{schedules:rules.filter(rule=>rule.id!==value("id"))});await interaction.editOriginalMessage({content:"Schedule removed. Any recording it already started will finish at its scheduled end."});return;}
      if(guild.channels.get(value("channel"))?.type!==2)throw Error("Choose a voice channel.");if(typeof value("days")!=="string"||!value("days").trim())throw Error("Choose weekdays using 0–6 separated by commas.");const rule=newSchedule({channelID:value("channel"),title:value("title")??"Scheduled recording",time:value("time")??"",timezone:value("timezone")??"UTC",days:String(value("days")??"").split(",").map(Number),durationMinutes:value("minutes")});await settingsStore.update(guildID,{schedules:[...rules,rule]});await interaction.editOriginalMessage({content:`Schedule enabled: ${rule.id}. Starts at ${rule.time} ${rule.timezone} and records for ${rule.durationMinutes} minutes.`});return;
    }
    if(commandName==="exportjob"){
      if(!exportQueue)throw new Error("Export queue unavailable.");const options=interaction.data?.options??[],id=options.find((option:any)=>option.name==="job")?.value,action=options.find((option:any)=>option.name==="action")?.value;
      const job=exportQueue.get(id);if(!job||job.guildID!==guildID)throw new Error("Export job not found in this server.");await interaction.defer(64);
      if(action==="cancel"){await exportQueue.cancel(id,guildID);await interaction.editOriginalMessage({content:"Cancellation requested. Your original recording is preserved. Files already uploaded to a cloud account are not deleted."});return;}
      if(action==="retry"){const next=await exportQueue.retry(id,guildID);await interaction.editOriginalMessage({content:`Retry queued: ${next.id}${downloads?"\n"+downloads.jobLink(next.id):""}`});return;}
      await interaction.editOriginalMessage({content:`Job ${job.id}: ${job.state} — ${job.stage??"Waiting"}`});return;
    }
    if(commandName==="eventrecord"){
      if(!interaction.member?.permissions?.has("manageGuild")){await interaction.createMessage({content:"Manage Server permission is required to configure event recording.",flags:64});return;}
      const options=interaction.data?.options??[],mode=options.find((option:any)=>option.name==="mode")?.value,rules=settings.eventRecordings??[];
      await interaction.defer(64);
      if(mode==="status"){await interaction.editOriginalMessage({content:rules.length?rules.map(rule=>`Event ${rule.eventID} — auto-stop ${rule.stopOnEnd?"on":"off"}`).join("\n"):"Event-triggered recording is off. No events are selected."});return;}
      const value=String(options.find((option:any)=>option.name==="event")?.value??""),match=/^(?:https:\/\/discord\.com\/events\/(\d+)\/)?(\d{1,25})$/.exec(value);
      if(!match||(match[1]&&match[1]!==guildID)||!["enable","disable"].includes(mode))throw new Error("Choose an event ID or event link from this server.");
      const eventID=match[2]!;
      if(mode==="enable"){const event=(await client.getGuildScheduledEvents(guildID)).find(event=>event.id===eventID);if(!event||event.entityType!==2||!(event as unknown as {channel?:{id:string}}).channel||event.status!==1)throw new Error("Select a scheduled voice-channel event that has not started yet.");}
      const next=rules.filter(rule=>rule.eventID!==eventID);if(mode==="enable")next.push({eventID,stopOnEnd:options.find((option:any)=>option.name==="stop_on_end")?.value===true});
      await settingsStore.update(guildID,{eventRecordings:next});await interaction.editOriginalMessage({content:mode==="enable"?"Event recording enabled for that event. Recording starts when Discord marks it active; auto-stop is optional and defaults off.":"Event recording disabled for that event."});return;
    }
    if(commandName==="access"){
      if(!interaction.member?.permissions?.has("manageGuild")){await interaction.createMessage({content:"Manage Server permission is required to change or inspect the access policy.",flags:64});return;}
      const options=interaction.data?.options??[],mode=options.find((option:any)=>option.name==="mode")?.value;
      if(mode==="status"){await interaction.createMessage({content:settings.restrictAccess?`Bot controls require role <@&${settings.accessRoleID}>.`:"Bot controls are open to all server members.",flags:64,allowedMentions:{parse:[]}});return;}
      if(!["everyone","role"].includes(mode))throw new Error("Invalid access mode.");
      const roleID=options.find((option:any)=>option.name==="role")?.value;
      if(mode==="role"&&(!roleID||roleID===guildID||!guild.roles.has(roleID))){await interaction.createMessage({content:"Choose an existing Bot Wrangler role; @everyone cannot be used for restricted access.",flags:64});return;}
      await interaction.defer(64);await settingsStore.update(guildID,mode==="role"?{restrictAccess:true,accessRoleID:roleID}:{restrictAccess:false});
      await interaction.editOriginalMessage({content:mode==="role"?`Bot commands and panel buttons now require <@&${roleID}>. Server managers can still change this policy with /access. Existing private web links remain usable; keep them private.`:"Bot commands and panel buttons are open to all server members again.",allowedMentions:{parse:[]}});return;
    }

    if(commandName==="title"){
      const options=interaction.data?.options??[],text=validateTitle(options.find((option:any)=>option.name==="text")?.value),id=options.find((option:any)=>option.name==="session")?.value;
      await interaction.defer(64);await recordings.exclusive(guildID,async()=>{const active=recordings.sessions.get(guildID);if(active&&(!id||active.id===id))await active.setTitle(text);else if(id)await renameSession(config.recordingPath,id,guildID,text);else throw new Error("Start a recording or provide a saved session ID.");});
      await interaction.editOriginalMessage({content:`Recording title saved: ${text}`,allowedMentions:{parse:[]}});return;
    }
    if(commandName==="downloadnames"){
      const style=interaction.data?.options?.find((option:any)=>option.name==="style")?.value;
      if(!["date","date-channel","original"].includes(style))throw new Error("Invalid naming style.");
      await interaction.defer(64);await settingsStore.update(guildID,{downloadNaming:style});
      await interaction.editOriginalMessage({content:`Download names now use ${style==="date"?"the recording start date (UTC)":style==="date-channel"?"the recording start date + channel (UTC)":"original filenames"}. You can also switch styles on each download page.`});return;
    }
    if(commandName==="delete"){
      const options=interaction.data?.options??[],id=options.find((option:any)=>option.name==="session")?.value;
      if(options.find((option:any)=>option.name==="confirm")?.value!==true){await interaction.createMessage({content:"Set confirm:true to permanently delete this session and its exports.",flags:64});return;}
      if(!interaction.member?.permissions?.has("manageGuild")){await interaction.createMessage({content:"Manage Server permission is required to delete recordings.",flags:64});return;}
      await interaction.defer(64);
      if(exportQueue?.busy(id))throw new Error("Wait for this recording's export to finish before deleting it.");
      if(exportQueue)await exportQueue.whileIdle(id,()=>recordings.exclusive(guildID,()=>deleteSession(config.recordingPath,id,guildID)));else await recordings.exclusive(guildID,()=>deleteSession(config.recordingPath,id,guildID));
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
          await interaction.editOriginalMessage({content:`Your export is queued. Job: ${job.id}\n[Open export status](${downloads.jobLink(job.id)})`});return;
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
        await interaction.editOriginalMessage({ content: "Your speaker tracks and participant manifest are ready.", attachments: [{ file: archive, filename: downloadName(`witness-${settings.downloadNaming==="original"?id:format}.zip`,{startedAt:sourceSession.startedAt,title:sourceSession.title,channelName:sourceSession.channelName,channelID:sourceSession.channelID},settings.downloadNaming??"date") }] });
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
      const voiceChannelID=interaction.data?.options?.find((option:any)=>option.name==="channel")?.value;
      const voiceChannel=guild.channels.get(voiceChannelID);
      if(!voiceChannelID||voiceChannel?.type!==2){
        await interaction.createMessage({content:"Choose a voice channel in this server with /record channel:… .",flags:64});return;
      }
      const permissions=interaction.member?voiceChannel.permissionsOf(interaction.member):undefined;
      if(!permissions?.has("viewChannel")||!permissions.has("voiceConnect")){
        await interaction.createMessage({content:"You need permission to view and connect to the selected voice channel.",flags:64});return;
      }

      const proposedTitle=interaction.data?.options?.find((option:any)=>option.name==="title")?.value;
      const title=proposedTitle===undefined?undefined:validateTitle(proposedTitle);
      await interaction.defer(64);
      try {
        const session = await recordings.exclusive(guildID, async () => {
          const connection = await joinVoiceChannel(client, guild, voiceChannelID);
          const session=await recordings.start(guild, voiceChannelID, connection, () => client.joinVoiceChannel(voiceChannelID, {opusOnly:true,selfDeaf:false}));
          if(title)await session.setTitle(title);return session;
        });
        await panels.ensure(interaction.channel.id,session).catch(error=>console.warn("[Panel] Could not post recording panel; /status remains available.",error));
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
        await panels.update();
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



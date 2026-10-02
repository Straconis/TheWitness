export const helpTopics = [
  {value:"start",name:"Quick start",description:"Record, stop, find your session, and download it"},
  {value:"recording",name:"Recording & notes",description:"Voice recording, titles, notes, and live controls"},
  {value:"exports",name:"Exports & formats",description:"Projects, audio formats, mixed audio, and export jobs"},
  {value:"downloads",name:"Downloads & browser tools",description:"ZIP names, private links, dashboard, and browser microphone"},
  {value:"automation",name:"Automatic recording",description:"Autojoin, events, schedules, and channel rules"},
  {value:"permissions",name:"Permissions & privacy",description:"Bot Wrangler roles, server settings, and deletion"},
  {value:"troubleshooting",name:"Troubleshooting & recovery",description:"Missing commands, interrupted recordings, and failed exports"}
] as const;
export interface HelpContext {downloads:boolean;restricted:boolean}
const pages:Record<string,string>={
 start:[
  "The Witness records separate, synchronized audio tracks for your group.",
  "**1. Choose a voice channel.** Have your participants join it.",
  "**2. Start:** `/record channel:General Voice title:Session 12` (the title is optional).",
  "**3. During the session:** `/note text:Combat starts` adds a timestamped note. Use `/status` or the recording panel to check progress.",
  "**4. Finish:** `/stop` saves the recording and leaves voice.",
  "**5. Find it:** `/recordings` lists recent sessions. Copy the session ID from the entry you want.",
  "**6. Download:** `/export session:<session-id> format:audition`. Replace `<session-id>` with the ID you copied. Open the returned export-status link or download the Discord attachment.",
  "Audition is the default export. Extract the whole ZIP and open `session.sesx`; keep its media files together. Use `format:wav` for separate WAV tracks instead.",
  "Choose a topic below, or jump directly with `/help topic:Exports & formats`."
 ].join("\n\n"),
 recording:[
  "**`/record channel:<voice-channel> [title]`** — Select the voice channel to record; the title is optional. You can start it from text chat without joining voice yourself, provided you can view and connect to the selected channel. One recording can be active per server; different servers can record simultaneously.",
  "**`/stop`** — Finish and save the current recording, then leave voice. A second `/stop` does not delete anything.",
  "**`/status`** — Check recording state, speaker count, saved packets, voice connection, and disk space.",
  "**`/note text:…`** — Add a timestamped note. The panel's **Add note** button does the same.",
  "**`/title text:Session 12`** — Name the active recording. Add `session:<session-id>` to rename a saved one.",
  "**`/recordings`** — Show the 10 most recent recordings in this server, including their IDs and states.",
  "The live recording panel offers **Status**, **Add note**, and **Stop**. If it cannot appear in channel chat, slash commands still work."
 ].join("\n\n"),
 exports:[
  "**`/export session:<session-id> [format] [mix] [transcribe] [upload]`** — Export a **completed** recording. Get its ID with `/recordings`; recover interrupted recordings first.",
  "**Formats:** `audition` (default): ZIP with an Audition session and FLAC media. `audacity`: ZIP with an import project and WAV media. `ogg`, `wav`, `flac`, `mp3`, `aac`: individual speaker audio; AAC files use `.m4a`.",
  "**Example:** `/export session:<session-id> format:flac mix:true` adds mixed session audio alongside separate tracks.",
  "With web downloads enabled, open the returned status link and wait for **Ready**. Otherwise, exports attach in Discord with an 8 MiB limit. Web audio exports offer individual files; project formats provide a ZIP.",
  "**`/exportjob action:status job:<job-id>`** — Check progress. Use `action:cancel` to cancel or `action:retry` for a failed/cancelled job. Copy the job ID from the queued-export response. Cancellation preserves the original recording; cloud files already uploaded remain.",
  "`transcribe:true` needs the configured local speech engine/model. `upload:dropbox|google|onedrive|box` needs a connected owner cloud account. Both require the web export service. Exports share a processing queue across servers."
 ].join("\n\n"),
 downloads:[
  "**`/downloadnames style:date`** — ZIP names such as `2026-10-01.zip`.",
  "**`/downloadnames style:date-channel`** — ZIP names such as `2026-10-01-General-Voice.zip`.",
  "**`/downloadnames style:original`** — Keep original filenames. The dashboard saves the same server preference, and each download page lets you choose a style for that link.",
  "Dates use the **recording start in UTC**. Channel names are saved when new recordings start; older recordings can fall back to a channel ID. Same-day exports can have the same download name. Individual tracks keep detailed filenames.",
  "**`/dashboard`** — Open this server's private session dashboard: rename recordings, prepare exports, recover audio, and manage settings. Web downloads must be enabled by the host operator.",
  "**`/webapp`** — Get a private browser microphone link for the **active** recording. Allow microphone access in the browser; web recording must be enabled by the host operator.",
  "On a private download page you can audition tracks, open the multitrack editor, and prepare excerpts. Excerpts preserve the original recording.",
  "Private links expire (check the expiry shown on the page). Anyone holding a link can use it while valid; share it only with your group."
 ].join("\n\n"),
 automation:[
  "Automatic recording starts **off** for a new server. These settings belong to each server separately.",
  "**`/autojoin mode:enable|disable|status`** — Join when an eligible member enters voice. Enabling only joins; it does not start recording. Disabling also turns autorecord off.",
  "**`/autorecord mode:enable|disable|status`** — Enabling turns on both autojoin and automatic recording. Disabling leaves autojoin enabled. These react to subsequent voice joins.",
  "**`/channelrules mode:status|all|add|remove [channel]`** — Limit automatic joining to selected channels. Example: `/channelrules mode:add channel:General Voice`. Requires **Manage Server**; it does not turn automation on.",
  "**`/eventrecord mode:enable event:<event-id-or-link> stop_on_end:true`** — Record a selected, not-yet-started Discord **voice** event when it becomes active. Stopping at event end is optional and defaults off. `mode:status` lists rules; `mode:disable` removes one. Requires **Manage Server**.",
  "**`/schedule action:add channel:General Voice time:19:00 days:5 timezone:America/New_York minutes:180`** — Record Fridays at 7 PM for three hours. Weekdays: `0=Sun` through `6=Sat`. Timezones use names like `America/New_York` (default UTC). `action:list` shows IDs; `action:remove id:<schedule-id>` removes a rule. Requires **Manage Server**.",
  "Schedules and events do not take over a manual recording. In role-restricted servers, automatic voice joining depends on a member having the Bot Wrangler role."
 ].join("\n\n"),
 permissions:[
  "**Who can use it?** Controls are open to all server members by default. A server can restrict them to a **Bot Wrangler** role. `/help` remains available to everyone.",
  "**`/access mode:role role:Bot Wrangler`** — Restrict controls to that role. `mode:everyone` opens controls; `mode:status` shows the policy. All `/access` operations require **Manage Server**, but work even if that manager lacks the Wrangler role.",
  "**Manage Server is also required** for `/schedule`, `/eventrecord`, `/channelrules`, `/retention`, and `/delete`. If role restrictions are enabled, those commands also require the Wrangler role.",
  "**`/delete session:<session-id> confirm:true`** — Permanently remove a saved recording and its exports. Check the session ID carefully.",
  "**`/retention days:30 confirm:true`** — Automatically delete completed recordings and exports older than 30 days. `days:0` disables cleanup (the default). Active, failed, and interrupted recordings are preserved.",
  "Recordings and command access are scoped to their server. **Private web links are bearer links:** anyone you give a valid link can use it. Changing the Wrangler role does not revoke already-shared links.",
  "The bot needs permission to view/connect to the voice channel and to send messages in the channel used for commands/panels. Ask a server manager if recording cannot start."
 ].join("\n\n"),
 troubleshooting:[
  "**Cannot start?** Select a voice channel with `/record channel:…`. Check your permission to view/connect to that channel, the bot's channel permissions, your Wrangler role, and `/status`. Stop the current recording before switching voice channels in the same server.",
  "**No commands in a newly invited server?** Commands currently register when the bot connects. Ask the host operator to restart it when idle, then reopen Discord's command picker.",
  "**Interrupted or failed recording?** Run `/recordings`, copy its ID, then `/recover session:<session-id>`. Recovery preserves the original files and returns a **new session ID**; export that recovered session.",
  "**Export unavailable or failed?** Use a completed session from this server. For queued exports, inspect `/exportjob action:status job:<job-id>` and retry failed jobs with `action:retry`. An attachment above 8 MiB needs the host's web download service.",
  "**Dashboard/browser link unavailable?** The host operator must enable the web download service. Browser microphone capture needs microphone permission and a supported secure browser page.",
  "**Private link expired?** Request a new dashboard, microphone, or export link through the corresponding command.",
  "**Low disk space?** Ask the host operator to review storage. A manager can delete selected saved sessions or opt into retention; deletion is permanent.",
  "**Update being prepared?** New recordings/exports pause while deployment waits for existing work to finish. Try again after the update completes. For unresolved problems, give the host operator the session/job ID and the error message."
 ].join("\n\n")
};
export function helpMessage(requested:unknown,context:HelpContext){
 const topic=helpTopics.find(item=>item.value===requested)??helpTopics[0];
 return {content:"",flags:64,allowedMentions:{parse:[]},embeds:[{
  title:`The Witness · ${topic.name}`,description:pages[topic.value],color:0x9dd9ff,
  fields:[{name:"This server",value:`Controls: ${context.restricted?"Bot Wrangler role required":"open to server members"}. Web downloads: ${context.downloads?"enabled":"not enabled on this host"}. Help is visible only to you.`}],
  footer:{text:"The Witness remembers. · Use the menu below or /help topic to explore."}
 }],components:[{type:1,components:[{type:3,custom_id:"witness:help",placeholder:"Choose a help topic",min_values:1,max_values:1,options:helpTopics.map(item=>({label:item.name,value:item.value,description:item.description,default:item.value===topic.value}))}]}]};
}

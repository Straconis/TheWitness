# The Witness: ready-to-test handoff

The development items from the Craig comparison are implemented: bundled local
transcription, owner cloud OAuth connections and refresh, AAC/M4A, Craig-style
Audacity import projects, a non-destructive browser multitrack editor, weekly
schedules with time zones, channel rules and opt-in retention. This is our private
recording package, not a claim of every Craig/Ennuizel feature or UI being identical.

Advanced features stay off until selected. No Witness subscription is required.
A/V synchronization remains deliberately deferred for the separate OBS workflow.
Run one instance per recording directory; this release targets one Node 24 host.

## Local evidence

The automated suite covers 65 checks, including existing recording/recovery
paths and the new integrations, editor exports, schedules and retention. A real
11-second speech sample was recognized by bundled whisper.cpp/base.en in about
11 seconds on this VM. This establishes real execution, not game-session accuracy
or hosting performance. Browser checks exercised waveform display, clip splitting,
saved edits and an export through to its download link.

## Transcription

The Linux package includes a CPU-only whisper.cpp v1.8.7 executable and the
checksum-pinned `base.en` model. Leaving `TRANSCRIPTION_EXECUTABLE` and
`TRANSCRIPTION_MODEL` blank uses the bundled files. Choose `transcribe:true` on
`/export`, or check Include transcript on the dashboard/editor. TXT, SRT and VTT
are included, with timestamps and speaker names from separate Discord tracks.
The engine processes tracks sequentially in five-minute chunks with two threads
by default. A timeout applies per conversion/recognition chunk. This protects
against hung tools; it is not a maximum recording duration.

`TRANSCRIPTION_PROMPT` can supply spelling hints for campaign names and places.
English is the bundled model's language. Other languages require a multilingual
model and an appropriate `TRANSCRIPTION_LANGUAGE`. A larger model may improve
accuracy but needs more resources. None of these settings start transcription
without an explicit export request.

Rebuild using `python3 scripts/prepare-transcription.py`; no administrator
installation is needed, but the development machine needs Git and C/C++ build
tools. Verify real speech with:

```sh
node scripts/check-transcription.cjs /path/to/speech.wav
```

## Cloud account setup

Uploads are optional and use the owner's connected account, shared by this
private bot deployment. Connecting an account does not enable automatic uploads.
Register a web/server OAuth application with the chosen provider, then configure
its `<PROVIDER>_CLIENT_ID` and `<PROVIDER>_CLIENT_SECRET` privately in `.env`.
Register this exact callback address at the provider:

```text
https://YOUR-PUBLIC-WITNESS-ADDRESS/oauth/callback
```

Start The Witness with its public web service enabled, then run:

```sh
node scripts/cloud-account.cjs connect dropbox
node scripts/cloud-account.cjs status
```

Replace `dropbox` with `google`, `onedrive` or `box`. Open the printed private
connection URL in a browser within ten minutes and authorize the account.
Credentials are stored under `RECORDING_PATH/private-accounts` with private file
permissions. Refresh tokens rotate automatically when providers issue replacements.
Client secrets and saved account files must stay outside Git, public downloads
and shared archives. Keep the recording directory persistent across host restarts.

Provider setup details:

- Dropbox: enable `files.content.write`; the flow requests offline access.
- Google: enable Drive API and configure OAuth consent/test users; the flow uses
  `drive.file`, offline access and explicit consent. Leave the folder setting blank
  initially. An existing folder may require additional provider authorization.
- Microsoft: register a confidential web application with the intended account
  types; the flow requests delegated `Files.ReadWrite` and `offline_access`.
- Box: enable file upload permissions in its developer application.

An owner can instead supply access/refresh tokens through the optional environment
settings. A standalone access token cannot refresh itself. Disconnect saved
credentials with `node scripts/cloud-account.cjs disconnect <provider>`, also
removing environment tokens; revoke app access at the provider if needed.
Google/provider policies can require reauthorization, especially development/test
apps. The bot reports authorization failure rather than silently bypassing it.

Project exports upload their ZIP, containing the project, audio and transcripts.
Other formats upload their files. Cancellation stops outstanding requests but
cannot undo files already accepted remotely. Restart/retry around a network
failure can leave duplicate uploads; check the destination before retrying.

## Editor and project exports

Open a completed export's private download page and choose Open multitrack editor.
The editor provides waveforms, synchronized preview, trims, splits, duplicated or
moved clips, fades, levels, pan, mute/solo, names, notes, undo/redo and saved edits.
Export produces new audio/project files; source recordings and prior exports
are preserved. Multiple holders of a private link share the saved edit; the last
save wins. Use WAV/FLAC sources when editing to avoid another lossy encoding pass.
Playback preview uses browser media timing; final edits render through FFmpeg.
The editor supports up to 100 tracks, 500 clips and a 24-hour timeline; the
recording engine has no artificial duration cap. Adjust note times after moving
conversation clips. Browser editing is for post-session use, not a new in-game
window requirement.

Audacity export uses Craig's legacy `.aup` import-project structure with a
`session_data` folder. Extract the whole ZIP and open `session.aup`; save in the
installed Audacity version's native format afterward. This is not an AUP3/AUP4
file generator. Audacity version compatibility needs verification.
Audition uses `.sesx` with linked WAVs and XMP cue markers. AAC exports use `.m4a`.

## Optional automation

Manage Server permission is required for these commands, plus the Bot Wrangler
role when role restriction is enabled.

```text
/schedule action:add channel:<voice channel> time:19:00 days:5 timezone:America/New_York minutes:240 title:Friday game
/schedule action:list
/schedule action:remove id:<schedule ID>
/channelrules mode:add channel:<voice channel>
/channelrules mode:status
/channelrules mode:all
/retention days:30 confirm:true
/retention days:0
```

Weekdays are 0=Sunday through 6=Saturday. Schedules repeat weekly in the selected
IANA time zone. The bot must be online at start time; missed starts are not
replayed. Spring-forward times that do not exist are skipped; a repeated local
start time during fall-back runs once. Schedules never adopt manual recordings,
restart manually stopped sessions or stop a different later recording. Removing
a schedule leaves a recording already started by it to finish at its original end.
Channel rules limit autojoin/autorecord triggers, not manual/event/scheduled starts.
They do not enable autojoin themselves. An empty selected-channel list allows none.

Retention is off by default and checks hourly/startup when enabled. It permanently
deletes completed recordings and their exports after the configured number of
whole days from completion. Active, failed, interrupted and exporting sessions
are preserved. Enabling retention can delete old completed sessions at the next
check; use it only when that is intended. Low-space warnings never enable cleanup.

## Remaining setup and real-world verification

1. Configure/invite the Discord bot and test two or more real speakers, notes,
   buttons, role restrictions, reconnects and selected events/schedules.
2. Open Audition and Audacity projects on the user's other machine and verify
   linked tracks, lengths, names and markers.
3. Connect any desired cloud accounts and test actual uploads and reauthorization.
4. Test real microphones in browsers through public HTTPS.
5. On the chosen host, select Node 24, run `node scripts/check-host.cjs`, confirm
   native-module compatibility, persistent storage, CPU/RAM and a reachable HTTPS
   web port. No specific bot-hosting.net plan has been verified.
6. Run a full-length game session and check audio sync, transcription quality,
   resource use and restart behavior before relying on it for an important game.

These are setup and verification tasks. Bugs found by those checks may still
need fixes; passing local tests cannot guarantee a trouble-free first deployment.

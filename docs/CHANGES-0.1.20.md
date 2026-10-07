# 0.1.20 — protect recording capacity and tighten server controls

Exports now estimate peak disk use, including both loose project audio and ZIP copies, and reserve capacity across concurrent jobs. Insufficient capacity keeps a job queued with a “Waiting for disk space” stage. A one-second disk guard interrupts and requeues exports when space becomes low. At the critical threshold, temporary export output is reclaimed before a fresh check decides whether recordings must stop. Original recordings are preserved. Compression estimates are approximate; these controls cannot guarantee capacity when other processes fill the disk.

Generated exports expire after 48 hours unless active work or saved editor work needs them; editor source chains remain intact. Terminal job records expire after seven days. Cleanup also handles abandoned intro uploads, unreferenced old intro versions and interrupted temporary/deleted directories. Unreadable or ambiguous export manifests are preserved. Startup cleanup precedes recording recovery and export dispatch. Durable disk-waiting jobs do not prevent an operator deployment.

Clean voice disconnects save and stop rather than reconnecting after a moderator kick or channel deletion. Error disconnects retain the reconnect policy. Forced disconnects skip sync end cues.

Manage Server is required to enable/disable autojoin and autorecord and to obtain a manager dashboard. Settings and server-intro uploads require a signed manager capability; old dashboard links and recording download links cannot perform those changes. The intro uploader moves to the manager dashboard. Manager links remain bearer links and should only be shared with managers.

Browser guests reuse a tab-scoped token across reconnects, with eight concurrent connections and 16 distinct guest tracks per recording. Duplicate concurrent identities are rejected, names are sanitized, and reconnect gaps in lossless PCM use sparse silence instead of another file. Discord messages disable mentions by default. Audition/Audacity XML strips forbidden control characters. Autojoin handles voice-channel switches.

An additional reproduced intro-upload bug is fixed: a new upload cannot nominate an existing intro ID and overwrite its PCM. Intro processing is limited to one conversion at a time and requires spare disk capacity. Admission checks recheck pending deployments after asynchronous work so delayed requests cannot start during an update.

Validation: 180 local tests, including multi-server recording survival after export cancellation for disk pressure, permission/signature tampering, guest reconnect/caps, XML, artifact preservation, intro immutability and startup/deployment timing. Live Discord, browser microphones and VPS behavior still require the live-session checklist. No root admin tools changed; deployment remains operator-triggered.

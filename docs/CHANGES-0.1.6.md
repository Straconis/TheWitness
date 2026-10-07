# 0.1.6 — command feedback, shutdown, excerpt quality, and recovery

Reviewed fixes from the October 7 pass. Behavior changes come first. Recording formats, settings validation, access rules, bearer links, and the -16 LUFS / -1 dBTP loudness defaults remain unchanged.

## Behavior changes

- **Commands show deliberate validation messages.** An explicit `UserError` identifies messages written for users, such as retention confirmation requirements and invalid time zones. Unexpected plain errors, TypeErrors, filesystem errors, and Discord API failures stay generic and are logged. Error replies disable mentions. This replaces the proposed plain-Error heuristic.
- **Failed recording starts leave newly joined voice channels.** Manual, automatic, scheduled, and event starts share the same helper. If this request joined voice but no session started, the bot leaves. An existing auto-join connection is kept, and a successfully started session is not disconnected because setting its title failed.

## Fixes

- **Final recording cards reflect graceful shutdown.** Automation stops and recordings finalize before the final panel edit. Every cleanup stage is attempted even if an earlier stage fails. Both automation components are closed independently. An in-flight live panel edit cannot remove the card before its saved/failed update. Regression tests cover ordering, failures, and the panel race.
- **Slash commands register for newly added servers.** Registration failures are isolated per server. Recurring-schedule load failures no longer prevent command registration.
- **Excerpts avoid an extra lossy Opus generation.** WAV, FLAC, MP3, and AAC exports trim in the final conversion. Ogg excerpts still encode trimmed Opus; browser PCM trimming remains intact. Raw recordings remain unchanged.
- **ZIP packaging uses Node's native CRC-32.** Both bounded Discord archives and streamed ZIP64 projects use `node:zlib` CRC-32, supported by the required Node 24 runtime. The recording format's separate Ogg CRC implementation is unchanged.
- **Recovery preserves valid sync-cue metadata.** Original cue IDs, clock/timeline positions, and source-session provenance are retained. Malformed optional metadata is skipped with a warning, preserving the source and allowing recovered audio to export. Only captured cues reach export manifests, as before.

## Excerpt quality evidence

Claude's review reports a comparison using the user's three-hour, six-speaker game recording: before this fix, a five-minute WAV excerpt measured 19–28 dB SNR against the same span decoded from the original Opus on the five tracks containing speech. The review reports that, after the fix, the excerpt PCM was identical to the corresponding span of the full export. These real-session measurements were supplied by Claude, not independently repeated during this release preparation.

The local deterministic regression compares a WAV excerpt with the corresponding span of a full WAV export and requires relative squared error below 1e-6. This verifies removal of the extra lossy generation; it does not imply that Discord Opus itself is lossless.

## Deferred findings

- Browser-guest recovery does not retain separate lossless PCM; defining recovery of its unchecksummed tail needs a deliberate policy.
- Original and browser-edited exports use different mix gain policies (`amix normalize=1` versus `normalize=0`). Final loudness matching compensates when enabled; a common default mixing policy remains undecided.
- Export directories accumulate until their session is deleted or opt-in retention removes it. An opt-in export age limit remains deferred.
- Reconnecting browser guests receive new tracks.
- Abandoned intro-upload directories are not automatically cleaned up.
- A malformed note-modal submission can still produce a generic error instead of a validation message.
- The timer-driven tone test has a reported intermittent timing sensitivity; converting it to explicit arrival timestamps remains deferred.

## Release preparation

Version metadata is 0.1.6 in package.json and package-lock.json. The authorized local scratch directories `work/realtest/` and `work/patched-copy/` were removed. This release is committed locally; pushing and VPS deployment are a separate step to perform when recordings are idle.

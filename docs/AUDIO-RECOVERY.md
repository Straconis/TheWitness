# Audio recovery

Open `/recovery` on the Witness download domain. This is an owner-only feature. Sign in with the existing owner backup key, or open the signed recovery link from Owner admin. A Discord server manager link does not grant recovery access. Recovery uploads do not join a voice channel or start a Discord recording.

1. Give the recording a title and upload a ZIP, files, or a folder.
2. Include the session and all referenced media for Soundcraft or Audition. An Audacity `.aup3` embeds its audio. A Soundcraft `.scraftz` bundle can be uploaded directly.
3. If a ZIP has several backup sessions, choose Soundcraft, Audition, or Audacity in the application selector. For audio-only recovery, select Audio files only: each source becomes a track starting at zero.
4. Once preparation finishes, the browser opens the normal recording download page. Choose speech cleanup, loudness matching, silence trimming, intro, mix, transcription, and export format there. All exports use the existing queue, cancellation, progress, private downloads, and multitrack editor.

The recovery page remembers uploads on the server. To resume an interrupted upload, select the same files or folder and click Resume. After upload completes, the browser can close while audio preparation runs. An interrupted import after a service restart is marked failed with its upload retained for retry. Successful publication is atomic, including after a restart between publishing a recording and saving the final recovery status.

## Supported project content

- **Soundcraft:** native JSON format v1 `.scraft`, or `.scraftz` ZIP; active audio playlists, clip placement and source offsets, static clip/track gain, mute/solo, linear fades, and marker notes. Non-audio tracks are omitted with a warning. Custom stereo panning/routing, buses, inserts, sends, automation, nonlinear fades and stretching require rendered stems.
- **Adobe Audition:** `.sesx` with referenced media; audio clip placement, source offsets, supported static track volume/pan/mute/solo, and marker metadata. Effects, automation, loops, time stretching and clip fades/envelopes require rendered stems. Media references are matched only against uploaded files; absolute project paths never grant filesystem access.
- **Audacity:** saved, closed `.aup3` SQLite projects with embedded int16 or float sample blocks, mono/linked stereo audio, clip trims/offsets, static gain/pan/mute/solo, and label notes. Projects with unsaved autosave recovery, realtime effects, envelopes, pitch/time changes, unsupported multichannel layouts or sample formats report a clear error. Legacy `.aup` projects are not supported; open and save them as `.aup3` in Audacity first.
- **Audio only:** WAV, FLAC, Ogg/Opus, MP3, AAC/M4A. Tracks are prepared as 48 kHz stereo FLAC without an intermediate Opus conversion. Preparation renders supported session edits; “uncut originals” on the normal download page refers to these prepared timeline tracks. Uploaded originals are kept separately until removed.

Unsupported processing is rejected rather than silently approximated. A session clip extending beyond the available source audio is reported on the recovery and recording pages. Missing and ambiguous media names report the affected filename. Keeping folder paths avoids ambiguity when sources have identical basenames.

## Limits and operation

- 32 GiB total upload, 200 selected files, 100 tracks, 500 clips, 24 hours per recovered timeline.
- Archive expansion is capped at 32 GiB, 1,000 usable files and 10,000 entries. Traversal, symbolic links and encrypted archives are rejected. Non-audio extras such as Craig `raw.dat` are ignored.
- Upload chunks are 512 KiB. They fit normal reverse-proxy request limits and support byte-offset retries without duplicating data.
- One project importer runs at a time, in a separate low-priority Python process. On Linux it has a 1 GiB virtual-address limit; this is not a claim of total service memory usage. FFmpeg children inherit that process limit. Audio and sample blocks are streamed. Long clip offsets are streamed as silent prefixes rather than allocated as giant delay buffers.
- Free space is checked at admission and throughout preparation; the configured recording reserve is preserved. Cancelling stops the whole importer process group before removing temporary files. Import preparation has a 24-hour deadline.
- Import state and uploaded originals are under `RECORDING_PATH/recovery/<UUID>/`. Completed sessions are ordinary recording UUID directories with `sourceType: audio-import`, validated `source-track-N.flac` media, notes and provenance. They use the `owner-recovery` scope and do not appear in another Discord server’s dashboard.
- Remove upload deletes the uploaded originals while preserving the recovered recording and listing. Delete recovered recording is an explicit separate action, refused while its exports are busy. No automatic deletion of recovery uploads or recordings is enabled.
- Deployment waits for an active importer to drain. New imports are refused while deployment is pending. Python 3 with SQLite and ZIP support is required; there are no new Python packages.

Audacity binary XML was checked against [ProjectSerializer.cpp at Audacity 3.7.9](https://github.com/audacity/audacity/blob/Audacity-3.7.9/libraries/lib-project-file-io/ProjectSerializer.cpp). `tests/fixtures/audacity-3.7.9-resaved.zip` contains a synthetic two-second project previously opened and saved by the checksum-verified official Audacity 3.7.9 AppImage; it exercises native numeric attributes, UTF-32 dictionary strings, empty effect racks and linked stereo metadata. It contains no user recording.

Validation covers three-format lossless imports and normal exports, actual Audacity resave metadata, exact nonzero clip offsets/trims, upload restarts and chunk retries, missing media, unsafe archives, unsupported automation, cancellation, restart cleanup, owner authentication, origin checks and explicit deletion. Browser QA uploads the Audacity fixture, follows the automatic redirect to the normal recording page, enables speech cleanup/loudness matching and completes a FLAC export through the normal queue.

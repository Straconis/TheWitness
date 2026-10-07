# 0.1.5 — configurable loudness, recording duration, and hardening

Fixes from a source review. Behavior changes are listed first; nothing here alters the on-disk recording format.

## Behavior changes

- **Configurable Match Loudness exports.** Target loudness and true peak controls default to -16 LUFS and -1 dBTP. Separate speakers and the final mix use two-pass loudness matching; raw audio is preserved and retries retain the chosen settings.
- **Configurable recording duration.** Servers can choose 2, 4, 6, 8, 12, 16, or 24 hours, with warnings before the selected cutoff. The default remains 8 hours.

- **Browser microphone sockets stay connected behind nginx.** The server now pings each socket every 25 s. nginx closes a WebSocket whose upstream is silent for `proxy_read_timeout` (120 s in the setup scripts), and this socket never sends anything down. Dead peers are terminated instead of holding a slot.
- **At most 8 browser guests per recording** (`MAX_BROWSER_GUESTS`). The 9th gets `429`.
- **Guest audio is shed first.** When more than 8 MiB of audio is waiting to be written, browser-guest frames are dropped (counted as `guestFramesDropped` in `session.json`) instead of failing the whole session at 16 MiB. Discord audio is unaffected.
- **Voice reconnect keeps trying for roughly five minutes** (`DEFAULT_RECONNECT_DELAYS`), instead of giving up after about a minute and marking the session `failed`.
- **Critical disk space stops recordings cleanly.** Below `CRITICAL_DISK_MIB` (default 256, capped at half of `LOW_DISK_WARNING_GIB`, `0` = off) active recordings are finalized with `stopReason: "low-disk"`, new recordings are refused, and queued exports pause until space is freed.
- **The export queue recovers from storage errors.** It retries after 30 s instead of staying dead until restart.
- **`CLOUD_UPLOAD_GUILD_IDS`** (comma-separated server IDs) limits who may upload to the owner's cloud accounts. Empty keeps the old behavior (every server).
- **Recovery skips malformed session metadata.** Files are preserved for salvage; settings still fail validation instead of silently resetting access controls.
- **Exports and transcription run at lowered CPU priority** (nice 10), so they compete less with live recording.

## Deployment

- `deploy-github.sh` prunes old releases after a successful deploy. It keeps the live release, the rollback target, `baseline.*`, and the three newest others.
- The deploy workflow ignores pushes that only touch `*.md`, `docs/**` or `licenses/**`, so a README edit no longer blocks new recordings while it waits for idle.

## Smaller fixes

- Request bodies are collected as bytes, so multi-byte characters split across network chunks are no longer corrupted.
- `.env.example`: removed duplicate keys, added `DROPBOX_ACCESS_TOKEN`, `DOWNLOAD_BIND_HOST`, `CLOUD_UPLOAD_GUILD_IDS`, `CRITICAL_DISK_MIB`.

## Not changed (needs a decision or a networked machine)

- `@types/node` is `^26` while `engines` pins Node 24. Run `npm install -D @types/node@^24` and commit both `package.json` and `package-lock.json`.
- Browser guest PCM is stored as duplicated stereo (about 690 MB per guest-hour). Switching to mono changes the on-disk format and needs coordinated export/salvage/normalization changes plus a format marker for older recordings.
- Whisper still runs over silent stretches (possible hallucinated text) and uses non-overlapping 5-minute chunks.
- Access defaults to "everyone", so any member can run `/autojoin` and turn on auto-record. Consider defaulting hosted servers to role-restricted access.
- nginx: `proxy_read_timeout 120s` is now fine because of the pings. HSTS and a systemd unit with resource limits are not in the repo.

## Review decisions and loudness matching

Accepted with corrections: preserve configurable duration and warning timers; check disk every 10 seconds and before new recordings and queued exports; stop independent servers together; enforce the cloud allowlist at upload time; retry final job metadata writes without repeating completed uploads; return malformed dashboard JSON as a client error.

Rejected automatic settings reset/quarantine: discarding invalid settings can turn role-restricted access into unrestricted access. Strict validation remains. Recording formats are unchanged. Guest shedding is best effort under backpressure, not a guarantee against disk failures. Release cleanup affects deployment artifacts only.

Speaker and final mix normalization use two-pass gated LUFS matching (configurable target and true peak, default -16 LUFS / -1 dBTP, maximum 20 dB boost), with settings persisted for retries and measured results in the export manifest. Intro matching uses LUFS and a true peak cap. Original/raw tracks remain intact. Rebuild FFmpeg with the updated script to enable loudnorm and the null muxer before deploying this version. Very short clips without a valid integrated measurement remain unchanged.

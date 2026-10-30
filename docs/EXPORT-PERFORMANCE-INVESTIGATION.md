# Export profiling and reuse investigation

## Verified current behavior

`src/exports/jobs.ts` already deduplicates queued/running exports and reuses completed results with identical request settings. It checks session identity/start/title and the existence of nonempty regular track/mix/archive files. Changed settings or missing artifacts cause a fresh render. Cloud uploads and transcription are excluded from completed reuse. `tests/reuse-export.test.cjs` verifies reuse after restart, no duplicate disk copies, missing-file fallback, changed settings and cross-guild rejection.

`src/exports/storage.ts` normally retains exports for 48 hours, jobs for seven days, and retains editor sources/dependencies longer. This is age-based retention, not a strict total-byte cache budget. Do not call the current retention a bounded cache.

Cross-format requests do not match. `src/exports/export.ts` converts into the requested codec before cleanup, silence editing and loudness matching. That means a finished FLAC is not automatically equivalent to a fresh MP3 or WAV export. `edited-export.ts` can render from an explicit previous export, but that editor flow is not a transparent format cache.

## Stage measurements added locally

`stage-profile.ts` collects monotonic elapsed wall milliseconds and segment counts at sequential progress boundaries. `jobs.ts` persists these under `stageTimings` and writes one `[Export stages]` JSON log per finished attempt, including failures/cancellations. Buckets separate synchronization, uncut-original encoding, conversion/editing, cleanup, silence analysis/cutting, loudness, intro, mix, project construction, ZIP packaging and optional transcription/upload. Preparation and unidentified boundaries have separate buckets. No speaker names, audio or tokens are stored by the profiler. Failed/retried attempts start a new timing profile.

These are elapsed intervals, not CPU time or exact function-level profiling. Loudness includes its measure/render/re-measure passes. Native project callbacks can split project time between project and other buckets; aggregate all buckets when checking total. This ledger assumes the current sequential pipeline: parallel workers will require per-operation spans or explicitly overlapping timings. A process crash can lose time since the last existing job save; no additional write timer is introduced.

Run `npm run build`, then `node scripts/profile-export-stages.cjs`. This creates and removes an isolated synthetic recording, never configured production storage. The first local two-speaker/five-second FLAC + raw + mix + cleanup + loudness sample measured:

| Stage | Wall time |
|---|---:|
| Loudness (two speakers and mix) | 2.884 s |
| Cleanup | 0.729 s |
| Original-track conversion | 0.131 s |
| Packaging | 0.076 s |
| Mixing | 0.062 s |

Raw JSON: `work/stage-profiling/sample.json`. Short synthetic tones validate coverage; they cannot rank stages reliably for real multi-hour speech, intros, silence cuts or native projects. The earlier seven-speaker/30-second scaling experiment also showed loudness dominating cleanup (`work/auto-workers/REPORT.md`). Profile a representative long local/staging export next, with the requested settings, before selecting another DSP optimization.

Validation: TypeScript build; three profiler tests including persisted completed/failed jobs; two cancellation/tool-control tests; 17 existing reuse/queue/sequential-export tests passed. No deployment performed.

## Recommended reuse design for independent review

Start with existing lossless artifacts rather than an extra full-session audio cache. The narrow first opportunity is packaging the same processed FLAC tracks into another project container with identical processing and track format. Hard links are safe only for immutable files and only where subsequent writes always use temporary-file/rename; otherwise copy within the normal export reservation. Each new archive still consumes disk and must pass normal preflight/live checks. Preserve all metadata, notes, intro handling, mix and project-specific format constraints.

For arbitrary output formats, establish a canonical lossless processing path first, then encode destination formats from it. That changes the pipeline and must be compared with fresh exports for loudness/true peak, sample count, silence/edit alignment and quality. Never silently use a lossy export as the canonical source. Exact byte equality across different codecs is not an appropriate expectation. Existing matching completed downloads should continue bypassing all processing.

A reuse key must bind guild/session, immutable source revision or verified fingerprint, DSP/tool/preset versions, track identity, cleanup, loudness target/peak, silence settings and speaker selection, excerpts/edits, intro content/version/normalization and any timing-affecting settings. Display metadata and notes must be refreshed or keyed separately. Existing job equality alone has no comprehensive source/tool revision key and should not be extended blindly to cross-format reuse. Historical exports lacking a validated key should miss safely.

For an optional dedicated regenerable cache, an initial proposal is disabled by default, 1 GiB hard payload cap, 24-hour expiry, and per-entry admission that skips entries exceeding the cap. These are proposed budgets, not validated production settings. Reuse existing immutable artifacts first; do not expand normal retained exports to fill this cache. Maintain an atomic size-accounted index, LRU eviction of unpinned entries before admission, count temporary writes against the cap, preserve the recording disk reserve and decline caching when budget cannot fit. Pin sources through rendering/packaging; coordinate pruning, session deletion and maintenance under the same lock. Explicit source-export references need retention protection just like editor dependencies. Do not evict editor projects, raw recordings, user uploads or active job data to satisfy a cache budget. Reconcile orphaned temporary/index entries on startup. A cache miss, corruption or eviction must fall back to the normal exporter.

Tests needed before enabling: cross-guild denial; every processing setting and source/tool change invalidates; intro replacement; immutable sources unchanged; matching lossless packaging; lossy source refused; failure/cancel drains writers and releases pins; pruning/deletion races; no eligible eviction target; oversized entry skipped; concurrent admissions obey total-byte cap; stale/missing/corrupt index recovery; low disk fallback; output alignment/loudness and representative long-recording memory/disk behavior.

No new cache is implemented by this investigation. Compare independent review findings before committing to a canonical pipeline or retention policy.

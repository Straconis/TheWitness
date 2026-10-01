# Improvements for the rebuild

Implemented in the latest sweep:

- Recording date/time download names, with a saved server preference and a
  per-download switch to original filenames.
- Adobe Audition project ZIPs: named speaker tracks, relative media references,
  correct clip lengths, ZIP64 disk streaming and large WAV support.
- Reliable cancellation of reconnects during stop/shutdown.
- One job for concurrent matching export requests.
- Preserve and skip corrupt export-job metadata while other jobs resume.
- Protect sample-zero audio timestamps from being misread as Ogg headers.

Added in the following sweep: session titles, notes as Audition XMP markers,
and disk-space monitoring/alerts. Audition marker display still needs testing.

Further improvement ideas:

1. Session titles and tags, such as campaign and episode, alongside date/time.
   This would make dashboards and downloaded projects easier to find later.
2. Export session notes as Audition timeline markers, so story beats and edit
   points appear in the editor instead of only in the notes file.
3. Disk-space status and early low-space alerts, with cleanup always explicit or
   opt-in. Avoid surprise deletion of recordings.
4. Visible per-speaker packet/drop diagnostics after recording, to distinguish
   connection problems from microphone problems.
5. Cancel/retry controls for export jobs, with original recordings preserved.

Pending real-application checks: a Discord group recording, opening the generated
SESX session in Audition, a real browser microphone, and hosting-image/public
HTTPS compatibility. Passing local fixtures does not replace these checks.

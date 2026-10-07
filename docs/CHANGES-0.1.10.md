# 0.1.10 — failures-only operator logs

The operator portal adds a **Show → Failures only** filter. Refresh, live updates and log downloads honor it alongside the time window and text search. It uses journal priorities 0–3 and recognizable error/failure messages, keeping adjacent stack-trace lines. It filters the latest 1,000 service records; it is a diagnostic view rather than a complete separate error archive. Messages without severity or recognizable error wording may be missed.

Includes the 0.1.9 export-delivery reply fixes, which had not reached the VPS before this release.

The export-cancellation test now waits for its deliberately hung fake exporter to start before cancelling, preventing a race where the retry accidentally ran the fake exporter's first attempt. Production cancellation behavior is unchanged.

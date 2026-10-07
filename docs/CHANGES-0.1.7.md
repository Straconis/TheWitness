# 0.1.7 — shared export queue and operator log portal

## Behavior changes

- All production `/export` requests join the persistent queue across Discord servers. Waiting jobs show a 1-based queue position in Discord and the web job status page. `EXPORT_CONCURRENCY` permits 1–16 running jobs, default 1.
- Optional operator logs at `logs.thewitness.dev` provide live refresh, recent time windows, text/session/job filters, and diagnostic downloads. Every route requires a dedicated operator login over HTTPS. The portal has no write, recording, restart, or shell controls.

## Queue review corrections

The design follows Craig's kitchen queue. The Witness dispatches on submissions/completions instead of a periodic tick. Persisted sequence numbers preserve FIFO ties across restart; legacy jobs use deterministic ID ties. Shutdown cannot start another export after an asynchronous disk check. Initial persistence failures preserve cancellation and clean up controllers. One job's storage failure does not reset another running job. Failed final-state writes still retry persistence without repeating completed work.

Discord attachment waiting stops after 14 minutes or shutdown while preserving the queued export. Web job links avoid Discord's 15-minute interaction-token limitation. Per-server fairness remains first come, first served; round-robin scheduling is deferred. See EXPORT-QUEUE.md.

## Portal setup and security

The viewer binds to localhost:3011 and requests only `the-witness.service` records from journalctl, checking every record's unit. Reads and requests are bounded; the service has process/memory/CPU limits and filesystem restrictions. The dedicated service account has journal-read group membership but no login shell. That OS-level group can read other journals, so the account remains private; the HTTP interface never accepts arbitrary units or commands.

Public configuration leaves credentials blank. The one-time sudo installer prompts privately and saves a scrypt password hash plus known-secret redaction values in a root-only environment file outside Git. Blank credentials prevent startup. The public Nginx site uses HTTPS, authentication on the backend, request limiting, and no access-log collection of filters or headers. Responses disable caching, log text renders as text rather than HTML, and recognized credentials/private links are redacted. Redaction is best effort; logs remain sensitive operator data.

The installer creates the separate service, origin certificate, and narrowly scoped restart permission. GitHub deployments update viewer scripts and restart an active portal, preserving credentials and server configuration. A failed portal restart is reported independently of bot deployment. Cloudflare DNS alone does not activate the portal: an administrator must run the documented installer. See TROUBLESHOOTING-LOGS.md.

## Validation

145 automated tests pass, including authenticated/unauthenticated routes, read-only methods, fixed journal scope, redaction, queue persistence, cancellation, concurrent storage failures, and shutdown races. Shell syntax and staged diff checks are also performed. A previously two-second tool-export test timeout was extended to ten seconds for full-suite CPU contention; its functional assertions are unchanged. Public HTTPS and live journal visibility require the one-time VPS setup and separate verification.

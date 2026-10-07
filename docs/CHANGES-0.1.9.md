# 0.1.9 — export delivery messages

Exports attached directly in Discord now keep the job ID in every queue-position update. When the reply stops waiting after 14 minutes or during shutdown, it explains that the job is preserved and shows the `/exportjob action:status` command with the job ID.

A failed initial queue notification no longer aborts attachment delivery or reports a queued export as a processing failure. Final notification failures are logged without discarding the saved job. Live Discord behavior still needs verification.

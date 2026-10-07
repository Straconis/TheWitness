# 0.1.18 — export diagnostics and cloud-account concurrency

Failed queued exports now log their job ID and error at the queue, including the normal download-service path. Operators can find these failures in the log portal. Normal cancellation and shutdown remain separate from failures.

Cloud-account refresh, OAuth completion and disconnect operations share a credential-file lock across account instances in the bot process. A slow refresh can no longer overwrite a newly connected account or recreate credentials after an in-process disconnect. Different data roots/providers remain independent; settled locks are removed.

Regression tests first reproduced the missing failure log and stale-account overwrite against the preceding code. Added coverage also checks disconnect ordering and cancellation/shutdown logs. The bot remains one process per recording directory; owner CLI account changes should be performed with the bot stopped because the credential lock does not span OS processes. No protected root tools changed.

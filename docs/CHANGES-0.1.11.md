# 0.1.11 — crash diagnostics and review follow-ups

The operator portal now includes trusted systemd crash/OOM and core-dump records for Witness, including in **Failures only**, while rejecting other services and forged unit references. The setup script computes the password hash inline, and `--refresh-redactions` updates known-secret values without rotating the operator login.

Discord attachment replies now change from a queue position to processing when a waiting export starts and explicitly report cancellation. Icon-only asset pushes now trigger deployment; route checks cover favicon/PNG/touch-icon bytes, HEAD and mutation rejection.

The Cloudflare edge-address rate-limit limitation remains documented pending a root-owned nginx change. A real systemd EnvironmentFile round trip passed for backslashes, dollar signs, quotes, Unicode and newlines. Live Discord replies, OBS sync and crash/OOM behavior still need real-session validation; the review did not kill or crash the running bot.

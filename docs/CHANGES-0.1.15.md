# 0.1.15 — separate deployment from root administration

GitHub deployment and bot execution move to the dedicated witness-deploy account with only exact service-restart sudo permissions. Administrator SSH remains on straconis. Reviewed root maintenance tools are installed separately under root-owned paths and never replaced by application deployments. Operator commands use the witness-admin dispatcher with isolated Python and a fixed working directory/PATH.

Download setup runs application checks and environment writes as the deployment user. Redaction snapshot reads reject symlinks/special files and impose a size limit. A one-time checksum-pinned migration preserves administrator SSH keys and includes rollback snapshots.

Portal login username changes to watcher while retaining its existing password. Regression checks cover private-field preservation and restart rollback. No unattended root-tool update mechanism is enabled.

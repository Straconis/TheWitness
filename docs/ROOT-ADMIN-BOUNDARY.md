# Root administration and deployment separation

GitHub deploys and the bot runs as witness-deploy, a dedicated Linux account without general sudo access. Its SSH key is restricted to the deployment command, and its root-owned home/authorized_keys cannot be changed by application code. Only exact bot/portal restart commands are permitted through sudo; both services execute as non-root users. The administrator continues using straconis over SSH. Portal authentication is separate; its username is watcher and the existing password is retained.

Use the root-owned /usr/local/sbin/witness-admin dispatcher for privileged maintenance:

- sudo witness-admin log-setup
- sudo witness-admin refresh-redactions
- sudo witness-admin cloudflare-ips
- sudo witness-admin cloudflare-check
- sudo witness-admin portal-username watcher
- sudo witness-admin deployment-status
- sudo witness-admin downloads-domain (or downloads-ip)
- sudo witness-admin deploy-permissions

The underlying tools are frozen reviewed copies in /usr/local/libexec/the-witness-admin. GitHub deployments do not install or update them. Root-tools updates require an explicitly reviewed checksum-pinned bundle copied into a root-only directory, verified there, then installed by the administrator. Do not execute repository/application/home-directory scripts directly with sudo.

The dispatcher fixes PATH, changes to /, clears Python/shell path variables and uses isolated Python. Download setup runs deployment-controlled Node checks and .env writes as witness-deploy rather than root. Redaction reads reject symlinks, special files and oversized bot configuration. The certificate runtime remains root-owned.

The one-time migration preserves operator SSH keys and reuses the existing GitHub deployment public key in the dedicated account. It blocks new work, refuses while recordings/exports are active, snapshots unit/key/policy/ownership state, changes the service/account ownership of both /opt/the-witness and the external /var/lib/the-witness/recordings data tree and restarts the bot. Rollback restores prior policy/key/unit/ownership if migration fails. Root-tool installation itself does not change credentials or restart services. The portal username update preserves the hash/redactions and rolls back on failed restart.

This separation limits repository push access to unprivileged application/deployment code. It does not protect recordings or logs from malicious application code, and does not restrict the human administrator's sudo privileges. Cloudflare ranges remain a snapshot: refresh during periodic maintenance or after announced changes.

The current VPS was verified on 2026-10-07 with `dev.tty.legacy_tiocsti=0`, disabling legacy terminal keystroke injection. Verify this setting before using the tools on another host: `sysctl dev.tty.legacy_tiocsti` should report `0`, or the key should be absent on a kernel without that interface. A host that enables it needs terminal isolation for the unprivileged `runuser` steps or administrator configuration to disable the feature first.

Download administration uses a read-only, no-follow regular-file open of the existing deployment lock and retains that lock throughout setup. It refuses busy, missing, symlink or special-file locks before changing settings. Root-tool updates remain manual even when application releases are deployed.

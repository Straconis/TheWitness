# Operator logs

The VPS runs The Witness as `the-witness.service`. Standard output and errors go to the systemd journal, including recording, reconnect, export, storage, command, startup, and shutdown diagnostics. The VPS has persistent journal storage, so service restarts do not erase those logs. Journal retention is managed by the host; logs are not kept forever.

These are hosting-wide operator logs, including diagnostics from multiple Discord servers. Read them over administrator SSH. They are not exposed through server dashboard bearer links.

## Connect and follow the log

```sh
ssh straconis@198.44.123.167
sudo journalctl -u the-witness.service -f -o short-iso
```

Press Ctrl+C to stop following. This does not stop the bot. The `sudo` prompt uses the VPS account password, not the VM's SSH-key passphrase. The ordinary hosting account cannot directly read the system journal.

Recent diagnostics and the current service state:

```sh
sudo journalctl -u the-witness.service --since '1 hour ago' --no-pager -o short-iso
systemctl status the-witness.service --no-pager
systemctl show the-witness.service -p ActiveState -p SubState -p NRestarts -p MainPID
cat /opt/the-witness/.releases/current-revision
```

For a specific incident, replace the time window with explicit dates and times. `short-iso` prints the host's time-zone offset. Note the affected session or export job ID and the time of the failure so its messages can be located.

Use the complete service log first: application `console.error` output is not necessarily tagged with journald's error priority, so filtering only by journal priority can omit useful diagnostics.

## Save a private diagnostic snapshot

Run on the VPS:

```sh
umask 077
sudo journalctl -u the-witness.service --since '2 hours ago' --no-pager -o short-iso > witness-service.log
```

The snapshot is readable only by its owner. Review it before sharing: diagnostics may contain server, participant, recording, file-path, or error details. Never include `.env`, SSH keys, or cloud account files in a report.

## Deployment failures

Build/test failures and SSH deployment output live in the repository's [GitHub Actions history](https://github.com/Straconis/TheWitness/actions). A build or test failure skips deployment. If the service fails after deployment, the deployment script attempts rollback; check both the Actions run and the service journal.

A deployment waits for active recordings and exports to finish. Check the current deployment state without changing recordings:

```sh
cd /opt/the-witness
node scripts/deploy-idle.cjs
```

This check reports busy work using its exit status; a successful idle check can be silent. Do not restart the bot just to obtain logs.

## Web portal setup

DNS for `logs.thewitness.dev` points to the VPS through Cloudflare. Keep Cloudflare SSL/TLS in Full (strict) mode; the setup issues a Let's Encrypt origin certificate using the existing Certbot installation and renewal timer.

On the VPS, after installing the portal scripts, run:

```sh
sudo bash /opt/the-witness/scripts/enable-log-portal.sh
```

The script asks for an operator username and a password of at least 16 characters, without printing the password. This login is separate from Discord and SSH credentials. It stores a scrypt hash, username, and known-secret redaction values in a root-only environment file at `/etc/the-witness-log-portal.env`. The public example leaves credentials blank. Re-running setup rotates the login credentials. Restarting the service applies manual configuration changes.

The portal uses the browser's HTTP Basic login prompt over HTTPS. It polls every five seconds while the tab is visible, with bounded records and request concurrency, and provides a redacted text download. It has no recording, restart, deletion, file browsing, or shell controls. Every data and UI route requires login. Unknown journal units and arbitrary command arguments are never accepted from the browser.

The service account `witness-logs` has journal-read group membership and no login shell. The application restricts reads to the fixed Witness service and checks each returned record's unit; it runs with a read-only filesystem, restricted process resources, and no privilege escalation. That journal group grants OS-level journal read access, so the service account must remain private. Credentials and private signed URLs are redacted where recognized; other log contents may still include private participant or server information.

GitHub deployments copy updated viewer code and restart the portal when it is active. Root-owned credentials, certificates, and service configuration are preserved. The one-time setup adds a sudo rule for that specific service restart only.

Check the portal itself over SSH:

```sh
systemctl status the-witness-log-portal.service --no-pager
sudo journalctl -u the-witness-log-portal.service --since '1 hour ago' --no-pager
```

In the operator portal, select **Show → Failures only** to focus on journal error priorities and recognizable error messages, including adjacent stack traces. The text filter, time window, live refresh and download apply to this view. It searches the latest 1,000 service records, so use the full journal over SSH for older records or errors that were not labeled clearly.


Systemd's own crash, OOM and core-dump messages for Witness appear alongside the bot's messages. The portal verifies their journal-supplied source fields before accepting them. **Failures only** includes those failures; ordinary start/restart lifecycle messages remain available under **All records**.

After rotating or adding bot secrets, refresh the exact-value redaction snapshot without changing the portal login:

```sh
sudo bash /opt/the-witness/scripts/enable-log-portal.sh --refresh-redactions
```

This reads the bot configuration, preserves the existing username/hash, atomically replaces the root-only portal environment file and restarts the portal. Do not print the environment file or inspect service environment values when diagnosing startup; use service state and its journal instead.

The nginx rate limit currently counts Cloudflare edge addresses. Per-visitor limiting requires a root-owned nginx configuration change that trusts only Cloudflare's published source ranges before accepting its client-IP header. Authentication remains required for proxied and direct origin requests.

Redaction refresh recognizes quoted multiline dotenv secrets, exported assignments, escaped newlines and comments following unquoted values. Individual multiline secret lines are also included for exact-value redaction when journal records split them. Redaction remains best-effort; refresh the snapshot whenever secrets change.

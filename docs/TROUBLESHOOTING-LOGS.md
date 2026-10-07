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

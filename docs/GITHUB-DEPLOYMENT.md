# GitHub deployment

Every push to `main` runs `.github/workflows/deploy.yml`. The workflow installs
Node 24, builds the application, runs the test suite, and packages a release.
A failed build or test does not change the VPS. Manual runs are also available.

GitHub repository secrets:

- `WITNESS_VPS_SSH_KEY`: dedicated deployment key, restricted on the VPS to
  `/opt/the-witness/scripts/deploy-github.sh` with SSH forwarding and PTYs disabled.
- `WITNESS_VPS_KNOWN_HOSTS`: verified VPS SSH host keys.

The VPS uses its existing FFmpeg, whisper executable and models. Releases contain
compiled code and production dependencies, stored under `/opt/the-witness/.releases`.
The deployed `dist` and `node_modules` point to the current release. `.env`,
recordings, private-link keys, server settings and audio models stay in place.
The revision is recorded in `.releases/current-revision`; old releases are kept
for rollback and may need occasional cleanup as disk space fills.

One-time administrator setup:

```sh
sudo bash /opt/the-witness/scripts/enable-github-deploy.sh
```

This adds a narrowly scoped sudo rule allowing `straconis` to restart only
`the-witness.service`. It does not grant arbitrary passwordless sudo.

Deployments hold a lock and wait up to 30 minutes for active recordings and export
jobs to finish. New work is paused during this wait after the deployment-aware code
is installed. On the first update, existing code does not yet understand the pause
marker, so perform the initial deployment while the bot is idle. A pause marker
expires after 40 minutes if a deployment crashes.

The service restarts after the release is selected. The deployer checks it stays
active with the same process ID across two checks, and restores the previous
release if restart/startup fails. This is a process health check; it does not prove
a live Discord voice session or web route works. GitHub Actions reports errors.
If the bot stays busy for 30 minutes, the deployment fails without replacing code;
rerun it when idle. Waiting runs are serialized and each successful push deploys.

To stop automatic updates, disable the workflow in GitHub Actions. To remove VPS
restart permission, remove `/etc/sudoers.d/the-witness-github-deploy` as administrator.
Source files in the local VM remain the editing workspace; production source for
each deployment is stored with that release. Successful releases also update the stable deployment helper scripts for future pushes.

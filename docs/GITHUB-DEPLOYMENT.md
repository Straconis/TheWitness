# GitHub deployment

Deployment requires an explicit operator command; pushes do not update the VPS.
The separate test workflow still checks pushes and pull requests without VPS access.
Run this from an authenticated GitHub CLI when ready:

```sh
gh workflow run deploy.yml --repo Straconis/TheWitness --ref main
```

Alternatively choose **Run workflow** in GitHub Actions. The deployment job runs
only when the selected ref is `main`; runs dispatched for other refs are skipped.
For an accepted run, it installs Node 24, builds the application, runs the test
suite, and packages a release.
A failed build or test does not change the VPS.

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

Deployment uses the dedicated `witness-deploy` account; administrator SSH remains on `straconis`. See [the root administration boundary](ROOT-ADMIN-BOUNDARY.md) for the reviewed migration and protected tools. Do not run application-directory scripts with sudo.

Administrator permission maintenance after the protected tools are installed:

```sh
sudo witness-admin deploy-permissions
```

This adds a narrowly scoped sudo rule allowing `witness-deploy` to restart only
`the-witness.service` and `the-witness-log-portal.service`. It does not grant arbitrary passwordless sudo.

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
rerun it when idle. Deployments are serialized. Each manual run tests and deploys
the revision selected when that run starts; later pushes require another run.

Download administration holds the same deployment lock, so it cannot overlap
a deployment or clear its recording pause. Manual deployment control complements
this locking; it does not replace it.

To remove VPS
restart permission, remove `/etc/sudoers.d/the-witness-github-deploy` as administrator.
Source files in the local VM remain the editing workspace; production source for
each deployment is stored with that release. Successful releases also update the stable deployment helper scripts for future pushes.

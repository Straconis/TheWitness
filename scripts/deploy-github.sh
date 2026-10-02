#!/bin/bash
# Forced SSH command: receive a tested GitHub release, switch code, and roll back failures.
set -euo pipefail
export DOTENV_CONFIG_QUIET=true
export PATH=/usr/local/bin:/usr/bin:/bin
app=/opt/the-witness
service=the-witness.service
cd "$app"
mkdir -p .releases
exec 9> .releases/deploy.lock
flock -n 9 || { echo 'Another deployment is in progress.' >&2; exit 1; }
IFS= read -r revision
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo 'Invalid release revision.' >&2; exit 1; }
release=$(mktemp -d "$app/.releases/$revision.XXXXXX")
archive=$(mktemp "$app/.releases/upload.XXXXXX")
cleanup() {
  rm -f "$archive"
  if [[ "${pending:-false}" == true ]]; then
    (cd "$app" && node "$release/scripts/deploy-idle.cjs" clear) || true
  fi
}
trap cleanup EXIT
cat > "$archive"
# Archive paths and links must stay inside the release directory.
python3 - "$archive" "$release" <<'PY'
import sys, tarfile
with tarfile.open(sys.argv[1], 'r:gz') as package:
    package.extractall(sys.argv[2], filter='data')
PY
rm -f "$archive"
test -f "$release/dist/index.js"
test -d "$release/node_modules"
# Reuse VPS-specific audio executables/models, rather than replacing them with CI tools.
test -x "$release/bin/oggcorrect"
for tool in ffmpeg whisper-cli models; do ln -s "$app/bin/$tool" "$release/bin/$tool"; done
cd "$release"
node - <<'JS'
if (Number(process.versions.node.split('.')[0]) !== 24) throw Error('Node 24 required');
// ensureOpusBinding: Opus includes the glibc version in its lookup path.
// A binary built against the older CI glibc works on this newer Debian glibc,
// but must be placed at the path computed for the production host.
const fs=require('node:fs'),path=require('node:path');
const packageFile=require.resolve('@discordjs/opus/package.json');
const packageRoot=path.dirname(packageFile);
const expected=require('@discordjs/node-pre-gyp').find(packageFile);
if(!fs.existsSync(expected)){
 const candidates=fs.readdirSync(path.join(packageRoot,'prebuild')).filter(name=>name.includes(`-${process.platform}-${process.arch}-glibc-`));
 if(candidates.length!==1)throw Error('Cannot select the production Opus binding');
 const binding=path.join(packageRoot,'prebuild',candidates[0],'opus.node');
 fs.mkdirSync(path.dirname(expected),{recursive:true});fs.copyFileSync(binding,expected);
}
const {OpusEncoder}=require('@discordjs/opus');new OpusEncoder(48000,2).encode(Buffer.alloc(3840));
require('@snazzah/davey');
const {downloadName}=require('./dist/downloads/names');
if(downloadName('project.zip',{startedAt:'2026-10-01T12:00:00Z'},'date')!=='2026-10-01.zip')throw Error('ZIP naming smoke check failed');
JS
cd "$app"
# Verify permission before touching the running release.
sudo -n -l /usr/bin/systemctl restart "$service" >/dev/null
# Block new recordings/exports before waiting for current work to drain.
node "$release/scripts/deploy-idle.cjs" prepare
pending=true
# Wait up to 30 minutes for saved recording/export state to become idle.
for attempt in $(seq 1 180); do
  if node "$release/scripts/deploy-idle.cjs"; then break; fi
  if [[ "$attempt" == 180 ]]; then echo 'Deployment postponed: recordings or exports remain active.' >&2; exit 1; fi
  sleep 10
done
old_dist=$(readlink -f dist)
old_modules=$(readlink -f node_modules)
# Preserve the first installed payload as a rollback release.
if [[ ! -L dist ]]; then mv dist ".releases/original-dist-$revision";old_dist="$app/.releases/original-dist-$revision";ln -s "$old_dist" dist;fi
if [[ ! -L node_modules ]]; then mv node_modules ".releases/original-modules-$revision";old_modules="$app/.releases/original-modules-$revision";ln -s "$old_modules" node_modules;fi
switch_link() { ln -s "$2" "$1.next"; mv -Tf "$1.next" "$1"; }
rollback() {
  echo 'Deployment failed; restoring previous release.' >&2
  switch_link dist "$old_dist"
  switch_link node_modules "$old_modules"
  sudo -n /usr/bin/systemctl restart "$service" || true
}
trap 'rollback' ERR
switch_link dist "$release/dist"
switch_link node_modules "$release/node_modules"
sudo -n /usr/bin/systemctl restart "$service"
sleep 15
systemctl is-active --quiet "$service"
# Restart loops can briefly look active; require the same process to survive.
pid=$(systemctl show "$service" -p MainPID --value)
[[ "$pid" != 0 ]]
sleep 15
systemctl is-active --quiet "$service"
[[ "$(systemctl show "$service" -p MainPID --value)" == "$pid" ]]
# Keep the stable forced-command entry point synchronized for future pushes.
for helper in deploy-github.sh deploy-idle.cjs enable-github-deploy.sh; do
  install -m 0755 "$release/scripts/$helper" "$app/scripts/$helper.next"
  mv -f "$app/scripts/$helper.next" "$app/scripts/$helper"
done
trap - ERR
printf '%s\n' "$revision" > .releases/current-revision
printf 'Deployed %s\n' "$revision"

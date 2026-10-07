#!/bin/bash
# Administrator step. Allows only the bot and portal service restarts.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
printf '%s\n' 'witness-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart the-witness.service, /usr/bin/systemctl restart the-witness-log-portal.service' > "$tmp"
visudo -cf "$tmp"
install -o root -g root -m 0440 "$tmp" /etc/sudoers.d/the-witness-github-deploy

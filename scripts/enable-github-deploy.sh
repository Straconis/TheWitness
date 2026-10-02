#!/bin/bash
# One-time administrator step. Allows only this service's restart.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
printf '%s\n' 'straconis ALL=(root) NOPASSWD: /usr/bin/systemctl restart the-witness.service' > "$tmp"
visudo -cf "$tmp"
install -o root -g root -m 0440 "$tmp" /etc/sudoers.d/the-witness-github-deploy

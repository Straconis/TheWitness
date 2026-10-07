#!/usr/bin/env bash
# One-time operator setup. Password input is hidden and never written to Git.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo in your SSH terminal.' >&2; exit 1; }
mode=${1:-setup}
[[ "$mode" == setup || "$mode" == --refresh-redactions ]] || { echo 'Usage: enable-log-portal.sh [--refresh-redactions]' >&2; exit 1; }
app=/opt/the-witness
host=logs.thewitness.dev
for program in nginx python3 journalctl systemctl; do command -v "$program" >/dev/null; done
test -f "$app/scripts/log-portal.py"
test -x /opt/the-witness-certbot/bin/certbot
# Generate private configuration before opening the public hostname.
python3 - "$mode" <<'PY'
import getpass, hashlib, json, os, re, secrets, sys
from pathlib import Path
filename=Path('/etc/the-witness-log-portal.env')
refresh=sys.argv[1]=='--refresh-redactions'
if refresh:
 if not filename.is_file():raise SystemExit('Portal is not configured; run enable-log-portal.sh setup first.')
 existing=dict(line.split('=',1) for line in filename.read_text().splitlines() if '=' in line)
 username=existing['LOG_PORTAL_USERNAME'];password_hash=existing['LOG_PORTAL_PASSWORD_HASH']
 if not username.isascii() or not username.replace('_','').replace('-','').isalnum():raise SystemExit('Invalid existing username.')
 parts=password_hash.split('$')
 if len(parts)!=3 or parts[0]!='scrypt' or len(bytes.fromhex(parts[1]))!=16 or len(bytes.fromhex(parts[2]))!=32:raise SystemExit('Invalid existing password hash.')
else:
 with open('/dev/tty','w') as terminal:
  terminal.write('Operator username [straconis]: ');terminal.flush()
 with open('/dev/tty','r') as terminal:
  username=terminal.readline().strip() or 'straconis'
 if not username.isascii() or not username.replace('_','').replace('-','').isalnum():raise SystemExit('Use letters, digits, underscores or hyphens for the username.')
 password=getpass.getpass('New portal password (at least 16 characters): ')
 if len(password)<16 or len(password)>1024:raise SystemExit('Use a password from 16 to 1024 characters.')
 if password!=getpass.getpass('Repeat portal password: '):raise SystemExit('Passwords did not match.')
 salt=secrets.token_bytes(16)
 key=hashlib.scrypt(password.encode(),salt=salt,n=16384,r=8,p=1,dklen=32)
 password_hash='scrypt$'+salt.hex()+'$'+key.hex()
values=[]
source=Path('/opt/the-witness/.env')
if source.exists():
 # Parse quoted multiline values without executing configuration or importing deployed code.
 assignment=re.compile(r"^[ \t]*(?:export[ \t]+)?([\w.-]+)[ \t]*=[ \t]*(?:\"((?:\\[\s\S]|[^\"])*)\"|'([^']*)'|`([^`]*)`|([^\r\n#]*))[ \t]*(?:#[^\r\n]*)?$",re.MULTILINE)
 for match in assignment.finditer(source.read_text()):
  key=match[1];value=next(part for part in match.groups()[1:] if part is not None)
  if match[2] is not None:value=value.replace('\\n','\n').replace('\\r','\r')
  if match[5] is not None:value=value.strip()
  if any(part in key.upper() for part in ['TOKEN','SECRET','PASSWORD','PRIVATE_KEY']) and value:
   values.append(value);values.extend(part for part in value.splitlines() if len(part)>=4 and part!=value)
body='LOG_PORTAL_USERNAME='+username+'\nLOG_PORTAL_PASSWORD_HASH='+password_hash+'\nLOG_PORTAL_REDACT_VALUES='+json.dumps(json.dumps(values))+'\n'
filename=Path('/etc/the-witness-log-portal.env')
fd=os.open(str(filename)+'.next',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as target:target.write(body)
os.chmod(str(filename)+'.next',0o600);os.replace(str(filename)+'.next',filename)
print('Private operator configuration saved. No password was printed.')
PY
if [[ "$mode" == --refresh-redactions ]]; then
 systemctl restart the-witness-log-portal.service
 sleep 2
 systemctl is-active --quiet the-witness-log-portal.service
 echo 'Redaction values refreshed; operator login preserved.'
 exit 0
fi
if ! id witness-logs >/dev/null 2>&1; then useradd --system --no-create-home --shell /usr/sbin/nologin witness-logs; fi
usermod -a -G systemd-journal witness-logs
cat > /etc/systemd/system/the-witness-log-portal.service <<'UNIT'
[Unit]
Description=The Witness read-only operator log portal
After=network.target systemd-journald.service
[Service]
User=witness-logs
Group=witness-logs
SupplementaryGroups=systemd-journal
EnvironmentFile=/etc/the-witness-log-portal.env
ExecStart=/usr/bin/python3 /opt/the-witness/scripts/log-portal.py
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
InaccessiblePaths=-/opt/the-witness/.env -/opt/the-witness/recordings
MemoryMax=256M
CPUQuota=20%
TasksMax=32
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
mkdir -p /var/www/the-witness-acme
# Serve only the certificate challenge until HTTPS is configured.
cat > /etc/nginx/sites-available/the-witness-logs <<NGINX
server {
 listen 80;
 server_name $host;
 access_log off;
 location /.well-known/acme-challenge/ { root /var/www/the-witness-acme; }
 location / { return 404; }
}
NGINX
ln -sfn /etc/nginx/sites-available/the-witness-logs /etc/nginx/sites-enabled/the-witness-logs
nginx -t
systemctl reload nginx
/opt/the-witness-certbot/bin/certbot certonly --non-interactive --agree-tos --register-unsafely-without-email --webroot --webroot-path /var/www/the-witness-acme --domain "$host" --cert-name "$host" --keep-until-expiring
cat > /etc/nginx/sites-available/the-witness-logs <<'NGINX'
limit_req_zone $binary_remote_addr zone=witness_logs:1m rate=1r/s;
server {
 listen 80;
 server_name logs.thewitness.dev;
 access_log off;
 location /.well-known/acme-challenge/ { root /var/www/the-witness-acme; }
 location / { return 301 https://logs.thewitness.dev$request_uri; }
}
server {
 listen 443 ssl;
 server_name logs.thewitness.dev;
 ssl_certificate /etc/letsencrypt/live/logs.thewitness.dev/fullchain.pem;
 ssl_certificate_key /etc/letsencrypt/live/logs.thewitness.dev/privkey.pem;
 ssl_protocols TLSv1.2 TLSv1.3;
 access_log off;
 location / {
  limit_req zone=witness_logs burst=5 nodelay;
  proxy_pass http://127.0.0.1:3011;
  proxy_set_header Host $host;
  proxy_set_header Authorization $http_authorization;
  proxy_buffering off;
  proxy_connect_timeout 5s;
  proxy_read_timeout 20s;
 }
}
NGINX
# Full setup must preserve visitor-IP restoration enabled by the operator.
if [[ -f /etc/nginx/snippets/the-witness-cloudflare-real-ip.conf ]]; then
 python3 - <<'PYIP'
from pathlib import Path
site=Path('/etc/nginx/sites-available/the-witness-logs')
marker=' server_name logs.thewitness.dev;'
include=' include /etc/nginx/snippets/the-witness-cloudflare-real-ip.conf;'
text=site.read_text()
if text.count(marker)!=2:raise SystemExit('Unexpected log virtual-host layout.')
site.write_text(text.replace(marker,marker+'\n'+include))
PYIP
fi
nginx -t
# Permit future GitHub deployments to restart only this additional service.
tmp=$(mktemp)
printf '%s\n' 'straconis ALL=(root) NOPASSWD: /usr/bin/systemctl restart the-witness-log-portal.service' > "$tmp"
visudo -cf "$tmp"
install -o root -g root -m 0440 "$tmp" /etc/sudoers.d/the-witness-log-portal
rm -f "$tmp"
systemctl daemon-reload
systemctl enable --now the-witness-log-portal.service
systemctl restart the-witness-log-portal.service
sleep 2
systemctl reload nginx
systemctl is-active --quiet the-witness-log-portal.service
printf 'Portal ready at https://%s. Use the operator login you just configured.\n' "$host"

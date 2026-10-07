#!/usr/bin/env bash
# One-time operator setup. Password input is hidden and never written to Git.
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run with sudo in your SSH terminal.' >&2; exit 1; }
app=/opt/the-witness
host=logs.thewitness.dev
for program in nginx python3 journalctl systemctl; do command -v "$program" >/dev/null; done
test -f "$app/scripts/log-portal.py"
test -x /opt/the-witness-certbot/bin/certbot
# Generate private configuration before opening the public hostname.
python3 - <<'PY'
import getpass, importlib.util, json, os
from pathlib import Path
spec=importlib.util.spec_from_file_location('portal','/opt/the-witness/scripts/log-portal.py');portal=importlib.util.module_from_spec(spec);spec.loader.exec_module(portal)
with open('/dev/tty','w') as terminal:
 terminal.write('Operator username [straconis]: ');terminal.flush()
with open('/dev/tty','r') as terminal:
 username=terminal.readline().strip() or 'straconis'
if not username.isascii() or not username.replace('_','').replace('-','').isalnum():raise SystemExit('Use letters, digits, underscores or hyphens for the username.')
password=getpass.getpass('New portal password (at least 16 characters): ')
if len(password)<16 or len(password)>1024:raise SystemExit('Use a password from 16 to 1024 characters.')
if password!=getpass.getpass('Repeat portal password: '):raise SystemExit('Passwords did not match.')
values=[]
source=Path('/opt/the-witness/.env')
if source.exists():
 for line in source.read_text().splitlines():
  if line.lstrip().startswith('#') or '=' not in line:continue
  key,value=line.split('=',1);value=value.strip().strip('\"\'')
  if any(part in key.upper() for part in ['TOKEN','SECRET','PASSWORD','PRIVATE_KEY']) and value:values.append(value)
body='LOG_PORTAL_USERNAME='+username+'\nLOG_PORTAL_PASSWORD_HASH='+portal.hash_password(password)+'\nLOG_PORTAL_REDACT_VALUES='+json.dumps(json.dumps(values))+'\n'
filename=Path('/etc/the-witness-log-portal.env')
fd=os.open(str(filename)+'.next',os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as target:target.write(body)
os.chmod(str(filename)+'.next',0o600);os.replace(str(filename)+'.next',filename)
print('Private operator configuration saved. No password was printed.')
PY
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
systemctl reload nginx
systemctl is-active --quiet the-witness-log-portal.service
printf 'Portal ready at https://%s. Use the operator login you just configured.\n' "$host"

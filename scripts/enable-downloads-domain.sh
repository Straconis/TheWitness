#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 ]] || { echo 'Run this setup with sudo.'; exit 1; }
app=/opt/the-witness
address=thewitness.dev
cd "$app"
export PATH=/usr/local/bin:/usr/bin:/bin
exec 9> .releases/deploy.lock
flock -n 9 || { echo "A deployment is running; try setup again when it finishes."; exit 1; }
export DOTENV_CONFIG_QUIET=true
node scripts/deploy-idle.cjs prepare
trap 'node scripts/deploy-idle.cjs clear' EXIT
node scripts/deploy-idle.cjs || { echo 'Wait for recordings and exports to finish, then run setup again.'; exit 1; }
apt-get update
apt-get install -y nginx python3-venv
python3 -m venv /opt/the-witness-certbot
/opt/the-witness-certbot/bin/pip install 'certbot>=5.4,<6'
mkdir -p /var/www/the-witness-acme
if [[ -L /etc/nginx/sites-enabled/default && $(readlink /etc/nginx/sites-enabled/default) == /etc/nginx/sites-available/default ]]; then
  rm /etc/nginx/sites-enabled/default
fi
cat > /etc/nginx/sites-available/the-witness <<NGINX
server {
  listen 80;
  server_name $address;
  access_log off;
  location /.well-known/acme-challenge/ { root /var/www/the-witness-acme; }
  location / { return 404; }
}
NGINX
ln -sfn /etc/nginx/sites-available/the-witness /etc/nginx/sites-enabled/the-witness
nginx -t
systemctl enable --now nginx
systemctl reload nginx
if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  ufw allow 80/tcp
  ufw allow 443/tcp
fi
/opt/the-witness-certbot/bin/certbot certonly --non-interactive --agree-tos --register-unsafely-without-email --webroot --webroot-path /var/www/the-witness-acme --domain "$address" --cert-name "$address" --keep-until-expiring
cat > /etc/nginx/sites-available/the-witness <<NGINX
server {
  listen 80;
  server_name $address;
  access_log off;
  location /.well-known/acme-challenge/ { root /var/www/the-witness-acme; }
  location / { return 301 https://$address\$request_uri; }
}
server {
  listen 443 ssl;
  server_name $address;
  ssl_certificate /etc/letsencrypt/live/$address/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/$address/privkey.pem;
  ssl_protocols TLSv1.2 TLSv1.3;
  access_log off;
  client_max_body_size 2m;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header Upgrade \$http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 120s;
    proxy_buffering off;
  }
}
NGINX
nginx -t
cat > /etc/systemd/system/the-witness-certbot.service <<'UNIT'
[Unit]
Description=Renew The Witness HTTPS certificate
[Service]
Type=oneshot
ExecStart=/opt/the-witness-certbot/bin/certbot renew --quiet --deploy-hook "/usr/bin/systemctl reload nginx"
UNIT
cat > /etc/systemd/system/the-witness-certbot.timer <<'UNIT'
[Unit]
Description=Check The Witness HTTPS renewal twice daily
[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=3600
Persistent=true
[Install]
WantedBy=timers.target
UNIT
# Preserve credentials and other environment settings without printing them.
python3 - <<'PY'
from pathlib import Path
p=Path('.env');settings={'DOWNLOAD_PORT':'3000','DOWNLOAD_PUBLIC_URL':'https://thewitness.dev','DOWNLOAD_BIND_HOST':'127.0.0.1'}
lines=p.read_text().splitlines();lines=[line for line in lines if line.split('=',1)[0] not in settings]
p.write_text('\n'.join(lines+[f'{key}={value}' for key,value in settings.items()])+'\n')
PY
systemctl daemon-reload
systemctl enable --now the-witness-certbot.timer
systemctl reload nginx
systemctl restart the-witness.service
sleep 3
systemctl is-active --quiet the-witness.service
curl --silent --show-error --output /dev/null http://127.0.0.1:3000/
echo 'HTTPS downloads enabled at https://thewitness.dev; certificate renewal is automatic.'

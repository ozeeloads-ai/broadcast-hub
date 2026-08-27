#!/bin/bash
# Broadcast Hub — one-time VPS setup for Hoster.kg (Debian/Ubuntu assumed).
# Run this as root on the fresh VPS:
#   1. Copy this whole file's contents.
#   2. SSH into the server (or use Hoster.kg's web console):
#        ssh root@176.126.164.34
#      (password: the one from your Hoster.kg panel)
#   3. Paste into a file, e.g.:  nano setup.sh   (paste, Ctrl+O, Enter, Ctrl+X)
#   4. Run it:  bash setup.sh
#
# It installs Node.js, clones the app from GitHub, sets fresh secrets,
# runs it under PM2 (auto-restart + survives reboot), and puts nginx in
# front of it on port 80. Safe to re-run if something fails partway.

set -e

echo "=== 1/8: System update ==="
apt update -y
apt upgrade -y

echo "=== 2/8: Install Node.js 20 LTS, git, build tools, nginx ==="
if ! command -v node >/dev/null || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
fi
apt install -y nodejs git build-essential python3 nginx openssl

echo "=== 3/8: Clone / update the app from GitHub ==="
cd /root
if [ -d broadcast-hub ]; then
  cd broadcast-hub
  git pull
else
  if ! git clone https://github.com/ozeeloads-ai/broadcast-hub.git; then
    echo ""
    echo "!!! Clone failed. If the repo is Private, either:"
    echo "    a) make it Public temporarily: GitHub repo -> Settings -> Danger Zone -> Change visibility, then re-run this script, or"
    echo "    b) clone with a token:  git clone https://<YOUR_GITHUB_TOKEN>@github.com/ozeeloads-ai/broadcast-hub.git"
    exit 1
  fi
  cd broadcast-hub
fi

echo "=== 4/8: Install app dependencies ==="
npm install --omit=dev

echo "=== 5/8: Write .env with fresh secrets (starting with a clean database) ==="
if [ ! -f .env ]; then
  SESSION_SECRET=$(openssl rand -hex 32)
  ENCRYPTION_KEY=$(openssl rand -hex 32)
  cat > .env <<EOF
PORT=3000
HOST=127.0.0.1
SESSION_SECRET=${SESSION_SECRET}
ENCRYPTION_KEY=${ENCRYPTION_KEY}
TELEGRAM_API_ID=38736755
TELEGRAM_API_HASH=29908c2c7fb9d11c54cc9db55162dd09
EOF
  echo "Created .env with new random secrets."
else
  echo ".env already exists, leaving it as-is."
fi

echo "=== 6/8: Install PM2 and start the app ==="
npm install -g pm2
pm2 delete broadcast-hub 2>/dev/null || true
pm2 start server.js --name broadcast-hub
pm2 save
pm2 startup systemd -u root --hp /root | tail -n 1 > /tmp/pm2_startup_cmd.sh
bash /tmp/pm2_startup_cmd.sh || true

echo "=== 7/8: Configure nginx as reverse proxy on port 80 ==="
cat > /etc/nginx/sites-available/broadcast-hub <<'NGINXEOF'
server {
    listen 80 default_server;
    server_name _;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
NGINXEOF
ln -sf /etc/nginx/sites-available/broadcast-hub /etc/nginx/sites-enabled/broadcast-hub
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl restart nginx
systemctl enable nginx

echo "=== 8/8: Firewall (keep SSH, open web ports) ==="
if command -v ufw >/dev/null; then
  ufw allow OpenSSH || true
  ufw allow 80/tcp || true
  ufw allow 443/tcp || true
  yes | ufw enable || true
fi

echo ""
echo "================================================"
echo " DONE. Site should be live at: http://176.126.164.34"
echo " Useful commands:"
echo "   pm2 status              - check the app is running"
echo "   pm2 logs broadcast-hub  - see live logs"
echo "   pm2 restart broadcast-hub"
echo "================================================"

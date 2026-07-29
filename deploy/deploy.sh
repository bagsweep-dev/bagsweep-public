#!/bin/bash
# BagSweep VPS Deploy Script
# Run on the VPS: bash deploy.sh
set -e

echo "═══════════════════════════════════════"
echo "  BagSweep — VPS Deployment"
echo "═══════════════════════════════════════"

# 1. Install dependencies
echo "▸ Installing system dependencies..."
apt-get update -qq
apt-get install -y -qq docker.io nginx certbot python3-certbot-nginx

# 2. Enable Docker
systemctl enable docker
systemctl start docker

# 3. Create app directory
mkdir -p /opt/bagsweep
echo "▸ Copying files to /opt/bagsweep..."
cp -r . /opt/bagsweep/
# the tracker needs no secrets, but the service mounts an env-file and a data dir
mkdir -p /opt/bagsweep/data
touch /opt/bagsweep/.env

# 4. Install systemd service
cp /opt/bagsweep/deploy/bagsweep-app.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable bagsweep-app

# 5. Setup Nginx — tracker app on app.bagsweep.xyz, static landing on the apex
cp /opt/bagsweep/deploy/nginx-app.bagsweep.xyz.conf /etc/nginx/sites-available/app.bagsweep.xyz
ln -sf /etc/nginx/sites-available/app.bagsweep.xyz /etc/nginx/sites-enabled/
cp /opt/bagsweep/deploy/nginx-bagsweep.xyz.conf /etc/nginx/sites-available/bagsweep.xyz
ln -sf /etc/nginx/sites-available/bagsweep.xyz /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

# 6. SSL certificate
echo "▸ Requesting SSL certificate..."
certbot --nginx -d app.bagsweep.xyz -d bagsweep.xyz --non-interactive --agree-tos --email admin@bagsweep.xyz || true

# 7. Start the app
systemctl start bagsweep-app
echo "▸ App started!"

echo ""
echo "═══════════════════════════════════════"
echo "  Deployment complete!"
echo "  App: https://app.bagsweep.xyz"
echo "═══════════════════════════════════════"
echo ""
echo "  Useful commands:"
echo "    systemctl status bagsweep-app"
echo "    journalctl -u bagsweep-app -f"
echo "    systemctl restart bagsweep-app"

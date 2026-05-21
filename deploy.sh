#!/usr/bin/env bash
set -euo pipefail

# ── Config ────────────────────────────────────────────────────────────────────
VPS_HOST="51.91.18.120"
VPS_USER="deploy"
REMOTE_DIR="/opt/tempmail"
DOMAIN_API="api.alldomainblocked.xyz"
DOMAIN_MAIL="mail.alldomainblocked.xyz"
EMAIL="avishek@kolpolok.com"
COMPOSE_PROJECT="tempmail"

SSH="ssh -o StrictHostKeyChecking=accept-new -i ~/.ssh/spendwise_deploy ${VPS_USER}@${VPS_HOST}"

echo "==> Syncing files to VPS..."
rsync -avz --delete -e "ssh -o StrictHostKeyChecking=accept-new -i ~/.ssh/spendwise_deploy" \
  --exclude='.git' \
  --exclude='*.example' \
  --exclude='api-server.js' \
  --exclude='api-redis.js' \
  --exclude='api-package.json' \
  --exclude='api-Dockerfile' \
  --exclude='smtp-server.js' \
  --exclude='smtp-rateLimit.js' \
  --exclude='smtp-Dockerfile' \
  --exclude='redis.conf' \
  --exclude='nginx.conf' \
  /home/avsk/Downloads/Tempmail/ \
  ${VPS_USER}@${VPS_HOST}:${REMOTE_DIR}/

echo "==> Creating Docker volumes and getting initial TLS certificates..."
$SSH bash -s <<REMOTE
set -euo pipefail
cd ${REMOTE_DIR}

# Create the named volumes docker compose will use
docker volume create ${COMPOSE_PROJECT}_certbot_www  2>/dev/null || true
docker volume create ${COMPOSE_PROJECT}_certbot_certs 2>/dev/null || true

# Block port 80 from our own containers during bootstrap, but serve the ACME
# challenge — use a temporary nginx for this step only
docker stop nginx-bootstrap 2>/dev/null || true
docker rm   nginx-bootstrap 2>/dev/null || true

docker run -d --name nginx-bootstrap \
  -p 80:80 \
  -v ${REMOTE_DIR}/nginx/nginx-bootstrap.conf:/etc/nginx/nginx.conf:ro \
  -v ${COMPOSE_PROJECT}_certbot_www:/var/www/certbot \
  nginx:1.27-alpine

sleep 3

# Issue certs for API domain
docker run --rm \
  -v ${COMPOSE_PROJECT}_certbot_certs:/etc/letsencrypt \
  -v ${COMPOSE_PROJECT}_certbot_www:/var/www/certbot \
  certbot/certbot certonly \
  --webroot --webroot-path /var/www/certbot \
  --email ${EMAIL} --agree-tos --no-eff-email --non-interactive \
  -d ${DOMAIN_API}

# Issue certs for mail domain
docker run --rm \
  -v ${COMPOSE_PROJECT}_certbot_certs:/etc/letsencrypt \
  -v ${COMPOSE_PROJECT}_certbot_www:/var/www/certbot \
  certbot/certbot certonly \
  --webroot --webroot-path /var/www/certbot \
  --email ${EMAIL} --agree-tos --no-eff-email --non-interactive \
  -d ${DOMAIN_MAIL}

docker stop nginx-bootstrap && docker rm nginx-bootstrap

echo "Certificates issued successfully."
REMOTE

echo "==> Starting the full stack..."
$SSH bash -s <<STACK
set -euo pipefail
cd ${REMOTE_DIR}

docker compose -p ${COMPOSE_PROJECT} up -d --build

echo "Waiting for services to become healthy..."
sleep 20

docker compose -p ${COMPOSE_PROJECT} ps
STACK

echo ""
echo "==> Deployment complete!"
echo "    API health:  https://${DOMAIN_API}/health"
echo "    Create inbox: curl -s -X POST https://${DOMAIN_API}/api/inbox | jq ."
echo "    SMTP port 25 open on ${VPS_HOST}"
echo ""
echo "    MX record needed:  ${DOMAIN_MAIL}.  IN MX  10  ${VPS_HOST}."

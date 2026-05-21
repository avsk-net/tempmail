#!/usr/bin/env bash
# Run as root: sudo bash ~/tempmail/nginx-tempmail.sh
set -euo pipefail

EMAIL='avishek@kolpolok.com'
DOMAIN_API='api.alldomainblocked.xyz'
DOMAIN_MAIL='mail.alldomainblocked.xyz'

echo '==> Writing HTTP-only vhost for ACME challenge...'
cat > /etc/nginx/sites-available/tempmail << 'NGINX_HTTP'
server {
    listen 80;
    server_name api.alldomainblocked.xyz mail.alldomainblocked.xyz;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}
NGINX_HTTP

ln -sf /etc/nginx/sites-available/tempmail /etc/nginx/sites-enabled/tempmail
nginx -t && systemctl reload nginx

echo '==> Issuing TLS certificate for both domains...'
certbot certonly --webroot -w /var/www/certbot   -d api.alldomainblocked.xyz -d mail.alldomainblocked.xyz   --non-interactive --agree-tos --email avishek@kolpolok.com

echo '==> Writing full HTTPS vhost (SSL + proxy to tempmail on :8090)...'
cat > /etc/nginx/sites-available/tempmail << 'NGINX_FULL'
server {
    listen 80;
    server_name api.alldomainblocked.xyz mail.alldomainblocked.xyz;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://$host$request_uri; }
}

# API domain
server {
    listen 443 ssl http2;
    server_name api.alldomainblocked.xyz;

    ssl_certificate     /etc/letsencrypt/live/api.alldomainblocked.xyz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.alldomainblocked.xyz/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    client_max_body_size 10M;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;

    location /socket.io/ {
        proxy_pass         http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
    }

    location / {
        proxy_pass         http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}

# Mail/UI domain
server {
    listen 443 ssl http2;
    server_name mail.alldomainblocked.xyz;

    ssl_certificate     /etc/letsencrypt/live/api.alldomainblocked.xyz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.alldomainblocked.xyz/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    client_max_body_size 10M;

    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;

    location /socket.io/ {
        proxy_pass         http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
    }

    location / {
        proxy_pass         http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Real-IP $remote_addr;
        proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;
    }
}
NGINX_FULL

nginx -t && systemctl reload nginx
echo '==> Done! Host nginx configured with TLS for both domains.'
echo '    Test: curl https://api.alldomainblocked.xyz/health'

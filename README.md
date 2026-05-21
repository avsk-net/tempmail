# TempMail — Self-Hosted Disposable Email Service

A production-ready temporary email service. Generates 10-minute inboxes, receives real SMTP mail, and shows messages in real-time via WebSocket.

## Architecture

```
Internet → Host nginx (SSL) → tempmail-nginx:8090 → api:3000 (×2 replicas)
                                                   ↘ redis:6379
SMTP :25 → tempmail-smtp → api:3000/internal/deliver
```

| Container | Role |
|-----------|------|
| `redis` | Ephemeral store — all data auto-expires with the inbox TTL |
| `api` (×2) | Express REST API + Socket.io WebSocket |
| `smtp` | Lightweight SMTP ingest — validates recipients before accepting |
| `nginx` | Internal reverse proxy + static UI, exposed on `127.0.0.1:8090` |

Host nginx handles TLS termination and proxies to the internal nginx on port 8090.

---

## Re-deploy on a New Domain

### 1. Prerequisites

- Ubuntu/Debian VPS with Docker installed
- Domain A records pointed to your VPS IP
- A non-root user in the `docker` group (e.g. `deploy`)
- Host nginx + certbot: `apt install nginx certbot python3-certbot-nginx`

### 2. Clone and configure

```bash
git clone https://github.com/avsk-net/tempmail.git
cd tempmail
cp .env.example .env
```

Edit `.env` — the `MAIL_DOMAIN` determines the `@domain` part of every generated address:

```env
MAIL_DOMAIN=yourdomain.com
INBOX_TTL_SECONDS=600
REDIS_URL=redis://redis:6379
SMTP_PORT=25
MAX_MSG_BYTES=5242880
API_INTERNAL_URL=http://api:3000
```

### 3. Edit the nginx setup script

Open `nginx-tempmail.sh` and change the three variables at the top:

```bash
EMAIL='you@example.com'       # Let's Encrypt contact email
DOMAIN_API='api.yourdomain.com'
DOMAIN_MAIL='mail.yourdomain.com'
```

### 4. Start the stack

```bash
docker compose -p tempmail up -d --build
```

Verify it's up on the internal port:

```bash
curl http://127.0.0.1:8090/health   # should return: OK
```

### 5. Set up host nginx + SSL (as root)

```bash
sudo bash nginx-tempmail.sh
```

This writes `/etc/nginx/sites-available/tempmail`, issues a Let's Encrypt certificate for both domains via certbot webroot, and reloads nginx.

### 6. Add DNS records

| Type | Name | Value | Purpose |
|------|------|-------|---------|
| A | `api.yourdomain.com` | `<VPS IP>` | API + WebSocket endpoint |
| A | `mail.yourdomain.com` | `<VPS IP>` | Web UI + SMTP hostname |
| MX | `yourdomain.com` | `mail.yourdomain.com` | Receive inbound email (priority 10) |

### 7. Smoke test

```bash
curl https://api.yourdomain.com/health
curl -X POST https://api.yourdomain.com/api/inbox
# Open https://mail.yourdomain.com in a browser
```

---

## API Reference

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/inbox` | Create a new temporary inbox |
| `GET` | `/api/inbox/:address` | Inbox metadata + remaining TTL |
| `GET` | `/api/inbox/:address/emails` | List emails (summaries) |
| `GET` | `/api/inbox/:address/emails/:id` | Full email body |
| `DELETE` | `/api/inbox/:address` | Delete inbox immediately |

### WebSocket (Socket.io)

Connect to `https://api.yourdomain.com`, then:

```js
socket.emit('subscribe', { address: 'box@yourdomain.com' })
socket.on('email:new',    (email) => { /* real-time delivery */ })
socket.on('inbox:deleted', ()    => { /* inbox expired or deleted */ })
```

---

## Operations

```bash
# Logs
docker compose -p tempmail logs -f api
docker compose -p tempmail logs -f smtp

# Restart a service
docker compose -p tempmail restart api

# Redeploy after code change
git pull && docker compose -p tempmail up -d --build

# Scale API replicas
docker compose -p tempmail up -d --scale api=4
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MAIL_DOMAIN` | `alldomainblocked.xyz` | `@domain` for generated addresses |
| `INBOX_TTL_SECONDS` | `600` | Inbox lifetime in seconds (10 min) |
| `REDIS_URL` | `redis://redis:6379` | Redis connection string |
| `SMTP_PORT` | `25` | SMTP listen port inside container |
| `MAX_MSG_BYTES` | `5242880` | Max inbound message size (5 MB) |
| `API_INTERNAL_URL` | `http://api:3000` | Used by SMTP to reach the API |

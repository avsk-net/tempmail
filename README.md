# TempMail — Production-Grade Temporary Email Service

A self-hosted, 10-minute ephemeral email service built on Node.js,
Redis, and a lightweight SMTP server.  Every inbox and all its mail
automatically self-destruct exactly 10 minutes after creation —
enforced at the database layer, not by a cron job.

---

## Architecture

```
Internet
    │
    ├──[port 25]──▶  smtp  (smtp-server)
    │                  │  MIME parse (mailparser)
    │                  │  POST /internal/deliver
    │                  ▼
    └──[443/80]──▶  nginx  (TLS termination, rate limiting)
                       │  /api/*  /socket.io/*
                       ▼
                      api  (Express + Socket.io)
                       │  GET/POST/DELETE inboxes & emails
                       │  WebSocket push on new mail
                       ▼
                     redis  (volatile-ttl, no persistence)
                       │  EXPIRE on every key = 600s
                       └──[keyspace events]──▶ api (cleanup hooks)
```

### Why This Stack?

| Concern | Choice | Reason |
|---|---|---|
| TTL enforcement | Redis `EXPIRE` | Atomic, millisecond-precision, no cron needed |
| SMTP ingestion | `smtp-server` npm | Pure JS, no system Postfix config required |
| MIME parsing | `mailparser` | Handles multipart, encoded words, attachments |
| Real-time push | Socket.io | Works through nginx websocket proxy |
| TLS | Nginx + Certbot | Standard; nginx blocks `/internal/*` from internet |

---

## DNS & SMTP Configuration

### Step 1 — Point MX records at your server

In your domain registrar / DNS provider (e.g. Cloudflare), add:

```
Type   Host              Value               Priority  TTL
────────────────────────────────────────────────────────────
MX     tmpbox.io         mail.tmpbox.io      10        300
A      mail.tmpbox.io    <YOUR_SERVER_IP>    —         300
A      api.tmpbox.io     <YOUR_SERVER_IP>    —         300
TXT    tmpbox.io         v=spf1 -all         —         300
```

> **SPF `-all`** tells receiving servers this domain never sends mail
> outbound — correct for a receive-only temp mail service, and it
> reduces abuse risk.

### Step 2 — PTR / Reverse DNS

Ask your VPS provider to set the reverse DNS (PTR record) for your
server IP to `mail.tmpbox.io`.  Many providers do this in their
control panel under "Networking → Reverse DNS".  This is required
for major mail providers to accept connections from your server.

### Step 3 — Unblock port 25

By default, DigitalOcean, AWS EC2, GCP, and Hetzner block outbound
port 25.  For *inbound* SMTP (receiving mail), you only need to ensure
the firewall on your VPS allows **inbound TCP port 25**.

If your VPS also blocks outbound port 25 (which prevents you from
connecting to other SMTP servers for testing), submit a support ticket.
This service does not *send* mail, so outbound port 25 is optional.

### Catch-All Logic

`smtp/server.js` accepts any address `*@tmpbox.io` but immediately
checks with the API whether a live inbox exists.  No Linux user
accounts are created; there is no `/etc/aliases` or Postfix `virtual`
map.  Every address is virtual, enforced in code.

---

## Redis Schema

All keys use `volatile-ttl` eviction — Redis automatically deletes
them when the TTL expires.  No cleanup process is needed.

```
inbox:{address}          STRING   JSON blob  EXPIRE 600
inbox:{address}:emails   LIST     [emailId]  EXPIRE 600  (synced to inbox TTL)
email:{uuid}             HASH     (see below) EXPIRE = inbox remaining TTL
```

### Email Hash Fields

```
id              UUID v4
inboxAddress    full recipient address
from            sender display name + address
to              recipient address
subject         decoded subject line
text            plain-text body
html            HTML body (sanitise on the frontend!)
date            ISO 8601
headers         JSON object (selected safe headers)
attachments     JSON array of { filename, contentType, size, storageKey }
hasAttachments  "0" | "1"
bodyPreview     first 120 chars of text body (for list view)
```

---

## API Reference

### `POST /api/inbox`
Create a new inbox.

**Response**
```json
{
  "address":    "swift-fox-a3f9@tmpbox.io",
  "expiresAt":  1718000000000,
  "ttlSeconds": 600
}
```

### `GET /api/inbox/:address`
Get inbox metadata and remaining TTL.

### `GET /api/inbox/:address/emails`
List all email summaries (no body).

### `GET /api/inbox/:address/emails/:id`
Get a full email including HTML body.

### `DELETE /api/inbox/:address`
Immediately destroy the inbox and all its mail.

### WebSocket Events

Connect to `wss://api.tmpbox.io` with Socket.io:

```javascript
const socket = io('wss://api.tmpbox.io');

// Subscribe to inbox
socket.emit('subscribe', { address: 'swift-fox-a3f9@tmpbox.io' });

// Listen for new mail
socket.on('email:new', (email) => console.log('New mail!', email));

// Inbox was deleted / expired
socket.on('inbox:deleted', () => console.log('Inbox gone.'));
```

---

## Deployment

### Prerequisites

- Ubuntu 22.04 VPS with a public IP
- Docker + Docker Compose v2 installed
- Domain with DNS control
- Port 25 open on VPS firewall: `ufw allow 25/tcp`
- Port 80 and 443 open: `ufw allow 80/tcp && ufw allow 443/tcp`

### 1 — Clone and configure

```bash
git clone https://github.com/yourorg/tempmail.git
cd tempmail
cp .env.example .env
# Edit .env — set MAIL_DOMAIN=yourdomain.com
```

### 2 — Get TLS certificates (first time)

```bash
# One-time bootstrap using the standalone mode (before nginx is running)
docker run --rm -p 80:80 certbot/certbot certonly \
  --standalone \
  --email admin@yourdomain.com \
  --agree-tos \
  --no-eff-email \
  -d api.yourdomain.com

# Copy certs to the volume certbot expects
# (handled automatically by certbot service on renewal)
```

### 3 — Start all services

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f
```

### 4 — Verify SMTP

```bash
# From an external machine, test that port 25 is reachable:
telnet api.tmpbox.io 25

# Send a test email via swaks (install with: apt install swaks)
swaks --to swift-fox-a3f9@tmpbox.io \
      --from test@gmail.com \
      --server mail.tmpbox.io \
      --data "Subject: Hello\n\nTest body"
```

### Scaling

```bash
# Scale the API horizontally (Redis is the shared state)
docker compose up -d --scale api=4
```

---

## Security Hardening Checklist

- [x] Nginx blocks `/internal/*` from the public internet
- [x] Rate limiting at Nginx (30 req/min) and SMTP (30 conn/IP/min) layers
- [x] `smtp-server` validates recipient before accepting data — no open relay
- [x] Redis `FLUSHALL` and `CONFIG` commands renamed/disabled
- [x] Redis bound to internal Docker network only
- [x] All API containers run as non-root user
- [x] SPF `-all` DNS record prevents spoofed outbound mail from your domain
- [ ] Add DMARC TXT record: `v=DMARC1; p=reject; rua=mailto:dmarc@yourdomain.com`
- [ ] Consider Cloudflare in front of nginx for DDoS mitigation
- [ ] Store email attachments in MinIO/S3 — never in Redis
- [ ] Sanitise HTML bodies on the frontend (e.g. DOMPurify) before rendering

---

## The "Domain Blacklist" Problem

Services like Netflix, Gmail, and Apple ID maintain blocklists of
known temp-mail domains.  There is no technical workaround.

**Practical approach:**
- Register a fresh `.com` or `.net` domain that has no history
- Avoid registrar-level email forwarding that might flag the domain
- Don't register a domain with "temp", "throw", "fake", or "disposable"
  in the name — those are blocklisted by pattern matching
- Rotate your domain every 6–12 months if blocking becomes a problem

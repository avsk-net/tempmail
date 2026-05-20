'use strict';

const express       = require('express');
const http          = require('http');
const { Server }    = require('socket.io');
const cors          = require('cors');
const rateLimit     = require('express-rate-limit');
const helmet        = require('helmet');
const { v4: uuidv4} = require('uuid');
const redis         = require('./redis');

// ─────────────────────────────────────────────
//  Config
// ─────────────────────────────────────────────
const PORT          = process.env.PORT || 3000;
const DOMAIN        = process.env.MAIL_DOMAIN || 'tmpbox.io';
const INBOX_TTL     = parseInt(process.env.INBOX_TTL_SECONDS || '600', 10); // 10 minutes
const ADJECTIVES    = ['swift','dark','bold','calm','wise','keen','rare','vast','pure','mild'];
const NOUNS         = ['fox','oak','rye','elm','bay','jet','arc','dew','ash','ivy'];

// ─────────────────────────────────────────────
//  App Setup
// ─────────────────────────────────────────────
const app  = express();
const srv  = http.createServer(app);
const io   = new Server(srv, {
  cors: { origin: '*', methods: ['GET','POST'] }
});

app.use(helmet());
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
//  Rate Limiting
// ─────────────────────────────────────────────
const inboxCreateLimiter = rateLimit({
  windowMs: 60 * 1000,   // 1 minute window
  max:      10,           // max 10 new inboxes per IP per minute
  message:  { error: 'Too many inbox creations, slow down.' }
});

const readLimiter = rateLimit({
  windowMs: 10 * 1000,
  max:      60,
  message:  { error: 'Too many requests.' }
});

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

/**
 * Generate a human-friendly random local-part:
 *   e.g.  swift-fox-a3f9  (adjective-noun-hex4)
 */
function generateLocalPart() {
  const adj  = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const hex  = Math.floor(Math.random() * 0xFFFF).toString(16).padStart(4, '0');
  return `${adj}-${noun}-${hex}`;
}

/**
 * Redis key helpers — keeps naming consistent everywhere.
 */
const KEY = {
  inbox:      (addr)       => `inbox:${addr}`,
  emailList:  (addr)       => `inbox:${addr}:emails`,
  email:      (id)         => `email:${id}`,
  socketRoom: (addr)       => `room:${addr}`,
};

// ─────────────────────────────────────────────
//  API Routes
// ─────────────────────────────────────────────

/**
 * POST /api/inbox
 * Creates a new temporary inbox.  Returns address + expiry timestamp.
 */
app.post('/api/inbox', inboxCreateLimiter, async (req, res) => {
  try {
    const localPart = generateLocalPart();
    const address   = `${localPart}@${DOMAIN}`;
    const now       = Date.now();
    const expiresAt = now + INBOX_TTL * 1000;

    const inboxKey = KEY.inbox(address);

    // Atomic creation — NX means "only set if Not eXists"
    const created = await redis.set(
      inboxKey,
      JSON.stringify({ address, createdAt: now, expiresAt }),
      { NX: true, EX: INBOX_TTL }
    );

    if (!created) {
      // Collision (extremely unlikely) — just recurse once
      return res.status(409).json({ error: 'Address collision, retry.' });
    }

    // The email-list key gets the same TTL automatically when first written;
    // we touch it now so EXPIRETIME is available immediately.
    await redis.expire(KEY.emailList(address), INBOX_TTL);

    res.json({ address, expiresAt, ttlSeconds: INBOX_TTL });
  } catch (err) {
    console.error('POST /api/inbox error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * GET /api/inbox/:address
 * Returns inbox metadata including remaining TTL.
 */
app.get('/api/inbox/:address', readLimiter, async (req, res) => {
  try {
    const address  = req.params.address.toLowerCase();
    const inboxKey = KEY.inbox(address);
    const [raw, ttl] = await Promise.all([
      redis.get(inboxKey),
      redis.ttl(inboxKey)
    ]);

    if (!raw || ttl < 0) {
      return res.status(404).json({ error: 'Inbox not found or expired.' });
    }

    const inbox = JSON.parse(raw);
    res.json({ ...inbox, remainingSeconds: ttl });
  } catch (err) {
    console.error('GET /api/inbox error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * GET /api/inbox/:address/emails
 * Lists all email summaries for the inbox.
 */
app.get('/api/inbox/:address/emails', readLimiter, async (req, res) => {
  try {
    const address  = req.params.address.toLowerCase();
    const inboxKey = KEY.inbox(address);
    const exists   = await redis.exists(inboxKey);

    if (!exists) {
      return res.status(404).json({ error: 'Inbox not found or expired.' });
    }

    const emailIds = await redis.lRange(KEY.emailList(address), 0, -1);
    if (!emailIds.length) {
      return res.json({ emails: [] });
    }

    // Fetch all email headers in a pipeline
    const pipeline = redis.multi();
    emailIds.forEach(id => pipeline.hGetAll(KEY.email(id)));
    const results = await pipeline.exec();

    const emails = results
      .map((email, idx) => {
        if (!email) return null;
        const { id, from, to, subject, date, hasAttachments, bodyPreview } = email;
        return { id, from, to, subject, date, hasAttachments: hasAttachments === '1', bodyPreview };
      })
      .filter(Boolean);

    res.json({ emails });
  } catch (err) {
    console.error('GET /api/inbox/:address/emails error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * GET /api/inbox/:address/emails/:id
 * Returns the full email body (text + html).
 */
app.get('/api/inbox/:address/emails/:id', readLimiter, async (req, res) => {
  try {
    const address  = req.params.address.toLowerCase();
    const emailId  = req.params.id;
    const inboxKey = KEY.inbox(address);
    const exists   = await redis.exists(inboxKey);

    if (!exists) {
      return res.status(404).json({ error: 'Inbox not found or expired.' });
    }

    const email = await redis.hGetAll(KEY.email(emailId));
    if (!Object.keys(email).length) {
      return res.status(404).json({ error: 'Email not found.' });
    }

    // Deserialise stored JSON fields
    email.attachments  = JSON.parse(email.attachments  || '[]');
    email.headers      = JSON.parse(email.headers      || '{}');
    email.hasAttachments = email.hasAttachments === '1';

    res.json({ email });
  } catch (err) {
    console.error('GET /api/inbox/:address/emails/:id error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

/**
 * DELETE /api/inbox/:address
 * Lets a user manually nuke their inbox early.
 */
app.delete('/api/inbox/:address', readLimiter, async (req, res) => {
  try {
    const address  = req.params.address.toLowerCase();
    const inboxKey = KEY.inbox(address);
    const emailIds = await redis.lRange(KEY.emailList(address), 0, -1);

    const pipeline = redis.multi();
    pipeline.del(inboxKey);
    pipeline.del(KEY.emailList(address));
    emailIds.forEach(id => pipeline.del(KEY.email(id)));
    await pipeline.exec();

    io.to(KEY.socketRoom(address)).emit('inbox:deleted');
    res.json({ message: 'Inbox deleted.' });
  } catch (err) {
    console.error('DELETE /api/inbox error:', err);
    res.status(500).json({ error: 'Internal server error.' });
  }
});

// ─────────────────────────────────────────────
//  Internal route called by the SMTP service
// ─────────────────────────────────────────────
/**
 * POST /internal/deliver
 * Only reachable from within the Docker network (nginx blocks external access).
 */
app.post('/internal/deliver', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const { to, from, subject, text, html, date, headers, attachments } = req.body;
    const address  = (to || '').toLowerCase();
    const inboxKey = KEY.inbox(address);

    // Only store if inbox exists and hasn't expired
    const ttl = await redis.ttl(inboxKey);
    if (ttl < 0) {
      console.warn(`[deliver] Inbox ${address} not found / expired — discarding mail.`);
      return res.json({ status: 'discarded' });
    }

    const emailId  = uuidv4();
    const emailKey = KEY.email(emailId);
    const bodyPreview = (text || html || '').replace(/<[^>]+>/g, '').substring(0, 120);

    const pipeline = redis.multi();

    // Store full email as a hash; expire it with the inbox TTL so both die together
    pipeline.hSet(emailKey, {
      id:             emailId,
      inboxAddress:   address,
      from:           from     || '',
      to:             address,
      subject:        subject  || '(no subject)',
      text:           text     || '',
      html:           html     || '',
      date:           date     || new Date().toISOString(),
      headers:        JSON.stringify(headers     || {}),
      attachments:    JSON.stringify(attachments || []),
      hasAttachments: attachments && attachments.length ? '1' : '0',
      bodyPreview,
    });
    pipeline.expire(emailKey, ttl);   // inherit remaining inbox TTL

    // Prepend to list (newest first); keep the list expiry in sync
    pipeline.lPush(KEY.emailList(address), emailId);
    pipeline.expire(KEY.emailList(address), ttl);

    await pipeline.exec();

    // Notify any connected WebSocket clients in real-time
    io.to(KEY.socketRoom(address)).emit('email:new', {
      id:             emailId,
      from,
      subject:        subject || '(no subject)',
      date:           date    || new Date().toISOString(),
      hasAttachments: !!(attachments && attachments.length),
      bodyPreview,
    });

    console.log(`[deliver] Stored email ${emailId} → ${address}`);
    res.json({ status: 'ok', emailId });
  } catch (err) {
    console.error('[deliver] error:', err);
    res.status(500).json({ error: 'Delivery failed.' });
  }
});

// ─────────────────────────────────────────────
//  WebSocket
// ─────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[ws] client connected: ${socket.id}`);

  /**
   * Client sends { address } to subscribe to an inbox.
   * We validate the inbox exists before joining the room.
   */
  socket.on('subscribe', async ({ address }) => {
    if (!address) return socket.emit('error', { message: 'No address provided.' });

    const inboxKey = KEY.inbox(address.toLowerCase());
    const ttl      = await redis.ttl(inboxKey);

    if (ttl < 0) {
      return socket.emit('error', { message: 'Inbox not found or expired.' });
    }

    const room = KEY.socketRoom(address.toLowerCase());
    socket.join(room);
    socket.emit('subscribed', { address, remainingSeconds: ttl });
    console.log(`[ws] ${socket.id} subscribed to ${address}`);
  });

  socket.on('disconnect', () => {
    console.log(`[ws] client disconnected: ${socket.id}`);
  });
});

// ─────────────────────────────────────────────
//  Boot
// ─────────────────────────────────────────────
srv.listen(PORT, () => {
  console.log(`[api] Listening on port ${PORT}, domain=${DOMAIN}, TTL=${INBOX_TTL}s`);
});

module.exports = { app, io }; // for testing

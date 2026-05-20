'use strict';

/**
 * SMTP Ingest Service
 * ──────────────────
 * Runs a lightweight SMTP server (smtp-server) that acts as the MTA.
 * Postfix/Haraka forward all mail for the catch-all domain here.
 *
 * Responsibilities:
 *  1. Accept connections on port 25 (or 2525 behind Postfix)
 *  2. Validate the recipient address via the API (inbox must be live)
 *  3. Parse MIME with mailparser
 *  4. POST parsed email to the API /internal/deliver endpoint
 *  5. Reject oversized or unauthenticated relay attempts
 */

const { SMTPServer }   = require('smtp-server');
const { simpleParser } = require('mailparser');
const fetch            = require('node-fetch');
const rateLimit        = require('./rateLimit');

// ─────────────────────────────────────────────
//  Config
// ─────────────────────────────────────────────
const SMTP_PORT       = parseInt(process.env.SMTP_PORT       || '25',    10);
const DOMAIN          = process.env.MAIL_DOMAIN              || 'tmpbox.io';
const API_INTERNAL    = process.env.API_INTERNAL_URL         || 'http://api:3000';
const MAX_MSG_SIZE    = parseInt(process.env.MAX_MSG_BYTES   || String(5 * 1024 * 1024), 10); // 5 MB

// ─────────────────────────────────────────────
//  SMTP Server
// ─────────────────────────────────────────────
const server = new SMTPServer({

  // We only accept mail FOR our domain — no open relay
  name:              DOMAIN,
  banner:            `${DOMAIN} ESMTP ready`,
  size:              MAX_MSG_SIZE,
  disabledCommands:  ['AUTH'],   // no outbound relay auth needed

  // ── Connection-level hooks ──────────────────

  onConnect(session, callback) {
    const ip = session.remoteAddress;
    console.log(`[smtp] Connect from ${ip}`);

    // Basic IP-level rate limiting (in-memory)
    if (rateLimit.isBlocked(ip)) {
      console.warn(`[smtp] Blocked IP: ${ip}`);
      return callback(new Error('4.7.1 Too many connections, try later.'));
    }
    rateLimit.hit(ip);
    callback();
  },

  // ── Recipient validation ────────────────────

  async onRcptTo(address, session, callback) {
    const to = address.address.toLowerCase();

    // Must be @our domain
    if (!to.endsWith(`@${DOMAIN}`)) {
      console.warn(`[smtp] Relay attempt for foreign domain: ${to}`);
      return callback(new Error('5.7.1 Relay access denied.'));
    }

    // Check that the inbox is alive (HTTP HEAD-equivalent: GET inbox metadata)
    try {
      const res = await fetch(`${API_INTERNAL}/api/inbox/${encodeURIComponent(to)}`);
      if (res.status === 404) {
        console.log(`[smtp] No live inbox for ${to} — rejecting.`);
        // 5xx = permanent reject so sender doesn't keep retrying
        return callback(new Error(`5.1.1 Mailbox ${to} does not exist.`));
      }
    } catch (err) {
      console.error('[smtp] API check failed:', err.message);
      // 4xx = transient; sender will retry
      return callback(new Error('4.3.0 Temporary service unavailable.'));
    }

    callback(); // recipient accepted
  },

  // ── Data handler ────────────────────────────

  onData(stream, session, callback) {
    const chunks = [];
    let size = 0;

    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_MSG_SIZE) {
        stream.destroy(new Error('Message too large.'));
        return;
      }
      chunks.push(chunk);
    });

    stream.on('end', async () => {
      const rawMail = Buffer.concat(chunks);

      try {
        const parsed = await simpleParser(rawMail, {
          skipHtmlToText:     false,
          skipTextToHtml:     false,
          skipImageLinks:     false,
          maxHtmlLengthToParse: 2 * 1024 * 1024, // 2 MB cap on HTML
        });

        // Extract safe attachment metadata (no binary blobs in Redis)
        const attachments = (parsed.attachments || []).map(a => ({
          filename:    a.filename    || 'attachment',
          contentType: a.contentType || 'application/octet-stream',
          size:        a.size        || 0,
          // In production, store binary to S3/MinIO and put the URL here
          storageKey:  null,
        }));

        const to      = session.envelope.rcptTo[0].address.toLowerCase();
        const from    = parsed.from?.text || session.envelope.mailFrom.address;
        const subject = parsed.subject || '';
        const text    = parsed.text    || '';
        const html    = parsed.html    || '';
        const date    = parsed.date?.toISOString() || new Date().toISOString();

        // Collect selected headers
        const headers = {};
        ['message-id', 'reply-to', 'x-mailer', 'list-unsubscribe'].forEach(h => {
          const v = parsed.headers?.get(h);
          if (v) headers[h] = v.toString();
        });

        const payload = { to, from, subject, text, html, date, headers, attachments };

        const deliverRes = await fetch(`${API_INTERNAL}/internal/deliver`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(payload),
        });

        if (!deliverRes.ok) {
          const body = await deliverRes.text();
          console.error(`[smtp] Deliver failed (${deliverRes.status}): ${body}`);
          return callback(new Error('4.3.0 Temporary storage failure.'));
        }

        console.log(`[smtp] Delivered from=${from} to=${to}`);
        callback(); // 250 OK

      } catch (err) {
        console.error('[smtp] Parse/deliver error:', err);
        callback(new Error('4.3.0 Message processing error.'));
      }
    });

    stream.on('error', (err) => {
      console.error('[smtp] Stream error:', err);
      callback(err);
    });
  },

  onError(err) {
    console.error('[smtp] Server error:', err);
  },
});

server.listen(SMTP_PORT, '0.0.0.0', () => {
  console.log(`[smtp] Listening on port ${SMTP_PORT} for @${DOMAIN}`);
});

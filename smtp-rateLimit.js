'use strict';

/**
 * Lightweight in-memory IP rate limiter for the SMTP service.
 * Tracks connection counts per IP in a sliding window.
 *
 * For production, swap this out for a Redis-backed counter so it
 * works correctly across multiple SMTP replicas.
 */

const WINDOW_MS   = 60 * 1000;  // 1-minute window
const MAX_HITS    = 30;          // max 30 SMTP connections per IP per window
const BLOCK_MS    = 5 * 60 * 1000; // blocked IPs cool off for 5 minutes

const counters = new Map();  // ip → { count, windowStart }
const blocked  = new Map();  // ip → blockedUntil timestamp

function cleanup() {
  const now = Date.now();
  for (const [ip, until] of blocked) {
    if (now > until) blocked.delete(ip);
  }
  for (const [ip, data] of counters) {
    if (now - data.windowStart > WINDOW_MS) counters.delete(ip);
  }
}

// Run cleanup every minute
setInterval(cleanup, WINDOW_MS);

module.exports = {
  hit(ip) {
    const now  = Date.now();
    const data = counters.get(ip) || { count: 0, windowStart: now };

    // Reset window if expired
    if (now - data.windowStart > WINDOW_MS) {
      data.count       = 0;
      data.windowStart = now;
    }

    data.count++;
    counters.set(ip, data);

    if (data.count > MAX_HITS) {
      blocked.set(ip, now + BLOCK_MS);
      console.warn(`[rateLimit] Blocked ${ip} (${data.count} hits / window)`);
    }
  },

  isBlocked(ip) {
    const until = blocked.get(ip);
    if (!until) return false;
    if (Date.now() > until) {
      blocked.delete(ip);
      return false;
    }
    return true;
  }
};

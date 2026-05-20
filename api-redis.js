'use strict';

const { createClient } = require('redis');

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';

const client = createClient({
  url: REDIS_URL,
  socket: {
    reconnectStrategy: (retries) => {
      if (retries > 10) {
        console.error('[redis] Too many reconnect attempts, giving up.');
        return new Error('Redis connection failed permanently.');
      }
      const delay = Math.min(retries * 100, 3000);
      console.log(`[redis] Reconnecting in ${delay}ms (attempt ${retries})…`);
      return delay;
    }
  }
});

client.on('error',   (err) => console.error('[redis] Client error:', err));
client.on('connect', ()    => console.log('[redis] Connected.'));
client.on('ready',   ()    => console.log('[redis] Ready.'));

(async () => {
  await client.connect();
})();

module.exports = client;

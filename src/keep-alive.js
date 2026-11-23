// whatsapp-gateway/src/keep-alive.js
// Proactive self-ping and connection heartbeat to ensure 24/7 continuous operation

import http from 'node:http';
import https from 'node:https';

export function startKeepAlive(service, options = {}) {
  const intervalMs = options.intervalMs || Number(process.env.KEEP_ALIVE_INTERVAL_MS) || 5 * 60 * 1000; // 5 minutes
  const selfUrl = process.env.SELF_URL || process.env.RENDER_EXTERNAL_URL;

  console.log(`[KeepAlive] 24/7 Heartbeat monitor active (Interval: ${Math.round(intervalMs / 1000)}s)`);

  // 1. Periodic self-ping (prevents free-tier hosting from sleeping)
  if (selfUrl) {
    const pingUrl = selfUrl.replace(/\/$/, '') + '/health';
    console.log(`[KeepAlive] Self-ping target configured: ${pingUrl}`);

    setInterval(() => {
      try {
        const client = pingUrl.startsWith('https') ? https : http;
        client
          .get(pingUrl, (res) => {
            // Drain data
            res.on('data', () => {});
          })
          .on('error', (err) => {
            console.warn('[KeepAlive] Self-ping warning:', err.message);
          });
      } catch (err) {
        console.warn('[KeepAlive] Self-ping exception:', err.message);
      }
    }, intervalMs);
  } else {
    console.log('[KeepAlive] Notice: SELF_URL not set. Configure SELF_URL or add UptimeRobot ping to keep awake.');
  }

  // 2. Continuous socket watchdog: verify client is connected if credentials exist
  setInterval(async () => {
    try {
      if (!service) return;
      const hasSavedCreds = service.hasCredentials();
      const isConnected = service.status === 'CONNECTED';

      if (hasSavedCreds && !isConnected && !service.isInitializing) {
        console.log('[KeepAlive Watchdog] Saved credentials exist but socket is not connected. Re-initiating connection...');
        await service.initialize().catch((err) => {
          console.warn('[KeepAlive Watchdog] Auto-reconnect notice:', err.message);
        });
      }
    } catch (e) {
      console.warn('[KeepAlive Watchdog] Exception:', e.message);
    }
  }, 45 * 1000); // Check every 45 seconds
}

// whatsapp-gateway/src/server.js
// 24/7 Dedicated Mealeato WhatsApp Gateway Server

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getWhatsAppGatewayService } from './gateway-service.js';
import { startKeepAlive } from './keep-alive.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3003;
const startTime = Date.now();

// Middleware
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

const service = getWhatsAppGatewayService();

// Root info
app.get('/', (req, res) => {
  res.json({
    service: 'Mealeato WhatsApp Gateway',
    version: '1.0.0',
    mode: '24/7 Persistent Worker',
    uptimeSeconds: Math.floor((Date.now() - startTime) / 1000),
    status: service.status,
    phoneNumber: service.phoneNumber,
  });
});

// Health check endpoint (for keep-alive & monitoring)
app.get('/health', (req, res) => {
  const isHealthy = true;
  res.status(isHealthy ? 200 : 503).json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    connected: service.status === 'CONNECTED',
    connectionStatus: service.status,
    phoneNumber: service.phoneNumber,
    timestamp: new Date().toISOString(),
  });
});

// Connection status
app.get('/api/whatsapp/status', (req, res) => {
  const statusInfo = service.getStatus();
  res.json(statusInfo);
});

// Get current QR code
app.get('/api/whatsapp/qr', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true' || req.query.force === 'true';

    let qrCode = service.qrCode?.dataUrl || null;

    if (forceRefresh || (!qrCode && service.status === 'DISCONNECTED' && !service.hasCredentials())) {
      console.log('[Server] Requesting fresh QR code...');
      await service.initialize();
      const qrObj = await service.waitForQrCode(6000);
      qrCode = qrObj?.dataUrl || service.qrCode?.dataUrl || null;
    }

    res.json({
      success: true,
      status: service.status,
      qrCode,
      available: Boolean(qrCode),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Explicit QR refresh
app.post('/api/whatsapp/qr', async (req, res) => {
  try {
    console.log('[Server] POST /api/whatsapp/qr - Explicit QR code refresh requested.');
    if (service.hasCredentials()) {
      return res.json({
        success: true,
        status: service.status,
        phoneNumber: service.phoneNumber,
        message: 'WhatsApp is already linked. To switch devices, use Disconnect first.',
        qrCode: null,
        available: false,
      });
    }

    if (service.status === 'DISCONNECTED') {
      await service.initialize();
    } else {
      await service.reconnect();
    }

    const qrObj = await service.waitForQrCode(8000);
    const qrCode = qrObj?.dataUrl || service.qrCode?.dataUrl || null;

    res.json({
      success: true,
      status: service.status,
      qrCode,
      available: Boolean(qrCode),
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Pairing code request
app.post('/api/whatsapp/pairing-code', async (req, res) => {
  try {
    const { phoneNumber } = req.body || {};
    if (!phoneNumber) {
      return res.status(400).json({ success: false, error: 'phoneNumber is required.' });
    }
    const result = await service.requestPairingCode(phoneNumber);
    res.json({
      success: true,
      pairingCode: result.pairingCode,
      phoneNumber: result.phoneNumber,
      status: service.status,
      message: 'Enter this 8-digit code in WhatsApp > Linked Devices > Link with phone number.',
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Send OTP
app.post('/api/whatsapp/send-otp', async (req, res) => {
  try {
    const { phone, name, code } = req.body || {};
    if (!phone) {
      return res.status(400).json({ success: false, error: 'phone is required.' });
    }
    const result = await service.sendOtp(phone, name, code);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Verify OTP
app.post('/api/whatsapp/verify-otp', async (req, res) => {
  try {
    const { phone, token } = req.body || {};
    if (!phone || !token) {
      return res.status(400).json({ success: false, error: 'phone and token are required.' });
    }
    const result = await service.verifyOtp(phone, token);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Transactional notification
app.post('/api/whatsapp/send-notification', async (req, res) => {
  try {
    const { phone, message, template, data } = req.body || {};
    if (!phone) {
      return res.status(400).json({ success: false, error: 'phone is required.' });
    }

    let finalMessage = message;
    if (!finalMessage && template) {
      finalMessage = template;
      if (data && typeof data === 'object') {
        for (const [key, val] of Object.entries(data)) {
          finalMessage = finalMessage.replace(new RegExp(`{${key}}`, 'g'), String(val));
        }
      }
    }

    if (!finalMessage) {
      return res.status(400).json({ success: false, error: 'message or template is required.' });
    }

    const result = await service.sendMessage(phone, finalMessage);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Test message
app.post('/api/whatsapp/test-message', async (req, res) => {
  try {
    const { phone, message } = req.body || {};
    if (!phone || !message) {
      return res.status(400).json({ success: false, error: 'phone and message are required.' });
    }
    const result = await service.sendMessage(phone, message);
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Disconnect
app.post('/api/whatsapp/disconnect', async (req, res) => {
  try {
    await service.disconnect({ cleanSession: true });
    res.json({ success: true, message: 'WhatsApp session disconnected and credentials purged.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Reconnect
app.post('/api/whatsapp/reconnect', async (req, res) => {
  try {
    await service.reconnect();
    res.json({ success: true, message: 'Reconnection triggered.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Start listening and boot service
app.listen(PORT, async () => {
  console.log(`[Mealeato WhatsApp Gateway] HTTP server running on port ${PORT}`);
  await service.boot();
  startKeepAlive(service);
});

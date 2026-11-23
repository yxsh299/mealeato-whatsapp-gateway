// whatsapp-gateway/src/gateway-service.js
// Persistent BerryProtocol WhatsApp WebSocket Service with Supabase Session Sync

import { EventEmitter } from 'node:events';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import qrcodeLib from 'qrcode';
import { restoreSessionFromSupabase, backupSessionToSupabase, clearSessionFromSupabase, getSupabase } from './session-sync.js';

let BerryProtocolClass = null;

async function loadBerryProtocol() {
  if (BerryProtocolClass) return BerryProtocolClass;
  try {
    const mod = await import('berryprotocol');
    BerryProtocolClass = mod.BerryProtocol || mod.default || mod.BerryClient;
    if (BerryProtocolClass) return BerryProtocolClass;
  } catch (err) {
    console.warn('[GatewayService] Direct import notice:', err.message);
  }

  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const mod = require('berryprotocol');
    BerryProtocolClass = mod.BerryProtocol || mod.default || mod.BerryClient;
    return BerryProtocolClass;
  } catch (err) {
    console.error('[GatewayService] Could not load berryprotocol module:', err.message);
    return null;
  }
}

export async function formatQrDataUrl(rawText) {
  if (!rawText) return null;
  if (typeof rawText === 'string' && rawText.startsWith('data:image/')) {
    return rawText;
  }
  let text = String(rawText);
  if (text.startsWith('2@') || text.startsWith('1@')) {
    text = `https://wa.me/settings/linked_devices#${text}`;
  }
  try {
    return await qrcodeLib.toDataURL(text, {
      width: 320,
      margin: 2,
      errorCorrectionLevel: 'M',
      color: { dark: '#000000', light: '#ffffff' },
    });
  } catch (e) {
    console.warn('[GatewayService] QR generation error:', e.message);
    return null;
  }
}

export class WhatsAppGatewayService extends EventEmitter {
  constructor() {
    super();
    const dataDir = path.resolve(process.cwd(), 'data');
    this.sessionPath = path.resolve(dataDir, 'whatsapp_auth');
    this.databasePath = path.resolve(dataDir, 'whatsapp_store.db');
    this.metaFile = path.resolve(dataDir, 'whatsapp_session.json');
    this.sessionId = 'mealeato_whatsapp_session';

    this.status = 'DISCONNECTED';
    this.phoneNumber = null;
    this.qrCode = null;
    this.pairingCode = null;
    this.pairingPhone = null;
    this.client = null;
    this.isInitializing = false;
    this.shouldKeepAlive = true;
    this.reconnectTimer = null;
    this.backupDebounceTimer = null;

    // In-memory OTP store & rate log
    this.otpChallenges = new Map();
    this.otpRequestLog = new Map();

    this.ensureDirectories();
  }

  ensureDirectories() {
    if (!fs.existsSync(this.sessionPath)) {
      fs.mkdirSync(this.sessionPath, { recursive: true });
    }
    const dbDir = path.dirname(this.databasePath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
  }

  hasCredentials() {
    const creds1 = path.join(this.sessionPath, 'creds.json');
    const creds2 = path.join(this.sessionPath, this.sessionId, 'creds.json');
    return fs.existsSync(creds1) || fs.existsSync(creds2);
  }

  cleanPhoneNumber(raw) {
    if (!raw) return null;
    let clean = String(raw).replace(/[^0-9]/g, '');
    if (clean.length === 10) clean = '91' + clean;
    else if (clean.length === 11 && clean.startsWith('0')) clean = '91' + clean.slice(1);
    return clean ? '+' + clean : null;
  }

  formatJid(to) {
    let clean = String(to || '').replace(/[^0-9]/g, '');
    if (clean.length === 10) clean = '91' + clean;
    else if (clean.length === 11 && clean.startsWith('0')) clean = '91' + clean.slice(1);
    return `${clean}@s.whatsapp.net`;
  }

  scheduleBackupToSupabase(delayMs = 2000) {
    clearTimeout(this.backupDebounceTimer);
    this.backupDebounceTimer = setTimeout(() => {
      const activeDir = fs.existsSync(path.join(this.sessionPath, this.sessionId, 'creds.json'))
        ? path.join(this.sessionPath, this.sessionId)
        : this.sessionPath;

      backupSessionToSupabase(activeDir, {
        phoneNumber: this.phoneNumber,
        sessionId: this.sessionId,
        status: this.status,
      }).catch((e) => console.warn('[GatewayService] Debounced backup warning:', e.message));
    }, delayMs);
  }

  async boot() {
    console.log('[GatewayService] Booting persistent WhatsApp gateway...');
    this.ensureDirectories();

    // 1. If local session missing, restore from Supabase
    const targetSessionDir = path.join(this.sessionPath, this.sessionId);
    if (!this.hasCredentials()) {
      const res = await restoreSessionFromSupabase(targetSessionDir);
      if (res.restored) {
        this.phoneNumber = res.phoneNumber || null;
      }
    }

    // 2. Restore meta file if available
    try {
      if (fs.existsSync(this.metaFile)) {
        const meta = JSON.parse(fs.readFileSync(this.metaFile, 'utf8'));
        if (meta.phoneNumber) this.phoneNumber = meta.phoneNumber;
      }
    } catch {}

    // 3. Auto-connect if credentials exist
    if (this.hasCredentials()) {
      console.log(`[GatewayService] Found saved credentials for ${this.phoneNumber || 'linked phone'}. Auto-connecting socket...`);
      await this.initialize().catch((err) => {
        console.warn(`[GatewayService] Initial auto-connect error: ${err.message}`);
      });
    } else {
      console.log('[GatewayService] No credentials saved yet. Ready for QR scan or pairing code.');
    }
  }

  async initialize() {
    this.shouldKeepAlive = true;
    if (this.isInitializing) return;
    this.isInitializing = true;

    try {
      this.ensureDirectories();
      const BerryProtocol = await loadBerryProtocol();
      if (!BerryProtocol) {
        throw new Error('BerryProtocol engine could not be loaded.');
      }

      if (this.client) {
        try {
          if (typeof this.client.removeAllListeners === 'function') {
            this.client.removeAllListeners();
          }
          await this.client.disconnect();
        } catch {}
        this.client = null;
      }

      this.status = 'CONNECTING';
      this.emit('status', this.status);

      this.client = new BerryProtocol({
        sessionId: this.sessionId,
        authFolder: this.sessionPath,
        databasePath: this.databasePath,
        printQrInTerminal: false,
        reconnectDelayMs: 3000,
        reconnectMaxAttempts: 25,
      });

      this.setupListeners();

      // If credentials exist, connect directly without generating a new QR
      if (this.hasCredentials()) {
        console.log('[GatewayService] Connecting with existing auth keys...');
        if (typeof this.client.connect === 'function') {
          this.client.connect().catch((err) => {
            console.warn(`[GatewayService] connect error: ${err.message}`);
          });
        } else {
          this.client.connectWithQr().catch((err) => {
            console.warn(`[GatewayService] connectWithQr fallback notice: ${err.message}`);
          });
        }
      } else {
        console.log('[GatewayService] No credentials, requesting QR...');
        this.client.connectWithQr().catch((err) => {
          console.warn(`[GatewayService] connectWithQr notice: ${err.message}`);
        });
      }
    } catch (err) {
      console.warn(`[GatewayService] Init error: ${err.message}`);
      this.status = 'DISCONNECTED';
      this.emit('status', this.status);
    } finally {
      this.isInitializing = false;
    }
  }

  setupListeners() {
    if (!this.client) return;
    let lastRawQr = null;

    const handleQrUpdate = async (value) => {
      if (!value) return;
      let rawText = typeof value === 'string' ? value : value?.value || value?.qr || String(value);
      if (!rawText || rawText === lastRawQr) return;
      lastRawQr = rawText;

      if (this.hasCredentials() && this.phoneNumber && this.status === 'CONNECTED') {
        return;
      }

      try {
        const dataUrl = await formatQrDataUrl(rawText);
        if (dataUrl) {
          this.qrCode = { raw: rawText, dataUrl };
          this.status = 'QR_READY';
          this.phoneNumber = null;
          this.emit('qr', this.qrCode);
          this.emit('status', this.status);
        }
      } catch (err) {
        console.error(`[GatewayService] QR render error: ${err.message}`);
      }
    };

    this.client.on('auth.qr', ({ value }) => handleQrUpdate(value));
    this.client.on('qr', (qr) => handleQrUpdate(qr));
    this.client.on('auth.link', ({ value }) => handleQrUpdate(value));

    this.client.on('auth.pairing_code', ({ code, phoneNumber }) => {
      this.pairingCode = code;
      this.pairingPhone = phoneNumber;
      this.status = 'PAIRING_CODE_READY';
      this.emit('pairing_code', { code, phoneNumber });
      this.emit('status', this.status);
    });

    this.client.on('connection.open', () => {
      this.status = 'CONNECTED';
      this.qrCode = null;
      this.pairingCode = null;
      this.pairingPhone = null;

      let phone = null;
      try {
        const rawUser = this.client.socket?.sock?.user?.id || this.client.socket?.sock?.user?.jid;
        if (rawUser) {
          const numberPart = rawUser.split(':')[0].split('@')[0];
          phone = this.cleanPhoneNumber(numberPart);
        }
      } catch {}

      if (phone) {
        this.phoneNumber = phone;
      }

      try {
        fs.writeFileSync(
          this.metaFile,
          JSON.stringify(
            {
              status: 'CONNECTED',
              phoneNumber: this.phoneNumber,
              sessionId: this.sessionId,
              platform: 'BerryProtocol v0.1.10 (24/7 Dedicated)',
              updatedAt: new Date().toISOString(),
            },
            null,
            2
          )
        );
      } catch {}

      console.log(`[GatewayService] ONLINE & CONNECTED as ${this.phoneNumber || 'Linked WhatsApp Account'}`);
      this.emit('ready', { phoneNumber: this.phoneNumber, sessionId: this.sessionId });
      this.emit('status', this.status);

      // Back up credentials to Supabase immediately (800ms) and debounce further updates
      this.scheduleBackupToSupabase(800);
    });

    this.client.on('connection.close', ({ reason, statusCode }) => {
      const isManual = reason === 'manual_logout' || statusCode === 401 || statusCode === 403;

      if (isManual) {
        console.log('[GatewayService] Manual logout or 401/403 logged out. Clearing session.');
        this.status = 'DISCONNECTED';
        this.phoneNumber = null;
        this.cleanLocalSession();
        clearSessionFromSupabase().catch(() => {});
        this.emit('disconnected', { reason: 'logged_out' });
        this.emit('status', this.status);
      } else {
        console.log(`[GatewayService] Socket closed (${reason || statusCode}). Preserving credentials while reconnecting...`);
        // If we have saved credentials, mark as CONNECTING so Polaris doesn't show offline panic
        if (this.hasCredentials()) {
          this.status = 'CONNECTING';
        } else {
          this.status = 'DISCONNECTED';
        }
        this.emit('disconnected', { reason, statusCode });
        this.emit('status', this.status);

        // BerryProtocol has internal auto-reconnect (reconnectDelayMs: 3000, reconnectMaxAttempts: 25).
        // Only trigger fallback re-initialization if connection remains down after 20 seconds.
        if (this.shouldKeepAlive && this.hasCredentials()) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => {
            if (this.status !== 'CONNECTED' && this.hasCredentials() && !this.isInitializing) {
              console.log('[GatewayService] Fallback watchdog: triggering fresh initialization...');
              this.initialize().catch(() => {});
            }
          }, 20000);
        }
      }
    });
  }

  cleanLocalSession() {
    try {
      if (fs.existsSync(this.sessionPath)) {
        fs.rmSync(this.sessionPath, { recursive: true, force: true });
      }
      fs.mkdirSync(this.sessionPath, { recursive: true });
    } catch {}

    try {
      if (fs.existsSync(this.metaFile)) fs.rmSync(this.metaFile, { force: true });
    } catch {}

    const dbFiles = [this.databasePath, `${this.databasePath}-wal`, `${this.databasePath}-shm`];
    for (const df of dbFiles) {
      try {
        if (fs.existsSync(df)) fs.rmSync(df, { force: true });
      } catch {}
    }

    this.status = 'DISCONNECTED';
    this.phoneNumber = null;
    this.qrCode = null;
    this.pairingCode = null;
    this.pairingPhone = null;
  }

  async waitForQrCode(timeoutMs = 8000) {
    if (this.qrCode && this.status === 'QR_READY') {
      return this.qrCode;
    }
    return new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          this.removeListener('qr', onQr);
          resolve(this.qrCode || null);
        }
      }, timeoutMs);

      const onQr = (qr) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.removeListener('qr', onQr);
          resolve(qr);
        }
      };

      this.once('qr', onQr);
    });
  }

  async requestPairingCode(rawPhone) {
    if (!rawPhone) throw new Error('Phone number is required for pairing code linking.');
    let clean = String(rawPhone).replace(/[^0-9]/g, '');
    if (clean.length === 10) clean = '91' + clean;
    else if (clean.length === 11 && clean.startsWith('0')) clean = '91' + clean.slice(1);

    await this.disconnect({ cleanSession: true });
    this.ensureDirectories();

    const BerryProtocol = await loadBerryProtocol();
    if (!BerryProtocol) throw new Error('BerryProtocol engine is not available.');

    this.status = 'CONNECTING';
    this.pairingCode = null;
    this.pairingPhone = clean;
    this.sessionId = 'mealeato_whatsapp_session';

    this.client = new BerryProtocol({
      sessionId: this.sessionId,
      authFolder: this.sessionPath,
      databasePath: this.databasePath,
      printQrInTerminal: false,
      reconnectDelayMs: 3000,
      reconnectMaxAttempts: 25,
    });

    this.setupListeners();
    this.client.connectWithPairingCode(clean).catch((err) => {
      console.warn(`[GatewayService] connectWithPairingCode notice: ${err.message}`);
    });

    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.removeListener('pairing_code', onCode);
      };

      const timer = setTimeout(() => {
        cleanup();
        if (this.pairingCode) {
          resolve({ success: true, pairingCode: this.pairingCode, phoneNumber: clean });
        } else {
          reject(new Error('Timed out waiting for WhatsApp pairing code.'));
        }
      }, 15000);

      const onCode = (data) => {
        cleanup();
        resolve({ success: true, pairingCode: data.code, phoneNumber: clean });
      };

      this.once('pairing_code', onCode);
    });
  }

  async disconnect(options = { cleanSession: true }) {
    this.shouldKeepAlive = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    if (this.client) {
      try {
        if (typeof this.client.removeAllListeners === 'function') {
          this.client.removeAllListeners();
        }
        await this.client.disconnect();
      } catch {}
      this.client = null;
    }

    if (options.cleanSession) {
      this.cleanLocalSession();
      await clearSessionFromSupabase().catch(() => {});
    } else {
      this.status = 'DISCONNECTED';
      this.phoneNumber = null;
      this.qrCode = null;
      this.pairingCode = null;
      this.pairingPhone = null;
    }

    this.emit('disconnected', { reason: 'manual_logout' });
    this.emit('status', this.status);
  }

  async reconnect() {
    console.log('[GatewayService] Reconnect requested. Preserving auth credentials...');
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    if (this.client) {
      try {
        if (typeof this.client.removeAllListeners === 'function') {
          this.client.removeAllListeners();
        }
        await this.client.disconnect();
      } catch {}
      this.client = null;
    }

    this.status = 'CONNECTING';
    this.emit('status', this.status);
    await this.initialize();
  }

  getStatus() {
    return {
      success: true,
      status: this.status,
      phoneNumber: this.phoneNumber,
      isConnected: this.status === 'CONNECTED',
      platform: 'BerryProtocol v0.1.10 (24/7 Dedicated)',
      sessionId: this.sessionId,
      qrCode: this.qrCode?.dataUrl || null,
      pairingCode: this.pairingCode,
      pairingPhone: this.pairingPhone,
      hasCredentials: this.hasCredentials(),
    };
  }

  async sendMessage(to, message) {
    const cleanTo = String(to || '').replace(/[^0-9]/g, '');
    if (!cleanTo) return { success: false, delivered: false, error: 'Recipient phone number is required.' };

    if (!this.client || this.status !== 'CONNECTED') {
      return {
        success: false,
        delivered: false,
        error: `WhatsApp is not connected (Status: ${this.status}). Please link WhatsApp in Polaris admin.`,
      };
    }

    const jid = this.formatJid(to);

    try {
      let result;
      if (typeof this.client.sendText === 'function') {
        result = await this.client.sendText(jid, message);
      } else if (typeof this.client.sendMessage === 'function') {
        result = await this.client.sendMessage(jid, { text: message });
      } else if (this.client.socket && typeof this.client.socket.sendMessage === 'function') {
        result = await this.client.socket.sendMessage(jid, { text: message });
      } else {
        throw new Error('No compatible message sending method found in BerryProtocol');
      }

      return {
        success: true,
        delivered: true,
        id: result?.id || `msg_${Date.now()}`,
      };
    } catch (err) {
      console.error(`[GatewayService] Send error to ${to}: ${err.message}`);
      return { success: false, delivered: false, error: err.message };
    }
  }

  async sendOtp(phone, customerName = '', customCode) {
    let clean = String(phone).replace(/[^0-9]/g, '');
    if (clean.length === 10) clean = '91' + clean;
    else if (clean.length === 11 && clean.startsWith('0')) clean = '91' + clean.slice(1);

    if (clean.length < 10) {
      return { success: false, error: 'Please enter a valid phone number.' };
    }

    const now = Date.now();
    const lastRequest = this.otpRequestLog.get(clean);
    const cooldownMs = 30 * 1000;

    if (lastRequest && now - lastRequest < cooldownMs) {
      const waitSec = Math.ceil((cooldownMs - (now - lastRequest)) / 1000);
      return {
        success: false,
        cooldownSeconds: waitSec,
        error: `Please wait ${waitSec}s before requesting a new OTP.`,
      };
    }

    const otpCode = customCode && /^[0-9]{4,6}$/.test(customCode.trim())
      ? customCode.trim()
      : String(crypto.randomInt(100000, 999999));

    const expiryMinutes = 5;
    const expiresAt = now + expiryMinutes * 60 * 1000;

    this.otpChallenges.set(clean, {
      phone: clean,
      code: otpCode,
      expiresAt,
      attempts: 0,
      createdAt: now,
    });
    this.otpRequestLog.set(clean, now);

    // Save challenge to Supabase
    try {
      const supabase = getSupabase();
      if (supabase) {
        await supabase.from('polaris_audit_log').insert({
          actor_id: '4cd8d158-d394-43b3-aa41-ab7460abb9de',
          action: 'whatsapp_otp_challenge',
          target_type: 'whatsapp_otp',
          target_id: clean,
          reason: `WhatsApp OTP challenge: ${clean}`,
          metadata: {
            phone: clean,
            code: otpCode,
            expires_at: expiresAt,
            attempts: 0,
            created_at: now,
          },
        });
      }
    } catch (saveErr) {
      console.warn('[GatewayService] Supabase OTP log notice:', saveErr.message);
    }

    const message = `*Mealeato Verification Code*\n\nYour security OTP is: *${otpCode}*\n\nValid for the next ${expiryMinutes} minutes. Never share this code with anyone.`;
    const dispatchResult = await this.sendMessage(clean, message);

    if (!dispatchResult.success) {
      return {
        success: true,
        delivered: false,
        otpLength: 6,
        message: 'Verification code generated for your WhatsApp number.',
        cooldownSeconds: 30,
        expiresInSeconds: expiryMinutes * 60,
      };
    }

    return {
      success: true,
      delivered: true,
      otpLength: 6,
      message: 'OTP sent successfully to your WhatsApp number.',
      cooldownSeconds: 30,
      expiresInSeconds: expiryMinutes * 60,
    };
  }

  async verifyOtp(phone, token) {
    let clean = String(phone).replace(/[^0-9]/g, '');
    if (clean.length === 10) clean = '91' + clean;
    else if (clean.length === 11 && clean.startsWith('0')) clean = '91' + clean.slice(1);

    let challenge = this.otpChallenges.get(clean);

    if (!challenge) {
      try {
        const supabase = getSupabase();
        if (supabase) {
          const { data: dbRecord } = await supabase
            .from('polaris_audit_log')
            .select('id, metadata, created_at')
            .eq('action', 'whatsapp_otp_challenge')
            .eq('target_id', clean)
            .order('created_at', { ascending: false })
            .limit(1)
            .maybeSingle();

          if (dbRecord?.metadata) {
            challenge = {
              phone: clean,
              code: String(dbRecord.metadata.code || ''),
              expiresAt: Number(dbRecord.metadata.expires_at || 0),
              attempts: Number(dbRecord.metadata.attempts || 0),
              createdAt: Number(dbRecord.metadata.created_at || 0),
            };
          }
        }
      } catch (err) {
        console.warn('[GatewayService] Supabase verify lookup notice:', err.message);
      }
    }

    if (!challenge) {
      return { success: false, verified: false, error: 'No OTP challenge found. Please request a new OTP.' };
    }

    if (Date.now() > challenge.expiresAt) {
      this.otpChallenges.delete(clean);
      return { success: false, verified: false, error: 'OTP has expired. Please request a new OTP.' };
    }

    if (challenge.attempts >= 5) {
      this.otpChallenges.delete(clean);
      return { success: false, verified: false, error: 'Too many incorrect attempts. Please request a new OTP.' };
    }

    const expected = Buffer.from(challenge.code, 'utf8');
    const received = Buffer.from(String(token || '').trim(), 'utf8');

    let isValid = false;
    if (expected.length === received.length) {
      isValid = crypto.timingSafeEqual(expected, received);
    }

    if (!isValid) {
      challenge.attempts++;
      return {
        success: false,
        verified: false,
        error: `Invalid OTP code. ${5 - challenge.attempts} attempts remaining.`,
      };
    }

    this.otpChallenges.delete(clean);
    return {
      success: true,
      verified: true,
      phone: clean,
    };
  }
}

// Global Singleton
let serviceInstance = null;
export function getWhatsAppGatewayService() {
  if (!serviceInstance) {
    serviceInstance = new WhatsAppGatewayService();
  }
  return serviceInstance;
}

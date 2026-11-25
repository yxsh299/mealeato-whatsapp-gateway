// whatsapp-gateway/src/session-sync.js
// Synchronizes WhatsApp session files with Supabase Storage (gzipped) to avoid PostgREST/Postgres WAL bloat

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const APP_CONFIG_KEY = 'whatsapp_session_backup';
const STORAGE_BUCKET = 'internal-backups';
const STORAGE_PATH = 'whatsapp/session-backup.json.gz';
const MIN_BACKUP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes between non-credential syncs

let supabaseClient = null;
let bucketEnsured = false;
let lastCredsHash = null;
let lastFullHash = null;
let lastBackupAt = 0;

export function getSupabase() {
  if (supabaseClient) return supabaseClient;
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.warn('[SessionSync] Supabase credentials not found. State persistence will be local only.');
    return null;
  }
  supabaseClient = createClient(url, key);
  return supabaseClient;
}

async function ensureStorageBucket(supabase) {
  if (bucketEnsured) return true;
  try {
    const { data } = await supabase.storage.getBucket(STORAGE_BUCKET);
    if (!data) {
      await supabase.storage.createBucket(STORAGE_BUCKET, { public: false });
    }
    bucketEnsured = true;
    return true;
  } catch (err) {
    try {
      await supabase.storage.createBucket(STORAGE_BUCKET, { public: false });
      bucketEnsured = true;
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Restores session files from Supabase Storage (with legacy app_config fallback) if local session is missing
 */
export async function restoreSessionFromSupabase(sessionDir) {
  try {
    const supabase = getSupabase();
    if (!supabase) return { restored: false, reason: 'no_supabase' };

    fs.mkdirSync(sessionDir, { recursive: true });

    const credsFile = path.join(sessionDir, 'creds.json');
    if (fs.existsSync(credsFile)) {
      console.log('[SessionSync] Local session files already exist. Skipping cloud restore.');
      return { restored: false, reason: 'local_already_exists' };
    }

    console.log('[SessionSync] Local session missing. Querying Supabase Storage for saved session backup...');
    let backupPayload = null;
    let backupDate = null;

    // 1. Primary: Compressed Storage object (zero PostgREST egress / Postgres WAL)
    try {
      const { data: blob, error: dlErr } = await supabase.storage.from(STORAGE_BUCKET).download(STORAGE_PATH);
      if (!dlErr && blob) {
        const arrBuf = await blob.arrayBuffer();
        const jsonBuf = zlib.gunzipSync(Buffer.from(arrBuf));
        backupPayload = JSON.parse(jsonBuf.toString('utf8'));
      }
    } catch (stErr) {
      console.warn('[SessionSync] Storage restore check notice:', stErr.message);
    }

    // 2. Legacy fallback: app_config row
    if (!backupPayload || !backupPayload.files) {
      const { data, error } = await supabase
        .from('app_config')
        .select('value, updated_at')
        .eq('key', APP_CONFIG_KEY)
        .maybeSingle();

      if (!error && data?.value?.files) {
        backupPayload = data.value;
        backupDate = data.updated_at;
      }
    }

    if (!backupPayload || !backupPayload.files) {
      console.log('[SessionSync] No previous session backup found in Supabase.');
      return { restored: false, reason: 'no_cloud_backup' };
    }

    const { files, phoneNumber, sessionId } = backupPayload;
    let restoredCount = 0;

    for (const [filename, content] of Object.entries(files)) {
      if (typeof content === 'string') {
        const destPath = path.join(sessionDir, filename);
        const fileDir = path.dirname(destPath);
        if (!fs.existsSync(fileDir)) {
          fs.mkdirSync(fileDir, { recursive: true });
        }
        if (content.startsWith('base64:')) {
          fs.writeFileSync(destPath, Buffer.from(content.slice(7), 'base64'));
        } else {
          fs.writeFileSync(destPath, content, 'utf8');
        }
        restoredCount++;
      }
    }

    console.log(`[SessionSync] Successfully restored ${restoredCount} session files for ${phoneNumber || 'Linked WhatsApp'} from Supabase!`);
    return {
      restored: true,
      phoneNumber,
      sessionId,
      restoredCount,
      backupDate,
    };
  } catch (err) {
    console.warn('[SessionSync] Restore error:', err.message);
    return { restored: false, error: err.message };
  }
}

/**
 * Backs up session files to Supabase Storage (gzipped, hash-deduped & throttled).
 */
export async function backupSessionToSupabase(sessionDir, meta = {}) {
  try {
    const supabase = getSupabase();
    if (!supabase) return { backedUp: false, reason: 'no_supabase' };

    if (!fs.existsSync(sessionDir)) return { backedUp: false, reason: 'dir_not_found' };

    const allFiles = fs.readdirSync(sessionDir);
    if (!allFiles.includes('creds.json')) {
      return { backedUp: false, reason: 'not_authenticated_yet' };
    }

    const filesPayload = {};
    for (const file of allFiles) {
      const fullPath = path.join(sessionDir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isFile() && stat.size < 500000) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          filesPayload[file] = content;
        } catch {
          const buf = fs.readFileSync(fullPath);
          filesPayload[file] = 'base64:' + buf.toString('base64');
        }
      }
    }

    const credsHash = crypto.createHash('sha256').update(String(filesPayload['creds.json'] || '')).digest('hex');
    const fullHash = crypto.createHash('sha256').update(JSON.stringify(filesPayload)).digest('hex');

    if (fullHash === lastFullHash) {
      return { backedUp: false, reason: 'unchanged' };
    }
    const now = Date.now();
    if (credsHash === lastCredsHash && now - lastBackupAt < MIN_BACKUP_INTERVAL_MS) {
      return { backedUp: false, reason: 'throttled' };
    }

    const payloadObj = {
      phoneNumber: meta.phoneNumber || null,
      sessionId: meta.sessionId || 'mealeato_whatsapp_session',
      status: meta.status || 'CONNECTED',
      fileCount: Object.keys(filesPayload).length,
      timestamp: now,
      files: filesPayload,
    };

    const ready = await ensureStorageBucket(supabase);
    if (!ready) {
      return { backedUp: false, error: 'storage_bucket_unavailable' };
    }

    const gzBuffer = zlib.gzipSync(Buffer.from(JSON.stringify(payloadObj), 'utf8'));
    const { error } = await supabase.storage.from(STORAGE_BUCKET).upload(STORAGE_PATH, gzBuffer, {
      contentType: 'application/gzip',
      upsert: true,
    });

    if (error) {
      console.warn('[SessionSync] Storage backup error:', error.message);
      return { backedUp: false, error: error.message };
    }

    lastCredsHash = credsHash;
    lastFullHash = fullHash;
    lastBackupAt = now;

    // Remove any legacy 1MB JSONB backup row from app_config to keep DB & WAL tiny
    try {
      await supabase.from('app_config').delete().eq('key', APP_CONFIG_KEY);
    } catch {}

    console.log(`[SessionSync] Backed up ${Object.keys(filesPayload).length} session files (${gzBuffer.length}B gzipped) to Supabase Storage.`);
    return { backedUp: true, count: Object.keys(filesPayload).length, bytes: gzBuffer.length };
  } catch (err) {
    console.warn('[SessionSync] Backup exception:', err.message);
    return { backedUp: false, error: err.message };
  }
}

/**
 * Clears saved session from Supabase when user explicitly logs out
 */
export async function clearSessionFromSupabase() {
  try {
    const supabase = getSupabase();
    if (!supabase) return;

    lastCredsHash = null;
    lastFullHash = null;
    lastBackupAt = 0;

    await supabase.storage.from(STORAGE_BUCKET).remove([STORAGE_PATH]).catch(() => {});
    await supabase.from('app_config').delete().eq('key', APP_CONFIG_KEY);
    console.log('[SessionSync] Cleared session backup from Supabase Storage & app_config.');
  } catch (err) {
    console.warn('[SessionSync] Clear session error:', err.message);
  }
}

// whatsapp-gateway/src/session-sync.js
// Synchronizes WhatsApp session files with Supabase for persistent multi-device survival

import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const APP_CONFIG_KEY = 'whatsapp_session_backup';

let supabaseClient = null;

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

/**
 * Restores session files from Supabase if local session is missing
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

    console.log('[SessionSync] Local session missing. Querying Supabase for saved session backup...');
    const { data, error } = await supabase
      .from('app_config')
      .select('value, updated_at')
      .eq('key', APP_CONFIG_KEY)
      .maybeSingle();

    if (error || !data || !data.value || !data.value.files) {
      console.log('[SessionSync] No previous session backup found in Supabase.');
      return { restored: false, reason: 'no_cloud_backup' };
    }

    const { files, phoneNumber, sessionId } = data.value;
    let restoredCount = 0;

    for (const [filename, content] of Object.entries(files)) {
      if (typeof content === 'string') {
        const destPath = path.join(sessionDir, filename);
        const fileDir = path.dirname(destPath);
        if (!fs.existsSync(fileDir)) {
          fs.mkdirSync(fileDir, { recursive: true });
        }
        // If content is base64 encoded binary
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
      backupDate: data.updated_at,
    };
  } catch (err) {
    console.warn('[SessionSync] Restore error:', err.message);
    return { restored: false, error: err.message };
  }
}

/**
 * Backs up session files to Supabase after pairing or credential update.
 * Uses UPSERT into app_config (single row, no log bloat).
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

    // UPSERT into app_config — single row, overwrites previous backup (no log bloat)
    const { error } = await supabase.from('app_config').upsert({
      key: APP_CONFIG_KEY,
      value: {
        phoneNumber: meta.phoneNumber || null,
        sessionId: meta.sessionId || 'mealeato_whatsapp_session',
        status: meta.status || 'CONNECTED',
        fileCount: Object.keys(filesPayload).length,
        timestamp: Date.now(),
        files: filesPayload,
      },
      updated_at: new Date().toISOString(),
      updated_by: 'gateway',
    }, { onConflict: 'key' });

    if (error) {
      console.warn('[SessionSync] Supabase backup error:', error.message);
      return { backedUp: false, error: error.message };
    }

    console.log(`[SessionSync] Backed up ${Object.keys(filesPayload).length} session files to Supabase for ${meta.phoneNumber || 'Linked WhatsApp'}.`);
    return { backedUp: true, count: Object.keys(filesPayload).length };
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

    await supabase.from('app_config').delete().eq('key', APP_CONFIG_KEY);
    console.log('[SessionSync] Cleared session backup from Supabase app_config.');
  } catch (err) {
    console.warn('[SessionSync] Clear session error:', err.message);
  }
}

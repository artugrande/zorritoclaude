// zorritov2/api/_lib/cron-tracker.js
/**
 * Cron run tracker — records each cron invocation to Vercel KV so we can
 * inspect later (e.g. via /api/cron-status) whether crons actually fired
 * and what happened.
 *
 * Storage layout:
 *   cron:last:<name>     → latest entry (object) with 35d TTL
 *   cron:history:<name>  → list, newest first, capped at 50
 *
 * Safe to call from any handler; degrades silently if KV is unavailable.
 */

let kv;
try { kv = require("@vercel/kv").kv; } catch { /* KV optional */ }

const HISTORY_MAX = 50;
const LAST_TTL_SEC = 60 * 60 * 24 * 35; // 35 days

async function recordCron(name, payload) {
  if (!kv) return;
  const entry = { ts: new Date().toISOString(), ...payload };
  try {
    await kv.set(`cron:last:${name}`, entry, { ex: LAST_TTL_SEC });
    await kv.lpush(`cron:history:${name}`, entry);
    await kv.ltrim(`cron:history:${name}`, 0, HISTORY_MAX - 1);
  } catch (e) {
    console.error(`[cron-tracker] failed to record ${name}:`, e.message);
  }
}

async function readCron(name, { history = false } = {}) {
  if (!kv) return history ? [] : null;
  try {
    if (history) {
      const items = await kv.lrange(`cron:history:${name}`, 0, HISTORY_MAX - 1);
      return Array.isArray(items) ? items : [];
    }
    return await kv.get(`cron:last:${name}`);
  } catch (e) {
    console.error(`[cron-tracker] failed to read ${name}:`, e.message);
    return history ? [] : null;
  }
}

module.exports = { recordCron, readCron };

/**
 * /api/self-verify
 * Called by the Self app after the user scans their passport.
 */

const { SelfBackendVerifier, AllIds, DefaultConfigStore } = require('@selfxyz/core');
const { kv } = require('@vercel/kv');

const SCOPE    = 'zorrito-self-test';
const ENDPOINT = 'https://www.zorrito.app/api/self-verify';

const configStore = new DefaultConfigStore({
  excludedCountries: [],
  ofac: false,
});

const verifier = new SelfBackendVerifier(
  SCOPE, ENDPOINT, false, AllIds, configStore, 'uuid'
);

async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // GET — endpoint health check
  if (req.method === 'GET') {
    return res.status(200).json({ status: 'ready', scope: SCOPE });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Save debug snapshot
  try {
    await kv.set('self:debug:last-body', {
      rawBody: JSON.stringify(req.body).slice(0, 1000),
      contentType: req.headers['content-type'],
      ts: Date.now()
    }, { ex: 3600 });
  } catch(_) {}

  const { attestationId, proof, publicSignals, userContextData } = req.body || {};

  // Handshake POST — Self checks endpoint is alive before sending proof
  if (!proof && !publicSignals) {
    return res.status(200).json({ status: 'ready' });
  }

  try {
    const result = await verifier.verify(attestationId, proof, publicSignals, userContextData || '');

    if (result.isValidDetails?.isValid) {
      const userId = result.userData?.userIdentifier || 'unknown';
      const nationality = result.discloseOutput?.nationality || null;
      await kv.set(`self:${userId}`, { verified: true, nationality, timestamp: Date.now() }, { ex: 3600 });
      console.log(`[self-verify] ✅ ${userId} nationality=${nationality}`);
      return res.status(200).json({ status: 'ok', result: true, userId, nationality });
    } else {
      return res.status(400).json({ status: 'error', result: false, error: 'Invalid proof' });
    }
  } catch (err) {
    console.error('[self-verify]', err.message);
    return res.status(500).json({ error: err.message });
  }
}

module.exports = handler;

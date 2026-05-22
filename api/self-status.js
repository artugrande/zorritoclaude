/**
 * /api/self-status?userId=XXX
 *
 * Frontend polls this after returning from Self app
 * to check if the verification was completed.
 */

const { kv } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'Missing userId' });

  const result = await kv.get(`self:${userId}`);

  if (result?.verified) {
    return res.status(200).json({ verified: true, nationality: result.nationality || null, timestamp: result.timestamp });
  } else {
    return res.status(200).json({ verified: false });
  }
};

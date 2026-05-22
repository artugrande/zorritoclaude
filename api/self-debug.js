const { kv } = require('@vercel/kv');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const [post, get] = await Promise.all([
    kv.get('self:debug:last-body'),
    kv.get('self:debug:last-get'),
  ]);
  return res.status(200).json({ lastPost: post, lastGet: get });
};

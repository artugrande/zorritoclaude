// zorritov2/api/fox-gallery.js
const { kv } = require("@vercel/kv");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const raw     = await kv.get("fox:gallery");
    // KV auto-parses JSON, so raw may already be an array
    const gallery = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []);
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ gallery });
  } catch (err) {
    console.error("[fox-gallery] error:", err.message);
    return res.status(500).json({ error: "Error cargando galería" });
  }
};

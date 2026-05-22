// zorritov2/api/share.js
/**
 * Per-user share page with dynamic OG/Twitter card image.
 * If the address has a generated AI fox in the gallery, that image is used
 * as og:image / twitter:image. Otherwise falls back to the default brand
 * image (assets/zorritoimage.png).
 *
 *   GET /api/share?addr=0x...        — full share landing (HTML)
 *   GET /api/share?ref=XXXXXXXX      — accepts 8-char hex refCode, resolves
 *                                       it to the owner address via the contract
 *
 * The page itself immediately redirects (meta refresh + JS) to the home with
 * the ref param preserved, so when someone clicks the Twitter link they land
 * on the actual dApp. But Twitter's crawler reads the og:image first and
 * shows the fox in the embed.
 */

const { ethers } = require("ethers");

let kv = null;
try { kv = require("@vercel/kv").kv; } catch { /* optional */ }

const CONTRACT = (process.env.V2_CONTRACT_ADDRESS || process.env.CONTRACT_ADDRESS ||
                  "0x8f4E627d4C4Af5dfE11908Bd8B929588d9Ee58c9").trim();
const RPC      = (process.env.CELO_RPC_URL || "https://forno.celo.org").trim();
const DEFAULT_IMG = "https://www.zorrito.app/assets/zorritoimage.png";

const escapeHtml = (s) => String(s || "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

async function resolveAddressFromRefCode(refCode) {
  if (!/^0x[0-9a-fA-F]{8}$/.test(refCode)) return null;
  const provider = new ethers.JsonRpcProvider(
    RPC, { chainId: 42220, name: "celo" }, { staticNetwork: true }
  );
  const c = new ethers.Contract(CONTRACT, [
    "function codeOwner(bytes4) view returns (address)",
  ], provider);
  try {
    const owner = await c.codeOwner(refCode);
    if (owner === ethers.ZeroAddress) return null;
    return owner.toLowerCase();
  } catch { return null; }
}

async function getFoxImage(address) {
  if (!address || !kv) return null;
  try {
    const meta = await kv.get(`fox:wallet:${address.toLowerCase()}`);
    if (!meta) return null;
    const data = typeof meta === "string" ? JSON.parse(meta) : meta;
    if (data?.imageUrl) return data.imageUrl;
  } catch (e) { console.warn("[share] KV read err:", e.message); }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Resolve target address
  let address = (req.query?.addr || "").trim().toLowerCase();
  const refCode = (req.query?.ref || "").trim().toLowerCase();
  let refDisplay = refCode;

  if (!address && refCode) {
    const cleanRef = refCode.startsWith("0x") ? refCode : "0x" + refCode;
    const resolved = await resolveAddressFromRefCode(cleanRef);
    if (resolved) {
      address = resolved;
      refDisplay = cleanRef.replace(/^0x/, "");
    }
  }

  // Validate address (if present)
  if (address && !ethers.isAddress(address)) address = "";

  // Pick image
  const foxImg = address ? await getFoxImage(address) : null;
  const ogImage = foxImg || DEFAULT_IMG;
  const isCustomFox = !!foxImg;

  // Build redirect URL — preserve ref param if present
  const redirectUrl = refDisplay
    ? `https://www.zorrito.app/?ref=${encodeURIComponent(refDisplay)}`
    : "https://www.zorrito.app/";

  const title = isCustomFox
    ? "Mirá mi zorro de Zorrito V2 🦊"
    : "Zorrito V2 — Ahorrá USDT en Celo, ganá un premio extra semanal";
  const desc = isCustomFox
    ? "Estoy ahorrando USDT en Celo con Zorrito. Yield de Aave + premio extra cada lunes. Unite y armá tu zorro IA."
    : "Plataforma de ahorro en USDT sobre Celo + Aave. Cada lunes se sortea el rendimiento entre los depositores. Disponible en MiniPay.";

  // Build HTML
  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}">
<link rel="canonical" href="${escapeHtml(redirectUrl)}">

<!-- Open Graph -->
<meta property="og:type" content="website">
<meta property="og:site_name" content="Zorrito V2">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(desc)}">
<meta property="og:url" content="${escapeHtml(redirectUrl)}">
<meta property="og:image" content="${escapeHtml(ogImage)}">
<meta property="og:image:alt" content="${escapeHtml(title)}">

<!-- Twitter -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:site" content="@ZorritoApp">
<meta name="twitter:title" content="${escapeHtml(title)}">
<meta name="twitter:description" content="${escapeHtml(desc)}">
<meta name="twitter:image" content="${escapeHtml(ogImage)}">

<meta http-equiv="refresh" content="0; url=${escapeHtml(redirectUrl)}">
<style>
  body { font-family: system-ui, sans-serif; background:#fffbf3; color:#222; margin:0; padding:40px 20px; text-align:center; }
  img { max-width: 320px; border-radius: 18px; box-shadow: 0 12px 40px rgba(0,0,0,.15); }
  a { color: #FD840E; text-decoration: none; font-weight: 700; }
</style>
</head>
<body>
<img src="${escapeHtml(ogImage)}" alt="${escapeHtml(title)}">
<p>Redirigiendo a <a href="${escapeHtml(redirectUrl)}">Zorrito V2</a>…</p>
<script>window.location.href = ${JSON.stringify(redirectUrl)};</script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  // Allow CDN to cache by the actual query (per-fox card stays fresh)
  res.setHeader("Cache-Control", "public, max-age=300, s-maxage=300");
  res.status(200).send(html);
};

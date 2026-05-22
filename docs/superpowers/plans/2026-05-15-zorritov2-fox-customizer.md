# ZorritoV2 Fox Customizer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an AI fox image generator to ZorritoV2. Users with a deposit select predefined traits + optional free-text description, pay 1 USDT, get a FLUX-generated fox image stored in Vercel Blob (one per wallet, new replaces old). All generated foxes appear in a public gallery.

**Architecture:** Three new files — `zorritov2/api/fox-generate.js` (payment verification + FLUX call + storage), `zorritov2/api/fox-gallery.js` (gallery data), `zorritov2/frontend/fox-gallery.html` (public gallery) — plus a new section added to `zorritov2/frontend/index.html`. Data stored in Vercel Blob (images) and Vercel KV (metadata + gallery list). Payment: user transfers 1 USDT on-chain to `PLATFORM_WALLET`, provides the tx hash; API verifies on-chain before generating.

**Tech Stack:** Node.js (CommonJS, matching existing API files), `@fal-ai/client`, `@vercel/blob`, `@vercel/kv`, ethers v6, FLUX schnell model

---

## File Map

| Path | Role |
|------|------|
| `zorritov2/package.json` | Add `@fal-ai/client`, `@vercel/blob`, `@vercel/kv` dependencies |
| `zorritov2/api/fox-generate.js` | POST — verify payment, generate image, store Blob + KV |
| `zorritov2/api/fox-gallery.js` | GET — return gallery array from KV |
| `zorritov2/frontend/index.html` | Add fox customizer section (after referral section) |
| `zorritov2/frontend/fox-gallery.html` | Public gallery page |

## KV Data Model

```
fox:wallet:{walletLower}  →  JSON { imageUrl, traits, prompt, timestamp, wallet }
fox:gallery               →  JSON array (max 100) of { wallet, imageUrl, traits, timestamp }
fox:used:{txHashLower}    →  "1"   (replay protection — expire after 7 days)
```

## Environment Variables Required

```
FAL_KEY=fal_...                                         # fal.ai API key
PLATFORM_WALLET=0x19eC1797000F434EB2fd622E642BeF80234425cb  # receives the 1 USDT
BLOB_READ_WRITE_TOKEN=...                               # auto-set by Vercel Blob
KV_REST_API_URL=...                                     # auto-set by Vercel KV
KV_REST_API_TOKEN=...                                   # auto-set by Vercel KV
```

## Traits Definition (for both API and frontend)

```js
const TRAITS = {
  fur: {
    label: "Pelaje",
    options: [
      { id: "orange",  label: "🟠 Naranja",    prompt: "orange fur" },
      { id: "red",     label: "🔴 Rojo",       prompt: "red fur" },
      { id: "white",   label: "⬜ Blanco",      prompt: "white fur" },
      { id: "brown",   label: "🟤 Marrón",     prompt: "brown fur" },
      { id: "black",   label: "🖤 Negro",       prompt: "black fur" },
    ],
  },
  accessory: {
    label: "Accesorio",
    options: [
      { id: "sunglasses", label: "🕶️ Lentes",        prompt: "wearing stylish sunglasses" },
      { id: "cowboy",     label: "🤠 Sombrero",       prompt: "wearing a cowboy hat" },
      { id: "scarf",      label: "🧣 Bufanda",        prompt: "wearing a colorful scarf" },
      { id: "chain",      label: "🔗 Collar cripto",  prompt: "wearing a gold chain with a coin pendant" },
      { id: "none",       label: "✨ Sin accesorio",  prompt: "" },
    ],
  },
  background: {
    label: "Fondo",
    options: [
      { id: "jungle",  label: "🌿 Selva",     prompt: "tropical jungle background" },
      { id: "city",    label: "🏙️ Ciudad",    prompt: "neon city night background" },
      { id: "beach",   label: "🏖️ Playa",     prompt: "sunset beach background" },
      { id: "space",   label: "🌌 Espacio",   prompt: "starry space background with planets" },
      { id: "defi",    label: "💰 DeFi",      prompt: "futuristic crypto DeFi aesthetic background with charts" },
    ],
  },
  expression: {
    label: "Expresión",
    options: [
      { id: "happy",     label: "😊 Feliz",      prompt: "happy cheerful expression" },
      { id: "cool",      label: "😎 Cool",        prompt: "cool confident expression" },
      { id: "powerful",  label: "💪 Poderoso",    prompt: "powerful determined expression" },
      { id: "mysterious",label: "🔮 Misterioso",  prompt: "mysterious expression with glowing eyes" },
    ],
  },
};
```

## Prompt Builder

```js
function buildPrompt(traits, description) {
  const parts = [
    "A cute anthropomorphic fox character,",
    traits.fur,
    traits.accessory,
    traits.background,
    traits.expression,
    description ? description.trim() : "",
    "digital art, cartoon illustration style, vibrant colors, high quality",
  ].filter(Boolean).join(", ");
  return parts;
}
```

---

## Task 1: package.json + Dependencies

**Files:**
- Create: `zorritov2/package.json`

- [ ] **Step 1: Create `zorritov2/package.json`**

```json
{
  "name": "zorritov2-api",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "@fal-ai/client": "^1.3.0",
    "@vercel/blob": "^0.27.0",
    "@vercel/kv": "^3.0.0",
    "ethers": "^6.11.1"
  }
}
```

- [ ] **Step 2: Install dependencies**

```bash
cd zorritov2 && npm install && cd ..
```

Expected: `node_modules/` created inside `zorritov2/` with the 4 packages.

- [ ] **Step 3: Verify**

```bash
node -e "require('./zorritov2/node_modules/@fal-ai/client'); console.log('fal OK')"
node -e "require('./zorritov2/node_modules/@vercel/blob'); console.log('blob OK')"
node -e "require('./zorritov2/node_modules/@vercel/kv'); console.log('kv OK')"
```

- [ ] **Step 4: Commit**

```bash
git add zorritov2/package.json zorritov2/package-lock.json
git commit -m "feat(v2/fox): add package.json with fal-ai, blob, kv deps"
```

---

## Task 2: fox-generate.js API

**Files:**
- Create: `zorritov2/api/fox-generate.js`

This is the core endpoint. It:
1. Only accepts POST
2. Parses `{ wallet, txHash, traits, description }` from request body
3. Validates inputs
4. Checks `fox:used:{txHash}` in KV (replay protection)
5. Verifies on-chain: tx receipt → logs → USDT Transfer from `wallet` to `PLATFORM_WALLET` ≥ 1 USDT
6. Marks tx as used in KV (7-day TTL)
7. Builds prompt from traits + description
8. Calls fal.ai FLUX schnell
9. Downloads generated image buffer
10. Uploads to Vercel Blob (`fox/{wallet}.png`, `addRandomSuffix: false`)
11. Saves metadata to `fox:wallet:{wallet}` in KV
12. Updates `fox:gallery` list in KV (prepend, remove old entry for same wallet, max 100)
13. Returns `{ imageUrl }`

- [ ] **Step 1: Write `zorritov2/api/fox-generate.js`**

```js
// zorritov2/api/fox-generate.js
const { ethers } = require("ethers");
const { fal }    = require("@fal-ai/client");
const { put }    = require("@vercel/blob");
const { kv }     = require("@vercel/kv");

const RPC              = process.env.CELO_RPC_URL || "https://forno.celo.org";
const USDT_ADDRESS     = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const PLATFORM_WALLET  = (process.env.PLATFORM_WALLET || "").toLowerCase();
const MIN_AMOUNT       = 1_000_000n; // 1 USDT (6 decimals)
const GALLERY_MAX      = 100;

// USDT Transfer event topic
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

const VALID_FURS        = ["orange","red","white","brown","black"];
const VALID_ACCESSORIES = ["sunglasses","cowboy","scarf","chain","none"];
const VALID_BACKGROUNDS = ["jungle","city","beach","space","defi"];
const VALID_EXPRESSIONS = ["happy","cool","powerful","mysterious"];

const FUR_PROMPT = {
  orange: "orange fur", red: "red fur", white: "white fur",
  brown: "brown fur", black: "black fur",
};
const ACCESSORY_PROMPT = {
  sunglasses: "wearing stylish sunglasses",
  cowboy: "wearing a cowboy hat",
  scarf: "wearing a colorful scarf",
  chain: "wearing a gold chain with a coin pendant",
  none: "",
};
const BACKGROUND_PROMPT = {
  jungle: "tropical jungle background",
  city: "neon city night background",
  beach: "sunset beach background",
  space: "starry space background with planets",
  defi: "futuristic crypto DeFi aesthetic background with charts",
};
const EXPRESSION_PROMPT = {
  happy: "happy cheerful expression",
  cool: "cool confident expression",
  powerful: "powerful determined expression",
  mysterious: "mysterious expression with glowing eyes",
};

function buildPrompt(traits, description) {
  const parts = [
    "A cute anthropomorphic fox character,",
    FUR_PROMPT[traits.fur],
    ACCESSORY_PROMPT[traits.accessory],
    BACKGROUND_PROMPT[traits.background],
    EXPRESSION_PROMPT[traits.expression],
    description ? description.trim().slice(0, 200) : "",
    "digital art, cartoon illustration style, vibrant colors, high quality",
  ].filter(Boolean).join(", ");
  return parts;
}

async function verifyPayment(provider, txHash, fromWallet) {
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error("Transacción no encontrada o no confirmada");
  if (receipt.status !== 1) throw new Error("Transacción fallida");

  const usdtAddr = USDT_ADDRESS.toLowerCase();
  const from     = fromWallet.toLowerCase();
  const to       = PLATFORM_WALLET;

  if (!to) throw new Error("PLATFORM_WALLET no configurada");

  // Find Transfer log from USDT contract
  const transferLog = receipt.logs.find(log => {
    if (log.address.toLowerCase() !== usdtAddr) return false;
    if (log.topics[0] !== TRANSFER_TOPIC) return false;
    if (log.topics.length < 3) return false;
    const logFrom = "0x" + log.topics[1].slice(26);
    const logTo   = "0x" + log.topics[2].slice(26);
    return logFrom.toLowerCase() === from && logTo.toLowerCase() === to;
  });

  if (!transferLog) {
    throw new Error("No se encontró una transferencia de 1 USDT a la wallet de la plataforma");
  }

  const amount = BigInt(transferLog.data);
  if (amount < MIN_AMOUNT) {
    throw new Error(`Monto insuficiente: ${amount} (mínimo ${MIN_AMOUNT})`);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Parse body
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: "Body inválido" });
  }

  const { wallet, txHash, traits, description = "" } = body || {};

  // Validate inputs
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "wallet inválida" });
  }
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return res.status(400).json({ error: "txHash inválido" });
  }
  if (!traits || typeof traits !== "object") {
    return res.status(400).json({ error: "traits requeridos" });
  }
  if (!VALID_FURS.includes(traits.fur))              return res.status(400).json({ error: "fur inválido" });
  if (!VALID_ACCESSORIES.includes(traits.accessory)) return res.status(400).json({ error: "accessory inválido" });
  if (!VALID_BACKGROUNDS.includes(traits.background))return res.status(400).json({ error: "background inválido" });
  if (!VALID_EXPRESSIONS.includes(traits.expression)) return res.status(400).json({ error: "expression inválido" });

  const walletLower = wallet.toLowerCase();
  const txHashLower = txHash.toLowerCase();

  try {
    // Replay protection
    const alreadyUsed = await kv.get(`fox:used:${txHashLower}`);
    if (alreadyUsed) {
      return res.status(400).json({ error: "Esta transacción ya fue usada" });
    }

    // Verify payment on-chain
    const provider = new ethers.JsonRpcProvider(RPC);
    await verifyPayment(provider, txHash, wallet);

    // Mark tx as used (7-day TTL)
    await kv.set(`fox:used:${txHashLower}`, "1", { ex: 7 * 24 * 3600 });

    // Build prompt and generate image
    const prompt = buildPrompt(traits, description);
    console.log(`[fox-generate] wallet=${wallet} prompt="${prompt}"`);

    fal.config({ credentials: process.env.FAL_KEY });
    const result = await fal.subscribe("fal-ai/flux/schnell", {
      input: {
        prompt,
        image_size: "square_hd",
        num_inference_steps: 4,
        num_images: 1,
        enable_safety_checker: true,
      },
    });

    const imageUrl = result.data?.images?.[0]?.url;
    if (!imageUrl) throw new Error("fal.ai no devolvió imagen");

    // Download image
    const imageResp = await fetch(imageUrl);
    if (!imageResp.ok) throw new Error("No se pudo descargar la imagen de fal.ai");
    const imageBuffer = Buffer.from(await imageResp.arrayBuffer());

    // Upload to Vercel Blob
    const blob = await put(`fox/${walletLower}.png`, imageBuffer, {
      access: "public",
      contentType: "image/png",
      addRandomSuffix: false,
    });

    // Save metadata to KV
    const metadata = {
      wallet: walletLower,
      imageUrl: blob.url,
      traits,
      prompt,
      timestamp: Date.now(),
    };
    await kv.set(`fox:wallet:${walletLower}`, JSON.stringify(metadata));

    // Update gallery list
    let gallery = [];
    try {
      const raw = await kv.get("fox:gallery");
      gallery = raw ? JSON.parse(raw) : [];
    } catch { gallery = []; }

    // Remove existing entry for this wallet
    gallery = gallery.filter(e => e.wallet !== walletLower);
    // Prepend new entry
    gallery.unshift({ wallet: walletLower, imageUrl: blob.url, traits, timestamp: metadata.timestamp });
    // Cap at max
    gallery = gallery.slice(0, GALLERY_MAX);
    await kv.set("fox:gallery", JSON.stringify(gallery));

    console.log(`[fox-generate] ✅ done wallet=${wallet} blob=${blob.url}`);
    return res.status(200).json({ imageUrl: blob.url });

  } catch (err) {
    console.error("[fox-generate] error:", err.message);
    return res.status(500).json({ error: err.message || "Error interno" });
  }
};
```

- [ ] **Step 2: Verify syntax**

```bash
node -e "
const fn = require('./zorritov2/api/fox-generate.js');
console.log('fox-generate loaded OK, type:', typeof fn);
"
```

Expected: `fox-generate loaded OK, type: function`

- [ ] **Step 3: Commit**

```bash
git add zorritov2/api/fox-generate.js
git commit -m "feat(v2/fox): fox-generate API — payment verify + FLUX + Blob + KV"
```

---

## Task 3: fox-gallery.js API

**Files:**
- Create: `zorritov2/api/fox-gallery.js`

Simple GET endpoint that returns the gallery array from KV.

- [ ] **Step 1: Write `zorritov2/api/fox-gallery.js`**

```js
// zorritov2/api/fox-gallery.js
const { kv } = require("@vercel/kv");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const raw     = await kv.get("fox:gallery");
    const gallery = raw ? JSON.parse(raw) : [];
    res.setHeader("Cache-Control", "public, s-maxage=30, stale-while-revalidate=60");
    return res.status(200).json({ gallery });
  } catch (err) {
    console.error("[fox-gallery] error:", err.message);
    return res.status(500).json({ error: "Error cargando galería" });
  }
};
```

- [ ] **Step 2: Verify syntax**

```bash
node -e "
const fn = require('./zorritov2/api/fox-gallery.js');
console.log('fox-gallery loaded OK, type:', typeof fn);
"
```

- [ ] **Step 3: Commit**

```bash
git add zorritov2/api/fox-gallery.js
git commit -m "feat(v2/fox): fox-gallery API — returns gallery from KV"
```

---

## Task 4: Fox Customizer section in index.html

**Files:**
- Modify: `zorritov2/frontend/index.html`

Add the fox customizer section after `section-referral` div (deposit-gated). The section has:
- Trait selector grid (fur, accessory, background, expression) using pill/chip buttons
- Optional description input (max 200 chars)
- Current fox preview (loads from `/api/fox-gallery` filtered by wallet, or `fox:wallet` directly)
- "Generar mi Zorro" button → pays 1 USDT on-chain then calls API
- Cost label: "1 USDT por generación"

The JS logic (appended to `app.js` or inline in a `<script>` tag at the bottom of index.html) must:
1. On connect: fetch current fox for this wallet from `/api/fox-gallery` and display preview
2. On "Generar": send 1 USDT transfer via `usdtW.transfer(PLATFORM_WALLET, 1_000_000n)`, wait for receipt, call `POST /api/fox-generate`, display result

- [ ] **Step 1: Add CSS for fox section**

Add these styles inside the existing `<style>` block in `zorritov2/frontend/index.html` (before closing `</style>`):

```css
/* ── Fox Customizer ── */
.trait-group { margin-bottom:12px; }
.trait-label { font-size:0.72rem; font-weight:700; text-transform:uppercase;
  letter-spacing:.06em; color:var(--muted); margin-bottom:8px; }
.trait-pills { display:flex; flex-wrap:wrap; gap:6px; }
.trait-pill { padding:6px 12px; border-radius:99px; border:1.5px solid #e0e0e0;
  background:#fff; font-size:0.82rem; font-weight:600; cursor:pointer;
  font-family:var(--font); color:var(--muted); transition:all .15s; }
.trait-pill:hover  { border-color:var(--orange); color:var(--orange); }
.trait-pill.active { border-color:var(--orange); background:#fff3e0; color:var(--orange); }
.fox-preview { width:100%; aspect-ratio:1; border-radius:16px; object-fit:cover;
  border:2px solid var(--border); background:#f5f5f5; display:block; }
.fox-placeholder { width:100%; aspect-ratio:1; border-radius:16px; border:2px dashed #e0e0e0;
  display:flex; align-items:center; justify-content:center;
  flex-direction:column; gap:8px; background:#fafafa; }
.fox-generating { opacity:.5; pointer-events:none; }
```

- [ ] **Step 2: Add HTML for fox section**

Add this HTML block immediately after the `</div><!-- /section-referral -->` closing div, still inside `#connected-state`:

```html
    <!-- Fox Customizer section -->
    <div id="section-fox" style="display:none;">
      <div class="section-label">Tu Zorro IA</div>
      <div class="card">
        <div class="card-title">Generá tu zorro personalizado · 1 USDT</div>

        <!-- Current fox preview -->
        <div id="fox-preview-wrap" class="fox-placeholder">
          <span style="font-size:2.5rem;">🦊</span>
          <span style="font-size:0.8rem;color:var(--muted);">Tu zorro aparecerá acá</span>
        </div>

        <div style="margin-top:14px;">
          <!-- Fur -->
          <div class="trait-group">
            <div class="trait-label">Pelaje</div>
            <div class="trait-pills" id="pills-fur">
              <button class="trait-pill active" data-trait="fur" data-value="orange">🟠 Naranja</button>
              <button class="trait-pill" data-trait="fur" data-value="red">🔴 Rojo</button>
              <button class="trait-pill" data-trait="fur" data-value="white">⬜ Blanco</button>
              <button class="trait-pill" data-trait="fur" data-value="brown">🟤 Marrón</button>
              <button class="trait-pill" data-trait="fur" data-value="black">🖤 Negro</button>
            </div>
          </div>
          <!-- Accessory -->
          <div class="trait-group">
            <div class="trait-label">Accesorio</div>
            <div class="trait-pills" id="pills-accessory">
              <button class="trait-pill active" data-trait="accessory" data-value="sunglasses">🕶️ Lentes</button>
              <button class="trait-pill" data-trait="accessory" data-value="cowboy">🤠 Sombrero</button>
              <button class="trait-pill" data-trait="accessory" data-value="scarf">🧣 Bufanda</button>
              <button class="trait-pill" data-trait="accessory" data-value="chain">🔗 Collar</button>
              <button class="trait-pill" data-trait="accessory" data-value="none">✨ Ninguno</button>
            </div>
          </div>
          <!-- Background -->
          <div class="trait-group">
            <div class="trait-label">Fondo</div>
            <div class="trait-pills" id="pills-background">
              <button class="trait-pill active" data-trait="background" data-value="defi">💰 DeFi</button>
              <button class="trait-pill" data-trait="background" data-value="jungle">🌿 Selva</button>
              <button class="trait-pill" data-trait="background" data-value="city">🏙️ Ciudad</button>
              <button class="trait-pill" data-trait="background" data-value="beach">🏖️ Playa</button>
              <button class="trait-pill" data-trait="background" data-value="space">🌌 Espacio</button>
            </div>
          </div>
          <!-- Expression -->
          <div class="trait-group">
            <div class="trait-label">Expresión</div>
            <div class="trait-pills" id="pills-expression">
              <button class="trait-pill active" data-trait="expression" data-value="cool">😎 Cool</button>
              <button class="trait-pill" data-trait="expression" data-value="happy">😊 Feliz</button>
              <button class="trait-pill" data-trait="expression" data-value="powerful">💪 Poderoso</button>
              <button class="trait-pill" data-trait="expression" data-value="mysterious">🔮 Misterioso</button>
            </div>
          </div>
          <!-- Description -->
          <div class="trait-group">
            <div class="trait-label">Descripción extra (opcional)</div>
            <input type="text" id="fox-description" maxlength="200"
              placeholder="ej: con una laptop, en la luna, con pizza..."
              style="width:100%;padding:10px 12px;border:1.5px solid #e0e0e0;border-radius:10px;
                     font-size:0.88rem;font-family:var(--font);box-sizing:border-box;">
          </div>
        </div>

        <button class="btn-primary" id="btn-generate-fox" onclick="actionGenerateFox()">
          🎨 Generar mi Zorro — 1 USDT
        </button>
        <div style="font-size:0.72rem;color:var(--muted);margin-top:6px;text-align:center;">
          La imagen se guarda en la galería pública · Ver <a href="fox-gallery.html" style="color:var(--orange);">galería</a>
        </div>
      </div>
    </div>
```

- [ ] **Step 3: Add fox JS logic to app.js**

Append this to the bottom of `zorritov2/frontend/app.js` (before the final `await tryMiniPayConnect()` line — actually append after it):

```js
// ── Fox Customizer ────────────────────────────────────────────────────────────

const PLATFORM_WALLET_ADDR = "0x19eC1797000F434EB2fd622E642BeF80234425cb";
const FOX_COST = 1_000_000n; // 1 USDT

// Trait selection state
const foxTraits = { fur: "orange", accessory: "sunglasses", background: "defi", expression: "cool" };

// Pill click handler — wire up after DOM ready
document.querySelectorAll(".trait-pill").forEach(pill => {
  pill.addEventListener("click", () => {
    const trait = pill.dataset.trait;
    const value = pill.dataset.value;
    foxTraits[trait] = value;
    // Deactivate siblings
    document.querySelectorAll(`[data-trait="${trait}"]`).forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
  });
});

async function loadFoxPreview(walletAddr) {
  const wrap = $("fox-preview-wrap");
  if (!wrap) return;
  try {
    const resp = await fetch("/api/fox-gallery");
    if (!resp.ok) return;
    const { gallery } = await resp.json();
    const entry = gallery.find(e => e.wallet === walletAddr.toLowerCase());
    if (entry?.imageUrl) {
      wrap.innerHTML = `<img src="${entry.imageUrl}" class="fox-preview" alt="Tu zorro">`;
    }
  } catch { /* silently fail */ }
}

window.actionGenerateFox = async () => {
  if (!zorritoW || !usdtW || !userAddr) return;

  const btn = $("btn-generate-fox");
  const description = $("fox-description")?.value || "";

  if (btn) { btn.disabled = true; btn.textContent = "Enviando pago..."; }

  try {
    // Step 1: send 1 USDT to platform wallet
    showToast("Enviando 1 USDT...", "info");
    const txPay = await usdtW.transfer(PLATFORM_WALLET_ADDR, FOX_COST);
    showToast("Confirmando pago...", "info");
    const receipt = await txPay.wait();
    const txHash  = receipt.hash;

    // Step 2: call generate API
    if (btn) btn.textContent = "Generando imagen...";
    showToast("Generando tu zorro con IA...", "info");

    const resp = await fetch("/api/fox-generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: userAddr, txHash, traits: { ...foxTraits }, description }),
    });

    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Error generando imagen");

    // Step 3: show result
    const wrap = $("fox-preview-wrap");
    if (wrap) wrap.innerHTML = `<img src="${data.imageUrl}" class="fox-preview" alt="Tu zorro">`;
    showToast("🦊 ¡Tu zorro fue generado!", "success");

  } catch (err) {
    const msg = err?.reason || err?.message || "Error desconocido";
    showToast(`❌ ${msg}`, "error");
    console.error("[fox-generate]", err);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🎨 Generar mi Zorro — 1 USDT"; }
  }
};
```

- [ ] **Step 4: Show `section-fox` in `refreshAll()`**

In `zorritov2/frontend/app.js`, inside the `if (hasDeposit)` block of `refreshAll()`, add:

```js
      show("section-fox");
      await loadFoxPreview(userAddr);
```

- [ ] **Step 5: Verify index.html renders correctly**

```bash
grep -c "section-fox" zorritov2/frontend/index.html
grep -c "trait-pill" zorritov2/frontend/index.html
```

Expected: both return a number > 0

- [ ] **Step 6: Commit**

```bash
git add zorritov2/frontend/index.html zorritov2/frontend/app.js
git commit -m "feat(v2/fox): fox customizer UI — trait selector + generate flow in index.html"
```

---

## Task 5: fox-gallery.html

**Files:**
- Create: `zorritov2/frontend/fox-gallery.html`

Public gallery showing all generated fox images in a grid.

- [ ] **Step 1: Write `zorritov2/frontend/fox-gallery.html`**

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Galería de Zorros — Zorrito V2</title>
  <link rel="icon" type="image/png" href="assets/zorritofinallogo.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="stylesheet" href="style.css">
  <style>
    body { font-family: var(--font); background: var(--bg); color: var(--text); max-width: 680px; margin: 0 auto; padding: 0 0 40px; }
    .nav { display:flex; justify-content:center; gap:16px; padding:12px 16px; border-bottom:1px solid #f0f0f0; }
    .nav a { color:var(--muted); text-decoration:none; font-size:0.85rem; font-weight:600; padding:6px 10px; border-radius:8px; }
    .nav a:hover { color:var(--orange); background:#fff3e0; }
    .gallery-hero { text-align:center; padding:28px 20px 16px; }
    .gallery-hero h1 { font-size:1.4rem; font-weight:800; }
    .gallery-grid { display:grid; grid-template-columns:repeat(2, 1fr); gap:12px; padding:0 16px; }
    @media(min-width:480px) { .gallery-grid { grid-template-columns:repeat(3, 1fr); } }
    .fox-card { background:var(--surface); border:1.5px solid var(--border); border-radius:16px; overflow:hidden; }
    .fox-card img { width:100%; aspect-ratio:1; object-fit:cover; display:block; }
    .fox-card-info { padding:8px 10px; }
    .fox-wallet { font-family:monospace; font-size:0.7rem; color:var(--muted); }
    .fox-traits { font-size:0.72rem; color:var(--muted); margin-top:2px; }
    .empty-state { text-align:center; color:var(--muted); font-size:0.9rem; padding:60px 20px; }
    .skel { background:#f0f0f0; animation:skeleton 1.4s ease-in-out infinite; border-radius:16px; }
    @keyframes skeleton { 0%,100%{opacity:.4} 50%{opacity:1} }
  </style>
</head>
<body>
  <nav class="nav">
    <a href="index.html">← App</a>
    <a href="docs.html">Cómo funciona</a>
    <a href="stats.html">Stats</a>
    <a href="fox-gallery.html">🦊 Galería</a>
  </nav>

  <div class="gallery-hero">
    <div style="font-size:48px;margin-bottom:6px;">🦊</div>
    <h1>Galería de Zorros</h1>
    <p style="color:var(--muted);font-size:0.88rem;margin-top:4px;">Todos los zorros generados por la comunidad</p>
  </div>

  <div class="gallery-grid" id="gallery-grid">
    <!-- skeleton placeholders -->
    <div class="fox-card skel" style="aspect-ratio:1;height:auto;"></div>
    <div class="fox-card skel" style="aspect-ratio:1;height:auto;"></div>
    <div class="fox-card skel" style="aspect-ratio:1;height:auto;"></div>
  </div>

  <script>
    const TRAIT_LABELS = {
      fur: { orange:"🟠", red:"🔴", white:"⬜", brown:"🟤", black:"🖤" },
      accessory: { sunglasses:"🕶️", cowboy:"🤠", scarf:"🧣", chain:"🔗", none:"" },
      background: { jungle:"🌿", city:"🏙️", beach:"🏖️", space:"🌌", defi:"💰" },
      expression: { happy:"😊", cool:"😎", powerful:"💪", mysterious:"🔮" },
    };

    function fmtWallet(w) {
      return w ? `${w.slice(0,6)}...${w.slice(-4)}` : "—";
    }

    function traitEmojis(traits) {
      if (!traits) return "";
      return [
        TRAIT_LABELS.fur[traits.fur] || "",
        TRAIT_LABELS.accessory[traits.accessory] || "",
        TRAIT_LABELS.background[traits.background] || "",
        TRAIT_LABELS.expression[traits.expression] || "",
      ].filter(Boolean).join(" ");
    }

    async function loadGallery() {
      const grid = document.getElementById("gallery-grid");
      try {
        const resp = await fetch("/api/fox-gallery");
        if (!resp.ok) throw new Error("HTTP " + resp.status);
        const { gallery } = await resp.json();

        grid.innerHTML = "";
        if (!gallery || gallery.length === 0) {
          grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">
            <div style="font-size:3rem;margin-bottom:12px;">🦊</div>
            <div>Todavía no hay zorros generados.<br>
            <a href="index.html" style="color:var(--orange);">¡Sé el primero!</a></div>
          </div>`;
          return;
        }

        for (const entry of gallery) {
          const card = document.createElement("div");
          card.className = "fox-card";
          card.innerHTML = `
            <img src="${entry.imageUrl}" alt="Zorro de ${fmtWallet(entry.wallet)}" loading="lazy">
            <div class="fox-card-info">
              <div class="fox-wallet">${fmtWallet(entry.wallet)}</div>
              <div class="fox-traits">${traitEmojis(entry.traits)}</div>
            </div>`;
          grid.appendChild(card);
        }
      } catch (err) {
        grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;">
          Error cargando galería: ${err.message}
        </div>`;
      }
    }

    loadGallery();
  </script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add zorritov2/frontend/fox-gallery.html
git commit -m "feat(v2/fox): fox-gallery.html — public grid of all generated foxes"
```

---

## Self-Review Checklist

- [x] Payment verified on-chain before any generation (Transfer event from user wallet to PLATFORM_WALLET, amount ≥ 1 USDT)
- [x] Replay protection: `fox:used:{txHash}` stored in KV with 7-day TTL
- [x] One image per wallet in Vercel Blob (`fox/{wallet}.png`, `addRandomSuffix: false`)
- [x] Gallery capped at 100 entries, old entry for same wallet replaced on regeneration
- [x] Trait pills: single-select per group, default values set
- [x] Section gated by `hasDeposit` — hidden until user deposits
- [x] Description capped at 200 chars (both maxlength HTML and `.slice(0, 200)` in API)
- [x] Inputs fully validated server-side (wallet, txHash regex, trait enums)
- [x] Error messages in Spanish matching the rest of the UI
- [x] Gallery API has `Cache-Control` for edge caching
- [x] No lottery/fish language anywhere

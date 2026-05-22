// zorritov2/api/fox-generate.js
const { ethers } = require("ethers");
const { put }    = require("@vercel/blob");
const { kv }     = require("@vercel/kv");
const https      = require("https");

// ── Download a URL and return a Buffer ────────────────────────────────────────
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ── AI Gateway image generation via chat/completions (Gemini 2.5 Flash Image)
// Uses zorritovivo.png as visual reference to keep character style consistent.
async function generateFoxImage(prompt) {
  const apiKey = (process.env.AI_GATEWAY_API_KEY || "").trim();
  if (!apiKey) throw new Error("AI_GATEWAY_API_KEY no configurada");

  // Fetch the reference fox image and encode as base64
  const refBuffer = await fetchBuffer("https://www.zorrito.app/assets/zorritovivo.png");
  const refB64    = refBuffer.toString("base64");

  const systemPrompt = [
    "You are an expert at generating cartoon character illustrations.",
    "Always maintain the exact same visual style, proportions, and character design as the reference image provided.",
    "The character MUST remain a fox with the same chibi/cartoon style.",
    "Only change the traits explicitly requested (fur color, accessories, background, expression, jersey).",
    "CRITICAL: The background MUST fully cover the entire square canvas — edge to edge, corner to corner.",
    "NO white borders, NO white margins, NO white frame, NO padding, NO letterboxing of any kind.",
    "The illustration must bleed to all four edges of the 1:1 canvas.",
    "Output ONLY the image, no text.",
  ].join(" ");

  const userContent = [
    {
      type: "image_url",
      image_url: { url: `data:image/png;base64,${refB64}` },
    },
    {
      type: "text",
      text: `Using this fox character as the strict visual reference, generate a new illustration with these traits: ${prompt}.

STYLE: Keep the EXACT same cartoon style, chibi proportions, thick black outlines, and cream/white belly markings as the reference.

CANVAS REQUIREMENTS (mandatory):
- Square 1:1 aspect ratio.
- The background scene must fill the ENTIRE canvas, edge to edge.
- ABSOLUTELY NO white borders, white frame, white margins, or white padding around the image.
- ABSOLUTELY NO letterboxing or pillarboxing.
- The background extends fully to all four edges of the canvas.
- Treat the canvas as if it were a window into the scene — the scene continues past the edges, never bounded by white space.`,
    },
  ];

  const body = JSON.stringify({
    model:    "google/gemini-2.5-flash-image",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user",   content: userContent },
    ],
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "ai-gateway.vercel.sh",
      path:     "/v1/chat/completions",
      method:   "POST",
      headers: {
        "Authorization":  `Bearer ${apiKey}`,
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 180_000,
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`Gateway error ${res.statusCode}: ${data.slice(0, 300)}`));
        }
        try {
          const json = JSON.parse(data);
          // Gemini image response: choices[0].message.images[0].image_url.url (data URI)
          const images = json.choices?.[0]?.message?.images;
          if (images?.length) {
            const dataUri = images[0].image_url?.url || "";
            const b64 = dataUri.replace(/^data:image\/\w+;base64,/, "");
            return resolve({ b64_json: b64 });
          }
          // Fallback: standard images/generations format
          const item = json.data?.[0];
          if (item) return resolve(item);
          reject(new Error("No image in gateway response: " + data.slice(0, 200)));
        } catch (e) {
          reject(new Error("Invalid gateway response: " + data.slice(0, 200)));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Gateway request timed out")); });
    req.write(body);
    req.end();
  });
}

const RPC             = process.env.CELO_RPC_URL || "https://forno.celo.org";
const USDT_ADDRESS    = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const PLATFORM_WALLET = (process.env.PLATFORM_WALLET || "").trim().toLowerCase();
const MIN_AMOUNT      = 250_000n; // 0.25 USDT (6 decimals) — matches MIN_DEPOSIT
const GALLERY_MAX     = 100;

// USDT Transfer(address indexed from, address indexed to, uint256 value)
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

const VALID_FURS        = ["orange", "red", "white", "brown", "black"];
const VALID_ACCESSORIES = ["sunglasses", "cowboy", "scarf", "chain", "mate", "worldcup", "none"];
const VALID_BACKGROUNDS = ["jungle", "city", "beach", "space", "patagonia", "desert", "stadium"];
const VALID_EXPRESSIONS = ["happy", "cool", "powerful", "mysterious"];

// Countries for the football jersey trait
const VALID_JERSEY_COUNTRIES = [
  "none","argentina","brazil","france","spain","germany","england","italy",
  "portugal","netherlands","uruguay","colombia","chile","mexico","usa",
  "japan","australia","senegal","morocco","nigeria","south-korea",
];

const FUR_PROMPT = {
  orange: "orange fur",
  red:    "red fur",
  white:  "white fur",
  brown:  "brown fur",
  black:  "black fur",
};
const ACCESSORY_PROMPT = {
  sunglasses: "wearing stylish sunglasses",
  cowboy:     "wearing a cowboy hat",
  scarf:      "wearing a colorful scarf",
  chain:      "wearing a gold chain with a coin pendant",
  mate:       "holding a traditional South American mate gourd with a metal straw",
  worldcup:   "holding a golden FIFA World Cup trophy",
  none:       "",
};
const BACKGROUND_PROMPT = {
  jungle:   "tropical jungle background",
  city:     "neon city night background",
  beach:    "sunset beach background",
  space:    "starry space background with planets",
  patagonia:"dramatic Patagonia mountain landscape background with glaciers and clear sky",
  desert:   "vast Atacama desert background with red dunes and starry night sky",
  stadium:  "packed football stadium background with green pitch, floodlights, and roaring crowd",
};
const EXPRESSION_PROMPT = {
  happy:      "happy cheerful expression",
  cool:       "cool confident expression",
  powerful:   "powerful determined expression",
  mysterious: "mysterious expression with glowing eyes",
};
const JERSEY_PROMPT = {
  none:        "",
  argentina:   "wearing the iconic light blue and white striped Argentina football jersey",
  brazil:      "wearing the yellow and green Brazil football jersey",
  france:      "wearing the dark blue France football jersey",
  spain:       "wearing the red Spain football jersey",
  germany:     "wearing the white Germany football jersey",
  england:     "wearing the white England football jersey with three lions crest",
  italy:       "wearing the blue Azzurri Italy football jersey",
  portugal:    "wearing the red Portugal football jersey",
  netherlands: "wearing the bright orange Netherlands football jersey",
  uruguay:     "wearing the light blue Uruguay football jersey",
  colombia:    "wearing the yellow Colombia football jersey",
  chile:       "wearing the red Chile football jersey",
  mexico:      "wearing the green Mexico football jersey",
  usa:         "wearing the white USA football jersey",
  japan:       "wearing the dark blue Japan football jersey",
  australia:   "wearing the gold and green Australia Socceroos jersey",
  senegal:     "wearing the white and green Senegal football jersey",
  morocco:     "wearing the red Morocco football jersey",
  nigeria:     "wearing the green Super Eagles Nigeria football jersey",
  "south-korea": "wearing the red South Korea football jersey",
};

// ── Character anchor ──────────────────────────────────────────────────────────
// All generated foxes must stay visually consistent with the Zorrito mascot:
// a rounded anthropomorphic fox with big bright eyes, thick clean black
// outlines, cream/white belly and muzzle markings, large fluffy tail with
// a white tip, friendly chibi proportions, flat 2D cartoon vector-art style.
const CHARACTER_BASE = [
  "Zorrito the anthropomorphic fox mascot,",
  "rounded chibi proportions, big expressive bright eyes,",
  "thick clean black outlines, cream-white belly and muzzle markings,",
  "large fluffy tail with white tip,",
  "flat 2D cartoon vector-art illustration style,",
  "vibrant colors, high quality digital art,",
  "NO nazi symbols, NO hateful imagery, MUST be a fox character",
].join(" ");

function buildPrompt(traits, description) {
  const jersey = traits.jersey && traits.jersey !== "none"
    ? JERSEY_PROMPT[traits.jersey] || ""
    : "";

  // Sanitize user description — strip anything that would override the character
  const safeDesc = description
    ? description.trim()
        .slice(0, 200)
        .replace(/nazi|hitler|ss symbol|swastika|hate|racist/gi, "")
    : "";

  const parts = [
    CHARACTER_BASE,
    FUR_PROMPT[traits.fur],
    jersey,
    ACCESSORY_PROMPT[traits.accessory],
    BACKGROUND_PROMPT[traits.background],
    EXPRESSION_PROMPT[traits.expression],
    safeDesc,
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

  if (!to) throw new Error("PLATFORM_WALLET no configurada en el servidor");

  const transferLog = receipt.logs.find(log => {
    if (log.address.toLowerCase() !== usdtAddr) return false;
    if (log.topics[0] !== TRANSFER_TOPIC) return false;
    if (log.topics.length < 3) return false;
    const logFrom = "0x" + log.topics[1].slice(26);
    const logTo   = "0x" + log.topics[2].slice(26);
    return logFrom.toLowerCase() === from && logTo.toLowerCase() === to;
  });

  if (!transferLog) {
    throw new Error("No se encontró transferencia de 0.25 USDT a la wallet de plataforma");
  }

  const amount = BigInt(transferLog.data);
  if (amount < MIN_AMOUNT) {
    throw new Error(`Monto insuficiente: se enviaron ${Number(amount) / 1e6} USDT (mínimo 0.25 USDT)`);
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
    return res.status(400).json({ error: "Body JSON inválido" });
  }

  const { wallet, txHash, traits, description = "" } = body || {};

  // ── Validate inputs ─────────────────────────────────────────────────────────
  if (!wallet || !ethers.isAddress(wallet)) {
    return res.status(400).json({ error: "wallet inválida" });
  }
  if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    return res.status(400).json({ error: "txHash inválido" });
  }
  if (!traits || typeof traits !== "object") {
    return res.status(400).json({ error: "traits requeridos" });
  }
  if (!VALID_FURS.includes(traits.fur))               return res.status(400).json({ error: "fur inválido" });
  if (!VALID_ACCESSORIES.includes(traits.accessory))  return res.status(400).json({ error: "accessory inválido" });
  if (!VALID_BACKGROUNDS.includes(traits.background)) return res.status(400).json({ error: "background inválido" });
  if (!VALID_EXPRESSIONS.includes(traits.expression)) return res.status(400).json({ error: "expression inválido" });
  if (traits.jersey && !VALID_JERSEY_COUNTRIES.includes(traits.jersey)) return res.status(400).json({ error: "jersey inválido" });

  const walletLower = wallet.toLowerCase();
  const txHashLower = txHash.toLowerCase();

  try {
    // ── Replay protection ────────────────────────────────────────────────────
    const alreadyUsed = await kv.get(`fox:used:${txHashLower}`);
    if (alreadyUsed) {
      return res.status(400).json({ error: "Esta transacción ya fue usada" });
    }

    // ── Verify payment on-chain ──────────────────────────────────────────────
    const provider = new ethers.JsonRpcProvider(RPC);
    await verifyPayment(provider, txHash, wallet);

    // Mark tx as used immediately (7-day TTL) to prevent double-spend during generation
    await kv.set(`fox:used:${txHashLower}`, "1", { ex: 7 * 24 * 3600 });

    // ── Build prompt and generate ────────────────────────────────────────────
    const prompt = buildPrompt(traits, description);
    console.log(`[fox-generate] wallet=${wallet} prompt="${prompt.slice(0, 100)}..."`);

    const imageItem = await generateFoxImage(prompt);

    // Gateway returns either b64_json or url
    let imageBuffer;
    if (imageItem.b64_json) {
      imageBuffer = Buffer.from(imageItem.b64_json, "base64");
    } else if (imageItem.url) {
      // Download from URL
      imageBuffer = await new Promise((resolve, reject) => {
        https.get(imageItem.url, res => {
          const chunks = [];
          res.on("data", c => chunks.push(c));
          res.on("end", () => resolve(Buffer.concat(chunks)));
          res.on("error", reject);
        }).on("error", reject);
      });
    } else {
      throw new Error("Gateway returned neither b64_json nor url");
    }

    const blob = await put(`fox/${walletLower}.png`, imageBuffer, {
      access: "public",
      contentType: "image/png",
      addRandomSuffix: false,
      cacheControlMaxAge: 0,   // disable CDN cache so regenerations are always fresh
    });

    // ── Save metadata to KV ──────────────────────────────────────────────────
    const metadata = {
      wallet:    walletLower,
      imageUrl:  blob.url,
      traits,
      prompt,
      timestamp: Date.now(),
    };
    await kv.set(`fox:wallet:${walletLower}`, JSON.stringify(metadata));

    // ── Update gallery list ──────────────────────────────────────────────────
    let gallery = [];
    try {
      const raw = await kv.get("fox:gallery");
      // KV auto-parses JSON — raw may already be an array or a JSON string
      gallery = Array.isArray(raw) ? raw : (raw ? JSON.parse(raw) : []);
    } catch { gallery = []; }

    // Remove existing entry for this wallet (regeneration)
    gallery = gallery.filter(e => e.wallet !== walletLower);
    // Prepend new entry
    gallery.unshift({ wallet: walletLower, imageUrl: blob.url, traits, timestamp: metadata.timestamp });
    // Cap at max
    gallery = gallery.slice(0, GALLERY_MAX);
    // Store as native array (KV serializes automatically)
    await kv.set("fox:gallery", gallery);

    console.log(`[fox-generate] ✅ done wallet=${wallet} blob=${blob.url}`);
    return res.status(200).json({ imageUrl: blob.url });

  } catch (err) {
    console.error("[fox-generate] error:", err.message);
    return res.status(500).json({ error: err.message || "Error interno" });
  }
};

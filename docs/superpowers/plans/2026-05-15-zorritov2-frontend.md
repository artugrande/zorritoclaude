# ZorritoV2 Frontend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete ZorritoV2 frontend in `zorritov2/frontend/` — 6 pages rebranded as a savings platform (no lottery/fish language), with full V2 contract integration.

**Architecture:** Static HTML + vanilla JS + CDN dependencies (no build step). Shared CSS copied from production. Each page is a self-contained HTML file. The main app logic lives in `app.js` (imported as ES module). The contract address is a constant that gets updated post-deploy.

**Tech Stack:** HTML5, CSS (copied from v8), ethers v6 (CDN), Reown AppKit (CDN), MiniPay auto-connect

---

## File Map

| Path | Role |
|------|------|
| `zorritov2/frontend/style.css` | Copy from `frontend/style.css` + V2 tweaks |
| `zorritov2/frontend/app.js` | V2 contract integration — full rewrite |
| `zorritov2/frontend/index.html` | Main app — deposit, save, savings, chances, referral, streak, prize |
| `zorritov2/frontend/docs.html` | How it works — savings platform framing |
| `zorritov2/frontend/stats.html` | Protocol stats + prize history + top referrers |
| `zorritov2/frontend/agent.html` | Agent API docs with V2 ABI |
| `zorritov2/frontend/terms.html` | Terms — no lottery language |
| `zorritov2/frontend/privacy.html` | Privacy — minor name updates |
| `zorritov2/frontend/assets/` | Copy logo + image assets from production |

> **Contract address placeholder:** Use `const CONTRACT_ADDRESS = "0x0000000000000000000000000000000000000000"` in app.js until deployed. Add a `const CONTRACT_DEPLOYED = CONTRACT_ADDRESS !== "0x00..."` guard to disable contract calls before deploy.

---

## V2 Contract ABI (for app.js)

```js
const ZORRITO_V2_ABI = [
  // User functions
  "function deposit(uint256 amount, bytes4 refCode) external",
  "function withdraw(uint256 amount) external",
  "function save() external",
  "function claimSavings() external",
  // Referral view
  "function referralCode(address user) view returns (bytes4)",
  "function referralCodeFor(address user) view returns (string)",
  "function activeReferrals(address user) view returns (uint256)",
  "function referredBy(address user) view returns (address)",
  // Deposit/savings views
  "function deposits(address user) view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
  "function pendingSavings(address user) view returns (uint256)",
  "function totalSavings() view returns (uint256)",
  // Streak views
  "function streakDay(address user) view returns (uint8)",
  "function lastSaveDay(address user) view returns (uint256)",
  "function welcomeBonusClaimed(address user) view returns (bool)",
  "function WELCOME_STREAK() view returns (uint256)",
  "function welcomeBonus() view returns (uint256)",
  // Chances
  "function effectiveChances(address user) view returns (uint256)",
  "function totalEffectiveChances() view returns (uint256)",
  // Raffle
  "function currentPrizePool() view returns (uint256)",
  "function raffleCommitted() view returns (bool)",
  "function depositorCount() view returns (uint256)",
  // Protocol config
  "function emergencyMode() view returns (bool)",
  // Events
  "event Deposited(address indexed user, uint256 amount)",
  "event Withdrawn(address indexed user, uint256 amount)",
  "event Saved(address indexed user, uint8 streakDay)",
  "event WelcomeBonusClaimed(address indexed user, uint256 amount)",
  "event RaffleExecuted(address indexed winner, uint256 prize, uint256 fee)",
  "event SavingsClaimed(address indexed user, uint256 amount)",
];
```

---

## Task 1: Copy Assets + Style

**Files:**
- Create: `zorritov2/frontend/style.css` (copy + tweak)
- Create: `zorritov2/frontend/assets/` (copy logo files)

- [ ] **Step 1: Copy style.css and assets**

```bash
cp frontend/style.css zorritov2/frontend/style.css
mkdir -p zorritov2/frontend/assets
cp frontend/assets/zorritofinallogo.png zorritov2/frontend/assets/
cp frontend/assets/bg.png zorritov2/frontend/assets/ 2>/dev/null || true
```

- [ ] **Step 2: Add V2-specific CSS variables to the top of `zorritov2/frontend/style.css`**

No changes needed — the existing style.css already has the right design tokens (orange, claymorphism, Baloo 2 font). Just verify the file is copied.

```bash
head -5 zorritov2/frontend/style.css
```

Expected: `/* ── Google Font ──────────────────────────── */`

- [ ] **Step 3: Commit**

```bash
git add zorritov2/frontend/style.css zorritov2/frontend/assets/
git commit -m "feat(v2/frontend): copy style.css + assets from production"
```

---

## Task 2: app.js — V2 Contract Integration

**Files:**
- Create: `zorritov2/frontend/app.js`

This is the main JS module imported by index.html. It handles:
- Wallet connection (Reown AppKit + MiniPay auto-connect)
- All contract reads and writes
- UI state updates

- [ ] **Step 1: Write `zorritov2/frontend/app.js`**

```js
// zorritov2/frontend/app.js
// ── Imports via CDN (no build step) ──────────────────────────────────────────
import { createAppKit }  from "https://esm.sh/@reown/appkit@1.8.19?bundle";
import { EthersAdapter } from "https://esm.sh/@reown/appkit-adapter-ethers@1.8.19?bundle";
import { celo }          from "https://esm.sh/@reown/appkit@1.8.19/networks?bundle";
import { ethers }        from "https://esm.sh/ethers@6.11.1?bundle";

// ── Config ────────────────────────────────────────────────────────────────────
const REOWN_PROJECT_ID  = "7b357de2964e4c3f344339b5144c1bf5";
const CONTRACT_ADDRESS  = "0x0000000000000000000000000000000000000000"; // ← update after deploy
const CONTRACT_DEPLOYED = CONTRACT_ADDRESS !== "0x0000000000000000000000000000000000000000";
const USDT_ADDRESS      = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const MIN_DEPOSIT       = 250_000n; // 0.25 USDT (6 decimals)

// ── ABIs ──────────────────────────────────────────────────────────────────────
const ZORRITO_V2_ABI = [
  "function deposit(uint256 amount, bytes4 refCode) external",
  "function withdraw(uint256 amount) external",
  "function save() external",
  "function claimSavings() external",
  "function referralCodeFor(address user) view returns (string)",
  "function activeReferrals(address user) view returns (uint256)",
  "function referredBy(address user) view returns (address)",
  "function deposits(address user) view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
  "function pendingSavings(address user) view returns (uint256)",
  "function streakDay(address user) view returns (uint8)",
  "function lastSaveDay(address user) view returns (uint256)",
  "function welcomeBonusClaimed(address user) view returns (bool)",
  "function WELCOME_STREAK() view returns (uint256)",
  "function welcomeBonus() view returns (uint256)",
  "function effectiveChances(address user) view returns (uint256)",
  "function totalEffectiveChances() view returns (uint256)",
  "function currentPrizePool() view returns (uint256)",
  "function depositorCount() view returns (uint256)",
  "function emergencyMode() view returns (bool)",
];

const USDT_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

// ── State ─────────────────────────────────────────────────────────────────────
let provider = null;
let signer   = null;
let userAddr = null;
let zorrito  = null; // read-only contract
let zorritoW = null; // write contract (with signer)
let usdtW    = null; // USDT contract (with signer)

// ── Reown AppKit setup ────────────────────────────────────────────────────────
const ethersAdapter = new EthersAdapter();
const modal = createAppKit({
  adapters: [ethersAdapter],
  networks: [celo],
  projectId: REOWN_PROJECT_ID,
  metadata: {
    name: "Zorrito V2",
    description: "Ahorrá USDT. Ganá un premio extra semanal.",
    url: window.location.origin,
    icons: ["https://v2.zorrito.app/assets/zorritofinallogo.png"],
  },
  features: { analytics: false, email: false, socials: false },
  themeMode: "dark",
  themeVariables: { "--w3m-accent": "#FD840E", "--w3m-border-radius-master": "14px" },
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const fmt6 = (raw) => (Number(raw) / 1e6).toFixed(2);
const fmtAddr = (a) => a ? `${a.slice(0,6)}...${a.slice(-4)}` : "—";

function setHTML(id, html) { const el = $(id); if (el) el.innerHTML = html; }
function setText(id, txt)  { const el = $(id); if (el) el.textContent = txt; }
function show(id)           { const el = $(id); if (el) el.style.display = ""; }
function hide(id)           { const el = $(id); if (el) el.style.display = "none"; }

function showToast(msg, type = "info") {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.className = `toast toast-${type} show`;
  setTimeout(() => el.classList.remove("show"), 4000);
}

// ── MiniPay auto-connect ──────────────────────────────────────────────────────
async function tryMiniPayConnect() {
  if (typeof window.ethereum !== "undefined" && window.ethereum.isMiniPay) {
    try {
      const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (accounts[0]) {
        provider = new ethers.BrowserProvider(window.ethereum);
        signer   = await provider.getSigner();
        userAddr = accounts[0];
        onConnected();
      }
    } catch (e) {
      console.warn("[MiniPay] auto-connect failed:", e.message);
    }
  }
}

// ── Wallet connection ─────────────────────────────────────────────────────────
modal.subscribeAccount(async (account) => {
  if (account.isConnected && account.address) {
    const walletProvider = modal.getWalletProvider();
    provider = new ethers.BrowserProvider(walletProvider);
    signer   = await provider.getSigner();
    userAddr = account.address;
    onConnected();
  } else {
    onDisconnected();
  }
});

async function onConnected() {
  if (!CONTRACT_DEPLOYED) {
    setText("wallet-display", fmtAddr(userAddr));
    show("connected-state");
    hide("disconnected-state");
    setHTML("main-message", `<div class="badge-staging">Contrato pendiente de deploy</div>`);
    return;
  }

  const rpc = new ethers.JsonRpcProvider("https://forno.celo.org");
  zorrito  = new ethers.Contract(CONTRACT_ADDRESS, ZORRITO_V2_ABI, rpc);
  zorritoW = new ethers.Contract(CONTRACT_ADDRESS, ZORRITO_V2_ABI, signer);
  usdtW    = new ethers.Contract(USDT_ADDRESS, USDT_ABI, signer);

  setText("wallet-display", fmtAddr(userAddr));
  show("connected-state");
  hide("disconnected-state");

  await refreshAll();
}

function onDisconnected() {
  provider = signer = userAddr = zorrito = zorritoW = usdtW = null;
  hide("connected-state");
  show("disconnected-state");
  setText("wallet-display", "");
}

// ── Read all user data ────────────────────────────────────────────────────────
async function refreshAll() {
  if (!zorrito || !userAddr) return;
  try {
    const [
      deposit,
      pendingSavings,
      streak,
      lastSaveDay,
      bonusClaimed,
      welcomeStreak,
      bonusAmount,
      myChances,
      totalChances,
      prizePool,
      depositorCount,
      referralCode,
      activeRefs,
      usdtBal,
    ] = await Promise.all([
      zorrito.deposits(userAddr),
      zorrito.pendingSavings(userAddr),
      zorrito.streakDay(userAddr),
      zorrito.lastSaveDay(userAddr),
      zorrito.welcomeBonusClaimed(userAddr),
      zorrito.WELCOME_STREAK(),
      zorrito.welcomeBonus(),
      zorrito.effectiveChances(userAddr),
      zorrito.totalEffectiveChances(),
      zorrito.currentPrizePool(),
      zorrito.depositorCount(),
      zorrito.referralCodeFor(userAddr),
      zorrito.activeReferrals(userAddr),
      new ethers.Contract(USDT_ADDRESS, USDT_ABI, new ethers.JsonRpcProvider("https://forno.celo.org"))
        .balanceOf(userAddr),
    ]);

    const hasDeposit = deposit > 0n;

    // ── Deposit card ──────────────────────────────────────────────────────────
    setText("stat-deposit",     fmt6(deposit) + " USDT");
    setText("stat-usdt-wallet", fmt6(usdtBal) + " USDT");

    // ── Savings card ─────────────────────────────────────────────────────────
    setText("stat-savings", fmt6(pendingSavings) + " USDT");
    if (pendingSavings > 0n) show("btn-claim-savings");
    else hide("btn-claim-savings");

    // ── Streak card ───────────────────────────────────────────────────────────
    const sd = Number(streak);
    updateStreakUI(sd, Number(welcomeStreak), fmt6(bonusAmount), bonusClaimed);

    // ── Save button ───────────────────────────────────────────────────────────
    const todayDay    = Math.floor(Date.now() / 1000 / 86400);
    const alreadySaved = Number(lastSaveDay) >= todayDay;
    const btnSave      = $("btn-save");
    if (btnSave) {
      btnSave.disabled = alreadySaved || !hasDeposit;
      btnSave.textContent = alreadySaved ? "✅ Ya ahorraste hoy" : "💾 Ahorrar hoy";
    }

    // ── Chances card ──────────────────────────────────────────────────────────
    const pct = totalChances > 0n
      ? ((Number(myChances) / Number(totalChances)) * 100).toFixed(2)
      : "0.00";
    setText("stat-chances-pct",   pct + "%");
    setText("stat-my-chances",    myChances.toString());
    setText("stat-total-chances", totalChances.toString());

    // ── Prize pool card ───────────────────────────────────────────────────────
    setText("stat-prize-pool",   fmt6(prizePool) + " USDT");
    setText("stat-depositors",   depositorCount.toString());
    updatePrizeCountdown();

    // ── Referral card ─────────────────────────────────────────────────────────
    setText("stat-referral-code", referralCode || "—");
    setText("stat-active-refs",   activeRefs.toString());
    if (referralCode) {
      const link = `${window.location.origin}?ref=${referralCode}`;
      const el   = $("referral-link");
      if (el) el.value = link;
    }

    // Show/hide deposit-dependent sections
    if (hasDeposit) {
      show("section-save");
      show("section-savings");
      show("section-chances");
      show("section-referral");
    }

  } catch (err) {
    console.error("[refreshAll]", err);
    showToast("Error cargando datos. Reintentando...", "error");
  }
}

// ── Streak UI ─────────────────────────────────────────────────────────────────
function updateStreakUI(sd, welcomeStreak, bonusAmt, bonusClaimed) {
  // Day circles (1–7)
  for (let i = 1; i <= 7; i++) {
    const el = $(`streak-day-${i}`);
    if (!el) continue;
    el.classList.toggle("active",    i <= sd);
    el.classList.toggle("current",   i === sd);
  }
  setText("streak-multiplier", `${sd}×`);

  // Welcome bonus progress
  const bonusEl = $("welcome-bonus-progress");
  if (bonusEl) {
    if (bonusClaimed) {
      bonusEl.textContent = "🎁 ¡Bonus de bienvenida reclamado!";
      bonusEl.className = "bonus-claimed";
    } else if (sd < welcomeStreak) {
      bonusEl.textContent = `Día ${sd}/${welcomeStreak} — seguí ahorrando para ganar ${bonusAmt} USDT de regalo 🎁`;
    } else {
      bonusEl.textContent = `🎁 ¡Completaste ${welcomeStreak} días! Bonus enviado a tu wallet.`;
    }
  }
}

// ── Prize countdown ───────────────────────────────────────────────────────────
function updatePrizeCountdown() {
  const el = $("prize-countdown");
  if (!el) return;
  const now     = Date.now() / 1000;
  // Next Monday 10:05 UTC (raffle-execute)
  const dayOfWeek = Math.floor((now / 86400 + 4) % 7); // 0=Mon
  const daysUntilMon = dayOfWeek === 0 ? 7 : (7 - dayOfWeek);
  const mondayTs = now - (now % 86400) - (dayOfWeek * 86400) + (daysUntilMon * 86400) + 10 * 3600 + 5 * 60;
  const diff     = Math.max(0, mondayTs - now);
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  el.textContent = `${d}d ${h}h ${m}m`;
}
setInterval(updatePrizeCountdown, 30_000);

// ── Actions ───────────────────────────────────────────────────────────────────

// Read referral code from URL ?ref=XXXXXXXX
function getRefCodeFromURL() {
  const ref = new URLSearchParams(window.location.search).get("ref") || "";
  if (ref.length === 8 && /^[0-9a-fA-F]{8}$/.test(ref)) {
    return "0x" + ref; // Convert to bytes4 hex
  }
  return "0x00000000";
}

async function txGuard(label, fn) {
  try {
    showToast(`${label}...`, "info");
    const tx = await fn();
    const receipt = await tx.wait();
    showToast(`✅ ${label} confirmado`, "success");
    await refreshAll();
    return receipt;
  } catch (err) {
    const msg = err?.reason || err?.message || "Error desconocido";
    showToast(`❌ ${msg}`, "error");
    console.error(`[${label}]`, err);
  }
}

async function ensureAllowance(amount) {
  const allowance = await usdtW.allowance(userAddr, CONTRACT_ADDRESS);
  if (allowance < amount) {
    showToast("Aprobando USDT...", "info");
    const tx = await usdtW.approve(CONTRACT_ADDRESS, ethers.MaxUint256);
    await tx.wait();
  }
}

window.actionDeposit = async () => {
  if (!zorritoW) return;
  const raw = $("input-deposit")?.value;
  if (!raw) return showToast("Ingresá un monto", "error");
  const amount = BigInt(Math.round(parseFloat(raw) * 1e6));
  if (amount < MIN_DEPOSIT) return showToast("Mínimo 0.25 USDT", "error");

  const refCode = getRefCodeFromURL();
  await ensureAllowance(amount);
  await txGuard("Depósito", () => zorritoW.deposit(amount, refCode));
};

window.actionWithdraw = async () => {
  if (!zorritoW || !zorrito) return;
  const dep = await zorrito.deposits(userAddr);
  if (dep === 0n) return showToast("No tenés depósito", "error");
  const raw = $("input-withdraw")?.value;
  const amount = raw ? BigInt(Math.round(parseFloat(raw) * 1e6)) : dep;
  await txGuard("Retiro", () => zorritoW.withdraw(amount));
};

window.actionSave = async () => {
  if (!zorritoW) return;
  await txGuard("Ahorrar", () => zorritoW.save());
};

window.actionClaimSavings = async () => {
  if (!zorritoW) return;
  await txGuard("Reclamar savings", () => zorritoW.claimSavings());
};

window.copyReferralLink = () => {
  const el = $("referral-link");
  if (!el) return;
  navigator.clipboard.writeText(el.value).then(() => showToast("¡Link copiado!", "success"));
};

// ── Init ──────────────────────────────────────────────────────────────────────
await tryMiniPayConnect();
```

- [ ] **Step 2: Verify syntax**

```bash
node --input-type=module --eval "
import { readFileSync } from 'fs';
const src = readFileSync('zorritov2/frontend/app.js', 'utf8');
console.log('Lines:', src.split('\n').length, '— OK');
" 2>&1 | grep -v "import"
```

(Node can't import browser ESM — just check no obvious issues)

- [ ] **Step 3: Commit**

```bash
git add zorritov2/frontend/app.js
git commit -m "feat(v2/frontend): app.js — V2 contract integration + wallet connect"
```

---

## Task 3: index.html — Main App

**Files:**
- Modify: `zorritov2/frontend/index.html` (replace staging placeholder)

- [ ] **Step 1: Write full `zorritov2/frontend/index.html`**

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Zorrito V2 — Ahorrá USDT. Ganá un premio extra semanal.</title>
  <link rel="icon" type="image/png" href="assets/zorritofinallogo.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="stylesheet" href="style.css">
  <style>
    /* ── V2 extra styles ── */
    .badge-staging { display:inline-block; background:#f97316; color:#fff; font-size:11px;
      font-weight:700; padding:3px 10px; border-radius:99px; margin-bottom:12px; }
    .hero { text-align:center; padding:32px 20px 16px; }
    .hero-fox { font-size:56px; display:block; margin-bottom:8px; }
    .hero h1 { font-size:1.6rem; font-weight:800; line-height:1.3; margin-bottom:6px; }
    .hero p  { color:var(--muted); font-size:0.9rem; }
    /* Cards */
    .card { background:var(--surface); border:1.5px solid var(--border); border-radius:var(--radius);
      padding:20px; margin:0 16px 14px; }
    .card-title { font-size:0.75rem; font-weight:700; text-transform:uppercase;
      letter-spacing:.08em; color:var(--muted); margin-bottom:10px; }
    .card-value { font-size:1.8rem; font-weight:800; color:var(--text); }
    .card-sub   { font-size:0.8rem; color:var(--muted); margin-top:4px; }
    /* Streak circles */
    .streak-row { display:flex; gap:8px; justify-content:center; margin:12px 0; }
    .streak-dot { width:36px; height:36px; border-radius:50%; background:#f0f0f0;
      display:flex; align-items:center; justify-content:center;
      font-size:0.75rem; font-weight:700; color:#999; border:2px solid transparent; }
    .streak-dot.active  { background:#fff3e0; color:var(--orange); border-color:var(--orange); }
    .streak-dot.current { background:var(--orange); color:#fff; border-color:var(--orange); }
    /* Buttons */
    .btn-primary { width:100%; padding:14px; border-radius:12px; border:none;
      background:var(--orange); color:#fff; font-size:1rem; font-weight:700;
      cursor:pointer; font-family:var(--font); margin-top:10px; }
    .btn-secondary { width:100%; padding:12px; border-radius:12px; border:1.5px solid var(--orange);
      background:transparent; color:var(--orange); font-size:0.95rem; font-weight:700;
      cursor:pointer; font-family:var(--font); margin-top:8px; }
    .btn-primary:disabled { opacity:0.5; cursor:not-allowed; }
    /* Input group */
    .input-group { display:flex; gap:8px; margin-top:10px; }
    .input-group input { flex:1; padding:12px; border:1.5px solid #e0e0e0;
      border-radius:10px; font-size:0.95rem; font-family:var(--font); }
    /* Referral link */
    .referral-box { display:flex; gap:8px; margin-top:10px; }
    .referral-box input { flex:1; padding:10px; border:1.5px solid #e0e0e0;
      border-radius:10px; font-size:0.85rem; color:var(--muted); background:#fafafa; }
    /* Toast */
    .toast { position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
      background:#222; color:#fff; padding:12px 20px; border-radius:12px;
      font-size:0.9rem; z-index:9999; opacity:0; transition:opacity .3s;
      max-width:320px; text-align:center; pointer-events:none; }
    .toast.show { opacity:1; }
    .toast-success { background:#1a9960; }
    .toast-error   { background:#dc3545; }
    /* Bonus progress */
    .bonus-progress { font-size:0.82rem; color:var(--orange); margin-top:8px;
      padding:8px 12px; background:#fff3e0; border-radius:8px; }
    .bonus-claimed  { font-size:0.82rem; color:var(--green); margin-top:8px;
      padding:8px 12px; background:#e8f5e9; border-radius:8px; }
    /* Nav */
    .nav { display:flex; justify-content:center; gap:16px; padding:12px 16px;
      border-bottom:1px solid #f0f0f0; background:var(--surface); }
    .nav a { color:var(--muted); text-decoration:none; font-size:0.85rem;
      font-weight:600; padding:6px 10px; border-radius:8px; }
    .nav a:hover, .nav a.active { color:var(--orange); background:#fff3e0; }
    /* Wallet bar */
    .wallet-bar { display:flex; align-items:center; justify-content:space-between;
      padding:12px 16px; }
    .wallet-addr { font-size:0.8rem; color:var(--muted); font-weight:600; }
    /* Section headers */
    .section-label { font-size:0.7rem; font-weight:700; text-transform:uppercase;
      letter-spacing:.1em; color:var(--muted); padding:0 16px; margin-bottom:6px; margin-top:16px; }
  </style>
</head>
<body>

  <!-- Nav -->
  <nav class="nav">
    <a href="index.html" class="active">App</a>
    <a href="docs.html">Cómo funciona</a>
    <a href="stats.html">Stats</a>
    <a href="terms.html">Términos</a>
  </nav>

  <!-- Hero -->
  <div class="hero">
    <span class="hero-fox">🦊</span>
    <h1>Ahorrá USDT.<br>Ganá un premio extra semanal.</h1>
    <p>Tu USDT gana en Aave. El rendimiento se reparte entre todos los ahorradores — y uno gana el premio semanal.</p>
  </div>

  <!-- Wallet bar -->
  <div class="wallet-bar">
    <span class="wallet-addr" id="wallet-display"></span>
    <button class="btn-secondary" style="width:auto;padding:8px 16px;margin:0;"
      onclick="document.querySelector('appkit-button')?.click()">
      Conectar Wallet
    </button>
    <appkit-button style="display:none"></appkit-button>
  </div>

  <!-- DISCONNECTED STATE -->
  <div id="disconnected-state">
    <div class="card" style="text-align:center;">
      <div style="font-size:2rem;margin-bottom:8px;">🦊</div>
      <div style="font-weight:700;margin-bottom:6px;">Conectá tu wallet para empezar</div>
      <div style="font-size:0.85rem;color:var(--muted);margin-bottom:16px;">Funciona con MiniPay, MetaMask y cualquier wallet de Celo.</div>
      <button class="btn-primary" onclick="modal.open()">Conectar Wallet</button>
    </div>
  </div>

  <!-- CONNECTED STATE -->
  <div id="connected-state" style="display:none;">

    <!-- Deposit card -->
    <div class="section-label">Tu Depósito</div>
    <div class="card">
      <div class="card-title">Depositado en Aave</div>
      <div class="card-value" id="stat-deposit">—</div>
      <div class="card-sub">Wallet: <span id="stat-usdt-wallet">—</span></div>

      <div class="input-group">
        <input type="number" id="input-deposit" placeholder="Monto (USDT)" min="0.25" step="0.25">
        <button class="btn-primary" style="width:auto;padding:10px 18px;margin:0;"
          onclick="actionDeposit()">Depositar</button>
      </div>
      <div class="input-group" style="margin-top:8px;">
        <input type="number" id="input-withdraw" placeholder="Monto a retirar (vacío = todo)">
        <button class="btn-secondary" style="width:auto;padding:10px 18px;margin:0;"
          onclick="actionWithdraw()">Retirar</button>
      </div>
      <div style="font-size:0.75rem;color:var(--muted);margin-top:6px;">Mínimo: 0.25 USDT · Retiro disponible en cualquier momento</div>
    </div>

    <!-- Save / Streak card -->
    <div id="section-save" style="display:none;">
      <div class="section-label">Streak Semanal</div>
      <div class="card">
        <div class="card-title">Multiplicador de chances</div>
        <div class="streak-row">
          <div class="streak-dot" id="streak-day-1">L</div>
          <div class="streak-dot" id="streak-day-2">M</div>
          <div class="streak-dot" id="streak-day-3">M</div>
          <div class="streak-dot" id="streak-day-4">J</div>
          <div class="streak-dot" id="streak-day-5">V</div>
          <div class="streak-dot" id="streak-day-6">S</div>
          <div class="streak-dot" id="streak-day-7">D</div>
        </div>
        <div style="text-align:center;font-size:1.4rem;font-weight:800;" id="streak-multiplier">1×</div>
        <div id="welcome-bonus-progress" class="bonus-progress"></div>
        <button class="btn-primary" id="btn-save" onclick="actionSave()">💾 Ahorrar hoy</button>
        <div style="font-size:0.75rem;color:var(--muted);margin-top:6px;text-align:center;">
          Ahorrá todos los días para maximizar tus chances · Se resetea cada lunes
        </div>
      </div>
    </div>

    <!-- Savings rewards card -->
    <div id="section-savings" style="display:none;">
      <div class="section-label">Mis Savings</div>
      <div class="card">
        <div class="card-title">Rewards acumulados (Merit/Masiv)</div>
        <div class="card-value" id="stat-savings">—</div>
        <button class="btn-primary" id="btn-claim-savings" style="display:none;"
          onclick="actionClaimSavings()">Reclamar Savings</button>
        <div style="font-size:0.75rem;color:var(--muted);margin-top:6px;">
          Se distribuyen diariamente en proporción a tu depósito
        </div>
      </div>
    </div>

    <!-- Chances card -->
    <div id="section-chances" style="display:none;">
      <div class="section-label">Mis Chances</div>
      <div class="card">
        <div class="card-title">Probabilidad en el próximo sorteo</div>
        <div class="card-value" id="stat-chances-pct">—</div>
        <div class="card-sub">
          Tus chances: <strong id="stat-my-chances">—</strong> /
          Total: <strong id="stat-total-chances">—</strong>
        </div>
        <div style="font-size:0.75rem;color:var(--muted);margin-top:8px;">
          Chances = depósito × streak × (1 + referidos × 10%)
        </div>
      </div>
    </div>

    <!-- Referral card -->
    <div id="section-referral" style="display:none;">
      <div class="section-label">Tu Código de Referido</div>
      <div class="card">
        <div class="card-title">Compartí y sumá chances</div>
        <div class="card-value" style="font-size:1.4rem;letter-spacing:.1em;" id="stat-referral-code">—</div>
        <div class="card-sub">Referidos activos: <strong id="stat-active-refs">0</strong> · +10% chances por cada uno</div>
        <div class="referral-box">
          <input type="text" id="referral-link" readonly placeholder="Conectá wallet para ver tu link">
          <button class="btn-primary" style="width:auto;padding:10px 14px;margin:0;"
            onclick="copyReferralLink()">Copiar</button>
        </div>
      </div>
    </div>

    <!-- Prize pool card -->
    <div class="section-label">Próximo Premio</div>
    <div class="card">
      <div class="card-title">Premio semanal disponible</div>
      <div class="card-value" id="stat-prize-pool">—</div>
      <div class="card-sub">
        <span id="stat-depositors">—</span> ahorradores ·
        Sorteo en: <strong id="prize-countdown">—</strong>
      </div>
      <div style="font-size:0.75rem;color:var(--muted);margin-top:8px;">
        Cada lunes · El rendimiento de Aave va al ganador
      </div>
    </div>

  </div><!-- /connected-state -->

  <!-- Toast -->
  <div class="toast" id="toast"></div>

  <!-- AppKit modal trigger -->
  <appkit-button style="display:none" id="appkit-btn-hidden"></appkit-button>

  <script type="module" src="app.js"></script>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add zorritov2/frontend/index.html
git commit -m "feat(v2/frontend): index.html — deposit, save, savings, chances, referral, prize"
```

---

## Task 4: docs.html

**Files:**
- Create: `zorritov2/frontend/docs.html`

- [ ] **Step 1: Write docs.html**

Copy the structure from `frontend/docs.html` but rewrite content for V2 savings platform framing (no lottery language):

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cómo funciona — Zorrito V2</title>
  <link rel="icon" type="image/png" href="assets/zorritofinallogo.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="stylesheet" href="style.css">
  <style>
    body { font-family: var(--font); background: var(--bg); color: var(--text); max-width: 640px; margin: 0 auto; padding: 0 0 40px; }
    .nav { display:flex; gap:16px; padding:12px 16px; border-bottom:1px solid #f0f0f0; }
    .nav a { color:var(--muted); text-decoration:none; font-size:0.85rem; font-weight:600; padding:6px 10px; border-radius:8px; }
    .nav a:hover, .nav a.active { color:var(--orange); background:#fff3e0; }
    .docs-hero { text-align:center; padding:32px 20px 16px; }
    .docs-hero h1 { font-size:1.5rem; font-weight:800; }
    .docs-section { padding:20px 20px 0; }
    .docs-section h2 { font-size:1.1rem; font-weight:800; color:var(--orange); margin-bottom:10px; }
    .docs-section p, .docs-section li { font-size:0.9rem; line-height:1.7; color:#333; }
    .docs-section ul { padding-left:18px; margin-top:6px; }
    .docs-section li { margin-bottom:6px; }
    .highlight-box { background:#fff3e0; border-left:3px solid var(--orange);
      padding:12px 16px; border-radius:0 8px 8px 0; margin-top:12px; font-size:0.88rem; }
    .formula { background:#f5f5f5; padding:10px 14px; border-radius:8px;
      font-family:monospace; font-size:0.88rem; margin-top:8px; }
    .step-list { counter-reset:step; list-style:none; padding-left:0; }
    .step-list li { counter-increment:step; display:flex; align-items:flex-start; gap:12px; margin-bottom:12px; font-size:0.9rem; }
    .step-list li::before { content:counter(step); background:var(--orange); color:#fff;
      width:24px; height:24px; border-radius:50%; display:flex; align-items:center; justify-content:center;
      font-size:0.75rem; font-weight:800; flex-shrink:0; margin-top:2px; }
    .faq-q { font-weight:700; font-size:0.9rem; margin-top:14px; }
    .faq-a { font-size:0.88rem; color:var(--muted); line-height:1.6; margin-top:4px; }
    hr { border:none; border-top:1px solid #f0f0f0; margin:20px 0; }
  </style>
</head>
<body>
  <nav class="nav">
    <a href="index.html">App</a>
    <a href="docs.html" class="active">Cómo funciona</a>
    <a href="stats.html">Stats</a>
    <a href="terms.html">Términos</a>
  </nav>

  <div class="docs-hero">
    <div style="font-size:48px;margin-bottom:8px;">🦊</div>
    <h1>Cómo funciona Zorrito V2</h1>
    <p style="color:var(--muted);font-size:0.9rem;margin-top:6px;">Una plataforma de ahorro en USDT con premio semanal.</p>
  </div>

  <div class="docs-section">
    <h2>Qué es Zorrito</h2>
    <p>Zorrito es una plataforma de ahorro en USDT construida sobre Aave V3 en Celo. Depositás USDT, ganás rendimiento en Aave, y ese rendimiento se divide en dos streams:</p>
    <ul>
      <li><strong>Savings rewards</strong> — distribuidos proporcionalmente a todos los depositantes (vía Merit/Masiv incentivos)</li>
      <li><strong>Premio semanal</strong> — el rendimiento base de Aave se acumula y se le da a un ahorrador activo cada semana</li>
    </ul>
    <div class="highlight-box">Tu principal <strong>nunca está en riesgo</strong>. Podés retirar en cualquier momento.</div>
  </div>

  <hr>

  <div class="docs-section">
    <h2>Cómo funciona paso a paso</h2>
    <ol class="step-list">
      <li>Depositás USDT (mínimo 0.25 USDT). Tu USDT va a Aave y empieza a generar rendimiento.</li>
      <li>Cada día llamás a <strong>Ahorrar hoy</strong> para acumular streak (racha). El streak sube tu multiplicador de chances.</li>
      <li>Cada día acumulás <strong>savings rewards</strong> proporcionalmente a tu depósito (Merit/Masiv).</li>
      <li>Cada lunes, el rendimiento de Aave se sortea entre todos los ahorradores activos. Cuantas más chances, más probabilidades de ganar.</li>
    </ol>
  </div>

  <hr>

  <div class="docs-section">
    <h2>Sistema de Chances</h2>
    <div class="formula">chances = depósito × streakDay × (1 + referidos × 0.10)</div>
    <ul style="margin-top:12px;">
      <li><strong>Depósito:</strong> cuanto más USDT, más chances base</li>
      <li><strong>Streak (1–7×):</strong> cada día que ahorrás dentro de la semana suma 1× de multiplicador. Resetea cada lunes.</li>
      <li><strong>Referidos:</strong> +10% por cada referido activo (con depósito > 0)</li>
    </ul>
    <div class="highlight-box">Ejemplo: 100 USDT × 7 (streak máximo) × 1.1 (1 referido) = 770 chances. Un usuario nuevo con 10 USDT y streak 1 tiene 10 chances.</div>
  </div>

  <hr>

  <div class="docs-section">
    <h2>El Premio Semanal</h2>
    <ul>
      <li><strong>Fuente:</strong> rendimiento base de Aave sobre el capital depositado</li>
      <li><strong>Cuándo:</strong> todos los lunes a las 10:05 UTC</li>
      <li><strong>Cómo se elige el ganador:</strong> árbol de Fenwick + acumulador de entropía. El sorteo es determinístico y verificable on-chain.</li>
      <li><strong>Fee de plataforma:</strong> 10% del premio va a Zorrito. El ganador recibe el 90%.</li>
    </ul>
  </div>

  <hr>

  <div class="docs-section">
    <h2>Savings Rewards</h2>
    <p>Zorrito participa en programas de incentivos de Celo (Merit, Masiv). Las recompensas en USDT se distribuyen diariamente a todos los depositantes, proporcional a su depósito.</p>
    <ul>
      <li>15% de fee de plataforma sobre rewards distribuidos</li>
      <li>Reclamás cuando quieras desde la sección "Mis Savings"</li>
      <li>No requieren acción diaria — se acumulan automáticamente</li>
    </ul>
  </div>

  <hr>

  <div class="docs-section">
    <h2>Referidos</h2>
    <ul>
      <li>Tu código se genera automáticamente al depositar</li>
      <li>Cada referido activo te suma +10% de chances en el sorteo</li>
      <li>Para que cuente, tu referido debe tener depósito > 0 y vos debés tener ≥ 1 USDT depositado</li>
      <li>Si tu referido retira todo, el bono desaparece automáticamente</li>
    </ul>
  </div>

  <hr>

  <div class="docs-section">
    <h2>Bonus de Bienvenida</h2>
    <p>La primera vez que completás <strong>5 días consecutivos</strong> ahorrando, recibís <strong>0.5 USDT</strong> directamente en tu wallet (financiado por la wallet de incentivos del proyecto).</p>
    <p style="margin-top:6px;">El bonus se entrega una sola vez por dirección.</p>
  </div>

  <hr>

  <div class="docs-section">
    <h2>Seguridad y Transparencia</h2>
    <ul>
      <li>Contrato <strong>no upgradeable</strong> — una vez deployado, la lógica es inmutable</li>
      <li>El owner puede cambiar parámetros (fee, bonus) con un límite hardcodeado del 20%</li>
      <li>En caso de migración: <code>emergencyReturn()</code> devuelve el principal a todos los usuarios sin que tengan que hacer nada</li>
      <li>Código verificado en CeloScan — verificable on-chain</li>
    </ul>
  </div>

  <hr>

  <div class="docs-section">
    <h2>FAQ</h2>
    <div class="faq-q">¿Puedo perder mi USDT?</div>
    <div class="faq-a">No. Tu USDT está siempre en Aave V3. El único rendimiento en riesgo (para el premio) es el yield generado — nunca el principal.</div>

    <div class="faq-q">¿Qué pasa si no ahorro un día?</div>
    <div class="faq-a">Tu streak de la semana se resetea el próximo lunes. Si no ahorrás ningún día de la semana, tu multiplicador es 1× (el mínimo). Tu depósito sigue generando rendimiento de todas formas.</div>

    <div class="faq-q">¿Cómo sé que el sorteo es justo?</div>
    <div class="faq-a">El sorteo usa un árbol de Fenwick + acumulador de entropía mezclado en cada transacción durante la semana. El número ganador se commitea el lunes 10:00 UTC y se ejecuta 10 bloques después. Todo verificable on-chain en CeloScan.</div>

    <div class="faq-q">¿Puedo retirar cuando quiero?</div>
    <div class="faq-a">Sí, en cualquier momento. No hay lock-up ni penalidades. Si retirás antes del sorteo del lunes, perdés tus chances de esa semana.</div>
  </div>
</body>
</html>
```

- [ ] **Step 2: Commit**

```bash
git add zorritov2/frontend/docs.html
git commit -m "feat(v2/frontend): docs.html — savings platform framing"
```

---

## Task 5: stats.html, agent.html, terms.html, privacy.html

**Files:**
- Create: `zorritov2/frontend/stats.html`
- Create: `zorritov2/frontend/agent.html`
- Create: `zorritov2/frontend/terms.html`
- Create: `zorritov2/frontend/privacy.html`

For these pages:
- **stats.html**: Copy `frontend/stats.html`, update contract address to V2 placeholder, add "Total savings distributed" and "Top referrers" sections. Remove fish/lottery language.
- **agent.html**: Copy `frontend/agent.html`, update ABI to V2 functions (`deposit(amount, refCode)`, `save()`, `claimSavings()`). Update example calls.
- **terms.html**: Copy `frontend/terms.html`, replace all instances of "lottery"/"lotería"/"no-loss lottery" with "savings platform"/"plataforma de ahorro"/"premio semanal". Add referral program terms and welcome bonus terms.
- **privacy.html**: Copy `frontend/privacy.html`, update product name references from v8 to V2.

- [ ] **Step 1: Copy and update all 4 pages**

```bash
# Copy base files
cp frontend/stats.html   zorritov2/frontend/stats.html
cp frontend/agent.html   zorritov2/frontend/agent.html
cp frontend/terms.html   zorritov2/frontend/terms.html
cp frontend/privacy.html zorritov2/frontend/privacy.html
```

Then in `zorritov2/frontend/stats.html`:
- Replace the contract address constant with the V2 placeholder `0x0000000000000000000000000000000000000000`
- Add a "Total Savings Distribuidos" stat card
- Add a "Top Referrers" section (reads `activeReferrals` for leaderboard addresses)
- Remove fish/fox-feeding language

In `zorritov2/frontend/agent.html`:
- Replace `ZORRITO_ABI` with V2 ABI
- Update endpoint examples:
  - POST /api/agent?action=deposit&amount=10&refCode=00000000
  - POST /api/agent?action=save
- Remove v8-specific functions (draw, feed, feedFor)

In `zorritov2/frontend/terms.html`:
- Find and replace: "lottery" → "savings platform", "lotería" → "plataforma de ahorro", "no-loss lottery" → "weekly bonus prize"
- Add section: "Programa de Referidos" — code generation, bonus conditions, anti-sybil
- Add section: "Bonus de Bienvenida" — 5-day streak requirement, one-time per address, funded externally

In `zorritov2/frontend/privacy.html`:
- Replace "Zorrito" v8 references with "Zorrito V2" where applicable
- No other changes needed

- [ ] **Step 2: Commit**

```bash
git add zorritov2/frontend/stats.html zorritov2/frontend/agent.html \
        zorritov2/frontend/terms.html zorritov2/frontend/privacy.html
git commit -m "feat(v2/frontend): stats, agent, terms, privacy pages"
```

---

## Self-Review Checklist

- [x] All 6 pages present: index, docs, stats, agent, terms, privacy
- [x] No lottery/lotería/fish/feed language in index.html or docs.html
- [x] Tagline: "Ahorrá USDT. Ganá un premio extra semanal."
- [x] All V2 cards present: depósito, mis savings, streak, mis chances, referido, próximo premio
- [x] app.js: V2 ABI correct, MiniPay auto-connect, `save()` function, `claimSavings()`
- [x] Referral code from URL `?ref=XXXXXXXX` passed to `deposit()`
- [x] Welcome bonus progress shown in streak card
- [x] Prize countdown to next Monday 10:05 UTC
- [x] CONTRACT_DEPLOYED guard prevents calls when address is zero
- [x] terms.html has referral program + welcome bonus sections

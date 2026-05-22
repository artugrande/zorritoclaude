// zorritov2/frontend/app.js
// ── Imports via CDN (no build step) ──────────────────────────────────────────
import { createAppKit }  from "https://esm.sh/@reown/appkit@1.8.19?bundle";
import { EthersAdapter } from "https://esm.sh/@reown/appkit-adapter-ethers@1.8.19?bundle";
import { celo }          from "https://esm.sh/@reown/appkit@1.8.19/networks?bundle";
import { ethers }        from "https://esm.sh/ethers@6.11.1?bundle";

// ── Config ────────────────────────────────────────────────────────────────────
const REOWN_PROJECT_ID  = "7b357de2964e4c3f344339b5144c1bf5";
const CONTRACT_ADDRESS  = "0x8f4E627d4C4Af5dfE11908Bd8B929588d9Ee58c9";
const USDT_ADDRESS      = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const AAVE_POOL         = "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402";
const AUSDT_ADDRESS     = "0xDeE98402A302e4D707fB9bf2bac66fAEEc31e8Df";
const MIN_DEPOSIT       = 250_000n; // 0.25 USDT (6 decimals)
const PLATFORM_WALLET   = "0x19eC1797000F434EB2fd622E642BeF80234425cb";
const FOX_COST          = 250_000n; // 0.25 USDT (6 decimals) — matches MIN_DEPOSIT
const RPC               = "https://forno.celo.org";

// ── ABIs ──────────────────────────────────────────────────────────────────────
const ZORRITO_V2_ABI = [
  "function deposit(uint256 amount, bytes4 refCode) external",
  "function depositFor(address beneficiary, uint256 amount, bytes4 refCode) external",
  "function withdraw(uint256 amount) external",
  "function claimSavings() external",
  "function referralCodeFor(address user) view returns (string)",
  "function activeReferrals(address user) view returns (uint256)",
  "function referredBy(address user) view returns (address)",
  "function codeOwner(bytes4 code) view returns (address)",
  "function deposits(address user) view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
  "function pendingSavings(address user) view returns (uint256)",
  "function totalSavings() view returns (uint256)",
  "function streakDay(address user) view returns (uint8)",
  "function lastDepositDay(address user) view returns (uint256)",
  "function getStatus(address user) view returns (bool alive, uint8 currentStreak, uint256 deadlineTimestamp, uint256 secondsUntilDead)",
  "function welcomeBonusClaimed(address user) view returns (bool)",
  "function WELCOME_STREAK() view returns (uint256)",
  "function welcomeBonus() view returns (uint256)",
  "function effectiveChances(address user) view returns (uint256)",
  "function totalEffectiveChances() view returns (uint256)",
  "function currentPrizePool() view returns (uint256)",
  "function depositorCount() view returns (uint256)",
  "function emergencyMode() view returns (bool)",
  "function selfVerified(address user) view returns (bool)",
  "event Deposited(address indexed user, address indexed payer, uint256 amount, uint8 streakDay)",
  "event RaffleExecuted(address indexed winner, uint256 prize, uint256 fee)",
];

const USDT_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, uint256 amount) external returns (bool)",
];

const AAVE_POOL_ABI = [
  "function getReserveData(address asset) view returns (tuple(uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))",
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
    description: "Ahorrá USDT. Ganá un premio semanal.",
    url: window.location.origin,
    icons: ["https://www.zorrito.app/assets/zorritofinallogo.png"],
  },
  features: { analytics: false, email: false, socials: false },
  themeMode: "dark",
  themeVariables: { "--w3m-accent": "#FD840E", "--w3m-border-radius-master": "14px" },
});

// Expose modal for any global references
window.modal = modal;

// ── Helpers ───────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const fmt6 = (raw) => (Number(raw) / 1e6).toFixed(2);
const fmtAddr = (a) => a ? `${a.slice(0,6)}...${a.slice(-4)}` : "—";

function setText(id, txt)  { const el = $(id); if (el) el.textContent = txt; }
function setHtml(id, html) { const el = $(id); if (el) el.innerHTML  = html; }

// ── i18n helper for dynamic strings ───────────────────────────────────────────
// Reads window.ZORRITO_T[lang][key] (loaded by lang.js). Substitutes {placeholders}.
// Falls back to the Spanish key if missing.
function t(key, params = {}) {
  let lang = "es";
  try {
    const stored = localStorage.getItem("zorrito-lang");
    if (stored && ["en","es","pt"].includes(stored)) lang = stored;
  } catch {}
  const dict = (window.ZORRITO_T && window.ZORRITO_T[lang]) || {};
  let str = dict[key];
  if (str == null) {
    // Fallback to ES then EN if missing in current lang
    str = (window.ZORRITO_T?.es?.[key]) ?? (window.ZORRITO_T?.en?.[key]) ?? key;
  }
  return String(str).replace(/\{(\w+)\}/g, (_, k) => (params[k] != null ? params[k] : `{${k}}`));
}

// Re-render dynamic strings when the user changes language (event from nav-shared.js)
window.addEventListener("zorrito-lang-change", () => {
  // Re-render onboarding if open
  try { if (typeof renderOnbSlide === "function") renderOnbSlide(false); } catch {}
  // Re-render main state
  if (typeof refreshAll === "function" && userAddr) {
    refreshAll().catch(() => {});
  } else if (typeof resetUI === "function") {
    resetUI();
  }
});

// Stat card with V1-style hierarchy: big number + small unit label below
function statUsdt(amount, opts = {}) {
  const { color = "", secondary = "" } = opts;
  const num = fmt6(amount);
  const sec = secondary ? `<span class="stat-secondary">${secondary}</span>` : "";
  return `<span class="stat-num" ${color ? `style="color:${color}"` : ""}>${num}</span><span class="stat-unit">USDT</span>${sec}`;
}

// Prize pool: when tiny, show "$0.00" with a friendly subtext (used to say
// "Acumulando" but the word broke awkwardly to two lines in the narrow card).
function statPrize(prizeRaw) {
  if (prizeRaw < 10_000n) { // < $0.01
    return `<span class="stat-num" style="color:var(--orange);">$0.00</span><span class="stat-secondary" style="font-size:0.7rem;line-height:1.25;">crece cada semana 🌱</span>`;
  }
  return `<span class="stat-num" style="color:var(--orange);">${fmt6(prizeRaw)}</span><span class="stat-unit">USDT</span>`;
}
function show(id)           { const el = $(id); if (el) el.style.display = ""; }
function hide(id)           { const el = $(id); if (el) el.style.display = "none"; }
function showFlex(id)       { const el = $(id); if (el) el.style.display = "flex"; }

function showToast(msg, type = "info") {
  const el = $("toast");
  if (!el) return;
  el.textContent = msg;
  el.className   = `show ${type === "success" ? "success" : type === "error" ? "error" : ""}`;
  setTimeout(() => el.className = "", 4000);
}

function isMiniPay() {
  return typeof window !== "undefined" && window.ethereum?.isMiniPay === true;
}

// ── MiniPay: type-0 (legacy) transactions required ────────────────────────────
async function txOpts() {
  if (!isMiniPay() || !provider) return {};
  try {
    const feeData = await provider.getFeeData();
    return { type: 0, gasPrice: feeData.gasPrice };
  } catch {
    return { type: 0, gasPrice: ethers.parseUnits("5", "gwei") };
  }
}

// ── Guest stats (before wallet connect) ──────────────────────────────────────
async function loadGuestStats() {
  try {
    const rpc      = new ethers.JsonRpcProvider(RPC);
    const contract = new ethers.Contract(CONTRACT_ADDRESS, ZORRITO_V2_ABI, rpc);
    const [principal, depositors, prize] = await Promise.all([
      contract.totalPrincipal(),
      contract.depositorCount(),
      contract.currentPrizePool(),
    ]);
    setHtml("stat-pool",       statUsdt(principal, { color: "var(--green)" }));
    setHtml("stat-prize-pool", statPrize(prize));
    setText("stat-depositors", depositors.toString());
    loadLiveAPY(rpc);
    loadMeritAPR();
    loadWinnerHistory(contract);
  } catch (e) {
    console.warn("[guestStats]", e.message);
  }
}

async function loadLiveAPY(rpc) {
  try {
    const pool = new ethers.Contract(AAVE_POOL, AAVE_POOL_ABI, rpc || new ethers.JsonRpcProvider(RPC));
    const data = await pool.getReserveData(USDT_ADDRESS);
    // currentLiquidityRate is ray (1e27) → APY ≈ rate/1e25 %
    const ray = data[2];
    const apyRaw = (Number(ray) / 1e25).toFixed(2);
    setText("stat-apy", apyRaw + "% APY");
  } catch {
    setText("stat-apy", "~4-6% APY");
  }
}

async function loadMeritAPR() {
  try {
    // ACI Merit API — official endpoint used by apps.aavechan.com
    const resp = await fetch("https://apps.aavechan.com/api/merit/aprs");
    if (!resp.ok) return;
    const data = await resp.json();
    const apr = data?.currentAPR?.actionsAPR?.["celo-supply-usdt"];
    if (apr != null && Number(apr) > 0) {
      const pct = Number(apr).toFixed(2);
      setText("stat-merit-apr", `+${pct}%`);
    }
  } catch { /* fail silently — merit bonus is supplemental info */ }
}

async function loadWinnerHistory(contract) {
  try {
    const filter = contract.filters.RaffleExecuted();
    const events = await contract.queryFilter(filter, -50000);
    const listEl = $("winner-list");
    if (!listEl) return;
    if (events.length === 0) {
      listEl.innerHTML = `<p class="empty-state">Aún no hay premios registrados</p>`;
      return;
    }
    listEl.innerHTML = "";
    const rpc = new ethers.JsonRpcProvider(RPC);
    for (const ev of events.reverse().slice(0, 5)) {
      const block  = await rpc.getBlock(ev.blockNumber).catch(() => null);
      const date   = block ? new Date(block.timestamp * 1000).toLocaleDateString("es-AR") : "—";
      const item   = document.createElement("div");
      item.className = "winner-item";
      item.innerHTML = `
        <span class="winner-addr">
          <a href="https://celoscan.io/address/${ev.args.winner}" target="_blank" rel="noopener"
             style="color:var(--muted);text-decoration:none;">${fmtAddr(ev.args.winner)}</a>
          <span style="font-size:0.72rem;color:var(--muted);display:block;">${date}</span>
        </span>
        <span class="winner-prize">+$${fmt6(ev.args.prize)} USDT</span>`;
      listEl.appendChild(item);
    }
  } catch (e) {
    console.warn("[winnerHistory]", e.message);
  }
}

// ── MiniPay auto-connect ──────────────────────────────────────────────────────
// Wait up to 3 s for MiniPay to inject window.ethereum before giving up
async function waitForEthereum(ms = 3000) {
  if (window.ethereum) return true;
  return new Promise(resolve => {
    const t = setTimeout(() => { window.removeEventListener("ethereum#initialized", done); resolve(false); }, ms);
    function done() { clearTimeout(t); resolve(true); }
    window.addEventListener("ethereum#initialized", done, { once: true });
  });
}

async function tryMiniPayConnect() {
  await waitForEthereum();
  console.log("[MiniPay] ethereum present:", !!window.ethereum, "isMiniPay:", isMiniPay());
  if (!isMiniPay()) return;

  // Hide connect button immediately — MiniPay manages its own wallet
  const connectBtn = $("btn-connect");
  if (connectBtn) connectBtn.style.display = "none";

  try {
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
    if (accounts[0]) {
      provider = new ethers.BrowserProvider(window.ethereum);
      signer   = await provider.getSigner();
      userAddr = accounts[0];
      // Show MiniPay badge with address
      const badge = $("minipay-badge");
      const addrEl = $("minipay-addr");
      if (badge) badge.style.display = "flex";
      if (addrEl) addrEl.textContent = fmtAddr(userAddr);
      onConnected();
    }
  } catch (e) {
    console.warn("[MiniPay] auto-connect failed:", e.message);
  }
}

// ── Wallet connection ─────────────────────────────────────────────────────────
modal.subscribeAccount(async (account) => {
  if (isMiniPay()) return; // MiniPay handles its own connection — don't interfere
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

function updateConnectBtn(connected, addr) {
  const btn   = $("btn-connect");
  const label = $("btn-connect-label");
  if (!btn || !label) return;
  if (connected) {
    btn.classList.add("connected");
    label.textContent = fmtAddr(addr);
  } else {
    btn.classList.remove("connected");
    label.textContent = "Conectar Wallet";
  }
}

// Track which wallet the current cached UI state belongs to
let _uiWalletAddr = null;

async function onConnected() {
  const rpc = new ethers.JsonRpcProvider(RPC);
  zorrito   = new ethers.Contract(CONTRACT_ADDRESS, ZORRITO_V2_ABI, rpc);
  zorritoW  = new ethers.Contract(CONTRACT_ADDRESS, ZORRITO_V2_ABI, signer);
  usdtW     = new ethers.Contract(USDT_ADDRESS, USDT_ABI, signer);

  // If the wallet changed (account switch in MiniPay/Reown), wipe per-wallet state
  if (_uiWalletAddr && _uiWalletAddr !== userAddr?.toLowerCase()) {
    generatedFoxUrl = null;
    _foxLoadedFor = null;
    _selfVerifiedKnown = false;
    const foxImg = $("fox-image");
    if (foxImg) foxImg.src = "assets/cofre.png";
    const wrap = $("fox-preview-wrap");
    if (wrap) wrap.innerHTML = "";
  }
  _uiWalletAddr = userAddr?.toLowerCase() || null;

  updateConnectBtn(true, userAddr);

  // Enable action buttons
  const btnDeposit  = $("btn-deposit");
  const btnWithdraw = $("btn-withdraw");
  const btnMaxDep   = $("btn-max-deposit");
  const btnMaxWith  = $("btn-max-withdraw");
  if (btnDeposit)  btnDeposit.disabled  = false;
  if (btnWithdraw) btnWithdraw.disabled = false;
  if (btnMaxDep)   btnMaxDep.disabled   = false;
  if (btnMaxWith)  btnMaxWith.disabled  = false;

  await refreshAll();
  // Ask for referral code only on first connect for a wallet that never deposited
  maybeShowReferralModal().catch(() => {});
}

function onDisconnected() {
  provider = signer = userAddr = zorrito = zorritoW = usdtW = null;
  generatedFoxUrl = null; // clear cached fox so next wallet doesn't see previous user's
  _foxLoadedFor = null;
  _selfVerifiedKnown = false; // clear Self verified flag for the new wallet
  _uiWalletAddr = null;
  updateConnectBtn(false, null);
  resetUI();
}

function resetUI() {
  setText("fox-status-text", t("dyn-fox-status-connect"));
  setText("fox-dead-timer", "");
  const foxImg = $("fox-image");
  if (foxImg) foxImg.src = "assets/cofre.png";
  const bubble = $("fox-bubble");
  if (bubble) { bubble.textContent = ""; bubble.className = "fox-bubble"; }
  hide("fox-streak-line"); hide("fox-chances-line");
  hide("fox-deposit-line"); hide("fox-savings-line");
  const btnSave = $("btn-save");
  if (btnSave) { btnSave.disabled = true; btnSave.textContent = t("dyn-btn-connect-wallet"); }
  hide("btn-claim-savings");
  hide("card-streak"); hide("card-referral");
  // fox card stays visible but locked
  const foxLockReset = $("fox-lock-banner");
  const foxBtnReset  = $("btn-generate-fox");
  if (foxLockReset) foxLockReset.style.display = "block";
  if (foxBtnReset)  { foxBtnReset.disabled = true; foxBtnReset.style.opacity = "0.5"; }

  // Reset Self verification card to locked state
  updateSelfVerificationUI(false);

  // Disable action buttons
  ["btn-deposit","btn-withdraw","btn-max-deposit","btn-max-withdraw"].forEach(id => {
    const el = $(id);
    if (el) el.disabled = true;
  });

  setText("usdt-wallet-bal", "—");
  setText("user-balance-val", "0.00");
  setText("withdrawable-val", "—");
  setText("stat-mydeposit", "—");
  setText("stat-mystreak", "—");
  setText("stat-odds-pct", "—");
  setText("stat-odds-detail", "Conectá tu wallet para ver tu probabilidad");
}

// ── Read all user data ────────────────────────────────────────────────────────
async function refreshAll() {
  if (!zorrito || !userAddr) return;
  try {
    const rpc = new ethers.JsonRpcProvider(RPC);
    const usdtRo = new ethers.Contract(USDT_ADDRESS, USDT_ABI, rpc);

    const [
      deposit,
      pendingSavings_,
      streak,
      lastDepositDay_,
      bonusClaimed,
      welcomeStreak,
      bonusAmount,
      myChances,
      totalChances,
      prizePool,
      depositorCount_,
      totalPrincipal_,
      referralCode_,
      activeRefs,
      usdtBal,
      isSelfVerified,
    ] = await Promise.all([
      zorrito.deposits(userAddr),
      zorrito.pendingSavings(userAddr),
      zorrito.streakDay(userAddr),
      zorrito.lastDepositDay(userAddr),
      zorrito.welcomeBonusClaimed(userAddr),
      zorrito.WELCOME_STREAK(),
      zorrito.welcomeBonus(),
      zorrito.effectiveChances(userAddr),
      zorrito.totalEffectiveChances(),
      zorrito.currentPrizePool(),
      zorrito.depositorCount(),
      zorrito.totalPrincipal(),
      zorrito.referralCodeFor(userAddr),
      zorrito.activeReferrals(userAddr),
      usdtRo.balanceOf(userAddr),
      zorrito.selfVerified(userAddr).catch(() => false), // graceful fallback until contract redeploy
    ]);

    const hasDeposit = deposit > 0n;
    const sd = Number(streak);

    // ── Fox image & status ────────────────────────────────────────────────────
    const foxImg  = $("fox-image");
    const bubble  = $("fox-bubble");
    const todayDay   = Math.floor(Date.now() / 1000 / 86400);
    const alreadySaved = Number(lastDepositDay_) >= todayDay;

    if (!hasDeposit) {
      // No deposit — show chest
      if (foxImg) {
        foxImg.src = "assets/cofre.png";
        foxImg.classList.add("fox-float");
        foxImg.closest(".fox-img-col")?.classList.remove("generated");
      }
      setText("fox-status-text", t("dyn-fox-status-nodeposit"));
      if (bubble) { bubble.textContent = t("dyn-fox-bubble-nodeposit"); bubble.className = "fox-bubble visible"; }
    } else if (sd === 0 || alreadySaved) {
      // Has deposit + (never saved yet OR already saved today) → fox is alive
      if (generatedFoxUrl) {
        if (foxImg) {
          foxImg.src = generatedFoxUrl;
          foxImg.classList.remove("fox-float");
          foxImg.closest(".fox-img-col")?.classList.add("generated");
        }
      } else {
        if (foxImg) {
          foxImg.src = "assets/zorritovivo.png";
          foxImg.classList.add("fox-float");
          foxImg.closest(".fox-img-col")?.classList.remove("generated");
        }
      }
      if (sd === 0) {
        setText("fox-status-text", t("dyn-fox-status-ready"));
        if (bubble) { bubble.textContent = t("dyn-fox-bubble-save-today"); bubble.className = "fox-bubble visible"; }
      } else {
        setText("fox-status-text", t("dyn-fox-status-alive", { day: sd }));
        if (bubble) { bubble.textContent = t("dyn-fox-bubble-alive"); bubble.className = "fox-bubble visible"; }
      }
    } else {
      // Has streak but hasn't saved today → fox dying, show original dead asset
      if (foxImg) {
        foxImg.src = "assets/zorromuerto.png";
        foxImg.classList.add("fox-float");
        foxImg.closest(".fox-img-col")?.classList.remove("generated");
      }
      setText("fox-status-text", t("dyn-fox-status-dying", { day: sd }));
      if (bubble) { bubble.textContent = t("dyn-fox-bubble-feed-me"); bubble.className = "fox-bubble visible urgent"; }
    }

    // Fox meta lines
    if (hasDeposit) {
      show("fox-deposit-line");
      setHtml("fox-deposit-val", `${fmt6(deposit)} <span style="font-size:0.72rem;opacity:.7;">USDT</span>`);
      show("fox-streak-line");
      setText("fox-streak-val", t("dyn-fox-streak-meta", { day: sd }));
      show("fox-chances-line");
      const pct = totalChances > 0n
        ? ((Number(myChances) / Number(totalChances)) * 100).toFixed(2)
        : "0.00";
      setText("fox-chances-val", pct + "%");
      if (pendingSavings_ > 0n) {
        show("fox-savings-line");
        setHtml("fox-savings-val", `${fmt6(pendingSavings_)} <span style="font-size:0.72rem;opacity:.7;">USDT</span>`);
      }
    }

    // ── Save button ───────────────────────────────────────────────────────────
    const btnSave = $("btn-save");
    if (btnSave) {
      if (!hasDeposit) {
        // Clickable "Adopt your fox" — triggers a min-deposit (0.25 USDT) shortcut.
        btnSave.disabled = false;
        btnSave.textContent = t("dyn-btn-adopt");
        btnSave.dataset.action = "adopt";
      } else if (alreadySaved) {
        btnSave.disabled = true;
        btnSave.textContent = t("dyn-btn-saved-today");
        btnSave.dataset.action = "saved";
      } else {
        btnSave.disabled = false;
        btnSave.dataset.action = "save";
        btnSave.textContent = t("dyn-btn-save-today");
      }
    }

    // ── Claim savings button ──────────────────────────────────────────────────
    if (pendingSavings_ > 0n) show("btn-claim-savings");
    else hide("btn-claim-savings");

    // ── Balances ──────────────────────────────────────────────────────────────
    setText("usdt-wallet-bal", fmt6(usdtBal));
    setText("user-balance-val", fmt6(deposit));
    setText("withdrawable-val", fmt6(deposit));

    // Max buttons
    const inputDep  = $("input-deposit");
    const inputWith = $("input-withdraw");
    const btnMaxDep = $("btn-max-deposit");
    const btnMaxWith = $("btn-max-withdraw");
    if (btnMaxDep && inputDep) {
      btnMaxDep.onclick = () => { inputDep.value = fmt6(usdtBal); };
    }
    if (btnMaxWith && inputWith) {
      btnMaxWith.onclick = () => { inputWith.value = fmt6(deposit); };
    }

    // ── Pool stats ────────────────────────────────────────────────────────────
    setHtml("stat-pool",       statUsdt(totalPrincipal_, { color: "var(--green)" }));
    setHtml("stat-prize-pool", statPrize(prizePool));
    setText("stat-depositors", depositorCount_.toString());
    setHtml("stat-mydeposit",  statUsdt(deposit));
    setText("stat-mystreak",   t("dyn-stat-streak-days", { day: sd }));
    const oddsRaw = totalChances > 0n
      ? ((Number(myChances) / Number(totalChances)) * 100).toFixed(2)
      : "0.00";
    setText("stat-odds-pct",    oddsRaw + "%");
    setText("stat-odds-detail", totalChances > 0n
      ? t("dyn-odds-formula")
      : t("dyn-odds-connect"));

    // ── Streak card (visible once user has saved at least once) ──────────────
    if (hasDeposit && sd > 0) {
      show("card-streak");
      updateStreakUI(sd, Number(welcomeStreak), fmt6(bonusAmount), bonusClaimed);
    } else {
      hide("card-streak");
    }

    // ── Referral card ─────────────────────────────────────────────────────────
    if (hasDeposit) {
      show("card-referral");
      setText("stat-referral-code", referralCode_ || "—");
      setText("stat-active-refs", activeRefs.toString());
      if (referralCode_) {
        const el = $("referral-link");
        if (el) el.value = `${window.location.origin}?ref=${referralCode_}`;
      }
    }

    // ── Share-on-X button (uses referral code + current streak) ──────────────
    updateShareXButton(sd, referralCode_ || "");

    // ── Fox bubble: contextual message ───────────────────────────────────────
    {
      const now = new Date();
      const isMonday = now.getUTCDay() === 1; // Monday in UTC
      const isMonday7 = isMonday && sd >= 7;
      updateFoxBubble({
        hasDeposit,
        savedToday: alreadySaved,
        streakDay: sd,
        isMonday7,
      });
    }

    // ── Fox customizer ────────────────────────────────────────────────────────
    // Card is always visible; lock banner shows when no deposit
    const foxLock = $("fox-lock-banner");
    const foxBtn  = $("btn-generate-fox");
    if (hasDeposit) {
      if (foxLock) foxLock.style.display = "none";
      if (foxBtn)  { foxBtn.disabled = false; foxBtn.style.opacity = ""; }
      // Only fetch the fox once per wallet (loadFoxPreview tags _foxLoadedFor)
      if (_foxLoadedFor !== userAddr.toLowerCase()) loadFoxPreview(userAddr);
    } else {
      if (foxLock) foxLock.style.display = "block";
      if (foxBtn)  { foxBtn.disabled = true; foxBtn.style.opacity = "0.5"; }
    }

    // ── Self.xyz verification status ──────────────────────────────────────────
    // Once verified is confirmed (in-memory flag or contract), never reset it.
    // KV fallback covers the period before contract redeploy.
    // If user is mid-flow (_selfSessionId set), never touch the Self UI.
    if (isSelfVerified || _selfVerifiedKnown) {
      updateSelfVerificationUI(true);
    } else if (!_selfSessionId) {
      // Not mid-flow: render button, then async-upgrade to verified if KV confirms
      updateSelfVerificationUI(false);
      fetch(`/api/self-status?address=${userAddr}`)
        .then(r => r.json())
        .then(d => { if (d.verified) updateSelfVerificationUI(true); })
        .catch(() => {});
      // If _selfSessionId is set (mid-flow), leave the Self UI completely untouched
    }

    // Reload APY, Merit & winners
    loadLiveAPY(new ethers.JsonRpcProvider(RPC));
    loadMeritAPR();
    loadWinnerHistory(zorrito);

  } catch (err) {
    console.error("[refreshAll]", err);
    showToast("Error cargando datos. Reintentando...", "error");
  }
}

// ── Streak UI ─────────────────────────────────────────────────────────────────
function updateStreakUI(sd, welcomeStreak, bonusAmt, bonusClaimed) {
  // Clamp to [0, 7]
  const day = Math.max(0, Math.min(7, sd));

  // Update each node: i < day → done, i === day → current, i > day → idle
  for (let i = 1; i <= 7; i++) {
    const el = $(`streak-node-${i}`);
    if (!el) continue;
    el.classList.remove("done", "current");
    if (i < day)      el.classList.add("done");
    else if (i === day) el.classList.add("current");
  }

  // Progress bar fill: 0% at day 0, 100% when current node is 7
  const bar = $("streak-progress-bar");
  if (bar) {
    const pct = day <= 1 ? 0 : ((day - 1) / 6) * 100;
    bar.style.width = `calc(${pct}% * (100% - 44px) / 100% + ${pct > 0 ? '0px' : '0px'})`;
    // Simpler: percentage of the track (between centers of node 1 and node 7)
    bar.style.width = `${pct}%`;
  }

  // Multiplier — matches contract: streakDay × (10 + refs) / 10 × selfBonus
  // The pure streak component is just `sd` itself (so 7× max).
  const multEl = $("streak-multiplier");
  if (multEl) {
    const m = day === 0 ? 1 : day;
    multEl.innerHTML = `${m}× <span class="lbl">chances</span>`;
  }

  // Welcome bonus
  const bonusEl = $("welcome-bonus-progress");
  if (bonusEl) {
    if (bonusClaimed) {
      bonusEl.textContent = t("dyn-bonus-claimed");
      bonusEl.className = "bonus-claimed";
      bonusEl.style.display = "";
    } else if (sd < welcomeStreak) {
      bonusEl.textContent = t("dyn-bonus-progress", { day: sd, total: welcomeStreak, amount: bonusAmt });
      bonusEl.className = "bonus-progress";
      bonusEl.style.display = "";
    } else {
      bonusEl.textContent = t("dyn-bonus-completed", { total: welcomeStreak });
      bonusEl.className = "bonus-claimed";
      bonusEl.style.display = "";
    }
  }
}

// ── Prize countdown (next Monday 10:05 UTC) ───────────────────────────────────
function updatePrizeCountdown() {
  const el = $("countdown");
  if (!el) return;
  const now = new Date();
  const dow = now.getUTCDay(); // 0=Sun, 1=Mon, …, 6=Sat
  // Days until next Monday (if today is Monday, count a full 7 days)
  const daysUntilMon = dow === 1 ? 7 : (8 - dow) % 7;
  const nextMon = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysUntilMon,
    10, 5, 0
  ));
  const diff = Math.max(0, nextMon - now) / 1000; // seconds
  const d = Math.floor(diff / 86400);
  const h = Math.floor((diff % 86400) / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = Math.floor(diff % 60);
  el.textContent = `${d}d ${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}
setInterval(updatePrizeCountdown, 1000);
updatePrizeCountdown();

// ── Onboarding (4 slides on first visit) ──────────────────────────────────────
const ONB_KEY = "zorrito-v2-onboarded";
const ONB_SLIDES = [
  { emoji: "💰", titleKey: "dyn-onb-1-title", subKey: "dyn-onb-1-sub" },
  { emoji: "🔥", titleKey: "dyn-onb-2-title", subKey: "dyn-onb-2-sub" },
  { emoji: "🎯", titleKey: "dyn-onb-3-title", subKey: "dyn-onb-3-sub" },
  { emoji: "🏆", titleKey: "dyn-onb-4-title", subKey: "dyn-onb-4-sub" },
];
let _onbStep = 0;

function renderOnbSlide(animated = true) {
  const slide = ONB_SLIDES[_onbStep];
  const emoji = $("onb-emoji"), title = $("onb-title"), sub = $("onb-sub"), hint = $("onb-tap-hint"), btn = $("onb-launch");
  if (!emoji || !title || !sub) return;

  const apply = () => {
    emoji.textContent = slide.emoji;
    title.textContent = t(slide.titleKey);
    sub.textContent   = t(slide.subKey);
    document.querySelectorAll(".onb-dot").forEach((d, i) => d.classList.toggle("active", i === _onbStep));
    const isLast = _onbStep === ONB_SLIDES.length - 1;
    if (btn)  btn.style.display  = isLast ? "" : "none";
    if (hint) hint.style.display = isLast ? "none" : "";
  };

  if (!animated) { apply(); return; }
  emoji.classList.add("fade"); title.classList.add("fade"); sub.classList.add("fade");
  setTimeout(() => {
    apply();
    emoji.classList.remove("fade"); title.classList.remove("fade"); sub.classList.remove("fade");
  }, 200);
}

function advanceOnb() {
  if (_onbStep < ONB_SLIDES.length - 1) {
    _onbStep++;
    renderOnbSlide(true);
  } else {
    closeOnboarding();
  }
}

function closeOnboarding() {
  const ov = $("onboarding");
  if (ov) ov.classList.remove("open");
  try { localStorage.setItem(ONB_KEY, "1"); } catch {}
}

function maybeShowOnboarding() {
  try {
    if (localStorage.getItem(ONB_KEY) === "1") return;
  } catch {}
  _onbStep = 0;
  renderOnbSlide(false);
  const ov = $("onboarding");
  if (ov) ov.classList.add("open");
}

(function wireOnboarding() {
  const card = $("onb-card"), btn = $("onb-launch");
  if (card) {
    card.addEventListener("click", (e) => {
      // ignore taps on the launch button itself
      if (e.target.closest("#onb-launch")) return;
      advanceOnb();
    });
    // basic swipe support
    let sx = 0;
    card.addEventListener("touchstart", (e) => { sx = e.touches[0].clientX; }, { passive: true });
    card.addEventListener("touchend",   (e) => {
      const dx = (e.changedTouches[0].clientX - sx);
      if (dx < -40)      advanceOnb();
      else if (dx > 40 && _onbStep > 0) { _onbStep--; renderOnbSlide(true); }
    }, { passive: true });
  }
  if (btn) btn.addEventListener("click", closeOnboarding);
})();
maybeShowOnboarding();

// ── Customizer modal wiring ───────────────────────────────────────────────────
(function wireCustomizerModal() {
  const open  = $("btn-open-customizer");
  const close = $("btn-close-customizer");
  const back  = $("fox-customizer-modal");
  if (open && back) open.addEventListener("click", () => back.classList.add("open"));
  if (close && back) close.addEventListener("click", () => back.classList.remove("open"));
  if (back) {
    back.addEventListener("click", (e) => {
      if (e.target === back) back.classList.remove("open"); // click outside panel closes
    });
  }
})();

// ── Share streak on X (Twitter intent) ────────────────────────────────────────
function updateShareXButton(streakDay, referralCode) {
  const btn = $("btn-share-x");
  if (!btn) return;
  if (!userAddr || !referralCode || referralCode === "—" || streakDay < 1) {
    btn.classList.remove("visible");
    return;
  }
  const sd = Math.max(1, Math.min(7, Number(streakDay) || 1));
  // Use /api/share?ref=… instead of the home URL. Twitter's crawler will
  // fetch the og:image dynamically — if the user has an AI-generated fox
  // saved in the gallery, that image gets embedded in the tweet card.
  // The share page itself redirects to www.zorrito.app/?ref=… for clicks.
  const link = `${window.location.origin}/api/share?ref=${referralCode}`;
  // Pre-format the streak portion with proper singular/plural per language.
  let lang = "es";
  try {
    const stored = localStorage.getItem("zorrito-lang");
    if (stored && ["en","es","pt"].includes(stored)) lang = stored;
  } catch {}
  let streakLabel;
  if (lang === "en")      streakLabel = `${sd}-day streak`;
  else if (lang === "pt") streakLabel = `${sd} ${sd === 1 ? "dia" : "dias"} de sequência`;
  else                    streakLabel = `${sd} ${sd === 1 ? "día"  : "días"} de streak`;
  const text = t("dyn-tweet-text", { streak: sd, streakLabel, link });
  btn.href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`;
  btn.classList.add("visible");
}

// ── Fox bubble: contextual one-liner ──────────────────────────────────────────
function updateFoxBubble({ hasDeposit, savedToday, streakDay, isMonday7 }) {
  const bubble = $("fox-bubble");
  if (!bubble) return;
  let msg = "";
  if (!userAddr) {
    msg = t("dyn-bubble-connect");
  } else if (!hasDeposit) {
    msg = t("dyn-bubble-deposit");
  } else if (isMonday7) {
    msg = t("dyn-bubble-monday-7");
  } else if (!savedToday) {
    msg = t("dyn-bubble-save-now");
  } else {
    msg = t("dyn-bubble-come-back", { day: Math.min(7, (streakDay || 0) + 1) });
  }
  bubble.textContent = msg;
  bubble.className = "fox-bubble visible";
}

// ── Referral code resolution ──────────────────────────────────────────────────
// Priority: localStorage (set by modal or URL) → URL ?ref= → none.
// Returns a bytes4 hex string ready for deposit(refCode).
function getRefCodeFromURL() {
  const ref = new URLSearchParams(window.location.search).get("ref") || "";
  if (ref.length === 8 && /^[0-9a-fA-F]{8}$/.test(ref)) return "0x" + ref.toLowerCase();
  return "";
}
function getStoredRefCode() {
  try {
    const code = localStorage.getItem("zorrito_ref_code") || "";
    if (/^0x[0-9a-fA-F]{8}$/.test(code)) return code.toLowerCase();
  } catch {}
  return "";
}
function setStoredRefCode(code) {
  try { localStorage.setItem("zorrito_ref_code", code); } catch {}
}
function clearStoredRefCode() {
  try { localStorage.removeItem("zorrito_ref_code"); } catch {}
}
// What we send to deposit(): real code or all-zeros if none
function getRefCodeForDeposit() {
  return getStoredRefCode() || getRefCodeFromURL() || "0x00000000";
}

// ── Referral modal: shown once per wallet that has never deposited ────────────
async function maybeShowReferralModal() {
  if (!userAddr || !zorrito) return;
  const askedKey = `zorrito_ref_asked_${userAddr.toLowerCase()}`;
  try {
    if (localStorage.getItem(askedKey)) return; // already asked this wallet
  } catch {}

  // Only show if user has NEVER deposited (referral only counts on first deposit)
  try {
    const dep = await zorrito.deposits(userAddr);
    if (dep > 0n) {
      try { localStorage.setItem(askedKey, "1"); } catch {}
      return; // existing depositor — referral is no longer applicable
    }
  } catch { return; }

  // If a ?ref= came in the URL, pre-fill it and auto-validate
  const urlRef = getRefCodeFromURL();
  showReferralModal(urlRef ? urlRef.slice(2) : "");
  try { localStorage.setItem(askedKey, "1"); } catch {}
}

function showReferralModal(prefill = "") {
  const backdrop = $("ref-modal-backdrop");
  const input    = $("ref-modal-input");
  const status   = $("ref-modal-status");
  const apply    = $("ref-modal-apply");
  const skip     = $("ref-modal-skip");
  if (!backdrop || !input || !apply || !skip) return;

  input.value = prefill;
  status.textContent = "";
  status.style.color = "var(--muted)";
  backdrop.style.display = "flex";

  const close = () => { backdrop.style.display = "none"; };

  skip.onclick = () => {
    clearStoredRefCode();
    close();
  };

  apply.onclick = async () => {
    const raw = (input.value || "").trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{8}$/.test(raw)) {
      status.style.color = "#dc2626";
      status.textContent = "Código inválido: debe tener 8 caracteres hex (0-9, a-f).";
      return;
    }
    const code = "0x" + raw;
    apply.disabled = true;
    apply.textContent = "Validando...";
    status.style.color = "var(--muted)";
    status.textContent = "Verificando código on-chain...";
    try {
      const owner = await zorrito.codeOwner(code);
      if (!owner || owner === ethers.ZeroAddress) {
        status.style.color = "#dc2626";
        status.textContent = "Ese código no existe.";
        apply.disabled = false; apply.textContent = "Aplicar código";
        return;
      }
      if (owner.toLowerCase() === userAddr.toLowerCase()) {
        status.style.color = "#dc2626";
        status.textContent = "No podés usar tu propio código.";
        apply.disabled = false; apply.textContent = "Aplicar código";
        return;
      }
      setStoredRefCode(code);
      status.style.color = "var(--green)";
      status.textContent = `✅ Código válido. Se aplicará en tu primer depósito.`;
      apply.textContent = "✅ Aplicado";
      setTimeout(close, 1200);
      showToast(`Referido aplicado: ${fmtAddr(owner)}`, "ok");
    } catch (e) {
      status.style.color = "#dc2626";
      status.textContent = "Error validando. Intentá de nuevo.";
      apply.disabled = false; apply.textContent = "Aplicar código";
    }
  };
}

// ── txGuard: wraps every write with loading toast + error handling ─────────────
async function txGuard(label, fn) {
  try {
    showToast(`${label}...`, "info");
    const opts = await txOpts();
    const tx = await fn(opts);
    showToast("Esperando confirmación...", "info");
    await tx.wait();
    showToast(`✅ ${label} confirmado`, "success");
    await refreshAll();
  } catch (err) {
    const msg = err?.reason || err?.shortMessage || err?.message || "Error desconocido";
    showToast(`❌ ${msg}`, "error");
    console.error(`[${label}]`, err);
  }
}

// ── USDT allowance ────────────────────────────────────────────────────────────
async function ensureAllowance(amount) {
  const opts = await txOpts();
  const allowance = await usdtW.allowance(userAddr, CONTRACT_ADDRESS);
  if (allowance < amount) {
    showToast("Aprobando USDT... (confirmá en tu wallet)", "info");
    const tx = await usdtW.approve(CONTRACT_ADDRESS, ethers.MaxUint256, opts);
    showToast("Esperando confirmación del approve...", "info");
    await tx.wait();
    showToast("✅ USDT aprobado", "success");
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function actionDeposit() {
  const btn = $("btn-deposit");
  if (!zorritoW || !usdtW) {
    if (btn) { btn.textContent = "⚠️ Sin wallet"; setTimeout(() => { btn.textContent = "Depositar"; }, 2000); }
    return showToast("Conectá tu wallet primero", "error");
  }
  const raw = $("input-deposit")?.value?.trim();
  if (!raw || isNaN(parseFloat(raw)) || parseFloat(raw) <= 0) {
    if (btn) { btn.textContent = "⚠️ Ingresá monto"; setTimeout(() => { btn.textContent = "Depositar"; }, 2000); }
    return showToast("Ingresá un monto válido", "error");
  }
  const amount = BigInt(Math.round(parseFloat(raw) * 1e6));
  if (amount < MIN_DEPOSIT) {
    if (btn) { btn.textContent = "⚠️ Mín. 0.25"; setTimeout(() => { btn.textContent = "Depositar"; }, 2000); }
    return showToast("Mínimo 0.25 USDT", "error");
  }

  if (btn) { btn.disabled = true; btn.textContent = "Procesando..."; }
  try {
    const refCode = getRefCodeForDeposit();
    await ensureAllowance(amount);
    await txGuard("Depósito", (opts) => zorritoW.deposit(amount, refCode, opts));
    // Referral code is consumed on first deposit; clear it so we don't carry stale state
    clearStoredRefCode();
    const input = $("input-deposit");
    if (input) input.value = "";
    document.querySelectorAll(".usdt-preset").forEach(b => b.classList.remove("selected"));
  } catch (err) {
    const msg = err?.reason || err?.shortMessage || err?.message || "Error desconocido";
    showToast(`❌ ${msg}`, "error");
    console.error("[actionDeposit]", err);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Depositar"; }
  }
}

async function actionWithdraw() {
  if (!zorritoW || !zorrito) return showToast("Conectá tu wallet primero", "error");
  const dep = await zorrito.deposits(userAddr);
  if (dep === 0n) return showToast("No tenés depósito", "error");
  const raw = $("input-withdraw")?.value;
  const amount = raw ? BigInt(Math.round(parseFloat(raw) * 1e6)) : dep;
  await txGuard("Retiro", (opts) => zorritoW.withdraw(amount, opts));
}

async function actionSave() {
  if (!zorritoW || !usdtW) return showToast("Conectá tu wallet primero", "error");
  const btn = $("btn-save");
  // "Adopt" shortcut: when user has no deposit yet, this same button starts
  // the minimum-deposit flow (0.25 USDT) instead of save() (which would revert).
  if (btn?.dataset?.action === "adopt") return actionAdopt();

  // Daily action = deposit 0.25 USDT. The new V2 contract fuses streak
  // extension INTO deposit(): one tx, real savings, no separate save() call.
  try {
    const amount = MIN_DEPOSIT; // 0.25 USDT
    const refCode = getRefCodeForDeposit();
    const lastDay = await zorrito.lastDepositDay(userAddr);
    const todayDay = BigInt(Math.floor(Date.now() / 1000 / 86400));
    if (lastDay >= todayDay) {
      return showToast("Ya ahorraste hoy 🦊", "success");
    }
    await ensureAllowance(amount);
    await txGuard("Ahorrando 0.25 USDT", (opts) => zorritoW.deposit(amount, refCode, opts));
    clearStoredRefCode();
  } catch (err) {
    const msg = err?.reason || err?.shortMessage || err?.message || "Error desconocido";
    showToast(`❌ ${msg}`, "error");
    console.error("[actionSave]", err);
  }
}

async function actionAdopt() {
  if (!zorritoW || !usdtW) return showToast("Conectá tu wallet primero", "error");
  const btn = $("btn-save");
  const orig = btn?.textContent;
  try {
    if (btn) { btn.disabled = true; btn.textContent = "Procesando..."; }
    const amount = MIN_DEPOSIT; // 0.25 USDT in 6 decimals
    const refCode = getRefCodeForDeposit();
    await ensureAllowance(amount);
    await txGuard("Adoptando tu zorro", (opts) => zorritoW.deposit(amount, refCode, opts));
    clearStoredRefCode();
    showToast("🦊 ¡Zorro adoptado! Acordate de ahorrar cada día.", "success");
  } catch (err) {
    const msg = err?.reason || err?.shortMessage || err?.message || "Error desconocido";
    showToast(`❌ ${msg}`, "error");
    console.error("[actionAdopt]", err);
    if (btn) { btn.textContent = orig; btn.disabled = false; }
  }
}

async function actionClaimSavings() {
  if (!zorritoW) return showToast("Conectá tu wallet primero", "error");
  await txGuard("Reclamar savings", (opts) => zorritoW.claimSavings(opts));
}

function copyReferralLink() {
  const el = $("referral-link");
  if (!el) return;
  navigator.clipboard.writeText(el.value).then(() => showToast("¡Link copiado!", "success"));
}

// ── Fox Customizer ────────────────────────────────────────────────────────────
const foxTraits = { fur: "orange", accessory: "sunglasses", background: "jungle", expression: "cool", jersey: "none" };

document.querySelectorAll(".trait-pill").forEach(pill => {
  pill.addEventListener("click", () => {
    const trait = pill.dataset.trait;
    const value = pill.dataset.value;
    foxTraits[trait] = value;
    document.querySelectorAll(`[data-trait="${trait}"]`).forEach(p => p.classList.remove("active"));
    pill.classList.add("active");
  });
});

// Jersey country selector
const jerseySelect = document.getElementById("jersey-select");
if (jerseySelect) {
  jerseySelect.addEventListener("change", () => {
    foxTraits.jersey = jerseySelect.value;
  });
}

// In-memory cache of the user's generated fox URL (source of truth: Vercel Blob/KV)
let generatedFoxUrl   = null;
let _foxLoadedFor     = null; // wallet address (lowercase) the cached fox belongs to
let _selfVerifiedKnown = false; // once true, never reset by refreshAll polling

function applyGeneratedFox(imageUrl) {
  generatedFoxUrl = imageUrl;
  // Show in customizer preview
  const wrap = $("fox-preview-wrap");
  if (wrap) wrap.innerHTML = `<img src="${imageUrl}" class="fox-preview" alt="Tu zorro">`;
  // Always update the main fox card unconditionally
  const foxImg = $("fox-image");
  if (foxImg) {
    foxImg.src = imageUrl;
    foxImg.classList.remove("fox-float");
    foxImg.closest(".fox-img-col")?.classList.add("generated");
  }
  // Show download button (strip cache-buster from the download URL)
  const dlBtn = $("btn-download-fox");
  if (dlBtn) {
    dlBtn.href = imageUrl.split("?")[0];
    dlBtn.style.display = "block";
  }
}

async function loadFoxPreview(walletAddr) {
  try {
    const resp = await fetch("/api/fox-gallery");
    if (!resp.ok) return;
    const { gallery } = await resp.json();
    const entry = gallery?.find(e => e.wallet === walletAddr.toLowerCase());
    // Ignore stale result if wallet changed while fetch was in flight
    if (!userAddr || userAddr.toLowerCase() !== walletAddr.toLowerCase()) return;
    _foxLoadedFor = walletAddr.toLowerCase();
    if (entry?.imageUrl) {
      const url = `${entry.imageUrl}?t=${entry.timestamp || Date.now()}`;
      applyGeneratedFox(url);
    } else {
      // No custom fox for this wallet — reset to default
      generatedFoxUrl = null;
      const wrap = $("fox-preview-wrap");
      if (wrap) wrap.innerHTML = "";
      const dlBtn = $("btn-download-fox");
      if (dlBtn) dlBtn.style.display = "none";
      const foxImg = $("fox-image");
      if (foxImg) {
        foxImg.src = "assets/zorritovivo.png";
        foxImg.closest(".fox-img-col")?.classList.remove("generated");
      }
    }
  } catch { /* silently fail */ }
}

async function actionGenerateFox() {
  if (!usdtW || !userAddr) return showToast("Conectá tu wallet primero", "error");
  const btn = $("btn-generate-fox");
  const description = $("fox-description")?.value || "";
  if (btn) { btn.disabled = true; btn.textContent = "Enviando pago..."; }
  try {
    const opts = await txOpts();
    showToast("Enviando 0.25 USDT...", "info");
    const txPay = await usdtW.transfer(PLATFORM_WALLET, FOX_COST, opts);
    showToast("Confirmando pago...", "info");
    const receipt = await txPay.wait();

    if (btn) btn.textContent = "Generando imagen...";
    showToast("Generando tu zorro con IA...", "info");

    const resp = await fetch("/api/fox-generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wallet: userAddr, txHash: receipt.hash, traits: { ...foxTraits }, description }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || "Error generando imagen");

    showToast("🦊 ¡Tu zorro fue generado!", "success");
    // Bust cache: same blob URL reused per wallet, must force browser re-fetch
    const foxUrl = `${data.imageUrl}?t=${Date.now()}`;
    // refreshAll may reset fox image via updateFoxState — apply AFTER so it's always last
    await refreshAll();
    applyGeneratedFox(foxUrl);
  } catch (err) {
    const msg = err?.reason || err?.shortMessage || err?.message || "Error desconocido";
    showToast(`❌ ${msg}`, "error");
    console.error("[fox-generate]", err);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🎨 Generar mi Zorro — 0.25 USDT"; }
  }
}

// ── Self.xyz verification ──────────────────────────────────────────────────────
// MiniPay learnings applied:
//  • Universal Link <a> button — NOT window.location.href (MiniPay blocks programmatic deep links)
//  • Start backend polling right after mobile_connected (before proof, in case MiniPay backgrounds)
//  • visibilitychange: re-poll when user returns to MiniPay after switching to Self
//  • No deeplinkCallback — routes to Safari instead of back into MiniPay
//  • iOS freezes the WebView when user switches apps → polling detects proof on return

const SELF_SCOPE    = "zorrito-v2";
const SELF_ENDPOINT = `${window.location.origin}/api/self-verify`;

let _selfSocket     = null;
let _selfSessionId  = null;
let _selfPollActive = false;

function uuidv4() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

function updateSelfVerificationUI(verified) {
  if (verified) _selfVerifiedKnown = true;
  const row = $("self-verify-card"); // now a row inside the "chances" card
  if (!row) return;

  const icon = row.querySelector("span");

  const selfImg = `<img src="assets/selflogo.png" alt="Self" style="width:22px;height:22px;border-radius:5px;flex-shrink:0;margin-top:1px;">`;

  if (!userAddr) {
    row.style.borderColor = "#f0e0d0";
    row.style.background  = "#fff";
    row.innerHTML = `
      ${selfImg}
      <div style="flex:1;min-width:0;">
        <div style="font-weight:700;font-size:0.85rem;">Verificate con Self <span style="font-size:0.72rem;background:rgba(59,130,246,.1);color:#3b82f6;border:1px solid rgba(59,130,246,.25);padding:1px 6px;border-radius:5px;font-weight:700;vertical-align:middle;">+25%</span></div>
        <div style="font-size:0.75rem;color:var(--muted);margin-top:2px;">Verificá tu pasaporte con ZK proof · una sola vez · permanente</div>
      </div>`;
    return;
  }

  if (verified) {
    row.style.borderColor = "rgba(26,153,96,.3)";
    row.style.background  = "rgba(26,153,96,.04)";
    row.innerHTML = `
      ${selfImg}
      <div style="flex:1;min-width:0;">
        <div style="font-weight:700;font-size:0.85rem;color:var(--green);">Verificado con Self <span style="font-size:0.72rem;background:rgba(26,153,96,.12);color:var(--green);border:1px solid rgba(26,153,96,.25);padding:1px 6px;border-radius:5px;font-weight:700;vertical-align:middle;">+25% activo</span></div>
        <div style="font-size:0.75rem;color:var(--muted);margin-top:2px;">Pasaporte verificado con ZK proof · permanente</div>
      </div>`;
    return;
  }

  // Connected, not verified — show button + flow inline
  row.style.borderColor = "rgba(59,130,246,.25)";
  row.style.background  = "rgba(59,130,246,.03)";
  row.innerHTML = `
    ${selfImg}
    <div style="flex:1;min-width:0;">
      <div style="font-weight:700;font-size:0.85rem;">Verificate con Self <span style="font-size:0.72rem;background:rgba(59,130,246,.1);color:#3b82f6;border:1px solid rgba(59,130,246,.25);padding:1px 6px;border-radius:5px;font-weight:700;vertical-align:middle;">+25%</span></div>
      <div style="font-size:0.75rem;color:var(--muted);margin-top:2px;margin-bottom:8px;">ZK proof de pasaporte · una sola vez · sin revelar datos</div>
      <div id="self-steps" style="display:none;flex-direction:column;gap:4px;margin-bottom:8px;font-size:0.75rem;"></div>
      <div id="self-status-box" style="display:none;padding:7px 10px;border-radius:7px;font-size:0.75rem;text-align:center;margin-bottom:8px;"></div>
      <div id="self-link-wrap"></div>
      <button id="btn-self-verify" style="display:flex;align-items:center;gap:6px;padding:8px 14px;background:linear-gradient(160deg,#3b82f6 0%,#2563eb 100%);color:#fff;border:none;border-radius:9px;font-size:0.8rem;font-weight:700;cursor:pointer;font-family:var(--font);">
        <img src="assets/selflogo.png" alt="" style="width:16px;height:16px;border-radius:3px;"> Verificar con Self →
      </button>
    </div>`;

  const btn = $("btn-self-verify");
  if (btn) btn.addEventListener("click", startSelfVerification);
}

function setSelfStatus(msg, type) {
  const box = $("self-status-box");
  if (!box) return;
  box.style.display = "";
  box.textContent   = msg;
  const styles = {
    idle:    "background:#f5f5f5;color:#999;border:1px solid #e0e0e0;",
    pending: "background:#fff9e6;color:#b45309;border:1px solid #fcd34d;",
    polling: "background:#eff6ff;color:#2563eb;border:1px solid #bfdbfe;",
    ok:      "background:#f0fdf4;color:var(--green);border:1px solid rgba(26,153,96,.3);",
    error:   "background:#fef2f2;color:#dc2626;border:1px solid #fecaca;",
  };
  box.style.cssText += styles[type] || styles.idle;
}

function setSelfStep(n, state /* "waiting" | "done" | "active" */) {
  const stepsEl = $("self-steps");
  if (!stepsEl) return;
  stepsEl.style.display = "flex";
  const labels = ["Iniciá la verificación","Escaneá tu pasaporte en Self","Volvé a esta página","Verificación confirmada"];
  stepsEl.innerHTML = labels.map((lbl, i) => {
    const num = i + 1;
    const s   = num < n ? "done" : num === n ? "active" : "waiting";
    const icon = s === "done" ? "✅" : s === "active" ? "▶️" : "⚪";
    const clr  = s === "done" ? "var(--green)" : s === "active" ? "var(--text)" : "var(--muted)";
    return `<div style="display:flex;align-items:center;gap:8px;color:${clr};font-weight:${s==="active"?"700":"400"};">${icon} ${lbl}</div>`;
  }).join("");
}

function connectSelfRelay(sessionId, selfApp) {
  if (_selfSocket) { _selfSocket.disconnect(); _selfSocket = null; }
  if (typeof io === "undefined") {
    setSelfStatus("Error: Socket.io no cargado. Recargá la página.", "error");
    return;
  }
  _selfSocket = io("https://websocket.self.xyz/websocket", {
    path: "/",
    query: { sessionId, clientType: "web" },
    transports: ["websocket"],
  });

  _selfSocket.on("connect", () => {
    setSelfStatus("Relay conectado — abrí Self y verificá tu pasaporte", "pending");
  });

  _selfSocket.on("connect_error", err => {
    setSelfStatus("Error conectando al relay: " + err.message, "error");
  });

  _selfSocket.on("mobile_status", data => {
    switch (data.status) {
      case "mobile_connected":
        setSelfStep(2, "active");
        setSelfStatus("Self conectado ✓ — generando ZK proof...", "polling");
        // Emit the app config so Self knows what to prove
        _selfSocket.emit("self_app", { ...selfApp, sessionId });
        // Start polling immediately — MiniPay backgrounds the WebView when user switches
        // to Self, so the WebSocket might not fire proof_verified on return
        setTimeout(() => pollSelfVerification(sessionId, 0), 6000);
        break;
      case "proof_generation_started":
        setSelfStatus("Generando ZK proof de tu pasaporte...", "polling");
        break;
      case "proof_generated":
        setSelfStatus("Proof generado — verificando on-chain...", "polling");
        break;
      case "proof_generation_failed":
        setSelfStatus("❌ El proof falló en Self. Intentá de nuevo.", "error");
        break;
    }
  });

  _selfSocket.on("proof_verified", () => {
    onSelfVerified();
  });
}

async function pollSelfVerification(sessionId, attempts) {
  if (!userAddr || _selfPollActive === sessionId) return; // avoid double-polling
  _selfPollActive = sessionId;

  if (attempts > 40) { // 40 × 3s = 2 min max
    if (_selfPollActive === sessionId) {
      setSelfStatus("⏱ Timeout. Si verificaste en Self, recargá la página.", "error");
      _selfPollActive = null;
      _selfSessionId  = null; // allow refreshAll to update UI again
    }
    return;
  }

  try {
    const res  = await fetch(`/api/self-status?address=${userAddr}`);
    const data = await res.json();
    if (data.verified) {
      _selfPollActive = null;
      onSelfVerified();
      return;
    }
  } catch { /* network hiccup — keep polling */ }

  setSelfStatus(`⏳ Esperando confirmación... (${attempts + 1}/40)`, "polling");
  setTimeout(() => pollSelfVerification(sessionId, attempts + 1), 3000);
}

function onSelfVerified() {
  _selfSessionId = null; // flow complete — allow refreshAll to manage UI
  if (_selfSocket) { _selfSocket.disconnect(); _selfSocket = null; }
  // Immediately render verified state — sets _selfVerifiedKnown = true
  // so no future refreshAll cycle can reset it
  updateSelfVerificationUI(true);
  // Also refresh full UI stats after a short delay
  setTimeout(() => refreshAll(), 1500);
}

async function startSelfVerification() {
  if (!userAddr) return showToast("Conectá tu wallet primero", "error");

  const sessionId = uuidv4();
  _selfSessionId  = sessionId;

  const selfApp = {
    appName:          "Zorrito",
    scope:            SELF_SCOPE,
    endpoint:         SELF_ENDPOINT,
    endpointType:     "https",
    userId:           sessionId,
    userIdType:       "uuid",
    userDefinedData:  userAddr,   // backend uses this to know which wallet to mark verified
    sessionId:        sessionId,
    devMode:          false,
    header:           "",
    logoBase64:       "",
    disclosures:      { excludedCountries: [], ofac: false, nationality: false },
    deeplinkCallback: "",         // intentionally blank — deeplinkCallback sends to Safari in MiniPay
    version:          2,
    chainID:          42220,      // Celo mainnet
  };

  // Hide verify button, show steps
  const btnWrap = $("btn-self-verify");
  if (btnWrap) btnWrap.style.display = "none";

  setSelfStep(1, "done");
  setSelfStatus("Conectando al relay de Self...", "pending");

  // Connect to relay FIRST, then show the Universal Link button
  connectSelfRelay(sessionId, selfApp);

  // Universal Link button — MUST be an <a> tap, NOT window.location.href
  // MiniPay blocks programmatic deep links in its WebView
  const universalLink = `https://redirect.self.xyz?selfApp=${encodeURIComponent(JSON.stringify(selfApp))}`;
  const linkWrap = $("self-link-wrap");
  if (linkWrap) {
    linkWrap.innerHTML = `
      <a href="${universalLink}"
         style="display:block;width:100%;padding:13px;background:linear-gradient(160deg,#FF9A2F 0%,#FD840E 55%,#E06800 100%);
                color:#fff;font-weight:800;font-size:0.92rem;text-align:center;border-radius:12px;
                text-decoration:none;box-sizing:border-box;margin-bottom:8px;"
         id="self-open-link">
        👆 Tocá aquí para abrir Self
      </a>`;
  }

  // visibilitychange: re-poll when user returns from Self (iOS backgrounds MiniPay WebView)
  // IMPORTANT: must reset _selfPollActive before calling — iOS freezes the WebView mid-poll,
  // leaving _selfPollActive === sessionId and causing the guard to skip the restart
  const onVisible = () => {
    if (!document.hidden && _selfSessionId === sessionId) {
      _selfPollActive = null;       // clear frozen state so polling can restart
      pollSelfVerification(sessionId, 0);
    }
  };
  document.addEventListener("visibilitychange", onVisible, { once: false });
}

// ── Wire up buttons — runs immediately (module is deferred, DOM is ready) ──────
// NOTE: do NOT wrap in DOMContentLoaded — top-level await blocks that event
{
  // Event delegation on document so the listener survives header re-renders
  // (nav-shared.js can replace #btn-connect after app.js loads — direct binding
  // would be lost; delegation looks up the current button on every click).
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("#btn-connect");
    if (!btn) return;
    if (userAddr) { modal.open({ view: "Account" }); }
    else          { modal.open(); }
  });

  const btnDeposit  = $("btn-deposit");
  const btnWithdraw = $("btn-withdraw");
  const btnSave     = $("btn-save");
  const btnClaim    = $("btn-claim-savings");
  const btnGenFox   = $("btn-generate-fox");
  const btnCopyRef  = $("btn-copy-referral");

  if (btnDeposit)  btnDeposit.addEventListener("click",  actionDeposit);
  if (btnWithdraw) btnWithdraw.addEventListener("click", actionWithdraw);
  if (btnSave)     btnSave.addEventListener("click",     actionSave);
  if (btnClaim)    btnClaim.addEventListener("click",    actionClaimSavings);
  if (btnGenFox)   btnGenFox.addEventListener("click",   actionGenerateFox);
  if (btnCopyRef)  btnCopyRef.addEventListener("click",  copyReferralLink);

  // USDT preset buttons
  document.querySelectorAll(".usdt-preset").forEach(btn => {
    btn.onclick = () => {
      const input = $("input-deposit");
      if (input) input.value = btn.dataset.amount;
      document.querySelectorAll(".usdt-preset").forEach(b => b.classList.remove("selected"));
      btn.classList.add("selected");
    };
  });

  const inputDep = $("input-deposit");
  if (inputDep) {
    inputDep.addEventListener("input", () => {
      document.querySelectorAll(".usdt-preset").forEach(b => b.classList.remove("selected"));
    });
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
loadGuestStats();
await tryMiniPayConnect();

// React to account switches inside MiniPay
if (isMiniPay() && window.ethereum) {
  window.ethereum.on("accountsChanged", (accounts) => {
    if (accounts[0]) {
      userAddr = accounts[0];
      const addrEl = $("minipay-addr");
      if (addrEl) addrEl.textContent = fmtAddr(userAddr);
      provider = new ethers.BrowserProvider(window.ethereum);
      provider.getSigner().then(s => { signer = s; onConnected(); });
    } else {
      onDisconnected();
    }
  });
}

// ── Imports via CDN (no build step needed) ────────────────────────────────────
import { createAppKit }   from "https://esm.sh/@reown/appkit@1.8.19?bundle";
import { EthersAdapter }  from "https://esm.sh/@reown/appkit-adapter-ethers@1.8.19?bundle";
import { celo }           from "https://esm.sh/@reown/appkit@1.8.19/networks?bundle";
import { ethers }         from "https://esm.sh/ethers@6.11.1?bundle";

// ── Lemon Cash Mini-App SDK ───────────────────────────────────────────────────
let _lemonSDK = null;
try {
  _lemonSDK = await import("https://esm.sh/@lemoncash/mini-app-sdk@0.1.11?bundle");
} catch (e) {
  console.warn("Lemon SDK not available:", e.message);
}

// ── i18n helper ───────────────────────────────────────────────────────────────
// Returns a translated string for the given key, using the current language.
function t(key) {
  try {
    const lang = localStorage.getItem('zorrito-lang') || 'en';
    return window.ZORRITO_T?.[lang]?.[key]
        ?? window.ZORRITO_T?.['en']?.[key]
        ?? key;
  } catch { return key; }
}

// ── Config ─────────────────────────────────────────────────────────────────────
// 1. Get a FREE project ID at https://cloud.reown.com → New Project → AppKit
// 2. Paste it below ↓
const REOWN_PROJECT_ID = "7b357de2964e4c3f344339b5144c1bf5";

const ZORRITO_ADDRESS = "0x135dc8DC4bEd4e619B97b07bA16bCE348CAeFF62"; // v8 — 10% platform fee
const CONTRACT_DEPLOYED = ZORRITO_ADDRESS !== "0x0000000000000000000000000000000000000000";
const USDT_ADDRESS    = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e"; // USDT on Celo (Aave V3 listed)

// ── ABIs ───────────────────────────────────────────────────────────────────────
const ZORRITO_ABI = [
  // core
  "function deposit(uint256 amount) external",
  "function withdraw(uint256 amount) external",
  "function draw() external",
  "function feed() external",
  // views
  "function getStats() view returns (uint256 poolSize, uint256 yieldAvailable, uint256 playerCount, uint256 nextDraw, uint256 aliveFoxes)",
  "function getUserDeposit(address user) view returns (uint256)",
  "function canDraw() view returns (bool)",
  "function isAlive(address user) view returns (bool)",
  "function getFoxStatus(address user) view returns (bool alive, uint32 currentStreak, uint32 bestStreak, uint256 fishCount, uint256 nextFeedDeadline, uint256 secondsUntilDead, uint256 currentStreakWeight, uint256 effTickets)",
  "function getLeaderboardData() view returns (address[] addrs, uint32[] streaks, uint32[] bestStreaks, bool[] alive, uint256[] fishCounts, uint256[] effTickets)",
  "function streakWeight(uint32 s) pure returns (uint256)",
  "function effectiveTickets(address user) view returns (uint256)",
  "function totalDeposited() view returns (uint256)",
  // events
  "event Deposited(address indexed user, uint256 amount, uint256 fish)",
  "event Withdrawn(address indexed user, uint256 amount)",
  "event WinnerPicked(address indexed winner, uint256 prize, uint256 platformFee, uint256 timestamp)",
  "event FoxFed(address indexed user, uint32 newStreak, bool wasRevived)",
];

const USDT_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

// ── Reown AppKit setup ─────────────────────────────────────────────────────────
const ethersAdapter = new EthersAdapter();

const modal = createAppKit({
  adapters: [ethersAdapter],
  networks: [celo],
  projectId: REOWN_PROJECT_ID,
  metadata: {
    name: "Zorrito",
    description: "No-loss lottery on Celo powered by Aave yield",
    url: window.location.origin,
    icons: ["https://www.zorrito.app/assets/zorritofinallogo.png"],
  },
  features: { analytics: false, email: false, socials: false },
  themeMode: "dark",
  themeVariables: {
    "--w3m-accent":           "#35d07f",
    "--w3m-border-radius-master": "4px",
  },
  // Valora WalletConnect ID — shown first in the wallet list
  featuredWalletIds: [
    "d01c7758d741b363e637a817a09bcf579feae4db9f5bb16f599fdd1f66e2f974",
  ],
});

// ── Aave reserve data ABI (for live APY) ──────────────────────────────────────
const AAVE_POOL_ABI_RESERVE = [
  "function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt)"
];
const AAVE_POOL_ADDRESS = "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402";

// ── State ──────────────────────────────────────────────────────────────────────
let provider, signer, zorrito, usdt, aUsdtContract, userAddress;
let nextDrawTimestamp  = 0;
let currentPlayerCount = 0;
let currentYield       = 0n;
let currentTotalDeposited = 0n;
let currentUserDeposit    = 0n;
let countdownInterval  = null;
let statsInterval      = null;
let currentAPY         = null;
let foxDeadInterval    = null; // countdown for fox death
let foxBubbleTimeout   = null; // for temporary bubbles
let foxBubblePermanent = false; // true = don't auto-hide
// Fox image state tracking
let _prevFoxAlive = null; // null = unknown, true/false = previous state

// Effective ticket state — set by refreshFoxStatus / refreshLeaderboard
let currentUserEffTix  = 0;   // user's effective tickets (0 if fox dead)
let currentTotalEffTix = 0;   // sum of all alive foxes' effective tickets
let currentUserMult    = 1.0; // user's streak multiplier (e.g. 1.5, 2.0…)
let currentUserStreak  = 0;   // user's current streak (for window hint)

// ── DOM refs ───────────────────────────────────────────────────────────────────
const btnConnect    = document.getElementById("btn-connect");
const btnDraw       = document.getElementById("btn-draw");
const btnDeposit    = document.getElementById("btn-deposit");
const btnWithdraw   = document.getElementById("btn-withdraw");
const inputDeposit  = document.getElementById("input-deposit");
const inputWithdraw = document.getElementById("input-withdraw");
const elPool           = document.getElementById("stat-pool");
const elYield          = document.getElementById("stat-yield");
const elPlayers        = document.getElementById("stat-players");
const elMyDep          = document.getElementById("stat-mydeposit");
const elCountdown      = document.getElementById("countdown");
const elWinners        = document.getElementById("winner-list");
const elUserBal        = document.getElementById("user-balance-val");
const elWithdrawable   = document.getElementById("withdrawable-val");
const btnMaxWithdraw   = document.getElementById("btn-max-withdraw");
const btnMaxDeposit    = document.getElementById("btn-max-deposit");
const elUsdtWalletBal  = document.getElementById("usdt-wallet-bal");

// ── Fish preset buttons ────────────────────────────────────────────────────────
document.querySelectorAll(".fish-preset").forEach(btn => {
  btn.addEventListener("click", () => {
    const amount = btn.dataset.amount;
    inputDeposit.value = amount;
    // Highlight selected preset
    document.querySelectorAll(".fish-preset").forEach(b => b.classList.remove("selected"));
    btn.classList.add("selected");
    updateDepositPreview(parseFloat(amount));
  });
});

inputDeposit.addEventListener("input", () => {
  document.querySelectorAll(".fish-preset").forEach(b => b.classList.remove("selected"));
  updateDepositPreview(parseFloat(inputDeposit.value));
});

function updateDepositPreview(raw) {
  const el = document.getElementById("deposit-preview");
  if (el) el.style.display = "none";
}

// ── MiniPay detection ─────────────────────────────────────────────────────────
function isMiniPay() {
  return typeof window !== "undefined" && window.ethereum?.isMiniPay === true;
}

// ── Lemon Cash detection ──────────────────────────────────────────────────────
function isLemon() {
  try {
    return _lemonSDK?.isLemonWebView?.() === true ||
           (typeof window !== "undefined" && !!window.ReactNativeWebView);
  } catch { return false; }
}

// ── Lemon write helper — routes contract writes through the Lemon SDK ─────────
// Returns a result object; throws on CANCELLED or FAILED
async function lemonWrite(contractAddress, functionName, functionParams) {
  if (!_lemonSDK) throw new Error("Lemon SDK not loaded");
  const result = await _lemonSDK.callSmartContract({
    contracts: [{
      contractAddress,
      functionName,
      functionParams: functionParams.map(p => p.toString()),
      chainId: 42220,
    }],
  });
  if (result?.status === "CANCELLED") throw new Error("Transaction cancelled");
  if (result?.status === "FAILED")    throw new Error("Transaction failed");
  return result;
}

// ── Lemon authentication + setup ──────────────────────────────────────────────
async function connectLemon() {
  try {
    if (!_lemonSDK) throw new Error("Lemon SDK not loaded");
    const auth = await _lemonSDK.authenticate({ chainId: 42220 });
    if (!auth?.address) throw new Error("Authentication failed — no address returned");
    await setupAfterLemonAuth(auth.address);
  } catch (e) {
    toast("Lemon auth failed: " + (e.message || e), "error");
    console.error(e);
  }
}

async function setupAfterLemonAuth(address) {
  if (!CONTRACT_DEPLOYED) { toast("Contract not deployed yet", "error"); return; }
  try {
    // Read-only provider — Lemon handles signing natively via its SDK
    provider = new ethers.JsonRpcProvider("https://forno.celo.org");
    signer   = null;  // no ethers signer in Lemon
    userAddress = address;

    // Contract instances for reads (no signer needed for view functions)
    zorrito = new ethers.Contract(ZORRITO_ADDRESS, ZORRITO_ABI, provider);
    usdt    = new ethers.Contract(USDT_ADDRESS,    USDT_ABI,    provider);
    aUsdtContract = new ethers.Contract(
      "0xDeE98402A302e4D707fB9bf2bac66fAEEc31e8Df",
      ["function balanceOf(address) view returns (uint256)"],
      provider
    );

    // Show Lemon badge, hide connect button
    btnConnect.style.display = "none";
    const badge = document.getElementById("lemon-badge");
    if (badge) {
      badge.style.display = "flex";
      badge.querySelector(".lemon-addr").textContent = shortAddr(address);
    }

    await Promise.all([refreshAll(), fetchLiveAPY()]);
    loadRecentWinners();
    checkIfUserWon();
    refreshLeaderboard();
    startCountdown();

    if (statsInterval) clearInterval(statsInterval);
    clearInterval(_guestInterval);
    statsInterval = setInterval(refreshAll, 15_000);
    setInterval(fetchLiveAPY, 5 * 60 * 1000);

  } catch (e) {
    toast("Error setting up Lemon wallet: " + (e.message || e), "error");
    console.error(e);
  }
}

// ── Shared post-connect setup (used by both WalletConnect and MiniPay) ─────────
async function setupAfterConnect(rawProvider) {
  if (!CONTRACT_DEPLOYED) {
    toast("Contract not deployed yet", "error");
    return;
  }
  try {
    provider    = new ethers.BrowserProvider(rawProvider);
    signer      = await provider.getSigner();
    userAddress = await signer.getAddress();

    zorrito      = new ethers.Contract(ZORRITO_ADDRESS, ZORRITO_ABI, signer);
    usdt         = new ethers.Contract(USDT_ADDRESS,    USDT_ABI,    signer);
    aUsdtContract = new ethers.Contract(
      "0xDeE98402A302e4D707fB9bf2bac66fAEEc31e8Df",
      ["function balanceOf(address) view returns (uint256)"],
      provider
    );

    if (isMiniPay()) {
      // In MiniPay: hide the connect button, show address in badge
      btnConnect.style.display = "none";
      const badge = document.getElementById("minipay-badge");
      if (badge) {
        badge.style.display = "flex";
        badge.querySelector(".minipay-addr").textContent = shortAddr(userAddress);
      }
    } else {
      btnConnect.querySelector("span").textContent = shortAddr(userAddress);
      btnConnect.classList.add("connected");
    }

    await Promise.all([refreshAll(), fetchLiveAPY()]);
    loadRecentWinners();
    checkIfUserWon();
    refreshLeaderboard();
    startCountdown();

    // Analytics: identify user by wallet + track connect event
    if (window.posthog) {
      posthog.identify(userAddress);
      posthog.capture('wallet_connected', {
        wallet_type: isMiniPay() ? 'minipay' : isLemon() ? 'lemon' : 'walletconnect',
      });
    }

    if (statsInterval) clearInterval(statsInterval);
    clearInterval(_guestInterval);
    statsInterval = setInterval(refreshAll, 15_000);
    setInterval(fetchLiveAPY, 5 * 60 * 1000);

  } catch (e) {
    toast("Error setting up wallet: " + (e.message || e), "error");
    console.error(e);
  }
}

// ── MiniPay explicit connect (called on button tap or feed tap) ───────────────
async function connectMiniPay() {
  try {
    await window.ethereum.request({ method: "eth_requestAccounts" });
    await setupAfterConnect(window.ethereum);
  } catch (e) {
    toast("MiniPay connection failed: " + (e.message || e), "error");
  }
}

// ── Legacy tx options for MiniPay (type 0 only — no EIP-1559) ────────────────
// MiniPay rejects type-2 (EIP-1559) transactions. When inside MiniPay we must
// pass explicit gasPrice and type:0 to every contract write call.
async function txOpts() {
  if (!isMiniPay() || !provider) return {};
  try {
    const feeData = await provider.getFeeData();
    return { type: 0, gasPrice: feeData.gasPrice };
  } catch {
    // Fallback: 5 gwei
    return { type: 0, gasPrice: ethers.parseUnits("5", "gwei") };
  }
}

// ── Connect button → open AppKit modal (non-MiniPay only) ────────────────────
btnConnect.addEventListener("click", () => {
  if (isMiniPay() || isLemon()) return;
  if (userAddress) {
    modal.open({ view: "Account" });
  } else {
    modal.open();
  }
});

// ── Fetch live APY on page load (no wallet needed) ────────────────────────────
fetchLiveAPY();
checkAaveSupplyCap();

// ── Guest public stats (no wallet needed) ─────────────────────────────────────
// Polls on-chain every 30 s so pool/players/yield always show live data,
// even before a wallet is connected. Stopped once a real wallet takes over.
const _publicProvider = new ethers.JsonRpcProvider("https://forno.celo.org");
const _publicZorrito  = new ethers.Contract(ZORRITO_ADDRESS, ZORRITO_ABI, _publicProvider);

async function refreshPublicStats() {
  // Skip if a wallet is already connected — refreshAll() handles it instead
  if (zorrito) return;
  try {
    const [poolSize, yieldAvail, playerCount, , aliveFoxes] = await _publicZorrito.getStats();
    currentPlayerCount    = Number(playerCount);
    currentYield          = yieldAvail;
    currentTotalDeposited = poolSize;

    elPool.innerHTML    = `<span class="stat-num">${formatUSDTWhole(poolSize)}</span><span class="stat-unit"> USDT</span>`;
    elYield.innerHTML   = `<span class="stat-num">${formatYield(yieldAvail)}</span><span class="stat-unit"> USDT</span>`;
    elPlayers.innerHTML = `<span class="stat-num">${playerCount}</span><span class="stat-secondary">(${aliveFoxes} ${t('players-alive')} 🦊)</span>`;

    updateOdds(0n, poolSize, Number(playerCount));
  } catch (e) {
    console.warn("Guest stats refresh failed:", e.message);
  }
}

// Fire immediately so numbers appear on load, then every 30 s
refreshPublicStats();
const _guestInterval = setInterval(refreshPublicStats, 30_000);

// ── The Graph: override player count with all-time total (not just active) ───
fetch("/api/graph-stats")
  .then(r => r.ok ? r.json() : null)
  .then(gs => {
    if (!gs?.ok) return;
    // Patch player count — contract returns active depositors only,
    // The Graph has total unique depositors ever (always >= active)
    const totalEver = gs.users.total;
    const aliveNow  = gs.users.active;
    if (totalEver > 0 && elPlayers) {
      // Keep alive count from contract if already set, else use graph value
      const aliveSpan = elPlayers.querySelector(".stat-secondary");
      const aliveText = aliveSpan ? aliveSpan.textContent : `(${aliveNow} ${t('players-alive')} 🦊)`;
      elPlayers.innerHTML = `<span class="stat-num">${totalEver}</span><span class="stat-secondary">${aliveText}</span>`;
      currentPlayerCount = totalEver;
    }
  })
  .catch(() => {});

// ── Auto-connect MiniPay on page load ─────────────────────────────────────────
if (isMiniPay()) {
  connectMiniPay();
  // React to account switches inside MiniPay
  window.ethereum.on("accountsChanged", (accounts) => {
    if (accounts.length === 0) {
      userAddress = null;
      provider = signer = zorrito = usdt = null;
      if (statsInterval) clearInterval(statsInterval);
      resetStats();
    } else {
      connectMiniPay();
    }
  });
} else if (isLemon()) {
  // ── Auto-connect Lemon on page load ────────────────────────────────────────
  connectLemon();
}

// ── Valora {{address}} URL param — pre-connect in read-only mode ──────────────
// Deferred so AppKit finishes initialising before we set the button state.
setTimeout(function handleValoraAddressParam() {
  const params = new URLSearchParams(window.location.search);
  const addrParam = params.get("address");
  if (addrParam && ethers.isAddress(addrParam) && !isMiniPay() && !isLemon() && !userAddress) {
    // Read-only view for the given address (Valora deep-link support)
    const roProvider = new ethers.JsonRpcProvider("https://forno.celo.org");
    userAddress = addrParam;
    provider    = roProvider;
    signer      = null;
    zorrito      = new ethers.Contract(ZORRITO_ADDRESS, ZORRITO_ABI, roProvider);
    usdt         = new ethers.Contract(USDT_ADDRESS,    USDT_ABI,    roProvider);
    aUsdtContract = new ethers.Contract(
      "0xDeE98402A302e4D707fB9bf2bac66fAEEc31e8Df",
      ["function balanceOf(address) view returns (uint256)"],
      roProvider
    );
    btnConnect.querySelector("span").textContent = addrParam.slice(0, 6) + "…" + addrParam.slice(-4);
    btnConnect.classList.add("connected");
    refreshAll();
    if (statsInterval) clearInterval(statsInterval);
    clearInterval(_guestInterval);
    statsInterval = setInterval(refreshAll, 15_000);
  }
}, 500);

// ── React to WalletConnect/AppKit connection changes ─────────────────────────
modal.subscribeAccount(async (account) => {
  if (isMiniPay() || isLemon()) return; // handled separately
  if (account.isConnected && account.address) {
    await setupAfterConnect(modal.getWalletProvider());
  } else {
    // Disconnected
    userAddress = null;
    provider = signer = zorrito = usdt = null;
    btnConnect.querySelector("span").textContent = t('connect-wallet');
    btnConnect.style.display = "";
    btnConnect.classList.remove("connected");
    if (statsInterval) clearInterval(statsInterval);
    resetStats();
  }
});

// ── Deposit ────────────────────────────────────────────────────────────────────
btnDeposit.addEventListener("click", async () => {
  if (!signer && !isLemon()) return toast("Connect wallet first", "error");
  if (!CONTRACT_DEPLOYED)    return toast("Contract not deployed yet", "error");

  const raw = parseFloat(inputDeposit.value);
  if (!raw || isNaN(raw) || raw < 1) {
    toast("Enter an amount (min 1 USDT = 1 🐟)", "error");
    inputDeposit.focus();
    return;
  }

  const amount = ethers.parseUnits(Math.floor(raw).toString(), 6);

  // Check wallet balance first
  try {
    const walletBal = await usdt.balanceOf(userAddress);
    if (walletBal < amount) {
      const have = parseFloat(ethers.formatUnits(walletBal, 6)).toFixed(2);
      return toast(`Not enough USDT — wallet has ${have} USDT`, "error");
    }
  } catch (_) {}

  try {
    btnDeposit.disabled = true;

    const allowance = await usdt.allowance(userAddress, ZORRITO_ADDRESS);

    if (isLemon()) {
      // ── Lemon path ────────────────────────────────────────────────────
      if (allowance < amount) {
        toast("Step 1/2 — Approve USDT spend...");
        await lemonWrite(USDT_ADDRESS, "approve", [ZORRITO_ADDRESS, amount]);
      }
      toast("Step 2/2 — Depositing...");
      await lemonWrite(ZORRITO_ADDRESS, "deposit", [amount]);
    } else {
      // ── Standard ethers path ──────────────────────────────────────────
      if (allowance < amount) {
        toast("Step 1/2 — Approve USDT spend...");
        const tx = await usdt.approve(ZORRITO_ADDRESS, amount, await txOpts());
        await tx.wait();
      }
      toast("Step 2/2 — Depositing...");
      const tx = await zorrito.deposit(amount, await txOpts());
      await tx.wait();
    }

    inputDeposit.value = "";
    document.querySelectorAll(".fish-preset").forEach(b => b.classList.remove("selected"));
    document.getElementById("deposit-preview").style.display = "none";
    const fish = Math.floor(raw);
    toast(`Got ${fish} 🐟 fish! Fox alive & in the draw 🦊`, "success");
    if (window.posthog) posthog.capture('deposit_completed', { amount_usdt: raw, fish });
    await refreshAll();
  } catch (e) {
    const msg = e.reason || e.shortMessage || e.message || "Deposit failed";
    toast(msg.length > 80 ? msg.slice(0, 80) + "…" : msg, "error");
    console.error("Deposit error:", e);
  } finally {
    btnDeposit.disabled = false;
  }
});

// ── Max deposit button ─────────────────────────────────────────────────────────
btnMaxDeposit.addEventListener("click", async () => {
  if (!usdtContract || !userAddress) return;
  const bal = await usdtContract.balanceOf(userAddress);
  const formatted = ethers.formatUnits(bal, 6);
  inputDeposit.value = Math.floor(parseFloat(formatted)).toString();
  document.querySelectorAll(".fish-preset").forEach(b => b.classList.remove("selected"));
  updateDepositPreview(parseFloat(inputDeposit.value));
});

// ── Max withdraw button ────────────────────────────────────────────────────────
btnMaxWithdraw.addEventListener("click", async () => {
  if (!zorrito || !aUsdtContract) return;
  const [dep, aUsdtBal, total] = await Promise.all([
    zorrito.getUserDeposit(userAddress),
    aUsdtContract.balanceOf(ZORRITO_ADDRESS),
    zorrito.totalDeposited ? zorrito.totalDeposited() : Promise.resolve(currentTotalDeposited),
  ]);
  let withdrawable = dep;
  if (total > 0n && aUsdtBal < total) {
    withdrawable = (dep * aUsdtBal) / total;
  }
  inputWithdraw.value = ethers.formatUnits(withdrawable, 6);
});

// ── Withdraw ───────────────────────────────────────────────────────────────────
btnWithdraw.addEventListener("click", async () => {
  const raw = parseFloat(inputWithdraw.value);
  if (!CONTRACT_DEPLOYED)          return toast("Contract not deployed yet", "error");
  if (!raw || raw <= 0)            return toast("Enter amount to withdraw", "error");
  if (!signer && !isLemon())       return toast("Connect wallet first", "error");

  const amount = ethers.parseUnits(raw.toFixed(6), 6);
  try {
    btnWithdraw.disabled = true;
    toast("Withdrawing...");
    if (isLemon()) {
      await lemonWrite(ZORRITO_ADDRESS, "withdraw", [amount]);
    } else {
      const tx = await zorrito.withdraw(amount, await txOpts());
      await tx.wait();
    }
    inputWithdraw.value = "";
    toast(`Withdrawn ${raw} USDT`, "success");
    if (window.posthog) posthog.capture('withdraw_completed', { amount_usdt: parseFloat(raw) });
    await refreshAll();
  } catch (e) {
    toast(e.reason || e.message || "Withdraw failed", "error");
  } finally {
    btnWithdraw.disabled = false;
  }
});

// ── Feed Fox / Adopt Fox ───────────────────────────────────────────────────────
document.addEventListener("click", async (e) => {
  if (e.target.id !== "btn-feed") return;
  if (!signer && !isLemon()) {
    if (isMiniPay()) {
      await connectMiniPay();
    } else {
      modal.open();
    }
    return;
  }
  const btn = e.target;

  // "Adopt a Fox" — trigger a 1 USDT deposit
  if (btn.dataset.adopt === "true") {
    delete btn.dataset.adopt;
    btn.disabled = true;
    try {
      const amount = ethers.parseUnits("1", 6); // 1 USDT
      const walletBal = await usdt.balanceOf(userAddress);
      if (walletBal < amount) {
        return toast("Not enough USDT in wallet — need at least 1 USDT", "error");
      }
      const allowance = await usdt.allowance(userAddress, ZORRITO_ADDRESS);
      if (isLemon()) {
        if (allowance < amount) {
          toast("Step 1/2 — Approve USDT...");
          await lemonWrite(USDT_ADDRESS, "approve", [ZORRITO_ADDRESS, amount]);
        }
        toast("Step 2/2 — Adopting your fox...");
        await lemonWrite(ZORRITO_ADDRESS, "deposit", [amount]);
      } else {
        if (allowance < amount) {
          toast("Step 1/2 — Approve USDT...");
          const tx = await usdt.approve(ZORRITO_ADDRESS, amount, await txOpts());
          await tx.wait();
        }
        toast("Step 2/2 — Adopting your fox...");
        const tx = await zorrito.deposit(amount, await txOpts());
        await tx.wait();
      }
      toast("🦊 Fox adopted!", "success");
      await refreshAll();
      if (typeof showPopup === "function") {
        showPopup(
          '<img src="assets/zorritovivo.png" style="width:90px;height:90px;object-fit:contain;" />',
          t('popup-adopt-title'),
          t('popup-adopt-body')
        );
      }
    } catch(err) {
      toast(err.reason || err.shortMessage || err.message || "Adoption failed", "error");
    } finally {
      btn.disabled = false;
    }
    return;
  }

  // Normal feed — costs 1 USDT
  try {
    btn.disabled = true;
    const feedAmount = ethers.parseUnits("1", 6);

    // Check wallet balance
    const walletBal = await usdt.balanceOf(userAddress);
    if (walletBal < feedAmount) {
      toast("Need 1 USDT in wallet to feed your fox", "error");
      btn.disabled = false;
      return;
    }

    // Approve + feed
    const allowance = await usdt.allowance(userAddress, ZORRITO_ADDRESS);
    if (isLemon()) {
      if (allowance < feedAmount) {
        toast("Approving 1 USDT...");
        await lemonWrite(USDT_ADDRESS, "approve", [ZORRITO_ADDRESS, feedAmount]);
      }
      toast("Feeding your fox... 🐟 (1 USDT)");
      await lemonWrite(ZORRITO_ADDRESS, "feed", []);
    } else {
      if (allowance < feedAmount) {
        toast("Approving 1 USDT...");
        const approveTx = await usdt.approve(ZORRITO_ADDRESS, feedAmount, await txOpts());
        await approveTx.wait();
      }
      toast("Feeding your fox... 🐟 (1 USDT)");
      const tx = await zorrito.feed(await txOpts());
      await tx.wait();
    }

    toast("Fox fed! +1 🐟", "success");
    if (window.posthog) posthog.capture('fox_fed', { streak: currentUserStreak });
    await refreshAll();
    // Show thanks speech bubble briefly next to fox
    showFoxBubble(t('bubble-thanks'), { permanent: false, urgent: false, duration: 3500 });
    if (typeof showPopup === "function") {
      showPopup(
        '<img src="assets/zorritovivo.png" style="width:90px;height:90px;object-fit:contain;" />',
        t('popup-feed-title'),
        t('popup-feed-body')
      );
    }
  } catch(err) {
    toast(err.reason || err.shortMessage || err.message || "Feed failed", "error");
  } finally {
    btn.disabled = false;
  }
});

// ── Draw ───────────────────────────────────────────────────────────────────────
btnDraw.addEventListener("click", async () => {
  if (!signer && !isLemon()) return toast("Connect wallet first", "error");
  try {
    btnDraw.disabled = true;
    toast("Triggering draw...");
    if (isLemon()) {
      await lemonWrite(ZORRITO_ADDRESS, "draw", []);
      toast("Draw triggered!", "success");
    } else {
      const tx      = await zorrito.draw(await txOpts());
      const receipt = await tx.wait();
      const iface   = zorrito.interface;
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog(log);
          if (parsed.name === "WinnerPicked") {
            const winner = parsed.args.winner;
            const prize  = ethers.formatUnits(parsed.args.prize, 6);
            prependWinner(winner, prize);
            if (winner.toLowerCase() === userAddress.toLowerCase()) {
              showWinBanner(prize, new Date().toLocaleString());
            } else {
              toast(`Winner: ${shortAddr(winner)} won ${prize} USDT!`, "success");
            }
          }
        } catch {}
      }
    }
    await refreshAll();
  } catch (e) {
    toast(e.reason || e.message || "Draw failed", "error");
  } finally {
    btnDraw.disabled = false;
  }
});

// ── Stats ──────────────────────────────────────────────────────────────────────
async function refreshAll() {
  if (!zorrito) return;
  try {
    const [poolSize, yieldAvail, playerCount, nextDraw, aliveFoxes] = await zorrito.getStats();
    nextDrawTimestamp     = Number(nextDraw);
    currentPlayerCount    = Number(playerCount);
    currentYield          = yieldAvail;
    currentTotalDeposited = poolSize;

    elPool.innerHTML    = `<span class="stat-num">${formatUSDTWhole(poolSize)}</span><span class="stat-unit"> USDT</span>`;
    elYield.innerHTML   = `<span class="stat-num">${formatYield(yieldAvail)}</span><span class="stat-unit"> USDT</span>`;
    elPlayers.innerHTML = `<span class="stat-num">${playerCount}</span><span class="stat-secondary">(${aliveFoxes} ${t('players-alive')} 🦊)</span>`;

    if (userAddress) {
      const [dep, aUsdtBal, walletBal] = await Promise.all([
        zorrito.getUserDeposit(userAddress),
        aUsdtContract.balanceOf(ZORRITO_ADDRESS),
        usdt.balanceOf(userAddress),
      ]);
      currentUserDeposit = dep;

      let withdrawable = dep;
      if (poolSize > 0n && aUsdtBal < poolSize) {
        withdrawable = (dep * aUsdtBal) / poolSize;
      }

      const fish = dep / BigInt(1e6);
      elMyDep.innerHTML          = `<span class="stat-num">${formatUSDT(dep)}</span><span class="stat-unit"> <img src="assets/usdt-logo.png" class="stat-tok-logo" alt="USDT" /></span>`;
      elUserBal.textContent      = formatUSDT(dep);
      elWithdrawable.textContent = formatUSDT(withdrawable);
      if (elUsdtWalletBal) {
        elUsdtWalletBal.textContent = formatUSDT(walletBal);
      }

      // Refresh fox status and leaderboard in parallel, then update odds
      // (odds need effective tickets from both functions before computing)
      await Promise.all([refreshFoxStatus(), refreshLeaderboard()]);
    }

    const drawable = await zorrito.canDraw();
    btnDraw.disabled = !drawable;
    if (drawable) {
      btnDraw.textContent = t('draw-btn');
    } else if (currentPlayerCount === 0) {
      btnDraw.textContent = t('draw-waiting');
    } else if (currentYield === 0n) {
      btnDraw.textContent = t('draw-accumulating');
    } else {
      btnDraw.textContent = t('draw-not-ready');
    }

    updateYieldProgress(poolSize, yieldAvail);
    updateOdds(currentUserDeposit, poolSize, Number(playerCount));
  } catch (e) {
    console.warn("Stats refresh failed:", e.message);
  }
}

// ── Fox Status ─────────────────────────────────────────────────────────────────
async function refreshFoxStatus() {
  if (!zorrito || !userAddress) return;
  try {
    const s = await zorrito.getFoxStatus(userAddress);
    const alive             = s[0];
    const currentStreak     = Number(s[1]);
    const bestStreak        = Number(s[2]);
    const fishCount         = Number(s[3]);
    const nextFeedDeadline  = Number(s[4]);
    const secondsUntilDead  = Number(s[5]);
    const swRaw             = Number(s[6]); // streakWeight (10–50)
    const effTix            = Number(s[7]); // effectiveTickets

    // Store for updateOdds (effective tickets only count when fox is alive)
    currentUserEffTix  = alive ? effTix : 0;
    currentUserMult    = swRaw / 10;
    currentUserStreak  = currentStreak;

    // Fox status elements
    const elFoxStatus  = document.getElementById("fox-status-text");
    const elFoxStreak  = document.getElementById("fox-streak");
    const elFoxBest    = document.getElementById("fox-best-streak");
    const elFoxFish    = document.getElementById("fox-fish-count");
    const elEffTix     = document.getElementById("fox-eff-tickets");
    const elStatStreak = document.getElementById("stat-mystreak");
    const elStatEffTix = document.getElementById("stat-myefftix");
    const btnFeed      = document.getElementById("btn-feed");

    // Update fox image + floating animation for cofre/ghost states
    const elFoxImg = document.getElementById("fox-image");
    if (elFoxImg) {
      if (fishCount === 0) {
        elFoxImg.src = "assets/cofre.png";
        elFoxImg.classList.add("fox-float");
      } else if (alive) {
        elFoxImg.src = "assets/zorritovivo.png";
        elFoxImg.classList.remove("fox-float");
      } else {
        elFoxImg.src = "assets/zorromuerto.png";
        elFoxImg.classList.add("fox-float");
      }
    }

    // Detect state transitions for popups
    const isFirstLoad = (_prevFoxAlive === null);
    if (!isFirstLoad && _prevFoxAlive === true && !alive && fishCount > 0) {
      // Fox just died
      if (typeof showPopup === "function") {
        showPopup(
          '<img src="assets/zorromuerto.png" style="width:90px;height:90px;object-fit:contain;" />',
          t('popup-dead-title'),
          t('popup-dead-body')
        );
      }
    }
    _prevFoxAlive = alive || (fishCount === 0 ? null : false);

    if (!elFoxStatus) return;
    elFoxFish.textContent   = `🐟 ${fishCount} fish`;
    elFoxStreak.textContent = alive ? `🔥 Streak: ${currentStreak} day${currentStreak !== 1 ? "s" : ""}` : "—";
    elFoxBest.textContent   = bestStreak > 0 ? `🏆 Best: ${bestStreak} day${bestStreak !== 1 ? "s" : ""}` : "";

    // Pool Stats card — my streak + my effective tickets
    if (elStatStreak) {
      elStatStreak.textContent = alive && currentStreak > 0
        ? `🔥 ${currentStreak} day${currentStreak !== 1 ? "s" : ""}`
        : currentStreak > 0 ? `💀 ${currentStreak}` : "—";
    }
    if (elStatEffTix) {
      const mult = (swRaw / 10).toFixed(1);
      const dispEffTix = Math.round(effTix / 10);
      elStatEffTix.textContent = alive && effTix > 0
        ? `${dispEffTix} (${mult}×)`
        : effTix > 0 ? `0 (fox dead)` : "—";
    }
    if (elEffTix) {
      const mult = (swRaw / 10).toFixed(1);
      const dispEffTix = Math.round(effTix / 10);
      elEffTix.textContent = alive
        ? `🎟 ${dispEffTix} tickets in draw · ${mult}× boost`
        : "";
      elEffTix.style.color = alive ? "var(--orange)" : "var(--muted)";
    }

    if (alive) {
      elFoxStatus.textContent = t('fox-alive-status');
      elFoxStatus.style.color = "var(--green)";
      // Show countdown until fox dies
      startFoxDeadCountdown(nextFeedDeadline);
      updateStreakWindowHint(secondsUntilDead);
      btnFeed.textContent = secondsUntilDead < 6 * 3600
        ? t('feed-now-urgent')
        : t('feed-fish-btn');
      btnFeed.style.background = secondsUntilDead < 6 * 3600 ? "var(--red)" : "var(--orange)";
      btnFeed.style.color = "#ffffff";
      btnFeed.disabled = false;
      updateTweetBtn(currentStreak, fishCount);
    } else if (fishCount === 0) {
      const hint = document.getElementById("streak-window-hint");
      if (hint) hint.textContent = "";
      elFoxStatus.textContent = t('no-fox-yet');
      elFoxStatus.style.color = "var(--muted)";
      btnFeed.textContent  = t('adopt-fox-btn');
      btnFeed.style.background = "var(--orange)";
      btnFeed.style.color = "#ffffff";
      btnFeed.disabled     = false;
      btnFeed.dataset.adopt = "true";
      stopFoxDeadCountdown();
      hideFoxBubble();
    } else {
      const hint = document.getElementById("streak-window-hint");
      if (hint) hint.textContent = "";
      elFoxStatus.textContent = t('fox-dead-status');
      elFoxStatus.style.color = "var(--red)";
      btnFeed.textContent  = t('revive-fox-btn');
      btnFeed.style.background = "var(--orange)";
      btnFeed.style.color = "#ffffff";
      btnFeed.disabled     = false;
      stopFoxDeadCountdown();
      hideFoxBubble();
      document.getElementById("fox-dead-timer").textContent = "";
    }
  } catch(e) {
    console.warn("Fox status failed:", e.message);
  }
}

function updateStreakWindowHint(diff) {
  const hint = document.getElementById("streak-window-hint");
  if (!hint) return;
  // Streak window = last 4 hours before deadline
  // Feed in this window to reliably advance streak by +1
  const WINDOW_SECS = 4 * 3600;
  if (diff <= 0) {
    hint.textContent = "";
    return;
  }
  const nextStreak = currentUserStreak + 1;
  if (diff > WINDOW_SECS) {
    const secsToWindow = diff - WINDOW_SECS;
    const h = Math.floor(secsToWindow / 3600);
    const m = Math.floor((secsToWindow % 3600) / 60);
    const timeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
    hint.innerHTML = t('streak-hint-wait').replace('{time}', timeStr);
    hint.style.color = "var(--muted)";
  } else {
    hint.innerHTML = t('streak-hint-now').replace('{n}', nextStreak);
    hint.style.color = "var(--orange)";
  }
}

function startFoxDeadCountdown(deadline) {
  stopFoxDeadCountdown();
  const el = document.getElementById("fox-dead-timer");
  if (!el) return;
  let lastBubbleKey = null; // track which bubble is shown to avoid re-setting every tick

  foxDeadInterval = setInterval(() => {
    const diff = deadline - Math.floor(Date.now() / 1000);
    updateStreakWindowHint(diff);
    if (diff <= 0) {
      el.textContent = t('fox-dies-warning');
      el.style.color = "var(--red)";
      el.style.fontWeight = "800";
      // Show desperate bubble (permanent)
      if (lastBubbleKey !== 'bubble-1h') {
        lastBubbleKey = 'bubble-1h';
        showFoxBubble(t('bubble-1h'), { permanent: true, urgent: true });
      }
    } else {
      const h = Math.floor(diff / 3600);
      const m = Math.floor((diff % 3600) / 60);
      const s = String(diff % 60).padStart(2, "0");
      el.textContent = `${h}h ${m}m ${s}s ${t('fox-dies-in')}`;
      el.style.color = "var(--red)";
      el.style.fontWeight = "800";

      // Progressive bubble messages
      let bubbleKey = null;
      let urgent = false;
      if (diff <= 1 * 3600) {
        bubbleKey = 'bubble-1h';
        urgent = true;
      } else if (diff <= 3 * 3600) {
        bubbleKey = 'bubble-3h';
        urgent = true;
      } else if (diff <= 4 * 3600) {
        bubbleKey = 'bubble-4h';
        urgent = false;
      } else if (diff <= 8 * 3600) {
        bubbleKey = 'bubble-8h';
        urgent = false;
      } else if (diff <= 12 * 3600) {
        bubbleKey = 'bubble-12h';
        urgent = false;
      }

      if (bubbleKey && bubbleKey !== lastBubbleKey) {
        lastBubbleKey = bubbleKey;
        const isPermanent = diff <= 3 * 3600;
        showFoxBubble(t(bubbleKey), { permanent: isPermanent, urgent });
      }
    }
  }, 1000);
}

function stopFoxDeadCountdown() {
  if (foxDeadInterval) { clearInterval(foxDeadInterval); foxDeadInterval = null; }
}

// ── Fox Speech Bubble ─────────────────────────────────────────────────────────
function showFoxBubble(text, { permanent = false, urgent = false, duration = 3000 } = {}) {
  const el = document.getElementById("fox-bubble");
  if (!el) return;
  if (foxBubbleTimeout) { clearTimeout(foxBubbleTimeout); foxBubbleTimeout = null; }
  el.textContent = text;
  el.classList.toggle("urgent", urgent);
  el.classList.add("visible");
  foxBubblePermanent = permanent;
  if (!permanent) {
    foxBubbleTimeout = setTimeout(() => {
      el.classList.remove("visible");
      foxBubblePermanent = false;
    }, duration);
  }
}

function hideFoxBubble() {
  const el = document.getElementById("fox-bubble");
  if (!el) return;
  if (foxBubbleTimeout) { clearTimeout(foxBubbleTimeout); foxBubbleTimeout = null; }
  el.classList.remove("visible", "urgent");
  foxBubblePermanent = false;
}

// ── Leaderboard ────────────────────────────────────────────────────────────────
async function refreshLeaderboard() {
  if (!zorrito) return;
  const el = document.getElementById("leaderboard-list");
  if (!el) return;
  try {
    const data = await zorrito.getLeaderboardData();
    const addrs      = data[0];
    const streaks    = data[1].map(Number);
    const bestStreaks = data[2].map(Number);
    const alives     = data[3];
    const fish       = data[4].map(Number);
    const effTixArr  = data[5].map(Number);

    // Total effective tickets across all alive foxes (used by updateOdds)
    currentTotalEffTix = effTixArr.reduce((sum, t, i) => sum + (alives[i] ? t : 0), 0);

    if (addrs.length === 0) {
      el.innerHTML = `<p class="empty-state">${ZORRITO_T[localStorage.getItem('zorrito-lang')||'en']['no-players-yet']||'No players yet'}</p>`;
      return;
    }

    // Sort by current streak desc, then by best streak, then by fish
    const rows = addrs.map((addr, i) => ({
      addr, streak: streaks[i], best: bestStreaks[i],
      alive: alives[i], fish: fish[i], eff: effTixArr[i],
    }));
    // Sort by effective tickets desc (already incorporates streak + fish)
    rows.sort((a, b) => b.eff - a.eff || b.streak - a.streak || b.fish - a.fish);

    const top = rows.slice(0, 10);

    el.innerHTML = top.map((r, i) => {
      const medal   = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
      const isMe    = userAddress && r.addr.toLowerCase() === userAddress.toLowerCase();
      const fox     = r.alive ? "🦊" : "💀";
      const multRaw = r.streak >= 365 ? 50 : r.streak >= 180 ? 40 : r.streak >= 90 ? 30 : r.streak >= 30 ? 20 : r.streak >= 7 ? 15 : 10;
      const multLabel = (r.alive && multRaw > 10) ? `<span style="color:var(--orange);font-size:0.7rem;font-weight:700;">${(multRaw/10).toFixed(1)}×</span>` : "";
      return `
        <div class="lb-row ${isMe ? "lb-me" : ""}">
          <span class="lb-rank">${medal}</span>
          <span class="lb-fox">${fox}</span>
          <span class="lb-addr">${shortAddr(r.addr)}${isMe ? " (you)" : ""}</span>
          <span class="lb-streak">${r.streak > 0 ? "🔥 " + r.streak : "—"} ${multLabel}</span>
          <span class="lb-fish">${r.eff > 0 ? Math.round(r.eff / 10) + " 🎟️" : r.fish + " 🐟"}</span>
        </div>`;
    }).join("");
  } catch(e) {
    console.warn("Leaderboard failed:", e.message);
  }
}

// ── Tweet Streak Button ────────────────────────────────────────────────────────
function updateTweetBtn(streak, fish) {
  const btn = document.getElementById("btn-tweet");
  if (!btn) return;
  if (!streak || streak < 1) {
    btn.style.display = "none";
    return;
  }
  const s = streak !== 1 ? "s" : "";
  const tweetText = t('tweet-text')
    .replace(/{streak}/g, streak)
    .replace(/{fish}/g, fish)
    .replace(/{s}/g, s);
  btn.href = `https://twitter.com/intent/tweet?text=${encodeURIComponent(tweetText)}`;
  btn.style.display = "flex";
}

// ── Winning Odds ───────────────────────────────────────────────────────────────
function updateOdds(userDeposit, totalPool, playerCount) {
  const elPct    = document.querySelector(".odds-pct");
  const elDetail = document.getElementById("odds-detail");
  const elStat   = document.getElementById("stat-odds");
  if (!elPct || !elDetail) return;

  // Remove existing bar if any
  const existingBar = elStat.querySelector(".odds-bar-wrap");
  if (existingBar) existingBar.remove();

  if (!userAddress || userDeposit === 0n || totalPool === 0n) {
    elPct.textContent    = "—";
    elDetail.textContent = playerCount === 0
      ? (ZORRITO_T[localStorage.getItem('zorrito-lang')||'en']['be-first-deposit']||'Be the first to deposit!')
      : `${playerCount} player${playerCount !== 1 ? "s" : ""} in the pool · connect & deposit to see your odds`;
    elPct.style.color = "var(--muted)";
    return;
  }

  // Use effective tickets when available (accurate) — fallback to deposit ratio
  const useEffTix = currentTotalEffTix > 0 && currentUserEffTix >= 0;
  let pct;
  if (useEffTix) {
    pct = currentTotalEffTix === 0 ? 0 : (currentUserEffTix / currentTotalEffTix) * 100;
  } else {
    const userUSDT  = parseFloat(ethers.formatUnits(userDeposit, 6));
    const totalUSDT = parseFloat(ethers.formatUnits(totalPool,   6));
    pct = totalUSDT === 0 ? 0 : (userUSDT / totalUSDT) * 100;
  }

  // Format percentage
  let pctStr;
  if (pct >= 99.9)      pctStr = "100%";
  else if (pct >= 10)   pctStr = pct.toFixed(1) + "%";
  else if (pct >= 1)    pctStr = pct.toFixed(2) + "%";
  else if (pct >= 0.01) pctStr = pct.toFixed(3) + "%";
  else                  pctStr = currentUserEffTix === 0 && useEffTix ? "0%" : "<0.01%";

  // Color based on odds
  const color = pct >= 50 ? "var(--green)" : pct >= 10 ? "var(--gold)" : "var(--text)";
  elPct.textContent = pctStr;
  elPct.style.color = color;

  // Context message — 1 draw per year
  const winChance = pct / 100;
  let context = "";
  if (currentUserEffTix === 0 && useEffTix) {
    context = "fox dead — revive it to enter the draw";
    elPct.style.color = "var(--red)";
  } else if (winChance >= 0.5) {
    context = `>${Math.round(winChance * 100)}% chance to win this Jan 1st draw`;
  } else if (winChance > 0) {
    const yearsPerWin = Math.round(1 / winChance);
    context = `~1 win every ${yearsPerWin} year${yearsPerWin !== 1 ? "s" : ""} on average`;
  } else {
    context = "deposit to enter the draw";
  }

  // Detail line — show effective tickets when available, else raw USDT
  if (useEffTix) {
    const multStr = currentUserMult !== 1.0 ? ` · ${currentUserMult.toFixed(1)}× streak bonus` : "";
    const dispUser  = Math.round(currentUserEffTix  / 10);
    const dispTotal = Math.round(currentTotalEffTix / 10);
    elDetail.textContent =
      `${dispUser} of ${dispTotal} effective tickets`
      + multStr
      + ` · ${playerCount} player${playerCount !== 1 ? "s" : ""} · ${context}`;
  } else {
    elDetail.textContent =
      `Your ${formatUSDT(userDeposit)} USDT out of ${formatUSDT(totalPool)} USDT pool · `
      + `${playerCount} player${playerCount !== 1 ? "s" : ""} · ${context}`;
  }

  // Progress bar
  const barWrap  = document.createElement("div");
  barWrap.className = "odds-bar-wrap";
  const bar = document.createElement("div");
  bar.className = "odds-bar";
  bar.style.width = Math.min(pct, 100) + "%";
  bar.style.background = color;
  barWrap.appendChild(bar);
  elStat.appendChild(barWrap);
}

// ── Live APY from Aave V3 ─────────────────────────────────────────────────────
const APY_FALLBACK = 0.01; // fallback if RPC call fails

async function fetchLiveAPY() {
  try {
    // Use a public Celo RPC — no wallet needed
    const rpc = new ethers.JsonRpcProvider("https://forno.celo.org");
    const pool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI_RESERVE, rpc);
    const data = await pool.getReserveData(USDT_ADDRESS);
    // currentLiquidityRate is in RAY = 1e27
    const RAY = 10n ** 27n;
    const liquidityRateRay = BigInt(data[2]); // index 2 = currentLiquidityRate
    // APR = rate / RAY
    // APY ≈ (1 + APR/SECONDS_PER_YEAR)^SECONDS_PER_YEAR - 1
    const SECONDS_PER_YEAR = 31_536_000;
    const apr = Number(liquidityRateRay) / Number(RAY);
    const apy = (Math.pow(1 + apr / SECONDS_PER_YEAR, SECONDS_PER_YEAR) - 1);
    currentAPY = apy;
    // Update all APY displays in the UI
    document.querySelectorAll(".live-apy").forEach(el => {
      el.textContent = (apy * 100).toFixed(2) + "% APY";
      el.title = `Live from Aave V3 on Celo · updated ${new Date().toLocaleTimeString()}`;
    });
    console.log(`Live Aave APY: ${(apy * 100).toFixed(4)}%`);
  } catch (e) {
    console.warn("Could not fetch live APY:", e.message);
    currentAPY = APY_FALLBACK;
  }
}

// ── Aave Supply Cap Check ─────────────────────────────────────────────────────
// Fetches the USDT supply cap on Aave V3 Celo and shows a warning if headroom is low
async function checkAaveSupplyCap() {
  const warnEl = document.getElementById('deposit-warn-cap');
  if (!warnEl) return;
  try {
    const rpc  = new ethers.JsonRpcProvider("https://forno.celo.org");
    const pool = new ethers.Contract(AAVE_POOL_ADDRESS, AAVE_POOL_ABI_RESERVE, rpc);
    const data = await pool.getReserveData(USDT_ADDRESS);

    // Supply cap is encoded in the configuration bitfield at bits 116–151
    const config     = BigInt(data[0]);
    const supplyCap  = Number((config >> 116n) & ((1n << 36n) - 1n)); // whole tokens
    if (supplyCap === 0) return; // no cap set

    // Get aToken total supply (raw, 6 decimals for USDT)
    const aTokenAddr = data[8];
    const aToken     = new ethers.Contract(
      aTokenAddr,
      ["function totalSupply() view returns (uint256)"],
      rpc
    );
    const totalSupply = await aToken.totalSupply();
    const capRaw      = BigInt(supplyCap) * 1_000_000n;
    const headroom    = Number(capRaw - totalSupply) / 1e6;

    const lang = localStorage.getItem('zorrito-lang') || 'es';
    const T    = (window.ZORRITO_T || {})[lang] || {};

    if (headroom <= 0) {
      warnEl.style.display = '';
      warnEl.textContent   = T['deposit-warn-cap-full'] || '🚨 Aave supply cap FULL. Deposits are blocked.';
    } else if (headroom < 100_000) {
      const n = headroom < 1000
        ? headroom.toFixed(0) + ' USDT'
        : (headroom / 1000).toFixed(1) + 'k USDT';
      warnEl.style.display = '';
      warnEl.textContent   = (T['deposit-warn-cap'] || '⚠️ Aave cap almost full — only {n} available.').replace('{n}', n);
    } else {
      // Plenty of headroom — no warning needed
      warnEl.style.display = 'none';
    }
    console.log(`Aave USDT supply cap headroom: ${headroom.toFixed(0)} USDT`);
  } catch (e) {
    console.warn("Could not check Aave supply cap:", e.message);
  }
}

// ── Yield Progress Info ────────────────────────────────────────────────────────
const APY_FALLBACK_DISPLAY = 0.01;

function updateYieldProgress(poolSize, yieldAvail) {
  const el = document.getElementById("yield-progress");
  if (!el) return;

  const poolUSDT = parseFloat(ethers.formatUnits(poolSize, 6));
  const apy = currentAPY ?? APY_FALLBACK_DISPLAY;

  if (poolUSDT === 0) {
    el.innerHTML = `<span class="yp-hint">${ZORRITO_T[localStorage.getItem('zorrito-lang')||'en']['yp-hint-start']||'Deposit USDT to start the lottery. Annual draw every Jan 1st · no loss ever.'}</span>`;
    return;
  }

  const currentYieldUSDT  = parseFloat(ethers.formatUnits(yieldAvail, 6));

  if (currentYieldUSDT >= 0.000001) {
    el.innerHTML = `
      <span class="yp-ready">✅ Yield accrued: ${formatYield(yieldAvail)} USDT</span>
      <span class="yp-hint">Annual draw triggers when the timer hits zero (Jan 1st).</span>`;
    return;
  }

  let hintHtml = "";

  // Annual yield estimate (90% to winner after platform fee)
  const annualYield      = poolUSDT * apy * 0.9;
  const annualYieldMicro = annualYield * 1_000_000;

  if (annualYieldMicro >= 1) {
    // Pool large enough — estimate time to first 1-wei yield
    const daysFor1Wei = 365 / annualYieldMicro;
    const timeStr = daysFor1Wei < 1/24
      ? `~${Math.ceil(daysFor1Wei * 24 * 60)} min`
      : daysFor1Wei < 1
        ? `~${(daysFor1Wei * 24).toFixed(1)}h`
        : `~${daysFor1Wei.toFixed(1)} days`;

    hintHtml = `
      <span class="yp-hint">⏳ Est. annual prize: <b>$${annualYield < 0.000001 ? "<0.000001" : annualYield.toFixed(6)}</b></span>
      <span class="yp-hint">First yield accumulates in: <b>${timeStr}</b></span>`;
  } else {
    const neededUSDT = Math.ceil((1e-6 / apy) * 10) / 10;
    const missing    = Math.max(0, neededUSDT - poolUSDT);
    hintHtml = `
      <span class="yp-hint">Pool too small to generate annual yield yet.</span>
      <span class="yp-cta">➕ Deposit <b>${missing.toFixed(1)} more USDT</b> to activate the annual draw!</span>`;
  }

  // "How much to reach a meaningful prize" ladder
  const prizeTargets = [0.01, 0.10, 1.00];
  const nextTarget   = prizeTargets.find(t => annualYield < t);
  if (nextTarget) {
    const neededPool  = Math.ceil(nextTarget / (apy * 0.9)); // account for 10% platform fee
    const missingPool = Math.max(0, neededPool - Math.round(poolUSDT));
    if (missingPool > 0 && missingPool < 200_000) {
      hintHtml += `<span class="yp-cta">🎯 +${missingPool.toLocaleString()} USDT in pool → annual prize hits <b>$${nextTarget.toFixed(2)}</b></span>`;
    }
  }

  el.innerHTML = hintHtml;
}

function resetStats() {
  [elPool, elYield, elPlayers, elMyDep].forEach(el => el.textContent = "—");
  elUserBal.textContent      = "0.00";
  elWithdrawable.textContent = "—";
  if (elUsdtWalletBal) elUsdtWalletBal.textContent = "—";
  currentPlayerCount = 0;
  currentYield = 0n;
  currentUserDeposit = 0n;
  currentTotalDeposited = 0n;
  currentUserEffTix  = 0;
  currentTotalEffTix = 0;
  currentUserMult    = 1.0;
  btnDraw.disabled = true;
  btnDraw.textContent = t('draw-not-ready');
  updateOdds(0n, 0n, 0);
  stopFoxDeadCountdown();
  _prevFoxAlive = null;
  const foxImg = document.getElementById("fox-image");
  if (foxImg) foxImg.src = "assets/cofre.png";
  // Reset fox UI
  const foxStatusEl = document.getElementById("fox-status-text");
  if (foxStatusEl) {
    document.getElementById("fox-status-text").textContent  = t('fox-connect-wallet');
    document.getElementById("fox-status-text").style.color  = "var(--muted)";
    document.getElementById("fox-streak").textContent  = "—";
    document.getElementById("fox-best-streak").textContent = "";
    document.getElementById("fox-fish-count").textContent  = "🐟 0 fish";
    document.getElementById("fox-dead-timer").textContent  = "";
    const ss = document.getElementById("stat-mystreak");  if (ss) ss.textContent = "—";
    const se = document.getElementById("stat-myefftix");  if (se) se.textContent = "—";
    // Reset feed button
    const btnFeedReset = document.getElementById("btn-feed");
    if (btnFeedReset) {
      btnFeedReset.textContent = t('fox-connect-wallet-btn');
      btnFeedReset.disabled = false;
      btnFeedReset.style.background = "var(--orange)";
      btnFeedReset.style.color = "#ffffff";
      delete btnFeedReset.dataset.adopt;
    }
  }
}

// ── Countdown ──────────────────────────────────────────────────────────────────
function startCountdown() {
  if (countdownInterval) clearInterval(countdownInterval);
  countdownInterval = setInterval(() => {
    if (currentPlayerCount === 0) {
      elCountdown.textContent = "--:--:--";
      return;
    }
    const diff = nextDrawTimestamp - Math.floor(Date.now() / 1000);
    if (diff <= 0) {
      elCountdown.textContent = currentYield > 0n ? "Ready! 🎲" : "00d 00:00:00";
    } else {
      const d = Math.floor(diff / 86400);
      const h = String(Math.floor((diff % 86400) / 3600)).padStart(2, "0");
      const m = String(Math.floor((diff % 3600) / 60)).padStart(2, "0");
      const s = String(diff % 60).padStart(2, "0");
      elCountdown.textContent = `${d}d ${h}:${m}:${s}`;
    }
  }, 1000);
}

// ── Recent Winners ─────────────────────────────────────────────────────────────
async function loadRecentWinners() {
  if (!zorrito || !provider) return;
  try {
    const filter = zorrito.filters.WinnerPicked();
    const block  = await provider.getBlockNumber();
    const events = await zorrito.queryFilter(filter, Math.max(0, block - 5000), block);
    const recent = events.slice(-5).reverse();
    if (recent.length === 0) {
      elWinners.innerHTML = `<p class="empty-state">${ZORRITO_T[localStorage.getItem('zorrito-lang')||'en']['no-winners-yet']||'No winners yet — be the first!'}</p>`;
      return;
    }
    elWinners.innerHTML = "";
    for (const e of recent) {
      prependWinner(e.args.winner, ethers.formatUnits(e.args.prize, 6));
    }
  } catch (e) {
    console.warn("Could not load winners:", e.message);
  }
}

// ── Check if connected user won a recent draw ──────────────────────────────────
async function checkIfUserWon() {
  if (!zorrito || !provider || !userAddress) return;
  try {
    const filter = zorrito.filters.WinnerPicked(userAddress);
    const block  = await provider.getBlockNumber();
    const events = await zorrito.queryFilter(filter, Math.max(0, block - 50000), block);
    if (events.length === 0) return;

    // Most recent win
    const latest = events[events.length - 1];
    const prize  = ethers.formatUnits(latest.args.prize, 6);
    const block_ = await provider.getBlock(latest.blockNumber);
    const when   = new Date(Number(block_.timestamp) * 1000).toLocaleString();

    // Show a persistent banner
    showWinBanner(prize, when);
  } catch (e) {
    console.warn("checkIfUserWon failed:", e.message);
  }
}

function showWinBanner(prize, when) {
  let banner = document.getElementById("win-banner");
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "win-banner";
    banner.style.cssText = `
      position:fixed; top:16px; left:50%; transform:translateX(-50%);
      background:#fbcc5c; color:#0d1117; padding:14px 24px; border-radius:12px;
      font-weight:700; font-size:1rem; z-index:1000; text-align:center;
      box-shadow:0 4px 24px rgba(251,204,92,0.4); cursor:pointer; max-width:380px;
    `;
    banner.onclick = () => banner.remove();
    document.body.appendChild(banner);
  }
  banner.innerHTML = `You won ${parseFloat(prize).toFixed(4)} USDT! It's already in your wallet.<br><small style="font-weight:400;font-size:0.8rem">${when} · click to dismiss</small>`;
}

function prependWinner(addr, prize) {
  const emptyState = elWinners.querySelector(".empty-state");
  if (emptyState) emptyState.remove();
  const el = document.createElement("div");
  el.className = "winner-item";
  el.innerHTML = `
    <span class="winner-addr">${shortAddr(addr)}</span>
    <span class="winner-prize">+${parseFloat(prize).toFixed(4)} USDT</span>
  `;
  elWinners.insertBefore(el, elWinners.firstChild);
  while (elWinners.children.length > 8) elWinners.removeChild(elWinners.lastChild);
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function formatUSDT(raw) {
  return parseFloat(ethers.formatUnits(raw, 6)).toLocaleString("en-US", {
    minimumFractionDigits: 2, maximumFractionDigits: 4,
  });
}

// Pool and player counts: no decimals, cleaner display
function formatUSDTWhole(raw) {
  return Math.floor(parseFloat(ethers.formatUnits(raw, 6))).toLocaleString("en-US");
}

// For yield: always show 6 decimals so tiny amounts are visible
function formatYield(raw) {
  const val = parseFloat(ethers.formatUnits(raw, 6));
  if (val === 0) return "0.000000";
  if (val < 0.000001) return val.toExponential(2);
  return val.toLocaleString("en-US", { minimumFractionDigits: 6, maximumFractionDigits: 6 });
}

function shortAddr(addr) {
  return addr.slice(0, 6) + "..." + addr.slice(-4);
}

let toastTimeout;
function toast(msg, type = "") {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className   = "show " + type;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { el.className = ""; }, 3500);
}

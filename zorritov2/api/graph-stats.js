/**
 * api/graph-stats.js  (Zorrito V1 + V2 unified)
 *
 * Reads on-chain state from BOTH the V1 contract (0x135dc8DC4bEd4e619B97b07bA16bCE348CAeFF62)
 * and the V2 contract, then sums everything so stats.html shows a continuous
 * history across both deployments. Cached in Vercel KV (TTL 5min).
 *
 * GET /api/graph-stats
 */

const { ethers } = require("ethers");

let kv = null;
try { kv = require("@vercel/kv").kv; } catch { /* KV optional */ }

const RPC          = (process.env.CELO_RPC_URL || process.env.CELO_RPC || "https://forno.celo.org").trim();
const V2_ADDR      = (process.env.V2_CONTRACT_ADDRESS || process.env.ZORRITO_V2_ADDR || "0x8f4E627d4C4Af5dfE11908Bd8B929588d9Ee58c9").trim();
const V1_ADDR      = "0x135dc8DC4bEd4e619B97b07bA16bCE348CAeFF62";
const USDT_ADDR    = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const AUSDT_ADDR   = "0xDeE98402A302e4D707fB9bf2bac66fAEEc31e8Df";
const AAVE_POOL    = "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402";

// 1.5M blocks ≈ 90 days on Celo (5s/block). Big enough to capture V1 historical activity.
const LOOKBACK_BLOCKS = parseInt(process.env.STATS_LOOKBACK_BLOCKS || "1500000", 10);
const CACHE_KEY       = "zorritov2:graph-stats:v5-v2only";
const CACHE_TTL_SEC   = 300;

// ── ABIs ─────────────────────────────────────────────────────────────────────
const V2_ABI = [
  "function totalPrincipal() view returns (uint256)",
  "function depositorCount() view returns (uint256)",
  "function currentPrizePool() view returns (uint256)",
  "function totalSavings() view returns (uint256)",
  "function totalEffectiveChances() view returns (uint256)",
  "function depositorList(uint256) view returns (address)",
  "function deposits(address) view returns (uint256)",
  "function streakDay(address) view returns (uint8)",
  "function selfVerified(address) view returns (bool)",
  "event Deposited(address indexed user, address indexed payer, uint256 amount, uint8 streakDay)",
  "event Withdrawn(address indexed user, uint256 amount)",
  "event RaffleExecuted(address indexed winner, uint256 prize, uint256 fee)",
  "event SelfVerificationSet(address indexed user)",
];

const V1_ABI = [
  "function totalDeposited() view returns (uint256)",
  "function depositorCount() view returns (uint256)",
  "function depositorList(uint256) view returns (address)",
  "event Deposited(address indexed user, uint256 amount, uint256 fish)",
  "event Withdrawn(address indexed user, uint256 amount)",
  "event FoxFed(address indexed user, uint32 newStreak, bool wasRevived)",
  "event WinnerPicked(address indexed winner, uint256 prize, uint256 platformFee, uint256 timestamp)",
];

const AAVE_ABI  = ["function getReserveData(address asset) view returns (uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128)"];
const AUSDT_ABI = ["function balanceOf(address) view returns (uint256)"];

const toUSDT = (raw) => Number(ethers.formatUnits(raw, 6));
const bucketDay = (ts) => {
  const d = new Date(ts * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

// ── Fetch per-contract data ──────────────────────────────────────────────────
async function fetchContract({ provider, addr, abi, version, fromBlock, blockToTs }) {
  const c     = new ethers.Contract(addr, abi, provider);
  const aUsdt = new ethers.Contract(AUSDT_ADDR, AUSDT_ABI, provider);

  // State
  let totalPrincipal = 0n, depositorCount = 0n, aUsdtBal = 0n;
  try {
    if (version === 2) {
      [totalPrincipal, depositorCount, aUsdtBal] = await Promise.all([
        c.totalPrincipal().catch(() => 0n),
        c.depositorCount().catch(() => 0n),
        aUsdt.balanceOf(addr),
      ]);
    } else {
      [totalPrincipal, depositorCount, aUsdtBal] = await Promise.all([
        c.totalDeposited().catch(() => 0n),
        c.depositorCount().catch(() => 0n),
        aUsdt.balanceOf(addr),
      ]);
    }
  } catch { /* fall back to zero */ }

  // Events — names differ between V1 and V2
  // V2 (new): there is NO separate "Saved" event. Every save is a deposit,
  // so saveEvents reuses the deposit list (each Deposited == one streak action).
  const evNames = version === 2
    ? { deposit: "Deposited", withdraw: "Withdrawn", save: null, raffle: "RaffleExecuted" }
    : { deposit: "Deposited", withdraw: "Withdrawn", save: "FoxFed", raffle: "WinnerPicked" };

  // forno limits queryFilter ranges (~5k–100k blocks per request depending on load).
  // Chunk the lookback into 100k-block windows and merge.
  async function chunkedQuery(filter) {
    const CHUNK = 100_000;
    const out   = [];
    let cur = fromBlock;
    let toBlock = "latest";
    // Resolve "latest" to a number for chunking — use latestBlock we already have via closure if available.
    if (typeof toBlock === "string") {
      try {
        const latest = await c.runner.provider.getBlockNumber();
        toBlock = latest;
      } catch { toBlock = cur + CHUNK; }
    }
    while (cur <= toBlock) {
      const end = Math.min(cur + CHUNK - 1, toBlock);
      try {
        const evs = await c.queryFilter(filter, cur, end);
        out.push(...evs);
      } catch (e) {
        // Skip the failed window — better partial data than total failure.
        console.warn(`v${version} chunk ${cur}-${end} failed:`, e.message);
      }
      cur = end + 1;
    }
    return out;
  }

  let depositEvents = [], withdrawEvents = [], saveEvents = [], winnerEvents = [];
  try {
    [depositEvents, withdrawEvents, winnerEvents] = await Promise.all([
      chunkedQuery(c.filters[evNames.deposit]()),
      chunkedQuery(c.filters[evNames.withdraw]()),
      chunkedQuery(c.filters[evNames.raffle]()),
    ]);
    // V2 (new) has no separate Saved event — saves and deposits are the same action.
    // Leaving saveEvents=[] keeps totalTxCount accurate (no double-counting).
    saveEvents = evNames.save ? await chunkedQuery(c.filters[evNames.save]()) : [];
  } catch (e) { console.warn(`v${version} queryFilter failed:`, e.message); }

  // Normalize winner event shape (V1 has 4 args + on-chain timestamp; V2 uses block ts)
  const winners = winnerEvents.map(ev => {
    if (version === 2) {
      return {
        v: 2,
        winner: ev.args?.[0],
        prize:  toUSDT(ev.args?.[1] ?? 0n),
        fee:    toUSDT(ev.args?.[2] ?? 0n),
        timestamp: blockToTs(ev.blockNumber),
        txHash: ev.transactionHash,
      };
    }
    return {
      v: 1,
      winner: ev.args?.[0],
      prize:  toUSDT(ev.args?.[1] ?? 0n),
      fee:    toUSDT(ev.args?.[2] ?? 0n),
      timestamp: Number(ev.args?.[3] ?? blockToTs(ev.blockNumber)),
      txHash: ev.transactionHash,
    };
  });

  return {
    state: {
      totalPrincipal,
      depositorCount: Number(depositorCount),
      aUsdtBal,
      currentPrizePool: aUsdtBal > totalPrincipal ? aUsdtBal - totalPrincipal : 0n,
    },
    depositEvents, withdrawEvents, saveEvents, winners,
  };
}

async function buildStats() {
  const provider = new ethers.JsonRpcProvider(
    RPC, { chainId: 42220, name: "celo" }, { staticNetwork: true }
  );
  const aavePool = new ethers.Contract(AAVE_POOL, AAVE_ABI, provider);

  const latestBlock = await provider.getBlock("latest");
  const fromBlock   = Math.max(0, latestBlock.number - LOOKBACK_BLOCKS);

  // Build a single block→ts interpolator (shared between V1 and V2 fetches)
  let blockToTs = () => latestBlock.timestamp;
  try {
    const startBlock = await provider.getBlock(fromBlock);
    const avg = (latestBlock.timestamp - startBlock.timestamp) /
                Math.max(1, latestBlock.number - fromBlock);
    blockToTs = (bn) => Math.round(startBlock.timestamp + (bn - fromBlock) * avg);
  } catch { /* fallback */ }

  // On-chain stats are V2-only (V1 was deprecated; off-chain analytics still unified via PostHog)
  const [v2, aaveData] = await Promise.all([
    fetchContract({ provider, addr: V2_ADDR, abi: V2_ABI, version: 2, fromBlock, blockToTs }),
    aavePool.getReserveData(USDT_ADDR),
  ]);

  // ── State ─────────────────────────────────────────────────────────────────
  const totalPrincipal    = v2.state.totalPrincipal;
  const depositorCount    = v2.state.depositorCount;
  const aUsdtBal          = v2.state.aUsdtBal;
  const currentPrizePool  = v2.state.currentPrizePool;

  // ── V2-only state (streak distribution, Self verification — V1 has different mech) ──
  const v2Contract = new ethers.Contract(V2_ADDR, V2_ABI, provider);
  let v2TotalChances = 0n, v2TotalSavings = 0n;
  try {
    [v2TotalChances, v2TotalSavings] = await Promise.all([
      v2Contract.totalEffectiveChances().catch(() => 0n),
      v2Contract.totalSavings().catch(() => 0n),
    ]);
  } catch {}

  const streakBuckets = { 1:0, 2:0, 3:0, 4:0, 5:0, 6:0, 7:0 };
  let activeDepositors = 0;
  let selfVerifiedCount = 0;
  if (v2.state.depositorCount > 0) {
    const MAX = Math.min(v2.state.depositorCount, 500);
    const addrs = [];
    for (let i = 0; i < MAX; i++) {
      try { addrs.push(await v2Contract.depositorList(i)); } catch { break; }
    }
    const states = await Promise.all(addrs.map(async (a) => {
      const dep = await v2Contract.deposits(a).catch(() => 0n);
      const sd  = await v2Contract.streakDay(a).catch(() => 0);
      const sv  = await v2Contract.selfVerified(a).catch(() => false);
      return { dep, sd: Number(sd), sv };
    }));
    for (const s of states) {
      if (s.dep > 0n) {
        activeDepositors++;
        const day = s.sd >= 1 && s.sd <= 7 ? s.sd : 1;
        streakBuckets[day]++;
      }
      if (s.sv) selfVerifiedCount++;
    }
  }

  // V2-only events
  const allDeposits  = v2.depositEvents;
  const allWithdraws = v2.withdrawEvents;
  const allSaves     = v2.saveEvents;
  const allWinners   = [...v2.winners].sort((a, b) => b.timestamp - a.timestamp);

  // Time-series (last 30 days)
  const nowTs = Math.floor(Date.now() / 1000);
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const ts = nowTs - i * 86400;
    days.push({ date: bucketDay(ts), ts, txCount: 0, depositCount: 0, withdrawCount: 0, saveCount: 0, depositVolume: 0 });
  }
  const dayMap = Object.fromEntries(days.map(d => [d.date, d]));

  function bumpDay(ev, field, volRaw = null) {
    const t = blockToTs(ev.blockNumber);
    const key = bucketDay(t);
    const row = dayMap[key];
    if (!row) return;
    row[field]++; row.txCount++;
    if (volRaw !== null) row.depositVolume += toUSDT(volRaw);
  }
  // V2 NEW Deposited signature: (user, payer, amount, streakDay) — amount is args[2].
  const amtIdx = 2;
  for (const e of allDeposits)  bumpDay(e, "depositCount",  e.args?.[amtIdx] ?? 0n);
  for (const e of allWithdraws) bumpDay(e, "withdrawCount");
  for (const e of allSaves)     bumpDay(e, "saveCount");

  function periodAgg(seconds) {
    const cutoff = nowTs - seconds;
    let tx = 0, deps = 0, wds = 0, saves = 0, vol = 0;
    for (const e of allDeposits)  if (blockToTs(e.blockNumber) > cutoff) { tx++; deps++;  vol += toUSDT(e.args?.[amtIdx] ?? 0n); }
    for (const e of allWithdraws) if (blockToTs(e.blockNumber) > cutoff) { tx++; wds++; }
    for (const e of allSaves)     if (blockToTs(e.blockNumber) > cutoff) { tx++; saves++; }
    return { tx, deposits: deps, withdraws: wds, saves, depositVol: vol };
  }

  const totalDepositVol  = allDeposits.reduce((s, e) => s + toUSDT(e.args?.[amtIdx] ?? 0n), 0);
  const totalTxCount     = allDeposits.length + allWithdraws.length + allSaves.length;
  const uniqueDepositors = new Set(allDeposits.map(e => (e.args?.[0] || "").toLowerCase())).size;
  const totalPrizes      = allWinners.reduce((s, w) => s + w.prize, 0);
  const totalFees        = allWinners.reduce((s, w) => s + w.fee,   0);

  // APY from Aave
  let apy = 0;
  try {
    const RAY = 10n ** 27n;
    const apr = Number(BigInt(aaveData[2])) / Number(RAY);
    apy = Math.pow(1 + apr / 31_536_000, 31_536_000) - 1;
  } catch { /* leave 0 */ }

  return {
    ok: true,
    source: "on-chain (V2)",
    generated: new Date().toISOString(),
    contract: {
      address: V2_ADDR,
      totalPrincipal: toUSDT(totalPrincipal),
      currentPrizePool: toUSDT(currentPrizePool),
      totalSavings: toUSDT(v2TotalSavings),
      aUsdtBalance: toUSDT(aUsdtBal),
      depositorCount,
      totalEffectiveChances: v2TotalChances.toString(),
      apy,
    },
    allTime: {
      total: totalTxCount,
      deposit: allDeposits.length,
      withdraw: allWithdraws.length,
      save: allSaves.length,
      uniqueDepositors: Math.max(uniqueDepositors, depositorCount),
      totalDepositedUSDT: totalDepositVol,
      draws: allWinners.length,
      totalPrizes,
      totalFees,
    },
    periods: {
      h24: periodAgg(86400),
      d7:  periodAgg(7 * 86400),
      d30: periodAgg(30 * 86400),
    },
    users: {
      total: Math.max(uniqueDepositors, depositorCount),
      active: activeDepositors || v2.state.depositorCount,
      selfVerified: selfVerifiedCount,
    },
    lastDraw: allWinners[0] || null,
    winners: allWinners,
    streakDistribution: [1,2,3,4,5,6,7].map(d => ({
      day: d, label: `Day ${d}`, userCount: streakBuckets[d],
    })),
    timeSeries: days.map(({ ts, ...rest }) => rest),
    coverage: {
      fromBlock,
      toBlock: latestBlock.number,
      lookbackBlocks: LOOKBACK_BLOCKS,
    },
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=240");

  try {
    if (kv) {
      try {
        const cached = await kv.get(CACHE_KEY);
        if (cached) { res.setHeader("X-Cache", "HIT"); return res.status(200).json(cached); }
      } catch (e) { console.warn("KV read failed:", e.message); }
    }

    const data = await buildStats();

    if (kv) {
      try { await kv.set(CACHE_KEY, data, { ex: CACHE_TTL_SEC }); }
      catch (e) { console.warn("KV write failed:", e.message); }
    }
    res.setHeader("X-Cache", "MISS");
    return res.status(200).json(data);
  } catch (err) {
    console.error("graph-stats error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

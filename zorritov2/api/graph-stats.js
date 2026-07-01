/**
 * api/graph-stats.js  (Zorrito V2 on-chain stats)
 *
 * On-chain stats for stats.html. Two data sources:
 *   • Contract view calls via forno RPC — pool size, depositor count, prize
 *     pool, APY, streak distribution. These are cheap and always work.
 *   • Blockscout indexer API — transaction activity (counts, time-series,
 *     volume) and raffle winners. A high-volume contract emits far more logs
 *     than a public RPC will return from eth_getLogs, so event history is read
 *     from the indexer instead of scanning logs directly.
 *
 * Cached in Vercel KV (TTL 5min).
 *
 * GET /api/graph-stats
 */

const { ethers } = require("ethers");

let kv = null;
try { kv = require("@vercel/kv").kv; } catch { /* KV optional */ }

const RPC        = (process.env.CELO_RPC_URL || process.env.CELO_RPC || "https://forno.celo.org").trim();
const V2_ADDR    = (process.env.V2_CONTRACT_ADDRESS || process.env.ZORRITO_V2_ADDR || "0x8f4E627d4C4Af5dfE11908Bd8B929588d9Ee58c9").trim();
const USDT_ADDR  = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const AUSDT_ADDR = "0xDeE98402A302e4D707fB9bf2bac66fAEEc31e8Df";
const AAVE_POOL  = "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402";

// Blockscout (Celo mainnet) — indexer API for event history at scale.
const BS_LEG = "https://celo.blockscout.com/api"; // Etherscan-compatible (getLogs w/ topic + range)

const CACHE_KEY     = "zorritov2:graph-stats:v6-blockscout";
const CACHE_TTL_SEC = 300;

// ── ABIs (contract state only) ────────────────────────────────────────────────
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
];
const AAVE_ABI  = ["function getReserveData(address asset) view returns (uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128)"];
const AUSDT_ABI = ["function balanceOf(address) view returns (uint256)"];

const RAFFLE_TOPIC    = ethers.id("RaffleExecuted(address,uint256,uint256)");
const DEPOSITED_TOPIC = ethers.id("Deposited(address,address,uint256,uint8)");
const WITHDRAWN_TOPIC = ethers.id("Withdrawn(address,uint256)");

// Scan raffle + activity history from this block (contract deployed ~2026-05-22).
const ACTIVITY_FROM_BLOCK = parseInt(process.env.ACTIVITY_FROM_BLOCK || "67700000", 10);
const LOG_CHUNK = 300_000; // blocks per getLogs request (Blockscout caps at 1000 results)

const toUSDT = (raw) => Number(ethers.formatUnits(raw, 6));
const bucketDay = (ts) => {
  const d = new Date(ts * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

async function bsJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json" } });
  if (!r.ok) throw new Error(`Blockscout ${r.status} for ${url}`);
  return r.json();
}

// Run async tasks with bounded concurrency (avoid hammering the indexer).
async function pMap(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Etherscan-compatible getLogs for one block range (Blockscout indexes this,
// so wide ranges work; returns up to 1000 logs per call).
async function getLogsRange(topic0, from, to) {
  const url = `${BS_LEG}?module=logs&action=getLogs&address=${V2_ADDR}&topic0=${topic0}&fromBlock=${from}&toBlock=${to}`;
  try {
    const d = await bsJson(url);
    return String(d.status) === "1" && Array.isArray(d.result) ? d.result : [];
  } catch (e) { console.warn("getLogs range failed:", e.message); return []; }
}

// Fetch ALL logs for a topic across [fromBlock, latest] using parallel,
// independent block-range chunks. Any chunk that hits the 1000-result cap is
// split in half and re-fetched (handles activity bursts).
async function getAllLogs(topic0, fromBlock, latestBlock) {
  const ranges = [];
  for (let f = fromBlock; f <= latestBlock; f += LOG_CHUNK) {
    ranges.push([f, Math.min(f + LOG_CHUNK - 1, latestBlock)]);
  }
  const logs = [];
  const capped = [];
  const first = await pMap(ranges, 6, ([a, b]) => getLogsRange(topic0, a, b).then((r) => ({ a, b, r })));
  for (const { a, b, r } of first) {
    if (r.length >= 1000) capped.push([a, b]);
    else logs.push(...r);
  }
  if (capped.length) {
    const halves = [];
    for (const [a, b] of capped) {
      const mid = Math.floor((a + b) / 2);
      halves.push([a, mid], [mid + 1, b]);
    }
    const second = await pMap(halves, 6, ([a, b]) => getLogsRange(topic0, a, b));
    for (const r of second) logs.push(...r);
  }
  return logs;
}

const logTs  = (l) => parseInt(l.timeStamp, 16) || 0;
const logAmt = (l) => {
  const data = String(l.data || "0x").slice(2);
  return data.length >= 64 ? Number(ethers.formatUnits(BigInt("0x" + data.slice(0, 64)), 6)) : 0;
};

// ── Contract state (forno) ─────────────────────────────────────────────────────
async function fetchState(provider) {
  const c     = new ethers.Contract(V2_ADDR, V2_ABI, provider);
  const aUsdt = new ethers.Contract(AUSDT_ADDR, AUSDT_ABI, provider);

  const [totalPrincipal, depositorCount, aUsdtBal, totalChances, totalSavings] = await Promise.all([
    c.totalPrincipal().catch(() => 0n),
    c.depositorCount().catch(() => 0n),
    aUsdt.balanceOf(V2_ADDR).catch(() => 0n),
    c.totalEffectiveChances().catch(() => 0n),
    c.totalSavings().catch(() => 0n),
  ]);
  const currentPrizePool = aUsdtBal > totalPrincipal ? aUsdtBal - totalPrincipal : 0n;

  // Streak distribution + active/self-verified counts.
  // Sample up to 240 depositors; all RPC reads run with bounded concurrency
  // (parallel, not sequential) to keep this fast. streakDay >= 1 means the
  // depositor is active (the contract resets it to 0 on full withdraw).
  const streakBuckets = { 1:0, 2:0, 3:0, 4:0, 5:0, 6:0, 7:0 };
  let activeDepositors = 0, selfVerifiedCount = 0;
  const count = Number(depositorCount);
  if (count > 0) {
    const MAX = Math.min(count, 240);
    const idxs = Array.from({ length: MAX }, (_, i) => i);
    const addrs = (await pMap(idxs, 12, (i) => c.depositorList(i).catch(() => null))).filter(Boolean);
    const states = await pMap(addrs, 12, async (a) => ({
      sd: Number(await c.streakDay(a).catch(() => 0)),
      sv: await c.selfVerified(a).catch(() => false),
    }));
    for (const s of states) {
      if (s.sd >= 1) {
        activeDepositors++;
        streakBuckets[s.sd <= 7 ? s.sd : 7]++;
      }
      if (s.sv) selfVerifiedCount++;
    }
  }

  return {
    totalPrincipal, depositorCount: count, aUsdtBal, currentPrizePool,
    totalChances, totalSavings, streakBuckets, activeDepositors, selfVerifiedCount,
  };
}

// ── Transaction activity (Blockscout getLogs, parallel block-range chunks) ─────
async function fetchActivity(latestBlock) {
  const nowTs = Math.floor(Date.now() / 1000);

  // 30-day time-series skeleton
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const ts = nowTs - i * 86400;
    days.push({ date: bucketDay(ts), txCount: 0, depositCount: 0, withdrawCount: 0, saveCount: 0, depositVolume: 0 });
  }
  const dayMap = Object.fromEntries(days.map((d) => [d.date, d]));

  const mkP = () => ({ tx: 0, deposits: 0, withdraws: 0, saves: 0, depositVol: 0 });
  const periods = { h24: mkP(), d7: mkP(), d30: mkP() };
  const windows = [[86400, periods.h24], [7 * 86400, periods.d7], [30 * 86400, periods.d30]];

  // Deposited + Withdrawn logs across full history, in parallel.
  const [deposits, withdraws] = await Promise.all([
    getAllLogs(DEPOSITED_TOPIC, ACTIVITY_FROM_BLOCK, latestBlock),
    getAllLogs(WITHDRAWN_TOPIC, ACTIVITY_FROM_BLOCK, latestBlock),
  ]);

  let allVol = 0;
  for (const l of deposits) {
    const ts = logTs(l), vol = logAmt(l);
    allVol += vol;
    const row = dayMap[bucketDay(ts)];
    if (row) { row.txCount++; row.depositCount++; row.depositVolume += vol; }
    for (const [sec, p] of windows) if (ts > nowTs - sec) { p.tx++; p.deposits++; p.depositVol += vol; }
  }
  for (const l of withdraws) {
    const ts = logTs(l);
    const row = dayMap[bucketDay(ts)];
    if (row) { row.txCount++; row.withdrawCount++; }
    for (const [sec, p] of windows) if (ts > nowTs - sec) { p.tx++; p.withdraws++; }
  }

  return {
    days, periods,
    allDep: deposits.length,
    allWd: withdraws.length,
    allVol,
  };
}

// ── Raffle winners (Blockscout getLogs, sparse event, full range) ──────────────
async function fetchWinners() {
  const url = `${BS_LEG}?module=logs&action=getLogs&address=${V2_ADDR}&topic0=${RAFFLE_TOPIC}&fromBlock=${ACTIVITY_FROM_BLOCK}&toBlock=latest`;
  let d;
  try { d = await bsJson(url); }
  catch (e) { console.warn("blockscout winners failed:", e.message); return []; }
  if (String(d.status) !== "1" || !Array.isArray(d.result)) return [];

  return d.result.map((l) => {
    const winner = ethers.getAddress("0x" + String(l.topics[1]).slice(-40));
    const data   = String(l.data || "0x").slice(2);
    const prize  = data.length >= 64  ? BigInt("0x" + data.slice(0, 64))   : 0n;
    const fee    = data.length >= 128 ? BigInt("0x" + data.slice(64, 128)) : 0n;
    return {
      v: 2,
      winner,
      prize: toUSDT(prize),
      fee:   toUSDT(fee),
      timestamp: parseInt(l.timeStamp, 16) || 0,
      txHash: l.transactionHash,
    };
  }).sort((a, b) => b.timestamp - a.timestamp);
}

// ── Build ──────────────────────────────────────────────────────────────────────
async function buildStats() {
  const provider = new ethers.JsonRpcProvider(
    RPC, { chainId: 42220, name: "celo" }, { staticNetwork: true }
  );
  const aavePool = new ethers.Contract(AAVE_POOL, AAVE_ABI, provider);

  const latestBlock = await provider.getBlockNumber();

  const [state, activity, winners, aaveData] = await Promise.all([
    fetchState(provider),
    fetchActivity(latestBlock),
    fetchWinners(),
    aavePool.getReserveData(USDT_ADDR).catch(() => null),
  ]);

  // APY from Aave (per-second liquidityRate in RAY, compounded)
  let apy = 0;
  try {
    if (aaveData) {
      const RAY = 10n ** 27n;
      const apr = Number(BigInt(aaveData[2])) / Number(RAY);
      apy = Math.pow(1 + apr / 31_536_000, 31_536_000) - 1;
    }
  } catch { /* leave 0 */ }

  const totalTx     = activity.allDep + activity.allWd + winners.length;
  const totalPrizes = winners.reduce((s, w) => s + w.prize, 0);
  const totalFees   = winners.reduce((s, w) => s + w.fee,   0);

  return {
    ok: true,
    source: "on-chain (V2) · state via RPC, activity via Blockscout",
    generated: new Date().toISOString(),
    contract: {
      address: V2_ADDR,
      totalPrincipal: toUSDT(state.totalPrincipal),
      currentPrizePool: toUSDT(state.currentPrizePool),
      totalSavings: toUSDT(state.totalSavings),
      aUsdtBalance: toUSDT(state.aUsdtBal),
      depositorCount: state.depositorCount,
      totalEffectiveChances: state.totalChances.toString(),
      apy,
    },
    allTime: {
      total: totalTx,
      deposit: activity.allDep,
      withdraw: activity.allWd,
      save: 0,
      uniqueDepositors: state.depositorCount,
      totalDepositedUSDT: activity.allVol,
      draws: winners.length,
      totalPrizes,
      totalFees,
    },
    periods: {
      h24: activity.periods.h24,
      d7:  activity.periods.d7,
      d30: activity.periods.d30,
    },
    users: {
      total: state.depositorCount,
      active: state.activeDepositors || state.depositorCount,
      selfVerified: state.selfVerifiedCount,
    },
    lastDraw: winners[0] || null,
    winners,
    streakDistribution: [1,2,3,4,5,6,7].map((d) => ({
      day: d, label: `Day ${d}`, userCount: state.streakBuckets[d],
    })),
    timeSeries: activity.days,
    coverage: {
      fromBlock: ACTIVITY_FROM_BLOCK,
      toBlock: latestBlock,
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

// Exported for local testing
module.exports.buildStats = buildStats;

// zorritov2/api/demo-agent-tick.js
/**
 * Demo Agent — daily cron at 11:00 UTC.
 *
 * Behavior (7-day cycle):
 *   • Day 1..7: deposit 0.25 USDT  → grows position and extends daily streak
 *     (the new V2 contract fuses streak into deposit — no separate save call)
 *   • Day 7+1 (next call after 7 deposits): withdraw all funds → cycle resets
 *   • Then starts over on next call
 *
 * Uses AGENT_PRIVATE_KEY (different from the keeper key).
 * Cycle state is tracked in Vercel KV under `demo-agent:cycle`.
 *
 * Manual trigger:
 *   curl -X POST https://www.zorrito.app/api/demo-agent-tick \
 *     -H "Authorization: Bearer <CRON_SECRET>"
 */

const { ethers } = require("ethers");
const { checkAuth, USDT_ADDRESS } = require("./_lib/contract");

let kv = null;
try { kv = require("@vercel/kv").kv; } catch { /* optional */ }

const RPC          = (process.env.CELO_RPC_URL || "https://forno.celo.org").trim();
const CONTRACT     = (process.env.V2_CONTRACT_ADDRESS || process.env.CONTRACT_ADDRESS || "").trim();
const CYCLE_TARGET = 7;     // deposits per cycle before harvest
const MIN_DEPOSIT  = 250_000n; // 0.25 USDT
const KV_CYCLE_KEY = "demo-agent:cycle";

const ZORRITO_ABI = [
  "function deposit(uint256 amount, bytes4 refCode) external",
  "function withdraw(uint256 amount) external",
  "function deposits(address) view returns (uint256)",
  "function streakDay(address) view returns (uint8)",
  "function lastDepositDay(address) view returns (uint256)",
  "function emergencyMode() view returns (bool)",
];

const USDT_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

async function getCycle() {
  if (!kv) return { depositCount: 0 };
  try {
    const c = await kv.get(KV_CYCLE_KEY);
    if (!c) return { depositCount: 0 };
    return typeof c === "string" ? JSON.parse(c) : c;
  } catch { return { depositCount: 0 }; }
}
async function setCycle(c) { if (kv) { try { await kv.set(KV_CYCLE_KEY, c); } catch {} } }

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!checkAuth(req)) return res.status(401).json({ error: "Unauthorized" });

  const ts = new Date().toISOString();

  try {
    const pk = (process.env.AGENT_PRIVATE_KEY || "").trim();
    if (!pk)    return res.status(500).json({ error: "AGENT_PRIVATE_KEY not set" });
    if (!CONTRACT) return res.status(500).json({ error: "V2_CONTRACT_ADDRESS not set" });

    const provider = new ethers.JsonRpcProvider(
      RPC, { chainId: 42220, name: "celo" }, { staticNetwork: true }
    );
    const wallet  = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
    const zorrito = new ethers.Contract(CONTRACT, ZORRITO_ABI, wallet);
    const usdt    = new ethers.Contract(USDT_ADDRESS, USDT_ABI, wallet);
    const agent   = wallet.address;

    const emergency = await zorrito.emergencyMode();
    if (emergency) return res.status(200).json({ ts, action: "skipped", reason: "Emergency mode" });

    const [usdtBal, allow, dep, lastSave, celoBal] = await Promise.all([
      usdt.balanceOf(agent),
      usdt.allowance(agent, CONTRACT),
      zorrito.deposits(agent),
      zorrito.lastDepositDay(agent),
      provider.getBalance(agent),
    ]);

    if (celoBal === 0n) {
      return res.status(200).json({ ts, action: "skipped", reason: "No CELO for gas", agent });
    }

    const todayUtc = BigInt(Math.floor(Date.now() / 86400000));
    const savedToday = lastSave >= todayUtc;
    const cycle = await getCycle();

    // ── Harvest path: cycle complete → withdraw everything, reset counter ────
    if (cycle.depositCount >= CYCLE_TARGET) {
      if (dep > 0n) {
        const tx = await zorrito.withdraw(dep, { type: 0, gasLimit: 350_000 });
        const r  = await tx.wait();
        await setCycle({ depositCount: 0, lastHarvestTs: Date.now() });
        return res.status(200).json({
          ts,
          action: "harvest_withdraw",
          agent,
          withdrawnUsdt: (Number(dep) / 1e6).toFixed(6),
          txHash:   r.hash,
          explorer: `https://celoscan.io/tx/${r.hash}`,
        });
      }
      // Edge case: counter says 7 but deposits already 0 → just reset
      await setCycle({ depositCount: 0 });
      return res.status(200).json({ ts, action: "cycle_reset", agent });
    }

    // ── Already acted today → skip ─────────────────────────────────────────
    // Use the on-chain savedToday as the marker (set on deposit-first-time and save)
    if (savedToday && cycle.depositCount > 0) {
      return res.status(200).json({
        ts,
        action: "skipped",
        reason: "Already acted today",
        agent,
        cycleDay: cycle.depositCount,
      });
    }

    // ── Normal cycle day: deposit + save ───────────────────────────────────
    if (usdtBal < MIN_DEPOSIT) {
      return res.status(200).json({
        ts, action: "skipped",
        reason: "Insufficient USDT balance for daily deposit",
        agent,
        usdtBalance: (Number(usdtBal) / 1e6).toFixed(6),
      });
    }

    const result = { ts, agent, txs: [] };

    // Approve once (max) if needed — tight gasLimit, simple ERC-20 approve
    if (allow < MIN_DEPOSIT) {
      const ap = await usdt.approve(CONTRACT, ethers.MaxUint256, { type: 0, gasLimit: 70_000 });
      const r  = await ap.wait();
      result.txs.push({ step: "approve", hash: r.hash });
    }

    // Deposit 0.25 USDT — V2 NEW fuses streak extension into deposit().
    // No separate save() call needed: each deposit IS the daily streak action.
    const depTx = await zorrito.deposit(MIN_DEPOSIT, "0x00000000", { type: 0, gasLimit: 1_200_000 });
    const depR  = await depTx.wait();
    result.txs.push({ step: "deposit", hash: depR.hash });

    // Increment cycle counter
    const newCycle = { depositCount: cycle.depositCount + 1, lastTickTs: Date.now() };
    await setCycle(newCycle);

    const newStreak = Number(await zorrito.streakDay(agent));
    const newDep    = await zorrito.deposits(agent);

    return res.status(200).json({
      ts,
      action:        "daily_deposit",
      agent,
      cycleDay:      newCycle.depositCount,
      cycleTarget:   CYCLE_TARGET,
      streakDay:     newStreak,
      depositUSDT:   (Number(newDep) / 1e6).toFixed(6),
      remainingDays: CYCLE_TARGET - newCycle.depositCount,
      txs:           result.txs,
      explorers:     result.txs.map(t => `https://celoscan.io/tx/${t.hash}`),
    });

  } catch (err) {
    console.error("[demo-agent-tick] error:", err);
    return res.status(500).json({ ts, error: err.reason || err.message });
  }
};

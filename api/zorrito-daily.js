/**
 * Zorrito Daily Agent
 *
 * Runs every day via Vercel Cron at 09:00 UTC.
 * Logic:
 *   - No deposit yet → deposit 1 USDT (first-time setup)
 *   - Already deposited → feed the fox (daily, costs 1 USDT, adds 1 fish + streak)
 *   - Insufficient USDT balance → skip and report
 *
 * Required env vars (set in Vercel dashboard):
 *   AGENT_PRIVATE_KEY  — private key of the agent wallet (holds USDT + CELO for gas)
 *   CRON_SECRET        — any random string; protects the endpoint from outside calls
 *
 * Cron schedule (vercel.json): "50 5 * * *"  → runs at 05:50 UTC every day
 *
 * Streak window logic:
 *   The contract only advances the streak when the feed happens in the last ~4h
 *   before the deadline (i.e., ≥20h after the previous feed).
 *   This agent skips if secondsUntilDead > 4h so it never wastes a feed outside
 *   the streak window. If the fox dies (cron fired too late), it auto-revives.
 *
 * Manual trigger (for testing):
 *   curl -X POST https://zorrito.app/api/zorrito-daily \
 *     -H "Authorization: Bearer <your-CRON_SECRET>"
 */

const { ethers } = require("ethers");

// ── Constants ─────────────────────────────────────────────────────────────────

const RPC          = "https://forno.celo.org";
const ZORRITO      = "0x135dc8DC4bEd4e619B97b07bA16bCE348CAeFF62"; // v8
const USDT_ADDRESS = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const ONE_USDT     = BigInt(1_000_000); // 1 USDT with 6 decimals

const ZORRITO_ABI = [
  "function depositFor(address beneficiary, uint256 amount) external",
  "function feedFor(address beneficiary) external",
  "function withdraw(uint256 amount) external",
  "function getFoxStatus(address user) view returns (bool alive, uint32 currentStreak, uint32 bestStreak, uint256 fishCount, uint256 nextFeedDeadline, uint256 secondsUntilDead)",
  "function getUserDeposit(address user) view returns (uint256)",
];

const MAX_DEPOSIT    = BigInt(2_000_000); // keep at most 2 USDT in the pool (1 USDT stays liquid in wallet)

const USDT_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
];

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── Auth ─────────────────────────────────────────────────────────────────────
  const cronSecret = (process.env.CRON_SECRET || "").trim();
  if (cronSecret) {
    const auth = (req.headers["authorization"] || "").trim();
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: "Unauthorized — set Authorization: Bearer <CRON_SECRET>" });
    }
  }

  // ── Env validation ────────────────────────────────────────────────────────────
  const privateKey = (process.env.AGENT_PRIVATE_KEY || "").trim();
  if (!privateKey) return res.status(500).json({ error: "AGENT_PRIVATE_KEY not configured" });

  // ── Wallet setup ──────────────────────────────────────────────────────────────
  const provider     = new ethers.JsonRpcProvider(RPC);
  const signer       = new ethers.Wallet(
    privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`,
    provider
  );
  const agentAddress = signer.address;

  try {
    // ── 1. Read current state ─────────────────────────────────────────────────
    const zorrito = new ethers.Contract(ZORRITO, ZORRITO_ABI, provider);
    const usdt    = new ethers.Contract(USDT_ADDRESS, USDT_ABI, provider);

    const [fox, deposit, balance] = await Promise.all([
      zorrito.getFoxStatus(agentAddress),
      zorrito.getUserDeposit(agentAddress),
      usdt.balanceOf(agentAddress),
    ]);

    const secondsUntilDead = Number(fox.secondsUntilDead);
    const nextFeedDeadline = Number(fox.nextFeedDeadline);
    const STREAK_WINDOW    = 4 * 3600; // feed in the last 4h before deadline → streak +1

    const status = {
      agentAddress,
      usdtWalletBalance:  ethers.formatUnits(balance, 6) + " USDT",
      depositedInPool:    ethers.formatUnits(deposit, 6) + " USDT",
      foxAlive:           fox.alive,
      currentStreak:      Number(fox.currentStreak),
      fishCount:          Number(fox.fishCount),
      secondsUntilDead,
      nextFeedDeadline:   new Date(nextFeedDeadline * 1000).toISOString(),
      inStreakWindow:     fox.alive && secondsUntilDead <= STREAK_WINDOW,
    };

    // ── 2. Guard: insufficient balance ────────────────────────────────────────
    if (BigInt(balance) < ONE_USDT) {
      return res.status(200).json({
        timestamp:   new Date().toISOString(),
        agentWallet: agentAddress,
        action:      "skipped",
        reason:      "Insufficient USDT balance — fund the agent wallet to resume",
        status,
      });
    }

    // ── 3. Guard: not yet in streak window — skip to avoid wasting the feed ───
    //    First deposit (deposit === 0) always proceeds.
    //    Revival (fox dead) always proceeds.
    //    Normal feeds only fire in the last 4h before the deadline so the
    //    streak counter advances (+1) on every cron run.
    if (BigInt(deposit) > 0n && fox.alive && secondsUntilDead > STREAK_WINDOW) {
      return res.status(200).json({
        timestamp:   new Date().toISOString(),
        agentWallet: agentAddress,
        action:      "skipped",
        reason:      `Outside streak window — ${Math.round(secondsUntilDead / 3600)}h until deadline, will feed in the last ${STREAK_WINDOW / 3600}h`,
        status,
      });
    }

    // ── 4. Ensure USDT allowance ──────────────────────────────────────────────
    const usdtSigner  = new ethers.Contract(USDT_ADDRESS, USDT_ABI, signer);
    const allowance   = await usdtSigner.allowance(agentAddress, ZORRITO);
    if (BigInt(allowance) < ONE_USDT) {
      const approveTx = await usdtSigner.approve(ZORRITO, ethers.MaxUint256);
      await approveTx.wait();
    }

    // ── 5. Decide: deposit (first time), revive (dead fox), or feed (daily) ───
    const zorritoSigner = new ethers.Contract(ZORRITO, ZORRITO_ABI, signer);
    let tx, action;

    if (BigInt(deposit) === 0n) {
      // First time: create fox
      tx     = await zorritoSigner.depositFor(agentAddress, ONE_USDT);
      action = "deposit";
    } else if (!fox.alive) {
      // Fox died (cron fired too late) — revive it; streak resets to 1
      tx     = await zorritoSigner.depositFor(agentAddress, ONE_USDT);
      action = "revive";
    } else {
      // Normal daily feed — inside streak window → streak +1
      tx     = await zorritoSigner.feedFor(agentAddress);
      action = "feed";
    }

    const receipt = await tx.wait();

    // ── 6. Withdraw excess so deposited amount never exceeds MAX_DEPOSIT ────────
    //    Re-read deposit after the action (it may have increased by 1 USDT).
    let withdrawTxHash = null;
    let withdrawAmount = null;
    const depositAfter = await zorrito.getUserDeposit(agentAddress);
    if (BigInt(depositAfter) > MAX_DEPOSIT) {
      const excess = BigInt(depositAfter) - MAX_DEPOSIT;
      const withdrawTx = await zorritoSigner.withdraw(excess);
      const withdrawReceipt = await withdrawTx.wait();
      withdrawTxHash = withdrawReceipt.hash;
      withdrawAmount = ethers.formatUnits(excess, 6) + " USDT";
    }

    return res.status(200).json({
      timestamp:    new Date().toISOString(),
      agentWallet:  agentAddress,
      action,
      txHash:       receipt.hash,
      explorer:     `https://celoscan.io/tx/${receipt.hash}`,
      ...(withdrawTxHash && {
        withdraw: {
          amount:   withdrawAmount,
          txHash:   withdrawTxHash,
          explorer: `https://celoscan.io/tx/${withdrawTxHash}`,
        },
      }),
      status,
    });

  } catch (err) {
    console.error("[zorrito-daily] Error:", err.message);
    return res.status(500).json({
      error:       err.reason || err.message,
      timestamp:   new Date().toISOString(),
      agentWallet: agentAddress,
    });
  }
};

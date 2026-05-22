/**
 * Zorrito x402 Agent API
 *
 * Allows AI agents to deposit and feed foxes via HTTP 402 payments.
 * Follows the x402 payment protocol (https://x402.org).
 *
 * Endpoints:
 *   GET  /api/agent?action=status&address=0x...   → fox + pool status (free)
 *   POST /api/agent?action=deposit&beneficiary=0x...&amount=N → deposit N USDT
 *   POST /api/agent?action=feed&beneficiary=0x...            → feed fox (1 USDT)
 *
 * Payment flow:
 *   1. Agent calls endpoint → receives 402 with X-Payment-Required header
 *   2. Agent transfers USDT to facilitator address on Celo
 *   3. Agent re-calls with X-Payment: base64({"txHash":"0x..."})
 *   4. Server verifies tx on-chain → executes depositFor / feedFor
 *   5. Returns 200 with Zorrito tx hash
 *
 * Required env vars (set in Vercel dashboard):
 *   PRIVATE_KEY — facilitator/deployer wallet private key (0x9c3Cf7...EAff54)
 *                 The public address is derived automatically from the private key.
 */

const { ethers } = require("ethers");

const RPC          = "https://forno.celo.org";
const ZORRITO      = "0x135dc8DC4bEd4e619B97b07bA16bCE348CAeFF62"; // v8
const USDT_ADDRESS = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const MIN_DEPOSIT  = BigInt(1_000_000); // 1 USDT (6 decimals)

const ZORRITO_ABI = [
  "function depositFor(address beneficiary, uint256 amount) external",
  "function feedFor(address beneficiary) external",
  "function getFoxStatus(address user) view returns (bool alive, uint32 currentStreak, uint32 bestStreak, uint256 fishCount, uint256 nextFeedDeadline, uint256 secondsUntilDead)",
  "function getStats() view returns (uint256 poolSize, uint256 yieldAvailable, uint256 playerCount, uint256 nextDraw, uint256 aliveFoxes)",
  "function getUserDeposit(address user) view returns (uint256)",
];

const USDT_ABI = [
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

// In-memory replay protection.
// For production scale, replace with a persistent store (Redis, Upstash, etc.)
const usedTxHashes = new Set();

// ── Helpers ───────────────────────────────────────────────────────────────────

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Payment, X-Payment-Required");
}

/**
 * Verify that txHash contains a USDT Transfer to `expectedTo` of at least `minAmount`.
 * Returns { payer: address, amount: bigint }.
 */
async function verifyUsdtPayment(txHash, expectedTo, minAmount) {
  const provider = new ethers.JsonRpcProvider(RPC);

  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt)          throw new Error("Transaction not found or not yet confirmed");
  if (receipt.status !== 1) throw new Error("Transaction reverted on-chain");

  const iface = new ethers.Interface([
    "event Transfer(address indexed from, address indexed to, uint256 value)",
  ]);

  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== USDT_ADDRESS.toLowerCase()) continue;
    try {
      const parsed = iface.parseLog(log);
      if (
        parsed.name === "Transfer" &&
        parsed.args.to.toLowerCase() === expectedTo.toLowerCase() &&
        BigInt(parsed.args.value) >= BigInt(minAmount)
      ) {
        return { payer: parsed.args.from, amount: BigInt(parsed.args.value) };
      }
    } catch { /* skip non-Transfer logs */ }
  }

  throw new Error(
    `No USDT transfer ≥ ${ethers.formatUnits(minAmount, 6)} USDT to ${expectedTo} found in tx`
  );
}

/**
 * Ensure the facilitator wallet has approved enough USDT to the Zorrito contract.
 * Runs a one-time max approval if allowance is insufficient.
 */
async function ensureAllowance(signer, required) {
  const usdt      = new ethers.Contract(USDT_ADDRESS, USDT_ABI, signer);
  const allowance = await usdt.allowance(signer.address, ZORRITO);
  if (BigInt(allowance) >= BigInt(required)) return;
  console.log("Approving USDT to Zorrito (one-time setup)...");
  const tx = await usdt.approve(ZORRITO, ethers.MaxUint256);
  await tx.wait();
  console.log("Approval confirmed.");
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();

  const privateKey = (process.env.PRIVATE_KEY || "").trim();

  if (!privateKey) {
    return res.status(500).json({ error: "PRIVATE_KEY not configured on server" });
  }

  // Derive facilitator address from private key (no separate env var needed)
  let facilitator;
  try {
    facilitator = new ethers.Wallet(
      privateKey.startsWith("0x") ? privateKey : "0x" + privateKey
    ).address;
  } catch {
    return res.status(500).json({ error: "PRIVATE_KEY is invalid" });
  }

  const action      = req.query.action || "deposit";
  const beneficiary = req.query.beneficiary || (req.body && req.body.beneficiary);
  const rawAmount   = parseInt(req.query.amount || (req.body && req.body.amount) || "1", 10);
  const amountUSDT  = Math.max(1, isNaN(rawAmount) ? 1 : rawAmount);
  const requiredRaw = action === "feed"
    ? MIN_DEPOSIT
    : BigInt(amountUSDT) * MIN_DEPOSIT;

  // ── Free status endpoint ─────────────────────────────────────────────────────
  if (action === "status") {
    const address = req.query.address;
    if (!address || !ethers.isAddress(address)) {
      return res.status(400).json({ error: "Pass ?address=0x... for status" });
    }
    try {
      const provider = new ethers.JsonRpcProvider(RPC);
      const zorrito  = new ethers.Contract(ZORRITO, ZORRITO_ABI, provider);
      const [fox, stats, deposit] = await Promise.all([
        zorrito.getFoxStatus(address),
        zorrito.getStats(),
        zorrito.getUserDeposit(address),
      ]);
      return res.status(200).json({
        address,
        fox: {
          alive:           fox.alive,
          streak:          fox.currentStreak.toString(),
          bestStreak:      fox.bestStreak.toString(),
          fishCount:       fox.fishCount.toString(),
          deadlineUnix:    fox.nextFeedDeadline.toString(),
          secondsUntilDead: fox.secondsUntilDead.toString(),
        },
        deposit: ethers.formatUnits(deposit, 6) + " USDT",
        pool: {
          totalUSDT:  ethers.formatUnits(stats.poolSize, 6),
          yieldUSDT:  ethers.formatUnits(stats.yieldAvailable, 6),
          players:    stats.playerCount.toString(),
          aliveFoxes: stats.aliveFoxes.toString(),
          nextDrawUnix: stats.nextDraw.toString(),
        },
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── Deposit / Feed — require payment ────────────────────────────────────────
  if (!beneficiary || !ethers.isAddress(beneficiary)) {
    return res.status(400).json({
      error: "Missing or invalid ?beneficiary=0x... parameter",
      hint:  "Pass the agent wallet address that should receive the lottery entry",
    });
  }

  const paymentHeader = req.headers["x-payment"];

  if (!paymentHeader) {
    // Return HTTP 402 with x402 payment details
    const protocol = req.headers["x-forwarded-proto"] || "https";
    const host     = req.headers.host;
    const resource = `${protocol}://${host}${req.url}`;

    return res
      .status(402)
      .setHeader("X-Payment-Required", JSON.stringify({
        x402Version:       1,
        scheme:            "exact",
        network:           "celo",
        maxAmountRequired: requiredRaw.toString(),
        resource,
        description:       action === "feed"
          ? `Feed fox for ${beneficiary} — 1 USDT/day · Zorrito no-loss lottery`
          : `Deposit ${amountUSDT} USDT into Zorrito for ${beneficiary}`,
        mimeType:          "application/json",
        payTo:             facilitator,
        maxTimeoutSeconds: 300,
        asset:             USDT_ADDRESS,
        extra: { name: "USDT", decimals: 6, network: "Celo mainnet" },
      }))
      .json({
        x402Version: 1,
        error:       "Payment Required",
        payTo:       facilitator,
        asset:       USDT_ADDRESS,
        network:     "celo",
        amountRequired: ethers.formatUnits(requiredRaw, 6) + " USDT",
        instructions: [
          `1. Transfer ${ethers.formatUnits(requiredRaw, 6)} USDT (${USDT_ADDRESS}) to ${facilitator} on Celo`,
          "2. Re-call this endpoint with header: X-Payment: base64(JSON.stringify({txHash:'0x...'}))",
        ],
      });
  }

  // ── Parse X-Payment header ──────────────────────────────────────────────────
  let payment;
  try {
    payment = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
  } catch {
    return res.status(402).json({ error: "Invalid X-Payment header — expected base64-encoded JSON" });
  }

  if (!payment.txHash || !/^0x[0-9a-fA-F]{64}$/.test(payment.txHash)) {
    return res.status(402).json({ error: "X-Payment must contain a valid txHash (0x + 64 hex chars)" });
  }

  // ── Replay protection ───────────────────────────────────────────────────────
  if (usedTxHashes.has(payment.txHash.toLowerCase())) {
    return res.status(402).json({ error: "This payment transaction has already been used" });
  }

  // ── Verify payment on-chain ─────────────────────────────────────────────────
  let verified;
  try {
    verified = await verifyUsdtPayment(payment.txHash, facilitator, requiredRaw);
  } catch (e) {
    return res.status(402).json({ error: `Payment verification failed: ${e.message}` });
  }

  // Mark as used immediately after verification (before on-chain call)
  usedTxHashes.add(payment.txHash.toLowerCase());

  // ── Execute on Zorrito ──────────────────────────────────────────────────────
  const provider = new ethers.JsonRpcProvider(RPC);
  const signer   = new ethers.Wallet(
    privateKey.startsWith("0x") ? privateKey : "0x" + privateKey,
    provider
  ); // resolves to 0x9c3Cf7A804C7c17B945250AAA6a0530690EAff54

  try {
    await ensureAllowance(signer, requiredRaw);
    const zorrito = new ethers.Contract(ZORRITO, ZORRITO_ABI, signer);

    const tx = action === "feed"
      ? await zorrito.feedFor(beneficiary)
      : await zorrito.depositFor(beneficiary, requiredRaw);

    const receipt = await tx.wait();

    return res.status(200).json({
      success:    true,
      action,
      beneficiary,
      amountUSDT: ethers.formatUnits(requiredRaw, 6),
      paidBy:     verified.payer,
      zorritoTx:  receipt.hash,
      explorer:   `https://celoscan.io/tx/${receipt.hash}`,
      next:       action === "feed"
        ? "Fox fed. Call again in ~20-24h to maintain streak."
        : `Deposit complete. Call /api/agent?action=feed&beneficiary=${beneficiary} daily to keep your fox alive.`,
    });
  } catch (e) {
    // Payment received but on-chain call failed — log for manual recovery
    console.error("On-chain execution failed after payment", {
      paymentTxHash: payment.txHash,
      beneficiary,
      action,
      error: e.message,
    });
    return res.status(500).json({
      error:   e.reason || e.message,
      warning: "Payment was received but on-chain execution failed. Contact support with paymentTxHash.",
      paymentTxHash: payment.txHash,
    });
  }
};

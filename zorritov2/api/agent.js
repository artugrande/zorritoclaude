/**
 * Zorrito V2 x402 Agent API — READ-ONLY
 *
 * Endpoints:
 *   GET /api/agent                          → API description + docs
 *   GET /api/agent?action=pool              → pool stats only (free)
 *   GET /api/agent?action=status&address=0x → user + pool state (free)
 *
 * Why read-only on V2:
 *   The V2 contract now exposes `depositFor(beneficiary, amount, refCode)` so
 *   sponsored deposits ARE possible — but this x402 endpoint is intentionally
 *   kept read-only until a paid write flow is wired up.
 *   For write access, agents must sign their own txs via /api/mcp.
 *
 * Required env vars (only used to advertise the platform wallet in /api/agent):
 *   PLATFORM_WALLET — address shown in the API description as the x402 payTo
 *                     for any future paid endpoints. If missing, /api/agent
 *                     still returns docs without it.
 *   KEEPER_PRIVATE_KEY — not used here (kept for forward compatibility with
 *                     /api/raffle-commit and /api/raffle-execute).
 */

const { ethers } = require("ethers");

const RPC          = "https://forno.celo.org";
const ZORRITO      = "0x8f4E627d4C4Af5dfE11908Bd8B929588d9Ee58c9"; // V2
const USDT_ADDRESS = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const DOCS_URL     = "https://zorrito.xyz/docs.html";

const ZORRITO_ABI = [
  "function deposits(address) view returns (uint256)",
  "function streakDay(address) view returns (uint8)",
  "function lastDepositDay(address) view returns (uint256)",
  "function effectiveChances(address) view returns (uint256)",
  "function totalEffectiveChances() view returns (uint256)",
  "function currentPrizePool() view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
  "function depositorCount() view returns (uint256)",
  "function selfVerified(address) view returns (bool)",
  "function activeReferrals(address) view returns (uint256)",
  "function pendingSavings(address) view returns (uint256)",
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function getProvider() {
  return new ethers.JsonRpcProvider(
    RPC,
    { chainId: 42220, name: "celo" },
    { staticNetwork: true }
  );
}

// Next Monday 10:05 UTC (unix seconds)
function nextDrawUnix() {
  const now = new Date();
  const d   = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 10, 5, 0, 0
  ));
  // Day-of-week in UTC: 0=Sun, 1=Mon, ...
  const dow = d.getUTCDay();
  let daysUntilMonday = (1 - dow + 7) % 7;
  if (daysUntilMonday === 0 && d.getTime() <= now.getTime()) {
    daysUntilMonday = 7;
  }
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  return Math.floor(d.getTime() / 1000);
}

function todayDayIndex() {
  return Math.floor(Date.now() / 1000 / 86400);
}

// ── Handler ──────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed",
      message: "V2 agent API is read-only. Use GET.",
      note: "Write operations are not exposed on this x402 endpoint yet; depositFor() exists in V2 but is not wired here. Use MCP (/api/mcp) to sign your own txs.",
    });
  }

  const action       = req.query.action || "";
  const platformWallet = (process.env.PLATFORM_WALLET || "").trim();

  // ── Description / docs ─────────────────────────────────────────────────────
  if (!action) {
    return res.status(200).json({
      name: "Zorrito V2 Agent API",
      version: "2.0.0",
      protocol: "x402-compatible (read-only)",
      network: "celo",
      contract: ZORRITO,
      usdt: USDT_ADDRESS,
      platformWallet: platformWallet || null,
      readOnly: true,
      note: "Write operations are not exposed on this x402 endpoint yet; depositFor() exists in V2 but is not wired here. Use MCP (/api/mcp) to sign your own txs.",
      endpoints: {
        "GET /api/agent":                          "this description",
        "GET /api/agent?action=pool":              "pool stats only (free)",
        "GET /api/agent?action=status&address=0x": "user + pool state (free)",
      },
      docs: DOCS_URL,
    });
  }

  // ── Pool stats ─────────────────────────────────────────────────────────────
  if (action === "pool") {
    try {
      const provider = getProvider();
      const zorrito  = new ethers.Contract(ZORRITO, ZORRITO_ABI, provider);
      const [prizePool, totalPrincipal, depositorCount, totalChances] = await Promise.all([
        zorrito.currentPrizePool(),
        zorrito.totalPrincipal(),
        zorrito.depositorCount(),
        zorrito.totalEffectiveChances(),
      ]);
      return res.status(200).json({
        status: "ok",
        data: {
          pool: {
            prizePoolUSDT:    ethers.formatUnits(prizePool, 6),
            totalDepositedUSDT: ethers.formatUnits(totalPrincipal, 6),
            depositors:       depositorCount.toString(),
            totalChances:     totalChances.toString(),
            nextDrawUnix:     nextDrawUnix(),
          },
        },
      });
    } catch (e) {
      return res.status(500).json({ status: "error", error: e.message });
    }
  }

  // ── User + pool status ────────────────────────────────────────────────────
  if (action === "status") {
    const address = req.query.address;
    if (!address || !ethers.isAddress(address)) {
      return res.status(400).json({
        status: "error",
        error: "Pass ?address=0x... for status",
      });
    }
    try {
      const provider = getProvider();
      const zorrito  = new ethers.Contract(ZORRITO, ZORRITO_ABI, provider);
      const [
        deposit, streak, lastSave, chances,
        totalChances, prizePool, totalPrincipal, depositorCount,
        verified, refs, pendingSav,
      ] = await Promise.all([
        zorrito.deposits(address),
        zorrito.streakDay(address),
        zorrito.lastDepositDay(address),
        zorrito.effectiveChances(address),
        zorrito.totalEffectiveChances(),
        zorrito.currentPrizePool(),
        zorrito.totalPrincipal(),
        zorrito.depositorCount(),
        zorrito.selfVerified(address),
        zorrito.activeReferrals(address),
        zorrito.pendingSavings(address),
      ]);

      const userChances  = BigInt(chances);
      const totalChances_ = BigInt(totalChances);
      const oddsPercent  = totalChances_ > 0n
        ? Number((userChances * 1_000_000n) / totalChances_) / 10_000
        : 0;
      const savedToday = Number(lastSave) === todayDayIndex();

      return res.status(200).json({
        status: "ok",
        data: {
          address,
          user: {
            depositUSDT:     ethers.formatUnits(deposit, 6),
            streakDay:       Number(streak),
            savedToday,
            chances:         userChances.toString(),
            oddsPercent,
            selfVerified:    Boolean(verified),
            activeReferrals: Number(refs),
            pendingSavingsUSDT: ethers.formatUnits(pendingSav, 6),
          },
          pool: {
            prizePoolUSDT:      ethers.formatUnits(prizePool, 6),
            totalDepositedUSDT: ethers.formatUnits(totalPrincipal, 6),
            depositors:         depositorCount.toString(),
            totalChances:       totalChances_.toString(),
            nextDrawUnix:       nextDrawUnix(),
          },
        },
      });
    } catch (e) {
      return res.status(500).json({ status: "error", error: e.message });
    }
  }

  // ── Unknown action ─────────────────────────────────────────────────────────
  return res.status(400).json({
    status: "error",
    error: `Unknown action '${action}'`,
    validActions: ["", "pool", "status"],
    note: "Write operations are not exposed on this x402 endpoint yet; depositFor() exists in V2 but is not wired here. Use MCP (/api/mcp) to sign your own txs.",
  });
};

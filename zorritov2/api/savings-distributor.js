// zorritov2/api/savings-distributor.js
/**
 * Keeper: claim Merit aUSDT rewards from Merkl → convert aUSDT to USDT inside
 * the contract via withdrawMeritToSavings() → distributeSavingsRewards().
 *
 * Schedule: daily 12:00 UTC  (vercel.json cron: "0 12 * * *")
 *
 * The Aave Celo "Merit" / "Masiv" program is distributed via Merkl as
 * JSON_AIRDROP campaigns. The reward token is aUSDT (the Aave aToken), not
 * raw USDT. The contract receives aUSDT on claim; we then call
 * withdrawMeritToSavings(amount) which redeems that aUSDT for plain USDT
 * (held inside the contract) so distributeSavingsRewards() can pick it up.
 *
 * Required env vars: KEEPER_PRIVATE_KEY, V2_CONTRACT_ADDRESS, CRON_SECRET
 * Optional: MERKL_DISTRIBUTOR, CELO_RPC_URL
 *
 * Manual trigger:
 *   curl -X POST https://www.zorrito.app/api/savings-distributor \
 *     -H "Authorization: Bearer <CRON_SECRET>"
 */

const { ethers } = require("ethers");
const {
  getContracts,
  checkAuth,
  USDT_ADDRESS,
  AUSDT_ADDRESS,
} = require("./_lib/contract");

const DEFAULT_MERKL_DISTRIBUTOR = "0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae";
const CHAIN_ID = 42220;

const MERKL_DISTRIBUTOR_ABI = [
  "function claim(address[] calldata users, address[] calldata tokens, uint256[] calldata amounts, bytes32[][] calldata proofs) external",
];

// Merkl v4 sometimes returns:
//   a) Flat: [{ token, amount, proof, ... }, ...]
//   b) Nested by chain: [{ chain: {...}, rewards: [{ token, amount, proof }, ...] }, ...]
// This normalizes both shapes into a flat array of {token, amount, proofs}.
function normalizeMerklResponse(data) {
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const entry of data) {
    if (entry == null) continue;
    // Nested
    if (Array.isArray(entry.rewards)) {
      for (const r of entry.rewards) out.push(r);
      continue;
    }
    // Flat: single token entry — also handle when `proofs` (plural) is used,
    // or when amounts/proofs live inside `breakdowns[]`.
    if (entry.token || entry.tokenAddress) {
      out.push(entry);
      continue;
    }
  }
  return out;
}

// Extracts the token address, claimable amount (BigInt) and proof for a reward.
// Handles a couple of field-name variations seen in Merkl v4 in the wild.
function extractReward(item) {
  if (!item) return null;
  const token = (item.token || item.tokenAddress || "").toLowerCase();
  // Amount fields seen: amount (string), pending (string), accumulated (string), claimable (string)
  const amountStr = item.amount ?? item.accumulated ?? item.pending ?? item.claimable;
  // Proof may be `proof`, `proofs` (single proof for this user), or under `breakdowns[i].proof`
  let proof =
    item.proof ||
    item.proofs ||
    (Array.isArray(item.breakdowns) && item.breakdowns[0]?.proof) ||
    null;
  if (!token || !amountStr || !proof) return null;
  if (!Array.isArray(proof)) return null;
  let amount;
  try {
    amount = BigInt(amountStr);
  } catch {
    return null;
  }
  if (amount === 0n) return null;
  return { token, amount, proof };
}

async function fetchMerklReward(address) {
  const url = `https://api.merkl.xyz/v4/users/${address}/rewards?chainId=${CHAIN_ID}`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Merkl API ${resp.status}: ${await resp.text()}`);
  }
  const data = await resp.json();
  console.log("[savings-distributor] Merkl raw response (first 500 chars):",
    JSON.stringify(data).slice(0, 500));

  const items = normalizeMerklResponse(data);
  if (items.length === 0) return { reward: null, reason: "Merkl returned no entries" };

  // Aave Celo Merit pays in aUSDT (the Aave aToken on Celo).
  // Some integrations may also pay in raw USDT — accept either, prefer aUSDT.
  const targetTokens = [AUSDT_ADDRESS.toLowerCase(), USDT_ADDRESS.toLowerCase()];
  let chosen = null;
  for (const t of targetTokens) {
    for (const it of items) {
      const tok = (it.token || it.tokenAddress || "").toLowerCase();
      if (tok === t) {
        const r = extractReward(it);
        if (r) { chosen = r; break; }
      }
    }
    if (chosen) break;
  }
  if (!chosen) {
    return {
      reward: null,
      reason: `No aUSDT/USDT reward in Merkl response (got ${items.length} entries)`,
    };
  }
  return { reward: chosen };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!checkAuth(req)) return res.status(401).json({ error: "Unauthorized" });

  const ts = new Date().toISOString();

  try {
    const { zorrito, keeperWallet, usdt, contractAddress } = getContracts();

    const emergency = await zorrito.emergencyMode();
    if (emergency) {
      return res.status(200).json({ ts, action: "skipped", reason: "Emergency mode active" });
    }

    const totalPrincipal = await zorrito.totalPrincipal();
    if (totalPrincipal === 0n) {
      return res.status(200).json({
        ts,
        action: "skipped",
        reason: "No depositors — Merit campaigns score by aUSDT holdings, so nothing to claim yet",
      });
    }

    const result = { ts, keeper: keeperWallet.address, contract: contractAddress };

    // ── Step 1: Fetch + claim Merkl Merit reward (aUSDT) ──────────────────────
    let claimedAUsdt = 0n;
    try {
      const { reward, reason } = await fetchMerklReward(contractAddress);
      if (!reward) {
        result.merklClaim = { skipped: true, reason: reason || "No pending Merit rewards" };
      } else {
        const distributorAddr = (process.env.MERKL_DISTRIBUTOR || DEFAULT_MERKL_DISTRIBUTOR).trim();
        const distributor = new ethers.Contract(distributorAddr, MERKL_DISTRIBUTOR_ABI, keeperWallet);
        // Distributor's claim() expects accumulated total per user (it tracks claimed-so-far internally
        // and only transfers the delta). Pass the full accumulated amount Merkl reported.
        const claimTx = await distributor.claim(
          [contractAddress], [reward.token], [reward.amount], [reward.proof]
        );
        const claimReceipt = await claimTx.wait();
        // The amount actually deposited may equal reward.amount (first claim) or less (re-claim).
        // We don't strictly need to know — withdrawMeritToSavings will use the contract's current aUSDT
        // balance vs totalPrincipal to determine how much to withdraw. But for logging we record it.
        claimedAUsdt = reward.amount;
        result.merklClaim = {
          token:    reward.token,
          amount:   reward.token.toLowerCase() === AUSDT_ADDRESS.toLowerCase()
                    ? (Number(reward.amount) / 1e6).toFixed(6) + " aUSDT"
                    : (Number(reward.amount) / 1e6).toFixed(6) + " USDT",
          txHash:   claimReceipt.hash,
          explorer: `https://celoscan.io/tx/${claimReceipt.hash}`,
        };
      }
    } catch (merklErr) {
      console.error("[savings-distributor] Merkl claim error:", merklErr);
      result.merklClaim = { error: merklErr.message };
    }

    // ── Step 2: If we claimed aUSDT, convert it to USDT inside the contract ──
    // The contract's aUSDT balance now exceeds totalPrincipal by (organic Aave yield + Merit).
    // We want to extract ONLY what came from Merit, leaving Aave yield as raffle prize.
    // Approximation: withdraw `claimedAUsdt` worth of USDT. This matches what we just received.
    if (claimedAUsdt > 0n) {
      try {
        const conversionTx = await zorrito.withdrawMeritToSavings(claimedAUsdt);
        const conversionReceipt = await conversionTx.wait();
        result.conversion = {
          aUsdtConverted: (Number(claimedAUsdt) / 1e6).toFixed(6) + " aUSDT → USDT",
          txHash:         conversionReceipt.hash,
          explorer:       `https://celoscan.io/tx/${conversionReceipt.hash}`,
        };
      } catch (convErr) {
        console.error("[savings-distributor] withdrawMeritToSavings error:", convErr);
        result.conversion = { error: convErr.reason || convErr.message };
        // Continue — maybe there's USDT in the contract from another source (sponsorship)
      }
    }

    // ── Step 3: Check if there's USDT to distribute ──────────────────────────
    const [usdtBalance, totalSavings] = await Promise.all([
      usdt.balanceOf(contractAddress),
      zorrito.totalSavings(),
    ]);

    if (usdtBalance <= totalSavings) {
      result.action       = "skipped";
      result.reason       = "No new USDT to distribute";
      result.usdtBalance  = (Number(usdtBalance)  / 1e6).toFixed(6) + " USDT";
      result.totalSavings = (Number(totalSavings) / 1e6).toFixed(6) + " USDT";
      return res.status(200).json(result);
    }

    // ── Step 4: Distribute to all depositors ─────────────────────────────────
    const toDistribute = usdtBalance - totalSavings;
    const tx           = await zorrito.distributeSavingsRewards();
    const receipt      = await tx.wait();

    result.action      = "distributed";
    result.distributed = (Number(toDistribute) / 1e6).toFixed(6) + " USDT";
    result.txHash      = receipt.hash;
    result.explorer    = `https://celoscan.io/tx/${receipt.hash}`;

    return res.status(200).json(result);

  } catch (err) {
    console.error("[savings-distributor] Error:", err);
    return res.status(500).json({ ts, error: err.reason || err.message });
  }
};

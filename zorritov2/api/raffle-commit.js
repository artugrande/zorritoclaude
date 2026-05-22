// zorritov2/api/raffle-commit.js
/**
 * Keeper: commit the weekly raffle entropy.
 * Schedule: Monday 10:00 UTC  (vercel.json cron: "0 10 * * 1")
 *
 * Required env vars: KEEPER_PRIVATE_KEY, V2_CONTRACT_ADDRESS, CRON_SECRET
 *
 * Manual trigger:
 *   curl -X POST https://www.zorrito.app/api/raffle-commit \
 *     -H "Authorization: Bearer <CRON_SECRET>"
 */

const { getContracts, checkAuth } = require("./_lib/contract");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!checkAuth(req)) return res.status(401).json({ error: "Unauthorized" });

  const ts = new Date().toISOString();

  try {
    const { zorrito, keeperWallet, contractAddress } = getContracts();

    const emergency = await zorrito.emergencyMode();
    if (emergency) {
      return res.status(200).json({ ts, action: "skipped", reason: "Emergency mode active" });
    }

    const alreadyCommitted = await zorrito.raffleCommitted();
    if (alreadyCommitted) {
      return res.status(200).json({ ts, action: "skipped", reason: "Raffle already committed" });
    }

    const total = await zorrito.totalPrincipal();
    if (total === 0n) {
      return res.status(200).json({ ts, action: "skipped", reason: "No depositors" });
    }

    // Guard: contract requires _fenwickTotal() > 0. This is normally === totalPrincipal > 0
    // but can be 0 if emergencyReturn was partially run (depositors registered but deposits=0).
    const totalChances = await zorrito.totalEffectiveChances();
    if (totalChances === 0n) {
      return res.status(200).json({ ts, action: "skipped", reason: "No active chances (all depositors withdrew)" });
    }

    const tx      = await zorrito.commitRaffle();
    const receipt = await tx.wait();

    return res.status(200).json({
      ts,
      action:   "committed",
      txHash:   receipt.hash,
      explorer: `https://celoscan.io/tx/${receipt.hash}`,
      keeper:   keeperWallet.address,
      contract: contractAddress,
    });

  } catch (err) {
    console.error("[raffle-commit] Error:", err.message);
    return res.status(500).json({ ts, error: err.reason || err.message });
  }
};

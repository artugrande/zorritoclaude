// zorritov2/api/raffle-execute.js
/**
 * Keeper: execute the weekly raffle and transfer prize to winner.
 * Schedule: Monday 10:05 UTC  (vercel.json cron: "5 10 * * 1")
 *
 * Required env vars: KEEPER_PRIVATE_KEY, V2_CONTRACT_ADDRESS, CRON_SECRET
 *
 * Manual trigger:
 *   curl -X POST https://www.zorrito.app/api/raffle-execute \
 *     -H "Authorization: Bearer <CRON_SECRET>"
 */

const { ethers }                   = require("ethers");
const { getContracts, checkAuth }  = require("./_lib/contract");

const RAFFLE_EXECUTED_ABI = ["event RaffleExecuted(address indexed winner, uint256 prize, uint256 fee)"];

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!checkAuth(req)) return res.status(401).json({ error: "Unauthorized" });

  const ts = new Date().toISOString();

  try {
    const { zorrito, keeperWallet, contractAddress, provider } = getContracts();

    const emergency = await zorrito.emergencyMode();
    if (emergency) {
      return res.status(200).json({ ts, action: "skipped", reason: "Emergency mode active" });
    }

    const committed = await zorrito.raffleCommitted();
    if (!committed) {
      return res.status(200).json({ ts, action: "skipped", reason: "Raffle not committed — run raffle-commit first" });
    }

    const [currentBlock, committedBlock] = await Promise.all([
      provider.getBlockNumber(),
      zorrito.committedBlock(),
    ]);
    const blocksElapsed = currentBlock - Number(committedBlock);

    if (blocksElapsed < 10) {
      return res.status(200).json({
        ts, action: "skipped",
        reason: `Too soon — ${blocksElapsed} blocks since commit (need 10)`,
        currentBlock, committedBlock: Number(committedBlock),
      });
    }

    if (blocksElapsed > 250) {
      // Auto-recovery: keeper can now reset the stale commit (Ownable2Step migration: now onlyKeeper).
      // Next cron run will re-commit fresh.
      try {
        const resetTx = await zorrito.forceResetCommit();
        await resetTx.wait();
        return res.status(200).json({
          ts, action: "reset",
          reason: `Commit expired (${blocksElapsed} blocks ago). Auto-reset; next commit cron will create a fresh raffle.`,
          txHash: resetTx.hash,
          explorer: `https://celoscan.io/tx/${resetTx.hash}`,
          currentBlock, committedBlock: Number(committedBlock),
        });
      } catch (resetErr) {
        return res.status(500).json({
          ts, action: "reset_failed",
          reason: `Commit expired (${blocksElapsed} blocks ago) and auto-reset failed.`,
          error: resetErr.reason || resetErr.message,
          currentBlock, committedBlock: Number(committedBlock),
        });
      }
    }

    const prizePool = await zorrito.currentPrizePool();
    const tx        = await zorrito.executeRaffle();
    const receipt   = await tx.wait();

    const iface = new ethers.Interface(RAFFLE_EXECUTED_ABI);
    let winner = null, prize = null, fee = null;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === "RaffleExecuted") {
          winner = parsed.args.winner;
          prize  = parsed.args.prize;
          fee    = parsed.args.fee;
          break;
        }
      } catch { /* skip */ }
    }

    return res.status(200).json({
      ts,
      action:    "executed",
      txHash:    receipt.hash,
      explorer:  `https://celoscan.io/tx/${receipt.hash}`,
      winner,
      prize:     prize  != null ? (Number(prize)  / 1e6).toFixed(6) + " USDT" : null,
      fee:       fee    != null ? (Number(fee)    / 1e6).toFixed(6) + " USDT" : null,
      prizePool: (Number(prizePool) / 1e6).toFixed(6) + " USDT",
      keeper:    keeperWallet.address,
      contract:  contractAddress,
    });

  } catch (err) {
    console.error("[raffle-execute] Error:", err.message);
    return res.status(500).json({ ts, error: err.reason || err.message });
  }
};

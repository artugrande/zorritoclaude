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
 *
 * Recovery semantics:
 *   - blocksElapsed < 10  → skipped (too soon, next cron retries)
 *   - 10 ≤ blocksElapsed ≤ 250 → execute; on revert auto-reset to avoid
 *     deadlocking the next 7 days of raffles
 *   - blocksElapsed > 250 → commit expired; auto-reset so next commit cron
 *     creates a fresh raffle
 */

const { ethers }                  = require("ethers");
const { getContracts, checkAuth } = require("./_lib/contract");
const { recordCron }              = require("./_lib/cron-tracker");

const RAFFLE_EXECUTED_ABI = ["event RaffleExecuted(address indexed winner, uint256 prize, uint256 fee)"];

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!checkAuth(req)) return res.status(401).json({ error: "Unauthorized" });

  const ts = new Date().toISOString();
  const respond = async (status, payload) => {
    await recordCron("raffle-execute", { httpStatus: status, ...payload });
    return res.status(status).json({ ts, ...payload });
  };

  try {
    const { zorrito, keeperWallet, contractAddress, provider } = getContracts();

    const emergency = await zorrito.emergencyMode();
    if (emergency) {
      return respond(200, { action: "skipped", reason: "Emergency mode active" });
    }

    const committed = await zorrito.raffleCommitted();
    if (!committed) {
      return respond(200, { action: "skipped", reason: "Raffle not committed — run raffle-commit first" });
    }

    const [currentBlock, committedBlock] = await Promise.all([
      provider.getBlockNumber(),
      zorrito.committedBlock(),
    ]);
    const blocksElapsed = currentBlock - Number(committedBlock);

    if (blocksElapsed < 10) {
      return respond(200, {
        action: "skipped",
        reason: `Too soon — ${blocksElapsed} blocks since commit (need 10)`,
        currentBlock, committedBlock: Number(committedBlock),
      });
    }

    if (blocksElapsed > 250) {
      // Commit too old — Celo block hashes only available for ~256 blocks.
      try {
        const resetTx = await zorrito.forceResetCommit();
        await resetTx.wait();
        return respond(200, {
          action: "reset",
          reason: `Commit expired (${blocksElapsed} blocks ago). Auto-reset; next commit cron will create a fresh raffle.`,
          txHash: resetTx.hash,
          explorer: `https://celoscan.io/tx/${resetTx.hash}`,
          currentBlock, committedBlock: Number(committedBlock),
        });
      } catch (resetErr) {
        return respond(500, {
          action: "reset_failed",
          reason: `Commit expired (${blocksElapsed} blocks ago) and auto-reset failed.`,
          error: resetErr.reason || resetErr.message,
          currentBlock, committedBlock: Number(committedBlock),
        });
      }
    }

    // ── Try to execute ────────────────────────────────────────────────────────
    let prizePool;
    try {
      prizePool = await zorrito.currentPrizePool();
    } catch { /* non-critical */ }

    let receipt;
    try {
      const tx = await zorrito.executeRaffle();
      receipt  = await tx.wait();
    } catch (execErr) {
      // Auto-recover from revert: reset the commit so a subsequent run (manual
      // or next-Monday cron) can re-commit and try again. Without this, a single
      // bad executeRaffle would deadlock the raffle for ~7 days until the next
      // commit cron, then 7 more days until the >250 branch resets.
      const errMsg = execErr.reason || execErr.shortMessage || execErr.message;
      let resetHash = null;
      try {
        const t = await zorrito.forceResetCommit();
        const r = await t.wait();
        resetHash = r.hash;
      } catch (resetErr) {
        return respond(500, {
          action: "execute_failed_reset_failed",
          executeError: errMsg,
          resetError: resetErr.reason || resetErr.message,
          currentBlock, committedBlock: Number(committedBlock),
        });
      }
      return respond(500, {
        action: "execute_failed_auto_reset",
        reason: "executeRaffle reverted. Commit auto-reset; trigger raffle-commit + raffle-execute manually to retry.",
        executeError: errMsg,
        resetTx: resetHash,
        resetExplorer: `https://celoscan.io/tx/${resetHash}`,
        currentBlock, committedBlock: Number(committedBlock),
      });
    }

    // Parse winner from event log
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

    return respond(200, {
      action:    "executed",
      txHash:    receipt.hash,
      explorer:  `https://celoscan.io/tx/${receipt.hash}`,
      winner,
      prize:     prize  != null ? (Number(prize)  / 1e6).toFixed(6) + " USDT" : null,
      fee:       fee    != null ? (Number(fee)    / 1e6).toFixed(6) + " USDT" : null,
      prizePool: prizePool != null ? (Number(prizePool) / 1e6).toFixed(6) + " USDT" : null,
      keeper:    keeperWallet.address,
      contract:  contractAddress,
    });

  } catch (err) {
    console.error("[raffle-execute] Error:", err.message);
    return respond(500, { error: err.reason || err.message });
  }
};

// zorritov2/api/self-status.js
// Polling endpoint for the frontend.
// Returns whether a wallet address has been Self-verified.
// Fast path: KV cache. Slow path: on-chain read (also writes to KV for future caching).

const { kv }     = require("@vercel/kv");
const { ethers } = require("ethers");

const RPC = "https://forno.celo.org";
const ABI = ["function selfVerified(address) view returns (bool)"];

module.exports = async function handler(req, res) {
  const { address } = req.query;

  if (!address || !ethers.isAddress(address)) {
    return res.status(400).json({ error: "Invalid address" });
  }

  const addr = address.toLowerCase();

  // ── Fast path: KV cache ───────────────────────────────────────────────────
  try {
    const cached = await kv.get(`self:addr:${addr}`);
    if (cached?.verified) {
      return res.json({ verified: true, source: "cache" });
    }
  } catch (kvErr) {
    console.warn("[self-status] KV error:", kvErr.message);
  }

  // ── Slow path: on-chain read ──────────────────────────────────────────────
  const contractAddr = (process.env.V2_CONTRACT_ADDRESS || process.env.CONTRACT_ADDRESS || "").trim();
  if (contractAddr) {
    try {
      const provider = new ethers.JsonRpcProvider(RPC);
      const contract = new ethers.Contract(contractAddr, ABI, provider);
      const onChain  = await contract.selfVerified(address);

      if (onChain) {
        // Backfill KV cache so next poll is instant
        await kv.set(
          `self:addr:${addr}`,
          { verified: true, ts: Date.now() },
          { ex: 86400 * 30 }
        ).catch(() => {});
        return res.json({ verified: true, source: "onchain" });
      }
    } catch (chainErr) {
      console.warn("[self-status] on-chain error:", chainErr.message);
    }
  }

  return res.json({ verified: false });
};

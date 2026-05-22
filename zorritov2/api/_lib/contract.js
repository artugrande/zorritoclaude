// zorritov2/api/_lib/contract.js
/**
 * Shared setup for ZorritoV2 keeper API routes.
 * Provides: provider, keeperWallet, zorrito (contract), usdt (contract)
 */

const { ethers } = require("ethers");

const RPC           = process.env.CELO_RPC_URL || "https://forno.celo.org";
const USDT_ADDRESS  = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const AUSDT_ADDRESS = "0xDeE98402A302e4D707fB9bf2bac66fAEEc31e8Df";

const KEEPER_ABI = [
  "function commitRaffle() external",
  "function executeRaffle() external",
  "function distributeSavingsRewards() external",
  "function withdrawMeritToSavings(uint256 amount) external",
  "function forceResetCommit() external",
  "function raffleCommitted() view returns (bool)",
  "function committedBlock() view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
  "function totalSavings() view returns (uint256)",
  "function totalEffectiveChances() view returns (uint256)",
  "function currentPrizePool() view returns (uint256)",
  "function emergencyMode() view returns (bool)",
];

const USDT_ABI = [
  "function balanceOf(address account) view returns (uint256)",
];

function getContracts() {
  const privateKey = (process.env.KEEPER_PRIVATE_KEY || "").trim();
  if (!privateKey) throw new Error("KEEPER_PRIVATE_KEY not set");

  const contractAddress = (process.env.V2_CONTRACT_ADDRESS || "").trim();
  if (!contractAddress) throw new Error("V2_CONTRACT_ADDRESS not set");

  const provider     = new ethers.JsonRpcProvider(RPC);
  const keeperWallet = new ethers.Wallet(
    privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`,
    provider
  );

  const zorrito = new ethers.Contract(contractAddress, KEEPER_ABI, keeperWallet);
  const usdt    = new ethers.Contract(USDT_ADDRESS, USDT_ABI, provider);

  return { provider, keeperWallet, zorrito, usdt, contractAddress };
}

function checkAuth(req) {
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret) {
    console.error("[auth] CRON_SECRET is not set — rejecting all requests");
    return false;
  }
  // Timing-safe comparison to prevent timing attacks
  const auth     = (req.headers["authorization"] || "").trim();
  const expected = `Bearer ${secret}`;
  if (auth.length !== expected.length) return false;
  try {
    const { timingSafeEqual } = require("crypto");
    return timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
  } catch {
    return false;
  }
}

module.exports = { getContracts, checkAuth, USDT_ADDRESS, AUSDT_ADDRESS };

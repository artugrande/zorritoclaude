// scripts/approveIncentive.js
// One-time: from the INCENTIVE wallet, approve the Zorrito contract to pull
// USDT for welcome bonuses.
//
// Usage:
//   1) In repo root .env, set: INCENTIVE_PRIVATE_KEY=0x<your incentive wallet key>
//   2) Run: npx hardhat run scripts/approveIncentive.js --network celo
//   3) After it prints the tx hash + verifies allowance, DELETE the line from .env.
//
// Optional env: APPROVE_AMOUNT (in USDT, default 100). Set to 0 to revoke.

require("dotenv").config();
const { ethers } = require("hardhat");

const USDT_ADDRESS = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const ZORRITO_V2   = "0xa93192250F68e5D4f68151F7c319760B51534cD1";

const USDT_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

async function main() {
  const pk = (process.env.INCENTIVE_PRIVATE_KEY || "").trim();
  if (!pk) {
    throw new Error(
      "Set INCENTIVE_PRIVATE_KEY in your local .env (NOT in Vercel). " +
      "It only needs to exist while this script runs — delete after."
    );
  }

  const provider = new ethers.JsonRpcProvider(
    "https://forno.celo.org",
    { chainId: 42220, name: "celo" },
    { staticNetwork: true }
  );
  const wallet = new ethers.Wallet(pk.startsWith("0x") ? pk : `0x${pk}`, provider);
  const usdt   = new ethers.Contract(USDT_ADDRESS, USDT_ABI, wallet);

  const amountUsdt = process.env.APPROVE_AMOUNT
    ? Number(process.env.APPROVE_AMOUNT)
    : 100; // default 100 USDT = 200 welcome bonuses
  // USDT on Celo has 6 decimals
  const amount = BigInt(Math.round(amountUsdt * 1_000_000));

  console.log("Incentive approve — Celo mainnet");
  console.log("  Wallet (signer):", wallet.address);
  console.log("  Approving:      ", amountUsdt, "USDT");
  console.log("  To spender:     ", ZORRITO_V2);

  const [balUsdt, balCelo, currentAllow] = await Promise.all([
    usdt.balanceOf(wallet.address),
    provider.getBalance(wallet.address),
    usdt.allowance(wallet.address, ZORRITO_V2),
  ]);
  console.log(`  USDT balance:    ${Number(balUsdt)/1e6} USDT`);
  console.log(`  CELO (for gas):  ${ethers.formatEther(balCelo)} CELO`);
  console.log(`  Current allow:   ${Number(currentAllow)/1e6} USDT`);

  if (balCelo === 0n) throw new Error("Wallet has no CELO for gas.");

  console.log("\nSubmitting approve tx...");
  const tx = await usdt.approve(ZORRITO_V2, amount);
  console.log("  tx hash:", tx.hash);
  console.log("  explorer:", `https://celoscan.io/tx/${tx.hash}`);
  await tx.wait();
  console.log("✓ confirmed");

  const newAllow = await usdt.allowance(wallet.address, ZORRITO_V2);
  console.log("\nFinal allowance:", Number(newAllow)/1e6, "USDT");
  if (newAllow >= 500_000n) {
    console.log("✅ Ready: contract can pull ≥0.5 USDT for welcome bonuses.");
  } else {
    console.log("⚠️  Allowance is below 0.5 USDT.");
  }
  console.log("\n👉 Now DELETE INCENTIVE_PRIVATE_KEY from your .env file.");
}

main().catch((e) => { console.error("\n❌ Failed:", e.message); process.exit(1); });

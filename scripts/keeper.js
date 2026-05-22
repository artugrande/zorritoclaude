/**
 * Zorrito Keeper — triggers draw() when conditions are met.
 *
 * Modes:
 *   node scripts/keeper.js --once   → check once and exit (used by GitHub Actions)
 *   node scripts/keeper.js          → run forever, check every 60s (local dev)
 */
require("dotenv").config();
const { ethers } = require("ethers");

const RPC      = "https://forno.celo.org";
const CONTRACT = "0x135dc8DC4bEd4e619B97b07bA16bCE348CAeFF62"; // Zorrito v8
const ABI = [
  "function canDraw() view returns (bool)",
  "function draw() external",
  "event WinnerPicked(address indexed winner, uint256 prize, uint256 timestamp)",
];

const ONCE = process.argv.includes("--once");

async function tryDraw() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const key = process.env.PRIVATE_KEY;
  if (!key) { console.error("❌ No PRIVATE_KEY in environment"); process.exit(1); }

  const signer  = new ethers.Wallet(key.startsWith("0x") ? key : "0x" + key, provider);
  const zorrito = new ethers.Contract(CONTRACT, ABI, signer);
  const ts      = new Date().toISOString();

  console.log(`[${ts}] Zorrito keeper — checking canDraw()...`);

  const ready = await zorrito.canDraw();
  if (!ready) {
    console.log(`[${ts}] Not ready yet — conditions not met (interval or yield)`);
    return;
  }

  console.log(`[${ts}] ✅ Draw ready! Triggering annual draw...`);
  try {
    const tx      = await zorrito.draw();
    console.log(`[${ts}] TX sent: ${tx.hash}`);
    const receipt = await tx.wait();
    const iface   = zorrito.interface;

    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed.name === "WinnerPicked") {
          const winner = parsed.args.winner;
          const prize  = ethers.formatUnits(parsed.args.prize, 6);
          console.log(`[${ts}] 🎉 WINNER: ${winner} won ${prize} USDT`);
        }
      } catch {}
    }
    console.log(`[${ts}] Draw complete ✅`);
  } catch (e) {
    console.error(`[${ts}] ❌ Draw failed:`, e.reason || e.message);
    process.exit(1);
  }
}

if (ONCE) {
  // GitHub Actions mode: run once and exit
  tryDraw().then(() => process.exit(0)).catch(e => {
    console.error(e);
    process.exit(1);
  });
} else {
  // Local dev mode: run forever
  const INTERVAL_MS = 60_000;
  console.log(`Zorrito keeper started. Checking every ${INTERVAL_MS / 1000}s...`);
  tryDraw();
  setInterval(tryDraw, INTERVAL_MS);
}

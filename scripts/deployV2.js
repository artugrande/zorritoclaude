const { ethers, run, network } = require("hardhat");

// ── Celo Mainnet Defaults (override with env vars if needed) ────────────────
const DEFAULTS = {
  USDT_ADDRESS:    "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
  AAVE_POOL:       "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402",
  AUSDT_ADDRESS:   "0xDeE98402A302e4D707fB9bf2bac66fAEEc31e8Df",
};

function envAddr(name, fallback) {
  const v = (process.env[name] || fallback || "").trim();
  if (!v) throw new Error(`Missing env var: ${name}`);
  if (!ethers.isAddress(v)) throw new Error(`Invalid address in ${name}: ${v}`);
  return v;
}

async function main() {
  const [deployer] = await ethers.getSigners();

  // ── Required env vars ───────────────────────────────────────────────────
  const KEEPER_ADDRESS    = envAddr("KEEPER_ADDRESS");
  const PLATFORM_WALLET   = envAddr("PLATFORM_WALLET");

  // ── Optional env vars (with mainnet defaults) ───────────────────────────
  const USDT_ADDRESS      = envAddr("USDT_ADDRESS",  DEFAULTS.USDT_ADDRESS);
  const AAVE_POOL         = envAddr("AAVE_POOL",     DEFAULTS.AAVE_POOL);
  const AUSDT_ADDRESS     = envAddr("AUSDT_ADDRESS", DEFAULTS.AUSDT_ADDRESS);

  // Optional: set incentive wallet immediately after deploy
  const INCENTIVE_WALLET  = process.env.INCENTIVE_WALLET
    ? envAddr("INCENTIVE_WALLET")
    : null;

  // Optional: skip verification (default: verify)
  const VERIFY = process.env.NO_VERIFY !== "1";

  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(" Deploying ZorritoV2");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  Network:          ${network.name}`);
  console.log(`  Deployer:         ${deployer.address}`);
  console.log(`  Balance:          ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} CELO`);
  console.log();
  console.log("Configuration:");
  console.log(`  USDT:             ${USDT_ADDRESS}`);
  console.log(`  Aave Pool:        ${AAVE_POOL}`);
  console.log(`  aUSDT:            ${AUSDT_ADDRESS}`);
  console.log(`  Platform Wallet:  ${PLATFORM_WALLET}`);
  console.log(`  Keeper:           ${KEEPER_ADDRESS}`);
  console.log(`  Incentive Wallet: ${INCENTIVE_WALLET || "(skipped — set later with setIncentiveWallet)"}`);
  console.log(`  Verify:           ${VERIFY ? "yes (Celoscan)" : "no"}\n`);

  // ── Deploy ──────────────────────────────────────────────────────────────
  const Factory = await ethers.getContractFactory("ZorritoV2");
  console.log("Deploying contract...");
  const zorrito = await Factory.deploy(
    USDT_ADDRESS,
    AAVE_POOL,
    AUSDT_ADDRESS,
    PLATFORM_WALLET,
    KEEPER_ADDRESS
  );
  await zorrito.waitForDeployment();
  const addr = await zorrito.getAddress();
  const deployTx = zorrito.deploymentTransaction();
  console.log(`✅ Deployed at ${addr}`);
  console.log(`   tx: https://celoscan.io/tx/${deployTx.hash}\n`);

  // ── Set incentive wallet if provided ────────────────────────────────────
  if (INCENTIVE_WALLET) {
    console.log(`Setting incentive wallet to ${INCENTIVE_WALLET}...`);
    const tx = await zorrito.setIncentiveWallet(INCENTIVE_WALLET);
    await tx.wait();
    console.log(`✅ incentiveWallet set (tx: ${tx.hash})\n`);
  }

  // ── Verify on Celoscan ──────────────────────────────────────────────────
  if (VERIFY) {
    console.log("Waiting 30s for Celoscan to index the bytecode before verifying...");
    await new Promise(r => setTimeout(r, 30_000));
    try {
      await run("verify:verify", {
        address: addr,
        constructorArguments: [
          USDT_ADDRESS,
          AAVE_POOL,
          AUSDT_ADDRESS,
          PLATFORM_WALLET,
          KEEPER_ADDRESS,
        ],
      });
      console.log("✅ Verified on Celoscan");
    } catch (e) {
      if (/already verified/i.test(e.message)) {
        console.log("ℹ️  Already verified");
      } else {
        console.warn("⚠️  Verification failed:", e.message);
        console.warn("   Manual command:");
        console.warn(`   npx hardhat verify --network celo ${addr} ${USDT_ADDRESS} ${AAVE_POOL} ${AUSDT_ADDRESS} ${PLATFORM_WALLET} ${KEEPER_ADDRESS}`);
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(" Next steps");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  1. Update frontend: zorritov2/frontend/app.js`);
  console.log(`       const CONTRACT_ADDRESS = "${addr}";`);
  console.log(`  2. Update Vercel env vars:`);
  console.log(`       V2_CONTRACT_ADDRESS=${addr}`);
  console.log(`       CONTRACT_ADDRESS=${addr}  (also used by self-verify keeper tx)`);
  if (!INCENTIVE_WALLET) {
    console.log(`  3. Set incentive wallet (owner call):`);
    console.log(`       await zorrito.setIncentiveWallet("0x...")`);
  }
  console.log(`  4. From the incentive wallet, approve USDT to this contract:`);
  console.log(`       USDT.approve("${addr}", maxUint256)`);
  console.log(`  5. Redeploy frontend to Vercel.\n`);
}

main().catch((err) => {
  console.error("\n❌ Deployment failed:");
  console.error(err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});

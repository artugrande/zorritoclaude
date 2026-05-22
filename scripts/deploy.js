const { ethers, network } = require("hardhat");

// ── Addresses by network ──────────────────────────────────────────────────────
const ADDRESSES = {
  celo: {
    usdt:     "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e", // USDT on Celo (LayerZero bridged, listed on Aave V3)
    aavePool: "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402", // Aave V3 Pool on Celo
    aUsdt:    "0xDeE98402A302e4D707fB9bf2bac66fAEEc31e8Df", // aUSDT — Aave interest-bearing USDT on Celo
  },
  alfajores: {
    // Alfajores doesn't have USDT natively — use a mock or cUSD
    // Deploy MockERC20 for USDT and a mock Aave pool for testing
    usdt:     process.env.MOCK_USDT     || "",
    aavePool: process.env.MOCK_AAVE     || "",
    aUsdt:    process.env.MOCK_AUSDT    || "",
  },
};

// ── Helper: get aUSDT from Aave PoolDataProvider ──────────────────────────────
// If you haven't hardcoded aUsdt above, uncomment this and run once to find it.
/*
async function getAUsdtAddress(aavePoolAddress, usdtAddress) {
  const provider = ethers.provider;
  const poolAbi = ["function getReserveData(address asset) view returns (tuple(uint256,uint128,uint128,uint128,uint128,uint128,uint40,uint16,address,address,address,address,uint128,uint128,uint128))"];
  const pool = new ethers.Contract(aavePoolAddress, poolAbi, provider);
  const data = await pool.getReserveData(usdtAddress);
  console.log("aToken (aUSDT):", data[8]); // aTokenAddress is index 8
  return data[8];
}
*/

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = network.name;

  console.log(`\nDeploying Zorrito on ${net}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Balance:  ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} CELO\n`);

  const addrs = ADDRESSES[net];
  if (!addrs?.usdt || !addrs?.aavePool || !addrs?.aUsdt) {
    throw new Error(`Missing addresses for network: ${net}. Update ADDRESSES in deploy.js`);
  }

  const Zorrito = await ethers.getContractFactory("Zorrito");
  const zorrito = await Zorrito.deploy(addrs.usdt, addrs.aavePool, addrs.aUsdt);
  await zorrito.waitForDeployment();

  const address = await zorrito.getAddress();
  console.log(`Zorrito deployed at: ${address}`);
  console.log(`\nUpdate frontend/app.js:`);
  console.log(`  ZORRITO_ADDRESS = "${address}"`);
}

main().catch((e) => { console.error(e); process.exit(1); });

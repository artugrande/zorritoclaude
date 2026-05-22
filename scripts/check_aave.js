const { ethers } = require('hardhat');

async function main() {
  const [deployer] = await ethers.getSigners();
  
  const USDT_ADDR  = '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e';
  const AAVE_ADDR  = '0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402';
  const AUSDT_ADDR = '0xDeE98402A302e4D707fB9bf2bac66fAEEc31e8Df';
  const USDT_WHALE = '0xf6436829Cf96EA0f8BC49d300c536FCC4f84C4ED';
  
  // Impersonate whale
  await ethers.provider.send('hardhat_impersonateAccount', [USDT_WHALE]);
  await ethers.provider.send('hardhat_setBalance', [USDT_WHALE, '0x' + (10n**20n).toString(16)]);
  const whale = await ethers.getSigner(USDT_WHALE);
  
  const usdt  = await ethers.getContractAt('IERC20', USDT_ADDR);
  const ausdt = await ethers.getContractAt('IERC20', AUSDT_ADDR);
  
  // Deploy ZorritoV2
  await ethers.provider.send('evm_setBlockGasLimit', ['0x' + (30_000_000n).toString(16)]);
  const Factory  = await ethers.getContractFactory('ZorritoV2');
  const contract = await Factory.deploy(USDT_ADDR, AAVE_ADDR, AUSDT_ADDR, deployer.address, deployer.address, { gasLimit: 25_000_000 });
  await contract.waitForDeployment();
  const addr = await contract.getAddress();
  
  // Give deployer USDT
  await usdt.connect(whale).transfer(deployer.address, ethers.parseUnits('100', 6));
  await usdt.connect(deployer).approve(addr, ethers.MaxUint256);

  // ── Storage manipulation ────────────────────────────────────────────────────
  // 1. Give aUSDT contract 100M USDT balance
  const LIQUIDITY_INDEX = 1008545082941805446378600677n;
  const SCALED_HUGE     = 100_000_000_000_000_000n;
  const packedUserState = (LIQUIDITY_INDEX << 128n) | SCALED_HUGE;
  const SEED_USDT       = ethers.parseUnits('100000000', 6);

  const ausdtUsdtKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [AUSDT_ADDR, 51])
  );
  await ethers.provider.send('hardhat_setStorageAt', [
    USDT_ADDR, ausdtUsdtKey, ethers.zeroPadValue(ethers.toBeHex(SEED_USDT), 32),
  ]);
  
  // 2. Give ZorritoV2 a huge aUSDT scaled balance
  const zorritoStateKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256'], [addr, 52])
  );
  await ethers.provider.send('hardhat_setStorageAt', [
    AUSDT_ADDR, zorritoStateKey, ethers.zeroPadValue(ethers.toBeHex(packedUserState), 32),
  ]);
  // ────────────────────────────────────────────────────────────────────────────
  
  const ausdtBal = await ausdt.balanceOf(addr);
  console.log('aUSDT balance of ZorritoV2 (after storage write):', ausdtBal.toString());
  
  // Deposit 10 USDT
  await contract.connect(deployer).deposit(ethers.parseUnits('10', 6), '0x00000000');
  const ausdtAfterDeposit = await ausdt.balanceOf(addr);
  console.log('aUSDT balance after deposit:', ausdtAfterDeposit.toString());
  
  // Try withdraw
  try {
    const usdtBefore = await usdt.balanceOf(deployer.address);
    await contract.connect(deployer).withdraw(ethers.parseUnits('10', 6));
    const usdtAfter = await usdt.balanceOf(deployer.address);
    console.log('WITHDRAW SUCCESS! Got:', (usdtAfter - usdtBefore).toString(), 'USDT');
  } catch(e) {
    console.log('WITHDRAW FAILED:', e.message.slice(0, 200));
  }
}
main().catch(console.error);

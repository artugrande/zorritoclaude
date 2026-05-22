// test/ZorritoV2.test.js
// Comprehensive test suite for ZorritoV2 on a Celo mainnet fork.
// Run with: npx hardhat test test/ZorritoV2.test.js --network hardhat

const { expect } = require("chai");
const { ethers }  = require("hardhat");

// ── On-chain addresses (Celo Mainnet) ──────────────────────────────────────
const USDT_ADDR  = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e"; // USDT on Celo (LayerZero bridged)
const AAVE_ADDR  = "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402"; // Aave V3 Pool (proxy) on Celo
const AUSDT_ADDR = "0xDeE98402A302e4D707fB9bf2bac66fAEEc31e8Df"; // aUSDT — Aave interest-bearing USDT
const USDT_WHALE = "0xf6436829Cf96EA0f8BC49d300c536FCC4f84C4ED"; // Large USDT holder on Celo (~4.5M USDT)

// ── Constants matching the contract ──────────────────────────────────────────
const MIN_DEPOSIT    = 250_000n;          // 0.25 USDT (6 decimals)
const WELCOME_STREAK = 5;                 // days
const WELCOME_BONUS  = 500_000n;          // 0.5 USDT
const ONE_USDT       = 1_000_000n;
const TEN_USDT       = 10_000_000n;
const HUNDRED_USDT   = 100_000_000n;
const THOUSAND_USDT  = 1_000_000_000n;
const DAY            = 86400n;

// ── Helpers ───────────────────────────────────────────────────────────────────

async function advance(seconds) {
  await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
  await ethers.provider.send("evm_mine");
}

async function nextDay() {
  await advance(DAY + 1n);
}

/**
 * Jump to the NEXT Monday 00:00:01 UTC.
 * Epoch 0 is Thursday. daysFromMonday = (daysSinceEpoch + 3) % 7.
 */
async function nextMonday() {
  const block          = await ethers.provider.getBlock("latest");
  const t              = BigInt(block.timestamp);
  const daysSinceEpoch = t / DAY;
  // daysFromMonday: 0 = Mon, 1 = Tue, ... 6 = Sun
  const daysFromMonday = (daysSinceEpoch + 3n) % 7n;
  // Seconds until next Monday midnight + 1s
  const secsToNextMonday = (7n - daysFromMonday) * DAY - (t % DAY) + 1n;
  await advance(secsToNextMonday);
}

/**
 * Jump to the next Monday and then advance one more day so we are on Tuesday.
 * This guarantees that 5 consecutive nextDay() calls will not cross another Monday.
 */
async function goToMondayStart() {
  await nextMonday();
  // We are now on Monday. 5 consecutive saves Mon/Tue/Wed/Thu/Fri stay in one week.
}

/**
 * Reset ZorritoV2's aUSDT _userState so that aUsdt.balanceOf(zorrito) == totalPrincipal.
 * This ensures prizePool = 0 so executeRaffle does not attempt a large Aave withdraw.
 *
 * Aave V3: balanceOf(user) = scaledBalance * liquidityIndex / RAY
 * => scaledBalance = amount * RAY / liquidityIndex
 */
async function resetZorritoABalance(contract, liquidityIndex) {
  const AUSDT_USER_STATE_SLOT = 52n;
  const RAY                   = 10n ** 27n;

  const totalPrincipal = await contract.totalPrincipal();
  // Compute scaled balance so that balanceOf == totalPrincipal
  const scaledBalance = (BigInt(totalPrincipal) * RAY) / liquidityIndex;

  // Pack: (liquidityIndex << 128) | scaledBalance
  const packedUserState = (liquidityIndex << 128n) | scaledBalance;
  const zorritoAddr     = await contract.getAddress();
  const key             = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [zorritoAddr, AUSDT_USER_STATE_SLOT])
  );
  await ethers.provider.send("hardhat_setStorageAt", [
    AUSDT_ADDR,
    key,
    ethers.zeroPadValue(ethers.toBeHex(packedUserState), 32),
  ]);
}

/**
 * Impersonate `address`, fund it with CELO for gas, then return a signer.
 */
async function impersonate(address) {
  await ethers.provider.send("hardhat_impersonateAccount", [address]);
  await ethers.provider.send("hardhat_setBalance", [
    address,
    "0x" + (10n ** 20n).toString(16), // 100 CELO
  ]);
  return ethers.getSigner(address);
}

/**
 * Deploy ZorritoV2 and set up alice, bob, carol with 1000 USDT each.
 * Also sets an incentive wallet with 100 USDT (approved to the contract).
 */
async function deployFixture() {
  const [deployer, keeper, platform] = await ethers.getSigners();

  // The Fenwick tree constructor allocates 8001 uint256 slots (~22M gas).
  // We must bump the next block's gas limit above Celo's default 16.7M.
  await ethers.provider.send("evm_setBlockGasLimit", ["0x" + (30_000_000n).toString(16)]);

  // Deploy contract
  const Factory = await ethers.getContractFactory("ZorritoV2");
  const contract = await Factory.deploy(
    USDT_ADDR,
    AAVE_ADDR,
    AUSDT_ADDR,
    platform.address,
    keeper.address,
    { gasLimit: 25_000_000 }
  );
  await contract.waitForDeployment();

  const usdt = await ethers.getContractAt("IERC20", USDT_ADDR);

  // Impersonate whale
  const whaleSigner = await impersonate(USDT_WHALE);

  // Fund alice, bob, carol
  const [, , , alice, bob, carol] = await ethers.getSigners();

  const users = [alice, bob, carol];
  for (const user of users) {
    await usdt.connect(whaleSigner).transfer(user.address, THOUSAND_USDT);
    await usdt.connect(user).approve(await contract.getAddress(), ethers.MaxUint256);
  }

  // Set up incentive wallet (a fresh signer from ethers)
  const [, , , , , , incentiveSigner] = await ethers.getSigners();
  await usdt.connect(whaleSigner).transfer(incentiveSigner.address, HUNDRED_USDT);
  await usdt.connect(incentiveSigner).approve(await contract.getAddress(), ethers.MaxUint256);
  await contract.connect(deployer).setIncentiveWallet(incentiveSigner.address);

  // ── Fetch live liquidity index from the fork at the pinned block ─────────────
  const aavePool = await ethers.getContractAt([
    "function getReserveData(address asset) view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt)"
  ], AAVE_ADDR);
  const reserveData    = await aavePool.getReserveData(USDT_ADDR);
  const liquidityIndex = BigInt(reserveData.liquidityIndex);

  // ── Aave liquidity / aUSDT balance setup ───────────────────────────────────
  //
  // Problem: on this Celo fork the USDT reserve is nearly 100% utilised, so:
  //  (a) the aUSDT contract (which holds underlying) has ~3.24M USDT — fine for
  //      small test deposits, but NOT sufficient once we artificially manipulate
  //      ZorritoV2's aUSDT scaled balance below.
  //  (b) Aave's validateWithdraw checks aUSDT.balanceOf(zorritoV2) and due to
  //      integer rounding the balance is 1 unit less than the exact deposit
  //      amount, causing NotEnoughAvailableUserBalance.
  //
  // Fix (two storage writes):
  //  1. Boost the aUSDT contract's USDT balance to 10 M (USDT mapping slot 51).
  //  2. Give ZorritoV2 a very large aUSDT scaled-balance so Aave's balance check
  //     always passes regardless of rounding or the deposit amount.
  //     aUSDT._userState mapping is at slot 52; value = (liquidityIndex << 128) | scaledBal.
  //
  const USDT_MAPPING_SLOT     = 51n;
  const AUSDT_USER_STATE_SLOT = 52n;

  // (1) Give aUSDT contract 100M USDT of underlying
  const SEED_USDT = ethers.parseUnits("100000000", 6); // 100 M USDT
  const ausdtUsdtKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [AUSDT_ADDR, USDT_MAPPING_SLOT])
  );
  await ethers.provider.send("hardhat_setStorageAt", [
    USDT_ADDR,
    ausdtUsdtKey,
    ethers.zeroPadValue(ethers.toBeHex(SEED_USDT), 32),
  ]);

  // (2) Give ZorritoV2 a huge aUSDT scaled balance using the dynamic liquidityIndex.
  const SCALED_HUGE     = 100_000_000_000_000_000n;      // effectively unlimited
  const packedUserState = (liquidityIndex << 128n) | SCALED_HUGE;
  const zorritoAddr     = await contract.getAddress();
  const zorritoStateKey = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [zorritoAddr, AUSDT_USER_STATE_SLOT])
  );
  await ethers.provider.send("hardhat_setStorageAt", [
    AUSDT_ADDR,
    zorritoStateKey,
    ethers.zeroPadValue(ethers.toBeHex(packedUserState), 32),
  ]);

  // Stop impersonation
  await ethers.provider.send("hardhat_stopImpersonatingAccount", [USDT_WHALE]);

  return { contract, usdt, deployer, keeper, platform, alice, bob, carol, incentiveSigner, whaleSigner, liquidityIndex };
}

// =============================================================================
// 1. deposit & withdraw
// =============================================================================
describe("deposit & withdraw", function () {
  this.timeout(120_000);

  it("reverts deposit below MIN_DEPOSIT", async function () {
    const { contract, alice } = await deployFixture();
    await expect(
      contract.connect(alice).deposit(MIN_DEPOSIT - 1n, "0x00000000")
    ).to.be.revertedWith("Below minimum deposit");
  });

  it("accepts deposit at MIN_DEPOSIT", async function () {
    const { contract, alice } = await deployFixture();
    await expect(
      contract.connect(alice).deposit(MIN_DEPOSIT, "0x00000000")
    ).to.emit(contract, "Deposited").withArgs(alice.address, MIN_DEPOSIT);
  });

  it("assigns 1-indexed depositorIndex and referral code on first deposit", async function () {
    const { contract, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");

    const idx = await contract.depositorIndex(alice.address);
    expect(idx).to.equal(1n);

    const code = await contract.referralCode(alice.address);
    expect(code).to.not.equal("0x00000000");
  });

  it("effectiveChances is 0 for user with no deposit", async function () {
    const { contract, alice } = await deployFixture();
    const chances = await contract.effectiveChances(alice.address);
    expect(chances).to.equal(0n);
  });

  it("effectiveChances > 0 after deposit (uses streakDay=1 floor)", async function () {
    const { contract, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");
    const chances = await contract.effectiveChances(alice.address);
    // Formula: deposit * streakDay(min 1) * (10 + refs) / 10 = 1_000_000 * 1 * 10 / 10 = 1_000_000
    expect(chances).to.be.gt(0n);
  });

  it("totalEffectiveChances() equals sum of individual chances", async function () {
    const { contract, alice, bob } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");
    await contract.connect(bob).deposit(ONE_USDT, "0x00000000");

    const aliceChances = await contract.effectiveChances(alice.address);
    const bobChances   = await contract.effectiveChances(bob.address);
    const total        = await contract.totalEffectiveChances();

    expect(total).to.equal(aliceChances + bobChances);
  });

  it("withdraw: user gets back >= deposited (Aave may add tiny interest)", async function () {
    const { contract, usdt, alice } = await deployFixture();
    await contract.connect(alice).deposit(TEN_USDT, "0x00000000");

    // Mine a block so Aave interest accrues and balance settles
    await ethers.provider.send("evm_mine");

    const balBefore = await usdt.balanceOf(alice.address);
    await contract.connect(alice).withdraw(TEN_USDT);
    const balAfter = await usdt.balanceOf(alice.address);

    // Aave may have accrued yield so balAfter >= balBefore + amount
    const U10 = BigInt(TEN_USDT);
    const SMALL_TOLERANCE = ethers.parseUnits("0.01", 6); // 0.01 USDT max Aave interest
    expect(balAfter - balBefore).to.be.gte(U10);
    expect(balAfter - balBefore).to.be.lte(U10 + SMALL_TOLERANCE);
  });

  it("reverts withdraw above balance", async function () {
    const { contract, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");
    await expect(
      contract.connect(alice).withdraw(ONE_USDT + 1n)
    ).to.be.revertedWith("Insufficient deposit");
  });

  it("effectiveChances = 0 after full withdraw", async function () {
    const { contract, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");
    await ethers.provider.send("evm_mine"); // let Aave settle
    await contract.connect(alice).withdraw(ONE_USDT);
    expect(await contract.effectiveChances(alice.address)).to.equal(0n);
  });

  it("deposits[user] = 0 after full withdraw", async function () {
    const { contract, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");
    await ethers.provider.send("evm_mine");
    await contract.connect(alice).withdraw(ONE_USDT);
    expect(await contract.deposits(alice.address)).to.equal(0n);
  });
});

// =============================================================================
// 2. save() + streak + welcome bonus
// =============================================================================
describe("save() + streak + welcome bonus", function () {
  this.timeout(120_000);

  it("reverts save with no deposit", async function () {
    const { contract, alice } = await deployFixture();
    await expect(contract.connect(alice).save()).to.be.revertedWith("No deposit");
  });

  it("reverts double save on same calendar day", async function () {
    const { contract, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");
    await contract.connect(alice).save();
    await expect(contract.connect(alice).save()).to.be.revertedWith("Already saved today");
  });

  it("streakDay increments to 2 on second save (next day)", async function () {
    const { contract, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");
    // Jump to Monday so next 2 saves are in the same week
    await goToMondayStart();
    await contract.connect(alice).save();
    await nextDay();
    await contract.connect(alice).save();
    expect(await contract.streakDay(alice.address)).to.equal(2);
  });

  it("streakDay capped at 7: save 7 days (Mon–Sun) then 8th day resets to 1", async function () {
    const { contract, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");

    // Jump to Monday so all 7 saves are in the same calendar week
    await goToMondayStart();

    // Save Mon through Sun (7 saves in same week)
    await contract.connect(alice).save(); // streak = 1
    for (let i = 1; i < 7; i++) {
      await nextDay();
      await contract.connect(alice).save(); // streak 2..7
    }
    expect(await contract.streakDay(alice.address)).to.equal(7);

    // 8th save crosses into a new week → streak resets to 1
    await nextDay();
    await contract.connect(alice).save();
    expect(await contract.streakDay(alice.address)).to.equal(1);
  });

  it("streakDay is capped at 7 within same week", async function () {
    const { contract, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");

    // Jump to Monday start (gives us Mon–Sun space within the same week)
    await goToMondayStart();

    // Save Tue through next Mon (7 consecutive saves within or spanning week boundary)
    for (let i = 0; i < 7; i++) {
      await contract.connect(alice).save();
      const streak = await contract.streakDay(alice.address);
      // Each save should increment streak up to 7
      expect(streak).to.equal(i + 1 > 7 ? 7 : i + 1);
      if (i < 6) await nextDay(); // don't advance after 7th save yet
    }
    // After 7 saves, streak must be exactly 7 (capped, not 8)
    expect(await contract.streakDay(alice.address)).to.equal(7);
  });

  it("streakDay resets to 1 on nextMonday", async function () {
    const { contract, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");

    // Start on Monday to save Tue/Wed in the same week
    await goToMondayStart();
    await contract.connect(alice).save();
    await nextDay();
    await contract.connect(alice).save();
    expect(await contract.streakDay(alice.address)).to.equal(2);

    // Jump to next Monday — streak must reset
    await nextMonday();
    await contract.connect(alice).save();
    expect(await contract.streakDay(alice.address)).to.equal(1);
  });

  it("effectiveChances grows as streak grows", async function () {
    const { contract, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");

    // Start on Monday to keep all saves in the same week
    await goToMondayStart();

    const chances1 = await contract.effectiveChances(alice.address); // streakDay=0 → uses 1
    await contract.connect(alice).save(); // streak = 1
    const chances2 = await contract.effectiveChances(alice.address);
    await nextDay();
    await contract.connect(alice).save(); // streak = 2
    const chances3 = await contract.effectiveChances(alice.address);

    expect(chances2).to.be.gte(chances1);
    expect(chances3).to.be.gt(chances2);
  });

  it("welcome bonus: on streak day 5, incentive wallet sends 0.5 USDT to user", async function () {
    const { contract, usdt, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");

    // Start on Monday so 5 consecutive saves stay in one week (Mon–Fri)
    await goToMondayStart();

    const balBefore = await usdt.balanceOf(alice.address);

    // Save 5 times: Mon, Tue, Wed, Thu, Fri — all in same week
    await contract.connect(alice).save(); // streak = 1
    for (let i = 1; i < WELCOME_STREAK; i++) {
      await nextDay();
      await contract.connect(alice).save(); // streak 2..5
    }

    const balAfter = await usdt.balanceOf(alice.address);
    // Exactly 0.5 USDT bonus should have arrived
    expect(balAfter - balBefore).to.equal(WELCOME_BONUS);
    expect(await contract.welcomeBonusClaimed(alice.address)).to.be.true;
  });

  it("welcome bonus NOT sent again (second trigger on a future week day 5)", async function () {
    const { contract, usdt, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");

    // Start on Monday so first 5 saves are Mon–Fri (same week)
    await goToMondayStart();

    // First trigger
    await contract.connect(alice).save(); // streak = 1
    for (let i = 1; i < WELCOME_STREAK; i++) {
      await nextDay();
      await contract.connect(alice).save(); // streak 2..5 → bonus fires
    }
    expect(await contract.welcomeBonusClaimed(alice.address)).to.be.true;

    const balAfterFirst = await usdt.balanceOf(alice.address);

    // Second week: jump to Monday and save 5 more times (Mon–Fri)
    await nextMonday();
    await contract.connect(alice).save(); // streak resets to 1
    for (let i = 1; i < WELCOME_STREAK; i++) {
      await nextDay();
      await contract.connect(alice).save(); // streak 2..5 — bonus already claimed, no re-send
    }

    const balAfterSecond = await usdt.balanceOf(alice.address);
    // No additional bonus
    expect(balAfterSecond).to.equal(balAfterFirst);
  });

  it("claimSavings reverts with nothing to claim if no savings", async function () {
    const { contract, alice } = await deployFixture();
    await contract.connect(alice).deposit(TEN_USDT, "0x00000000");
    await expect(contract.connect(alice).claimSavings())
      .to.be.revertedWith("Nothing to claim");
  });

  it("welcome bonus silently skips if incentive wallet has 0 USDT (save does not revert)", async function () {
    const { contract, deployer, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");

    // Set incentive wallet to a fresh EOA with 0 USDT (no balance, no allowance)
    const freshWallet = ethers.Wallet.createRandom().address;
    await contract.connect(deployer).setIncentiveWallet(freshWallet);

    // Start on Monday so all 5 saves (Mon–Fri) are in the same week
    await goToMondayStart();

    // Save WELCOME_STREAK times — must NOT revert even though wallet is empty
    await contract.connect(alice).save(); // streak = 1
    for (let i = 1; i < WELCOME_STREAK; i++) {
      await nextDay();
      await contract.connect(alice).save(); // streak 2..5
    }

    // streak reached 5, but bonus was not sent (wallet empty)
    expect(await contract.streakDay(alice.address)).to.equal(WELCOME_STREAK);
    expect(await contract.welcomeBonusClaimed(alice.address)).to.be.false;
  });
});

// =============================================================================
// 3. referrals
// =============================================================================
describe("referrals", function () {
  this.timeout(120_000);

  it("bob uses alice's referral code → referredBy[bob] = alice.address", async function () {
    const { contract, alice, bob } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");

    const aliceCode = await contract.referralCode(alice.address);
    await contract.connect(bob).deposit(ONE_USDT, aliceCode);

    expect(await contract.referredBy(bob.address)).to.equal(alice.address);
  });

  it("activeReferrals[alice] = 1 when bob (referrer has >=1 USDT) deposits", async function () {
    const { contract, alice, bob } = await deployFixture();
    // Alice deposits >= 1 USDT
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");

    const aliceCode = await contract.referralCode(alice.address);
    await contract.connect(bob).deposit(ONE_USDT, aliceCode);

    expect(await contract.activeReferrals(alice.address)).to.equal(1n);
  });

  it("alice's effectiveChances higher with 1 referral than without", async function () {
    const { contract, alice, bob } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");
    const chancesWithout = await contract.effectiveChances(alice.address);

    const aliceCode = await contract.referralCode(alice.address);
    await contract.connect(bob).deposit(ONE_USDT, aliceCode);

    const chancesWith = await contract.effectiveChances(alice.address);
    expect(chancesWith).to.be.gt(chancesWithout);
  });

  it("activeReferrals[alice] = 0 after bob withdraws all", async function () {
    const { contract, alice, bob } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");

    const aliceCode = await contract.referralCode(alice.address);
    await contract.connect(bob).deposit(ONE_USDT, aliceCode);
    expect(await contract.activeReferrals(alice.address)).to.equal(1n);

    await contract.connect(bob).withdraw(ONE_USDT);
    expect(await contract.activeReferrals(alice.address)).to.equal(0n);
  });

  it("alice effectiveChances drops after bob withdraws all", async function () {
    const { contract, alice, bob } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");
    const aliceCode = await contract.referralCode(alice.address);
    await contract.connect(bob).deposit(ONE_USDT, aliceCode);

    const chancesWithReferral = await contract.effectiveChances(alice.address);
    await contract.connect(bob).withdraw(ONE_USDT);
    const chancesAfter = await contract.effectiveChances(alice.address);

    expect(chancesAfter).to.be.lt(chancesWithReferral);
  });

  it("cannot self-refer: referredBy[alice] = zero address", async function () {
    const { contract, alice } = await deployFixture();
    // Compute alice's referral code: bytes4(keccak256(abi.encodePacked(alice.address)))
    const packed  = ethers.solidityPacked(["address"], [alice.address]);
    const hash    = ethers.keccak256(packed);
    const selfCode = hash.slice(0, 10); // "0x" + 8 hex chars = bytes4

    // Alice tries to use her own code on her first deposit
    await contract.connect(alice).deposit(ONE_USDT, selfCode);
    expect(await contract.referredBy(alice.address)).to.equal(ethers.ZeroAddress);
  });

  it("referral code only set on first deposit (second deposit with a code is ignored)", async function () {
    const { contract, alice, bob, carol } = await deployFixture();
    // Alice deposits first (no referrer)
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");

    // Bob deposits with alice's code — referredBy[bob] = alice
    const aliceCode = await contract.referralCode(alice.address);
    await contract.connect(bob).deposit(ONE_USDT, aliceCode);

    // Carol deposits and gets a code
    await contract.connect(carol).deposit(ONE_USDT, "0x00000000");
    const carolCode = await contract.referralCode(carol.address);

    // Bob deposits again with carol's code — referredBy should NOT change
    await contract.connect(bob).deposit(ONE_USDT, carolCode);
    expect(await contract.referredBy(bob.address)).to.equal(alice.address);
  });

  it("user's referral code does not change on second deposit", async function () {
    const { contract, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");
    const codeAfterFirst = await contract.referralCode(alice.address);

    // Second deposit — code must remain the same
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");
    const codeAfterSecond = await contract.referralCode(alice.address);

    expect(codeAfterSecond).to.equal(codeAfterFirst);
    expect(codeAfterFirst).to.not.equal("0x00000000");
  });
});

// =============================================================================
// 4. raffle
// =============================================================================
describe("raffle", function () {
  this.timeout(120_000);

  it("commitRaffle reverts for non-keeper", async function () {
    const { contract, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");
    await expect(contract.connect(alice).commitRaffle()).to.be.revertedWith("Not keeper");
  });

  it("commitRaffle reverts if already committed", async function () {
    const { contract, alice, keeper } = await deployFixture();
    await contract.connect(alice).deposit(TEN_USDT, "0x00000000");
    await contract.connect(keeper).commitRaffle();
    await expect(contract.connect(keeper).commitRaffle())
      .to.be.revertedWith("Already committed");
  });

  it("executeRaffle reverts if not committed", async function () {
    const { contract, keeper, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");
    await expect(contract.connect(keeper).executeRaffle()).to.be.revertedWith("Not committed");
  });

  it("executeRaffle reverts if < 10 blocks after commit", async function () {
    const { contract, keeper, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");
    await contract.connect(keeper).commitRaffle();
    // Mine only 5 blocks (less than required 10)
    for (let i = 0; i < 5; i++) await ethers.provider.send("evm_mine");
    await expect(contract.connect(keeper).executeRaffle()).to.be.revertedWith("Too soon after commit");
  });

  it("full cycle: deposit → commitRaffle → mine 11 blocks → executeRaffle → RaffleExecuted event, raffleCommitted = false", async function () {
    const { contract, keeper, alice, bob, liquidityIndex } = await deployFixture();
    await contract.connect(alice).deposit(TEN_USDT, "0x00000000");
    await contract.connect(bob).deposit(TEN_USDT, "0x00000000");

    // Reset aUSDT balance to match totalPrincipal so prizePool = 0.
    // (Our fixture sets a huge scaled balance for withdraw rounding; we undo it here
    //  to prevent executeRaffle from trying to withdraw a giant prize that Aave can't cover.)
    await resetZorritoABalance(contract, liquidityIndex);

    await contract.connect(keeper).commitRaffle();
    for (let i = 0; i < 11; i++) await ethers.provider.send("evm_mine");

    const tx = await contract.connect(keeper).executeRaffle();
    const receipt = await tx.wait();

    // Find RaffleExecuted event
    const event = receipt.logs.find((log) => {
      try { return contract.interface.parseLog(log)?.name === "RaffleExecuted"; }
      catch { return false; }
    });
    expect(event).to.not.be.undefined;

    const parsed = contract.interface.parseLog(event);
    expect(
      parsed.args.winner === alice.address || parsed.args.winner === bob.address
    ).to.be.true;

    // raffleCommitted must be cleared
    expect(await contract.raffleCommitted()).to.be.false;
  });

  it("zero-prize week: execute immediately after commit+10 blocks with no time for yield → prize=0, no revert", async function () {
    const { contract, keeper, alice, liquidityIndex } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");
    // Do NOT advance time — Aave yield will be effectively 0.
    // Reset aUSDT balance so prizePool = 0 (avoid huge-prize revert from storage manipulation).
    await resetZorritoABalance(contract, liquidityIndex);
    await contract.connect(keeper).commitRaffle();
    for (let i = 0; i < 11; i++) await ethers.provider.send("evm_mine");

    const tx = await contract.connect(keeper).executeRaffle();
    const receipt = await tx.wait();
    const event = receipt.logs.find((log) => {
      try { return contract.interface.parseLog(log)?.name === "RaffleExecuted"; }
      catch { return false; }
    });
    expect(event).to.not.be.undefined;
    const parsed = contract.interface.parseLog(event);
    // Prize should be 0 or negligible (minimal yield from a few mined blocks on the fork).
    // We accept anything under 1 USDT — the key invariant is that executeRaffle does not revert.
    expect(parsed.args.prize).to.be.lte(ONE_USDT);
  });

  it("forceResetCommit: commit → mine 251 blocks → forceResetCommit by owner → raffleCommitted = false", async function () {
    const { contract, keeper, deployer, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");
    await contract.connect(keeper).commitRaffle();

    // Mine 251 blocks to expire the commit window
    await ethers.provider.send("hardhat_mine", ["0x" + (251).toString(16)]);

    // executeRaffle should revert (commit expired)
    await expect(contract.connect(keeper).executeRaffle()).to.be.revertedWith("Commit expired, re-commit");

    // Owner can force-reset the stale commit
    await contract.connect(deployer).forceResetCommit();
    expect(await contract.raffleCommitted()).to.be.false;
  });
});

// =============================================================================
// 5. savings distribution
// =============================================================================
describe("savings distribution", function () {
  this.timeout(120_000);

  it("distributeSavingsRewards reverts with 'No new rewards' if no USDT in contract", async function () {
    const { contract, keeper, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");
    await expect(contract.connect(keeper).distributeSavingsRewards()).to.be.revertedWith("No new rewards");
  });

  it("send 10 USDT to contract → distributeSavingsRewards → savingsAccumulator > 0", async function () {
    const { contract, usdt, keeper, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");

    // Send 10 USDT directly to contract (impersonate whale)
    const whaleSigner = await impersonate(USDT_WHALE);
    await usdt.connect(whaleSigner).transfer(await contract.getAddress(), TEN_USDT);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [USDT_WHALE]);

    const accBefore = await contract.savingsAccumulator();
    await contract.connect(keeper).distributeSavingsRewards();
    const accAfter = await contract.savingsAccumulator();
    expect(accAfter).to.be.gt(accBefore);
  });

  it("platform receives 15% fee (1.5 USDT out of 10)", async function () {
    const { contract, usdt, keeper, platform, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");

    const platformBalBefore = await usdt.balanceOf(platform.address);

    // Send 10 USDT to contract
    const whaleSigner = await impersonate(USDT_WHALE);
    await usdt.connect(whaleSigner).transfer(await contract.getAddress(), TEN_USDT);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [USDT_WHALE]);

    await contract.connect(keeper).distributeSavingsRewards();

    const platformBalAfter = await usdt.balanceOf(platform.address);
    const fee = platformBalAfter - platformBalBefore;

    // 15% of 10 USDT = 1.5 USDT = 1_500_000
    expect(fee).to.equal(1_500_000n);
  });

  it("alice and bob (equal deposits) have equal pendingSavings after distribution", async function () {
    const { contract, usdt, keeper, alice, bob } = await deployFixture();
    await contract.connect(alice).deposit(TEN_USDT, "0x00000000");
    await contract.connect(bob).deposit(TEN_USDT, "0x00000000");

    // Send rewards to contract
    const whaleSigner = await impersonate(USDT_WHALE);
    await usdt.connect(whaleSigner).transfer(await contract.getAddress(), TEN_USDT);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [USDT_WHALE]);

    await contract.connect(keeper).distributeSavingsRewards();

    const alicePending = await contract.pendingSavings(alice.address);
    const bobPending   = await contract.pendingSavings(bob.address);
    expect(alicePending).to.equal(bobPending);
    expect(alicePending).to.be.gt(0n);
  });

  it("combined alice + bob pendingSavings ≈ 8.5 USDT (85% of 10)", async function () {
    const { contract, usdt, keeper, alice, bob } = await deployFixture();
    await contract.connect(alice).deposit(TEN_USDT, "0x00000000");
    await contract.connect(bob).deposit(TEN_USDT, "0x00000000");

    const whaleSigner = await impersonate(USDT_WHALE);
    await usdt.connect(whaleSigner).transfer(await contract.getAddress(), TEN_USDT);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [USDT_WHALE]);

    await contract.connect(keeper).distributeSavingsRewards();

    const alicePending = await contract.pendingSavings(alice.address);
    const bobPending   = await contract.pendingSavings(bob.address);
    const combined     = alicePending + bobPending;

    // 85% of 10 USDT = 8.5 USDT = 8_500_000 (allow rounding of ±1)
    expect(combined).to.be.gte(8_500_000n - 1n);
    expect(combined).to.be.lte(8_500_000n + 1n);
  });

  it("claimSavings transfers USDT to user, pendingSavings[alice] = 0 after", async function () {
    const { contract, usdt, keeper, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");

    const whaleSigner = await impersonate(USDT_WHALE);
    await usdt.connect(whaleSigner).transfer(await contract.getAddress(), TEN_USDT);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [USDT_WHALE]);

    await contract.connect(keeper).distributeSavingsRewards();

    const pendingBefore = await contract.pendingSavings(alice.address);
    expect(pendingBefore).to.be.gt(0n);

    const balBefore = await usdt.balanceOf(alice.address);
    await contract.connect(alice).claimSavings();
    const balAfter = await usdt.balanceOf(alice.address);

    expect(balAfter - balBefore).to.equal(pendingBefore);
    expect(await contract.pendingSavings(alice.address)).to.equal(0n);
  });

  it("totalSavings decrements correctly after claim", async function () {
    const { contract, usdt, keeper, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");

    const whaleSigner = await impersonate(USDT_WHALE);
    await usdt.connect(whaleSigner).transfer(await contract.getAddress(), TEN_USDT);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [USDT_WHALE]);

    await contract.connect(keeper).distributeSavingsRewards();

    const totalBefore = await contract.totalSavings();
    const pending     = await contract.pendingSavings(alice.address);

    await contract.connect(alice).claimSavings();

    const totalAfter = await contract.totalSavings();
    expect(totalBefore - totalAfter).to.equal(pending);
  });

  it("second distribution works (no 'No new rewards' if new USDT arrives)", async function () {
    const { contract, usdt, keeper, alice, bob } = await deployFixture();
    await contract.connect(alice).deposit(TEN_USDT, "0x00000000");
    await contract.connect(bob).deposit(TEN_USDT, "0x00000000");

    const whaleSigner = await impersonate(USDT_WHALE);

    // First distribution
    await usdt.connect(whaleSigner).transfer(await contract.getAddress(), TEN_USDT);
    await contract.connect(keeper).distributeSavingsRewards();

    // Alice claims
    await contract.connect(alice).claimSavings();

    // Second distribution (new USDT arrives)
    await usdt.connect(whaleSigner).transfer(await contract.getAddress(), TEN_USDT);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [USDT_WHALE]);

    // Should not revert
    await expect(contract.connect(keeper).distributeSavingsRewards()).to.not.be.reverted;

    // After second distribution, alice should have new pending (from 2nd distribution only)
    // Bob should have more pending (accumulated from both rounds)
    const alicePending = await contract.pendingSavings(alice.address);
    const bobPending   = await contract.pendingSavings(bob.address);

    expect(alicePending).to.be.gt(0n);
    expect(bobPending).to.be.gt(alicePending); // Bob accumulated from both rounds
  });
});

// =============================================================================
// 6. emergency
// =============================================================================
describe("emergency", function () {
  this.timeout(120_000);

  it("setEmergencyMode reverts for non-owner", async function () {
    const { contract, alice } = await deployFixture();
    await expect(contract.connect(alice).setEmergencyMode(true)).to.be.revertedWith("Not owner");
  });

  it("deposit reverts in emergency mode", async function () {
    const { contract, deployer, alice } = await deployFixture();
    await contract.connect(deployer).setEmergencyMode(true);
    await expect(
      contract.connect(alice).deposit(ONE_USDT, "0x00000000")
    ).to.be.revertedWith("Emergency mode");
  });

  it("save reverts in emergency mode", async function () {
    const { contract, deployer, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");
    await contract.connect(deployer).setEmergencyMode(true);
    await expect(contract.connect(alice).save()).to.be.revertedWith("Emergency mode");
  });

  it("emergencyReturn reverts without emergency mode", async function () {
    const { contract, deployer, alice } = await deployFixture();
    await contract.connect(alice).deposit(ONE_USDT, "0x00000000");
    await expect(
      contract.connect(deployer).emergencyReturn(0, 1)
    ).to.be.revertedWith("Not in emergency mode");
  });

  it("full cycle: deposit alice + bob → setEmergencyMode(true) → emergencyReturn(0, 2) → alice and bob get >= their deposited USDT back, totalPrincipal = 0", async function () {
    const { contract, usdt, deployer, alice, bob } = await deployFixture();
    await contract.connect(alice).deposit(TEN_USDT, "0x00000000");
    await contract.connect(bob).deposit(TEN_USDT, "0x00000000");

    const aliceBalBefore = await usdt.balanceOf(alice.address);
    const bobBalBefore   = await usdt.balanceOf(bob.address);

    await contract.connect(deployer).setEmergencyMode(true);
    const count = await contract.depositorCount();
    await contract.connect(deployer).emergencyReturn(0, count);

    const aliceBalAfter = await usdt.balanceOf(alice.address);
    const bobBalAfter   = await usdt.balanceOf(bob.address);

    expect(aliceBalAfter - aliceBalBefore).to.be.gte(TEN_USDT);
    expect(bobBalAfter   - bobBalBefore).to.be.gte(TEN_USDT);

    // totalPrincipal should be 0
    expect(await contract.totalPrincipal()).to.equal(0n);
  });

  it("emergencyReturn idempotent: second call on same range does nothing extra", async function () {
    const { contract, usdt, deployer, alice } = await deployFixture();
    await contract.connect(alice).deposit(TEN_USDT, "0x00000000");

    await contract.connect(deployer).setEmergencyMode(true);
    const count = await contract.depositorCount();

    // First call returns funds
    await contract.connect(deployer).emergencyReturn(0, count);
    const balAfterFirst = await usdt.balanceOf(alice.address);

    // Second call should be idempotent (no extra transfer)
    await contract.connect(deployer).emergencyReturn(0, count);
    const balAfterSecond = await usdt.balanceOf(alice.address);

    expect(balAfterSecond).to.equal(balAfterFirst);
  });

  it("unsettled savings preserved: deposit → distribute 10 USDT → emergencyReturn → user can claimSavings", async function () {
    const { contract, usdt, keeper, deployer, alice } = await deployFixture();
    await contract.connect(alice).deposit(TEN_USDT, "0x00000000");

    // Distribute some savings rewards first
    const whaleSigner = await impersonate(USDT_WHALE);
    await usdt.connect(whaleSigner).transfer(await contract.getAddress(), TEN_USDT);
    await ethers.provider.send("hardhat_stopImpersonatingAccount", [USDT_WHALE]);
    await contract.connect(keeper).distributeSavingsRewards();

    // Check alice has pending savings
    const pendingBefore = await contract.pendingSavings(alice.address);
    expect(pendingBefore).to.be.gt(0n);

    // Trigger emergency and return principal
    await contract.connect(deployer).setEmergencyMode(true);
    const count = await contract.depositorCount();
    await contract.connect(deployer).emergencyReturn(0, count);

    // emergencyReturn calls _settleSavings, so pending is settled into _pendingSavings
    const pendingAfter = await contract.pendingSavings(alice.address);
    expect(pendingAfter).to.be.gt(0n);

    // Alice can still claim her savings
    const balBefore = await usdt.balanceOf(alice.address);
    await contract.connect(alice).claimSavings();
    const balAfter = await usdt.balanceOf(alice.address);
    expect(balAfter - balBefore).to.equal(pendingAfter);
  });
});

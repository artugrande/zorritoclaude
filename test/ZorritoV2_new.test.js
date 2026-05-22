// test/ZorritoV2_new.test.js
// Tests for the NEW V2 contract — daily deposit, no save(), UTC-day-based streak.
// Run with: npx hardhat test test/ZorritoV2_new.test.js --network hardhat

const { expect } = require("chai");
const { ethers } = require("hardhat");

// ── On-chain addresses (Celo Mainnet) ──────────────────────────────────────
const USDT_ADDR  = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const AAVE_ADDR  = "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402";
const AUSDT_ADDR = "0xDeE98402A302e4D707fB9bf2bac66fAEEc31e8Df";
const USDT_WHALE = "0xf6436829Cf96EA0f8BC49d300c536FCC4f84C4ED";

const MIN_DEPOSIT    = 250_000n;
const WELCOME_BONUS  = 500_000n;
const DAY            = 86400n;
const ZERO4          = "0x00000000";

async function advance(seconds) {
  await ethers.provider.send("evm_increaseTime", [Number(seconds)]);
  await ethers.provider.send("evm_mine");
}
async function nextDay() { await advance(DAY + 1n); }

async function deploy() {
  const [owner, platform, keeper, alice, bob, sponsor, incentive] = await ethers.getSigners();

  // Impersonate USDT whale + fund test signers
  await ethers.provider.send("hardhat_impersonateAccount", [USDT_WHALE]);
  await ethers.provider.send("hardhat_setBalance", [USDT_WHALE, "0x1000000000000000000"]);
  const whale = await ethers.getSigner(USDT_WHALE);
  const usdt = await ethers.getContractAt("IERC20", USDT_ADDR);

  for (const s of [alice, bob, sponsor, incentive]) {
    await usdt.connect(whale).transfer(s.address, 1_000_000_000n); // 1000 USDT each
  }

  const Z = await ethers.getContractFactory("ZorritoV2");
  const c = await Z.deploy(USDT_ADDR, AAVE_ADDR, AUSDT_ADDR, platform.address, keeper.address);
  await c.waitForDeployment();

  // Approvals
  for (const s of [alice, bob, sponsor]) {
    await usdt.connect(s).approve(await c.getAddress(), ethers.MaxUint256);
  }

  // Set up welcome bonus source
  await c.setIncentiveWallet(incentive.address);
  await usdt.connect(incentive).approve(await c.getAddress(), ethers.MaxUint256);

  return { c, usdt, owner, platform, keeper, alice, bob, sponsor, incentive };
}

describe("ZorritoV2 (new) — streak mechanics", () => {
  it("first deposit sets streakDay=1 and lastDepositDay=today", async () => {
    const { c, alice } = await deploy();
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4);
    expect(await c.streakDay(alice.address)).to.equal(1);
    const block = await ethers.provider.getBlock("latest");
    expect(await c.lastDepositDay(alice.address)).to.equal(BigInt(block.timestamp) / DAY);
  });

  it("same-day second deposit does NOT change streak (no revert, just adds USDT)", async () => {
    const { c, alice } = await deploy();
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4);
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4); // same day
    expect(await c.streakDay(alice.address)).to.equal(1);
    expect(await c.deposits(alice.address)).to.equal(MIN_DEPOSIT * 2n);
  });

  it("next-day deposit increments streak to 2", async () => {
    const { c, alice } = await deploy();
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4);
    await nextDay();
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4);
    expect(await c.streakDay(alice.address)).to.equal(2);
  });

  it("7 consecutive days caps streak at 7", async () => {
    const { c, alice } = await deploy();
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4); // day 1
    for (let i = 0; i < 9; i++) {
      await nextDay();
      await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4);
    }
    expect(await c.streakDay(alice.address)).to.equal(7);
  });

  it("skipping 2+ days resets streak to 1 (revival)", async () => {
    const { c, alice } = await deploy();
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4); // day 1
    await nextDay();
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4); // day 2, streak=2
    expect(await c.streakDay(alice.address)).to.equal(2);
    await advance(3n * DAY); // skip 3 days
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4);
    expect(await c.streakDay(alice.address)).to.equal(1); // revival
  });

  it("welcome bonus claimed once streak reaches WELCOME_STREAK days", async () => {
    const { c, usdt, alice, incentive } = await deploy();
    const incBefore = await usdt.balanceOf(incentive.address);
    const aliceBefore = await usdt.balanceOf(alice.address);

    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4); // streak 1
    for (let i = 0; i < 4; i++) {
      await nextDay();
      await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4); // streak 2,3,4,5
    }
    expect(await c.streakDay(alice.address)).to.equal(5);
    expect(await c.welcomeBonusClaimed(alice.address)).to.equal(true);

    const incAfter = await usdt.balanceOf(incentive.address);
    const aliceAfter = await usdt.balanceOf(alice.address);
    expect(incBefore - incAfter).to.equal(WELCOME_BONUS);
    // Alice: -5 × 0.25 deposit + 0.5 bonus = -0.75 net
    expect(aliceBefore - aliceAfter).to.equal(MIN_DEPOSIT * 5n - WELCOME_BONUS);
  });

  it("welcome bonus is one-shot (not paid twice on subsequent days)", async () => {
    const { c, usdt, alice, incentive } = await deploy();
    for (let i = 0; i < 6; i++) {
      await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4);
      await nextDay();
    }
    const incAfter5 = await usdt.balanceOf(incentive.address);
    // 1 more deposit — bonus should not fire again
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4);
    expect(await usdt.balanceOf(incentive.address)).to.equal(incAfter5);
  });
});

describe("ZorritoV2 (new) — depositFor (sponsorship)", () => {
  it("sponsor pays USDT, beneficiary gets deposit + streak", async () => {
    const { c, usdt, sponsor, bob } = await deploy();
    const sponsorBefore = await usdt.balanceOf(sponsor.address);
    const bobBefore = await usdt.balanceOf(bob.address);
    await c.connect(sponsor).depositFor(bob.address, MIN_DEPOSIT, ZERO4);
    expect(await c.deposits(bob.address)).to.equal(MIN_DEPOSIT);
    expect(await c.streakDay(bob.address)).to.equal(1);
    expect(await usdt.balanceOf(sponsor.address)).to.equal(sponsorBefore - MIN_DEPOSIT);
    expect(await usdt.balanceOf(bob.address)).to.equal(bobBefore); // bob untouched
  });

  it("depositFor extends beneficiary's streak on next day", async () => {
    const { c, sponsor, bob } = await deploy();
    await c.connect(sponsor).depositFor(bob.address, MIN_DEPOSIT, ZERO4);
    await nextDay();
    await c.connect(sponsor).depositFor(bob.address, MIN_DEPOSIT, ZERO4);
    expect(await c.streakDay(bob.address)).to.equal(2);
  });

  it("depositFor reverts on zero beneficiary", async () => {
    const { c, sponsor } = await deploy();
    await expect(c.connect(sponsor).depositFor(ethers.ZeroAddress, MIN_DEPOSIT, ZERO4))
      .to.be.revertedWith("Zero beneficiary");
  });

  it("depositFor activates beneficiary's referral if they were referred", async () => {
    const { c, alice, sponsor, bob } = await deploy();
    // Alice deposits first → gets a refCode
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4);
    const aliceCode = await c.referralCode(alice.address);
    // Bob is sponsored, referred by Alice
    await c.connect(sponsor).depositFor(bob.address, MIN_DEPOSIT, aliceCode);
    expect(await c.referredBy(bob.address)).to.equal(alice.address);
    expect(await c.activeReferrals(alice.address)).to.equal(1n);
  });
});

describe("ZorritoV2 (new) — getStatus view", () => {
  it("returns (false, 0, 0, 0) for non-depositors", async () => {
    const { c, alice } = await deploy();
    const [alive, s, deadline, secs] = await c.getStatus(alice.address);
    expect(alive).to.equal(false);
    expect(s).to.equal(0);
    expect(deadline).to.equal(0n);
    expect(secs).to.equal(0n);
  });

  it("alive=true and counts down within window after deposit", async () => {
    const { c, alice } = await deploy();
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4);
    const [alive, s, deadline, secs] = await c.getStatus(alice.address);
    expect(alive).to.equal(true);
    expect(s).to.equal(1);
    expect(secs).to.be.gt(0n);
    expect(secs).to.be.lte(2n * DAY); // at most 48h (deposited at very start of day)
  });

  it("alive=false after 2+ day gap", async () => {
    const { c, alice } = await deploy();
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4);
    await advance(3n * DAY); // skip 3 days
    const [alive, s, , secs] = await c.getStatus(alice.address);
    expect(alive).to.equal(false);
    expect(s).to.equal(0);
    expect(secs).to.equal(0n);
  });

  it("deadlineTimestamp = (lastDepositDay + 2) * 86400", async () => {
    const { c, alice } = await deploy();
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4);
    const lastDay = await c.lastDepositDay(alice.address);
    const [, , deadline] = await c.getStatus(alice.address);
    expect(deadline).to.equal((lastDay + 2n) * DAY);
  });
});

describe("ZorritoV2 (new) — withdraw resets streak on full withdraw", () => {
  it("partial withdraw preserves streak", async () => {
    const { c, alice } = await deploy();
    await c.connect(alice).deposit(MIN_DEPOSIT * 4n, ZERO4); // 1 USDT, streak=1
    await c.connect(alice).withdraw(MIN_DEPOSIT * 2n); // withdraw half
    expect(await c.streakDay(alice.address)).to.equal(1);
    expect(await c.lastDepositDay(alice.address)).to.be.gt(0n);
  });

  it("full withdraw resets streak and lastDepositDay to 0", async () => {
    const { c, alice } = await deploy();
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4);
    await nextDay();
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4); // streak=2
    expect(await c.streakDay(alice.address)).to.equal(2);
    await c.connect(alice).withdraw(MIN_DEPOSIT * 2n); // withdraw all
    expect(await c.streakDay(alice.address)).to.equal(0);
    expect(await c.lastDepositDay(alice.address)).to.equal(0n);
  });

  it("re-deposit after full withdraw starts streak from 1", async () => {
    const { c, alice } = await deploy();
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4);
    await nextDay();
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4);
    await c.connect(alice).withdraw(MIN_DEPOSIT * 2n);
    // Re-deposit
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4);
    expect(await c.streakDay(alice.address)).to.equal(1);
  });
});

describe("ZorritoV2 (new) — regressions: existing features unchanged", () => {
  it("emergencyMode blocks deposit", async () => {
    const { c, owner, alice } = await deploy();
    await c.connect(owner).setEmergencyMode(true);
    await expect(c.connect(alice).deposit(MIN_DEPOSIT, ZERO4)).to.be.revertedWith("Emergency mode");
  });

  it("emergencyReturn sends USDT back to depositor", async () => {
    const { c, usdt, owner, alice } = await deploy();
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4);
    const balBefore = await usdt.balanceOf(alice.address);
    await c.connect(owner).setEmergencyMode(true);
    await c.connect(owner).emergencyReturn(0, 1);
    expect(await usdt.balanceOf(alice.address)).to.be.gte(balBefore + MIN_DEPOSIT - 10n);
  });

  it("withdraw deposits work normally", async () => {
    const { c, alice } = await deploy();
    await c.connect(alice).deposit(MIN_DEPOSIT * 4n, ZERO4);
    await c.connect(alice).withdraw(MIN_DEPOSIT * 4n);
    expect(await c.deposits(alice.address)).to.equal(0n);
  });

  it("effectiveChances uses NEW streak after deposit", async () => {
    const { c, alice } = await deploy();
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4); // streak 1
    const c1 = await c.effectiveChances(alice.address);
    await nextDay();
    await c.connect(alice).deposit(MIN_DEPOSIT, ZERO4); // streak 2, deposit doubled
    const c2 = await c.effectiveChances(alice.address);
    // streak 2, deposit = 0.5 USDT → chances = 500_000 * 2 = 1_000_000
    // vs streak 1, deposit = 0.25 USDT → chances = 250_000
    expect(c2).to.equal(MIN_DEPOSIT * 2n * 2n); // 1_000_000
    expect(c1).to.equal(MIN_DEPOSIT * 1n);      //   250_000
  });

  it("does NOT have save() function anymore", async () => {
    const { c } = await deploy();
    expect(c.save).to.equal(undefined);
  });
});

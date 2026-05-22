const { expect }       = require("chai");
const { ethers }       = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

// ── Constants matching the contract ───────────────────────────────────────────
const ONE_USDT      = 1_000_000n;          // 1 USDT (6 decimals)
const FEED_INTERVAL = 24 * 60 * 60;        // 1 day in seconds
const DRAW_INTERVAL = 365 * 24 * 60 * 60;  // 365 days in seconds
const GENESIS       = 1_767_225_600;        // Jan 1 2026 UTC

// ── Fixture ────────────────────────────────────────────────────────────────────
// loadFixture() snapshots the chain after first call and restores it for each
// test that uses it — so time advances in one test don't bleed into the next.
async function deployFixture() {
  const [owner, alice, bob, carol] = await ethers.getSigners();

  const MockERC20 = await ethers.getContractFactory("MockERC20");
  const MockAave  = await ethers.getContractFactory("MockAavePool");

  const usdt  = await MockERC20.deploy("USD Tether", "USDT",  6);
  const aUsdt = await MockERC20.deploy("Aave USDT",  "aUSDT", 6);
  const aave  = await MockAave.deploy(
    await usdt.getAddress(),
    await aUsdt.getAddress(),
  );

  const Zorrito = await ethers.getContractFactory("Zorrito");
  const zorrito = await Zorrito.deploy(
    await usdt.getAddress(),
    await aave.getAddress(),
    await aUsdt.getAddress(),
  );

  const zAddr = await zorrito.getAddress();

  // Fund users and pre-approve infinite spend
  for (const user of [alice, bob, carol]) {
    await usdt.mint(user.address, ONE_USDT * 100_000n);
    await usdt.connect(user).approve(zAddr, ethers.MaxUint256);
  }

  // Give the mock Aave pool a USDT reserve for withdrawals
  await usdt.mint(await aave.getAddress(), ONE_USDT * 1_000_000n);

  return { zorrito, usdt, aUsdt, aave, owner, alice, bob, carol };
}

// Helper: advance to just past the draw threshold (relative — always works)
async function fastForwardToDraw() {
  await time.increase(DRAW_INTERVAL + 1);
}

// ── Test suite ─────────────────────────────────────────────────────────────────
describe("Zorrito v7", function () {

  // ── 1. Deployment ────────────────────────────────────────────────────────────
  describe("Deployment", function () {
    it("sets lastDrawTime to GENESIS", async function () {
      const { zorrito } = await loadFixture(deployFixture);
      expect(await zorrito.lastDrawTime()).to.equal(GENESIS);
    });

    it("stores correct immutable addresses", async function () {
      const { zorrito, usdt, aave, aUsdt } = await loadFixture(deployFixture);
      expect(await zorrito.usdt()).to.equal(await usdt.getAddress());
      expect(await zorrito.aavePool()).to.equal(await aave.getAddress());
      expect(await zorrito.aUsdt()).to.equal(await aUsdt.getAddress());
    });

    it("reverts if zero usdt address", async function () {
      const { aave, aUsdt } = await loadFixture(deployFixture);
      const Zorrito = await ethers.getContractFactory("Zorrito");
      await expect(
        Zorrito.deploy(ethers.ZeroAddress, await aave.getAddress(), await aUsdt.getAddress())
      ).to.be.revertedWith("Zero usdt");
    });

    it("reverts if zero aavePool address", async function () {
      const { usdt, aUsdt } = await loadFixture(deployFixture);
      const Zorrito = await ethers.getContractFactory("Zorrito");
      await expect(
        Zorrito.deploy(await usdt.getAddress(), ethers.ZeroAddress, await aUsdt.getAddress())
      ).to.be.revertedWith("Zero pool");
    });

    it("reverts if zero aUsdt address", async function () {
      const { usdt, aave } = await loadFixture(deployFixture);
      const Zorrito = await ethers.getContractFactory("Zorrito");
      await expect(
        Zorrito.deploy(await usdt.getAddress(), await aave.getAddress(), ethers.ZeroAddress)
      ).to.be.revertedWith("Zero aUsdt");
    });
  });

  // ── 2. deposit() ─────────────────────────────────────────────────────────────
  describe("deposit()", function () {
    it("credits deposits mapping with correct amount", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 5n);
      expect(await zorrito.deposits(alice.address)).to.equal(ONE_USDT * 5n);
    });

    it("emits Deposited with correct fish count (1 USDT = 1 fish)", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await expect(zorrito.connect(alice).deposit(ONE_USDT * 3n))
        .to.emit(zorrito, "Deposited")
        .withArgs(alice.address, ONE_USDT * 3n, 3n);
    });

    it("fox is alive immediately after deposit", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT);
      expect(await zorrito.isAlive(alice.address)).to.be.true;
    });

    it("streak starts at 1 after first deposit", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT);
      expect(await zorrito.streak(alice.address)).to.equal(1);
    });

    it("accumulates deposits across multiple calls", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 2n);
      await zorrito.connect(alice).deposit(ONE_USDT * 3n);
      expect(await zorrito.deposits(alice.address)).to.equal(ONE_USDT * 5n);
    });

    it("reverts if amount < 1 USDT", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await expect(
        zorrito.connect(alice).deposit(500_000n)
      ).to.be.revertedWith("Min deposit: 1 USDT (1 fish)");
    });

    it("updates totalDeposited correctly", async function () {
      const { zorrito, alice, bob } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 10n);
      await zorrito.connect(bob).deposit(ONE_USDT * 5n);
      expect(await zorrito.totalDeposited()).to.equal(ONE_USDT * 15n);
    });

    it("tracks depositorCount correctly across multiple users", async function () {
      const { zorrito, alice, bob } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT);
      await zorrito.connect(bob).deposit(ONE_USDT);
      expect(await zorrito.depositorCount()).to.equal(2n);
    });

    it("does not add the same user twice to the depositors array", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT);
      await zorrito.connect(alice).deposit(ONE_USDT);
      expect(await zorrito.depositorCount()).to.equal(1n);
    });
  });

  // ── 3. feed() ────────────────────────────────────────────────────────────────
  describe("feed()", function () {
    it("reverts if user has no deposit", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await expect(zorrito.connect(alice).feed())
        .to.be.revertedWith("No fish: deposit first to get a fox");
    });

    it("increments streak when called after 20h", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT);
      await time.increase(20 * 3600);
      await zorrito.connect(alice).feed();
      expect(await zorrito.streak(alice.address)).to.equal(2);
    });

    it("does NOT increment streak when fed before 20h", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT);
      await time.increase(10 * 3600); // only 10 hours
      await zorrito.connect(alice).feed();
      expect(await zorrito.streak(alice.address)).to.equal(1); // unchanged
    });

    it("resets streak to 1 when fox dies and is revived", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT);
      // Build streak to 4
      for (let i = 0; i < 3; i++) {
        await time.increase(22 * 3600);
        await zorrito.connect(alice).feed();
      }
      expect(await zorrito.streak(alice.address)).to.equal(4);
      // Miss a full day — fox dies
      await time.increase(FEED_INTERVAL + 1);
      expect(await zorrito.isAlive(alice.address)).to.be.false;
      // Feed again — streak resets
      await zorrito.connect(alice).feed();
      expect(await zorrito.streak(alice.address)).to.equal(1);
    });

    it("fox is dead after FEED_INTERVAL + 1 seconds without a feed", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT);
      await time.increase(FEED_INTERVAL + 1);
      expect(await zorrito.isAlive(alice.address)).to.be.false;
    });

    it("each feed adds 1 fish (1 USDT to deposits)", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT);
      await time.increase(22 * 3600);
      await zorrito.connect(alice).feed();
      expect(await zorrito.deposits(alice.address)).to.equal(ONE_USDT * 2n);
    });

    it("preserves maxStreak after fox death and revival", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT);
      // Build streak to 7
      for (let i = 0; i < 6; i++) {
        await time.increase(22 * 3600);
        await zorrito.connect(alice).feed();
      }
      expect(await zorrito.streak(alice.address)).to.equal(7);
      expect(await zorrito.maxStreak(alice.address)).to.equal(7);
      // Die and revive
      await time.increase(FEED_INTERVAL + 1);
      await zorrito.connect(alice).feed();
      expect(await zorrito.streak(alice.address)).to.equal(1);
      expect(await zorrito.maxStreak(alice.address)).to.equal(7); // preserved
    });
  });

  // ── 4. streakWeight() ────────────────────────────────────────────────────────
  describe("streakWeight()", function () {
    const cases = [
      [0,   10, "0 days → 1× (weight 10)"],
      [6,   10, "6 days → 1× (weight 10)"],
      [7,   15, "7 days → 1.5× (weight 15)"],
      [29,  15, "29 days → 1.5× (weight 15)"],
      [30,  20, "30 days → 2× (weight 20)"],
      [89,  20, "89 days → 2× (weight 20)"],
      [90,  30, "90 days → 3× (weight 30)"],
      [179, 30, "179 days → 3× (weight 30)"],
      [180, 40, "180 days → 4× (weight 40)"],
      [364, 40, "364 days → 4× (weight 40)"],
      [365, 50, "365 days → 5× (weight 50)"],
      [999, 50, "999 days → 5× capped (weight 50)"],
    ];

    for (const [streak, weight, label] of cases) {
      it(label, async function () {
        const { zorrito } = await loadFixture(deployFixture);
        expect(await zorrito.streakWeight(streak)).to.equal(weight);
      });
    }
  });

  // ── 5. effectiveTickets() ────────────────────────────────────────────────────
  describe("effectiveTickets()", function () {
    it("returns 0 when fox is dead", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 10n);
      await time.increase(FEED_INTERVAL + 1);
      expect(await zorrito.effectiveTickets(alice.address)).to.equal(0);
    });

    it("returns fish × streakWeight when alive (streak < 7 → weight 10)", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 10n); // 10 fish, weight=10
      expect(await zorrito.effectiveTickets(alice.address)).to.equal(100); // 10 × 10
    });

    it("scales correctly with streak multiplier — feed() also adds fish", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      // Start with 5 fish
      await zorrito.connect(alice).deposit(ONE_USDT * 5n);
      // 6 feeds of 22h each → streak becomes 7 (weight=15), each feed adds 1 fish
      for (let i = 0; i < 6; i++) {
        await time.increase(22 * 3600);
        await zorrito.connect(alice).feed();
      }
      expect(await zorrito.streak(alice.address)).to.equal(7);
      // Total fish = 5 initial + 6 feeds = 11; effectiveTickets = 11 × 15 = 165
      expect(await zorrito.effectiveTickets(alice.address)).to.equal(165);
    });

    it("higher deposit → proportionally higher effective tickets", async function () {
      const { zorrito, alice, bob } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 10n); // 10 fish
      await zorrito.connect(bob).deposit(ONE_USDT * 20n);   // 20 fish
      const effAlice = await zorrito.effectiveTickets(alice.address);
      const effBob   = await zorrito.effectiveTickets(bob.address);
      // Both at streak 1 → weight 10; Bob should have exactly 2× Alice
      expect(effBob).to.equal(effAlice * 2n);
    });
  });

  // ── 6. withdraw() ────────────────────────────────────────────────────────────
  describe("withdraw()", function () {
    it("returns USDT to user on full withdrawal", async function () {
      const { zorrito, usdt, alice } = await loadFixture(deployFixture);
      const balBefore = await usdt.balanceOf(alice.address);
      await zorrito.connect(alice).deposit(ONE_USDT * 10n);
      await zorrito.connect(alice).withdraw(ONE_USDT * 10n);
      expect(await usdt.balanceOf(alice.address)).to.equal(balBefore);
    });

    it("reverts when withdrawing more than deposited", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 5n);
      await expect(
        zorrito.connect(alice).withdraw(ONE_USDT * 6n)
      ).to.be.revertedWith("Insufficient balance");
    });

    it("removes depositor when balance hits zero", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 5n);
      await zorrito.connect(alice).withdraw(ONE_USDT * 5n);
      expect(await zorrito.depositorCount()).to.equal(0n);
      expect(await zorrito.isDepositor(alice.address)).to.be.false;
    });

    it("keeps depositor when partially withdrawing", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 5n);
      await zorrito.connect(alice).withdraw(ONE_USDT * 2n);
      expect(await zorrito.depositorCount()).to.equal(1n);
      expect(await zorrito.deposits(alice.address)).to.equal(ONE_USDT * 3n);
    });

    it("clears streak and lastFed after full withdrawal", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT);
      await zorrito.connect(alice).withdraw(ONE_USDT);
      expect(await zorrito.streak(alice.address)).to.equal(0);
      expect(await zorrito.lastFed(alice.address)).to.equal(0);
    });

    it("updates totalDeposited after withdrawal", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 10n);
      await zorrito.connect(alice).withdraw(ONE_USDT * 4n);
      expect(await zorrito.totalDeposited()).to.equal(ONE_USDT * 6n);
    });

    it("emits Withdrawn event", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 5n);
      await expect(zorrito.connect(alice).withdraw(ONE_USDT * 5n))
        .to.emit(zorrito, "Withdrawn")
        .withArgs(alice.address, ONE_USDT * 5n);
    });
  });

  // ── 7. _removeDepositor — swap-and-pop integrity ─────────────────────────────
  describe("_removeDepositor (swap-and-pop)", function () {
    it("count is correct after first user withdraws from a 3-user pool", async function () {
      const { zorrito, alice, bob, carol } = await loadFixture(deployFixture);
      for (const u of [alice, bob, carol]) {
        await zorrito.connect(u).deposit(ONE_USDT);
      }
      await zorrito.connect(alice).withdraw(ONE_USDT);
      expect(await zorrito.depositorCount()).to.equal(2n);
      expect(await zorrito.isDepositor(alice.address)).to.be.false;
      expect(await zorrito.isDepositor(bob.address)).to.be.true;
      expect(await zorrito.isDepositor(carol.address)).to.be.true;
    });

    it("middle user removal leaves pool consistent", async function () {
      const { zorrito, alice, bob, carol } = await loadFixture(deployFixture);
      for (const u of [alice, bob, carol]) {
        await zorrito.connect(u).deposit(ONE_USDT);
      }
      await zorrito.connect(bob).withdraw(ONE_USDT);
      expect(await zorrito.depositorCount()).to.equal(2n);
      expect(await zorrito.isDepositor(bob.address)).to.be.false;
    });

    it("last user removal leaves an empty pool", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT);
      await zorrito.connect(alice).withdraw(ONE_USDT);
      expect(await zorrito.depositorCount()).to.equal(0n);
    });

    it("remaining users can withdraw after another user leaves", async function () {
      const { zorrito, alice, bob } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 5n);
      await zorrito.connect(bob).deposit(ONE_USDT * 3n);
      await zorrito.connect(alice).withdraw(ONE_USDT * 5n);
      await expect(zorrito.connect(bob).withdraw(ONE_USDT * 3n)).to.not.be.reverted;
    });
  });

  // ── 8. draw() ────────────────────────────────────────────────────────────────
  describe("draw()", function () {
    it("reverts when called before 365 days have passed", async function () {
      const { zorrito, alice, aave } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 100n);
      await aave.addYield(await zorrito.getAddress(), ONE_USDT);
      // Do NOT advance time — we're before the eligible timestamp
      await expect(zorrito.draw()).to.be.revertedWith("Too early");
    });

    it("reverts when there are no depositors", async function () {
      const { zorrito } = await loadFixture(deployFixture);
      await fastForwardToDraw();
      await expect(zorrito.draw()).to.be.revertedWith("No depositors");
    });

    it("reverts when there is no yield", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 100n);
      await fastForwardToDraw();
      // Alice's fox dies during the wait — revive it
      await zorrito.connect(alice).feed();
      await expect(zorrito.draw()).to.be.revertedWith("No yield yet");
    });

    it("emits WinnerPicked and transfers prize to winner", async function () {
      const { zorrito, usdt, aave, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 100n);
      const prize = ONE_USDT * 5n;
      await aave.addYield(await zorrito.getAddress(), prize);
      await fastForwardToDraw();
      await zorrito.connect(alice).feed(); // revive
      const balBefore = await usdt.balanceOf(alice.address);
      const tx = await zorrito.draw();
      await expect(tx).to.emit(zorrito, "WinnerPicked");
      const balAfter = await usdt.balanceOf(alice.address);
      expect(balAfter - balBefore).to.equal(prize);
    });

    it("advances lastDrawTime by exactly DRAW_INTERVAL", async function () {
      const { zorrito, aave, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 100n);
      await aave.addYield(await zorrito.getAddress(), ONE_USDT);
      await fastForwardToDraw();
      await zorrito.connect(alice).feed();
      await zorrito.draw();
      expect(await zorrito.lastDrawTime()).to.equal(GENESIS + DRAW_INTERVAL);
    });

    it("only alive foxes can win — dead fox excluded", async function () {
      const { zorrito, usdt, aave, alice, bob } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 100n);
      await zorrito.connect(bob).deposit(ONE_USDT * 100n);
      // Fast forward — both foxes die
      await fastForwardToDraw();
      // Only Alice revives
      await zorrito.connect(alice).feed();
      expect(await zorrito.isAlive(alice.address)).to.be.true;
      expect(await zorrito.isAlive(bob.address)).to.be.false;
      await aave.addYield(await zorrito.getAddress(), ONE_USDT * 5n);
      const bobBalBefore = await usdt.balanceOf(bob.address);
      await zorrito.draw();
      expect(await usdt.balanceOf(bob.address)).to.equal(bobBalBefore); // Bob got nothing
    });

    it("principal is safe — winner receives only yield, deposit remains withdrawable", async function () {
      const { zorrito, usdt, aave, alice } = await loadFixture(deployFixture);
      const depositAmt = ONE_USDT * 100n;
      await zorrito.connect(alice).deposit(depositAmt);
      const yieldAmt = ONE_USDT * 7n;
      await aave.addYield(await zorrito.getAddress(), yieldAmt);
      await fastForwardToDraw();
      await zorrito.connect(alice).feed(); // revive
      const balBefore = await usdt.balanceOf(alice.address);
      await zorrito.draw();
      // Alice can still withdraw her full principal
      await zorrito.connect(alice).withdraw(depositAmt);
      const balAfter = await usdt.balanceOf(alice.address);
      // balAfter = balBefore + prize (from draw) + deposit (from withdraw)
      expect(balAfter).to.equal(balBefore + yieldAmt + depositAmt);
    });

    it("canDraw() returns false before threshold, true when ready", async function () {
      const { zorrito, aave, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 100n);
      expect(await zorrito.canDraw()).to.be.false; // too early
      await aave.addYield(await zorrito.getAddress(), ONE_USDT);
      await fastForwardToDraw();
      await zorrito.connect(alice).feed(); // revive fox
      expect(await zorrito.canDraw()).to.be.true;
    });

    it("canDraw() returns false if no alive foxes even after time passes", async function () {
      const { zorrito, aave, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 100n);
      await aave.addYield(await zorrito.getAddress(), ONE_USDT);
      await fastForwardToDraw();
      // Alice's fox is dead — don't revive
      expect(await zorrito.isAlive(alice.address)).to.be.false;
      expect(await zorrito.canDraw()).to.be.false;
    });
  });

  // ── 9. depositFor() / feedFor() ──────────────────────────────────────────────
  describe("depositFor() / feedFor()", function () {
    it("depositFor: fish credited to beneficiary, not to caller", async function () {
      const { zorrito, alice, bob } = await loadFixture(deployFixture);
      // Alice pays, Bob receives
      await zorrito.connect(alice).depositFor(bob.address, ONE_USDT * 5n);
      expect(await zorrito.deposits(bob.address)).to.equal(ONE_USDT * 5n);
      expect(await zorrito.deposits(alice.address)).to.equal(0n);
    });

    it("depositFor: reverts for zero beneficiary address", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await expect(
        zorrito.connect(alice).depositFor(ethers.ZeroAddress, ONE_USDT)
      ).to.be.revertedWith("Zero beneficiary");
    });

    it("feedFor: adds fish to beneficiary and updates their streak", async function () {
      const { zorrito, alice, bob } = await loadFixture(deployFixture);
      await zorrito.connect(bob).deposit(ONE_USDT); // Bob gets a fox
      await time.increase(22 * 3600);
      const fishBefore = await zorrito.deposits(bob.address);
      await zorrito.connect(alice).feedFor(bob.address); // Alice pays
      expect(await zorrito.deposits(bob.address)).to.equal(fishBefore + ONE_USDT);
      expect(await zorrito.streak(bob.address)).to.equal(2);
    });

    it("feedFor: reverts if beneficiary has no deposit", async function () {
      const { zorrito, alice, bob } = await loadFixture(deployFixture);
      await expect(
        zorrito.connect(alice).feedFor(bob.address)
      ).to.be.revertedWith("No fish: deposit first");
    });
  });

  // ── 10. View functions ────────────────────────────────────────────────────────
  describe("View functions", function () {
    it("getStats: returns correct poolSize, playerCount and aliveFoxes", async function () {
      const { zorrito, alice, bob } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 10n);
      await zorrito.connect(bob).deposit(ONE_USDT * 5n);
      const [poolSize, , playerCount, , aliveFoxes] = await zorrito.getStats();
      expect(poolSize).to.equal(ONE_USDT * 15n);
      expect(playerCount).to.equal(2n);
      expect(aliveFoxes).to.equal(2n);
    });

    it("getStats: nextDraw = lastDrawTime + DRAW_INTERVAL", async function () {
      const { zorrito } = await loadFixture(deployFixture);
      const [, , , nextDraw] = await zorrito.getStats();
      expect(nextDraw).to.equal(BigInt(GENESIS) + BigInt(DRAW_INTERVAL));
    });

    it("getFoxStatus: returns all 8 fields correctly for alive fox", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 3n);
      const s = await zorrito.getFoxStatus(alice.address);
      expect(s[0]).to.be.true;   // alive
      expect(s[1]).to.equal(1);  // streak
      expect(s[3]).to.equal(3);  // fishCount (3 USDT = 3 fish)
      expect(s[6]).to.equal(10); // streakWeight (< 7 days = weight 10)
      expect(s[7]).to.equal(30); // effTickets = 3 × 10
    });

    it("getFoxStatus: effTickets = 0 and alive = false when fox is dead", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 5n);
      await time.increase(FEED_INTERVAL + 1);
      const s = await zorrito.getFoxStatus(alice.address);
      expect(s[0]).to.be.false; // alive
      expect(s[7]).to.equal(0); // effTickets
    });

    it("getLeaderboardData: returns parallel arrays of matching length", async function () {
      const { zorrito, alice, bob, carol } = await loadFixture(deployFixture);
      for (const u of [alice, bob, carol]) {
        await zorrito.connect(u).deposit(ONE_USDT);
      }
      const [addrs, streaks, , alive, fish, eff] = await zorrito.getLeaderboardData();
      expect(addrs.length).to.equal(3);
      expect(streaks.length).to.equal(3);
      expect(alive.length).to.equal(3);
      expect(fish.length).to.equal(3);
      expect(eff.length).to.equal(3);
    });

    it("getYield: returns 0 initially, correct amount after addYield", async function () {
      const { zorrito, aave, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 100n);
      expect(await zorrito.getYield()).to.equal(0n);
      await aave.addYield(await zorrito.getAddress(), ONE_USDT * 3n);
      expect(await zorrito.getYield()).to.equal(ONE_USDT * 3n);
    });

    it("getUserDeposit: returns correct balance", async function () {
      const { zorrito, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 42n);
      expect(await zorrito.getUserDeposit(alice.address)).to.equal(ONE_USDT * 42n);
    });
  });

  // ── 11. Multi-user weighted draw ─────────────────────────────────────────────
  describe("Weighted draw — effective tickets", function () {
    it("user with 0 effective tickets (dead fox) cannot win", async function () {
      const { zorrito, usdt, aave, alice, bob } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 100n);
      await zorrito.connect(bob).deposit(ONE_USDT * 100n);
      // Fast forward — both foxes die
      await fastForwardToDraw();
      // Only Alice revives
      await zorrito.connect(alice).feed();
      await aave.addYield(await zorrito.getAddress(), ONE_USDT * 5n);
      const bobBalBefore = await usdt.balanceOf(bob.address);
      await zorrito.draw();
      expect(await usdt.balanceOf(bob.address)).to.equal(bobBalBefore);
    });

    it("single player with alive fox always wins", async function () {
      const { zorrito, usdt, aave, alice } = await loadFixture(deployFixture);
      await zorrito.connect(alice).deposit(ONE_USDT * 50n);
      const prize = ONE_USDT * 3n;
      await aave.addYield(await zorrito.getAddress(), prize);
      await fastForwardToDraw();
      await zorrito.connect(alice).feed();
      const balBefore = await usdt.balanceOf(alice.address);
      await zorrito.draw();
      expect(await usdt.balanceOf(alice.address)).to.equal(balBefore + prize);
    });
  });
});

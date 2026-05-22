// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

// ─────────────────────────────────────────────────────────────────────────────
//  Zorrito v8 — No-Loss Annual Lottery on Celo via Aave V3
//
//  Changes from v7:
//    • 10% platform fee on the annual prize — sustains Zorrito infrastructure.
//      PLATFORM_WALLET receives 10% of yield at draw time.
//      Winner receives 90% of yield. Principal is NEVER affected.
//
//  Changes from v6 (in v7):
//    • Replace deprecated Celo L1 randomness precompile (0xce10) with
//      EIP-4399 block.prevrandao — Celo migrated to OP Stack L2 and removed
//      all L1-specific precompiles. block.prevrandao is the standard replacement.
//
//  Mechanics:
//    • Deposit USDT → get 🐟 fish (1 USDT = 1 fish)
//    • Feed your fox 1 USDT every day to stay alive in the annual draw
//    • Dead fox (not fed in 24h) is excluded from the draw
//    • effectiveTickets = fishCount × streakMultiplier
//    • Streak tiers (multiplier):
//        < 7 days   → 1.0×   (base)
//        7–29 days  → 1.5×
//        30–89 days → 2.0×
//        90–179 d   → 3.0×
//        180–364 d  → 4.0×
//        365 + days → 5.0×  (max — 1 full year of daily saving)
//    • Entropy accumulator: mixed on every user action over 365 days using
//      block.prevrandao (EIP-4399), block.timestamp, msg.sender, totalDeposited.
//      Attacker must control the L1 proposer at EVERY interaction to bias the
//      result — effectively impossible over a full year of random user actions.
//    • Principal always withdrawable — no loss ever
//    • Draw date: Jan 1st each year (lastDrawTime seeded to Jan 1 2026 UTC)
// ─────────────────────────────────────────────────────────────────────────────

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

contract Zorrito is ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ── Constants ──────────────────────────────────────────────────────────────
    uint256 public constant DRAW_INTERVAL  = 365 days; // annual lottery
    uint256 public constant FEED_INTERVAL  = 1 days;   // must feed every 24h
    uint256 public constant MIN_DEPOSIT    = 1e6;       // 1 USDT (6 decimals)
    uint256 public constant MAX_DEPOSITORS = 5_000;

    // 10% platform fee — sustains Zorrito infrastructure
    address public constant PLATFORM_WALLET = 0x19eC1797000F434EB2fd622E642BeF80234425cb;
    uint256 public constant PLATFORM_FEE_BPS = 1000; // 10% in basis points (1000 / 10000)

    // Jan 1, 2026 00:00:00 UTC → next draw = Jan 1, 2027
    uint256 private constant GENESIS = 1_767_225_600;

    // ── Immutables ─────────────────────────────────────────────────────────────
    IERC20    public immutable usdt;
    IAavePool public immutable aavePool;
    IERC20    public immutable aUsdt;

    // ── Deposit state ──────────────────────────────────────────────────────────
    mapping(address => uint256) public deposits;
    mapping(address => bool)    public isDepositor;
    mapping(address => uint256) private depositorIndex; // 1-indexed
    address[] public depositors;
    uint256   public totalDeposited;
    uint256   public lastDrawTime;

    // ── Entropy accumulator (RANDAO-style) ────────────────────────────────────
    // Mixed on every deposit/feed/withdraw throughout the 365-day round.
    // Attacker must control the Celo beacon at EVERY user interaction over
    // a full year to bias the result — effectively impossible.
    bytes32 private _roundEntropy;

    // ── Fox / feed state ───────────────────────────────────────────────────────
    mapping(address => uint256) public lastFed;    // timestamp of last feed
    mapping(address => uint32)  public streak;     // current daily streak
    mapping(address => uint32)  public maxStreak;  // all-time best streak

    // ── Events ─────────────────────────────────────────────────────────────────
    event Deposited(address indexed user, uint256 amount, uint256 fish);
    event Withdrawn(address indexed user, uint256 amount);
    event WinnerPicked(address indexed winner, uint256 prize, uint256 platformFee, uint256 timestamp);
    event FoxFed(address indexed user, uint32 newStreak, bool wasRevived);

    // ── Constructor ────────────────────────────────────────────────────────────
    constructor(
        address _usdt,
        address _aavePool,
        address _aUsdt
    ) {
        require(_usdt     != address(0), "Zero usdt");
        require(_aavePool != address(0), "Zero pool");
        require(_aUsdt    != address(0), "Zero aUsdt");

        usdt     = IERC20(_usdt);
        aavePool = IAavePool(_aavePool);
        aUsdt    = IERC20(_aUsdt);

        // First draw eligible on Jan 1, 2027
        lastDrawTime = GENESIS;

        // Seed accumulator with deployment context so it's never zero
        _roundEntropy = keccak256(abi.encodePacked(
            block.timestamp,
            block.number,
            msg.sender
        ));

        IERC20(_usdt).forceApprove(_aavePool, type(uint256).max);
    }

    // ── Deposit (buy fish 🐟) ──────────────────────────────────────────────────
    // Depositing also feeds/revives the fox automatically.
    function deposit(uint256 amount) external nonReentrant {
        require(amount >= MIN_DEPOSIT, "Min deposit: 1 USDT (1 fish)");
        require(
            isDepositor[msg.sender] || depositors.length < MAX_DEPOSITORS,
            "Pool full"
        );

        usdt.safeTransferFrom(msg.sender, address(this), amount);

        if (!isDepositor[msg.sender]) {
            isDepositor[msg.sender]    = true;
            depositorIndex[msg.sender] = depositors.length + 1;
            depositors.push(msg.sender);
        }

        deposits[msg.sender] += amount;
        totalDeposited        += amount;

        aavePool.supply(address(usdt), amount, address(this), 0);
        _feedFox(msg.sender);
        _mixEntropy();

        emit Deposited(msg.sender, amount, amount / MIN_DEPOSIT);
    }

    // ── Deposit on behalf of another address (x402 / agent flow) ─────────────
    function depositFor(address beneficiary, uint256 amount) external nonReentrant {
        require(amount >= MIN_DEPOSIT, "Min deposit: 1 USDT (1 fish)");
        require(beneficiary != address(0), "Zero beneficiary");
        require(
            isDepositor[beneficiary] || depositors.length < MAX_DEPOSITORS,
            "Pool full"
        );

        usdt.safeTransferFrom(msg.sender, address(this), amount);

        if (!isDepositor[beneficiary]) {
            isDepositor[beneficiary]    = true;
            depositorIndex[beneficiary] = depositors.length + 1;
            depositors.push(beneficiary);
        }

        deposits[beneficiary] += amount;
        totalDeposited         += amount;

        aavePool.supply(address(usdt), amount, address(this), 0);
        _feedFox(beneficiary);
        _mixEntropy();

        emit Deposited(beneficiary, amount, amount / MIN_DEPOSIT);
    }

    // ── Feed fox on behalf of another address (x402 / agent flow) ────────────
    function feedFor(address beneficiary) external nonReentrant {
        require(beneficiary != address(0), "Zero beneficiary");
        require(deposits[beneficiary] >= MIN_DEPOSIT, "No fish: deposit first");

        usdt.safeTransferFrom(msg.sender, address(this), MIN_DEPOSIT);
        deposits[beneficiary] += MIN_DEPOSIT;
        totalDeposited         += MIN_DEPOSIT;
        aavePool.supply(address(usdt), MIN_DEPOSIT, address(this), 0);

        _feedFox(beneficiary);
        _mixEntropy();
        emit Deposited(beneficiary, MIN_DEPOSIT, 1);
    }

    // ── Feed fox 🦊 (costs 1 USDT/day → grows fish + streak) ─────────────────
    function feed() external nonReentrant {
        require(deposits[msg.sender] >= MIN_DEPOSIT, "No fish: deposit first to get a fox");

        usdt.safeTransferFrom(msg.sender, address(this), MIN_DEPOSIT);
        deposits[msg.sender] += MIN_DEPOSIT;
        totalDeposited        += MIN_DEPOSIT;
        aavePool.supply(address(usdt), MIN_DEPOSIT, address(this), 0);

        _feedFox(msg.sender);
        _mixEntropy();
        emit Deposited(msg.sender, MIN_DEPOSIT, 1);
    }

    // ── Withdraw ───────────────────────────────────────────────────────────────
    function withdraw(uint256 amount) external nonReentrant {
        require(deposits[msg.sender] >= amount, "Insufficient balance");

        uint256 aUsdtBal   = aUsdt.balanceOf(address(this));
        uint256 aaveAmount = (aUsdtBal >= totalDeposited)
            ? amount
            : (amount * aUsdtBal) / totalDeposited;

        deposits[msg.sender] -= amount;
        totalDeposited        -= amount;

        if (deposits[msg.sender] == 0) {
            _removeDepositor(msg.sender);
            delete lastFed[msg.sender];
            delete streak[msg.sender];
        }

        uint256 actualOut = aavePool.withdraw(address(usdt), aaveAmount, msg.sender);
        require(actualOut > 0, "Aave returned zero");

        _mixEntropy();
        emit Withdrawn(msg.sender, amount);
    }

    // ── Annual Draw ────────────────────────────────────────────────────────────
    // Anyone can trigger. Keeper bot calls this on Jan 1st each year.
    function draw() external nonReentrant {
        require(block.timestamp >= lastDrawTime + DRAW_INTERVAL, "Too early");
        require(depositors.length > 0, "No depositors");

        uint256 prize = getYield();
        require(prize > 0, "No yield yet");

        lastDrawTime = lastDrawTime + DRAW_INTERVAL;

        address winner = _selectWinner();

        // Roll accumulator into next round's seed
        _roundEntropy = keccak256(abi.encodePacked(
            _roundEntropy,
            winner,
            block.timestamp
        ));

        // Split prize: 10% platform fee, 90% to winner
        uint256 platformFee  = (prize * PLATFORM_FEE_BPS) / 10_000;
        uint256 winnerPrize  = prize - platformFee;

        uint256 paidFee = aavePool.withdraw(address(usdt), platformFee, PLATFORM_WALLET);
        require(paidFee > 0, "Aave fee returned zero");

        uint256 paid = aavePool.withdraw(address(usdt), winnerPrize, winner);
        require(paid > 0, "Aave returned zero");

        emit WinnerPicked(winner, paid, paidFee, block.timestamp);
    }

    // ── Streak Multiplier ──────────────────────────────────────────────────────
    // Returns a weight out of 10 (so 10 = 1×, 50 = 5×).
    // Deterministic and public — no new randomness attack surface.
    //
    //   Days of streak  │  Multiplier  │  Weight
    //   ──────────────────────────────────────────
    //      0 – 6        │    1.0×      │   10
    //      7 – 29       │    1.5×      │   15
    //     30 – 89       │    2.0×      │   20
    //     90 – 179      │    3.0×      │   30
    //    180 – 364      │    4.0×      │   40
    //    365 +          │    5.0×      │   50
    //
    function streakWeight(uint32 s) public pure returns (uint256) {
        if (s >= 365) return 50;
        if (s >= 180) return 40;
        if (s >= 90)  return 30;
        if (s >= 30)  return 20;
        if (s >= 7)   return 15;
        return 10;
    }

    // effectiveTickets = fish × streakWeight (denominator 10 cancels in selection)
    function effectiveTickets(address user) public view returns (uint256) {
        if (!isAlive(user)) return 0;
        uint256 fish = deposits[user] / MIN_DEPOSIT;
        return fish * streakWeight(streak[user]);
    }

    // ── Views ──────────────────────────────────────────────────────────────────

    function isAlive(address user) public view returns (bool) {
        if (deposits[user] < MIN_DEPOSIT) return false;
        if (lastFed[user] == 0) return false;
        return block.timestamp - lastFed[user] <= FEED_INTERVAL;
    }

    function getYield() public view returns (uint256) {
        uint256 aBalance = aUsdt.balanceOf(address(this));
        if (aBalance <= totalDeposited) return 0;
        return aBalance - totalDeposited;
    }

    function getStats() external view returns (
        uint256 poolSize,
        uint256 yieldAvailable,
        uint256 playerCount,
        uint256 nextDraw,
        uint256 aliveFoxes
    ) {
        uint256 alive;
        for (uint256 i; i < depositors.length; ++i) {
            if (isAlive(depositors[i])) ++alive;
        }
        return (
            totalDeposited,
            getYield(),
            depositors.length,
            lastDrawTime + DRAW_INTERVAL,
            alive
        );
    }

    function getUserDeposit(address user) external view returns (uint256) {
        return deposits[user];
    }

    // Full fox status including streak weight and effective tickets
    function getFoxStatus(address user) external view returns (
        bool    alive,
        uint32  currentStreak,
        uint32  bestStreak,
        uint256 fishCount,
        uint256 nextFeedDeadline,
        uint256 secondsUntilDead,
        uint256 currentStreakWeight,
        uint256 effTickets
    ) {
        alive                = isAlive(user);
        currentStreak        = streak[user];
        bestStreak           = maxStreak[user];
        fishCount            = deposits[user] / MIN_DEPOSIT;
        nextFeedDeadline     = lastFed[user] == 0 ? 0 : lastFed[user] + FEED_INTERVAL;
        secondsUntilDead     = alive
            ? (lastFed[user] + FEED_INTERVAL - block.timestamp)
            : 0;
        currentStreakWeight  = streakWeight(currentStreak);
        effTickets           = effectiveTickets(user);
    }

    // Leaderboard data including effective tickets for sorting
    function getLeaderboardData() external view returns (
        address[] memory addrs,
        uint32[]  memory streaks,
        uint32[]  memory bestStreaks,
        bool[]    memory alive,
        uint256[] memory fishCounts,
        uint256[] memory effTickets
    ) {
        uint256 len = depositors.length;
        addrs       = depositors;
        streaks     = new uint32[](len);
        bestStreaks  = new uint32[](len);
        alive       = new bool[](len);
        fishCounts  = new uint256[](len);
        effTickets  = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            address d       = depositors[i];
            streaks[i]     = streak[d];
            bestStreaks[i]  = maxStreak[d];
            alive[i]        = isAlive(d);
            fishCounts[i]   = deposits[d] / MIN_DEPOSIT;
            effTickets[i]   = effectiveTickets(d);
        }
    }

    function canDraw() external view returns (bool) {
        if (block.timestamp < lastDrawTime + DRAW_INTERVAL) return false;
        if (getYield() == 0) return false;
        for (uint256 i; i < depositors.length; ++i) {
            if (isAlive(depositors[i])) return true;
        }
        return false;
    }

    function depositorCount() external view returns (uint256) {
        return depositors.length;
    }

    // ── Internals ──────────────────────────────────────────────────────────────

    function _mixEntropy() internal {
        // EIP-4399: block.prevrandao is the standard randomness source on Celo L2
        // (Celo migrated to OP Stack; the old L1 precompile at 0xce10 was removed)
        _roundEntropy = keccak256(abi.encodePacked(
            _roundEntropy,
            block.prevrandao,
            block.timestamp,
            msg.sender,
            totalDeposited
        ));
    }

    function _feedFox(address user) internal {
        uint256 last    = lastFed[user];
        uint256 elapsed = last == 0 ? type(uint256).max : block.timestamp - last;
        bool    revived = false;

        if (elapsed > FEED_INTERVAL) {
            streak[user] = 1;
            revived = (last != 0);
        } else if (elapsed >= 20 hours) {
            streak[user] += 1;
        }

        if (streak[user] > maxStreak[user]) {
            maxStreak[user] = streak[user];
        }

        lastFed[user] = block.timestamp;
        emit FoxFed(user, streak[user], revived);
    }

    // Winner selection weighted by effectiveTickets (fish × streakMultiplier)
    function _selectWinner() internal view returns (address) {
        // Sum effective tickets for all alive foxes
        uint256 aliveTotal;
        for (uint256 i; i < depositors.length; ++i) {
            aliveTotal += effectiveTickets(depositors[i]);
        }
        require(aliveTotal > 0, "No alive foxes");

        // Final seed: 365 days of accumulated entropy + EIP-4399 prevrandao + block context
        uint256 rand = uint256(keccak256(abi.encodePacked(
            _roundEntropy,
            block.prevrandao,
            block.timestamp,
            block.number,
            aliveTotal
        ))) % aliveTotal;

        // Weighted selection
        uint256 cumulative;
        for (uint256 i; i < depositors.length; ++i) {
            cumulative += effectiveTickets(depositors[i]);
            if (rand < cumulative) return depositors[i];
        }

        // Fallback: last alive fox
        for (uint256 i = depositors.length; i > 0; --i) {
            if (isAlive(depositors[i - 1])) return depositors[i - 1];
        }
        revert("No alive fox found");
    }

    // O(1) removal via swap-and-pop + index mapping
    function _removeDepositor(address user) internal {
        uint256 idx  = depositorIndex[user] - 1;
        uint256 last = depositors.length - 1;

        if (idx != last) {
            address moved         = depositors[last];
            depositors[idx]       = moved;
            depositorIndex[moved] = idx + 1;
        }

        depositors.pop();
        delete depositorIndex[user];
        delete isDepositor[user];
    }
}

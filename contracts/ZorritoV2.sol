// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";

interface IAavePool {
    function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;
    function withdraw(address asset, uint256 amount, address to) external returns (uint256);
}

/**
 * @title  ZorritoV2 — daily-deposit no-loss savings
 * @notice This is the SECOND ZorritoV2 deployment. Same product name, fixed
 *         mechanics. Versus the previous deploy:
 *           • `save()` is removed. Streak extension is fused into `deposit()`.
 *           • Streak is UTC-day-based with daily death (>1 UTC day gap → fox dies).
 *           • Welcome bonus is checked inside `deposit()` instead of `save()`.
 *           • `depositFor(beneficiary, …)` added for sponsorship / x402 / agents.
 *           • `getStatus(user)` view exposes alive/deadline/secondsUntilDead.
 */
contract ZorritoV2 is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;

    // ── Constants & Immutables ────────────────────────────────────────────────

    uint256 public constant MIN_DEPOSIT    = 250_000;   // 0.25 USDT (6 decimals)
    uint256 public constant MAX_DEPOSITORS = 100_000;
    uint256 public constant MAX_FEE_BPS    = 2_000;     // 20% hard cap
    uint8   public constant MAX_STREAK     = 7;

    IERC20    public immutable usdt;
    IAavePool public immutable aavePool;
    IERC20    public immutable aUsdt;
    address   public immutable PLATFORM_WALLET;

    // ── State Variables ───────────────────────────────────────────────────────

    address public keeper;

    uint256 public raffleFee  = 1_000;   // 10% BPS
    uint256 public savingsFee = 1_500;   // 15% BPS
    address public incentiveWallet;
    uint256 public welcomeBonus  = 500_000; // 0.5 USDT
    uint256 public WELCOME_STREAK = 5;      // days

    bool public emergencyMode;
    mapping(address => bool) public returned;

    // Depositor registry
    uint256 public depositorCount;
    address[] public depositorList;                      // 0-indexed
    mapping(address => uint256) public depositorIndex;  // 1-indexed (0 = not registered)
    mapping(address => uint256) public deposits;
    uint256 public totalPrincipal;

    // Fenwick tree (1-indexed) for O(log n) raffle selection.
    mapping(uint256 => uint256) private _fenwick;

    // Daily streak — resets if gap between deposits exceeds 1 UTC day.
    mapping(address => uint256) public lastDepositDay;   // unix day index (t/86400)
    mapping(address => uint8)   public streakDay;        // 1–MAX_STREAK

    // Referrals
    mapping(address => bytes4)  public referralCode;    // user's own code
    mapping(bytes4 => address)  public codeOwner;       // code → address
    mapping(address => address) public referredBy;      // who referred this user
    mapping(address => uint256) public activeReferrals; // count

    // Savings rewards O(1) accumulator
    uint256 public savingsAccumulator;                    // scaled 1e18
    mapping(address => uint256) public savingsSnapshot;  // per-user snapshot
    mapping(address => uint256) private _pendingSavings; // claimable, not yet transferred
    uint256 public totalSavings;                          // USDT owed to users (still in contract)

    // Welcome bonus
    mapping(address => bool) public welcomeBonusClaimed;

    // Self.xyz ZK passport verification
    mapping(address => bool) public selfVerified;

    // Raffle entropy
    bytes32 public entropyAccumulator;
    bytes32 public committedEntropy;
    uint256 public committedBlock;
    bool    public raffleCommitted;

    // ── Events ────────────────────────────────────────────────────────────────

    event Deposited(address indexed user, address indexed payer, uint256 amount, uint8 streakDay);
    event Withdrawn(address indexed user, uint256 amount);
    event WelcomeBonusClaimed(address indexed user, uint256 amount);
    event RaffleCommitted(uint256 block_);
    event RaffleExecuted(address indexed winner, uint256 prize, uint256 fee);
    event SavingsDistributed(uint256 toDistribute, uint256 fee);
    event SavingsClaimed(address indexed user, uint256 amount);
    event SelfVerificationSet(address indexed user);
    event EmergencyModeSet(bool active);
    event EmergencyReturned(address indexed user, uint256 amount);
    event KeeperSet(address indexed newKeeper);
    event IncentiveWalletSet(address indexed newWallet);
    event WelcomeBonusSet(uint256 amount);
    event WelcomeStreakSet(uint256 days_);
    event RaffleFeeSet(uint256 bps);
    event SavingsFeeSet(uint256 bps);

    // ── Modifiers & Constructor ───────────────────────────────────────────────

    modifier onlyKeeper() { require(msg.sender == keeper, "Not keeper"); _; }

    constructor(
        address _usdt,
        address _aavePool,
        address _aUsdt,
        address _platformWallet,
        address _keeper
    ) Ownable(msg.sender) {
        require(_usdt           != address(0), "Zero usdt");
        require(_aavePool       != address(0), "Zero pool");
        require(_aUsdt          != address(0), "Zero aUsdt");
        require(_platformWallet != address(0), "Zero platform");
        require(_keeper         != address(0), "Zero keeper");

        usdt           = IERC20(_usdt);
        aavePool       = IAavePool(_aavePool);
        aUsdt          = IERC20(_aUsdt);
        PLATFORM_WALLET = _platformWallet;
        keeper         = _keeper;

        IERC20(_usdt).forceApprove(_aavePool, type(uint256).max);
    }

    // ── Fenwick helpers ──────────────────────────────────────────────────────

    function _lsb(uint256 x) private pure returns (uint256) { return x & (~x + 1); }

    function _fenwickAdd(uint256 i, uint256 delta) private {
        for (; i <= MAX_DEPOSITORS; i += _lsb(i)) _fenwick[i] += delta;
    }
    function _fenwickSub(uint256 i, uint256 delta) private {
        for (; i <= MAX_DEPOSITORS; i += _lsb(i)) _fenwick[i] -= delta;
    }
    function _fenwickQuery(uint256 i) private view returns (uint256 s) {
        for (; i > 0; i -= _lsb(i)) s += _fenwick[i];
    }
    function _fenwickTotal() private view returns (uint256) { return _fenwickQuery(depositorCount); }

    function _fenwickFind(uint256 target) private view returns (uint256 idx) {
        uint256 n = depositorCount;
        uint256 bitMask = 1;
        while (bitMask <= n) bitMask <<= 1;
        bitMask >>= 1;
        while (bitMask > 0) {
            uint256 next = idx + bitMask;
            if (next <= n && _fenwick[next] <= target) {
                idx = next;
                target -= _fenwick[next];
            }
            bitMask >>= 1;
        }
        return idx + 1;
    }

    // effectiveChances = deposit × streakDay × (10 + activeReferrals) / 10 × selfBonus
    // Self.xyz verified users get a +25% bonus.
    function _effectiveChances(address user) private view returns (uint256) {
        uint256 dep = deposits[user];
        if (dep == 0) return 0;
        uint8 sd = streakDay[user] == 0 ? 1 : streakDay[user];
        uint256 refs = activeReferrals[user];
        uint256 base = dep * uint256(sd) * (10 + refs) / 10;
        return selfVerified[user] ? base * 5 / 4 : base;
    }

    function _mixEntropy() private {
        entropyAccumulator = keccak256(abi.encodePacked(
            entropyAccumulator, block.prevrandao, block.timestamp, msg.sender, totalPrincipal
        ));
    }

    function _settleSavings(address user) private {
        uint256 dep = deposits[user];
        if (dep > 0 && savingsAccumulator > savingsSnapshot[user]) {
            uint256 earned = dep * (savingsAccumulator - savingsSnapshot[user]) / 1e18;
            _pendingSavings[user] += earned;
        }
        savingsSnapshot[user] = savingsAccumulator;
    }

    /**
     * @dev Update streak state for `user` based on UTC-day boundary.
     *  - First deposit ever            → streak = 1
     *  - Same UTC day as last deposit  → no change
     *  - Next UTC day                  → streak++ (capped at MAX_STREAK)
     *  - Gap > 1 UTC day (fox died)    → streak = 1 (revival)
     */
    function _updateStreak(address user) private {
        uint256 currentDay = block.timestamp / 86400;
        uint256 lastDay    = lastDepositDay[user];

        if (lastDay == 0) {
            streakDay[user] = 1;
        } else if (currentDay > lastDay) {
            uint256 gap = currentDay - lastDay;
            if (gap == 1) {
                uint8 next = streakDay[user] + 1;
                streakDay[user] = next > MAX_STREAK ? MAX_STREAK : next;
            } else {
                // Fox died — streak resets
                streakDay[user] = 1;
            }
        }
        // else: same UTC day → no streak change (deposit still adds USDT)
        lastDepositDay[user] = currentDay;
    }

    function _tryClaimWelcomeBonus(address user) private {
        if (
            streakDay[user] >= uint8(WELCOME_STREAK) &&
            !welcomeBonusClaimed[user] &&
            incentiveWallet != address(0) &&
            welcomeBonus > 0
        ) {
            uint256 allowance_ = usdt.allowance(incentiveWallet, address(this));
            uint256 bal_       = usdt.balanceOf(incentiveWallet);
            if (allowance_ >= welcomeBonus && bal_ >= welcomeBonus) {
                welcomeBonusClaimed[user] = true;
                usdt.safeTransferFrom(incentiveWallet, user, welcomeBonus);
                emit WelcomeBonusClaimed(user, welcomeBonus);
            }
        }
    }

    // ── Public Deposit Functions ──────────────────────────────────────────────

    function deposit(uint256 amount, bytes4 refCode) external nonReentrant {
        _deposit(msg.sender, msg.sender, amount, refCode);
    }

    /// @notice Deposit on behalf of `beneficiary` (sponsorship / x402 / agents).
    ///         `msg.sender` provides the USDT; `beneficiary` receives the deposit
    ///         credit, streak update, referral binding and welcome bonus.
    function depositFor(address beneficiary, uint256 amount, bytes4 refCode) external nonReentrant {
        require(beneficiary != address(0), "Zero beneficiary");
        _deposit(msg.sender, beneficiary, amount, refCode);
    }

    function _deposit(address payer, address user, uint256 amount, bytes4 refCode) private {
        require(!emergencyMode, "Emergency mode");
        require(amount >= MIN_DEPOSIT, "Below minimum deposit");

        bool isFirstDeposit = depositorIndex[user] == 0;

        // Register new depositor
        if (isFirstDeposit) {
            require(depositorCount < MAX_DEPOSITORS, "Max depositors reached");
            depositorCount++;
            depositorList.push(user);
            depositorIndex[user] = depositorCount;

            // Generate referral code for new user
            referralCode[user] = bytes4(keccak256(abi.encodePacked(user)));
            codeOwner[referralCode[user]] = user;

            // Register referral (only on first deposit, no self-referral)
            if (refCode != bytes4(0) && referredBy[user] == address(0)) {
                address codeReferrer = codeOwner[refCode];
                if (codeReferrer != address(0) && codeReferrer != user) {
                    referredBy[user] = codeReferrer;
                }
            }
        }

        // Settle accumulated savings BEFORE state changes
        _settleSavings(user);

        // Snapshot OLD chances for Fenwick subtraction (uses current streak/deposit)
        uint256 idx = depositorIndex[user];
        uint256 oldChances = _effectiveChances(user);
        if (oldChances > 0) _fenwickSub(idx, oldChances);

        // Streak update happens BEFORE recomputing new chances so new chances
        // reflect the updated streak day.
        _updateStreak(user);

        // Pull USDT from payer (may be msg.sender or sponsor) → contract → Aave
        usdt.safeTransferFrom(payer, address(this), amount);
        aavePool.supply(address(usdt), amount, address(this), 0);

        deposits[user] += amount;
        totalPrincipal += amount;

        // Activate referral on user's first deposit (referrer must be an active depositor)
        if (isFirstDeposit) {
            address referrer = referredBy[user];
            if (referrer != address(0) && deposits[referrer] >= MIN_DEPOSIT) {
                uint256 refOldChances = _effectiveChances(referrer);
                activeReferrals[referrer]++;
                uint256 refIdx = depositorIndex[referrer];
                if (refOldChances > 0 && refIdx > 0) _fenwickSub(refIdx, refOldChances);
                uint256 refNewChances = _effectiveChances(referrer);
                if (refNewChances > 0 && refIdx > 0) _fenwickAdd(refIdx, refNewChances);
            }
        }

        // Add NEW chances to Fenwick
        uint256 newChances = _effectiveChances(user);
        if (newChances > 0) _fenwickAdd(idx, newChances);

        // Welcome bonus check (was previously in save())
        _tryClaimWelcomeBonus(user);

        _mixEntropy();
        emit Deposited(user, payer, amount, streakDay[user]);
    }

    // ── Withdraw ──────────────────────────────────────────────────────────────

    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0, "Zero amount");
        require(deposits[msg.sender] >= amount, "Insufficient deposit");

        _settleSavings(msg.sender);

        uint256 origPrincipal = totalPrincipal;

        uint256 idx = depositorIndex[msg.sender];
        uint256 oldChances = _effectiveChances(msg.sender);
        if (oldChances > 0) _fenwickSub(idx, oldChances);

        deposits[msg.sender] -= amount;
        totalPrincipal -= amount;

        // If user fully withdrew → deactivate referral + reset streak state
        if (deposits[msg.sender] == 0) {
            address referrer = referredBy[msg.sender];
            if (referrer != address(0) && activeReferrals[referrer] > 0) {
                uint256 refOldChances = _effectiveChances(referrer);
                uint256 refIdx = depositorIndex[referrer];
                activeReferrals[referrer]--;
                if (refOldChances > 0 && refIdx > 0) _fenwickSub(refIdx, refOldChances);
                uint256 refNewChances = _effectiveChances(referrer);
                if (refNewChances > 0 && refIdx > 0) _fenwickAdd(refIdx, refNewChances);
            }
            // Reset streak — user has no fox; next deposit starts fresh at streak=1
            streakDay[msg.sender] = 0;
            lastDepositDay[msg.sender] = 0;
        }

        uint256 newChances = _effectiveChances(msg.sender);
        if (newChances > 0) _fenwickAdd(idx, newChances);

        // Proportional aToken withdraw (Aave 1-unit rounding fix)
        uint256 aUsdtBal = aUsdt.balanceOf(address(this));
        uint256 aaveAmount = (aUsdtBal >= origPrincipal)
            ? amount
            : (amount * aUsdtBal) / origPrincipal;
        uint256 actualOut = aavePool.withdraw(address(usdt), aaveAmount, msg.sender);
        require(actualOut > 0, "Aave withdraw failed");

        _mixEntropy();
        emit Withdrawn(msg.sender, actualOut);
    }

    // ── Savings claim ─────────────────────────────────────────────────────────

    function claimSavings() external nonReentrant {
        _settleSavings(msg.sender);
        uint256 amount = _pendingSavings[msg.sender];
        require(amount > 0, "Nothing to claim");

        _pendingSavings[msg.sender] = 0;
        totalSavings -= amount;

        usdt.safeTransfer(msg.sender, amount);
        emit SavingsClaimed(msg.sender, amount);
    }

    function pendingSavings(address user) external view returns (uint256) {
        uint256 dep = deposits[user];
        uint256 extra = 0;
        if (dep > 0 && savingsAccumulator > savingsSnapshot[user]) {
            extra = dep * (savingsAccumulator - savingsSnapshot[user]) / 1e18;
        }
        return _pendingSavings[user] + extra;
    }

    // ── Self.xyz verification (keeper-marked) ─────────────────────────────────

    function setSelfVerified(address user) external onlyKeeper {
        require(user != address(0), "Zero address");
        require(!selfVerified[user], "Already verified");

        uint256 idx = depositorIndex[user];
        if (idx > 0 && deposits[user] > 0) {
            uint256 oldChances = _effectiveChances(user);
            selfVerified[user] = true;
            uint256 newChances = _effectiveChances(user);
            if (oldChances > 0) _fenwickSub(idx, oldChances);
            if (newChances > 0) _fenwickAdd(idx, newChances);
        } else {
            selfVerified[user] = true;
        }
        emit SelfVerificationSet(user);
    }

    // ── Raffle ────────────────────────────────────────────────────────────────

    function commitRaffle() external onlyKeeper {
        require(!emergencyMode, "Emergency mode");
        require(!raffleCommitted, "Already committed");
        require(depositorCount > 0, "No depositors");
        require(_fenwickTotal() > 0, "No active chances");

        committedEntropy = entropyAccumulator;
        committedBlock   = block.number;
        raffleCommitted  = true;
        emit RaffleCommitted(committedBlock);
    }

    function executeRaffle() external onlyKeeper nonReentrant {
        require(!emergencyMode, "Emergency mode");
        require(raffleCommitted, "Not committed");
        require(block.number >= committedBlock + 10, "Too soon after commit");
        require(block.number <= committedBlock + 250, "Commit expired, re-commit");

        uint256 total = _fenwickTotal();
        require(total > 0, "No chances");

        bytes32 futureHash = blockhash(committedBlock + 5);
        uint256 rand = uint256(keccak256(abi.encodePacked(committedEntropy, futureHash))) % total;

        uint256 winnerIdx = _fenwickFind(rand);
        address winner    = depositorList[winnerIdx - 1];

        uint256 aBalance  = aUsdt.balanceOf(address(this));
        uint256 prizePool = aBalance > totalPrincipal ? aBalance - totalPrincipal : 0;

        raffleCommitted = false;

        if (prizePool == 0) {
            emit RaffleExecuted(winner, 0, 0);
            return;
        }

        uint256 fee   = prizePool * raffleFee / 10_000;
        uint256 prize = prizePool - fee;

        if (fee > 0)   aavePool.withdraw(address(usdt), fee,   PLATFORM_WALLET);
        if (prize > 0) aavePool.withdraw(address(usdt), prize, winner);

        _mixEntropy();
        emit RaffleExecuted(winner, prize, fee);
    }

    function forceResetCommit() external onlyKeeper {
        require(raffleCommitted, "Not committed");
        require(block.number > committedBlock + 250, "Not yet expired");
        raffleCommitted = false;
    }

    // ── Merit rewards (keeper-driven) ─────────────────────────────────────────

    /// @notice Convert claimed Merit/Masiv aUSDT rewards into plain USDT for the
    ///         savings system. Aave base yield (aUSDT > principal) is NOT touched.
    function withdrawMeritToSavings(uint256 amount) external onlyKeeper nonReentrant {
        require(!emergencyMode, "Emergency mode");
        require(amount > 0, "Zero amount");
        uint256 aUsdtBal = aUsdt.balanceOf(address(this));
        require(aUsdtBal >= totalPrincipal + amount, "Would touch principal");
        aavePool.withdraw(address(usdt), amount, address(this));
    }

    function distributeSavingsRewards() external onlyKeeper nonReentrant {
        require(!emergencyMode, "Emergency mode");
        require(totalPrincipal > 0, "No depositors");

        uint256 usdtBalance = usdt.balanceOf(address(this));
        require(usdtBalance > totalSavings, "No new rewards");
        uint256 received = usdtBalance - totalSavings;

        uint256 fee          = received * savingsFee / 10_000;
        uint256 toDistribute = received - fee;

        if (fee > 0) usdt.safeTransfer(PLATFORM_WALLET, fee);

        savingsAccumulator += toDistribute * 1e18 / totalPrincipal;
        totalSavings += toDistribute;

        emit SavingsDistributed(toDistribute, fee);
    }

    // ── Emergency ─────────────────────────────────────────────────────────────

    function setEmergencyMode(bool active) external onlyOwner {
        emergencyMode = active;
        emit EmergencyModeSet(active);
    }

    function emergencyReturn(uint256 start, uint256 end) external onlyOwner nonReentrant {
        require(emergencyMode, "Not in emergency mode");
        require(end <= depositorList.length, "End out of bounds");

        for (uint256 i = start; i < end; i++) {
            address user = depositorList[i];
            if (returned[user]) continue;
            uint256 dep = deposits[user];
            if (dep == 0) continue;

            returned[user] = true;
            _settleSavings(user);
            uint256 userIdx = depositorIndex[user];
            uint256 userChances = _effectiveChances(user);
            if (userChances > 0 && userIdx > 0) _fenwickSub(userIdx, userChances);
            deposits[user] = 0;

            uint256 aUsdtBal_     = aUsdt.balanceOf(address(this));
            uint256 origPrincipal_ = totalPrincipal;
            totalPrincipal -= dep;

            uint256 aaveAmt_ = (aUsdtBal_ >= origPrincipal_)
                ? dep
                : (dep * aUsdtBal_) / origPrincipal_;
            if (aaveAmt_ > aUsdtBal_) aaveAmt_ = aUsdtBal_;

            uint256 actualOut = aavePool.withdraw(address(usdt), aaveAmt_, user);
            emit EmergencyReturned(user, actualOut);
        }
    }

    // ── Owner Setters ─────────────────────────────────────────────────────────

    function setKeeper(address _keeper) external onlyOwner {
        require(_keeper != address(0), "Zero keeper");
        keeper = _keeper;
        emit KeeperSet(_keeper);
    }

    function setIncentiveWallet(address _wallet) external onlyOwner {
        incentiveWallet = _wallet;
        emit IncentiveWalletSet(_wallet);
    }

    function setWelcomeBonus(uint256 _amount) external onlyOwner {
        welcomeBonus = _amount;
        emit WelcomeBonusSet(_amount);
    }

    function setWelcomeStreak(uint256 _days) external onlyOwner {
        require(_days >= 1 && _days <= MAX_STREAK, "Must be 1-7");
        WELCOME_STREAK = _days;
        emit WelcomeStreakSet(_days);
    }

    function setRaffleFee(uint256 _bps) external onlyOwner {
        require(_bps <= MAX_FEE_BPS, "Exceeds max fee");
        raffleFee = _bps;
        emit RaffleFeeSet(_bps);
    }

    function setSavingsFee(uint256 _bps) external onlyOwner {
        require(_bps <= MAX_FEE_BPS, "Exceeds max fee");
        savingsFee = _bps;
        emit SavingsFeeSet(_bps);
    }

    // ── Views ─────────────────────────────────────────────────────────────────

    /**
     * @notice Returns the fox's health for `user` — used by the UI to render
     *         the countdown + warning before death.
     *
     * @return alive             true if the fox is alive (deposited today or yesterday UTC)
     * @return currentStreak     current streak day (0 if dead or never deposited)
     * @return deadlineTimestamp UTC timestamp when the fox dies if no further deposit
     *                           (== (lastDepositDay + 2) * 86400)
     * @return secondsUntilDead  seconds remaining before death (0 if already dead)
     */
    function getStatus(address user) external view returns (
        bool alive,
        uint8 currentStreak,
        uint256 deadlineTimestamp,
        uint256 secondsUntilDead
    ) {
        uint256 lastDay = lastDepositDay[user];
        if (lastDay == 0 || deposits[user] == 0) {
            return (false, 0, 0, 0);
        }
        uint256 currentDay = block.timestamp / 86400;
        alive = (currentDay - lastDay) <= 1;
        currentStreak = alive ? streakDay[user] : 0;
        deadlineTimestamp = (lastDay + 2) * 86400;
        secondsUntilDead = block.timestamp >= deadlineTimestamp
            ? 0
            : deadlineTimestamp - block.timestamp;
    }

    function referralCodeFor(address user) external view returns (string memory) {
        bytes4 code = referralCode[user];
        if (code == bytes4(0)) return "";
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(8);
        for (uint256 i = 0; i < 4; i++) {
            str[i * 2]     = alphabet[uint8(code[i] >> 4)];
            str[i * 2 + 1] = alphabet[uint8(code[i] & 0x0f)];
        }
        return string(str);
    }

    function effectiveChances(address user) external view returns (uint256) {
        return _effectiveChances(user);
    }

    function totalEffectiveChances() external view returns (uint256) {
        return _fenwickTotal();
    }

    function currentPrizePool() external view returns (uint256) {
        uint256 aBalance = aUsdt.balanceOf(address(this));
        return aBalance > totalPrincipal ? aBalance - totalPrincipal : 0;
    }
}

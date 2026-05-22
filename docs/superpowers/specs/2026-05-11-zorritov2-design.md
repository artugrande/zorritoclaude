# ZorritoV2 — Design Spec
**Date:** 2026-05-11  
**Status:** Approved  
**Replaces:** Zorrito v8 (`0x43Fdf0FBbF64ee0b93A8C12e42C9AE6E9B6bb917`)

---

## 1. Product Vision

Zorrito V2 is a **savings platform** on Celo built on Aave V3. Users deposit USDT which earns yield on Aave. That yield is split into two streams:

1. **Direct savings rewards** — distributed proportionally to all depositors (from Merit/Masiv incentives)
2. **Weekly bonus prize** — the pooled base Aave yield awarded to one active saver each week

Principal is never at risk. Users can withdraw at any time.

**Tagline:** *"Ahorrá USDT. Ganá un premio extra semanal."*

**Key messaging change:** Remove all "lottery / lotería / no-loss lottery" language. Frame the weekly prize as a bonus reward on top of savings, not a lottery ticket.

---

## 2. Smart Contract

### 2.1 Core Mechanics

| Function | Description |
|----------|-------------|
| `deposit(uint256 amount, bytes4 referralCode)` | Deposit USDT → Aave. Mint chances. Minimum deposit: 0.25 USDT. |
| `withdraw(uint256 amount)` | Withdraw principal from Aave → user. Updates Fenwick tree. |
| `save()` | Daily save action (costs 0 USDT, only gas). Keeps user active in current week's draw. Increments daily streak (max 7). Triggers welcome bonus on day 5 if not yet claimed. |
| `claimSavings()` | Withdraw accumulated savings rewards (Merit/Masiv) to user wallet. |
| `executeRaffle()` | Keeper-only. Selects winner using Fenwick tree + entropy accumulator. Transfers prize minus platform fee. |
| `commitRaffle()` | Keeper-only. Fixes entropy for this week's draw. Must be called before `executeRaffle()`. |
| `distributeSavingsRewards()` | Keeper-only. Reads actual USDT balance increase (from Merit claim), takes 15% platform fee, distributes remainder to depositors via O(1) accumulator. |
| `emergencyReturn(uint256 start, uint256 end)` | Owner-only. Returns principal to depositors in batches without user interaction. For future migrations. |
| `setEmergencyMode(bool)` | Owner-only. Pauses deposits and saves. Required before calling `emergencyReturn`. |

### 2.2 Chances Calculation

```
effectiveChances = depositAmount × streakMultiplier × referralMultiplier

streakMultiplier = streakDay (1–7, resets each week)
referralMultiplier = 1 + (activeReferrals × 0.10)
```

### 2.3 Weekly Streak (resets each week)

- Each day the user calls `save()` within the weekly cycle: `streakDay += 1`
- Max streak: 7 (= 7× multiplier on Sunday before the draw)
- **Resets to 0 every Monday** when the new weekly cycle begins
- A user who saves all 7 days competes at 7× regardless of how long they've been using the protocol
- Rationale: gives new users fair competition, creates weekly re-engagement loop

### 2.4 Winner Selection — Fenwick Tree

Replace current O(n) loop with a Binary Indexed Tree:

- Each depositor assigned a stable index (1 to N) on first deposit
- Fenwick tree stores cumulative `effectiveChances` by index
- On `commitRaffle()`: snapshot entropy accumulator → generate random number in [0, totalEffectiveChances)
- On `executeRaffle()`: O(log n) binary search on Fenwick tree to find winner
- Gas: ~50,000 gas per draw regardless of user count (vs ~25M gas at 5,000 users today)
- Scales to 1M+ depositors with no contract changes

**Trade-off:** each deposit/withdraw/save requires O(log n) Fenwick updates (~20 writes). At Celo gas prices this costs ~$0.00001 extra per transaction — imperceptible to users.

### 2.5 Entropy Accumulator

Rolling entropy mixed on every user action throughout the week using `block.prevrandao` (EIP-4399), `block.timestamp`, `msg.sender`, `totalDeposited`. Committed on Monday, executed 10 blocks later.

### 2.6 Savings Rewards Distribution — O(1) Accumulator

```solidity
// On distributeSavingsRewards():
uint256 received = usdtBalance - totalPrincipal - totalSavings;
uint256 fee = received * SAVINGS_FEE_BPS / 10000;        // 15% to platform
uint256 toDistribute = received - fee;
savingsAccumulator += toDistribute * 1e18 / totalPrincipal;

// User's claimable savings:
claimable = deposit * (savingsAccumulator - userAccumulatorSnapshot) / 1e18;
```

No loops. Scales to any number of users. Contract is agnostic to reward source — any protocol can call `distributeSavingsRewards()`.

### 2.7 Referral System

- **Code generation:** `bytes4(keccak256(abi.encodePacked(userAddress)))` → 8-char hex string (e.g., `A3F2B1C4`)
- **Registration:** new user provides code on first deposit
- **Bonus:** referrer gets +10% effective chances per active referral
- **Active referral:** referred user has >0 USDT deposited
- **Anti-sybil:** referrer must have ≥1 USDT deposited to earn bonus
- **No cap** on number of referrals
- Bonus is recalculated on each draw — if referral withdraws all, bonus disappears automatically

### 2.8 Welcome Bonus — Incentive Wallet

```solidity
address public incentiveWallet;   // set by owner, external wallet
uint256 public welcomeBonus;      // default: 0.5 USDT (configurable by owner)
uint256 public WELCOME_STREAK;    // default: 5 (days of consecutive saves required)
mapping(address => bool) public welcomeBonusClaimed;
```

- On `save()`: if user reaches `streakDay == WELCOME_STREAK` for the first time AND `!welcomeBonusClaimed[msg.sender]` AND `incentiveWallet` has funds AND allowance sufficient → transfer `welcomeBonus` USDT from `incentiveWallet` to `msg.sender`
- Sets `welcomeBonusClaimed[msg.sender] = true` — one-time per address, forever
- Silently skips if wallet is empty — save never fails because of this
- Rationale: rewards users who demonstrate commitment (5 days of engagement), not just deposit size
- Owner controls the incentive wallet address, bonus amount, and streak threshold
- Grants (e.g., Celo Public Goods) load the incentive wallet — funds are fully visible on-chain, separate from protocol TVL

### 2.9 Revenue Model

| Stream | Fee | Recipient |
|--------|-----|-----------|
| Weekly prize | 10% of yield | `PLATFORM_WALLET` |
| Savings rewards | 15% of Merit/Masiv rewards | `PLATFORM_WALLET` |

- Both fees are on yield only — principal is never touched
- Fee percentages are configurable by `owner` with hardcoded max (20% cap each)
- `PLATFORM_WALLET` is a constant set at deploy time

**Revenue projection:**
| TVL | Annual revenue (approx.) |
|-----|--------------------------|
| 100k USDT | ~$2,250 |
| 500k USDT | ~$11,250 |
| 1M USDT | ~$22,500 |

### 2.10 Emergency Return

```solidity
function setEmergencyMode(bool active) external onlyOwner
function emergencyReturn(uint256 start, uint256 end) external onlyOwner nonReentrant
```

- Owner calls `setEmergencyMode(true)` → pauses deposits and saves
- Owner calls `emergencyReturn(0, 100)`, `(100, 200)`, etc. in batches
- For each user: withdraws their Aave position and sends USDT directly to their wallet
- `returned[address]` mapping prevents double-payment
- Designed for clean migration to V3 without requiring user interaction

### 2.11 Access Control

| Role | Capabilities |
|------|-------------|
| `owner` | Set incentive wallet, welcome bonus, keeper address, fee percentages (within cap), emergency mode, emergency return |
| `keeper` | `commitRaffle`, `executeRaffle`, `distributeSavingsRewards` |
| Anyone | `deposit`, `withdraw`, `save`, `claimSavings` |

**The contract is NOT upgradeable.** No proxy pattern. Once deployed, core mechanics are immutable. The only path to changing logic is deploying V3 and using `emergencyReturn` to migrate.

### 2.12 Security

- `ReentrancyGuard` on all state-changing functions
- `SafeERC20` for all token transfers
- `require(actualOut > 0)` on Aave withdrawals
- Zero-address checks on constructor
- Fixed pragma `0.8.20`
- `MIN_DEPOSIT = 0.25 USDT` — enforced on every deposit call
- `MAX_DEPOSITORS = 8,000` (Fenwick tree + gas safety margin)
- Hardcoded fee cap (20%) prevents owner from draining yield

---

## 3. Keeper — Vercel Cron (3 jobs)

| Job | Schedule | Action |
|-----|----------|--------|
| `savings-distributor` | Daily 12:00 UTC | Check Merkl API → if rewards pending → claim → `distributeSavingsRewards()` |
| `raffle-commit` | Monday 10:00 UTC | `commitRaffle()` — fixes entropy for this week |
| `raffle-execute` | Monday 10:05 UTC | `executeRaffle()` — selects winner, transfers prize |

- Keeper has its own private key with only CELO for gas
- Deployed as Vercel API routes with cron triggers (Pro plan)
- If a job fails, it retries next cycle — no funds at risk

---

## 4. Frontend Updates

**Base URL:** zorrito.app

### 4.1 index.html
- New hero: tagline *"Ahorrá USDT. Ganá un premio extra semanal."*
- Remove all lottery/fish/ticket language
- New cards:
  - **Tu depósito** — balance + withdrawal button (min. 0.25 USDT shown on deposit input)
  - **Mis Savings** — claimable balance + Claim button
  - **Mis Chances** — deposit × streak × referrals breakdown
  - **Tu código de referido** — 8-char code + copy button + share link
  - **Streak semanal** — day 1–7 visual progress, multiplier. Shows progress toward welcome bonus: *"Día 3/5 — seguí ahorrando para ganar 0.5 USDT de regalo 🎁"*
  - **Próximo premio** — countdown to Sunday draw
- Welcome bonus banner: *"🎁 ¡Ganaste 0.5 USDT! Completaste 5 días seguidos ahorrando"* (shows after day 5 save, if not yet claimed)

### 4.2 docs.html — Full rewrite
1. **Qué es Zorrito** — savings platform framing, not lottery
2. **Cómo funciona** — step by step: deposit → save daily → earn savings → win weekly prize
3. **Sistema de chances** — deposit × streak × referrals, with examples
4. **El premio semanal** — source (Aave yield), when (every Sunday), how winner is selected
5. **Savings rewards** — what they are, how they accumulate, how to claim
6. **Referidos** — code generation, +10% per referral, conditions
7. **Seguridad y transparencia** — immutable contract, owner limitations, emergency return, on-chain verification
8. **FAQ** — ¿puedo perder mi USDT? / ¿qué pasa si no ahorro un día? / ¿cómo sé que el sorteo es justo?

### 4.3 stats.html
- Add: total savings rewards distributed all-time
- Add: top referrers leaderboard
- Update prize history to show weekly draws

### 4.4 agent.html
- Update ABI with V2 functions (`save`, `claimSavings`, `distributeSavingsRewards`, referral params)
- Update example calls

### 4.5 terms.html
- Replace "lottery" / "no-loss lottery" with "savings platform" / "weekly bonus prize"
- Add referral program terms
- Add welcome bonus terms

### 4.6 privacy.html
- Minor updates to product name references only

---

## 5. Testing — Hardhat Fork Tests

Before mainnet deploy, full test suite on Celo mainnet fork:

- `deposit()` → correct Aave supply, Fenwick update, revert if amount < 0.25 USDT
- `withdraw()` → correct Aave withdrawal, Fenwick update
- `save()` → streak increment, weekly reset, welcome bonus trigger on day 5 (first time only)
- `commitRaffle()` + `executeRaffle()` → correct winner selection, prize distribution, platform fee
- `distributeSavingsRewards()` → correct accumulator update, platform fee, claimable balance
- Referral registration, bonus calculation, active/inactive referral transitions
- `emergencyReturn()` → full batch return, no double-pay
- Edge cases: MAX_DEPOSITORS cap, deposit below 0.25 USDT reverts, empty incentive wallet silently skips bonus, welcome bonus only claimed once per address, zero yield week

---

## 6. Deploy Sequence

1. Run full Hardhat test suite on Celo mainnet fork — must pass 100%
2. Deploy ZorritoV2 to Alfajores testnet — smoke test
3. Deploy ZorritoV2 to Celo mainnet
4. Set `incentiveWallet` (owner's pre-existing wallet) and call `approve` from that wallet
5. Set `keeper` address to Vercel cron wallet
6. Deploy Vercel cron jobs with new contract address + keeper private key
7. Update frontend with new contract address and V2 ABI
8. Notify v8 users manually — they migrate at their own pace

---

## 7. Customize Fox — AI Image Generation

### 7.1 Overview

Users can pay 1 USDT to generate a custom AI version of their Zorrito fox. The image is cosmetic — it replaces the default fox avatar in their profile within zorrito.app. Timed with FIFA World Cup 2026 for viral potential.

### 7.2 User Flow

1. User clicks **"Customize"** button on their profile
2. Frontend prompts: *"Pay 1 USDT to unlock your custom Zorrito"*
3. User approves USDT transfer to `customizationWallet` (separate from incentiveWallet)
4. Backend verifies the transaction on-chain (polls until confirmed)
5. Modal opens with two inputs:
   - **Country jersey selector** — dropdown of all FIFA World Cup 2026 teams, shows flag + country name
   - **Accessories text box** — free-form prompt: *"add a World Cup trophy, golden boots, confetti..."*
6. User clicks **"Generate my Zorrito"**
7. Vercel AI SDK generates image using FLUX model (via fal.ai)
8. Image uploaded to **Vercel Blob** → permanent CDN URL
9. `walletAddress → imageURL` stored in **Vercel KV**
10. User's Zorrito avatar updates instantly across the app

### 7.3 Prompt Construction

The prompt is assembled programmatically — user never writes raw AI prompt:

```
"A cartoon fox wearing a [COUNTRY] soccer jersey with the number 10,
[ACCESSORIES], celebrating with confetti, vibrant colors,
clean white background, digital art style, Zorrito mascot"
```

Example: *"A cartoon fox wearing a Brazil soccer jersey with the number 10, holding a World Cup trophy and a soccer ball, celebrating with confetti, vibrant colors, clean white background, digital art style, Zorrito mascot"*

### 7.4 Technical Stack

| Component | Technology |
|-----------|-----------|
| Image generation | Vercel AI SDK + fal.ai (FLUX model) |
| Image storage | Vercel Blob |
| Avatar persistence | Vercel KV (`wallet → imageURL`) |
| Payment verification | Backend polls Celo RPC for tx confirmation |
| Payment recipient | `customizationWallet` (separate from `incentiveWallet`) |

### 7.5 Revenue

- 1 USDT per customization → `customizationWallet`
- User can regenerate unlimited times (each costs 1 USDT)
- Vercel Blob + KV costs are negligible (~$0.001 per image)

### 7.6 Frontend Changes

- Profile section: shows fox avatar (default or custom)
- "Customize" button visible to all logged-in users
- Country selector: flags + names for all 48 World Cup 2026 teams
- Accessories input: placeholder *"e.g. golden trophy, soccer ball, confetti, sunglasses"*
- Loading state: *"Generating your Zorrito..."* with animation
- Result: preview image + *"Save this Zorrito"* button
- Stored image loads automatically on next wallet connect

---

## 8. What Does NOT Change

- USDT on Celo (same token address)
- Aave V3 Celo integration
- MiniPay compatibility
- No custody of user funds — principal always in Aave
- Open source contract on CeloScan

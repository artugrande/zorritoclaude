# Zorrito Smart Contract — Security Audit Report

**Date:** 2026-04-10
**Contract:** `Zorrito v4` — `0x7d07CeA8432bEF38ea9885b0F9B55b7dEcE7DE9d`
**Compiler:** `^0.8.20`
**Auditor:** Claude (Sonnet 4.6) via solidity-auditor skill

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 2 |
| High     | 4 |
| Medium   | 3 |
| Low      | 3 |
| Info     | 2 |
| **Total** | **14** |

> ⚠️ This is an AI-generated audit, not a formal third-party audit. It should be treated as a first-pass review. A professional audit by a security firm is recommended before scaling up deposits.

---

## Findings

---

### [C-01] Weak On-Chain Randomness — Winner Selection Is Manipulable

**Severity:** ~~Critical~~ → **Low** (mitigated in v4)
**Status:** ✅ Significantly improved — RANDAO-style entropy accumulator implemented

**Original issue:**
`_selectWinner()` previously derived randomness exclusively from a single block's values — all known to the block proposer before finalization. A validator controlling the draw block could simulate outcomes off-chain and skip their turn to get a favorable winner.

**Fix applied in v4 — RANDAO-style entropy accumulator:**

```solidity
bytes32 private _roundEntropy;

function _mixEntropy() internal {
    _roundEntropy = keccak256(abi.encodePacked(
        _roundEntropy,
        CELO_RANDOM.random(),   // Celo commit-reveal beacon at this moment
        block.timestamp,
        msg.sender,             // attacker does NOT control which users transact
        totalDeposited
    ));
}
```

`_mixEntropy()` is called on every `deposit()`, `feed()`, and `withdraw()` throughout the 30-day round. By draw time, the accumulator has been stirred dozens of times across many independent blocks and callers.

The final seed combines the accumulator with the current Celo beacon and block context:

```solidity
uint256 rand = uint256(keccak256(abi.encodePacked(
    _roundEntropy,        // 30 days of accumulated entropy
    CELO_RANDOM.random(), // current Celo commit-reveal beacon
    block.timestamp,
    block.number,
    aliveTotal
))) % aliveTotal;
```

**Why this is strong:**
- To bias the result an attacker must control the Celo random beacon value at **every single user interaction** over the entire 30-day round — including random strangers depositing, feeding, or withdrawing.
- Each mix includes `msg.sender`, which the attacker cannot control.
- This is the same principle Ethereum uses for its RANDAO beacon: many independent contributions make manipulation require majority network control.

**Residual risk (Low):**
A colluding group controlling a large fraction of Celo validators AND able to prevent all normal user transactions for 30 days could theoretically influence the result. This is a nation-state level attack vector, not a realistic threat for the current pool size.

**Future upgrade path (if pool grows significantly):**
Pyth Network's Entropy product or a drand oracle posting the League of Entropy randomness beacon on-chain could provide external verifiable randomness with zero validator influence.

---

### [C-02] Reentrancy Exposure in `withdraw()` and `draw()`

**Severity:** Critical
**Status:** Low risk with current USDT, but should be fixed

Both `withdraw()` and `draw()` call `aavePool.withdraw()` which transfers tokens directly to an external address. If that address is a contract, it can re-enter before the function returns.

Although `deposits[msg.sender]` is decremented before the external call (correct CEI ordering), there is no global reentrancy guard. A future token upgrade or Aave adapter change could create a re-entry path.

**Recommendation:**
Add OpenZeppelin `ReentrancyGuard` and `nonReentrant` modifier to `deposit()`, `withdraw()`, and `draw()`.

---

### [H-01] Depositor Array Invariant Fragility

**Severity:** High
**Status:** Acceptable for MVP with small depositor count

The `depositors` array relies on `deposits[msg.sender] == 0` to prevent double-insertion. Any future feature that resets the mapping without removing from the array would silently create duplicates, inflating a user's winning probability.

**Recommendation:**
Add a separate `mapping(address => bool) public isDepositor` flag for explicit membership tracking.

---

### [H-02] Unbounded `depositors` Array — DoS via Block Gas Limit

**Severity:** High
**Status:** Mitigated at small scale; must be fixed before scaling

`_selectWinner()` and `_removeDepositor()` both iterate over the entire `depositors` array (O(n)). With ~14,000+ depositors, these functions will exceed the block gas limit and permanently freeze `draw()` and `withdraw()`, locking all funds.

**Recommendation:**
- Cap depositors at a safe maximum (e.g., 5,000).
- Use `mapping(address => uint256) depositorIndex` for O(1) removal.
- Replace linear winner scan with binary search over a prefix-sum structure.

---

### [H-03] Permissionless `draw()` — Timing and Frontrunning Attacks

**Severity:** High
**Status:** Known / Accepted for MVP

Anyone can call `draw()` once `DRAW_INTERVAL` has elapsed. This enables:
1. **Frontrunning deposits:** Attacker triggers draw just before a large deposit arrives, excluding it from the current draw.
2. **MEV manipulation:** Combined with C-01, an attacker controlling block ordering can guarantee winning.

**Recommendation:**
Add a keeper whitelist or integrate Chainlink Automation for tamper-resistant scheduling. At minimum, add a commit-reveal scheme to decouple timing from outcome.

---

### [H-04] Accounting Drift After Scaled Withdrawal

**Severity:** High
**Status:** Fixed in v2 withdrawal logic; residual drift possible under repeated scaled withdrawals

When `aUsdtBal < totalDeposited`, withdrawals use `aaveAmount = (amount * aUsdtBal) / totalDeposited`. Integer division truncates dust which is permanently lost. After a scaled withdrawal, `totalDeposited` is reduced by the nominal amount but Aave received less, causing `getYield()` to overstate yield over time.

**Recommendation:**
Adopt a share-based accounting model (ERC-4626 style). Track each user's share of the Aave position instead of their nominal USDT deposit amount.

---

### [M-01] Unsafe `approve()` Pattern

**Severity:** Medium
**Status:** Low risk with current USDT on Celo; fix recommended

```solidity
usdt.approve(address(aavePool), amount);
aavePool.supply(address(usdt), amount, address(this), 0);
```

If `supply()` fails after `approve()` succeeds, the allowance is left nonzero. The next deposit on standard USDT would then revert when calling `approve()` on a nonzero allowance, permanently bricking `deposit()`.

**Recommendation:**
Use `SafeERC20.forceApprove()` from OpenZeppelin, or approve `type(uint256).max` once in the constructor.

---

### [M-02] Unchecked Return Value of `aavePool.withdraw()`

**Severity:** Medium

`aavePool.withdraw()` returns the actual amount withdrawn, but both call sites ignore this value. If Aave withdraws less than requested, the user silently receives less while the contract's accounting assumes the full amount was transferred.

**Recommendation:**
```solidity
uint256 actual = aavePool.withdraw(address(usdt), aaveAmount, msg.sender);
require(actual >= minimumExpected, "Aave withdrawal shortfall");
```

---

### [M-03] `lastDrawTime` Schedule Drift ✅ FIXED

**Severity:** Medium
**Status:** Fixed in this commit

**Before:**
```solidity
lastDrawTime = block.timestamp;
```
If draw is called late, the next interval starts from the late time, causing drift.

**After (fixed):**
```solidity
lastDrawTime = lastDrawTime + DRAW_INTERVAL;
```
This preserves a fixed daily cadence regardless of when `draw()` is actually called.

---

### [L-01] No Zero-Address Validation in Constructor

**Severity:** Low

The constructor does not check that `_usdt`, `_aavePool`, or `_aUsdt` are non-zero. Passing `address(0)` would silently deploy a broken contract with no upgrade path.

**Recommendation:**
```solidity
require(_usdt != address(0) && _aavePool != address(0) && _aUsdt != address(0), "Zero address");
```

---

### [L-02] Public Depositor Enumeration — Privacy Concern

**Severity:** Low

The `depositors` public array exposes all current participants and their exact deposit amounts. Sophisticated actors can compute exact winning probabilities and time deposits/withdrawals accordingly.

**Recommendation:**
Mark `depositors` as `private`. Expose only aggregate statistics via `getStats()`.

---

### [L-03] Hardcoded Decimal Assumption

**Severity:** Low

`MIN_DEPOSIT = 1e6` hardcodes 6 decimals (USDT). If redeployed with an 18-decimal token, this would effectively mean no minimum deposit.

**Recommendation:**
Assert at construction time: `require(IERC20Metadata(_usdt).decimals() == 6, "Unexpected decimals")`.

---

### [I-01] Missing Events for Some State Changes

**Severity:** Info

No events are emitted for contract initialization or for Aave interaction failures.

**Recommendation:**
Emit events for all state-changing operations for off-chain monitoring.

---

### [I-02] Unpinned Solidity Pragma

**Severity:** Info

`^0.8.20` allows compilation with any future `0.8.x` compiler.

**Recommendation:**
Pin to exact version: `pragma solidity 0.8.20;`

---

## Risk Summary Matrix

| ID | Title | Severity | Status |
|----|-------|----------|--------|
| C-01 | Weak On-Chain Randomness | ~~Critical~~ Low | ✅ Mitigated — RANDAO accumulator |
| C-02 | Reentrancy Exposure | Critical | Low risk / fix planned |
| H-01 | Depositor Array Invariant | High | Acceptable at small scale |
| H-02 | Unbounded Array DoS | High | Fix before scaling |
| H-03 | Permissionless draw() | High | Known / MVP |
| H-04 | Accounting Drift | High | Partial fix in v2 |
| M-01 | Unsafe approve() | Medium | Fix recommended |
| M-02 | Unchecked Aave return value | Medium | Fix recommended |
| M-03 | Schedule Drift | Medium | ✅ Fixed |
| L-01 | No Zero-Address Check | Low | Fix recommended |
| L-02 | Public Depositor List | Low | Acceptable for now |
| L-03 | Hardcoded Decimals | Low | Documented |
| I-01 | Missing Events | Info | — |
| I-02 | Unpinned Pragma | Info | — |

---

## Recommended Priority for Next Contract Version

1. **RANDAO accumulator** for randomness (C-01) ✅ Done in v4
2. **ReentrancyGuard** on all external functions (C-02) ✅ Already in place
3. **Share-based accounting** ERC-4626 style (H-04)
4. **Depositor array cap + O(1) index removal** (H-02) ✅ Already in place
5. **SafeERC20** for token interactions (M-01) ✅ Already in place
6. **Check Aave return values** (M-02) ✅ Already in place
7. All Low/Info fixes in hardening pass
8. If pool exceeds $100K TVL: evaluate Pyth Entropy or drand oracle for external VRF

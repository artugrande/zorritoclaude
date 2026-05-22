# ZorritoV2 Keepers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy 3 Vercel cron jobs that run the ZorritoV2 keeper functions: daily savings distribution (Merkl/Merit rewards) and weekly raffle commit + execute.

**Architecture:** Three independent Vercel API routes in `zorritov2/api/`, each triggered by a Vercel cron. A shared `_lib/contract.js` provides the ethers wallet + contract setup. All routes return JSON, are protected by `CRON_SECRET`, and are idempotent (safe to retry).

**Tech Stack:** Node.js, ethers v6, Vercel cron (Pro plan), Merkl API v4

---

## File Map

| Path | Role |
|------|------|
| `zorritov2/api/_lib/contract.js` | Shared: provider, keeper wallet, ZorritoV2 + USDT contract instances |
| `zorritov2/api/raffle-commit.js` | Keeper: Monday 10:00 UTC — calls `commitRaffle()` |
| `zorritov2/api/raffle-execute.js` | Keeper: Monday 10:05 UTC — calls `executeRaffle()` |
| `zorritov2/api/savings-distributor.js` | Keeper: daily 12:00 UTC — checks Merkl → claims → `distributeSavingsRewards()` |
| `zorritov2/vercel.json` | Add cron triggers + build for `_lib` subfolder |

> **Note:** These files live in `zorritov2/` (the staging/v2 Vercel project), NOT in the root `api/`.

---

## Environment Variables (set in Vercel dashboard for `zorritov2` project)

| Var | Description |
|-----|-------------|
| `KEEPER_PRIVATE_KEY` | Private key of the keeper wallet (holds CELO for gas only) |
| `V2_CONTRACT_ADDRESS` | ZorritoV2 deployed address (set after deploy) |
| `CRON_SECRET` | Any random string — protects endpoints from outside calls |
| `MERKL_DISTRIBUTOR` | Merkl distributor on Celo (default: `0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae`) |
| `CELO_RPC_URL` | Defaults to `https://forno.celo.org` |

---

## Task 1: Shared Contract Library

**Files:**
- Create: `zorritov2/api/_lib/contract.js`

- [ ] **Step 1: Create the `_lib` folder and `contract.js`**

```js
// zorritov2/api/_lib/contract.js
/**
 * Shared setup for ZorritoV2 keeper API routes.
 * Provides: provider, keeperWallet, zorrito (contract), usdt (contract)
 */

const { ethers } = require("ethers");

const RPC           = process.env.CELO_RPC_URL || "https://forno.celo.org";
const USDT_ADDRESS  = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";

const KEEPER_ABI = [
  // Keeper functions
  "function commitRaffle() external",
  "function executeRaffle() external",
  "function distributeSavingsRewards() external",
  // View helpers
  "function raffleCommitted() view returns (bool)",
  "function committedBlock() view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
  "function totalSavings() view returns (uint256)",
  "function currentPrizePool() view returns (uint256)",
  "function emergencyMode() view returns (bool)",
];

const USDT_ABI = [
  "function balanceOf(address account) view returns (uint256)",
];

/**
 * Returns { provider, keeperWallet, zorrito, usdt, contractAddress }
 * Throws if required env vars are missing.
 */
function getContracts() {
  const privateKey = (process.env.KEEPER_PRIVATE_KEY || "").trim();
  if (!privateKey) throw new Error("KEEPER_PRIVATE_KEY not set");

  const contractAddress = (process.env.V2_CONTRACT_ADDRESS || "").trim();
  if (!contractAddress) throw new Error("V2_CONTRACT_ADDRESS not set");

  const provider     = new ethers.JsonRpcProvider(RPC);
  const keeperWallet = new ethers.Wallet(
    privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`,
    provider
  );

  const zorrito = new ethers.Contract(contractAddress, KEEPER_ABI, keeperWallet);
  const usdt    = new ethers.Contract(USDT_ADDRESS, USDT_ABI, provider);

  return { provider, keeperWallet, zorrito, usdt, contractAddress };
}

/**
 * Auth check: validates Authorization: Bearer <CRON_SECRET> header.
 * Returns true if auth is valid (or if CRON_SECRET is not set).
 */
function checkAuth(req) {
  const secret = (process.env.CRON_SECRET || "").trim();
  if (!secret) return true; // no secret configured — allow all (dev only)
  const auth = (req.headers["authorization"] || "").trim();
  return auth === `Bearer ${secret}`;
}

module.exports = { getContracts, checkAuth, USDT_ADDRESS };
```

- [ ] **Step 2: Verify the file is valid JS**

```bash
node -e "require('./zorritov2/api/_lib/contract.js')" 2>&1
```

Expected: no output (module loads cleanly — env vars not set is fine, the functions just aren't called)

- [ ] **Step 3: Commit**

```bash
git add zorritov2/api/_lib/contract.js
git commit -m "feat(v2/keeper): shared contract lib"
```

---

## Task 2: raffle-commit.js

**Files:**
- Create: `zorritov2/api/raffle-commit.js`

Called every Monday at 10:00 UTC. Calls `commitRaffle()` to snapshot the entropy accumulator. Idempotent: if already committed, skips gracefully.

- [ ] **Step 1: Write raffle-commit.js**

```js
// zorritov2/api/raffle-commit.js
/**
 * Keeper: commit the weekly raffle entropy.
 * Schedule: Monday 10:00 UTC  (vercel.json cron: "0 10 * * 1")
 *
 * Required env vars: KEEPER_PRIVATE_KEY, V2_CONTRACT_ADDRESS, CRON_SECRET
 *
 * Manual trigger:
 *   curl -X POST https://v2.zorrito.app/api/raffle-commit \
 *     -H "Authorization: Bearer <CRON_SECRET>"
 */

const { getContracts, checkAuth } = require("./_lib/contract");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!checkAuth(req)) return res.status(401).json({ error: "Unauthorized" });

  const ts = new Date().toISOString();

  try {
    const { zorrito, keeperWallet, contractAddress } = getContracts();

    // Guard: emergency mode
    const emergency = await zorrito.emergencyMode();
    if (emergency) {
      return res.status(200).json({ ts, action: "skipped", reason: "Emergency mode active" });
    }

    // Guard: already committed this week
    const alreadyCommitted = await zorrito.raffleCommitted();
    if (alreadyCommitted) {
      return res.status(200).json({ ts, action: "skipped", reason: "Raffle already committed" });
    }

    // Guard: no principal deposited
    const total = await zorrito.totalPrincipal();
    if (total === 0n) {
      return res.status(200).json({ ts, action: "skipped", reason: "No depositors" });
    }

    const tx      = await zorrito.commitRaffle();
    const receipt = await tx.wait();

    return res.status(200).json({
      ts,
      action:      "committed",
      txHash:      receipt.hash,
      explorer:    `https://celoscan.io/tx/${receipt.hash}`,
      keeper:      keeperWallet.address,
      contract:    contractAddress,
    });

  } catch (err) {
    console.error("[raffle-commit] Error:", err.message);
    return res.status(500).json({ ts, error: err.reason || err.message });
  }
};
```

- [ ] **Step 2: Verify JS syntax**

```bash
node -c zorritov2/api/raffle-commit.js && echo "OK"
```

Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add zorritov2/api/raffle-commit.js
git commit -m "feat(v2/keeper): raffle-commit cron handler"
```

---

## Task 3: raffle-execute.js

**Files:**
- Create: `zorritov2/api/raffle-execute.js`

Called every Monday at 10:05 UTC (5 minutes after commit, ~21 blocks on Celo). Calls `executeRaffle()`. Checks that `block.number >= committedBlock + 10` before calling.

- [ ] **Step 1: Write raffle-execute.js**

```js
// zorritov2/api/raffle-execute.js
/**
 * Keeper: execute the weekly raffle and transfer prize to winner.
 * Schedule: Monday 10:05 UTC  (vercel.json cron: "5 10 * * 1")
 *
 * Must run at least 10 blocks after raffle-commit (Celo ~5s/block → ~50s).
 * 5-minute gap between jobs = ~60 blocks — well above the 10-block minimum.
 *
 * Required env vars: KEEPER_PRIVATE_KEY, V2_CONTRACT_ADDRESS, CRON_SECRET
 *
 * Manual trigger:
 *   curl -X POST https://v2.zorrito.app/api/raffle-execute \
 *     -H "Authorization: Bearer <CRON_SECRET>"
 */

const { getContracts, checkAuth } = require("./_lib/contract");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!checkAuth(req)) return res.status(401).json({ error: "Unauthorized" });

  const ts = new Date().toISOString();

  try {
    const { zorrito, keeperWallet, contractAddress, provider } = getContracts();

    // Guard: emergency mode
    const emergency = await zorrito.emergencyMode();
    if (emergency) {
      return res.status(200).json({ ts, action: "skipped", reason: "Emergency mode active" });
    }

    // Guard: must be committed first
    const committed = await zorrito.raffleCommitted();
    if (!committed) {
      return res.status(200).json({ ts, action: "skipped", reason: "Raffle not committed — run raffle-commit first" });
    }

    // Guard: block number check (contract enforces this too, but we check early for clarity)
    const [currentBlock, committedBlock] = await Promise.all([
      provider.getBlockNumber(),
      zorrito.committedBlock(),
    ]);
    const blocksElapsed = currentBlock - Number(committedBlock);
    if (blocksElapsed < 10) {
      return res.status(200).json({
        ts,
        action:  "skipped",
        reason:  `Too soon — only ${blocksElapsed} blocks since commit (need 10)`,
        currentBlock,
        committedBlock: Number(committedBlock),
      });
    }

    // Guard: stale commit (> 250 blocks)
    if (blocksElapsed > 250) {
      return res.status(200).json({
        ts,
        action:  "skipped",
        reason:  `Commit expired (${blocksElapsed} blocks ago). Owner must call forceResetCommit() then re-commit next Monday.`,
        currentBlock,
        committedBlock: Number(committedBlock),
      });
    }

    const prizePool = await zorrito.currentPrizePool();

    const tx      = await zorrito.executeRaffle();
    const receipt = await tx.wait();

    // Parse RaffleExecuted event to get winner + amounts
    const iface  = new (require("ethers").Interface)(["event RaffleExecuted(address indexed winner, uint256 prize, uint256 fee)"]);
    let winner = null, prize = null, fee = null;
    for (const log of receipt.logs) {
      try {
        const parsed = iface.parseLog(log);
        if (parsed?.name === "RaffleExecuted") {
          winner = parsed.args.winner;
          prize  = parsed.args.prize;
          fee    = parsed.args.fee;
          break;
        }
      } catch { /* skip non-matching logs */ }
    }

    return res.status(200).json({
      ts,
      action:     "executed",
      txHash:     receipt.hash,
      explorer:   `https://celoscan.io/tx/${receipt.hash}`,
      winner,
      prize:      prize !== null ? (Number(prize) / 1e6).toFixed(6) + " USDT" : null,
      fee:        fee   !== null ? (Number(fee)   / 1e6).toFixed(6) + " USDT" : null,
      prizePool:  (Number(prizePool) / 1e6).toFixed(6) + " USDT",
      keeper:     keeperWallet.address,
      contract:   contractAddress,
    });

  } catch (err) {
    console.error("[raffle-execute] Error:", err.message);
    return res.status(500).json({ ts, error: err.reason || err.message });
  }
};
```

- [ ] **Step 2: Verify JS syntax**

```bash
node -c zorritov2/api/raffle-execute.js && echo "OK"
```

- [ ] **Step 3: Commit**

```bash
git add zorritov2/api/raffle-execute.js
git commit -m "feat(v2/keeper): raffle-execute cron handler"
```

---

## Task 4: savings-distributor.js

**Files:**
- Create: `zorritov2/api/savings-distributor.js`

Called daily at 12:00 UTC. Checks Merkl API for pending USDT rewards for the ZorritoV2 contract, claims them on-chain if available, then calls `distributeSavingsRewards()`.

**Merkl API v4 flow:**
1. GET `https://api.merkl.xyz/v4/users/{contractAddress}/rewards?chainId=42220`
2. Find token entry for USDT (`0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`)
3. If `amount > 0` (pending to claim), call `claim()` on the Merkl distributor contract
4. Wait for confirmation, then call `distributeSavingsRewards()`

- [ ] **Step 1: Write savings-distributor.js**

```js
// zorritov2/api/savings-distributor.js
/**
 * Keeper: check Merkl/Merit rewards → claim → distributeSavingsRewards().
 * Schedule: daily 12:00 UTC  (vercel.json cron: "0 12 * * *")
 *
 * Flow:
 *   1. Check Merkl API for pending USDT rewards for the ZorritoV2 contract
 *   2. If rewards > 0: call Merkl distributor.claim() on-chain
 *   3. Call distributeSavingsRewards() to distribute to depositors
 *   4. Also distributes any other USDT already in the contract (e.g. manual top-ups)
 *
 * Required env vars: KEEPER_PRIVATE_KEY, V2_CONTRACT_ADDRESS, CRON_SECRET
 * Optional:  MERKL_DISTRIBUTOR  (default: Celo mainnet distributor)
 *            CELO_RPC_URL       (default: https://forno.celo.org)
 *
 * Manual trigger:
 *   curl -X POST https://v2.zorrito.app/api/savings-distributor \
 *     -H "Authorization: Bearer <CRON_SECRET>"
 */

const { ethers }                 = require("ethers");
const { getContracts, checkAuth, USDT_ADDRESS } = require("./_lib/contract");

// Merkl distributor on Celo mainnet
// Override via MERKL_DISTRIBUTOR env var if the address changes
const DEFAULT_MERKL_DISTRIBUTOR = "0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae";

const MERKL_DISTRIBUTOR_ABI = [
  // Merkl claim: users[], tokens[], amounts[], proofs[]
  "function claim(address[] calldata users, address[] calldata tokens, uint256[] calldata amounts, bytes32[][] calldata proofs) external",
];

const CHAIN_ID = 42220; // Celo mainnet

/**
 * Fetch pending Merkl rewards for `address` on Celo.
 * Returns { amount, proof, token } for USDT, or null if none pending.
 */
async function fetchMerklReward(address) {
  const url = `https://api.merkl.xyz/v4/users/${address}/rewards?chainId=${CHAIN_ID}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Merkl API error ${resp.status}: ${await resp.text()}`);

  const data = await resp.json();

  // data is an array of reward entries per token
  // Find USDT entry (case-insensitive address match)
  const usdtEntry = (data || []).find(
    (entry) => entry.token?.toLowerCase() === USDT_ADDRESS.toLowerCase()
  );

  if (!usdtEntry || BigInt(usdtEntry.amount || 0) === 0n) return null;

  return {
    token:  usdtEntry.token,
    amount: BigInt(usdtEntry.amount),
    proof:  usdtEntry.proof, // bytes32[]
  };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!checkAuth(req)) return res.status(401).json({ error: "Unauthorized" });

  const ts = new Date().toISOString();

  try {
    const { zorrito, keeperWallet, usdt, contractAddress } = getContracts();

    // Guard: emergency mode
    const emergency = await zorrito.emergencyMode();
    if (emergency) {
      return res.status(200).json({ ts, action: "skipped", reason: "Emergency mode active" });
    }

    // Guard: no depositors
    const totalPrincipal = await zorrito.totalPrincipal();
    if (totalPrincipal === 0n) {
      return res.status(200).json({ ts, action: "skipped", reason: "No depositors" });
    }

    const result = { ts, keeper: keeperWallet.address, contract: contractAddress };

    // ── Step 1: Claim Merkl rewards (if any) ─────────────────────────────────
    let merklClaimed = false;
    try {
      const reward = await fetchMerklReward(contractAddress);

      if (reward) {
        const distributorAddr = (process.env.MERKL_DISTRIBUTOR || DEFAULT_MERKL_DISTRIBUTOR).trim();
        const distributor = new ethers.Contract(distributorAddr, MERKL_DISTRIBUTOR_ABI, keeperWallet);

        const claimTx = await distributor.claim(
          [contractAddress],  // users
          [reward.token],     // tokens
          [reward.amount],    // amounts
          [reward.proof],     // proofs
        );
        const claimReceipt = await claimTx.wait();

        result.merklClaim = {
          amount:   (Number(reward.amount) / 1e6).toFixed(6) + " USDT",
          txHash:   claimReceipt.hash,
          explorer: `https://celoscan.io/tx/${claimReceipt.hash}`,
        };
        merklClaimed = true;
      } else {
        result.merklClaim = { skipped: true, reason: "No pending Merkl rewards" };
      }
    } catch (merklErr) {
      // Merkl errors are non-fatal — if the API is down or claim fails,
      // we still try to distribute any USDT already in the contract
      result.merklClaim = { error: merklErr.message };
    }

    // ── Step 2: Check if there's USDT to distribute ───────────────────────────
    const [usdtBalance, totalSavings] = await Promise.all([
      usdt.balanceOf(contractAddress),
      zorrito.totalSavings(),
    ]);

    if (usdtBalance <= totalSavings) {
      result.action = "skipped";
      result.reason = "No new USDT to distribute";
      result.usdtBalance   = (Number(usdtBalance) / 1e6).toFixed(6) + " USDT";
      result.totalSavings  = (Number(totalSavings) / 1e6).toFixed(6) + " USDT";
      return res.status(200).json(result);
    }

    // ── Step 3: Distribute ────────────────────────────────────────────────────
    const toDistribute = usdtBalance - totalSavings;
    const tx      = await zorrito.distributeSavingsRewards();
    const receipt = await tx.wait();

    result.action       = "distributed";
    result.distributed  = (Number(toDistribute) / 1e6).toFixed(6) + " USDT";
    result.txHash       = receipt.hash;
    result.explorer     = `https://celoscan.io/tx/${receipt.hash}`;
    result.merklClaimed = merklClaimed;

    return res.status(200).json(result);

  } catch (err) {
    console.error("[savings-distributor] Error:", err.message);
    return res.status(500).json({ ts, error: err.reason || err.message });
  }
};
```

- [ ] **Step 2: Verify JS syntax**

```bash
node -c zorritov2/api/savings-distributor.js && echo "OK"
```

- [ ] **Step 3: Commit**

```bash
git add zorritov2/api/savings-distributor.js
git commit -m "feat(v2/keeper): savings-distributor cron handler with Merkl integration"
```

---

## Task 5: Update vercel.json with Cron Triggers

**Files:**
- Modify: `zorritov2/vercel.json`

- [ ] **Step 1: Update vercel.json**

```json
{
  "version": 2,
  "builds": [
    { "src": "api/*.js",        "use": "@vercel/node" },
    { "src": "api/_lib/*.js",   "use": "@vercel/node" },
    { "src": "frontend/**",     "use": "@vercel/static" }
  ],
  "routes": [
    { "src": "/api/(.*)", "dest": "api/$1" },
    { "src": "/(.*)",     "dest": "frontend/$1" }
  ],
  "crons": [
    {
      "path":     "/api/savings-distributor",
      "schedule": "0 12 * * *"
    },
    {
      "path":     "/api/raffle-commit",
      "schedule": "0 10 * * 1"
    },
    {
      "path":     "/api/raffle-execute",
      "schedule": "5 10 * * 1"
    }
  ]
}
```

Note: Vercel cron jobs send a `GET` request with the `Authorization: Bearer <CRON_SECRET>` header automatically when `CRON_SECRET` is set. The routes handle both GET and POST.

- [ ] **Step 2: Commit**

```bash
git add zorritov2/vercel.json
git commit -m "feat(v2/keeper): add Vercel cron triggers to vercel.json"
```

---

## Task 6: Manual Smoke Test (after deploy, skip in CI)

Once `V2_CONTRACT_ADDRESS` and `KEEPER_PRIVATE_KEY` are set as env vars in the Vercel dashboard:

- [ ] **Test raffle-commit manually:**

```bash
curl -X POST https://v2.zorrito.app/api/raffle-commit \
  -H "Authorization: Bearer $CRON_SECRET" | jq
```

Expected: `{ "action": "skipped", "reason": "No depositors" }` (or `"committed"` if there are depositors)

- [ ] **Test savings-distributor manually:**

```bash
curl -X POST https://v2.zorrito.app/api/savings-distributor \
  -H "Authorization: Bearer $CRON_SECRET" | jq
```

Expected: `{ "action": "skipped", "reason": "No new USDT to distribute" }` (or distribution result)

- [ ] **Test raffle-execute manually:**

```bash
curl -X POST https://v2.zorrito.app/api/raffle-execute \
  -H "Authorization: Bearer $CRON_SECRET" | jq
```

Expected: `{ "action": "skipped", "reason": "Raffle not committed" }`

---

## Post-Deploy Checklist

After Plan 1 deploy (contract) and Plan 2 deploy (keepers):

1. Set `V2_CONTRACT_ADDRESS` in Vercel dashboard → zorritov2 project → Environment Variables
2. Set `KEEPER_PRIVATE_KEY` (keeper wallet with only CELO for gas)
3. Set `CRON_SECRET` (random string)
4. Optionally set `MERKL_DISTRIBUTOR` if the default Celo address changes
5. Verify crons are scheduled: Vercel dashboard → zorritov2 → Cron Jobs
6. Monday morning: monitor `raffle-commit` (10:00 UTC) and `raffle-execute` (10:05 UTC) logs

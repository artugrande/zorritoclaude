/**
 * Zorrito V2 MCP Server
 *
 * Exposes Zorrito V2 (daily-save + weekly extra prize) as Model Context
 * Protocol tools so any AI agent (Claude Desktop, Cursor, GPT, etc.) can
 * interact with the no-loss lottery on Celo.
 *
 * Endpoint: https://zorrito.app/api/mcp
 *
 * Tools:
 *   get_pool_status   — pool stats (read-only, free)
 *   get_user_status   — per-wallet state (read-only, free)
 *   deposit_usdt      — deposit USDT from the agent wallet
 *   daily_deposit     — deposit 0.25 USDT to extend daily streak (once/day, real savings)
 *   claim_savings     — claim accumulated savings
 *
 * Connect from Claude Desktop (~/Library/Application Support/Claude/claude_desktop_config.json):
 *   { "mcpServers": { "zorrito": { "url": "https://zorrito.app/api/mcp" } } }
 *
 * Required env var for write tools:
 *   AGENT_PRIVATE_KEY — private key of the agent wallet
 * Optional:
 *   CELO_RPC_URL      — defaults to https://forno.celo.org
 */

const { createMcpHandler } = require("mcp-handler");
const { z }                = require("zod");
const { ethers }           = require("ethers");

// ── Constants ─────────────────────────────────────────────────────────────────

const RPC          = (process.env.CELO_RPC_URL || "https://forno.celo.org").trim();
const ZORRITO      = "0x8f4E627d4C4Af5dfE11908Bd8B929588d9Ee58c9"; // V2
const USDT_ADDRESS = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const ONE_USDT     = BigInt(1_000_000);

const ZORRITO_ABI = [
  // Writes
  "function deposit(uint256 amount, bytes4 refCode) external",
  "function depositFor(address beneficiary, uint256 amount, bytes4 refCode) external",
  "function withdraw(uint256 amount) external",
  "function claimSavings() external",
  // Reads
  "function deposits(address) view returns (uint256)",
  "function streakDay(address) view returns (uint256)",
  "function lastDepositDay(address) view returns (uint256)",
  "function getStatus(address) view returns (bool alive, uint8 currentStreak, uint256 deadlineTimestamp, uint256 secondsUntilDead)",
  "function effectiveChances(address) view returns (uint256)",
  "function totalEffectiveChances() view returns (uint256)",
  "function currentPrizePool() view returns (uint256)",
  "function totalPrincipal() view returns (uint256)",
  "function depositorCount() view returns (uint256)",
  "function activeReferrals(address) view returns (uint256)",
  "function referralCodeFor(address) view returns (bytes4)",
  "function selfVerified(address) view returns (bool)",
  "function pendingSavings(address) view returns (uint256)",
];

const USDT_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function getProvider() {
  // Explicit network avoids ENS lookups / chain-detection errors on Celo
  return new ethers.JsonRpcProvider(
    RPC,
    { chainId: 42220, name: "celo" },
    { staticNetwork: true }
  );
}

function getSigner() {
  const raw = (process.env.AGENT_PRIVATE_KEY || "").trim();
  if (!raw) {
    throw new Error(
      "AGENT_PRIVATE_KEY env var not configured. Write tools require an agent wallet private key."
    );
  }
  return new ethers.Wallet(raw.startsWith("0x") ? raw : `0x${raw}`, getProvider());
}

async function ensureAllowance(signer, required) {
  const usdt = new ethers.Contract(USDT_ADDRESS, USDT_ABI, signer);
  const current = await usdt.allowance(signer.address, ZORRITO);
  if (BigInt(current) < BigInt(required)) {
    const tx = await usdt.approve(ZORRITO, ethers.MaxUint256, { type: 0, gasLimit: 100_000 });
    await tx.wait();
  }
}

// Next Monday 10:05 UTC (raffle slot)
function nextMondayDraw() {
  const now = new Date();
  const d = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    10, 5, 0, 0,
  ));
  // 1 = Monday in JS getUTCDay()
  let delta = (1 - d.getUTCDay() + 7) % 7;
  if (delta === 0 && now.getTime() >= d.getTime()) delta = 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return d;
}

function txError(err) {
  const msg = err && err.message ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${msg}` }], isError: true };
}

// ── MCP handler ───────────────────────────────────────────────────────────────

const mcpWebHandler = createMcpHandler(
  (server) => {

    // ── Tool: get_pool_status ──────────────────────────────────────────────
    server.tool(
      "get_pool_status",
      "Read Zorrito V2 pool stats: total deposited, weekly prize pool, depositor count, total chances, and next draw time. Free, no auth.",
      {},
      async () => {
        try {
          const provider = getProvider();
          const zorrito  = new ethers.Contract(ZORRITO, ZORRITO_ABI, provider);
          const [totalPrincipal, prizePool, depositorCount, totalChances] = await Promise.all([
            zorrito.totalPrincipal(),
            zorrito.currentPrizePool(),
            zorrito.depositorCount(),
            zorrito.totalEffectiveChances(),
          ]);
          const draw = nextMondayDraw();
          const result = {
            contract:        ZORRITO,
            totalDeposited:  ethers.formatUnits(totalPrincipal, 6) + " USDT",
            prizePool:       ethers.formatUnits(prizePool, 6) + " USDT",
            depositorCount:  Number(depositorCount),
            totalChances:    totalChances.toString(),
            nextDrawTimestamp: Math.floor(draw.getTime() / 1000),
            nextDrawIso:     draw.toISOString(),
          };
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return txError(err);
        }
      }
    );

    // ── Tool: get_user_status ──────────────────────────────────────────────
    server.tool(
      "get_user_status",
      "Read Zorrito V2 status for a wallet: deposit, streakDay, savedToday, chances, oddsPercent, activeReferrals, selfVerified, pendingSavings. Free, no auth.",
      { address: z.string().describe("Celo wallet address (0x...)") },
      async ({ address }) => {
        if (!ethers.isAddress(address)) {
          return { content: [{ type: "text", text: `Error: invalid address "${address}"` }], isError: true };
        }
        try {
          const provider = getProvider();
          const zorrito  = new ethers.Contract(ZORRITO, ZORRITO_ABI, provider);
          const usdt     = new ethers.Contract(USDT_ADDRESS, USDT_ABI, provider);

          const [
            deposit, streak, lastDay, myChances, totalChances,
            activeRefs, verified, pending, walletBal,
          ] = await Promise.all([
            zorrito.deposits(address),
            zorrito.streakDay(address),
            zorrito.lastDepositDay(address),
            zorrito.effectiveChances(address),
            zorrito.totalEffectiveChances(),
            zorrito.activeReferrals(address),
            zorrito.selfVerified(address),
            zorrito.pendingSavings(address),
            usdt.balanceOf(address),
          ]);

          const todayUtcDay = Math.floor(Date.now() / 1000 / 86400);
          const savedToday  = Number(lastDay) >= todayUtcDay;
          const total       = BigInt(totalChances);
          const mine        = BigInt(myChances);
          const oddsPercent = total > 0n
            ? Number((mine * 10_000n) / total) / 100
            : 0;

          const result = {
            address,
            deposit:         ethers.formatUnits(deposit, 6) + " USDT",
            walletBalance:   ethers.formatUnits(walletBal, 6) + " USDT",
            streakDay:       Number(streak),
            lastDepositDay:  Number(lastDay),
            savedToday,
            chances:         mine.toString(),
            totalChances:    total.toString(),
            oddsPercent:     oddsPercent.toFixed(4) + " %",
            activeReferrals: Number(activeRefs),
            selfVerified:    Boolean(verified),
            pendingSavings:  ethers.formatUnits(pending, 6) + " USDT",
          };
          return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
        } catch (err) {
          return txError(err);
        }
      }
    );

    // ── Tool: deposit_usdt ─────────────────────────────────────────────────
    server.tool(
      "deposit_usdt",
      "Deposit USDT into Zorrito V2 from the agent wallet (the signer derived from AGENT_PRIVATE_KEY). NOTE: V2 has no depositFor — the deposit always credits msg.sender. Earns Aave yield and grants lottery chances. Requires AGENT_PRIVATE_KEY.",
      {
        amount_usdt: z.number().positive().describe("USDT amount to deposit (e.g. 10 = 10 USDT, 6 decimals)"),
        ref_code:    z.string().optional().describe("Optional 8-char hex referral code (without 0x), or leave empty for none"),
      },
      async ({ amount_usdt, ref_code }) => {
        try {
          const signer = getSigner();
          const amount = BigInt(Math.round(amount_usdt * 1_000_000));
          let ref = "0x00000000";
          if (ref_code && ref_code.trim()) {
            const clean = ref_code.trim().replace(/^0x/i, "");
            if (!/^[0-9a-fA-F]{8}$/.test(clean)) {
              return { content: [{ type: "text", text: `Error: ref_code must be 8 hex chars (got "${ref_code}")` }], isError: true };
            }
            ref = "0x" + clean.toLowerCase();
          }
          await ensureAllowance(signer, amount);
          const zorrito = new ethers.Contract(ZORRITO, ZORRITO_ABI, signer);
          const tx      = await zorrito.deposit(amount, ref, { type: 0, gasLimit: 350_000 });
          const receipt = await tx.wait();
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success:     true,
                action:      "deposit",
                wallet:      signer.address,
                amount:      `${amount_usdt} USDT`,
                refCode:     ref,
                txHash:      receipt.hash,
                explorerUrl: `https://celoscan.io/tx/${receipt.hash}`,
                gasUsed:     receipt.gasUsed.toString(),
              }, null, 2),
            }],
          };
        } catch (err) {
          return txError(err);
        }
      }
    );

    // ── Tool: daily_deposit ────────────────────────────────────────────────
    // Convenience wrapper that deposits the minimum (0.25 USDT) to extend
    // the daily streak. Same as calling deposit_usdt with amount=0.25.
    server.tool(
      "daily_deposit",
      "Deposit 0.25 USDT (the minimum) to extend the agent's daily streak by +1 (capped at 7). The USDT goes into the V2 contract and earns Aave yield. Each UTC day each wallet can only effectively bump streak once; subsequent same-day deposits add USDT but don't increment streak. Requires AGENT_PRIVATE_KEY.",
      {},
      async () => {
        try {
          const signer  = getSigner();
          const zorrito = new ethers.Contract(ZORRITO, ZORRITO_ABI, signer);
          const amount  = 250_000n; // 0.25 USDT
          await ensureAllowance(signer, amount);
          const tx      = await zorrito.deposit(amount, "0x00000000", { type: 0, gasLimit: 1_200_000 });
          const receipt = await tx.wait();
          const [streak, chances] = await Promise.all([
            zorrito.streakDay(signer.address),
            zorrito.effectiveChances(signer.address),
          ]);
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success:     true,
                action:      "daily_deposit",
                wallet:      signer.address,
                amount:      "0.25 USDT",
                newStreak:   Number(streak),
                chances:     chances.toString(),
                txHash:      receipt.hash,
                explorerUrl: `https://celoscan.io/tx/${receipt.hash}`,
                gasUsed:     receipt.gasUsed.toString(),
              }, null, 2),
            }],
          };
        } catch (err) {
          return txError(err);
        }
      }
    );

    // ── Tool: claim_savings ────────────────────────────────────────────────
    server.tool(
      "claim_savings",
      "Claim accumulated pendingSavings for the agent wallet via claimSavings(). Requires AGENT_PRIVATE_KEY.",
      {},
      async () => {
        try {
          const signer  = getSigner();
          const zorrito = new ethers.Contract(ZORRITO, ZORRITO_ABI, signer);
          const pendingBefore = await zorrito.pendingSavings(signer.address);
          const tx      = await zorrito.claimSavings({ type: 0, gasLimit: 250_000 });
          const receipt = await tx.wait();
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                success:       true,
                action:        "claim_savings",
                wallet:        signer.address,
                claimedAmount: ethers.formatUnits(pendingBefore, 6) + " USDT",
                txHash:        receipt.hash,
                explorerUrl:   `https://celoscan.io/tx/${receipt.hash}`,
                gasUsed:       receipt.gasUsed.toString(),
              }, null, 2),
            }],
          };
        } catch (err) {
          return txError(err);
        }
      }
    );
  },
  {},
  { basePath: "/api" }
);

// ── Bridge: Web Standard Request → Node.js req/res ───────────────────────────

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    const proto = req.headers["x-forwarded-proto"] || "https";
    const host  = req.headers["x-forwarded-host"] || req.headers.host;
    const url   = `${proto}://${host}${req.url}`;

    const webReq = new Request(url, {
      method:  req.method,
      headers: req.headers,
      body:    (req.method !== "GET" && req.method !== "HEAD" && body.length > 0) ? body : undefined,
    });

    const webRes = await mcpWebHandler(webReq);

    res.status(webRes.status);
    webRes.headers.forEach((value, key) => res.setHeader(key, value));

    const contentType = webRes.headers.get("content-type") || "";

    if (contentType.includes("text/event-stream")) {
      const reader = webRes.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        res.write(Buffer.from(value));
      }
    } else {
      const buf = await webRes.arrayBuffer();
      res.end(Buffer.from(buf));
    }
  } catch (err) {
    console.error("[zorrito-v2-mcp] Error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
};

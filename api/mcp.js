/**
 * Zorrito MCP Server
 *
 * Exposes Zorrito DeFi protocol as Model Context Protocol tools so any
 * AI agent (Claude, GPT, Cursor, etc.) can interact with the no-loss lottery.
 *
 * Endpoint: https://zorrito.app/api/mcp
 *
 * Tools:
 *   get_fox_status  — read fox + pool state for any wallet (read-only, free)
 *   deposit_usdt    — deposit N USDT into Zorrito for the agent wallet
 *   feed_fox        — feed the fox daily (costs 1 USDT, builds streak)
 *
 * Connect from Claude Desktop (~/Library/Application Support/Claude/claude_desktop_config.json):
 *   { "mcpServers": { "zorrito": { "url": "https://zorrito.app/api/mcp" } } }
 *
 * Connect from Cursor (.cursor/mcp.json):
 *   { "mcpServers": { "zorrito": { "url": "https://zorrito.app/api/mcp" } } }
 *
 * Required env var for write tools:
 *   AGENT_PRIVATE_KEY — private key of the agent wallet
 */

const { createMcpHandler } = require("mcp-handler");
const { z }                = require("zod");
const { ethers }           = require("ethers");

// ── Constants ─────────────────────────────────────────────────────────────────

const RPC          = "https://forno.celo.org";
const ZORRITO      = "0x135dc8DC4bEd4e619B97b07bA16bCE348CAeFF62";
const USDT_ADDRESS = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const ONE_USDT     = BigInt(1_000_000);

const ZORRITO_ABI = [
  "function depositFor(address beneficiary, uint256 amount) external",
  "function feedFor(address beneficiary) external",
  "function getFoxStatus(address user) view returns (bool alive, uint32 currentStreak, uint32 bestStreak, uint256 fishCount, uint256 nextFeedDeadline, uint256 secondsUntilDead)",
  "function getStats() view returns (uint256 poolSize, uint256 yieldAvailable, uint256 playerCount, uint256 nextDraw, uint256 aliveFoxes)",
  "function getUserDeposit(address user) view returns (uint256)",
];

const USDT_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function getSigner() {
  const raw = (process.env.AGENT_PRIVATE_KEY || "").trim();
  if (!raw) throw new Error("AGENT_PRIVATE_KEY not configured");
  const provider = new ethers.JsonRpcProvider(RPC);
  return new ethers.Wallet(raw.startsWith("0x") ? raw : `0x${raw}`, provider);
}

async function ensureAllowance(signer, required) {
  const usdt = new ethers.Contract(USDT_ADDRESS, USDT_ABI, signer);
  const current = await usdt.allowance(signer.address, ZORRITO);
  if (BigInt(current) < BigInt(required)) {
    const tx = await usdt.approve(ZORRITO, ethers.MaxUint256);
    await tx.wait();
  }
}

// ── MCP Handler (Web Standard API — bridged to Node.js in export) ─────────────

const mcpWebHandler = createMcpHandler(
  (server) => {

    // ── Tool 1: get_fox_status ─────────────────────────────────────────────
    server.tool(
      "get_fox_status",
      "Read fox status, deposit amount, and pool stats for any Celo wallet. Free, no authentication needed.",
      { address: z.string().describe("Celo wallet address (0x...)") },
      async ({ address }) => {
        if (!ethers.isAddress(address)) {
          return { content: [{ type: "text", text: `Error: invalid address "${address}"` }], isError: true };
        }
        const provider = new ethers.JsonRpcProvider(RPC);
        const zorrito  = new ethers.Contract(ZORRITO, ZORRITO_ABI, provider);
        const usdt     = new ethers.Contract(USDT_ADDRESS, USDT_ABI, provider);

        const [fox, deposit, balance, stats] = await Promise.all([
          zorrito.getFoxStatus(address),
          zorrito.getUserDeposit(address),
          usdt.balanceOf(address),
          zorrito.getStats(),
        ]);

        const result = {
          address,
          fox: {
            alive:            fox.alive,
            currentStreak:    Number(fox.currentStreak),
            bestStreak:       Number(fox.bestStreak),
            fishCount:        Math.round(Number(fox.fishCount) / 10),
            secondsUntilDead: Number(fox.secondsUntilDead),
            nextFeedDeadline: fox.nextFeedDeadline > 0n
              ? new Date(Number(fox.nextFeedDeadline) * 1000).toISOString()
              : null,
          },
          wallet: {
            usdtBalance:     ethers.formatUnits(balance, 6) + " USDT",
            depositedInPool: ethers.formatUnits(deposit, 6) + " USDT",
          },
          pool: {
            totalUSDT:    ethers.formatUnits(stats.poolSize, 6) + " USDT",
            yieldUSDT:    ethers.formatUnits(stats.yieldAvailable, 6) + " USDT",
            players:      Number(stats.playerCount),
            aliveFoxes:   Number(stats.aliveFoxes),
            nextDrawDate: new Date(Number(stats.nextDraw) * 1000).toISOString(),
          },
        };

        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    );

    // ── Tool 2: deposit_usdt ──────────────────────────────────────────────
    server.tool(
      "deposit_usdt",
      "Deposit USDT into Zorrito from the agent wallet. Earns Aave yield and grants lottery entries. Requires AGENT_PRIVATE_KEY.",
      { amount_usdt: z.number().int().min(1).describe("USDT amount to deposit (integer, min 1)") },
      async ({ amount_usdt }) => {
        const signer = getSigner();
        const amount = BigInt(amount_usdt) * ONE_USDT;
        await ensureAllowance(signer, amount);
        const zorrito = new ethers.Contract(ZORRITO, ZORRITO_ABI, signer);
        const tx      = await zorrito.depositFor(signer.address, amount);
        const receipt = await tx.wait();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success:  true,
              action:   "deposit",
              amount:   `${amount_usdt} USDT`,
              wallet:   signer.address,
              txHash:   receipt.hash,
              explorer: `https://celoscan.io/tx/${receipt.hash}`,
            }, null, 2),
          }],
        };
      }
    );

    // ── Tool 3: feed_fox ──────────────────────────────────────────────────
    server.tool(
      "feed_fox",
      "Feed the Zorrito fox for today. Costs 1 USDT, adds 1 fish (lottery ticket), builds daily streak. Call once every 20-24 hours. Requires AGENT_PRIVATE_KEY.",
      {},
      async () => {
        const signer = getSigner();
        await ensureAllowance(signer, ONE_USDT);
        const zorrito = new ethers.Contract(ZORRITO, ZORRITO_ABI, signer);
        const tx      = await zorrito.feedFor(signer.address);
        const receipt = await tx.wait();
        const fox     = await zorrito.getFoxStatus(signer.address);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success:        true,
              action:         "feed",
              cost:           "1 USDT",
              wallet:         signer.address,
              newStreak:      Number(fox.currentStreak),
              totalFish:      Math.round(Number(fox.fishCount) / 10),
              txHash:         receipt.hash,
              explorer:       `https://celoscan.io/tx/${receipt.hash}`,
              nextFeedBefore: fox.nextFeedDeadline > 0n
                ? new Date(Number(fox.nextFeedDeadline) * 1000).toISOString()
                : null,
            }, null, 2),
          }],
        };
      }
    );
  },
  {},
  { basePath: "/api" }
);

// ── Bridge: Web Standard Request → Node.js req/res ───────────────────────────
// createMcpHandler returns (Request) => Promise<Response>
// Vercel Functions provide Node.js IncomingMessage / ServerResponse

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization, Mcp-Session-Id");

  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    // Collect body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);

    // Build Web Standard Request
    const proto = req.headers["x-forwarded-proto"] || "https";
    const host  = req.headers["x-forwarded-host"] || req.headers.host;
    const url   = `${proto}://${host}${req.url}`;

    const webReq = new Request(url, {
      method:  req.method,
      headers: req.headers,
      body:    (req.method !== "GET" && req.method !== "HEAD" && body.length > 0) ? body : undefined,
    });

    // Call the MCP handler
    const webRes = await mcpWebHandler(webReq);

    // Write response back to Node.js
    res.status(webRes.status);
    webRes.headers.forEach((value, key) => res.setHeader(key, value));

    const contentType = webRes.headers.get("content-type") || "";

    if (contentType.includes("text/event-stream")) {
      // SSE: pipe the readable stream
      const reader = webRes.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); break; }
          res.write(Buffer.from(value));
        }
      };
      await pump();
    } else {
      const buf = await webRes.arrayBuffer();
      res.end(Buffer.from(buf));
    }
  } catch (err) {
    console.error("[zorrito-mcp] Error:", err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  }
};

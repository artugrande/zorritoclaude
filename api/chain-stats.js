/**
 * chain-stats.js — Accurate all-time on-chain event counts via Etherscan V2 API.
 *
 * Requests are serialised (one at a time) to stay within Etherscan free tier
 * (5 req/s). Each page waits 250 ms before the next call.
 *
 * GET /api/chain-stats
 */

const ETHERSCAN_V2   = "https://api.etherscan.io/v2/api";
const CELO_CHAIN_ID  = "42220";
const ZORRITO_ADDR   = "0x135dc8DC4bEd4e619B97b07bA16bCE348CAeFF62";
const DEPLOY_BLOCK   = 64_226_000;
const PAGE_DELAY_MS  = 400; // gap between calls — free tier is 3 req/s, so 400ms → 2.5/s

// keccak256 topic0 hashes for each Zorrito event
const TOPICS = {
  FoxFed:       "0x8337ddaad53138e9fa96063ddc81bc446984c35a81f28c09982175b69f3fe19c",
  Deposited:    "0x73a19dd210f1a7f902193214c0ee91dd35ee5b4d920cba8d519eca65a7b488ca",
  Withdrawn:    "0x7084f5476618d8e60b11ef0d7d3f06914655adb8793e28ff7f018d4c76d505d5",
  WinnerPicked: "0x0c94cfc5a2ba1b9f32b037a5042267ae4df56cb9d5308471e0b3d05d099d591d",
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fetch a single page of logs; returns the result array or throws.
async function fetchPage(topic0, page, apiKey) {
  const url = new URL(ETHERSCAN_V2);
  url.searchParams.set("chainid",   CELO_CHAIN_ID);
  url.searchParams.set("module",    "logs");
  url.searchParams.set("action",    "getLogs");
  url.searchParams.set("address",   ZORRITO_ADDR);
  url.searchParams.set("topic0",    topic0);
  url.searchParams.set("fromBlock", String(DEPLOY_BLOCK));
  url.searchParams.set("toBlock",   "latest");
  url.searchParams.set("page",      String(page));
  url.searchParams.set("offset",    "1000");
  url.searchParams.set("apikey",    apiKey);

  const res  = await fetch(url.toString());
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();

  if (data.status === "0") {
    // Empty result is valid (no events yet), array or "No records" message
    if (Array.isArray(data.result) || data.message?.includes("No records")) return [];
    throw new Error(`API error: ${data.message || data.result || "unknown"}`);
  }
  return Array.isArray(data.result) ? data.result : [];
}

// Paginate all logs for a topic; returns { count, addresses } sequentially.
async function fetchAllLogs(topic0, apiKey, collectAddrs = false) {
  let page    = 1;
  let count   = 0;
  const addrs = collectAddrs ? new Set() : null;

  while (true) {
    const rows = await fetchPage(topic0, page, apiKey);
    count += rows.length;

    if (collectAddrs) {
      for (const r of rows) {
        if (r.topics?.[1]) addrs.add("0x" + r.topics[1].slice(26));
      }
    }

    if (rows.length < 1000) break; // last page reached
    page++;
    await sleep(PAGE_DELAY_MS);
  }

  return { count, uniqueAddrs: addrs ? addrs.size : 0 };
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  // Cache 10 min on CDN; serve stale for up to 20 min while revalidating
  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=1200");

  const apiKey = (process.env.CELOSCAN_API_KEY || "").trim();
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: "CELOSCAN_API_KEY not configured" });
  }

  try {
    // ── Serialised queries — one event type at a time to respect rate limit ──
    const feed     = await fetchAllLogs(TOPICS.FoxFed,       apiKey, false);
    await sleep(PAGE_DELAY_MS);
    const deposit  = await fetchAllLogs(TOPICS.Deposited,    apiKey, true);
    await sleep(PAGE_DELAY_MS);
    const withdraw = await fetchAllLogs(TOPICS.Withdrawn,     apiKey, false);
    await sleep(PAGE_DELAY_MS);
    const winner   = await fetchAllLogs(TOPICS.WinnerPicked,  apiKey, false);

    const totalTx = feed.count + deposit.count + withdraw.count;

    return res.status(200).json({
      ok:        true,
      generated: new Date().toISOString(),
      allTime: {
        feed:             feed.count,
        deposit:          deposit.count,
        withdraw:         withdraw.count,
        winner:           winner.count,
        total:            totalTx,
        uniqueDepositors: deposit.uniqueAddrs,
      },
    });

  } catch (err) {
    console.error("chain-stats error:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

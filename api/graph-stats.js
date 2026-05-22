/**
 * api/graph-stats.js  (drop this into newzorritocelo/api/)
 *
 * Replaces chain-stats.js entirely — no more polling Etherscan page by page.
 * Returns the same shape as chain-stats.js + extra fields for the dashboard.
 *
 * GET /api/graph-stats
 *
 * Response cached 5 min on CDN. Subgraph itself lags ~1-2 blocks (~2s on Celo).
 */

// Studio endpoint — works immediately, no API key needed
const STUDIO_ENDPOINT = "https://api.studio.thegraph.com/query/1748793/zorrito/v0.0.2";

// After publishing to decentralized network, set SUBGRAPH_ID in Vercel env
const GRAPH_API_KEY   = process.env.GRAPH_API_KEY || "d142472c9ac61cd26ccb6e58bbea0532";
const SUBGRAPH_ID     = process.env.SUBGRAPH_ID   || "";
const DECENTRALIZED   = SUBGRAPH_ID
  ? `https://gateway.thegraph.com/api/${GRAPH_API_KEY}/subgraphs/id/${SUBGRAPH_ID}`
  : null;
const ENDPOINT        = DECENTRALIZED || STUDIO_ENDPOINT;

async function graphQuery(gql) {
  const res  = await fetch(ENDPOINT, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ query: gql }),
  });
  if (!res.ok) throw new Error(`Graph HTTP ${res.status}`);
  const { data, errors } = await res.json();
  if (errors?.length) throw new Error(errors[0].message);
  return data;
}

const ALLOWED_ORIGINS = [
  "https://zorrito.app",
  "https://www.zorrito.app",
];

module.exports = async (req, res) => {
  // ── Cache-bust protection: strip any query params ─────────────────────────
  if (Object.keys(req.query).length > 0) {
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(307, "/api/graph-stats");
  }

  // ── CORS: only allow requests from zorrito.app ────────────────────────────
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return res.status(403).json({ ok: false, error: "Forbidden" });
  }
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET");

  // ── 2-min CDN cache, serve stale for 4 min while revalidating ────────────
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=240");
  res.setHeader("X-Updated-At", Date.now());

  try {
    const data = await graphQuery(`{
      globalStats(id: "global") {
        totalTxCount totalFeedCount totalDepositCount totalWithdrawCount
        totalDepositedUSDT totalWithdrawnUSDT
        totalDepositors activeDepositors
        totalFeeds totalRevivals
        longestActiveStreak longestActiveStreakUser
        longestEverStreak longestEverStreakUser
        totalEffectiveTickets
        drawCount totalPrizesDistributed totalPlatformFees
        lastWinner lastPrize lastDrawTimestamp
        lastUpdatedTimestamp
      }
      streakTiers(orderBy: minStreak, orderDirection: asc) {
        id label minStreak maxStreak userCount totalEffectiveTickets
      }
      dayStats(first: 30, orderBy: date, orderDirection: desc) {
        id date
        txCount feedCount depositCount withdrawCount
        depositVolume withdrawVolume uniqueDepositors uniqueFeeders newUsers revivals
      }
    }`);

    const g = data.globalStats;
    const total = g.totalTxCount;

    // Compute 24h / 7d / 30d from dailyStats
    const days = data.dayStats || [];
    const sum  = (field, n) => days.slice(0, n).reduce((a, d) => a + (parseFloat(d[field]) || 0), 0);
    const sumI = (field, n) => days.slice(0, n).reduce((a, d) => a + (parseInt(d[field])  || 0), 0);

    return res.status(200).json({
      ok:        true,
      source:    "the-graph",
      generated: new Date().toISOString(),
      allTime: {
        feed:             g.totalFeedCount,
        deposit:          g.totalDepositCount,
        withdraw:         g.totalWithdrawCount,
        total:            total,
        uniqueDepositors: g.totalDepositors,
        totalDepositedUSDT: parseFloat(g.totalDepositedUSDT),
        totalWithdrawnUSDT: parseFloat(g.totalWithdrawnUSDT),
        totalRevivals:    g.totalRevivals,
        draws:            g.drawCount,
        totalPrizes:      parseFloat(g.totalPrizesDistributed),
      },
      periods: {
        h24: { tx: sumI("txCount",1),  feeds: sumI("feedCount",1),  depositVol: sum("depositVolume",1)  },
        d7:  { tx: sumI("txCount",7),  feeds: sumI("feedCount",7),  depositVol: sum("depositVolume",7)  },
        d30: { tx: sumI("txCount",30), feeds: sumI("feedCount",30), depositVol: sum("depositVolume",30) },
      },
      users: {
        total:      g.totalDepositors,
        active:     g.activeDepositors,
        survival:   g.totalDepositors > 0
                      ? ((g.activeDepositors / g.totalDepositors) * 100).toFixed(1) + "%"
                      : "0%",
      },
      foxMechanics: {
        totalFeeds:            g.totalFeeds,
        totalRevivals:         g.totalRevivals,
        totalEffectiveTickets: parseFloat(g.totalEffectiveTickets),
        longestActiveStreak:   g.longestActiveStreak,
        longestActiveUser:     g.longestActiveStreakUser,
        longestEverStreak:     g.longestEverStreak,
      },
      lastDraw: g.lastDrawTimestamp ? {
        winner:    g.lastWinner,
        prize:     parseFloat(g.lastPrize),
        timestamp: parseInt(g.lastDrawTimestamp),
      } : null,
      streakDistribution: data.streakTiers,
      timeSeries: data.dayStats.reverse(), // chronological
    });

  } catch (err) {
    console.error("graph-stats error:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

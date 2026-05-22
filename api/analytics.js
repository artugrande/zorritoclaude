/**
 * analytics.js — PostHog proxy for Zorrito stats dashboard.
 *
 * Keeps the PostHog API key server-side (never exposed to the browser).
 * Fetches all dashboard data in parallel and returns a single JSON payload.
 *
 * GET /api/analytics
 */

const POSTHOG_HOST       = "https://us.i.posthog.com";
const POSTHOG_PROJECT_ID = process.env.POSTHOG_PROJECT_ID || "391437";
const POSTHOG_API_KEY    = process.env.POSTHOG_API_KEY;

// ── PostHog query helper ───────────────────────────────────────────────────────

async function phQuery(query) {
  const res = await fetch(`${POSTHOG_HOST}/api/projects/${POSTHOG_PROJECT_ID}/query/`, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${POSTHOG_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`PostHog query failed: ${res.status}`);
  return res.json();
}

// ── Reusable query builders ────────────────────────────────────────────────────

function trendsQuery(event, math, dateFrom, breakdownBy) {
  return {
    kind: "TrendsQuery",
    series: [{ kind: "EventsNode", event, math }],
    dateRange: { date_from: dateFrom },
    ...(breakdownBy && { breakdown: { breakdown_type: "event", breakdown: breakdownBy } }),
  };
}

function hogqlQuery(sql) {
  return { kind: "HogQLQuery", query: sql };
}

// ── Handler ───────────────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600"); // cache 5min

  if (!POSTHOG_API_KEY) {
    return res.status(500).json({ error: "POSTHOG_API_KEY not configured" });
  }

  try {
    // ── Run all queries in parallel ──────────────────────────────────────────
    const [
      visitors7d,
      visitors30d,
      pageviewsDaily,
      countryBreakdown,
      deviceBreakdown,
      walletTypeBreakdown,
      funnelRaw,
      referrerBreakdown,
      sessionStats,
    ] = await Promise.allSettled([

      // 1. Unique visitors last 7 days
      phQuery(hogqlQuery(`
        SELECT count(distinct person_id) as unique_visitors,
               count() as total_pageviews
        FROM events
        WHERE event = '$pageview'
          AND timestamp >= now() - interval 7 day
      `)),

      // 2. Unique visitors last 30 days
      phQuery(hogqlQuery(`
        SELECT count(distinct person_id) as unique_visitors,
               count() as total_pageviews
        FROM events
        WHERE event = '$pageview'
          AND timestamp >= now() - interval 30 day
      `)),

      // 3. Daily pageviews last 30 days (for chart)
      phQuery(hogqlQuery(`
        SELECT toDate(timestamp) as day,
               count(distinct person_id) as unique_visitors,
               count() as pageviews
        FROM events
        WHERE event = '$pageview'
          AND timestamp >= now() - interval 30 day
        GROUP BY day
        ORDER BY day ASC
      `)),

      // 4. Top countries — all-time (no date filter so it's historical)
      phQuery(hogqlQuery(`
        SELECT properties.$geoip_country_name as country,
               properties.$geoip_country_code as country_code,
               count(distinct person_id) as visitors
        FROM events
        WHERE event = '$pageview'
          AND properties.$geoip_country_name IS NOT NULL
        GROUP BY country, country_code
        ORDER BY visitors DESC
        LIMIT 50
      `)),

      // 5. Device type (mobile vs desktop)
      phQuery(hogqlQuery(`
        SELECT properties.$device_type as device,
               count(distinct person_id) as visitors
        FROM events
        WHERE event = '$pageview'
          AND timestamp >= now() - interval 30 day
          AND properties.$device_type IS NOT NULL
        GROUP BY device
        ORDER BY visitors DESC
      `)),

      // 6. Wallet type breakdown (from custom wallet_connected event)
      phQuery(hogqlQuery(`
        SELECT properties.wallet_type as wallet_type,
               count() as connections
        FROM events
        WHERE event = 'wallet_connected'
          AND timestamp >= now() - interval 30 day
        GROUP BY wallet_type
        ORDER BY connections DESC
      `)),

      // 7. Funnel: pageview → wallet_connected → deposit_completed
      phQuery(hogqlQuery(`
        SELECT
          countDistinctIf(distinct_id, event = '$pageview')        as step1_visitors,
          countDistinctIf(distinct_id, event = 'wallet_connected') as step2_connected,
          countDistinctIf(distinct_id, event = 'deposit_completed') as step3_deposited
        FROM events
        WHERE timestamp >= now() - interval 30 day
      `)),

      // 8. Top referrers
      phQuery(hogqlQuery(`
        SELECT properties.$referring_domain as referrer,
               count(distinct person_id) as visitors
        FROM events
        WHERE event = '$pageview'
          AND timestamp >= now() - interval 30 day
          AND properties.$referring_domain IS NOT NULL
          AND properties.$referring_domain != ''
        GROUP BY referrer
        ORDER BY visitors DESC
        LIMIT 8
      `)),

      // 9. Sessions + avg duration (computed from min/max timestamp per session_id)
      // $session_duration property is only set on $pageleave events, so we compute
      // duration manually as max(timestamp) - min(timestamp) per session.
      phQuery(hogqlQuery(`
        SELECT count() as sessions,
               avg(dateDiff('second', min_ts, max_ts)) as avg_duration_sec
        FROM (
          SELECT properties.$session_id,
                 min(timestamp) as min_ts,
                 max(timestamp) as max_ts
          FROM events
          WHERE timestamp >= now() - interval 30 day
            AND properties.$session_id IS NOT NULL
            AND properties.$session_id != ''
          GROUP BY properties.$session_id
        )
      `)),

    ]);

    // ── Helper: safely extract results ───────────────────────────────────────
    const safe = (settled, fallback = null) =>
      settled.status === "fulfilled" ? settled.value : fallback;

    const row0 = (settled) => {
      const d = safe(settled);
      return d?.results?.[0] ?? null;
    };

    const rows = (settled) => {
      const d = safe(settled);
      return d?.results ?? [];
    };

    // ── Parse visitors ───────────────────────────────────────────────────────
    const v7  = row0(visitors7d);
    const v30 = row0(visitors30d);

    // ── Parse daily chart ────────────────────────────────────────────────────
    const dailyChart = rows(pageviewsDaily).map(r => ({
      date:            r[0],
      unique_visitors: r[1],
      pageviews:       r[2],
    }));

    // ── Parse countries ──────────────────────────────────────────────────────
    const countries = rows(countryBreakdown).map(r => ({
      country:      r[0] || "Unknown",
      country_code: (r[1] || "").toLowerCase(),
      visitors:     r[2],
    }));

    // ── Parse devices ────────────────────────────────────────────────────────
    const devices = rows(deviceBreakdown).map(r => ({
      device:   r[0] || "Unknown",
      visitors: r[1],
    }));

    // ── Parse wallet types ───────────────────────────────────────────────────
    const walletTypes = rows(walletTypeBreakdown).map(r => ({
      wallet_type:  r[0] || "unknown",
      connections:  r[1],
    }));

    // ── Parse funnel ─────────────────────────────────────────────────────────
    const funnelRow = row0(funnelRaw);
    const funnel = funnelRow ? {
      visitors:  funnelRow[0] || 0,
      connected: funnelRow[1] || 0,
      deposited: funnelRow[2] || 0,
    } : { visitors: 0, connected: 0, deposited: 0 };

    // ── Parse referrers ──────────────────────────────────────────────────────
    const referrers = rows(referrerBreakdown).map(r => ({
      domain:   r[0],
      visitors: r[1],
    }));

    // ── Parse session stats ──────────────────────────────────────────────────
    const sessRow  = row0(sessionStats);
    const sessions = sessRow ? { count: sessRow[0] || 0, avg_duration_sec: sessRow[1] || 0 } : { count: 0, avg_duration_sec: 0 };

    // ── Compose response ─────────────────────────────────────────────────────
    return res.status(200).json({
      ok:        true,
      generated: new Date().toISOString(),
      visitors: {
        last_7d:  { unique: v7?.[0] || 0,  pageviews: v7?.[1] || 0  },
        last_30d: { unique: v30?.[0] || 0, pageviews: v30?.[1] || 0 },
      },
      sessions,
      funnel,
      dailyChart,
      countries,
      devices,
      walletTypes,
      referrers,
    });

  } catch (err) {
    console.error("Analytics error:", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};

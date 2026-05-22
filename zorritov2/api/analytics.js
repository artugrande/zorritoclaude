/**
 * api/analytics.js — PostHog proxy for the Zorrito V2 stats dashboard.
 *
 * Keeps the PostHog API key server-side. If POSTHOG_API_KEY is not configured,
 * returns a placeholder payload with the same shape so stats.html doesn't break.
 *
 * GET /api/analytics
 */

const POSTHOG_HOST       = process.env.POSTHOG_HOST       || "https://us.i.posthog.com";
const POSTHOG_PROJECT_ID = process.env.POSTHOG_PROJECT_ID || "";
const POSTHOG_API_KEY    = process.env.POSTHOG_API_KEY    || "";

function placeholder(reason) {
  return {
    ok: true,
    placeholder: true,
    reason,
    generated: new Date().toISOString(),
    visitors: { last_7d: { unique: 0, pageviews: 0 }, last_30d: { unique: 0, pageviews: 0 } },
    sessions: { count: 0, avg_duration_sec: 0 },
    funnel: { visitors: 0, connected: 0, deposited: 0 },
    dailyChart: [],
    countries: [],
    devices: [],
    walletTypes: [],
    referrers: [],
  };
}

async function phQuery(query) {
  const res = await fetch(`${POSTHOG_HOST}/api/projects/${POSTHOG_PROJECT_ID}/query/`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${POSTHOG_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`PostHog ${res.status}`);
  return res.json();
}
const hogql = (sql) => ({ kind: "HogQLQuery", query: sql });

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=600");

  if (!POSTHOG_API_KEY || !POSTHOG_PROJECT_ID) {
    return res.status(200).json(placeholder("POSTHOG_API_KEY or POSTHOG_PROJECT_ID not configured"));
  }

  try {
    const [
      visitors7d, visitors30d, pageviewsDaily, countryBreakdown,
      deviceBreakdown, walletTypeBreakdown, funnelRaw, referrerBreakdown, sessionStats,
    ] = await Promise.allSettled([
      phQuery(hogql(`
        SELECT count(distinct person_id) as unique_visitors, count() as total_pageviews
        FROM events WHERE event = '$pageview' AND timestamp >= now() - interval 7 day
      `)),
      phQuery(hogql(`
        SELECT count(distinct person_id) as unique_visitors, count() as total_pageviews
        FROM events WHERE event = '$pageview' AND timestamp >= now() - interval 30 day
      `)),
      phQuery(hogql(`
        SELECT toDate(timestamp) as day,
               count(distinct person_id) as unique_visitors,
               count() as pageviews
        FROM events
        WHERE event = '$pageview' AND timestamp >= now() - interval 30 day
        GROUP BY day ORDER BY day ASC
      `)),
      phQuery(hogql(`
        SELECT properties.$geoip_country_name as country,
               properties.$geoip_country_code as country_code,
               count(distinct person_id) as visitors
        FROM events
        WHERE event = '$pageview' AND properties.$geoip_country_name IS NOT NULL
        GROUP BY country, country_code ORDER BY visitors DESC LIMIT 50
      `)),
      phQuery(hogql(`
        SELECT properties.$device_type as device,
               count(distinct person_id) as visitors
        FROM events
        WHERE event = '$pageview' AND timestamp >= now() - interval 30 day
          AND properties.$device_type IS NOT NULL
        GROUP BY device ORDER BY visitors DESC
      `)),
      phQuery(hogql(`
        SELECT properties.wallet_type as wallet_type, count() as connections
        FROM events
        WHERE event = 'wallet_connected' AND timestamp >= now() - interval 30 day
        GROUP BY wallet_type ORDER BY connections DESC
      `)),
      phQuery(hogql(`
        SELECT
          countDistinctIf(distinct_id, event = '$pageview')         as step1_visitors,
          countDistinctIf(distinct_id, event = 'wallet_connected')  as step2_connected,
          countDistinctIf(distinct_id, event = 'deposit_completed') as step3_deposited
        FROM events WHERE timestamp >= now() - interval 30 day
      `)),
      phQuery(hogql(`
        SELECT properties.$referring_domain as referrer,
               count(distinct person_id) as visitors
        FROM events
        WHERE event = '$pageview' AND timestamp >= now() - interval 30 day
          AND properties.$referring_domain IS NOT NULL AND properties.$referring_domain != ''
        GROUP BY referrer ORDER BY visitors DESC LIMIT 8
      `)),
      phQuery(hogql(`
        SELECT count() as sessions,
               avg(dateDiff('second', min_ts, max_ts)) as avg_duration_sec
        FROM (
          SELECT properties.$session_id,
                 min(timestamp) as min_ts, max(timestamp) as max_ts
          FROM events
          WHERE timestamp >= now() - interval 30 day
            AND properties.$session_id IS NOT NULL AND properties.$session_id != ''
          GROUP BY properties.$session_id
        )
      `)),
    ]);

    const safe = (s, f = null) => s.status === "fulfilled" ? s.value : f;
    const row0 = (s) => safe(s)?.results?.[0] ?? null;
    const rows = (s) => safe(s)?.results ?? [];

    const v7  = row0(visitors7d);
    const v30 = row0(visitors30d);
    const dailyChart = rows(pageviewsDaily).map(r => ({ date: r[0], unique_visitors: r[1], pageviews: r[2] }));
    const countries  = rows(countryBreakdown).map(r => ({ country: r[0] || "Unknown", country_code: (r[1] || "").toLowerCase(), visitors: r[2] }));
    const devices    = rows(deviceBreakdown).map(r => ({ device: r[0] || "Unknown", visitors: r[1] }));
    const walletTypes= rows(walletTypeBreakdown).map(r => ({ wallet_type: r[0] || "unknown", connections: r[1] }));
    const fn         = row0(funnelRaw);
    const funnel     = fn ? { visitors: fn[0] || 0, connected: fn[1] || 0, deposited: fn[2] || 0 } : { visitors: 0, connected: 0, deposited: 0 };
    const referrers  = rows(referrerBreakdown).map(r => ({ domain: r[0], visitors: r[1] }));
    const sr         = row0(sessionStats);
    const sessions   = sr ? { count: sr[0] || 0, avg_duration_sec: sr[1] || 0 } : { count: 0, avg_duration_sec: 0 };

    return res.status(200).json({
      ok: true,
      generated: new Date().toISOString(),
      visitors: {
        last_7d:  { unique: v7?.[0]  || 0, pageviews: v7?.[1]  || 0 },
        last_30d: { unique: v30?.[0] || 0, pageviews: v30?.[1] || 0 },
      },
      sessions, funnel, dailyChart, countries, devices, walletTypes, referrers,
    });
  } catch (err) {
    console.error("Analytics error:", err);
    return res.status(200).json(placeholder(err.message));
  }
};

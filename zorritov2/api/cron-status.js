// zorritov2/api/cron-status.js
/**
 * Public read-only endpoint: shows last execution + (optionally) history of
 * every keeper cron. Useful for verifying that Vercel crons are actually
 * firing on schedule.
 *
 *   GET /api/cron-status              → last run for each cron
 *   GET /api/cron-status?history=1    → last run + last 50 entries each
 */

const { readCron } = require("./_lib/cron-tracker");

// Keep in sync with vercel.json
const CRONS = [
  { name: "raffle-commit",        schedule: "0 10 * * 1",  desc: "Monday 10:00 UTC — commit raffle entropy" },
  { name: "raffle-execute",       schedule: "5 10 * * 1",  desc: "Monday 10:05 UTC — execute raffle, pay winner" },
  { name: "savings-distributor",  schedule: "0 12 * * *",  desc: "Daily 12:00 UTC — claim Merit + distribute" },
  { name: "demo-agent-tick",      schedule: "0 11 * * *",  desc: "Daily 11:00 UTC — demo agent deposit" },
];

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (req.method === "OPTIONS") return res.status(200).end();

  const withHistory = req.query?.history === "1";

  const out = {};
  for (const { name, schedule, desc } of CRONS) {
    const last    = await readCron(name);
    const history = withHistory ? await readCron(name, { history: true }) : undefined;
    out[name] = {
      schedule,
      desc,
      last,
      ageMs: last?.ts ? Date.now() - new Date(last.ts).getTime() : null,
      ...(history && { history }),
    };
  }

  return res.status(200).json({
    ts: new Date().toISOString(),
    note: "Crons are tracked via Vercel KV. If `last` is null, either the cron has not fired since tracking was added, or KV is unavailable.",
    crons: out,
  });
};

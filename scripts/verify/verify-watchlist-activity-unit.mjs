/**
 * verify-watchlist-activity-unit.mjs — Proactive Job Alerts Phase 4 unit
 * tests for watchlistActivity.js (Analysis 04's deterministic precursor).
 * Pure logic, no dev server.
 *
 * Run: node scripts/verify/verify-watchlist-activity-unit.mjs
 */
import { groupCandidatesByCompany, computeWatchlistActivityStates } from "../../src/lib/proactiveJobAlerts/watchlistActivity.js";

const results = [];
const check = (label, pass) => { results.push({ label, pass }); console.log(`${pass ? "✅" : "❌"} ${label}`); };
const NOW = new Date("2026-08-03T12:00:00Z");
const daysAgo = (n) => new Date(NOW.getTime() - n * 86400000).toISOString();

console.log("\n=== groupCandidatesByCompany ===");
{
  const candidates = [{ company: "Acme Corp" }, { company: "acme corp" }, { company: "Beta Inc" }];
  const grouped = groupCandidatesByCompany(candidates);
  check("Groups case-insensitively", grouped["acme corp"].length === 2);
  check("Distinct companies separated", grouped["beta inc"].length === 1);
}

console.log("\n=== computeWatchlistActivityStates ===");
{
  const watchlist = [
    { company_name: "Acme Corp", status: "dream_company" },
    { company_name: "Beta Inc", status: "watching" },
    { company_name: "Gamma LLC", status: "watching" },
    { company_name: "Quiet Co", status: "watching", last_checked_at: daysAgo(45) },
  ];
  const alertCandidates = [
    { company: "Acme Corp", lifecycle_status: "alerted", signal_enrichments: { hasNetworkContact: true } },
    { company: "Beta Inc", lifecycle_status: "discovered" },
    { company: "Beta Inc", lifecycle_status: "evaluated" },
    { company: "Gamma LLC", posted_at: daysAgo(5) },
    { company: "Gamma LLC", posted_at: daysAgo(8) },
    { company: "Gamma LLC", posted_at: daysAgo(10) },
  ];
  const byCompany = groupCandidatesByCompany(alertCandidates);
  const states = computeWatchlistActivityStates({ watchlist, alertCandidatesByCompany: byCompany, now: NOW });

  const acme = states.find(s => s.companyName === "Acme Corp");
  check("Network contact join takes highest priority signal", acme.signal === "network_contact_joined");
  check("Dream company flag reads from watchlist.status (no separate column)", acme.isDreamCompany === true);

  const beta = states.find(s => s.companyName === "Beta Inc");
  check("New/evaluated postings detected as new_posting", beta.signal === "new_posting" && beta.detail.includes("2"));

  const gamma = states.find(s => s.companyName === "Gamma LLC");
  check("3+ postings within 14 days -> volume_increase", gamma.signal === "volume_increase");

  const quiet = states.find(s => s.companyName === "Quiet Co");
  check("No candidates at all -> quiet (no false signal fabricated)", quiet.signal === "quiet");
}
{
  const states = computeWatchlistActivityStates({ watchlist: [{ company_name: "Solo Co", status: "watching" }], alertCandidatesByCompany: {}, now: NOW });
  check("Company with zero known candidates defaults to quiet, not a crash", states[0].signal === "quiet");
}

console.log("\n=== SUMMARY ===");
const failed = results.filter(r => !r.pass);
console.log(failed.length === 0 ? `✅ ALL ${results.length} CHECKS PASSED` : `❌ ${failed.length}/${results.length} CHECKS FAILED:\n${failed.map(f => "  - " + f.label).join("\n")}`);
process.exit(failed.length === 0 ? 0 : 1);

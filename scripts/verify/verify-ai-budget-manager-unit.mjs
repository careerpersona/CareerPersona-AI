/**
 * verify-ai-budget-manager-unit.mjs — Smart Apply Auto Prep / platform
 * infrastructure Phase 1 unit tests for the shared AI Budget Manager
 * (src/lib/platform/aiBudget.js). Pure logic, no dev server.
 *
 * Run: node scripts/verify/verify-ai-budget-manager-unit.mjs
 */
import { getDailyPeriodKey, getMonthlyPeriodKey, combineBudgetResults } from "../../src/lib/platform/aiBudget.js";

const results = [];
const check = (label, pass) => { results.push({ label, pass }); console.log(`${pass ? "✅" : "❌"} ${label}`); };

console.log("\n=== Period Keys ===");
{
  const d = new Date("2026-08-06T15:30:00Z");
  check("Daily period key is YYYY-MM-DD", getDailyPeriodKey(d) === "2026-08-06");
  check("Monthly period key is YYYY-MM", getMonthlyPeriodKey(d) === "2026-08");
}
{
  const d1 = new Date("2026-08-06T23:59:00Z");
  const d2 = new Date("2026-08-07T00:01:00Z");
  check("Daily period key changes across a day boundary", getDailyPeriodKey(d1) !== getDailyPeriodKey(d2));
  check("Monthly period key stays stable within the same month", getMonthlyPeriodKey(d1) === getMonthlyPeriodKey(d2));
}
{
  const d1 = new Date("2026-08-31T12:00:00Z");
  const d2 = new Date("2026-09-01T12:00:00Z");
  check("Monthly period key changes across a month boundary", getMonthlyPeriodKey(d1) !== getMonthlyPeriodKey(d2));
}

console.log("\n=== Combine Budget Results ===");
{
  const r = combineBudgetResults({ allowed: true }, { allowed: true });
  check("Both allowed -> allowed, no reason", r.allowed === true && r.reason === null);
}
{
  const r = combineBudgetResults({ allowed: false }, { allowed: true });
  check("Daily denies, monthly allows -> denied, reason daily_cap", r.allowed === false && r.reason === "daily_cap");
}
{
  const r = combineBudgetResults({ allowed: true }, { allowed: false });
  check("Daily allows, monthly denies -> denied, reason monthly_cap", r.allowed === false && r.reason === "monthly_cap");
}
{
  const r = combineBudgetResults({ allowed: false }, { allowed: false });
  check("Both deny -> denied, daily_cap takes precedence as the reason", r.allowed === false && r.reason === "daily_cap");
}
{
  const r = combineBudgetResults(undefined, { allowed: true });
  check("Missing/malformed daily result treated as denied, not a crash", r.allowed === false && r.reason === "daily_cap");
}
{
  const r = combineBudgetResults({ allowed: true }, undefined);
  check("Missing/malformed monthly result treated as denied, not a crash", r.allowed === false && r.reason === "monthly_cap");
}

console.log("\n=== SUMMARY ===");
const failed = results.filter(r => !r.pass);
console.log(failed.length === 0 ? `✅ ALL ${results.length} CHECKS PASSED` : `❌ ${failed.length}/${results.length} CHECKS FAILED:\n${failed.map(f => "  - " + f.label).join("\n")}`);
process.exit(failed.length === 0 ? 0 : 1);

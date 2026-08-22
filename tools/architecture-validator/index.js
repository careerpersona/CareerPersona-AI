#!/usr/bin/env node
// Architecture Validator -- detects duplicate business logic and
// module-ownership violations against a registry of rules
// (tools/config/ownership-rules.json). Two-tier by design (not a single
// pass/fail): Referral Intelligence's Phase 9 audit found that only an
// unambiguous pattern (the ranking comparator, 1 hit, always a real
// violation) is safely fully-automatable -- a broader pattern (company-name
// matching) produced 8/9 hits that were legitimate unrelated code and
// required a human reading context a regex can't see. hardFailPatterns
// hits are always real violations; advisoryPatterns hits are reported for
// manual review, never auto-failed.
//
// Usage:
//   node tools/architecture-validator/index.js [--rule=<id>] [--feature=<name>]
//     [--format=console|json|md] [--out=<path>] [--strict]
import { execSync } from "child_process";
import { parseArgs } from "../shared/cli.js";
import { loadConfig, REPO_ROOT, ConfigError } from "../shared/config.js";
import { Report } from "../shared/report.js";
import { PASS, FAIL, TOOL_ERROR } from "../shared/exitCodes.js";

// Runs `grep -rn` for `pattern` under `scope`, excluding `ownerFile`. Uses
// the system grep (already a hard dependency of this dev environment --
// Git Bash on Windows, native on CI) rather than a JS regex file-walker, to
// match this project's own established practice of running real grep for
// these exact checks (see ADR-Referral-Intelligence.md's Evidence section).
function grepScope({ pattern, scope, ownerFile }) {
  const scopePath = scope.endsWith("/") ? scope : `${scope}/`;
  let raw;
  try {
    raw = execSync(`grep -rn -E "${pattern.replace(/"/g, '\\"')}" "${scopePath}"`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e) {
    // grep exits 1 when there are zero matches -- not an error condition here.
    if (e.status === 1 && !e.stdout) return [];
    if (e.status === 1) raw = e.stdout;
    else throw e;
  }
  const ownerAbs = ownerFile.replace(/\\/g, "/");
  const hits = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    // Non-greedy file-prefix match, not `[^:]+`: an absolute Windows path
    // (e.g. "C:/Users/...") has its own colon after the drive letter, which
    // a `[^:]+` file pattern stops at prematurely, capturing "C" as the
    // file and failing to match the real `:<line>:` separator that follows.
    const m = /^(.+?):(\d+):(.*)$/.exec(line);
    if (!m) continue;
    const [, file, lineNo, evidence] = m;
    const relFile = file.replace(/\\/g, "/").replace(/^\.\//, "");
    if (relFile === ownerAbs) continue;
    hits.push({ file: relFile, line: Number(lineNo), evidence: evidence.trim() });
  }
  return hits;
}

function runRule(report, rule) {
  for (const { pattern, description } of rule.hardFailPatterns || []) {
    const hits = grepScope({ pattern, scope: rule.scope, ownerFile: rule.ownerFile });
    report.addCheck(`${rule.id}: 0 hard-fail hits for "${description}" outside ${rule.ownerFile}`, hits.length === 0);
    hits.forEach((h, i) => {
      report.addFinding({
        id: `${rule.id}:hardfail:${i}`, severity: "fail", rule: rule.id,
        message: `${description} -- duplicated logic outside owner ${rule.ownerFile}`,
        file: h.file, line: h.line, evidence: h.evidence,
      });
    });
  }
  for (const { pattern, description } of rule.advisoryPatterns || []) {
    const hits = grepScope({ pattern, scope: rule.scope, ownerFile: rule.ownerFile });
    hits.forEach((h, i) => {
      report.addFinding({
        id: `${rule.id}:advisory:${i}`, severity: "advisory", rule: rule.id,
        message: description, file: h.file, line: h.line, evidence: h.evidence,
        requiresManualReview: true,
        reviewNote: "Advisory pattern -- confirm this is not a reimplementation of the owner's logic before dismissing.",
      });
    });
    if (hits.length === 0) report.addCheck(`${rule.id}: 0 advisory hits for "${description}"`, true);
  }
}

async function main() {
  const args = parseArgs();
  let rules;
  try {
    rules = loadConfig(args.rules || "tools/config/ownership-rules.json");
  } catch (e) {
    if (e instanceof ConfigError) { console.error(`❌ [architecture-validator] ${e.message}`); process.exit(TOOL_ERROR); }
    throw e;
  }

  if (args.rule) rules = rules.filter((r) => r.id === args.rule);
  if (args.feature) rules = rules.filter((r) => !r.feature || r.feature === args.feature);

  if (rules.length === 0) {
    console.error("❌ [architecture-validator] No registered rules matched the given --rule/--feature filter.");
    process.exit(TOOL_ERROR);
  }

  const report = new Report({ tool: "architecture-validator", feature: args.feature || null });
  for (const rule of rules) runRule(report, rule);

  report.finalize({ strict: args.strict });
  report.print(args.format);
  if (args.out) await report.writeFile(args.out, args.format === "console" ? "json" : args.format);

  process.exit(report.status === "fail" ? FAIL : PASS);
}

main();

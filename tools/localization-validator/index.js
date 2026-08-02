#!/usr/bin/env node
// Localization Validator -- consolidates the four localization checks proven
// by hand during Referral Intelligence Phase 8 into one tool:
//  - coverage:     every key in the source locale's namespace exists in every target locale
//  - diff-purity:  locale file changes are pure additions (no accidental modification)
//  - collision:    a candidate key name doesn't already exist elsewhere in its namespace
//  - hardcoded:    heuristic (advisory-only) scan for un-translated JSX text nodes
//
// Usage:
//   node tools/localization-validator/index.js --check=coverage,diff-purity,collision,hardcoded
//     [--namespace=<ns>] [--key=<newKeyName>] [--files=<a.jsx,b.jsx>] [--format=console|json|md] [--out=<path>]
import { execSync } from "child_process";
import path from "path";
import { readFileSync } from "fs";
import { parseArgs } from "../shared/cli.js";
import { loadConfig, REPO_ROOT, ConfigError } from "../shared/config.js";
import { Report } from "../shared/report.js";
import { PASS, FAIL, TOOL_ERROR } from "../shared/exitCodes.js";

function getNested(obj, keyPath) {
  return keyPath.split(".").reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), obj);
}

function flattenKeys(obj, prefix = "") {
  let keys = [];
  for (const [k, v] of Object.entries(obj || {})) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) keys = keys.concat(flattenKeys(v, full));
    else keys.push(full);
  }
  return keys;
}

async function loadLocale(localesDir, code) {
  const fullPath = path.join(REPO_ROOT, localesDir, `${code}.js`);
  const mod = await import(`file://${fullPath.replace(/\\/g, "/")}`);
  return mod.default;
}

// Every key present in the source locale's namespace must exist in every
// target locale -- direct reuse of the exact diffing logic used to verify
// Referral Intelligence's 26 networking.* + 1 opportunity.* keys across all
// 13 non-English locales before and after the Phase 8 translation sweep.
async function checkCoverage(report, cfg, args) {
  const source = await loadLocale(cfg.localesDir, cfg.sourceLocale);
  if (args.namespace && !source[args.namespace]) {
    report.addFinding({ id: "coverage:bad-namespace", severity: "fail", rule: "coverage", message: `Namespace "${args.namespace}" does not exist in the source locale (${cfg.sourceLocale}).` });
    return;
  }
  const scoped = args.namespace ? { [args.namespace]: source[args.namespace] } : source;
  const sourceKeys = flattenKeys(scoped);
  for (const code of cfg.locales) {
    const target = await loadLocale(cfg.localesDir, code);
    const missing = sourceKeys.filter((k) => getNested(target, k) === undefined);
    report.addCheck(`${code}: 0 missing keys${args.namespace ? ` in "${args.namespace}"` : ""}`, missing.length === 0);
    for (const k of missing) {
      report.addFinding({ id: `coverage:${code}:${k}`, severity: "fail", rule: "coverage", message: `Missing key "${k}" in locale "${code}"`, file: `${cfg.localesDir}/${code}.js` });
    }
  }
}

// Confirms a locale-file change set is pure additions -- direct reuse of the
// `git diff --stat` purity check run against all 14 locale files at Phase 8
// sign-off (378 insertions, 0 deletions).
function checkDiffPurity(report, cfg) {
  const targetFiles = [cfg.sourceLocale, ...cfg.locales].map((c) => `${cfg.localesDir}/${c}.js`);
  let diff;
  try {
    diff = execSync(`git diff -U0 -- ${targetFiles.map((f) => `"${f}"`).join(" ")}`, { cwd: REPO_ROOT, encoding: "utf8" });
  } catch (e) {
    report.addFinding({ id: "diff-purity:git-error", severity: "fail", rule: "diff-purity", message: `git diff failed: ${e.message}` });
    return;
  }
  const removedLines = diff.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
  report.addCheck(`Locale diff is pure additions (0 removed/modified lines across ${targetFiles.length} files)`, removedLines.length === 0);
  removedLines.slice(0, 20).forEach((line, i) => {
    report.addFinding({ id: `diff-purity:removed:${i}`, severity: "fail", rule: "diff-purity", message: "Existing translation line was removed or modified", evidence: line });
  });
}

// Confirms a candidate key name isn't already used elsewhere in its namespace
// -- direct reuse of the opportunity.referralAiInsightLabel collision check.
async function checkCollision(report, cfg, args) {
  if (!args.namespace || !args.key) {
    report.addFinding({ id: "collision:missing-args", severity: "fail", rule: "collision", message: "--namespace and --key are both required for the collision check." });
    return;
  }
  const source = await loadLocale(cfg.localesDir, cfg.sourceLocale);
  const ns = source[args.namespace];
  if (!ns) {
    report.addFinding({ id: "collision:bad-namespace", severity: "fail", rule: "collision", message: `Namespace "${args.namespace}" does not exist.` });
    return;
  }
  const existing = args.key in ns;
  report.addCheck(`"${args.key}" does not already exist in namespace "${args.namespace}"`, !existing);
  if (existing) {
    report.addFinding({ id: "collision:hit", severity: "fail", rule: "collision", message: `Key "${args.key}" already exists in namespace "${args.namespace}" -- value: ${JSON.stringify(ns[args.key])}` });
  }
}

// Heuristic JSX text-node scan, advisory only -- this session's own version of
// this exact check produced false positives (a standalone emoji, a JS
// expression fragment) that required a human to dismiss. Never promoted to a
// hard failure, even with --strict elsewhere -- findings are always severity
// "advisory" here on purpose.
function checkHardcoded(report, args) {
  if (!args.files) {
    report.addCheck("hardcoded-string scan: skipped (no --files given)", true);
    return;
  }
  const textNodeRe = />\s*([^<>{}\n][^<>{}]*)\s*</g;
  const symbolOnlyRe = /^[\s\-–—•·%$0-9.,()#+]*$/;
  for (const relFile of args.files.split(",").map((f) => f.trim())) {
    let src;
    try {
      src = readFileSync(path.join(REPO_ROOT, relFile), "utf8");
    } catch {
      report.addFinding({ id: `hardcoded:missing:${relFile}`, severity: "fail", rule: "hardcoded", message: `File not found: ${relFile}` });
      continue;
    }
    let m;
    let hits = 0;
    while ((m = textNodeRe.exec(src))) {
      const text = m[1].trim();
      if (!text || symbolOnlyRe.test(text)) continue;
      hits++;
      report.addFinding({
        id: `hardcoded:${relFile}:${hits}`, severity: "advisory", rule: "hardcoded",
        message: "Possible un-translated JSX text node -- review manually.",
        file: relFile, evidence: text, requiresManualReview: true,
        reviewNote: "Heuristic scan -- standalone emoji and JS expression fragments are known false positives.",
      });
    }
    report.addCheck(`${relFile}: scanned for hardcoded text (advisory only)`, true);
  }
}

async function main() {
  const args = parseArgs();
  let cfg;
  try {
    cfg = loadConfig("tools/config/localization.config.json");
  } catch (e) {
    if (e instanceof ConfigError) { console.error(`❌ [localization-validator] ${e.message}`); process.exit(TOOL_ERROR); }
    throw e;
  }

  const checksToRun = (args.check || "coverage,diff-purity").split(",");
  const report = new Report({ tool: "localization-validator", feature: args.feature || null });

  if (checksToRun.includes("coverage")) await checkCoverage(report, cfg, args);
  if (checksToRun.includes("diff-purity")) checkDiffPurity(report, cfg);
  if (checksToRun.includes("collision")) await checkCollision(report, cfg, args);
  if (checksToRun.includes("hardcoded")) checkHardcoded(report, args);

  report.finalize({ strict: args.strict });
  report.print(args.format);
  if (args.out) await report.writeFile(args.out, args.format === "console" ? "json" : args.format);

  process.exit(report.status === "fail" ? FAIL : PASS);
}

main();

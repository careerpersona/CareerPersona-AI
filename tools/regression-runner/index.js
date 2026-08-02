#!/usr/bin/env node
// Regression/Test Runner -- consolidates the existing scripts/verify/*.cjs
// Playwright suites into one report. Runs each registered script UNCHANGED
// (as a child process), so nothing about the suites themselves needs to be
// rewritten to be covered by this tool.
//
// Prerequisite: dev server running at http://localhost:5173 (same requirement
// every registered suite already documents individually).
//
// Usage:
//   node tools/regression-runner/index.js [--suite=<id>] [--feature=<name>]
//                                          [--parallel] [--format=console|json|md] [--out=<path>]
import { spawn } from "child_process";
import path from "path";
import { parseArgs } from "../shared/cli.js";
import { loadConfig, REPO_ROOT, ConfigError } from "../shared/config.js";
import { Report } from "../shared/report.js";
import { PASS, FAIL, TOOL_ERROR } from "../shared/exitCodes.js";

const CHECK_LINE = /^(✅|❌)\s+(.*)$/;

function runSuite(suite) {
  return new Promise((resolve) => {
    const fullPath = path.join(REPO_ROOT, suite.path);
    const child = spawn(process.execPath, [fullPath], { cwd: REPO_ROOT });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stdout += d.toString(); });
    child.on("close", (code) => resolve({ suite, code, stdout }));
    child.on("error", (err) => resolve({ suite, code: null, stdout: `SPAWN ERROR: ${err.message}` }));
  });
}

function parseChecksFromOutput(stdout) {
  const checks = [];
  for (const line of stdout.split("\n")) {
    const m = CHECK_LINE.exec(line.trim());
    if (m) checks.push({ label: m[2], pass: m[1] === "✅" });
  }
  return checks;
}

async function main() {
  const args = parseArgs();
  let suites;
  try {
    suites = loadConfig("tools/config/regression-suites.json");
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`❌ [regression-runner] ${e.message}`);
      process.exit(TOOL_ERROR);
    }
    throw e;
  }

  if (args.suite) suites = suites.filter((s) => s.id === args.suite);
  if (args.feature) suites = suites.filter((s) => s.feature === args.feature);

  if (suites.length === 0) {
    console.error("❌ [regression-runner] No registered suites matched the given --suite/--feature filter.");
    process.exit(TOOL_ERROR);
  }

  console.log(`Running ${suites.length} suite(s)${args.parallel ? " in parallel" : " sequentially"}...\n`);

  const results = args.parallel
    ? await Promise.all(suites.map(runSuite))
    : await (async () => {
        const out = [];
        for (const s of suites) {
          console.log(`--- ${s.id} ---`);
          out.push(await runSuite(s));
        }
        return out;
      })();

  const report = new Report({ tool: "regression-runner", feature: args.feature || null });

  for (const { suite, code, stdout } of results) {
    const parsedChecks = parseChecksFromOutput(stdout);
    if (parsedChecks.length === 0) {
      // The suite produced no recognizable ✅/❌ lines -- still record its
      // overall exit code so a silently-broken suite can't disappear from
      // the report.
      report.addCheck(`${suite.id}: produced no parseable check output`, false);
    } else {
      for (const c of parsedChecks) report.addCheck(`${suite.id}: ${c.label}`, c.pass);
    }
    // Exit code is authoritative -- a suite could print all-✅ lines and still
    // exit non-zero (e.g. an uncaught error after the summary), so this is
    // checked independently of the parsed lines above, not as a replacement.
    report.addCheck(`${suite.id}: process exit code`, code === 0);
  }

  report.finalize({ strict: args.strict });
  report.print(args.format);
  if (args.out) await report.writeFile(args.out, args.format === "console" ? "json" : args.format);

  process.exit(report.status === "fail" ? FAIL : PASS);
}

main();

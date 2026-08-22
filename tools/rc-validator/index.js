#!/usr/bin/env node
// Release Candidate Validator -- automates the Phase 9 RC checklist
// (ADR-Referral-Intelligence.md's Evidence A-F) as one command: build, lint,
// Architecture Validator, Localization Validator, and the Regression Runner
// (which already includes that feature's registered responsive suite, if
// any -- see Developer-Toolkit-Architecture.md's tool 4 composition and the
// ambiguity note in tools/README.md on why this validator does not launch
// its own separate Playwright session).
//
// Composes existing commands/tools rather than duplicating their logic:
// `npx vite build`, `npx eslint .`, and the three already-built/just-built
// sibling tools, each run as a child process and consolidated into one
// report -- an array of each sub-tool's own report, plus a rolled-up
// top-level status. Never deploys anything; a passing report is evidence
// for a human decision, not a deploy trigger.
//
// Usage:
//   node tools/rc-validator/index.js --feature=<name>
//     [--format=console|json|md] [--out=<path>] [--strict] [--checklist=<path>]
import { spawn } from "child_process";
import path from "path";
import { parseArgs } from "../shared/cli.js";
import { loadConfig, REPO_ROOT, ConfigError } from "../shared/config.js";
import { Report } from "../shared/report.js";
import { PASS, FAIL, TOOL_ERROR } from "../shared/exitCodes.js";

function runCommand(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: REPO_ROOT, shell: true });
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stdout += d.toString(); });
    child.on("close", (code) => resolve({ code, stdout }));
    child.on("error", (err) => resolve({ code: null, stdout: `SPAWN ERROR: ${err.message}` }));
  });
}

// A sub-tool's --format=json output is not necessarily the entirety of its
// stdout -- regression-runner in particular also `console.log`s a "Running
// N suite(s)..." line and a "--- <suite-id> ---" line per suite (useful for
// a human watching it run live) ahead of its final JSON dump, regardless of
// --format. JSON.stringify(x, null, 2)'s first line is always exactly "{",
// so the last such line in stdout marks where the real report begins.
function extractTrailingJSON(stdout) {
  const lines = stdout.split("\n");
  const startIdx = lines.lastIndexOf("{");
  if (startIdx === -1) throw new Error("no JSON object found in stdout");
  return JSON.parse(lines.slice(startIdx).join("\n"));
}

// Runs a sibling tools/<name>/index.js as a child process (never imported
// in-process -- every sibling tool calls process.exit() itself in main(),
// which would kill this validator's own process on the first sub-tool call)
// and parses its --format=json output back into the same report shape.
function runSubTool(relPath, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(REPO_ROOT, relPath), ...args, "--format=json"], { cwd: REPO_ROOT });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      try {
        resolve({ code, report: extractTrailingJSON(stdout) });
      } catch {
        resolve({ code, report: null, rawOutput: stdout + stderr });
      }
    });
  });
}

// Wraps a plain shell command (build/lint -- not one of this toolkit's
// Report-emitting tools) into the same report shape, so the console/JSON/MD
// renderers and the top-level rollup treat every sub-check uniformly.
function commandToReport(tool, label, { code, stdout }) {
  const r = new Report({ tool });
  r.addCheck(label, code === 0);
  if (code !== 0) {
    r.addFinding({ id: `${tool}:nonzero-exit`, severity: "fail", message: `${label} exited with code ${code}`, evidence: stdout.split("\n").slice(-25).join("\n") });
  }
  r.finalize({});
  return r.toJSON();
}

async function main() {
  const args = parseArgs();
  if (!args.feature) {
    console.error("❌ [rc-validator] --feature=<name> is required.");
    process.exit(TOOL_ERROR);
  }

  let checklist;
  try {
    checklist = loadConfig(args.checklist || "tools/config/rc-checklist.json");
  } catch (e) {
    if (e instanceof ConfigError) { console.error(`❌ [rc-validator] ${e.message}`); process.exit(TOOL_ERROR); }
    throw e;
  }

  const section = checklist[args.feature];
  if (!section) {
    console.error(`❌ [rc-validator] No RC checklist section registered for feature "${args.feature}" in ${args.checklist || "tools/config/rc-checklist.json"}.`);
    process.exit(TOOL_ERROR);
  }

  const subReports = [];

  if (section.build) {
    console.error(`[rc-validator] running: npx vite build`);
    subReports.push(commandToReport("build", "npx vite build succeeds", await runCommand("npx", ["vite", "build"])));
  }

  if (section.lint) {
    console.error(`[rc-validator] running: npx eslint .`);
    subReports.push(commandToReport("lint", "npx eslint . reports no errors", await runCommand("npx", ["eslint", "."])));
  }

  if (section.architectureValidator) {
    console.error(`[rc-validator] running: architecture-validator --feature=${args.feature}`);
    const { report, rawOutput } = await runSubTool("tools/architecture-validator/index.js", [`--feature=${args.feature}`]);
    subReports.push(report || { tool: "architecture-validator", status: "fail", summary: "Tool produced no parseable JSON output.", checks: [], findings: [{ severity: "fail", message: "Unparseable output", evidence: rawOutput }] });
  }

  if (section.localization) {
    console.error(`[rc-validator] running: localization-validator (coverage,diff-purity)`);
    const { report, rawOutput } = await runSubTool("tools/localization-validator/index.js", ["--check=coverage,diff-purity"]);
    subReports.push(report || { tool: "localization-validator", status: "fail", summary: "Tool produced no parseable JSON output.", checks: [], findings: [{ severity: "fail", message: "Unparseable output", evidence: rawOutput }] });
  }

  if (section.regression) {
    console.error(`[rc-validator] running: regression-runner --feature=${args.feature} (requires dev server at http://localhost:5173)`);
    const { report, rawOutput } = await runSubTool("tools/regression-runner/index.js", [`--feature=${args.feature}`]);
    subReports.push(report || { tool: "regression-runner", status: "fail", summary: "Tool produced no parseable JSON output.", checks: [], findings: [{ severity: "fail", message: "Unparseable output", evidence: rawOutput }] });
  }

  const hasFail = subReports.some((r) => r.status === "fail");
  const hasWarn = subReports.some((r) => r.status === "warn");
  const status = hasFail || (args.strict && hasWarn) ? "fail" : hasWarn ? "warn" : "pass";
  const summary = `${subReports.filter((r) => r.status === "pass").length}/${subReports.length} sub-checks passed clean` + (hasWarn ? "; advisory findings present" : "") + (hasFail ? "; blocking failures present" : "");

  const consolidated = {
    tool: "rc-validator",
    version: "1.0.0",
    feature: args.feature,
    generatedAt: new Date().toISOString(),
    status,
    summary,
    reports: subReports,
  };

  function toMarkdown() {
    const lines = [`# Release Candidate Report -- ${args.feature}`, "", `**Status:** ${status}  `, `**Summary:** ${summary}  `, `**Generated:** ${consolidated.generatedAt}`, ""];
    for (const r of subReports) {
      lines.push(`## ${r.tool}`, "", `**Status:** ${r.status}  `, `**Summary:** ${r.summary}`, "");
      if (r.checks?.length) for (const c of r.checks) lines.push(`- ${c.pass ? "✅" : "❌"} ${c.label}`);
      if (r.findings?.length) for (const f of r.findings) lines.push(`- **[${f.severity}]** ${f.message}${f.file ? ` (\`${f.file}${f.line ? ":" + f.line : ""}\`)` : ""}`);
      lines.push("");
    }
    return lines.join("\n");
  }

  function toConsole() {
    const lines = [];
    for (const r of subReports) {
      lines.push(`\n--- ${r.tool} ---`);
      for (const c of r.checks || []) lines.push(`${c.pass ? "✅" : "❌"} ${c.label}`);
      for (const f of r.findings || []) lines.push(`${f.severity === "fail" ? "❌" : f.severity === "advisory" ? "⚠️ " : "ℹ️ "} [${f.severity}] ${f.message}`);
      lines.push(`${r.status === "pass" ? "✅" : r.status === "warn" ? "⚠️ " : "❌"} ${r.summary}`);
    }
    lines.push(`\n=== rc-validator SUMMARY (${args.feature}) ===`);
    lines.push(`${status === "pass" ? "✅" : status === "warn" ? "⚠️ " : "❌"} ${summary}`);
    return lines.join("\n");
  }

  if (args.format === "json") console.log(JSON.stringify(consolidated, null, 2));
  else if (args.format === "md") console.log(toMarkdown());
  else console.log(toConsole());

  if (args.out) {
    const { writeFile, mkdir } = await import("fs/promises");
    await mkdir(path.dirname(args.out), { recursive: true });
    const content = args.format === "md" ? toMarkdown() : args.format === "console" || !args.format ? toConsole() : JSON.stringify(consolidated, null, 2);
    await writeFile(args.out, content, "utf8");
  }

  process.exit(status === "fail" ? FAIL : PASS);
}

main();

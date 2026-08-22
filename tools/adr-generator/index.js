#!/usr/bin/env node
// ADR Generator -- renders a standardized ADR whose Evidence section is
// generated directly from an RC Validator report rather than typed from
// memory (the exact gap Developer-Toolkit-Architecture.md identifies:
// ADR-Referral-Intelligence.md's own Evidence section was hand-transcribed
// from what verification scripts had just printed, with no automated link
// between "what the tool found" and "what the ADR claims").
//
// Preserves the section structure already established by every existing
// ADR in docs/architecture/ (Context / Decision / Consequences / Evidence /
// Decision Log / Status) -- reverse-engineered from ADR-Referral-Intelligence.md,
// since no separate template document existed before this tool.
//
// Input:
//   --feature=<name>            required
//   --rc-report=<path>          RC Validator JSON report (--format=json output)
//   --decisions=<path>          docs/architecture/<feature>-decisions.json
//   --out=<path>                required; refuses to overwrite an existing
//                                file unless --force is also given (this
//                                repo's existing ADRs are hand-authored,
//                                frozen documents -- silently overwriting one
//                                would violate "Do not rewrite existing ADRs")
import { readFileSync, existsSync } from "fs";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { parseArgs } from "../shared/cli.js";
import { REPO_ROOT } from "../shared/config.js";
import { TOOL_ERROR, PASS } from "../shared/exitCodes.js";

function readJSON(relOrAbsPath, label) {
  const full = path.resolve(REPO_ROOT, relOrAbsPath);
  let raw;
  try {
    raw = readFileSync(full, "utf8");
  } catch {
    console.error(`❌ [adr-generator] ${label} not found: ${relOrAbsPath} (resolved to ${full})`);
    process.exit(TOOL_ERROR);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`❌ [adr-generator] ${label} is not valid JSON: ${relOrAbsPath} (${e.message})`);
    process.exit(TOOL_ERROR);
  }
}

function renderDecisions(decisions) {
  if (!decisions?.length) return "_No decisions recorded._";
  return decisions.map((d, i) => `### ${i + 1}. ${d.title}\n${d.body}`).join("\n\n");
}

function renderDecisionLog(log) {
  if (!log?.length) return "_No decision log entries recorded._";
  const rows = log.map((e) => `| ${e.phase} | ${e.decision} |`).join("\n");
  return `| Phase | Decision |\n|---|---|\n${rows}`;
}

// Built directly from the RC Validator's own consolidated report -- never
// hand-transcribed. Each sub-tool's status/summary/checks/findings render
// as their own subsection, so the ADR's evidence can be regenerated and
// re-diffed against a fresh RC run at any time.
function renderEvidence(rcReport) {
  if (!rcReport) return "_No RC Validator report supplied -- Evidence section not generated._";
  const parts = [`**RC Validator run:** ${rcReport.generatedAt} -- overall status **${rcReport.status}** -- ${rcReport.summary}`, ""];
  for (const r of rcReport.reports || []) {
    parts.push(`### ${r.tool}`, "", `**Status:** ${r.status} -- ${r.summary}`, "");
    if (r.checks?.length) {
      for (const c of r.checks) parts.push(`- ${c.pass ? "✅" : "❌"} ${c.label}`);
      parts.push("");
    }
    if (r.findings?.length) {
      for (const f of r.findings) {
        const loc = f.file ? ` (\`${f.file}${f.line ? ":" + f.line : ""}\`)` : "";
        parts.push(`- **[${f.severity}]** ${f.message}${loc}`);
      }
      parts.push("");
    }
  }
  return parts.join("\n");
}

function render(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) out = out.split(`{{${k}}}`).join(v);
  return out;
}

async function main() {
  const args = parseArgs();
  if (!args.feature) { console.error("❌ [adr-generator] --feature=<name> is required."); process.exit(TOOL_ERROR); }
  if (!args.decisions) { console.error("❌ [adr-generator] --decisions=<path> is required."); process.exit(TOOL_ERROR); }
  if (!args.out) { console.error("❌ [adr-generator] --out=<path> is required."); process.exit(TOOL_ERROR); }

  const outFull = path.resolve(REPO_ROOT, args.out);
  if (existsSync(outFull) && !args.force) {
    console.error(`❌ [adr-generator] Refusing to overwrite existing file: ${args.out}. Pass --force to overwrite deliberately.`);
    process.exit(TOOL_ERROR);
  }

  const decisions = readJSON(args.decisions, "Decisions file");
  const rcReport = args["rc-report"] ? readJSON(args["rc-report"], "RC Validator report") : null;

  const templatePath = path.join(REPO_ROOT, "tools/adr-generator/template.md");
  const template = readFileSync(templatePath, "utf8");

  const today = new Date().toISOString().slice(0, 10);
  const rendered = render(template, {
    title: decisions.title || decisions.feature,
    status: decisions.status || "Proposed",
    date: decisions.date || today,
    owners: decisions.owners || "Architect approval (see Decision Log below)",
    context: decisions.context || "_No context recorded._",
    decisions: renderDecisions(decisions.decisions),
    consequences: decisions.consequences || "_No consequences recorded._",
    evidence: renderEvidence(rcReport),
    decisionLog: renderDecisionLog(decisions.decisionLog),
    statusFooter: decisions.statusFooter || decisions.status || "Proposed",
    statusNote: decisions.statusNote || "",
  });

  await mkdir(path.dirname(outFull), { recursive: true });
  await writeFile(outFull, rendered, "utf8");
  console.log(`✅ [adr-generator] Wrote ADR for "${args.feature}" to ${args.out}`);
  process.exit(PASS);
}

main();

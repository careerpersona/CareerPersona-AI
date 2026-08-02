// Shared report shape for every tool in tools/. Two complementary record types:
//  - checks: simple {label, pass} pairs -- mirrors the exact convention every
//    scripts/verify/*.cjs script already uses, so console output stays
//    immediately familiar and the Regression Runner can consolidate existing
//    scripts' own pass/fail lines without reinventing a format.
//  - findings: richer evidence records (file/line/severity/reviewNote) for
//    tools that need to report *what* was found, not just pass/fail.
export class Report {
  constructor({ tool, version = "1.0.0", feature = null }) {
    this.tool = tool;
    this.version = version;
    this.feature = feature;
    this.generatedAt = new Date().toISOString();
    this.checks = [];
    this.findings = [];
  }

  addCheck(label, pass) {
    this.checks.push({ label, pass });
    return pass;
  }

  // severity: "fail" (always fails the run) | "advisory" (reported, does not
  // fail unless --strict) | "info" (reported only).
  addFinding({ id, severity = "advisory", rule = null, message, file = null, line = null, evidence = null, requiresManualReview = false, reviewNote = null }) {
    this.findings.push({ id, severity, rule, message, file, line, evidence, requiresManualReview, reviewNote });
  }

  // Call once after all checks/findings are recorded. strict promotes
  // advisory findings to failing status (never demotes a real "fail").
  finalize({ strict = false } = {}) {
    const failedChecks = this.checks.filter((c) => !c.pass);
    const failFindings = this.findings.filter((f) => f.severity === "fail");
    const advisoryFindings = this.findings.filter((f) => f.severity === "advisory");

    const hasHardFailure = failedChecks.length > 0 || failFindings.length > 0;
    const hasAdvisory = advisoryFindings.length > 0;

    this.status = hasHardFailure || (strict && hasAdvisory) ? "fail" : hasAdvisory ? "warn" : "pass";
    this.stats = {
      checksRun: this.checks.length,
      checksPassed: this.checks.length - failedChecks.length,
      checksFailed: failedChecks.length,
      findingsTotal: this.findings.length,
      findingsFail: failFindings.length,
      findingsAdvisory: advisoryFindings.length,
    };
    const parts = [];
    if (this.checks.length) parts.push(`${this.stats.checksPassed}/${this.stats.checksRun} checks passed`);
    if (this.findings.length) parts.push(`${failFindings.length} fail, ${advisoryFindings.length} advisory finding(s)`);
    this.summary = parts.length ? parts.join("; ") : "no checks or findings recorded";
    return this;
  }

  toJSON() {
    return {
      tool: this.tool,
      version: this.version,
      feature: this.feature,
      generatedAt: this.generatedAt,
      status: this.status,
      summary: this.summary,
      stats: this.stats,
      checks: this.checks,
      findings: this.findings,
    };
  }

  toConsole() {
    const lines = [];
    for (const c of this.checks) lines.push(`${c.pass ? "✅" : "❌"} ${c.label}`);
    for (const f of this.findings) {
      const icon = f.severity === "fail" ? "❌" : f.severity === "advisory" ? "⚠️ " : "ℹ️ ";
      const loc = f.file ? ` (${f.file}${f.line ? ":" + f.line : ""})` : "";
      lines.push(`${icon} [${f.severity}] ${f.message}${loc}`);
      if (f.reviewNote) lines.push(`     review: ${f.reviewNote}`);
    }
    lines.push("");
    lines.push(`=== ${this.tool} SUMMARY ===`);
    lines.push(`${this.status === "pass" ? "✅" : this.status === "warn" ? "⚠️ " : "❌"} ${this.summary}`);
    return lines.join("\n");
  }

  toMarkdown() {
    const lines = [`## ${this.tool}`, "", `**Status:** ${this.status}  `, `**Summary:** ${this.summary}  `, `**Generated:** ${this.generatedAt}`, ""];
    if (this.checks.length) {
      lines.push("### Checks", "");
      for (const c of this.checks) lines.push(`- ${c.pass ? "✅" : "❌"} ${c.label}`);
      lines.push("");
    }
    if (this.findings.length) {
      lines.push("### Findings", "");
      for (const f of this.findings) {
        const loc = f.file ? ` (\`${f.file}${f.line ? ":" + f.line : ""}\`)` : "";
        lines.push(`- **[${f.severity}]** ${f.message}${loc}`);
        if (f.evidence) lines.push(`  \`\`\`\n  ${f.evidence}\n  \`\`\``);
        if (f.reviewNote) lines.push(`  > ${f.reviewNote}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  print(format = "console") {
    if (format === "json") console.log(JSON.stringify(this.toJSON(), null, 2));
    else if (format === "md") console.log(this.toMarkdown());
    else console.log(this.toConsole());
  }

  async writeFile(filePath, format = "json") {
    const { writeFile, mkdir } = await import("fs/promises");
    const path = await import("path");
    await mkdir(path.dirname(filePath), { recursive: true });
    const content = format === "json" ? JSON.stringify(this.toJSON(), null, 2) : format === "md" ? this.toMarkdown() : this.toConsole();
    await writeFile(filePath, content, "utf8");
  }
}

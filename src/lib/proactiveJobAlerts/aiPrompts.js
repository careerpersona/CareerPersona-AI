// Proactive Job Alerts -- AI Analysis Layer, pure half. Prompt building,
// availability predicates, and response parsing -- zero I/O, zero askClaude
// import, so these are directly unit-testable without a browser or dev
// server (unlike src/data/proactiveJobAlerts.js, which imports askClaude
// from App.jsx and therefore can only run inside the actual app).
//
// Consumes the Discovery Engine's already-computed, already-tiered, already-
// capped output; never recomputes a score, tier, signal, or selection. See
// src/data/proactiveJobAlerts.js for the thin wrapper that actually calls
// askClaude with these prompts, and the Phase 3 report for the full AI
// Justification per analysis.

function fmtPct(n) {
  return n == null ? "unknown" : `${Math.round(n * 100)}%`;
}

// ── Analysis 01: Critical Opportunity Engine (every 4-6h) ───────────────────
// Input is the ALREADY delivery-capped, ALREADY deterministically-ranked set
// from discoveryEngine.enforceDeliveryCaps() -- at most 2 critical + 3 high.
// The AI never decides which opportunities cross the daily cap (Rule 5: hard
// limits enforced at the insertion point, not by AI); it only writes the
// "Why This Is Urgent" explanation and the within-digest display order for
// the small set Discovery Engine already selected.
export function buildCriticalOpportunityPrompt(deliverCandidates) {
  if (!deliverCandidates.length) return null;
  const dataLines = deliverCandidates.map((c, i) =>
    `${i}. "${c.job.title}" at ${c.job.company} -- tier: ${c.tier} (${c.tierReason}); match: ${c.matchScore}%; confidence: ${c.confidenceTier}; ` +
    `urgency factors: ${c.urgencyFactors.map(f => f.type).join(", ") || "none"}.`
  ).join("\n");

  const prompt = `You are CareerPersona AI -- Critical Opportunity Engine. These ${deliverCandidates.length} opportunities have ALREADY been deterministically selected as today's Critical/High alerts (tier and urgency factors are fixed facts, not for you to change).

CRITICAL RULES:
- Do not change, add, or invent a tier, urgency factor, match score, or company fact not listed below.
- Your only job: write a 1-2 sentence "why this is urgent" explanation per opportunity using ONLY the listed facts, and order them by how urgent they are relative to each other.

DATA:
${dataLines}

Return ONLY this JSON, no markdown:
{"v":1,"alerts":[{"index":<int>,"whyUrgent":"<1-2 sentences>","displayRank":<int, 1=shown first>"}]}`;

  return { prompt, candidates: deliverCandidates };
}

export function parseCriticalOpportunityResponse(raw, deliverCandidates) {
  try {
    const s = raw.indexOf("{"); const e = raw.lastIndexOf("}");
    const parsed = s >= 0 && e > s ? JSON.parse(raw.slice(s, e + 1)) : null;
    if (parsed?.v !== 1 || !Array.isArray(parsed.alerts)) return null;
    return parsed.alerts
      .filter(a => Number.isInteger(a.index) && deliverCandidates[a.index])
      .sort((a, b) => (a.displayRank ?? 99) - (b.displayRank ?? 99))
      .map(a => ({ candidate: deliverCandidates[a.index], whyUrgent: a.whyUrgent, displayRank: a.displayRank }));
  } catch {
    return null;
  }
}

// ── Analysis 04: Watchlist Activity Monitor (every 12h) ──────────────────────
// Input is a list of already-detected activity states (§13's table --
// detection is a mechanical status/date/signal check, done by the caller
// before this function runs, never by the AI). Deliberately the thinnest
// justification of the six analyses -- see the Phase 3 report.
export function buildWatchlistActivityPrompt(activityStates) {
  const active = activityStates.filter(s => s.signal !== "quiet");
  if (!active.length) return null;
  const dataLines = active.map(s => `- ${s.companyName}: ${s.signal}${s.detail ? ` (${s.detail})` : ""}${s.isDreamCompany ? " [dream company]" : ""}${s.outcomePatternPositive ? " [positive outcome pattern at similar companies]" : ""}`).join("\n");

  const prompt = `You are CareerPersona AI -- Watchlist Activity Monitor. The following watchlist companies show ALREADY-DETECTED activity signals (facts, not for you to change).

CRITICAL RULES:
- Do not invent a company, signal, or fact not listed below.
- Your only job: synthesize these into ONE short paragraph telling the user which company most deserves their attention first and why, connecting signals across companies where relevant.

DATA:
${dataLines}

Return ONLY this JSON, no markdown:
{"v":1,"watchlistSummary":{"finding":"<2-3 sentences>","evidence":"<1 sentence citing which companies>"}}`;

  return { prompt };
}

export function parseWatchlistActivityResponse(raw) {
  try {
    const s = raw.indexOf("{"); const e = raw.lastIndexOf("}");
    const parsed = s >= 0 && e > s ? JSON.parse(raw.slice(s, e + 1)) : null;
    return parsed?.v === 1 ? parsed.watchlistSummary : null;
  } catch {
    return null;
  }
}

// ── Analyses 02 + 03 + 05 + 06: Weekly (conditional sections) ───────────────
// Same conditional-inclusion pattern as Referral Intelligence's
// buildReferralIntelligencePayload -- a section's prompt block AND JSON
// schema key are both omitted when unavailable, decided here in code, never
// left for the AI to judge (Data-Driven Availability Rule).
export function computeWeeklyAvailability({ curatedCandidates, volumeTrend, discoveryCoverage, personalOutcomeTiming }) {
  return {
    curatedPipeline: curatedCandidates.length > 0,
    marketIntelligence: volumeTrend?.trend != null,
    alertEffectiveness: discoveryCoverage.total > 0,
    timingIntelligence: personalOutcomeTiming?.hasSignal === true,
  };
}

export function buildWeeklyAnalysesPrompt({
  curatedCandidates, balanceResult, volumeTrend, salarySignal, hiringFreeze, speedOfFill,
  trustScore, missedOpportunities, engagementTrends, discoveryCoverage,
  applicationWindowStats, personalOutcomeTiming, seasonalPattern, availability,
}) {
  const SECTIONS = [];

  if (availability.curatedPipeline) {
    const lines = curatedCandidates.map((c, i) => `${i}. "${c.job.title}" at ${c.job.company} -- match: ${c.matchScore}%${c.isStretch ? " [STRETCH]" : ""}, industry: ${c.industry || "unknown"}.`).join("\n");
    SECTIONS.push({
      key: "curatedPipeline",
      block: `=== ANALYSIS 02: CURATED WEEKLY PIPELINE ===\nDATA: This week's ${curatedCandidates.length} already-selected curated opportunities:\n${lines}\n${balanceResult?.gapNote ? `Note: ${balanceResult.gapNote}\n` : ""}Task: Write a 1-2 sentence "why this week" rationale for EACH opportunity by index, using only the DATA above. Do not re-select, re-rank, or drop any opportunity.`,
      schema: `"curatedPipeline":[{"index":<int>,"whyThisWeek":"<1-2 sentences>"}]`,
    });
  }
  if (availability.marketIntelligence) {
    const parts = [`Posting volume trend: ${volumeTrend.trend} (${volumeTrend.current} this period vs ${volumeTrend.previous} prior average).`];
    if (salarySignal?.trend) parts.push(`Salary trend: ${salarySignal.trend}.`);
    if (hiringFreeze?.broadSlowdown) parts.push(`Broad-based hiring slowdown detected across ${hiringFreeze.categoriesTotal} role categories.`);
    if (speedOfFill?.avgDays) parts.push(`Average time-to-fill: ${speedOfFill.avgDays} days (sample size ${speedOfFill.sampleSize}).`);
    SECTIONS.push({
      key: "marketIntelligence",
      block: `=== ANALYSIS 03: MARKET INTELLIGENCE ===\nDATA: ${parts.join(" ")}\nTask: Explain what this means for the user's search strategy this week. Use ONLY the DATA above -- never attribute a broad slowdown to the user's individual fit.`,
      schema: `"marketIntelligence":{"finding":"<2-3 sentences>","evidence":"<1 sentence>"}`,
    });
  }
  if (availability.alertEffectiveness) {
    const parts = [`Discovery coverage: ${discoveryCoverage.total} evaluated, ${discoveryCoverage.counts.discarded} discarded (${fmtPct(discoveryCoverage.discardRate)}), ${discoveryCoverage.counts.alerted + discoveryCoverage.counts.engaged + discoveryCoverage.counts.applied} surfaced.`];
    if (trustScore.trustScore != null) parts.push(`Alert trust score: ${fmtPct(trustScore.trustScore)} over the last 30 days (${trustScore.engagedOrApplied}/${trustScore.totalAlerts} alerts led to engagement or application).${trustScore.needsSelfCorrection ? " This is below the self-correction threshold; the confidence floor has been automatically raised." : ""}`);
    if (missedOpportunities.length) parts.push(`${missedOpportunities.length} alerted opportunities expired without engagement, e.g.: ${missedOpportunities.slice(0, 3).map(m => `"${m.job_title}" at ${m.company}`).join("; ")}.`);
    if (engagementTrends.length) parts.push(`Engagement patterns by category: ${engagementTrends.map(t => `${t.dimension}=${t.value} (${fmtPct(t.engagementRate)} engagement, n=${t.sampleSize})`).join("; ")}.`);
    SECTIONS.push({
      key: "alertEffectiveness",
      block: `=== ANALYSIS 05: ALERT EFFECTIVENESS ANALYSIS ===\nDATA: ${parts.join(" ")}\nTask: (1) Interpret the trust score and coverage numbers for the user. (2) For each missed opportunity listed, hypothesize the most likely cause (timing, confidence score too high, or unclear urgency signal) -- this is your own judgment, clearly framed as a hypothesis, not a certainty. (3) Note any revealed preference from the engagement patterns. Use ONLY the DATA above.`,
      schema: `"alertEffectiveness":{"trustScoreFinding":"<1-2 sentences>","missedOpportunityHypotheses":[{"jobTitle":"<string>","company":"<string>","hypothesis":"<1 sentence>"}],"preferenceNote":"<1-2 sentences or empty string>"}`,
    });
  }
  if (availability.timingIntelligence) {
    const windowLines = applicationWindowStats.filter(s => s.responseRate != null).map(s => `${s.window}: ${fmtPct(s.responseRate)} response rate (n=${s.sampleSize})`).join("; ");
    const parts = [`Personal application-window response rates: ${windowLines}. Best-performing window: ${personalOutcomeTiming.bestWindow} (${fmtPct(personalOutcomeTiming.bestResponseRate)}).`];
    if (seasonalPattern?.hasSeasonalSignal) parts.push(`Rising-volume months observed: ${seasonalPattern.risingMonths.join(", ")}.`);
    SECTIONS.push({
      key: "timingIntelligence",
      block: `=== ANALYSIS 06: TIMING INTELLIGENCE ===\nDATA: ${parts.join(" ")}\nTask: Recommend when the user should apply relative to a posting's age, personalized to their own historical pattern above. Use ONLY the DATA above.`,
      schema: `"timingIntelligence":{"finding":"<2-3 sentences>","evidence":"<1 sentence>"}`,
    });
  }

  if (!SECTIONS.length) return null;

  const prompt = `You are CareerPersona AI -- Weekly Job Alerts Analyst. Generate ${SECTIONS.length} independent AI ${SECTIONS.length === 1 ? "analysis" : "analyses"}, based only on deterministic facts already computed in code.

CRITICAL RULES:
- Each analysis must derive exclusively from its own DATA block. Do NOT cross-reference other sections.
- Never invent a score, count, trend, or fact not present in the DATA blocks -- your job is to prioritize, explain, and suggest, never to calculate.

${SECTIONS.map(s => s.block).join("\n\n")}

Return ONLY this JSON, no markdown:
{"v":1,"analyses":{${SECTIONS.map(s => s.schema).join(",")}}}`;

  return { prompt, sections: SECTIONS, curatedCandidates };
}

export function parseWeeklyAnalysesResponse(raw, built) {
  try {
    const s = raw.indexOf("{"); const e = raw.lastIndexOf("}");
    const parsed = s >= 0 && e > s ? JSON.parse(raw.slice(s, e + 1)) : null;
    if (parsed?.v !== 1) return null;
    const analyses = parsed.analyses || {};
    if (analyses.curatedPipeline && built?.curatedCandidates) {
      analyses.curatedPipeline = analyses.curatedPipeline
        .filter(a => Number.isInteger(a.index) && built.curatedCandidates[a.index])
        .map(a => ({ candidate: built.curatedCandidates[a.index], whyThisWeek: a.whyThisWeek }));
    }
    return analyses;
  } catch {
    return null;
  }
}

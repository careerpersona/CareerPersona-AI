import { useState, useMemo } from "react";
import { useI18n } from "../i18n/I18nContext";
import { C, Btn, Card } from "../App";
import { computeDiscoveryCoverage } from "../lib/proactiveJobAlerts/effectivenessMetrics";
import { useAlertCandidateLookup } from "../data/proactiveJobAlerts";

const TIER_COLOR = { critical: "#DC2626", high: "#D97706", curated: "#2563EB", discarded: "#9CA3AF" };
const CONFIDENCE_LABEL_KEY = { early_signal: "confEarlySignal", emerging: "confEmerging", high_confidence: "confHighConfidence", exceptional: "confExceptional" };
const URGENCY_LABEL_KEY = {
  closing_soon: "urgencyClosingSoon", referral_confirmed: "urgencyReferralConfirmed", exceptional_match: "urgencyExceptionalMatch",
  outcome_pattern_match: "urgencyOutcomePattern", dream_company_posting: "urgencyDreamCompany", watchlist_company_posting: "urgencyWatchlistCompany",
};

// Deterministic-fact chip row -- the literal, visible evidence the AI
// Explanation Rule requires: every AI narrative block below is rendered with
// one of these directly attached, sourced from the exact `basedOn` object
// worker.js persisted alongside the narrative (never re-derived here).
function FactChips({ items }) {
  if (!items.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 6 }}>
      {items.map((it, i) => (
        <span key={i} style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 8, background: C.bgSoft, color: C.textMid, border: `1px solid ${C.border}` }}>{it}</span>
      ))}
    </div>
  );
}

function AIInsightBlock({ label, text, factChips }) {
  const { t } = useI18n();
  if (!text) return null;
  return (
    <div style={{ background: C.purpleLight, border: `1px solid ${C.purple}20`, borderRadius: 10, padding: "10px 14px", marginTop: 8 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: C.purple, marginBottom: 3, textTransform: "uppercase", letterSpacing: 0.4 }}>{label || t("alerts.aiInsightLabel")}</div>
      <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>{text}</div>
      <div style={{ fontSize: 10, color: C.textMuted, marginTop: 6, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.3 }}>{t("alerts.basedOnLabel")}</div>
      <FactChips items={factChips} />
    </div>
  );
}

function TierBadge({ tier }) {
  const { t } = useI18n();
  return <span style={{ fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 8, color: "#fff", background: TIER_COLOR[tier] || C.textMuted, textTransform: "uppercase" }}>{t(`alerts.tier_${tier}`)}</span>;
}

// Shared by both transparency tools -- a pure read of an already-persisted
// alert_candidates row's deterministic fields. No AI call in either path;
// see the Phase 5 report for why this is the strongest compliant form of the
// AI Explanation Rule (nothing to trace, because nothing is AI-generated).
export function AlertCandidateTransparency({ userId, jobId, mode = "why-not-seen" }) {
  const { t } = useI18n();
  const { status, candidate, lookup } = useAlertCandidateLookup(userId);
  const [open, setOpen] = useState(false);

  const handleOpen = () => {
    setOpen(true);
    if (status === "idle") lookup(jobId);
  };

  return (
    <div>
      <button onClick={handleOpen} style={{ fontSize: 11, color: C.purple, background: "none", border: "none", cursor: "pointer", fontWeight: 600, padding: 0 }}>
        {mode === "why-not-seen" ? t("alerts.whyDidntISeeThis") : t("alerts.explainPriorityChange")}
      </button>
      {open && (
        <div style={{ marginTop: 8, background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 8, padding: "10px 12px", fontSize: 12, color: C.textMid }}>
          {status === "loading" && t("alerts.transparencyLoading")}
          {status === "done" && !candidate && t("alerts.transparencyNeverEvaluated")}
          {status === "done" && candidate && mode === "why-not-seen" && (
            candidate.alert_tier === "discarded"
              ? <span data-testid="discard-reason">{t("alerts.transparencyDiscarded")} {candidate.discard_reason}</span>
              : <span data-testid="lifecycle-status">{t("alerts.transparencyLifecyclePrefix")} {t(`alerts.lifecycle_${candidate.lifecycle_status}`)}</span>
          )}
          {status === "done" && candidate && mode === "explain-priority" && (
            candidate.previous_tier && candidate.previous_tier !== candidate.alert_tier
              ? <span data-testid="tier-change-reason">{candidate.tier_change_reason}</span>
              : t("alerts.transparencyNoPriorityChange")
          )}
        </div>
      )}
    </div>
  );
}

function CriticalAlertCard({ alert, userId }) {
  const { t } = useI18n();
  const c = alert.alert_candidates;
  const exp = alert.explanation;
  const factChips = exp?.basedOn
    ? [
        ...(exp.basedOn.urgencyFactors || []).map(f => t(`alerts.${URGENCY_LABEL_KEY[f.type] || "urgencyUnknown"}`)),
        t("alerts.matchChip").replace("{n}", exp.basedOn.matchScore),
        t(`alerts.${CONFIDENCE_LABEL_KEY[exp.basedOn.confidenceTier] || "confEarlySignal"}`),
      ]
    : [];
  return (
    <Card style={{ borderLeft: `3px solid ${TIER_COLOR[c.alert_tier]}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{c.job_title} — {c.company}</div>
          <div style={{ display: "flex", gap: 6, marginTop: 4, alignItems: "center" }}>
            <TierBadge tier={c.alert_tier} />
            <span style={{ fontSize: 11, color: C.textMuted }}>{t("alerts.matchChip").replace("{n}", c.match_score)}</span>
          </div>
        </div>
      </div>
      <AIInsightBlock label={t("alerts.whyUrgentLabel")} text={exp?.whyUrgent} factChips={factChips} />
      <div style={{ marginTop: 8 }}>
        <AlertCandidateTransparency userId={userId} jobId={c.job_id} mode="explain-priority" />
      </div>
    </Card>
  );
}

function CuratedAlertCard({ alert }) {
  const { t } = useI18n();
  const c = alert.alert_candidates;
  const exp = alert.explanation;
  const factChips = exp?.basedOn
    ? [t("alerts.matchChip").replace("{n}", exp.basedOn.matchScore), ...(exp.basedOn.isStretch ? [t("alerts.stretchChip")] : []), ...(exp.basedOn.industry ? [exp.basedOn.industry] : [])]
    : [];
  return (
    <Card>
      <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{c.job_title} — {c.company}</div>
      <AIInsightBlock label={t("alerts.whyThisWeekLabel")} text={exp?.whyThisWeek} factChips={factChips} />
    </Card>
  );
}

function DeepDiveSection({ titleKey, availableText, findingText, evidenceText, factChips, children }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <button onClick={() => setOpen(o => !o)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{t(titleKey)}</span>
        <span style={{ color: C.textMuted }}>{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div style={{ marginTop: 10 }}>
          {!findingText ? (
            <div style={{ fontSize: 12, color: C.textMuted }}>{availableText}</div>
          ) : (
            <>
              <AIInsightBlock text={findingText} factChips={factChips} />
              {evidenceText && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>{evidenceText}</div>}
              {children}
            </>
          )}
        </div>
      )}
    </Card>
  );
}

export default function ProactiveAlertsPanel({ userId, isPremium, alertsHook }) {
  const { t } = useI18n();
  const { alerts, candidates, marketSignals, loading } = alertsHook;

  // Reads "now" via a lazy useState initializer -- React's own documented
  // escape hatch for an impure value a component needs (the initializer runs
  // once, at mount, not on every render, which is what the purity rule
  // actually objects to). Deliberately not kept fresh via setInterval: the
  // cutoff only needs to be accurate to within the panel's own visit/refresh
  // cadence, not tick-by-tick.
  const [nowMs] = useState(() => Date.now());
  const todaysCritical = alerts.filter(a => a.digest_type === "daily_critical" && a.delivered_at && new Date(a.delivered_at).getTime() >= nowMs - 86400000 && a.alert_candidates);
  const curatedThisWeek = alerts.filter(a => a.digest_type === "weekly_curated" && a.delivered_at && new Date(a.delivered_at).getTime() >= nowMs - 7 * 86400000 && a.alert_candidates);

  // Discovery Coverage stat strip reuses the exact same deterministic
  // function Analysis 05 itself uses server-side (effectivenessMetrics.js) --
  // the frontend never recomputes coverage counts independently.
  const coverage = useMemo(() => computeDiscoveryCoverage(candidates), [candidates]);

  const weeklySignal = useMemo(() => marketSignals.find(s => s.signal_type === "weekly_analysis")?.value, [marketSignals]);
  const watchlistSignal = useMemo(() => marketSignals.find(s => s.signal_type === "watchlist_summary")?.value, [marketSignals]);

  if (!isPremium) {
    return (
      <div>
        <h1 style={{ fontSize: 24, fontWeight: 800, color: C.text, marginBottom: 4 }}>{t("alerts.pageTitle")}</h1>
        <p style={{ fontSize: 14, color: C.textMuted, marginBottom: 20 }}>{t("alerts.pageSubtitle")}</p>
        <Card style={{ textAlign: "center", padding: 48 }}>
          <div style={{ fontSize: 40, marginBottom: 14 }}>🔔</div>
          <div style={{ fontWeight: 700, fontSize: 18, color: C.text, marginBottom: 8 }}>{t("alerts.premiumTitle")}</div>
          <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 20, maxWidth: 480, marginLeft: "auto", marginRight: "auto" }}>{t("alerts.premiumBody")}</div>
          <Btn onClick={() => { window.location.hash = "#pricing"; }}>{t("alerts.upgradeBtn")}</Btn>
        </Card>
      </div>
    );
  }

  if (loading) return <Card style={{ textAlign: "center", padding: 40 }}><div style={{ fontSize: 13, color: C.textMuted }}>{t("alerts.loading")}</div></Card>;

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 800, color: C.text, marginBottom: 4 }}>{t("alerts.pageTitle")}</h1>
      <p style={{ fontSize: 14, color: C.textMuted, marginBottom: 20 }}>{t("alerts.pageSubtitle")}</p>
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card>
        <div style={{ fontWeight: 700, fontSize: 16, color: C.text, marginBottom: 8 }}>🔔 {t("alerts.introTitle")}</div>
        <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.7 }}>{t("alerts.introBody")}</div>
      </Card>

      <Card>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }} className="two-col">
          {[
            [t("alerts.statEvaluated"), coverage.total],
            [t("alerts.statCriticalToday"), todaysCritical.length],
            [t("alerts.statCuratedWeek"), curatedThisWeek.length],
            [t("alerts.statDiscardRate"), coverage.discardRate != null ? `${Math.round(coverage.discardRate * 100)}%` : "—"],
          ].map(([label, val], i) => (
            <div key={i} style={{ background: C.bgSoft, borderRadius: 10, padding: "12px 10px", textAlign: "center" }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>{val}</div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{label}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* Rule 7 (locked): "Nothing today" is a positive success state, never
          an empty/error state. */}
      {todaysCritical.length === 0 ? (
        <Card style={{ textAlign: "center", padding: 32 }}>
          <div style={{ fontSize: 24, marginBottom: 6 }}>✓</div>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 4 }}>{t("alerts.nothingTodayTitle")}</div>
          <div style={{ fontSize: 12, color: C.textMuted }}>{t("alerts.nothingTodayBody").replace("{n}", coverage.total)}</div>
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{t("alerts.todaysCriticalHeading")}</div>
          {todaysCritical.map(a => <CriticalAlertCard key={a.id} alert={a} userId={userId} />)}
        </div>
      )}

      {curatedThisWeek.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{t("alerts.curatedWeekHeading")}</div>
          {curatedThisWeek.map(a => <CuratedAlertCard key={a.id} alert={a} />)}
        </div>
      )}

      <DeepDiveSection
        titleKey="alerts.marketIntelligenceHeading"
        availableText={t("alerts.marketIntelligenceUnavailable")}
        findingText={weeklySignal?.marketIntelligence?.finding}
        evidenceText={weeklySignal?.marketIntelligence?.evidence}
        factChips={weeklySignal?.basedOn?.marketIntelligence ? [
          weeklySignal.basedOn.marketIntelligence.volumeTrend?.trend ? t(`alerts.trend_${weeklySignal.basedOn.marketIntelligence.volumeTrend.trend}`) : null,
          weeklySignal.basedOn.marketIntelligence.hiringFreeze?.broadSlowdown ? t("alerts.broadSlowdownChip") : null,
        ].filter(Boolean) : []}
      />

      <DeepDiveSection
        titleKey="alerts.watchlistHeading"
        availableText={t("alerts.watchlistUnavailable")}
        findingText={watchlistSignal?.finding}
        evidenceText={watchlistSignal?.evidence}
        factChips={(watchlistSignal?.basedOn || []).map(s => `${s.companyName}: ${t(`alerts.signal_${s.signal}`)}`)}
      />

      <DeepDiveSection
        titleKey="alerts.effectivenessHeading"
        availableText={t("alerts.effectivenessUnavailable")}
        findingText={weeklySignal?.alertEffectiveness?.trustScoreFinding}
        evidenceText={null}
        factChips={weeklySignal?.basedOn?.alertEffectiveness ? [
          weeklySignal.basedOn.alertEffectiveness.trustScore?.trustScore != null ? t("alerts.trustScoreChip").replace("{n}", Math.round(weeklySignal.basedOn.alertEffectiveness.trustScore.trustScore * 100)) : null,
        ].filter(Boolean) : []}
      >
        {weeklySignal?.alertEffectiveness?.missedOpportunityHypotheses?.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", marginBottom: 4 }}>{t("alerts.missedOpportunitiesLabel")}</div>
            {weeklySignal.alertEffectiveness.missedOpportunityHypotheses.map((m, i) => (
              <div key={i} style={{ fontSize: 12, color: C.textMid, marginBottom: 4 }}>
                <strong>{m.jobTitle} — {m.company}:</strong> {m.hypothesis}
              </div>
            ))}
          </div>
        )}
      </DeepDiveSection>

      <DeepDiveSection
        titleKey="alerts.timingHeading"
        availableText={t("alerts.timingUnavailable")}
        findingText={weeklySignal?.timingIntelligence?.finding}
        evidenceText={weeklySignal?.timingIntelligence?.evidence}
        factChips={weeklySignal?.basedOn?.timingIntelligence?.personalOutcomeTiming?.bestWindow ? [t(`alerts.window_${weeklySignal.basedOn.timingIntelligence.personalOutcomeTiming.bestWindow}`)] : []}
      />
    </div>
    </div>
  );
}

import { useState, useMemo } from "react";
import { useI18n } from "../i18n/I18nContext";
import { C, Btn, Card } from "../App";
import {
  computeRelationshipStrength,
  computeCompanyReadiness,
  computeTargetCompanies,
  computeReferralAvailability,
  rankByScore,
} from "../lib/referralIntelligence/scoringEngine";
import { runReferralAnalysis } from "../data/referralIntelligence";

// Built lazily (not at module scope) -- App.jsx's `C` export is not yet
// initialized when this module first evaluates, since App.jsx imports this
// component before its own `export const C` line runs (circular import).
function tierColor(tier) {
  return { strong: C.green, warm: C.blue, warming: C.yellow, cold: C.textMuted }[tier];
}
const TIER_LABEL_KEY = { strong: "relationshipTierStrong", warm: "relationshipTierWarm", warming: "relationshipTierWarming", cold: "relationshipTierCold" };
const AVAILABILITY_COPY = { topOpportunities: "referralAvailable01", outreachTiming: "referralAvailable02", relationshipBuilding: "referralAvailable03" };

// Always renders all 3 fixed sections, regardless of whether any analysis has ever
// been generated -- `content` may be null/undefined (before the first run). Each row
// independently shows its real finding or its own positive availability message.
// Mirrors OutcomeAnalysisDeepDives exactly (a new, parallel component -- Outcome
// Intelligence's own component is not touched or generalized).
function ReferralAnalysisDeepDives({ content, t }) {
  const [openKey, setOpenKey] = useState(null);
  const sections = [
    { key: "topOpportunities", title: t("networking.referralAnalysis01") },
    { key: "outreachTiming", title: t("networking.referralAnalysis02") },
    { key: "relationshipBuilding", title: t("networking.referralAnalysis03") },
  ];
  return (
    <Card>
      <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 12 }}>{t("networking.referralDeepDivesHeading")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {sections.map(s => {
          const data = content?.analyses?.[s.key];
          if (!data) {
            return (
              <div key={s.key} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 4 }}>{s.title}</div>
                <div style={{ fontSize: 12, color: C.textMuted }}>{t(`networking.${AVAILABILITY_COPY[s.key]}`)}</div>
              </div>
            );
          }
          const open = openKey === s.key;
          return (
            <div key={s.key} style={{ border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
              <button onClick={() => setOpenKey(open ? null : s.key)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 14px", background: open ? C.bgSoft : "#fff", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 600, color: C.text, textAlign: "left" }}>
                {s.title}<span>{open ? "−" : "+"}</span>
              </button>
              {open && (
                <div style={{ padding: "0 14px 14px", fontSize: 13, color: C.textMid, lineHeight: 1.7 }}>
                  <div style={{ marginBottom: 6 }}>{data.finding}</div>
                  <div style={{ fontSize: 12, color: C.textMuted }}>{data.evidence}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// isPremium is consulted ONLY inside this component, never in NetworkingPage's own
// render tree -- the "outreach" branch (all 4 existing tabs) never references
// isPremium at all, so it cannot be accidentally gated. See the locked Premium
// Integration verification in the blueprint.
export default function ReferralIntelligencePanel({ contacts, watchlist, savedJobs, applications, referralPatterns, profile, isPremium, referralAnalysesHook }) {
  const { t, language } = useI18n();
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const { analyses, latest, saveAnalysis } = referralAnalysesHook;

  const targetCompanies = useMemo(() => computeTargetCompanies({ watchlist, savedJobs, applications }), [watchlist, savedJobs, applications]);
  const relationshipScores = useMemo(
    () => rankByScore((contacts || []).map(c => ({ ...computeRelationshipStrength(c), name: c.name, company: c.company }))),
    [contacts]
  );

  if (!isPremium) {
    return (
      <Card style={{ textAlign: "center", padding: 48 }}>
        <div style={{ fontSize: 40, marginBottom: 14 }}>🤝</div>
        <div style={{ fontWeight: 700, fontSize: 18, color: C.text, marginBottom: 8 }}>{t("networking.referralPremiumTitle")}</div>
        <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 20, maxWidth: 480, marginLeft: "auto", marginRight: "auto" }}>{t("networking.referralPremiumBody")}</div>
        <Btn onClick={() => { window.location.hash = "#pricing"; }}>{t("networking.referralUpgradeBtn")}</Btn>
      </Card>
    );
  }

  const referralPattern = (referralPatterns || []).find(p => p.pattern_type === "referral" && p.pattern_value === "used") || null;
  const companyReadinessList = targetCompanies.map(tc => computeCompanyReadiness({
    companyName: tc.companyName, contacts, watchlistEntry: tc.watchlistEntry, hasSavedOrAppliedJob: tc.hasSavedOrAppliedJob, referralPattern,
  }));
  const availability = computeReferralAvailability({ contacts, targetCompanies, companyReadinessList });
  const anyAvailable = availability.topOpportunities || availability.outreachTiming || availability.relationshipBuilding;

  const runAnalysis = async () => {
    if (!isPremium || !profile?.id) return;
    setRunning(true); setRunError("");
    try {
      await runReferralAnalysis({ contacts, watchlist, savedJobs, applications, referralPatterns, saveAnalysis, userId: profile.id });
    } catch (e) {
      console.error("[ReferralIntelligence]", e);
      setRunError(t("networking.referralRunFailed"));
    } finally {
      setRunning(false);
    }
  };

  const latestContent = latest?.content;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card>
        <div style={{ fontWeight: 700, fontSize: 16, color: C.text, marginBottom: 10 }}>🤝 {t("networking.referralIntroTitle")}</div>
        <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.7 }}>{t("networking.referralIntroBody")}</div>
      </Card>

      {/* Deterministic snapshot -- real data, no AI, always visible immediately from
          the first saved contact (mirrors Outcome Intelligence's Funnel Overview). */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>{t("networking.referralSnapshotHeading")}</div>
          <Btn onClick={runAnalysis} loading={running} disabled={!anyAvailable} style={{ fontSize: 12, padding: "7px 14px" }}>{t("networking.referralRunAnalysis")}</Btn>
        </div>
        {runError && <div style={{ color: C.red, fontSize: 12, marginBottom: 10 }}>{runError}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: relationshipScores.length ? 16 : 0 }} className="two-col">
          {[
            { label: t("networking.referralContactsLabel"), value: String((contacts || []).length) },
            { label: t("networking.referralCompaniesLabel"), value: String(targetCompanies.length) },
            { label: t("networking.referralOverlapLabel"), value: String(companyReadinessList.filter(Boolean).length) },
          ].map((f, i) => (
            <div key={i} style={{ background: C.bgSoft, borderRadius: 10, padding: "12px 10px", textAlign: "center" }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>{f.value}</div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{f.label}</div>
            </div>
          ))}
        </div>
        {relationshipScores.slice(0, 5).map((c, i) => (
          <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 13, color: C.textMid, padding: "8px 0", borderTop: i === 0 ? `1px solid ${C.border}` : "none", borderBottom: i < relationshipScores.length - 1 && i < 4 ? `1px solid ${C.border}` : "none" }}>
            <span>{c.name}{c.company ? ` · ${c.company}` : ""}</span>
            <span style={{ color: tierColor(c.tier), fontWeight: 700, fontSize: 12 }}>{t(`networking.${TIER_LABEL_KEY[c.tier]}`)}</span>
          </div>
        ))}
      </Card>

      {anyAvailable && !latestContent && (
        <Card style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 13, color: C.textMuted }}>{t("networking.referralReadyToAnalyze")}</div>
        </Card>
      )}

      <ReferralAnalysisDeepDives content={latestContent} t={t} />

      {analyses.length > 1 && (
        <Card>
          <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 12 }}>{t("networking.referralHistoryHeading")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {analyses.map(a => (
              <div key={a.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: C.textMid, padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
                <span>{new Date(a.generated_at).toLocaleDateString(language)}</span>
                <span>{a.contact_count} · {a.company_count}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

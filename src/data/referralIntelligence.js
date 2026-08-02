import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";
import { askClaude } from "../App";
import {
  computeRelationshipStrength,
  computeCompanyReadiness,
  computeTargetCompanies,
  computeReferralAvailability,
  rankByScore,
} from "../lib/referralIntelligence/scoringEngine";

// Referral Intelligence's platform-memory table. Mirrors useOutcomeAnalyses exactly.
export function useReferralAnalyses(userId) {
  const [analyses, setAnalyses] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!userId) { setAnalyses([]); setLoading(false); return; }
    setLoading(true);
    const { data, error } = await supabase
      .from("referral_analyses").select("*").eq("user_id", userId).order("generated_at", { ascending: false });
    setAnalyses(!error && data ? data : []);
    setLoading(false);
  }, [userId]);

  useEffect(() => { refresh(); }, [refresh]);

  const saveAnalysis = useCallback(async (userId2, record) => {
    if (!userId2) return;
    const { data, error } = await supabase.from("referral_analyses").insert({
      user_id: userId2,
      contact_count: record.contactCount,
      company_count: record.companyCount,
      content: record.content,
    }).select().single();
    if (error) throw error;
    await refresh();
    return data;
  }, [refresh]);

  return { analyses, latest: analyses[0] || null, loading, saveAnalysis, refresh };
}

function fmtScore(s) {
  return `${s.companyName || s.contactId}: ${s.score} (${s.tier})`;
}

// Builds the DATA blocks + prompt, calling the AI only for sections whose
// availability predicate is true (computed deterministically, never by the AI) --
// same conditional-inclusion pattern as buildOutcomeIntelligencePayload.
export async function buildReferralIntelligencePayload({ contacts, targetCompanies, companyReadinessList, availability }) {
  const readyCompanies = rankByScore(companyReadinessList.filter(Boolean));
  const targetsWithoutContact = targetCompanies.filter(tc => !readyCompanies.some(c => c.companyName === tc.companyName));

  const d1 = readyCompanies.length
    ? `Company readiness scores (higher = stronger referral opportunity): ${readyCompanies.map(fmtScore).join("; ")}.`
    : "No company readiness data yet.";

  const d2 = contacts.length
    ? `Contact relationship scores: ${contacts.map(c => fmtScore({ ...computeRelationshipStrength(c), companyName: `${c.name} (${c.company || "no company"})` })).join("; ")}.`
    : "No contacts logged yet.";

  const d3 = targetsWithoutContact.length
    ? `Target companies with no contact yet: ${targetsWithoutContact.map(t => t.companyName).join(", ")}.`
    : "No target companies without a contact.";

  const SECTIONS = [
    {
      key: "topOpportunities", available: availability.topOpportunities,
      block: `=== ANALYSIS 1: TOP REFERRAL OPPORTUNITIES ===\nDATA: ${d1}\nTask: Prioritize and explain the top 3-5 already-ranked company opportunities above. Do not re-rank them or invent a different order. Use ONLY the DATA above.`,
      schema: `"topOpportunities":{"finding":"<2-3 sentences>","evidence":"<1 sentence>"}`,
    },
    {
      key: "outreachTiming", available: availability.outreachTiming,
      block: `=== ANALYSIS 2: OUTREACH TIMING GUIDANCE ===\nDATA: ${d2}\nTask: Advise when/how to approach the strongest relationships above. Use ONLY the DATA above.`,
      schema: `"outreachTiming":{"finding":"<2-3 sentences>","evidence":"<1 sentence>"}`,
    },
    {
      key: "relationshipBuilding", available: availability.relationshipBuilding,
      block: `=== ANALYSIS 3: RELATIONSHIP BUILDING GUIDANCE ===\nDATA: ${d3}\nTask: Suggest how to start building a relationship at the listed target companies where none exists yet. Use ONLY the DATA above.`,
      schema: `"relationshipBuilding":{"finding":"<2-3 sentences>","evidence":"<1 sentence>"}`,
    },
  ].filter(s => s.available);

  const raw = await askClaude(
    `You are CareerPersona AI — Referral Intelligence Analyst. Generate ${SECTIONS.length} independent AI ${SECTIONS.length === 1 ? "recommendation" : "recommendations"} about a user's referral opportunities, based only on deterministic scores already computed in code.

CRITICAL RULES:
- Each analysis must derive exclusively from its own DATA block. Do NOT cross-reference other sections.
- Never invent a score, rank, or fact not present in the DATA blocks -- your job is to prioritize, explain, and suggest, never to calculate.
- Never fabricate numbers not present in the DATA blocks.

${SECTIONS.map(s => s.block).join("\n\n")}

Return ONLY this JSON, no markdown:
{"v":1,"analyses":{${SECTIONS.map(s => s.schema).join(",")}}}`,
    1500, "referral_intelligence"
  );

  try {
    const s = raw.indexOf("{"); const e = raw.lastIndexOf("}");
    const parsed = s >= 0 && e > s ? JSON.parse(raw.slice(s, e + 1)) : null;
    return parsed?.v === 1 ? parsed : null;
  } catch { return null; }
}

// Orchestrates one full analysis run: computes deterministic scores, calls the AI for
// narrative synthesis, persists the result. Mirrors runOutcomeAnalysis's structure.
export async function runReferralAnalysis({ contacts, watchlist, savedJobs, applications, referralPatterns, saveAnalysis, userId }) {
  const targetCompanies = computeTargetCompanies({ watchlist, savedJobs, applications });
  const referralPattern = (referralPatterns || []).find(p => p.pattern_type === "referral" && p.pattern_value === "used") || null;

  const companyReadinessList = targetCompanies.map(tc =>
    computeCompanyReadiness({
      companyName: tc.companyName,
      contacts,
      watchlistEntry: tc.watchlistEntry,
      hasSavedOrAppliedJob: tc.hasSavedOrAppliedJob,
      referralPattern,
    })
  );

  const availability = computeReferralAvailability({ contacts, targetCompanies, companyReadinessList });
  if (!availability.topOpportunities && !availability.outreachTiming && !availability.relationshipBuilding) {
    return { availability, content: null, contacts, targetCompanies, companyReadinessList };
  }

  const content = await buildReferralIntelligencePayload({ contacts, targetCompanies, companyReadinessList, availability });
  await saveAnalysis(userId, {
    contactCount: contacts.length,
    companyCount: targetCompanies.length,
    content,
  });

  return { availability, content, contacts, targetCompanies, companyReadinessList };
}

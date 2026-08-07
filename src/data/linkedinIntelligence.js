import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";
import { askClaude } from "../App";
import { computeProfileCompleteness, computeKeywordCoverage, computeProfileEvolution } from "../lib/linkedinIntelligence/deterministicScoring";
import {
  isPremiumAnalysisAvailable, buildLinkedinPremiumPrompt, parseLinkedinPremiumResponse,
  buildProfileEvolutionPrompt, parseProfileEvolutionResponse,
  buildFreeContentPrompt, parseFreeContentResponse,
} from "../lib/linkedinIntelligence/aiPrompts";

const TABLE = "linkedin_profile_analyses";

// LinkedIn Intelligence's platform-memory table -- the single writer, per the
// locked blueprint's Ownership Rule (§5/§6). Mirrors useReferralAnalyses /
// useOutcomeAnalyses exactly: row-per-analysis, most-recent-first, never
// updated in place. Applies to all tiers -- Free-tier deterministic scores
// and generated content are always written; Premium interpretive fields
// (strategy_analysis / recruiter_visibility_intelligence) are included in
// THE SAME insert when available, never written via a second call against
// an existing row -- this hook has no update path at all, so a historical
// row can never be recalculated in place, structurally, not just by
// convention.
export function useLinkedInProfileAnalyses(userId) {
  const [analyses, setAnalyses] = useState([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!userId) { setAnalyses([]); setLoading(false); return; }
    setLoading(true);
    const { data, error } = await supabase
      .from(TABLE).select("*").eq("user_id", userId).order("created_at", { ascending: false });
    setAnalyses(!error && data ? data.map(rowToAnalysis) : []);
    setLoading(false);
  }, [userId]);

  useEffect(() => { refresh(); }, [refresh]);

  const saveAnalysis = useCallback(async (record) => {
    if (!userId) return;
    const { data, error } = await supabase.from(TABLE).insert({
      user_id: userId,
      resume_id: record.resumeId || null,
      completeness_score: record.completenessScore ?? null,
      completeness_breakdown: record.completenessBreakdown ?? null,
      keyword_coverage_score: record.keywordCoverageScore ?? null,
      keywords_matched: record.keywordsMatched ?? null,
      keywords_missing: record.keywordsMissing ?? null,
      weights_version: record.weightsVersion || "v1",
      headline: record.headline ?? null,
      about_section: record.aboutSection ?? null,
      experience_optimizations: record.experienceOptimizations ?? null,
      recruiter_visibility_tips: record.recruiterVisibilityTips ?? null,
      strategy_analysis: record.strategyAnalysis ?? null,
      recruiter_visibility_intelligence: record.recruiterVisibilityIntelligence ?? null,
    }).select().single();
    if (error) throw error;
    await refresh();
    return rowToAnalysis(data);
  }, [userId, refresh]);

  // `previous` is exposed now (Phase 2) because it costs nothing beyond the
  // already-fetched list -- Profile Evolution Tracking (Phase 3+) needs two
  // consecutive snapshots to diff, but computing that diff itself is Phase 3
  // scope, not this hook's.
  return { analyses, latest: analyses[0] || null, previous: analyses[1] || null, loading, saveAnalysis, refresh };
}

function rowToAnalysis(r) {
  return {
    id: r.id,
    createdAt: r.created_at,
    resumeId: r.resume_id,
    completenessScore: r.completeness_score,
    completenessBreakdown: r.completeness_breakdown,
    keywordCoverageScore: r.keyword_coverage_score,
    keywordsMatched: r.keywords_matched,
    keywordsMissing: r.keywords_missing,
    weightsVersion: r.weights_version,
    headline: r.headline,
    aboutSection: r.about_section,
    experienceOptimizations: r.experience_optimizations,
    recruiterVisibilityTips: r.recruiter_visibility_tips,
    strategyAnalysis: r.strategy_analysis,
    recruiterVisibilityIntelligence: r.recruiter_visibility_intelligence,
  };
}

// Orchestrates one full LinkedIn Intelligence run: computes deterministic
// facts (Free, all tiers), generates content (Free, all tiers), and --
// Premium only, when available -- generates the interpretive analysis, then
// persists everything in ONE insert. Mirrors runReferralAnalysis's
// structure. Ownership boundary (per Phase 3 guidance): this function
// consumes the deterministic engine's output, it never recomputes a score;
// it writes only strategy_analysis/recruiter_visibility_intelligence among
// the interpretive columns, never the deterministic or generated-content
// columns of a historical row (there is no update path for those at all).
export async function runLinkedinIntelligenceAnalysis({
  resumeText, linkedinProfileText, jobDesc, targetRole, resumeId, isPremium, saveAnalysis, userContext,
}) {
  const completeness = computeProfileCompleteness({ resumeText, linkedinProfileText });
  const keywordCoverage = computeKeywordCoverage({ resumeText, targetText: jobDesc || targetRole });

  const contentPrompt = buildFreeContentPrompt({ resume: resumeText, linkedinProfile: linkedinProfileText, jobDesc, contextString: userContext });
  if (!contentPrompt) return null;
  const contentRaw = await askClaude(contentPrompt, 3000, "linkedin_intelligence");
  const content = parseFreeContentResponse(contentRaw) || {};

  let strategyAnalysis = null;
  let recruiterVisibilityIntelligence = null;
  if (isPremium && isPremiumAnalysisAvailable({ completenessScore: completeness.completeness_score })) {
    const premiumPrompt = buildLinkedinPremiumPrompt({
      completenessBreakdown: completeness.completeness_breakdown,
      keywordCoverageScore: keywordCoverage.keyword_coverage_score,
      keywordsMissing: keywordCoverage.keywords_missing,
      headline: content.headline,
      aboutSection: content.aboutSection,
      targetRole,
    });
    if (premiumPrompt) {
      const premiumRaw = await askClaude(premiumPrompt.prompt, 1200, "linkedin_intelligence");
      const parsed = parseLinkedinPremiumResponse(premiumRaw);
      strategyAnalysis = parsed?.strategyAnalysis || null;
      recruiterVisibilityIntelligence = parsed?.recruiterVisibilityIntelligence || null;
    }
  }

  const saved = await saveAnalysis({
    resumeId,
    completenessScore: completeness.completeness_score,
    completenessBreakdown: completeness.completeness_breakdown,
    keywordCoverageScore: keywordCoverage.keyword_coverage_score,
    keywordsMatched: keywordCoverage.keywords_matched,
    keywordsMissing: keywordCoverage.keywords_missing,
    weightsVersion: completeness.weights_version,
    headline: content.headline,
    aboutSection: content.aboutSection,
    experienceOptimizations: content.experienceOptimizations,
    recruiterVisibilityTips: content.recruiterVisibilityTips,
    strategyAnalysis,
    recruiterVisibilityIntelligence,
  });

  return saved;
}

// Profile Evolution Tracking -- separate trigger point (viewing history, 2+
// analyses), separate call, per One Responsibility per AI Module. Never
// persisted: the blueprint's §6 schema has no column for it, since it's a
// narrative *about* two already-persisted snapshots, not a new fact -- it is
// deterministically recomputable on demand from the two rows, so there is
// nothing to lose by not storing it.
export async function runProfileEvolutionAnalysis({ latest, previous, targetRole }) {
  const evolution = computeProfileEvolution(latest, previous);
  if (!evolution.hasSignal) return { evolution, narrative: null };

  const built = buildProfileEvolutionPrompt(evolution, targetRole);
  if (!built) return { evolution, narrative: null };

  const raw = await askClaude(built.prompt, 500, "linkedin_intelligence");
  const narrative = parseProfileEvolutionResponse(raw);
  return { evolution, narrative };
}

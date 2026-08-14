import { supabase } from "../lib/supabaseClient";
import { fetchProfile } from "./profile";

// Phase 7, Part B — single shared export function, called from both the
// normal Settings entry point and the account-deletion locked screen (same
// underlying function either way, per the task's explicit requirement).
//
// Scope: the 13 categories originally named plus 8 more approved after the
// Phase 7 schema cross-check surfaced them (Resume Analysis History, Salary
// Offers, Job/Company Watchlists, Notifications, Automation Preferences,
// Outcome Intelligence, Smart Apply Queue, AI Career Assistant Chat
// History) -- 21 categories total. Excluded, as explicitly instructed:
// activity_log (internal telemetry) and billing/subscription state
// (subscriptions, stripe_events, feature_usage, usage_daily_summary,
// ai_request_log). Also excluded: the two dead/legacy tables (job_matches,
// subscriptions_legacy) and the dormant, never-written opportunity_snapshots
// table -- none hold data belonging to any real category above.
export async function exportUserData(userId, email) {
  const [
    profile,
    resumes,
    applications,
    savedJobs,
    interviewSessions,
    networkingContacts,
    networkingSessions,
    salaryResearch,
    linkedinAnalyses,
    referralAnalyses,
    aiBriefings,
    aiActionPlans,
    careerProgress,
    jobIntelligence,
    resumeAnalysisHistory,
    salaryOffers,
    jobWatchlist,
    companyWatchlist,
    notifications,
    automationPreferences,
    outcomePatterns,
    outcomeAnalyses,
    recommendationEvaluations,
    smartApplyQueue,
    assistantConversations,
    assistantMessages,
  ] = await Promise.all([
    fetchProfile(userId, email),
    supabase.from("user_resumes").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    supabase.from("applications").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    supabase.from("saved_jobs").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    supabase.from("interview_sessions").select("*").eq("user_id", userId),
    supabase.from("networking_contacts").select("*").eq("user_id", userId),
    supabase.from("networking_sessions").select("*").eq("user_id", userId),
    supabase.from("salary_research").select("*").eq("user_id", userId),
    supabase.from("linkedin_profile_analyses").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    supabase.from("referral_analyses").select("*").eq("user_id", userId).order("generated_at", { ascending: false }),
    supabase.from("ai_briefings").select("*").eq("user_id", userId).order("briefing_date", { ascending: false }),
    supabase.from("ai_action_plans").select("*").eq("user_id", userId).order("plan_date", { ascending: false }),
    supabase.from("career_progress_analysis").select("*").eq("user_id", userId).order("analysis_date", { ascending: false }),
    supabase.from("job_intelligence_analysis").select("*").eq("user_id", userId).order("analysis_date", { ascending: false }),
    supabase.from("resume_analysis_history").select("*").eq("user_id", userId),
    supabase.from("salary_offers").select("*").eq("user_id", userId),
    supabase.from("job_watchlist").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    supabase.from("company_watchlist").select("*").eq("user_id", userId),
    supabase.from("notifications").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    supabase.from("automation_preferences").select("*").eq("user_id", userId),
    supabase.from("outcome_patterns").select("*").eq("user_id", userId),
    supabase.from("outcome_analyses").select("*").eq("user_id", userId).order("generated_at", { ascending: false }),
    supabase.from("recommendation_evaluations").select("*").eq("user_id", userId).order("applied_at", { ascending: false }),
    supabase.from("smart_apply_queue").select("*").eq("user_id", userId).order("created_at", { ascending: false }),
    supabase.from("assistant_conversations").select("*").eq("user_id", userId),
    // assistant_messages has no user_id column of its own -- scoped via the
    // conversation IDs already fetched above, same join the app itself uses.
    (async () => {
      const { data: convos } = await supabase.from("assistant_conversations").select("id").eq("user_id", userId);
      const ids = (convos || []).map(c => c.id);
      if (!ids.length) return { data: [] };
      return supabase.from("assistant_messages").select("*").in("conversation_id", ids).order("created_at", { ascending: true });
    })(),
  ]);

  // Resume files: signed download links included alongside the JSON metadata
  // rather than bundling raw file bytes into the export -- the app has no zip
  // library, and embedding binary as base64 inside a single JSON file would
  // bloat it substantially for no real benefit. Same mechanism already used
  // by the in-app "Download" button (createSignedUrl), just a longer expiry
  // since this file may be reviewed a while after it's generated.
  const resumeRows = resumes.data || [];
  const resumesWithLinks = await Promise.all(resumeRows.map(async (r) => {
    if (!r.file_url) return { ...r, file_download_url: null };
    const { data } = await supabase.storage.from("resumes").createSignedUrl(r.file_url, 3600);
    return { ...r, file_download_url: data?.signedUrl || null };
  }));

  return {
    exported_at: new Date().toISOString(),
    profile,
    resumes: resumesWithLinks,
    resume_analysis_history: resumeAnalysisHistory.data || [],
    applications: applications.data || [],
    saved_jobs: savedJobs.data || [],
    interview_sessions: interviewSessions.data || [],
    networking: {
      contacts: networkingContacts.data || [],
      sessions: networkingSessions.data || [],
    },
    salary_research: salaryResearch.data || [],
    salary_offers: salaryOffers.data || [],
    linkedin_analyses: linkedinAnalyses.data || [],
    referral_analyses: referralAnalyses.data || [],
    ai_career_analyses: {
      briefings: aiBriefings.data || [],
      action_plans: aiActionPlans.data || [],
      career_progress: careerProgress.data || [],
      job_intelligence: jobIntelligence.data || [],
    },
    watchlists: {
      jobs: jobWatchlist.data || [],
      companies: companyWatchlist.data || [],
    },
    notifications: notifications.data || [],
    automation_preferences: automationPreferences.data || [],
    outcome_intelligence: {
      patterns: outcomePatterns.data || [],
      analyses: outcomeAnalyses.data || [],
      recommendation_evaluations: recommendationEvaluations.data || [],
    },
    smart_apply_queue: smartApplyQueue.data || [],
    assistant_chat: {
      conversations: assistantConversations.data || [],
      messages: assistantMessages.data || [],
    },
  };
}

// Direct in-app download -- no email/server round-trip. Blob + object URL,
// same pattern the app already uses for resume PDF/DOCX downloads.
export function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

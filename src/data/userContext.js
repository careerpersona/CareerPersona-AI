import { useMemo } from "react";

// Profile fields used to compute completeness percentage — must stay in sync
// with the same list in DashboardPage.
const PROFILE_FIELDS = [
  "full_name", "email_address", "phone", "location",
  "job_title", "years_experience", "preferred_job_title", "work_type",
];

/**
 * Pure function — no React, safe to call outside components.
 * Accepts whatever data is available; everything defaults to null / [].
 * Returns a normalized context object plus a getContextString() helper for AI prompts.
 *
 * Data param keys:
 *   profile           — from fetchProfile / useAuth
 *   applications      — from useApplications
 *   savedJobs         — from useSavedJobs
 *   resumes           — from useResumes
 *   smartApplyQueue   — from useSmartApplyQueue (raw rows)
 *   interviewSession  — from useInterviewSession { session } value
 *   salaryData        — from useSalaryResearch { data } value ({ form, results } | null)
 *   networkContacts   — from useNetworkingContacts array
 *   networkingSession — from useNetworkingSession { form, results, draft, ... }
 *   briefing          — daily briefing content object (v:2 shape)
 *   dailyPlan         — daily plan content object (v:2, categories shape)
 *   activityLog       — from useActivityLog { activity } array
 *   notifications     — from useNotifications array
 *   chatHistory       — chat messages array [{ role, text }]
 *   companyWatchlist  — from useCompanyWatchlist array [{ company_name, status }]
 */
export function buildUserContext({
  profile = null,
  applications = [],
  savedJobs = [],
  resumes = [],
  smartApplyQueue = [],
  interviewSession = null,
  salaryData = null,
  networkContacts = [],
  networkingSession = null,
  briefing = null,
  dailyPlan = null,
  activityLog = [],
  notifications = [],
  chatHistory = [],
  companyWatchlist = [],
} = {}) {

  // ── Identity ─────────────────────────────────────────────────────────────
  const identity = {
    id: profile?.id ?? null,
    name: profile?.full_name ?? null,
    email: profile?.email_address ?? null,
    phone: profile?.phone ?? null,
    location: profile?.location ?? null,
    currentRole: profile?.job_title ?? null,
    targetRole: profile?.preferred_job_title ?? null,
    yearsExperience: profile?.years_experience ?? null,
    workType: profile?.work_type ?? null,
    careerGoal: profile?.career_goal || null,
    careerTimeline: profile?.career_timeline || null,
  };

  // ── Profile completeness ──────────────────────────────────────────────────
  const profileComplete = profile
    ? Math.round((PROFILE_FIELDS.filter(f => profile[f]).length / PROFILE_FIELDS.length) * 100)
    : 0;

  // ── Applications ──────────────────────────────────────────────────────────
  const apps = applications ?? [];
  const atsScores = apps.map(a => Number(a.atsScore) || 0).filter(n => n > 0);
  const appStats = {
    total: apps.length,
    interviews: apps.filter(a => ["Interview", "Final Interview", "Phone Screen"].includes(a.status)).length,
    offers: apps.filter(a => a.status === "Offer").length,
    rejections: apps.filter(a => a.status === "Rejected").length,
    pending: apps.filter(a => !["Offer", "Rejected", "Withdrawn"].includes(a.status)).length,
    bestAtsScore: atsScores.length ? Math.max(...atsScores) : null,
  };

  // ── Resumes ───────────────────────────────────────────────────────────────
  const resumeList = resumes ?? [];
  const defaultResume = resumeList.find(r => r.is_default) ?? resumeList[0] ?? null;

  // ── Smart Apply ───────────────────────────────────────────────────────────
  const queue = smartApplyQueue ?? [];
  // Collect the most recent salary_insight and company_insight from ready rows
  // so AI agents (Briefing, Chat, Interview) can read them without another DB call.
  const readyRows = queue.filter(i => i.status === "ready");
  const latestSalaryInsight = readyRows.find(i => i.salary_insight)?.salary_insight ?? null;
  const latestCompanyInsight = readyRows.find(i => i.company_insight)?.company_insight ?? null;
  const smartApply = {
    total: queue.length,
    queued: queue.filter(i => i.status === "queued").length,
    ready: readyRows.length,
    applied: queue.filter(i => i.status === "applied").length,
    latestSalaryInsight,
    latestCompanyInsight,
  };

  // ── Interview ─────────────────────────────────────────────────────────────
  const interview = {
    questionsCount: interviewSession?.questions?.length ?? 0,
    mode: interviewSession?.mode ?? null,
    jobDesc: interviewSession?.jobDesc ?? null,
    readinessScore: interviewSession?.mockSummary?.avgScore != null
      ? Math.round(interviewSession.mockSummary.avgScore * 10)
      : null,
  };

  // ── Salary ────────────────────────────────────────────────────────────────
  const salary = {
    hasResearch: !!(salaryData?.results),
    jobTitle: salaryData?.form?.jobTitle ?? null,
    location: salaryData?.form?.location ?? null,
    experience: salaryData?.form?.experience ?? null,
    results: salaryData?.results ?? null,
  };

  // ── Networking ────────────────────────────────────────────────────────────
  const contacts = networkContacts ?? [];
  const networking = {
    contactCount: contacts.length,
    contacts,
    session: networkingSession
      ? {
          form: networkingSession.form ?? null,
          hasResults: !!(networkingSession.results),
          hasDraft: !!(networkingSession.draft),
        }
      : null,
  };

  // ── AI content (briefing + plan) ──────────────────────────────────────────
  const aiContent = {
    hasBriefing: !!(briefing && briefing.v === 2),
    briefing: briefing ?? null,
    hasPlan: !!(dailyPlan && dailyPlan.v === 2),
    dailyPlan: dailyPlan ?? null,
  };

  // ── Activity & notifications ───────────────────────────────────────────────
  // activityLog items have shape { id, action, time } from useActivityLog's fromRow.
  const recentActivity = (activityLog ?? []).slice(0, 5)
    .map(a => a.action ?? a.description ?? "")
    .filter(Boolean);
  const unreadNotifications = (notifications ?? []).filter(n => !n.read).length;

  // ── Context string builder ────────────────────────────────────────────────
  // Returns a compact single-line string suitable for inserting into AI prompts.
  // Call with no args for the full context; pass a sections object to include only
  // specific sections:  getContextString({ identity: true, applications: true })
  const getContextString = (sections) => {
    const all = !sections;
    const parts = [];

    if (all || sections?.identity) {
      parts.push(
        `Name: ${identity.name || "Unknown"}. ` +
        `Role: ${identity.currentRole || "not set"}. ` +
        `Target: ${identity.targetRole || "not set"}. ` +
        `Location: ${identity.location || "not specified"}. ` +
        `Experience: ${identity.yearsExperience || "?"}yrs.` +
        (identity.careerGoal ? ` Career Goal: ${identity.careerGoal}.` : "") +
        (identity.careerTimeline ? ` Target Timeline: ${identity.careerTimeline}.` : "")
      );
    }

    if (all || sections?.applications) {
      parts.push(
        `Applications: ${appStats.total} (interviews: ${appStats.interviews}, offers: ${appStats.offers}). ` +
        `Saved: ${(savedJobs ?? []).length} jobs. ` +
        `Profile: ${profileComplete}% complete. ` +
        `Best ATS: ${appStats.bestAtsScore != null ? appStats.bestAtsScore + "%" : "not analyzed"}.`
      );
    }

    if (all || sections?.interview) {
      parts.push(`Interview practice: ${interview.questionsCount} questions.`);
    }

    if (all || sections?.networking) {
      parts.push(`Network: ${networking.contactCount} contacts.`);
    }

    if (all || sections?.salary) {
      parts.push(`Salary research: ${salary.hasResearch ? "done" : "not done"}.`);
    }

    if ((all || sections?.resumes) && resumeList.length > 0) {
      parts.push(`Resumes: ${resumeList.length} (default: ${defaultResume?.name || "none"}).`);
    }

    if ((all || sections?.smartApply) && smartApply.total > 0) {
      parts.push(
        `Smart Apply: ${smartApply.queued} queued, ${smartApply.ready} ready, ${smartApply.applied} applied.`
      );
    }

    if ((all || sections?.opportunities) && (companyWatchlist ?? []).length > 0) {
      const wl = companyWatchlist ?? [];
      const dreams = wl.filter(w => w.status === "dream_company").map(w => w.company_name);
      parts.push(
        `Company watchlist: ${wl.length} tracked (${dreams.length} dream companies${dreams.length ? ": " + dreams.slice(0, 3).join(", ") : ""}).`
      );
    }

    if ((all || sections?.smartApply) && smartApply.latestSalaryInsight) {
      const si = smartApply.latestSalaryInsight;
      const range = si.marketRange;
      if (range?.median) {
        parts.push(
          `Salary market data: median $${Math.round(range.median / 1000)}K (range $${Math.round((range.low || range.median * 0.85) / 1000)}K–$${Math.round((range.high || range.median * 1.15) / 1000)}K). ` +
          (si.userPositioning ? si.userPositioning : "")
        );
      }
    }

    return parts.join(" ");
  };

  return {
    identity,
    careerGoal: identity.careerGoal,
    careerTimeline: identity.careerTimeline,
    profileComplete,
    apps,
    appStats,
    savedJobs: savedJobs ?? [],
    resumes: resumeList,
    defaultResume,
    smartApply,
    smartApplyQueue: queue,
    latestSalaryInsight,
    latestCompanyInsight,
    interview,
    salary,
    networking,
    aiContent,
    recentActivity,
    notifications: notifications ?? [],
    unreadNotifications,
    chatHistory: chatHistory ?? [],
    getContextString,
  };
}

/**
 * Memoized React hook. Call with whatever data is available at the current
 * component level; everything not supplied defaults to null / [].
 * Rebuilds only when one of the individual data values changes (not on every
 * render), so AI modules can safely read from the returned object without
 * triggering extra re-renders.
 */
export function useUserContext({
  profile = null,
  applications = [],
  savedJobs = [],
  resumes = [],
  smartApplyQueue = [],
  interviewSession = null,
  salaryData = null,
  networkContacts = [],
  networkingSession = null,
  briefing = null,
  dailyPlan = null,
  activityLog = [],
  notifications = [],
  chatHistory = [],
  companyWatchlist = [],
} = {}) {
  return useMemo(
    () =>
      buildUserContext({
        profile,
        applications,
        savedJobs,
        resumes,
        smartApplyQueue,
        interviewSession,
        salaryData,
        networkContacts,
        networkingSession,
        briefing,
        dailyPlan,
        activityLog,
        notifications,
        chatHistory,
        companyWatchlist,
      }),
    [
      profile,
      applications,
      savedJobs,
      resumes,
      smartApplyQueue,
      interviewSession,
      salaryData,
      networkContacts,
      networkingSession,
      briefing,
      dailyPlan,
      activityLog,
      notifications,
      chatHistory,
      companyWatchlist,
    ]
  );
}

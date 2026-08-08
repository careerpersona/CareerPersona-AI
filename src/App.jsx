import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { supabase, initialLocationHash, initialLocationSearch } from "./lib/supabaseClient";
import { fetchProfile, upsertProfile } from "./data/profile";
import { useApplications, insertApplicationRow, deleteApplicationRow, upsertApplicationRow, isInterviewStage } from "./data/applications";
import { useOutcomePatterns, useOutcomeAnalyses, useRecommendationEvaluations } from "./data/outcomeIntelligence";
import { useReferralAnalyses } from "./data/referralIntelligence";
import ReferralIntelligencePanel from "./components/ReferralIntelligencePanel";
import { matchContactsToCompany, computeTargetCompanies, computeCompanyReadiness, rankByScore } from "./lib/referralIntelligence/scoringEngine";
import { useProactiveAlerts } from "./data/proactiveJobAlerts";
import ProactiveAlertsPanel from "./components/ProactiveAlertsPanel";
import { computeAllPatterns, computeFunnel, computeRejectionStageBreakdown, computeOutcomesLoggedCount, computeConfidenceTier, computeAnalysisAvailability, eligibleApplications } from "./lib/outcomeIntelligence/patternEngine";
import { useSavedJobs } from "./data/savedJobs";
import { useResumes, useResumeHistory } from "./data/resumes";
import { useLinkedInProfileAnalyses, runLinkedinIntelligenceAnalysis, runProfileEvolutionAnalysis } from "./data/linkedinIntelligence";
import { useSmartApplyQueue } from "./data/smartApply";
import { useAutomationPreference } from "./data/automationPreferences";
import { useInterviewSession, useInterviewHistory } from "./data/interviewSession";
import { useVoiceInput, voiceSupported } from "./hooks/useVoiceInput";
import { useSalaryResearch } from "./data/salaryResearch";
import { useNetworkingContacts } from "./data/networkingContacts";
import { useNetworkingSession } from "./data/networkingSession";
import { useAssistantChat } from "./data/assistantChat";
import { useActivityLog } from "./data/activityLog";
import { useNotifications, insertNotification } from "./data/notifications";
import { useAiBriefing } from "./data/aiBriefing";
import { useAiActionPlan } from "./data/aiActionPlan";
import { useCareerProgressAnalysis } from "./data/careerProgress";
import { useJobIntelligenceAnalysis } from "./data/jobIntelligence";
import { useUserContext } from "./data/userContext";
import { loadSkillSynonyms } from "./data/skillSynonyms";
import { extractSkillKeywords, buildCompatibilityRecord, normalizeSkillSet } from "./lib/compatibility";
import { useCompanyWatchlist } from "./data/opportunityIntelligence";
import { useJobWatchlist } from "./data/jobWatchlist";
import { I18nContext, useLanguagePreference, useI18n } from "./i18n/I18nContext";
import { normalizeFullName, normalizeEmail, isEmailValid, isEmailPresent, isPhonePresent, normalizePhonesInText, detectContactType, resolveCountry, validateFields, getCountries } from "./lib/contactNormalization";
import { parseResumeDoc } from "./lib/resumeParsing";
import { computeResumeCompleteness } from "./lib/resumeCompleteness";
import { buildIdentityBlock, buildSmartApplyPrompt, SMART_APPLY_DOC_FIELDS, validateSmartApplyPackage, summarizeSmartApplyIntegrity } from "./lib/smartApply/generation";
import { LANGUAGES } from "./i18n/languages";
import { MapPin, Mail, Phone, Globe, User, Briefcase, GraduationCap, Code2, Award, FolderOpen } from 'lucide-react';

// Disable browser scroll restoration before React mounts — prevents the
// browser from jumping to the last scroll position on page refresh.
if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";

export const C = {
  bg: "#FFFFFF", bgSoft: "#F7F8FC", bgCard: "#FFFFFF", border: "#E2E8F0", borderStrong: "#CBD5E1",
  purple: "#6B21E8", purpleLight: "#F3EEFF", purpleMid: "#9B59F5", text: "#0F172A", textMid: "#334155",
  textMuted: "#64748B", green: "#059669", greenLight: "#ECFDF5", red: "#DC2626", redLight: "#FEF2F2",
  yellow: "#D97706", yellowLight: "#FFFBEB", orange: "#F97316", orangeLight: "#FFF7ED", blue: "#2563EB", blueLight: "#EFF6FF",
  navText: "#3B2A1F", navHover: "#6B21E8",
};

const useStorage = (key, initial) => {
  const [val, setVal] = useState(() => { try { const d = localStorage.getItem(key); return d ? JSON.parse(d) : initial; } catch { return initial; } });
  const set = useCallback((v) => { const next = typeof v === "function" ? v(val) : v; setVal(next); localStorage.setItem(key, JSON.stringify(next)); }, [key, val]);
  return [val, set];
};

export const useSessionState = (key, initial) => {
  const [val, setVal] = useState(() => { try { const d = sessionStorage.getItem(key); return d !== null ? JSON.parse(d) : initial; } catch { return initial; } });
  const set = useCallback((v) => { setVal(prev => { const next = typeof v === "function" ? v(prev) : v; try { sessionStorage.setItem(key, JSON.stringify(next)); } catch {} return next; }); }, [key]);
  return [val, set];
};

// Unique ID generator — crypto.randomUUID with a safe fallback
const uid = () => {
  try { if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID(); } catch {}
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

// Persistent account store, separate from "who is currently logged in" —
// so logging out doesn't erase a saved profile (cp_accounts is keyed by email).
const getAccounts = () => { try { return JSON.parse(localStorage.getItem("cp_accounts") || "{}"); } catch { return {}; } };
const saveAccount = (profile) => {
  if (!profile?.email) return;
  const accounts = getAccounts();
  accounts[profile.email.toLowerCase()] = profile;
  localStorage.setItem("cp_accounts", JSON.stringify(accounts));
};

// Detect auth callback URLs synchronously at module load so we can show a
// loading screen instead of the login form while the token is being exchanged.
// Handles both implicit flow (#access_token=…) and PKCE flow (?code=…).
const isAuthCallbackUrl =
  initialLocationHash.includes("access_token=") ||
  initialLocationHash.includes("token_hash=") ||
  initialLocationSearch.includes("code=");

// After a successful auth callback, replace the auth params in the address bar
// with the clean dashboard hash so the token isn't replayed on refresh.
const cleanAuthCallbackUrl = () => {
  if (
    window.location.hash.includes("access_token=") ||
    window.location.hash.includes("token_hash=") ||
    window.location.search.includes("code=")
  ) {
    window.history.replaceState({ page: "dashboard" }, "", "#dashboard");
  }
};

const useAuth = () => {
  // Seed recoveryMode from the hash captured at module load time — before
  // createClient() processes it, before React StrictMode double-mounts effects,
  // and before any onAuthStateChange timing races can occur.
  const isRecoveryUrl = initialLocationHash.includes("type=recovery");
  const [user, setUser] = useState(() => {
    if (isRecoveryUrl) return null; // don't restore old session during recovery
    try { return JSON.parse(localStorage.getItem("cp_user") || "null"); } catch { return null; }
  });
  const [recoveryMode, setRecoveryMode] = useState(isRecoveryUrl);
  // Show a "Completing sign-in…" screen while Supabase exchanges the callback
  // token. Cleared by the first onAuthStateChange event (success or failure).
  const [authResolving, setAuthResolving] = useState(isAuthCallbackUrl && !isRecoveryUrl);
  // Sync ref so async callbacks read the latest value without stale closures.
  const recoveryRef = useRef(isRecoveryUrl);
  const authResolvingRef = useRef(authResolving);

  const login = (u) => { setUser(u); localStorage.setItem("cp_user", JSON.stringify(u)); };
  const logout = async () => {
    try { await supabase.auth.signOut(); } catch {}
    setUser(null);
    recoveryRef.current = false;
    setRecoveryMode(false);
    localStorage.removeItem("cp_user");
  };

  useEffect(() => {
    const syncFromSession = async (session) => {
      if (!session?.user) return;
      if (session.access_token) {
        // 1. Fetch canonical billing state (Worker is single source of truth)
        try {
          const stateRes = await fetch(`${WORKER_URL}/api/billing/state`, {
            headers: { "Authorization": `Bearer ${session.access_token}` },
          });
          if (stateRes.ok) {
            const state = await stateRes.json();
            setBillingState(state);
            window.dispatchEvent(new CustomEvent("billing:updated", { detail: state }));
          }
        } catch (_) {}
      }
      // 2. Fetch profile (non-billing fields: name, email, language, etc.)
      const merged = await fetchProfile(session.user.id, session.user.email);
      login(merged);
    };

    const resolveAuthCallback = () => {
      if (authResolvingRef.current) {
        authResolvingRef.current = false;
        setAuthResolving(false);
        cleanAuthCallbackUrl();
      }
    };

    // On load: sync from Supabase session, or clear stale cp_user if session is gone.
    // Without this, an expired refresh token leaves the user visually "signed in"
    // while every DB write fails silently with an RLS 401.
    supabase.auth.getSession().then(({ data }) => {
      if (recoveryRef.current) return;
      if (data.session) {
        syncFromSession(data.session);
      } else {
        // No valid session — clear any stale cp_user so the login screen shows.
        setUser(null);
        localStorage.removeItem("cp_user");
      }
      // If getSession resolves first (can happen in PKCE flow where the code
      // exchange completes before onAuthStateChange fires), clear the loading screen.
      resolveAuthCallback();
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        // Hold the Supabase internal session (needed for updateUser) but don't
        // treat this as a normal login — show the reset form instead.
        recoveryRef.current = true;
        setRecoveryMode(true);
        setUser(null);
        localStorage.removeItem("cp_user");
        resolveAuthCallback();
        return;
      }
      // Ignore all other events while the user is going through the reset flow
      // (USER_UPDATED fires after updateUser succeeds; we don't want auto-login).
      if (recoveryRef.current) return;
      if (session?.user) {
        syncFromSession(session);
        resolveAuthCallback();
      } else if (event === "SIGNED_OUT") {
        // Explicit sign-out, expired refresh token, or server-side session revocation.
        // Clear local state so the user sees the login screen rather than a broken
        // "signed in but can't do anything" state.
        setUser(null);
        localStorage.removeItem("cp_user");
        resolveAuthCallback();
      } else {
        // Any other event with no session (e.g. TOKEN_REFRESHED with null) —
        // don't leave the loading screen stuck.
        resolveAuthCallback();
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const clearRecovery = () => {
    recoveryRef.current = false;
    setRecoveryMode(false);
  };

  return { user, login, logout, recoveryMode, clearRecovery, authResolving };
};

// ─── DEVELOPMENT MODE ────────────────────────────────────────────────────────
// Toggle below to switch between Development (mock AI) and Production (real API).
//   DEV_MODE = true  → no Anthropic API calls, no credits consumed, instant mocks
//   DEV_MODE = false → real Claude API via Cloudflare Worker (production behavior)
const DEV_MODE = import.meta.env.DEV;

const WORKER_URL = "https://proxy.dawn-voice-2790.workers.dev";

// `options.extraBody` merges additional fields into the worker request body,
// for a feature whose worker-side handler needs more than the standard
// {feature, model, max_tokens, messages} shape (e.g. a per-feature quota key
// alongside the generic Layer 2 check — see handleClaude in worker.js).
// `options.onMeta`, when provided, receives the full parsed worker response
// as a fire-and-forget side channel — the string return value every existing
// caller depends on is unchanged. Generic infrastructure, not tied to any
// one feature; currently unused (no active caller passes `options`), kept
// because askClaude is the single shared execution path every AI feature in
// this app goes through, and a future feature needing extra request/response
// data can reuse this rather than forking a second call path.
export async function askClaude(prompt, maxTokens = 2500, feature = "ai_request", options = {}) {
  const { extraBody = {}, onMeta } = options;
  if (DEV_MODE) {
    // Simulate realistic network latency so all loading states, progress bars,
    // banners, and animations behave exactly as they do in production.
    await new Promise(r => setTimeout(r, 850 + Math.random() * 400));
    return _devMockRoute(prompt);
  }
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  const headers = { "Content-Type": "application/json" };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ feature, model: "claude-sonnet-4-6", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }], ...extraBody }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const errMsg = (typeof err.error === 'object' && err.error !== null)
      ? (err.error?.message || JSON.stringify(err.error))
      : String(err.error || `worker_${res.status}`);
    console.error('[askClaude] HTTP', res.status, 'body:', JSON.stringify(err));
    throw Object.assign(new Error(errMsg), { workerError: err.error, status: res.status, reason: err.reason, perInterviewRemaining: err.perInterviewRemaining, monthlyRemaining: err.monthlyRemaining });
  }
  const data = await res.json();
  // TEMPORARY FORENSIC INSTRUMENTATION — remove after diagnosis. Does not change the
  // return value or any behavior; only surfaces stop_reason for truncation diagnosis.
  if (feature === "ai_request" && maxTokens === 8000) {
    console.log(`[FORENSIC] askClaude stop_reason=${data.stop_reason} content_blocks=${data.content?.length} text_len=${data.content?.[0]?.text?.length}`);
  }
  onMeta?.(data);
  return (data.content?.[0]?.text || "{}").replace(/```json|```/g, "").trim();
}

async function workerBillingPost(path, payload = null) {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw Object.assign(new Error("not_signed_in"), { status: 401 });
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `worker_${res.status}`), { workerError: body.error, status: res.status });
  return body;
}

// Routes every askClaude prompt to the appropriate mock response.
// Checks for distinguishing keywords present in each prompt string.
function _devMockRoute(prompt) {
  const p = prompt.toLowerCase();

  // ── Daily Briefing ─────────────────────────────────────────────────────────
  if (p.includes("daily briefing")) {
    return JSON.stringify({ v: 2, summary: "You have 3 active applications in progress and your ATS score is trending up. Today is a strong day to follow up with recruiters.", newMatchingJobs: "23 new Software Engineer roles posted this week matching your skills.", highestPayingJobs: "Senior roles at Series B startups offer $150K–$185K with strong equity packages.", jobsClosingSoon: "2 applications haven't received a response in 7 days — now is the right time to follow up.", priorityRecommendation: "Add Docker, Kubernetes, and CI/CD to your resume — they appear in 80%+ of your target job descriptions.", companiesHiringNow: "Amazon, Stripe, and Notion are actively sourcing for mid-senior engineers this month.", newOpportunities: "Staff Engineer and Tech Lead roles are open in adjacent areas matching your trajectory.", resumeUpdates: "Your resume is well-structured and competitive — continue tailoring content and keywords for each role you apply to.", atsScoreChanges: "Your ATS score is 82 following keyword optimization. Your resume is well-positioned for your target roles.", interviewInvitations: "1 interview stage pending — prep a strong STAR answer for 'Tell me about a time you led a project.'", recruiterActivity: "Your LinkedIn profile is at 87% completeness — adding 2 skills boosts recruiter visibility.", applicationUpdates: "3 applications are in 'Under Review' — follow up with a brief check-in email.", salaryChanges: "Median comp for Senior Software Engineers in your location increased 6% YoY.", marketUpdates: "Demand for full-stack engineers remains high. Your skills are in demand.", careerInsights: "Candidates who customize their resume per application see a 40% higher interview rate.", dailyHighlights: ["Follow up on 2 applications", "Add Docker & Kubernetes to resume", "Check 3 new job matches"] });
  }

  // ── Action Plan ────────────────────────────────────────────────────────────
  if (p.includes("action plan") || p.includes("productivityscore")) {
    return JSON.stringify({ v: 2, productivityScore: 72, categories: [{ id: "priorities", category: "Today's Priorities", task: "Follow up on your Stripe application — it's been 6 days since submission.", time: "10 min", status: "pending" }, { id: "applications", category: "Recommended Applications", task: "Apply to the Staff Engineer role at Notion — it's a strong match for your background.", time: "30 min", status: "pending" }, { id: "resume", category: "Resume Improvements", task: "Add Docker and Kubernetes to your skills section — they appear in 80% of your target job descriptions.", time: "15 min", status: "pending" }, { id: "interview", category: "Interview Practice", task: "Practice STAR method for 'Tell me about a time you handled a production incident.'", time: "20 min", status: "pending" }], followUps: "Send a brief check-in email to the recruiter at Amazon who reached out last week.", networking: "Connect with 2 engineers at Notion on LinkedIn and mention your shared interest in developer tools.", skills: "Spend 30 minutes on a Docker tutorial — it appears in 68% of your target job descriptions.", certifications: "AWS Solutions Architect certification is highly valued for Senior Engineer roles — visit aws.amazon.com/certification today to review the exam guide and schedule a study session." });
  }

  // ── AI Career Chat ─────────────────────────────────────────────────────────
  if (p.includes("user question:") || (p.includes("careerpersona ai career assistant") && p.includes("answer concisely"))) {
    return "Great question! Based on your profile and application history, I'd recommend focusing on roles that leverage your full-stack background with cloud experience. Make sure to tailor your resume for each application and highlight measurable achievements. Would you like specific advice on your next steps?";
  }

  // ── Resume Analysis (main analyze + keyword-improve re-score) ──────────────
  if (p.includes("ats resume coach") && p.includes("tailoredresume") && p.includes("keywordsfound")) {
    const improved = p.includes("note: this resume was just improved");
    const base = improved ? 88 : 72;
    return JSON.stringify({ atsScore: base, potentialAtsScore: Math.min(base + 14, 97), scoreBreakdown: { keywordMatch: base - 4, formatting: 85, relevance: Math.min(base + 2, 98) }, keywordsFound: ["Python", "JavaScript", "React", "SQL", "AWS", "Node.js"], keywordsMissing: improved ? [] : ["Docker", "Kubernetes", "TypeScript", "CI/CD"], tailoredResume: _devExtractResume(prompt) || _devMockResume(), suggestions: ["Add measurable outcomes to bullet points (e.g. 'Reduced latency by 40%')", "Include Docker and Kubernetes in your skills section", "Add a brief professional summary at the top", "Quantify team sizes and project scopes where possible", "Use stronger action verbs: 'Architected' instead of 'Built'"], coverLetter: "Dear Hiring Manager,\n\nI am excited to apply for this position. With 5+ years of software engineering experience building scalable, high-performance systems, I am confident my background aligns closely with your requirements.\n\nAt Acme Corp I drove a 40% reduction in API latency and led a team of 5 engineers delivering critical data pipelines ahead of schedule. My expertise in Python, React, and AWS enables me to contribute immediately.\n\nI would welcome the opportunity to discuss how my experience can contribute to your team's success.\n\nBest regards,\nJohn Smith", jobTitle: "Senior Software Engineer", company: "Amazon" });
  }

  // ── Resume Quick Insights (strengths / improvements panel) ────────────────
  if (p.includes("highpriorityimprovements") || p.includes("tailoringopportunities")) {
    return JSON.stringify({ strengths: ["Strong technical breadth across frontend and backend with React, Python, and AWS.", "Demonstrated leadership managing cross-functional teams of 5+ engineers.", "Quantified achievements (40% latency reduction) stand out to ATS systems and recruiters."], highPriorityImprovements: ["Add a 3–4 line professional summary at the top to immediately capture recruiter attention.", "Include Docker and Kubernetes — they appear in 80%+ of Senior Engineer job descriptions.", "Replace passive language ('responsible for') with strong action verbs ('architected', 'drove', 'spearheaded')."], missingSkills: ["Container orchestration (Docker, Kubernetes)", "Infrastructure as Code (Terraform, Pulumi)", "System design at scale (millions of users)", "Machine learning or data pipeline experience", "Observability tooling (Datadog, Prometheus, Grafana)"], tailoringOpportunities: ["Mirror the job posting's language around 'distributed systems' and 'high availability'.", "Move AWS experience to the top of your skills list — it's the primary requirement.", "Add your largest system's scale (users, requests/sec) to signal senior-level scope."] });
  }

  // ── AI Resume Builder (returns plain text, not JSON) ──────────────────────
  if (p.includes("expert resume writer") && p.includes("ats-optimized")) {
    return _devMockResume();
  }

  // ── Score Benchmarking ─────────────────────────────────────────────────────
  if (p.includes("market benchmark") || p.includes("industryaverage")) {
    return JSON.stringify({ atsScore: 72, industryAverage: 61, topCandidateAverage: 87, percentile: 68, percentileLabel: "Top 32%", keywordCoverage: 74, formattingScore: 88, experienceScore: 80, skillsScore: 76, educationScore: 85, overallRanking: "Above Average", industryLabel: "Software Engineering", recommendations: ["Add Docker/Kubernetes to reach the top 20% keyword coverage for this role", "Add a professional summary — 78% of top candidates include one", "Quantify more achievements — top candidates average 4.2 metrics per role"] });
  }

  // ── Job Fit Analyzer ───────────────────────────────────────────────────────
  if (p.includes("how well this resume matches") || p.includes("applicationreadiness")) {
    return JSON.stringify({ overallMatch: 76, matchLabel: "Good Match", requiredSkillsMatch: [{ skill: "Python", found: true, evidence: "5+ years Python in current role" }, { skill: "AWS", found: true, evidence: "AWS Lambda and S3 mentioned" }, { skill: "React", found: true, evidence: "React frontend development" }, { skill: "Docker", found: false, evidence: null }, { skill: "Kubernetes", found: false, evidence: null }], preferredSkillsMatch: [{ skill: "TypeScript", found: true }, { skill: "PostgreSQL", found: true }, { skill: "GraphQL", found: false }], missingSkills: ["Docker", "Kubernetes", "GraphQL"], keywordMatchScore: 74, experienceMatch: { score: 82, status: "Well-matched", detail: "5 years aligns with the 4–6 year requirement." }, educationMatch: { score: 90, status: "Meets requirement", detail: "B.S. Computer Science meets the listed requirement." }, seniorityMatch: { score: 78, status: "Well-matched", detail: "Senior experience aligns with the role seniority." }, applicationReadiness: "Almost Ready", topRecommendations: ["Add Docker and Kubernetes to close the main skill gap", "Mirror the job description language around 'distributed systems'", "Quantify the scale of your AWS usage with metrics"], coverLetterTip: "Mention your 40% latency reduction — it maps directly to their performance engineering requirements." });
  }

  // ── LinkedIn Intelligence -- Free content generation ───────────────────────
  // Schema matches buildFreeContentPrompt (Phase 3): no invented scores or
  // keyword lists -- those are deterministic (deterministicScoring.js) now.
  if (p.includes("linkedin profile expert") || (p.includes("linkedin") && p.includes("headline") && p.includes("aboutsection"))) {
    return JSON.stringify({ headline: "Senior Software Engineer | Python · AWS · React | Building Scalable Systems That Perform", aboutSection: "I'm a software engineer with 5+ years building high-performance distributed systems. I specialize in Python, AWS, and React — with a track record of shipping products used by tens of thousands of users and driving a 40% reduction in API latency.\n\nI'm passionate about clean architecture, developer experience, and working on teams that care about engineering quality. Currently exploring Senior and Staff Engineer opportunities where I can drive technical strategy alongside great people.", experienceOptimizations: [{ company: "Acme Corp", title: "Senior Software Engineer", optimizedBullets: ["Architected microservices platform handling 2M+ daily requests using Python and AWS Lambda, reducing infrastructure costs by 35%", "Drove 40% API latency reduction through Redis caching strategy and query optimization", "Led cross-functional team of 5 engineers delivering real-time data pipeline 2 weeks ahead of schedule"] }, { company: "Tech Startup", title: "Software Engineer", optimizedBullets: ["Built React/TypeScript frontend serving 50K+ monthly active users, improving Core Web Vitals by 28%", "Established CI/CD pipeline with Docker and Jenkins, reducing deployment time from 45 to 8 minutes", "Integrated Stripe and Twilio APIs processing $2M+ in annual transactions"] }], recruiterVisibilityTips: ["Set your profile to 'Open to Work' with specific role titles to appear in recruiter searches", "Post one technical insight per week — LinkedIn algorithm boosts profiles with consistent engagement", "Request recommendations from managers who can speak to your leadership and technical impact"] });
  }

  // ── LinkedIn Intelligence -- Premium (Strategy + Recruiter Visibility) ─────
  if (p.includes("linkedin intelligence analyst") && p.includes("profile strategy")) {
    return JSON.stringify({ v: 1, analyses: {
      strategyAnalysis: { priorityActions: ["Add measurable bullets to your most recent role", "Close the Terraform/Kubernetes keyword gap for Senior Engineer roles"], reasoning: "Your experience section is the largest gap relative to your target role, and closing it improves both recruiter search visibility and reviewer confidence." },
      recruiterVisibilityIntelligence: { guidance: ["Set your headline to include your target title verbatim", "Post one technical insight per week to boost search ranking"], searchabilityNote: "Your current keyword coverage puts you in the middle of the pack for recruiter searches on your target role." },
    } });
  }

  // ── LinkedIn Intelligence -- Profile Evolution Tracking ────────────────────
  if (p.includes("linkedin intelligence analyst") && p.includes("explain a change")) {
    return JSON.stringify({ v: 1, evolution: { narrative: "Your profile completeness and keyword coverage both improved since your last analysis, most likely from the resume update you made in between.", focusNext: "Add the remaining missing keywords to keep closing the gap for your target role." } });
  }

  // ── Cover Letter Versions ──────────────────────────────────────────────────
  if (p.includes("cover letter writer") || p.includes("4 distinct cover letter")) {
    return JSON.stringify({ professional: "Dear Hiring Manager,\n\nI am writing to express my strong interest in the Senior Software Engineer position. With over five years building scalable, high-performance distributed systems, I am confident my background aligns closely with your requirements.\n\nAt Acme Corp I architected microservices handling 2M+ daily requests, drove a 40% API latency reduction, and led a team of 5 engineers to deliver a data pipeline ahead of schedule. My expertise spans Python, React, AWS, and SQL.\n\nI would welcome the opportunity to discuss how I can contribute to your engineering team.\n\nRespectfully,\nJohn Smith", friendly: "Hi there!\n\nI spotted the Senior Software Engineer opening and honestly, it reads like it was written with my background in mind — so I had to apply.\n\nI've spent 5 years building things I'm proud of: microservices handling millions of daily requests, a caching strategy that cut API latency by 40%, and a CI/CD pipeline that went from 45-minute deploys to 8 minutes. I love hard technical problems with people who care about quality.\n\nI'd love to chat and learn more about what you're building!\n\nThanks,\nJohn", executive: "Dear Search Committee,\n\nAs a senior software engineering leader with a history of driving technical excellence and organizational impact, I am compelled by the opportunity to bring my expertise to your organization.\n\nAt Acme Corp I designed a microservices platform scaling to 2M+ daily requests while reducing infrastructure costs by 35%, and built and mentored a team of five engineers establishing practices that outlasted any single project.\n\nI am seeking an environment where engineering decisions have real business impact. I look forward to discussing how I can accelerate your team's trajectory.\n\nSincerely,\nJohn Smith", ats: "SENIOR SOFTWARE ENGINEER APPLICATION\n\nDear Hiring Manager,\n\nI am applying for the Senior Software Engineer position. I bring 5+ years of expertise in Python, AWS, React, Node.js, SQL, and microservices architecture — skills that align directly with your stated requirements.\n\nKey qualifications:\n• Python backend: 5+ years production APIs and microservices\n• AWS: Lambda, S3, EC2, RDS deployment and optimization\n• React/TypeScript frontend: 50K+ user application\n• Team leadership: 5-engineer cross-functional team, Agile/Scrum\n• Performance: 40% API latency reduction\n\nThank you,\nJohn Smith" });
  }

  // ── Deep Resume Insights ───────────────────────────────────────────────────
  if (p.includes("grammarscore") || p.includes("weakbullets") || (p.includes("deep analysis") && p.includes("resume quality"))) {
    return JSON.stringify({ grammarScore: 84, readabilityScore: 79, formattingScore: 88, keywordDensity: 72, actionVerbScore: 76, overallQualityScore: 80, issues: [{ category: "Action Verbs", problem: "Passive phrase 'responsible for managing'", reason: "Passive language reduces impact and ATS keyword density", fix: "Replace 'responsible for managing' with 'Managed' or 'Directed'", severity: "medium" }, { category: "ATS", problem: "Skills section missing Docker and Kubernetes", reason: "These keywords appear in 80%+ of Senior Engineer job descriptions", fix: "Add 'Docker, Kubernetes' to your skills section", severity: "high" }, { category: "Structure", problem: "Professional summary section missing", reason: "Top 30% of candidates include a 3–4 line summary — it's the first thing recruiters read", fix: "Add a professional summary: 2 sentences on role + 1 on your strongest achievement", severity: "high" }, { category: "Formatting", problem: "Inconsistent date format across roles", reason: "ATS systems may misparse inconsistent date formats", fix: "Use consistent format throughout: '2020–Present' or 'Jan 2020 – Present'", severity: "low" }], weakBullets: [{ original: "Led team of 5 engineers", improved: "Led cross-functional team of 5 engineers to deliver real-time data pipeline 2 weeks ahead of schedule" }, { original: "Built scalable microservices", improved: "Architected microservices platform processing 2M+ daily requests with 99.9% uptime" }], weakActionVerbs: [{ original: "Helped", stronger: "Spearheaded" }, { original: "Worked on", stronger: "Delivered" }, { original: "Did", stronger: "Executed" }], missingSections: ["Professional Summary"], resumeLengthStatus: "Optimal", contactInfoStatus: "Complete", sectionOrderIssue: null });
  }

  // ── Issue Fix (single fix — returns plain text resume) ────────────────────
  if (p.includes("apply exactly this fix")) {
    const r = _devExtractResume(prompt);
    return r ? r.replace(/responsible for/gi, "managed").replace(/\bhelped\b/gi, "spearheaded") : _devMockResume();
  }

  // ── Apply All Fixes (batch — returns plain text resume) ───────────────────
  if (p.includes("apply all of the following improvements")) {
    const r = _devExtractResume(prompt);
    return (r || _devMockResume()).replace(/responsible for/gi, "managed").replace(/\bhelped\b/gi, "spearheaded");
  }

  // ── Keyword Improve (returns plain text resume, no JSON) ──────────────────
  if (p.includes("keywords to incorporate") && p.includes("current resume")) {
    const r = _devExtractResume(prompt);
    return (r || _devMockResume()) + "\n• Containerized services using Docker and Kubernetes, improving deployment reliability by 60%\n• Implemented CI/CD pipelines reducing time-to-production by 75%\n• Leveraged TypeScript for type-safe frontend development across React applications";
  }

  // ── Smart Apply Full Package ───────────────────────────────────────────────
  if (p.includes("application package") || (p.includes("tailoredresume") && p.includes("recruitermessage"))) {
    return JSON.stringify({ tailoredResume: _devMockResume(), coverLetter: "Dear Hiring Manager,\n\nI am excited to apply for this position. My background in Python, AWS, and scalable system design aligns directly with your requirements.\n\nAt Acme Corp I drove a 40% reduction in API latency and led a team of 5 engineers delivering critical data pipelines ahead of schedule. I would welcome the opportunity to discuss how I can contribute.\n\nBest regards,\nJohn Smith", recruiterMessage: "Hi [Name], I came across this role and was immediately drawn to the distributed systems work your team is doing. I have 5 years of Python/AWS experience and a track record of 40% latency improvements. Would you be open to a quick chat?", networkingMessage: "Hi [Name], I saw you work at [company] — I've been following the engineering blog and am very interested in the team's infrastructure work. Would love to connect if you have 15 minutes!", missingSkills: ["Docker", "Kubernetes", "Terraform"], interviewProbability: 68, hiringProbability: 42, applicationQuestions: ["Describe your experience with distributed systems at scale.", "How do you approach debugging a production incident with no runbook?", "Tell me about a time you led a technical project from design to deployment."], salaryInsight: { marketRange: { low: 140000, median: 165000, high: 195000 }, userPositioning: "Your experience level positions you in the 55th–70th percentile of the market range.", negotiationLeverage: "Your measurable 40% latency reduction is strong negotiation leverage — it demonstrates direct business impact.", benchmarks: ["Staff Engineer at similar-stage companies: $170K–$200K total comp"] }, companyInsight: { culture: "Engineering-driven culture with strong emphasis on technical excellence and ownership.", recentNews: "Recently announced Series C of $150M — actively expanding engineering headcount across platform teams.", hiringTrend: "growing", redFlags: ["High interview bar may result in extended hiring timeline"], greenFlags: ["Strong eng culture with open-source contributions", "Competitive equity refreshes"], talkingPoints: ["Their caching architecture work aligns directly with your Redis optimization experience"] } });
  }

  // ── Match Score Only (lightweight call in job search) ─────────────────────
  if (p.includes("match score only")) {
    return JSON.stringify({ matchScore: 74, explanation: "Strong Python/AWS match; missing container orchestration skills." });
  }

  // ── Interview AI Performance Summary ──────────────────────────────────────
  if (p.includes("interview performance summary") || (p.includes("interview coach") && p.includes("per-question performance"))) {
    return JSON.stringify({ technicalPerformance: "Strong", behavioralPerformance: "Excellent", communication: "Good", confidence: "Strong", biggestStrength: "Clear structure and quantifiable outcomes make your answers compelling and memorable.", biggestImprovement: "Work on being more concise — trim setup details to reach the action and result faster." });
  }

  // ── Interview Questions ────────────────────────────────────────────────────
  if ((p.includes("interview questions") || p.includes("interview coach")) && p.includes("behavioral")) {
    return JSON.stringify([{ question: "Tell me about a time you led a complex technical project from design to delivery.", category: "Behavioral", difficulty: "Medium", tipToAnswer: "Use the STAR method: Situation (project scope and stakes), Task (your role), Action (key decisions you made and why), Result (measurable outcome — timeline, performance, business value).", starGuidance: { situation: "Describe the project context and why it was complex", task: "Explain your specific responsibilities", action: "Walk through 2–3 key decisions and the reasoning behind each", result: "Quantify the outcome: timeline, performance, team impact, business value" } }, { question: "How do you approach debugging a production incident with no runbook and customers impacted?", category: "Technical", difficulty: "Hard", tipToAnswer: "Walk through your mental model: triage by impact, isolate the failure domain, form hypotheses, test carefully. Show you can stay calm, communicate status, and learn from post-mortems.", starGuidance: null }, { question: "Describe a system you designed that needed to scale significantly. What tradeoffs did you navigate?", category: "Technical", difficulty: "Hard", tipToAnswer: "Pick a concrete example. Name the scale target, bottlenecks identified, architectural options considered, and what you chose — and why. Acknowledge tradeoffs honestly.", starGuidance: null }, { question: "Tell me about a time you disagreed with a technical decision your team made. How did you handle it?", category: "Behavioral", difficulty: "Medium", tipToAnswer: "Use STAR. Show you can advocate constructively with data and reasoning, not just opinion.", starGuidance: { situation: "Describe the decision and its context", task: "Explain your concern and why it mattered", action: "Describe how you raised it — data, framing, the conversation", result: "Outcome and what you learned about technical advocacy" } }, { question: "How do you prioritize technical debt against product feature delivery?", category: "Situational", difficulty: "Medium", tipToAnswer: "Show you think in tradeoffs, not absolutes. Name a framework (risk-based, velocity-based). Give an example.", starGuidance: null }, { question: "Tell me about your experience with cloud infrastructure and cost optimization.", category: "Technical", difficulty: "Easy", tipToAnswer: "Be specific: which services, at what scale, and what you optimized. Quantify savings if possible.", starGuidance: null }, { question: "How do you ensure code quality across a team with varying experience levels?", category: "Culture Fit", difficulty: "Medium", tipToAnswer: "Talk about systems, not just standards: code review culture, pair programming, automated testing, documentation. Show you think about enablement, not enforcement.", starGuidance: null }, { question: "Where do you see your engineering career in 3–5 years?", category: "Culture Fit", difficulty: "Easy", tipToAnswer: "Be genuine but frame it around growth in the domain they care about. Show ambition balanced with commitment to this role.", starGuidance: null }]);
  }

  // ── Interview Answer Rating ────────────────────────────────────────────────
  if (p.includes("rate this practice answer") || (p.includes("interview coach") && p.includes("score"))) {
    return JSON.stringify({ score: 7.8, strengths: ["Clear structure with specific details", "Good use of quantifiable outcome", "Confident delivery without hedging"], improvements: ["Could be 15% more concise — trim the setup to get to the action faster", "Add the business impact beyond the technical result"], revisedAnswer: "At Acme Corp I inherited a system with 800ms API latency causing cart abandonment. I analyzed query patterns, identified N+1 database calls, and implemented Redis caching for the hot path. Latency dropped 40% to 480ms, cart completion improved 12%, and database load fell 30% — saving $1,800/month in RDS costs.", scoreExplanation: "The answer demonstrated clear structure and quantifiable outcomes, though more concise delivery and explicit business impact would push this score higher." });
  }

  // ── Salary Research ────────────────────────────────────────────────────────
  if (p.includes("salary") && (p.includes("2026 salary") || p.includes("marketrange") || p.includes("salary data"))) {
    return JSON.stringify({ jobTitle: "Senior Software Engineer", location: "San Francisco, CA", experience: "5 years", marketRange: { low: 140000, median: 168000, high: 215000 }, totalCompRange: { low: 180000, median: 235000, high: 310000 }, equityRange: { low: 50000, median: 85000, high: 160000 }, percentiles: { p25: 148000, p50: 168000, p75: 195000, p90: 218000 }, trend: "+6.2% YoY", trendDirection: "up", demandLevel: "High", topPayingCompanies: ["Google", "Meta", "Stripe", "Airbnb", "OpenAI"], skills: ["Go", "Rust", "Kubernetes", "ML/AI", "Platform Engineering"], negotiationTips: ["Anchor at the 75th percentile ($195K base) — your measurable achievements support it", "Frame your 40% latency reduction as direct revenue impact, not just a technical win", "Ask about RSU vesting schedule and refresh cadence — total comp often varies 30–50%"], locationComparison: [{ city: "San Francisco, CA", median: 168000, costAdjusted: 104000 }, { city: "New York, NY", median: 158000, costAdjusted: 108000 }, { city: "Seattle, WA", median: 162000, costAdjusted: 128000 }, { city: "Austin, TX", median: 142000, costAdjusted: 130000 }] });
  }

  // ── Networking Follow-up Message (plain text) ──────────────────────────────
  if (p.includes("follow-up message") || p.includes("write a professional follow-up")) {
    return "Subject: Quick follow-up — Senior Software Engineer Application\n\nHi [Name],\n\nI wanted to follow up on my application for the Senior Software Engineer role I submitted last week. I remain very enthusiastic about the opportunity and would love to learn more about the team's work.\n\nPlease let me know if there's any additional information I can provide.\n\nBest regards,\nJohn Smith";
  }

  // ── Networking Outreach ────────────────────────────────────────────────────
  if (p.includes("networking outreach") || (p.includes("linkedin") && p.includes("networkin"))) {
    return JSON.stringify({ linkedinMessage: "Hi [Name], I've been following [Company]'s engineering blog and was really impressed by the distributed systems work your team published. I'm a Senior Software Engineer with 5 years of Python/AWS experience exploring new opportunities, and [Company] is at the top of my list. Would you be open to a 15-minute chat?", emailSubject: "Software Engineer curious about the [Team] team at [Company]", emailBody: "Hi [Name],\n\nMy name is John Smith and I'm a Senior Software Engineer with 5 years of experience building scalable backend systems at Acme Corp.\n\nI came across your profile while researching [Company]'s engineering team and would love to learn more about the distributed systems and infrastructure challenges your team is solving.\n\nIf you have 15 minutes for a quick chat I'd really appreciate it.\n\nThanks,\nJohn Smith", followUpMessage: "Hi [Name], just wanted to resurface my message from last week! Totally understand if now isn't a good time — but if you ever have 10 minutes to chat about [Company]'s engineering team, I'd love to connect. No pressure!", tips: ["Personalize the opening with a specific observation about their work or company", "Keep the ask small — '15-minute chat' is less intimidating than 'informational interview'", "Mention a mutual connection or shared interest if one exists", "Follow up once after 7 days — most people just forget, they're not saying no"] });
  }

  // ── Opportunity Intelligence ───────────────────────────────────────────────
  if (p.includes("career intelligence advisor") && p.includes("careerpivotopportunities")) {
    return JSON.stringify({
      careerPivotOpportunities: [
        { role: "Engineering Manager", fit: 82, reason: "Your track record leading a 5-engineer team and delivering high-impact projects positions you for people management.", skillsNeeded: ["Roadmap planning", "Performance reviews", "Headcount budgeting"], salaryUplift: "+18%" },
        { role: "Staff Engineer", fit: 78, reason: "Your system design experience and measurable impact at scale qualify you for Staff-level technical scope.", skillsNeeded: ["Cross-team architecture docs", "Technical strategy", "Mentoring program design"], salaryUplift: "+25%" },
        { role: "Platform Engineer / SRE", fit: 71, reason: "Your AWS, Docker, and reliability work translates directly into platform and infrastructure roles.", skillsNeeded: ["Terraform", "Incident runbooks", "SLO/SLI definition"], salaryUplift: "+12%" },
      ],
      trendingSkills: [
        { skill: "AI/LLM Integration", demand: "Exploding", frequency: 78, salaryPremium: "+22%" },
        { skill: "Kubernetes", demand: "High", frequency: 65, salaryPremium: "+15%" },
        { skill: "TypeScript", demand: "High", frequency: 61, salaryPremium: "+9%" },
        { skill: "System Design", demand: "High", frequency: 58, salaryPremium: "+18%" },
        { skill: "Terraform / IaC", demand: "Growing", frequency: 47, salaryPremium: "+14%" },
        { skill: "GraphQL", demand: "Growing", frequency: 44, salaryPremium: "+8%" },
      ],
      emergingIndustries: [
        { industry: "AI/LLM Tooling & Infrastructure", growth: "+340% YoY", roles: ["LLM Engineer", "ML Platform Engineer", "AI Product Engineer"], avgSalary: "$185K" },
        { industry: "Climate Tech & Clean Energy", growth: "+89% YoY", roles: ["Backend Engineer", "Platform Engineer", "Data Engineer"], avgSalary: "$162K" },
        { industry: "FinTech Infrastructure", growth: "+67% YoY", roles: ["Senior Backend Engineer", "Security Engineer", "Platform Lead"], avgSalary: "$175K" },
      ],
      growingCompanies: [
        { company: "Anthropic", signal: "Tripling engineering headcount through 2026 across infrastructure and product teams.", category: "AI", openRoles: 34, yourMatch: 74 },
        { company: "Stripe", signal: "Expanding backend and platform engineering for their global payments infrastructure.", category: "FinTech", openRoles: 18, yourMatch: 81 },
        { company: "Figma", signal: "Post-acquisition rebuild phase with active senior engineering hiring.", category: "Design Tools", openRoles: 9, yourMatch: 68 },
        { company: "Linear", signal: "Scaling product engineering team significantly after Series C close.", category: "Dev Tools", openRoles: 6, yourMatch: 72 },
      ],
      internalPromotionSignals: [
        "Staff Engineer promotion typically requires ownership of a system used by 3+ teams — document your architecture impact with user and reliability metrics.",
        "Your 40% latency reduction is promotion-level evidence — quantify the business impact (revenue, cost savings, user retention) to make the case concrete.",
        "Build visibility across teams: present your work in all-hands, write internal design docs that get referenced by other engineers.",
        "Ask your manager for a gap analysis against the Staff Engineer level rubric before your next review cycle starts.",
      ],
    });
  }

  // ── Job Intelligence Landscape Analysis ───────────────────────────────────
  if (p.includes("analysis 1: market patterns") && p.includes("analysis 5: search performance")) {
    return JSON.stringify({ v: 1, generatedAt: new Date().toISOString(), marketPatterns: { status: "Strong", summary: "Your job search is concentrated in the mid-to-senior software engineering space, with a clear preference for product-driven tech companies over enterprise environments. The remote-first skew in your saved jobs aligns with a shift toward distributed team culture in your target market.", evidence: ["78% of saved jobs are at Series A–C companies, signaling a preference for high-growth environments", "Senior Engineer roles dominate at 65%, with a visible secondary cluster of Staff/Lead roles at 20%", "Remote or hybrid roles account for 82% of your saved landscape"], trends: "Hiring activity in your target sectors remains strong, with a noticeable uptick in full-stack and platform-adjacent roles over the past 30 days." }, employerDemand: { status: "Consistent", summary: "Employers in your search landscape are consistently requesting cloud-native engineering skills alongside product intuition. Python and React appear in the majority of roles, but infrastructure and observability tooling is increasingly expected at the senior level.", topSkills: ["Python", "AWS / Cloud", "React / TypeScript", "System Design", "Docker / Kubernetes"], qualifications: ["4–7 years of backend or full-stack engineering experience", "Experience shipping production systems at meaningful scale"], insight: "Container orchestration and CI/CD appear in 72% of your saved job descriptions — closing this gap would meaningfully broaden your competitive reach." }, marketFit: { status: "Good", narrative: "Your profile aligns well with the core requirements of your target market. Your Python and AWS depth positions you competitively for most senior backend roles in your saved landscape. The gap between your current profile and your target roles is narrow — primarily around infrastructure tooling and system design documentation, not core engineering competency. You are not disadvantaged in this market; you are one or two deliberate additions away from being a strong fit for the top quartile of your saved roles.", strengths: ["Strong Python/AWS foundation matching 70%+ of employer requirements", "Demonstrated impact at scale — measurable achievements that stand out in competitive pools"], gaps: ["Container orchestration (Docker, Kubernetes) expected but not visible in profile", "System design and architecture leadership experience less prominent than top candidates"], positioning: "You are positioned in the 60th–70th percentile of candidates for your target roles; targeted resume optimization could move you to the 80th percentile." }, searchStrategy: { status: "Focused", summary: "Your search is well-targeted by role level and technology stack, but geographic distribution is narrow. The concentration in San Francisco and New York limits your available opportunity set when remote roles would broaden this significantly.", alignment: "Your saved jobs align closely with your stated target role and experience level — the strategy is directionally correct.", recommendation: "Expand your saved job pool to include more remote-first companies to unlock a larger opportunity set without changing your role targeting." }, searchPerformance: { status: "Improving", summary: "Your response rate has improved as your applications have become more targeted. The shift from broad volume applications to selective, tailored ones is producing better outcomes. Early-stage applications to smaller companies are converting at a higher rate than large enterprise applications.", patterns: ["Tailored applications to Series B companies show 2× the response rate of volume applications", "Response times are shorter at companies where you have a mutual connection or warm referral"], insight: "Your data shows that quality over quantity is working — maintaining selective, tailored applications rather than increasing volume will continue to improve outcomes." } });
  }

  // ── Job Change Analysis ───────────────────────────────────────────────────
  if (p.includes("compare these two job descriptions")) {
    return JSON.stringify({ summary: "The employer raised the experience bar and added cloud-native tooling requirements.", newSkills: ["TypeScript", "AWS Lambda"], removedSkills: ["jQuery"], responsibilitiesChanged: "Team leadership added — the role now requires mentoring junior engineers.", experienceChanged: "Minimum experience increased from 3 to 5 years.", educationChanged: null, toolsChanged: ["Docker", "Kubernetes"], workAuthorizationChanged: null, otherChanges: [] });
  }

  // ── Job Tracker Change Interpretation ─────────────────────────────────────
  if (p.includes("just changed. facts already computed")) {
    return "The salary increase brings this role closer to your target, worth a second look.";
  }

  // ── Application Outcome Intelligence ───────────────────────────────────────
  // The real prompt only includes an "=== ANALYSIS N: ..." block for sections whose
  // data requirement is actually met (see computeAnalysisAvailability) -- mirror that
  // here by only returning keys for markers actually present in the prompt, so DEV_MODE
  // testing exercises the same "fewer than 6 keys" shape production will produce.
  if (p.includes("application outcome intelligence analyst")) {
    const tierMatch = p.match(/confidence tier for this run is "(\w+)"/);
    const tier = tierMatch ? tierMatch[1] : "early_signal";
    const ALL_ANALYSES = {
      responsePattern: { marker: "analysis 1: response pattern analysis", data: { finding: "Applications to mid-size companies are responding at a notably higher rate than applications to enterprise companies in your history.", evidence: "Based on your logged outcomes so far." } },
      funnelStage: { marker: "analysis 2: funnel stage intelligence", data: { finding: "Most of your rejections are happening early in the process rather than after an interview, which usually points to a resume or keyword-matching gap rather than an interview-skills gap.", evidence: "Based on logged rejection stages." } },
      companyProfileFit: { marker: "analysis 3: company profile fit", data: { finding: "Mid-size, remote-friendly companies show your strongest response signal so far.", evidence: "Based on company size and remote policy patterns." } },
      applicationQuality: { marker: "analysis 4: application quality correlation", data: { finding: "Applications sent with a cover letter are trending toward a better response rate than those without one.", evidence: "Based on cover-letter-sent patterns." } },
      resumeVersion: { marker: "analysis 5: resume version effectiveness", data: { finding: "Resume version 2 is outperforming version 1 in your logged outcomes so far.", evidence: "Based on resume-version-linked outcome data." } },
      strategicPrediction: {
        marker: "analysis 6: strategic prediction engine",
        data: {
          targeting: "Consider prioritizing mid-size and remote-friendly companies for your next batch of applications.",
          approachChanges: "Sending a tailored cover letter appears to correlate with better outcomes for you — worth doing consistently.",
          resumeSignals: "No single resume change stands out yet from the current data.",
          opportunityCost: "A few saved jobs and prepared Smart Apply packages haven't been submitted yet — following up on those is low-effort upside.",
        },
      },
    };
    const analyses = {};
    for (const [key, cfg] of Object.entries(ALL_ANALYSES)) {
      if (p.includes(cfg.marker)) analyses[key] = cfg.data;
    }
    return JSON.stringify({
      v: 1, confidenceTier: tier, analyses,
      topInsights: [
        { text: "Mid-size companies are your strongest-responding segment so far.", evidence: "Early signal based on your logged outcomes." },
        { text: "Cover letters appear to correlate with better response rates.", evidence: "Early signal — keep tracking to confirm." },
      ],
      whatWorking: ["Mid-size, remote-friendly companies are responding well to your applications."],
      whatToChange: ["Send a tailored cover letter with every application where possible."],
    });
  }

  // ── Referral Intelligence ───────────────────────────────────────────────────
  // Same availability-aware shape as the Outcome Intelligence mock above: only
  // return a key if its marker is actually present in the prompt, mirroring exactly
  // what the real prompt would have asked for.
  if (p.includes("referral intelligence analyst")) {
    const ALL_SECTIONS = {
      topOpportunities: { marker: "analysis 1: top referral opportunities", data: { finding: "Your strongest referral opportunity right now is at the company where you have a warm, recently-engaged contact and an active target signal.", evidence: "Based on your computed company readiness scores." } },
      outreachTiming: { marker: "analysis 2: outreach timing guidance", data: { finding: "Reach out to your warmest contacts within the next few days while the relationship is still fresh — waiting too long lets engagement cool off.", evidence: "Based on your logged relationship scores." } },
      relationshipBuilding: { marker: "analysis 3: relationship building guidance", data: { finding: "For target companies where you don't have a contact yet, start with a low-pressure coffee-chat request rather than asking for a referral outright.", evidence: "Based on your target companies with no contact yet." } },
    };
    const analyses = {};
    for (const [key, cfg] of Object.entries(ALL_SECTIONS)) {
      if (p.includes(cfg.marker)) analyses[key] = cfg.data;
    }
    return JSON.stringify({ v: 1, analyses });
  }

  // ── Fallback ───────────────────────────────────────────────────────────────
  return "{}";
}

function _devMockResume() {
  return `John Smith
Senior Software Engineer | San Francisco, CA
john.smith@email.com | (415) 234-5678 | linkedin.com/in/johnsmith

PROFESSIONAL SUMMARY
Results-driven Senior Software Engineer with 5+ years architecting scalable, high-performance distributed systems. Proven track record of reducing infrastructure costs by 35% and driving 40% API latency improvements. Expertise in Python, AWS, and React with strong leadership experience managing cross-functional engineering teams.

EXPERIENCE

Senior Software Engineer — Acme Corp (2020–Present)
• Architected microservices platform handling 2M+ daily requests using Python and AWS Lambda, reducing costs by 35%
• Drove 40% API latency reduction through Redis caching strategy and systematic query optimization
• Led cross-functional team of 5 engineers delivering real-time data pipeline 2 weeks ahead of schedule
• Containerized services using Docker and Kubernetes, improving deployment reliability by 60%

Software Engineer — Tech Startup (2018–2020)
• Built React/TypeScript frontend serving 50K+ monthly active users, improving Core Web Vitals by 28%
• Established CI/CD pipeline with Docker and Jenkins, reducing deployment time from 45 minutes to 8 minutes
• Integrated Stripe and Twilio APIs processing $2M+ in annual transactions with 99.9% uptime

SKILLS
Python, JavaScript, TypeScript, React, Node.js, AWS (Lambda, S3, EC2, RDS), Docker, Kubernetes, PostgreSQL, Redis, SQL, Git, CI/CD, Agile/Scrum

EDUCATION
B.S. Computer Science — UC Berkeley (2018) | GPA: 3.7`;
}

function _devExtractResume(prompt) {
  for (const marker of ["CURRENT RESUME:\n", "RESUME:\n", "RESUME:"]) {
    const idx = prompt.indexOf(marker);
    if (idx !== -1) {
      const text = prompt.slice(idx + marker.length).trim();
      if (text.length > 50) return text.slice(0, 3000);
    }
  }
  return null;
}

// ─── Resume Document Engine ───────────────────────────────────────────────────
// One shared parser drives PDF, DOCX, Print, Preview, and Copy so every output
// is always consistent with what the user sees in the Resume Preview.
// parseResumeDoc/RESUME_SECTION_NAMES relocated to src/lib/resumeParsing.js
// (LinkedIn Intelligence Phase 1) so it can be imported by the new deterministic
// scoring module without a circular import back into App.jsx -- see that
// file's header comment for why.

// Extracts a year-range date from the end of a role header line for right-aligned rendering.
// Matches: "(2020–Present)", "Jan 2020 – Present", "2018–2020", "(Mar 2019 – Dec 2021)"
function extractRoleDate(text) {
  // Try date range first (e.g. "Jan 2022 – Present", "2016 – 2019")
  const m = text.match(/\s*[\(\[]?\s*(?:[A-Za-z]{3,9}\.?\s*)?\d{4}\s*[-–—]+\s*(?:Present|Current|(?:[A-Za-z]{3,9}\.?\s*)?\d{4})\s*[\)\]]?\s*$/i);
  if (m) {
    const date = m[0].trim().replace(/^[\(\[]+|[\)\]]+$/g, '').trim();
    const left = text.slice(0, text.length - m[0].length).replace(/[\s,|–—-]+$/, '').trim();
    return { left, date };
  }
  // Fallback: single year or month+year after a pipe/comma separator (e.g. "| 2016", "| May 2018")
  const m2 = text.match(/\s*[|,]\s*(?:[A-Za-z]{3,9}\.?\s*)?\d{4}\s*$/i);
  if (m2) {
    const date = m2[0].replace(/^\s*[|,]\s*/, '').trim();
    const left = text.slice(0, text.length - m2[0].length).replace(/[\s,|–—-]+$/, '').trim();
    return { left, date };
  }
  return { left: text, date: null };
}

// Resume Engine theme — single source of truth for all five outputs (Preview, PDF, DOCX,
// Print, Copy). Future theme engine replaces these values; the engine/renderer stay identical.
const RE = {
  accent:    '#6B21E8',
  accentBg:  '#F3EEFF',
  name:      '#6B21E8',
  role:      '#2d2d2d',
  body:      '#374151',
  date:      '#4B5563',
  separator: '#DDD6FE',
};

// Splits "Job Title — Company Name" or "Job Title at Company" into { role, company }.
// The left side of extractRoleDate output is passed here. Falls back gracefully if no
// recognizable separator is found.
function splitRoleAndCompany(text) {
  const seps = [' — ', ' – ', ' - ', ' | '];
  for (const sep of seps) {
    const idx = text.indexOf(sep);
    if (idx > 3) {
      return { role: text.slice(0, idx).trim(), company: text.slice(idx + sep.length).trim() };
    }
  }
  // " at " — only split when what follows starts with an uppercase letter (a proper noun/company)
  const atIdx = text.indexOf(' at ');
  if (atIdx > 3) {
    const after = text.slice(atIdx + 4).trim();
    if (after.length > 0 && after[0] === after[0].toUpperCase() && /[A-Z]/.test(after[0])) {
      return { role: text.slice(0, atIdx).trim(), company: after };
    }
  }
  return { role: text, company: null };
}

function resumeDocToHTML(parsed, forCopy = false) {
  const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  if (forCopy) {
    const lines = [];
    if (parsed.name) { lines.push(parsed.name, ''); }
    parsed.headerLines.forEach(h => lines.push(h.text));
    if (parsed.headerLines.length) lines.push('');
    parsed.sections.forEach(sec => {
      lines.push(sec.title);
      lines.push('─'.repeat(40));
      sec.items.forEach(item => {
        if (item.type === 'gap')    { lines.push(''); return; }
        if (item.type === 'bullet') { lines.push(`  • ${item.text}`); return; }
        if (item.type === 'roleHeader') {
          const { left, date } = extractRoleDate(item.text);
          const { role, company } = splitRoleAndCompany(left);
          lines.push(date ? `${role}  |  ${date}` : role);
          if (company) lines.push(company);
          return;
        }
        lines.push(item.text);
      });
      lines.push('');
    });
    return lines.join('\n').trim();
  }

  // HTML output used by Print window — mirrors Preview visual design exactly
  let html = '';
  if (parsed.name || parsed.headerLines.length) {
    html += '<div class="rhdr">';
    if (parsed.name) html += `<div class="rn">${esc(parsed.name)}</div>`;
    parsed.headerLines.forEach(h => {
      if (h.type === 'contact') {
        const parts = h.text.split(/\s*[|·•]\s*/).filter(Boolean);
        if (parts.length > 1) {
          html += `<div class="rh">${parts.map((p, i) => i === 0 ? esc(p.trim()) : `<span class="rhsep">|</span>${esc(p.trim())}`).join('')}</div>`;
        } else {
          html += `<div class="rh">${esc(h.text)}</div>`;
        }
      } else {
        html += `<div class="rhtitle">${esc(h.text)}</div>`;
      }
    });
    html += '</div>';
  }
  parsed.sections.forEach(sec => {
    html += `<section><div class="rshdr"><span class="rslabel">${esc(sec.title)}</span></div>`;
    sec.items.forEach(item => {
      if (item.type === 'gap')    { html += '<div class="rg"></div>'; return; }
      if (item.type === 'bullet') { html += `<div class="rb"><span class="rdot">•</span><span>${esc(item.text)}</span></div>`; return; }
      if (item.type === 'roleHeader') {
        const { left, date } = extractRoleDate(item.text);
        const { role, company } = splitRoleAndCompany(left);
        html += `<div class="rr"><span class="rtitle">${esc(role)}</span>${date ? `<span class="rd8">${esc(date)}</span>` : ''}</div>`;
        if (company) html += `<div class="rco">${esc(company)}</div>`;
        return;
      }
      html += `<div class="rx">${esc(item.text)}</div>`;
    });
    html += '</section>';
  });
  return html;
}

const RESUME_PRINT_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:Calibri,'Helvetica Neue',Arial,sans-serif;font-size:10.5pt;color:#111;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;line-height:1.45}
.pg{padding:15mm 22mm;max-width:216mm;margin:0 auto}
.rhdr{background:#F3EEFF;border-radius:8pt;padding:14pt 18pt;text-align:center;margin-bottom:14pt}
.rn{font-size:20pt;font-weight:800;color:#000;margin-bottom:4pt;letter-spacing:-.02em}
.rhtitle{font-size:11pt;font-weight:600;color:#111;line-height:1.5;margin-bottom:2pt}
.rh{font-size:9.5pt;color:#444;line-height:1.5}
.rhsep{color:#6B21E8;margin:0 4pt}
section{margin-bottom:0}
.rslabel{display:inline-block;background:#F3EEFF;border-radius:5pt;padding:3pt 10pt;font-size:8.5pt;font-weight:800;text-transform:uppercase;letter-spacing:.07em;color:#6B21E8}
.rshdr{margin-top:12pt;margin-bottom:6pt}
.rr{display:flex;justify-content:space-between;align-items:baseline;margin-top:5pt;margin-bottom:1pt}
.rtitle{font-size:10.5pt;font-weight:700;color:#000}
.rd8{font-size:9.5pt;color:#4B5563;white-space:nowrap;padding-left:8pt}
.rco{font-size:10pt;color:#6B21E8;font-style:italic;margin-bottom:3pt}
.rx{font-size:10pt;color:#111;margin-bottom:1.5pt;line-height:1.45}
.rb{font-size:10pt;color:#111;display:flex;gap:5pt;margin-bottom:2pt;padding-left:2pt;line-height:1.45}
.rdot{flex-shrink:0;color:#6B21E8;margin-top:.05em;font-size:11pt}
.rg{height:0;border-top:.75pt dashed #DDD6FE;margin:6pt 0}
@page{size:Letter;margin:0}
@media print{.pg{padding:15mm 22mm}a{text-decoration:none;color:inherit}}
`;

const COVER_PRINT_CSS = `
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;font-size:11pt;color:#1a1a1a;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pg{padding:25mm 28mm;max-width:210mm;margin:0 auto}
p{margin-bottom:10mm;line-height:1.75;color:#222}
@page{size:A4;margin:0}
`;

function printDocument(content, type) {
  const win = window.open('', '_blank');
  if (!win) return;
  if (type === 'resume') {
    const parsed = parseResumeDoc(content);
    const body = resumeDocToHTML(parsed);
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Resume</title><style>${RESUME_PRINT_CSS}</style></head><body><div class="pg">${body}</div><script>window.onload=function(){window.print();window.onafterprint=function(){window.close();}}<\/script></body></html>`);
  } else {
    const esc = (s) => String(s).replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const paras = (content||'').split(/\n{2,}/).map(p=>p.trim().replace(/\n/g,' ')).filter(Boolean).map(p=>`<p>${esc(p)}</p>`).join('');
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Cover Letter</title><style>${COVER_PRINT_CSS}</style></head><body><div class="pg">${paras}</div><script>window.onload=function(){window.print();window.onafterprint=function(){window.close();}}<\/script></body></html>`);
  }
  win.document.close();
}

// Unified download trigger. Desktop/Android: anchor + download attr. iOS: Web Share API
// (gives native Share Sheet → Save to Files / AirDrop), falling back to Quick Look viewer.
// iOS Safari blocks programmatic blob URL clicks initiated from async contexts (gesture
// activation expires after ~1 s — before the dynamic import resolves on a cold load).
async function triggerDownload(blob, filename) {
  const isApple = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && /Mac/.test(navigator.platform));

  if (isApple) {
    if (typeof navigator.share === 'function') {
      const ext = filename.split('.').pop().toLowerCase();
      const mimeMap = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', txt: 'text/plain' };
      const type = mimeMap[ext] || blob.type || 'application/octet-stream';
      const file = new File([blob], filename, { type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: filename }); return; }
        catch (e) { if (e.name === 'AbortError') return; }
      }
    }
    // Fallback: anchor without download attr → iOS opens Quick Look viewer.
    // The user can tap the share icon inside Quick Look to Save to Files.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 30000);
    return;
  }

  // Desktop / Android: standard anchor + download attribute
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.cssText = 'position:fixed;top:-9999px;left:-9999px;';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 5000);
}

async function downloadPDF(content, filename) {
  const { jsPDF } = await import('jspdf');
  const parsed = parseResumeDoc(content);
  const doc = new jsPDF({ unit: 'mm', format: 'letter' });
  // Layout constants — single source of truth for all alignment
  const mL = 8; const mR = 8; const mT = 14; const mB = 14;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const cW = pageW - mL - mR;
  const BULLET_INDENT = 4; const BULLET_HANG = 9; // consistent bullet grid
  const ROLE_LINE_H = 5.5; const BODY_LINE_H = 5;
  let y = 0;

  const chk = (n) => { if (y + n > pageH - mB) { doc.addPage(); y = mT; } };

  const ACCENT    = [107, 33, 232];    // #6B21E8
  const ACCENT_BG = [243, 238, 255];   // #F3EEFF
  const DARK_GRAY = [45, 45, 45];      // #2d2d2d — job titles / degree
  const BODY      = [55, 65, 81];      // #374151 — body text
  const DATE_CLR  = [75, 85, 99];      // #4B5563 — dates
  const SEP       = [221, 214, 254];   // #DDD6FE — separator

  // ── Header: full-width purple background strip
  if (parsed.name || parsed.headerLines.length > 0) {
    const titleLines   = parsed.headerLines.filter(h => h.type === 'title');
    const contactLines = parsed.headerLines.filter(h => h.type === 'contact');
    const contactItems = [];
    contactLines.forEach(h => h.text.split(/\s*[|·•]\s*/).filter(Boolean).forEach(p => { if (p.trim()) contactItems.push(p.trim()); }));

    // Pre-calculate header height before drawing rect (draw rect first, then text over it)
    let headerH = 5; // name baseline at 5mm — ~1.3mm visual top margin matches Browser 5px padding
    if (parsed.name) headerH += 7; // 15pt × 1.2 lineH ≈ 6.4mm + margin → 7mm to title baseline
    headerH += titleLines.length * 4; // 9pt × 1.2 lineH ≈ 3.8mm + margin → 4mm per title line
    if (contactItems.length > 0) headerH += 4; // 1mm gap + contact height + 1.5mm bottom
    else headerH += 2; // bottom padding only

    doc.setFillColor(...ACCENT_BG);
    doc.rect(0, 0, pageW, headerH, 'F');

    let hy = 5; // text baseline cursor — matches headerH initial (name baseline at 5mm)
    if (parsed.name) {
      doc.setFont('helvetica', 'bold'); doc.setFontSize(15); doc.setTextColor(...ACCENT);
      doc.text(parsed.name.toUpperCase(), pageW / 2, hy, { align: 'center' });
      hy += 7;
    }
    titleLines.forEach(h => {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...BODY);
      doc.text(h.text, pageW / 2, hy, { align: 'center' });
      hy += 4;
    });
    if (contactItems.length > 0) {
      hy += 1;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...BODY);
      const sf = doc.internal.scaleFactor;
      const itemWidths = contactItems.map(c => doc.getStringUnitWidth(c) * 8 / sf);
      const itemGap = 4;
      const totalW = itemWidths.reduce((a, b) => a + b, 0) + itemGap * Math.max(0, contactItems.length - 1);
      let cx = (pageW - totalW) / 2;
      contactItems.forEach((c, i) => {
        const w = itemWidths[i];
        doc.text(c, cx, hy);
        doc.setDrawColor(...ACCENT); doc.setLineWidth(0.35);
        doc.line(cx, hy + 0.9, cx + w, hy + 0.9);
        cx += w + itemGap;
      });
    }

    y = headerH + 3; // gap below header before first section
  } else {
    y = mT;
  }

  // ── PDF section icon helper ──────────────────────────────────────────────────
  function drawPdfSecIcon(type, cx, cy, r) {
    doc.setDrawColor(...ACCENT); doc.setLineWidth(0.35);
    doc.circle(cx, cy, r, 'S');
    doc.setLineWidth(0.28);
    const ir = r * 0.55;
    if (type === 'person') {
      doc.circle(cx, cy - ir * 0.45, ir * 0.4, 'S');
      doc.line(cx - ir * 0.85, cy + ir, cx - ir * 0.2, cy + ir * 0.1);
      doc.line(cx - ir * 0.2, cy + ir * 0.1, cx + ir * 0.2, cy + ir * 0.1);
      doc.line(cx + ir * 0.2, cy + ir * 0.1, cx + ir * 0.85, cy + ir);
    } else if (type === 'briefcase') {
      doc.rect(cx - ir * 0.9, cy - ir * 0.3, ir * 1.8, ir, 'S');
      doc.line(cx - ir * 0.45, cy - ir * 0.3, cx - ir * 0.45, cy - ir);
      doc.line(cx - ir * 0.45, cy - ir, cx + ir * 0.45, cy - ir);
      doc.line(cx + ir * 0.45, cy - ir, cx + ir * 0.45, cy - ir * 0.3);
      doc.line(cx, cy - ir * 0.3, cx, cy + ir * 0.7);
    } else if (type === 'graduation') {
      doc.lines([[ir, 0.6 * ir], [-ir, 0.6 * ir], [-ir, -0.6 * ir], [ir, -0.6 * ir]], cx - ir, cy - 0.3 * ir, [1, 1], 'S', true);
      doc.line(cx + ir, cy - 0.3 * ir + 0.6 * ir, cx + ir, cy + ir * 0.7);
      doc.line(cx - ir * 0.4, cy + ir * 0.2, cx + ir * 0.4, cy + ir * 0.2);
    } else if (type === 'code') {
      doc.line(cx - ir * 0.2, cy, cx - ir * 0.85, cy - ir * 0.55);
      doc.line(cx - ir * 0.2, cy, cx - ir * 0.85, cy + ir * 0.55);
      doc.line(cx + ir * 0.2, cy, cx + ir * 0.85, cy - ir * 0.55);
      doc.line(cx + ir * 0.2, cy, cx + ir * 0.85, cy + ir * 0.55);
    } else if (type === 'award') {
      const pts = Array.from({ length: 5 }, (_, k) => {
        const a1 = (k * 72 - 90) * Math.PI / 180;
        const a2 = (k * 72 + 36 - 90) * Math.PI / 180;
        return [[cx + ir * 0.9 * Math.cos(a1), cy + ir * 0.9 * Math.sin(a1)],
                [cx + ir * 0.38 * Math.cos(a2), cy + ir * 0.38 * Math.sin(a2)]];
      }).flat();
      for (let k = 0; k < pts.length; k++) doc.line(pts[k][0], pts[k][1], pts[(k + 1) % pts.length][0], pts[(k + 1) % pts.length][1]);
    } else if (type === 'folder') {
      doc.rect(cx - ir * 0.85, cy - ir * 0.1, ir * 1.7, ir * 0.95, 'S');
      doc.line(cx - ir * 0.85, cy - ir * 0.1, cx - ir * 0.4, cy - ir * 0.7);
      doc.line(cx - ir * 0.4, cy - ir * 0.7, cx + ir * 0.1, cy - ir * 0.1);
    } else if (type === 'globe') {
      doc.circle(cx, cy, ir * 0.6, 'S');
      doc.line(cx - ir * 0.6, cy, cx + ir * 0.6, cy);
      doc.ellipse(cx, cy, ir * 0.28, ir * 0.6, 'S');
    }
  }

  // ── Sections
  for (let si = 0; si < parsed.sections.length; si++) {
    const sec = parsed.sections[si];
    y += si === 0 ? 4.5 : 3;
    chk(10);

    const isBodySec = /summary|objective|profile|about|skills?|language/i.test(sec.title);
    const isExpSec  = /experience|work|employment|career|relevant|internship|volunteer/i.test(sec.title);
    const isEduSec  = /education|academic|university|college|school/i.test(sec.title);

    // Section bar
    const barH = 8; const barY = y - 5.5;
    doc.setFillColor(...ACCENT_BG);
    doc.rect(0, barY, pageW, barH, 'F');
    const secIconCX = mL + 3.8; const secIconCY = y - 1.5; const secIconR = 3.3;
    drawPdfSecIcon(getSectionIconType(sec.title), secIconCX, secIconCY, secIconR);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.setTextColor(...ACCENT);
    doc.text(sec.title.toUpperCase(), mL + 9.5, y);
    y += barH - 3;

    // Experience: timeline line drawn retroactively after each entry
    const EXP_INDENT = isExpSec ? 6 : 0; // shift content right for timeline
    const TL_X = mL + 1.5; // timeline x
    let entryStartY = null;

    const items = sec.items;
    for (let ii = 0; ii < items.length; ii++) {
      const item = items[ii];

      if (item.type === 'gap') {
        // Draw timeline line + dot for completed experience entry
        if (isExpSec && entryStartY !== null) {
          const entryEndY = y - 2;
          doc.setDrawColor(...ACCENT); doc.setLineWidth(0.5);
          doc.line(TL_X, entryStartY, TL_X, entryEndY);
          doc.setFillColor(...ACCENT);
          doc.circle(TL_X, entryStartY, 1.8, 'F');
          entryStartY = null;
        }
        try { doc.setLineDash([1.5, 1.5], 0); } catch (_) {}
        doc.setDrawColor(...SEP); doc.setLineWidth(0.2);
        doc.line(mL, y + 1, pageW - mR, y + 1);
        try { doc.setLineDash([], 0); } catch (_) {}
        y += 5;
        continue;
      }

      if (item.type === 'roleHeader') {
        const { left, date } = extractRoleDate(item.text);
        const { role, company } = splitRoleAndCompany(left);

        if (isBodySec || (!company && !date && role.length > 60)) {
          doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...BODY);
          for (const l of doc.splitTextToSize(item.text, cW)) { chk(BODY_LINE_H); doc.text(l, mL, y); y += BODY_LINE_H; }
          continue;
        }

        // Consume next text item as location
        let location = null;
        if (ii + 1 < items.length && items[ii + 1].type === 'text') { location = items[ii + 1].text; ii++; }

        chk(7);
        const contentX = mL + EXP_INDENT;
        const contentW = cW - EXP_INDENT;

        if (isExpSec) {
          // Mark entry start for timeline
          entryStartY = y - 1;
          // Role | Company on left, date right-aligned
          const sf = doc.internal.scaleFactor;
          let rightBlockW = 0;
          if (date) { const dw = doc.getStringUnitWidth(date) * 9 / sf; rightBlockW = Math.max(rightBlockW, dw); }
          if (location) { doc.setFontSize(9); const lw = doc.getStringUnitWidth(location) * 9 / sf; rightBlockW = Math.max(rightBlockW, lw); }
          const leftW = contentW - rightBlockW - 3;

          doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...DARK_GRAY);
          const roleText = company ? `${role} | ${company}` : role;
          // Measure role part only for bold, then company in italic
          const roleWrapped = doc.splitTextToSize(role, leftW - (company ? doc.getStringUnitWidth(' | ') * 10.5 / sf + doc.getStringUnitWidth(company) * 10 / sf : 0));
          // Simplified: render "Role | Company" as mixed run on first line
          const firstLineY = y;
          doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...DARK_GRAY);
          doc.text(role, contentX, firstLineY);
          if (company) {
            const roleOnlyW = doc.getStringUnitWidth(role) * 10.5 / sf;
            doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...BODY);
            doc.text(' | ', contentX + roleOnlyW, firstLineY);
            const sepW = doc.getStringUnitWidth(' | ') * 10 / sf;
            doc.setFont('helvetica', 'italic'); doc.setFontSize(10); doc.setTextColor(...ACCENT);
            doc.text(company, contentX + roleOnlyW + sepW, firstLineY);
          }
          y += ROLE_LINE_H;
          // Date + location right-aligned
          if (date) {
            doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...DATE_CLR);
            doc.text(date, pageW - mR, firstLineY, { align: 'right' });
          }
          if (location) {
            doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...DATE_CLR);
            doc.text(location, pageW - mR, firstLineY + ROLE_LINE_H - 0.5, { align: 'right' });
          }
        } else if (isEduSec) {
          // Degree on left, date+location on right
          const sf = doc.internal.scaleFactor;
          let rightBlockW = 0;
          if (date) { doc.setFontSize(9); rightBlockW = Math.max(rightBlockW, doc.getStringUnitWidth(date) * 9 / sf); }
          if (location) { rightBlockW = Math.max(rightBlockW, doc.getStringUnitWidth(location) * 9 / sf); }
          const leftW = cW - rightBlockW - 3;
          doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...DARK_GRAY);
          const degreeLines = doc.splitTextToSize(role, leftW);
          degreeLines.forEach((l, li) => { chk(ROLE_LINE_H); doc.text(l, mL, y); if (li < degreeLines.length - 1) y += ROLE_LINE_H; });
          if (date) {
            doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...DATE_CLR);
            doc.text(date, pageW - mR, y - (degreeLines.length - 1) * ROLE_LINE_H, { align: 'right' });
          }
          if (location) {
            doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...DATE_CLR);
            doc.text(location, pageW - mR, y - (degreeLines.length - 1) * ROLE_LINE_H + ROLE_LINE_H - 0.5, { align: 'right' });
          }
          y += ROLE_LINE_H;
          if (company) {
            doc.setFont('helvetica', 'italic'); doc.setFontSize(10); doc.setTextColor(...ACCENT);
            for (const l of doc.splitTextToSize(company, cW)) { chk(5); doc.text(l, mL, y); y += 5; }
          }
        } else {
          // Generic (projects, certifications, etc.)
          const sf = doc.internal.scaleFactor;
          doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5); doc.setTextColor(...DARK_GRAY);
          if (date) {
            const dateW2 = doc.getStringUnitWidth(date) * 9 / sf;
            const rW = cW - dateW2 - 4;
            const rLines = doc.splitTextToSize(role, rW);
            rLines.forEach((l, li) => { chk(ROLE_LINE_H); doc.text(l, mL, y); if (li < rLines.length - 1) y += ROLE_LINE_H; });
            doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...DATE_CLR);
            doc.text(date, pageW - mR, y, { align: 'right' });
            y += ROLE_LINE_H;
          } else {
            for (const l of doc.splitTextToSize(role, cW)) { chk(ROLE_LINE_H); doc.text(l, mL, y); y += ROLE_LINE_H; }
          }
          if (company) {
            doc.setFont('helvetica', 'italic'); doc.setFontSize(10); doc.setTextColor(...ACCENT);
            for (const l of doc.splitTextToSize(company, cW)) { chk(5); doc.text(l, mL, y); y += 5; }
            y += 0.5;
          }
          if (location) {
            doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...DATE_CLR);
            for (const l of doc.splitTextToSize(location, cW)) { chk(BODY_LINE_H); doc.text(l, mL, y); y += BODY_LINE_H; }
          }
        }
        continue;
      }

      if (item.type === 'bullet') {
        const bulletX = mL + EXP_INDENT + BULLET_INDENT;
        const textX = mL + EXP_INDENT + BULLET_HANG;
        const textW = cW - EXP_INDENT - BULLET_HANG;
        doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...BODY);
        const wrapped = doc.splitTextToSize(item.text, textW);
        chk(BODY_LINE_H);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(12); doc.setTextColor(...ACCENT);
        doc.text('•', bulletX, y - 0.3);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...BODY);
        wrapped.forEach((l, li) => { chk(BODY_LINE_H); doc.text(l, textX, y); if (li < wrapped.length - 1) y += BODY_LINE_H; });
        y += BODY_LINE_H;
        continue;
      }

      // Plain text item
      const inEduSec = /education|university|college|school/i.test(sec.title);
      const isYearGPA = /^\d{4}$|^GPA/i.test(item.text.trim());
      if (inEduSec && !isYearGPA) {
        doc.setFont('helvetica', 'italic'); doc.setFontSize(10); doc.setTextColor(...ACCENT);
      } else if (inEduSec && isYearGPA) {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...DATE_CLR);
      } else {
        doc.setFont('helvetica', 'normal'); doc.setFontSize(10); doc.setTextColor(...BODY);
      }
      for (const l of doc.splitTextToSize(item.text, cW)) { chk(BODY_LINE_H); doc.text(l, mL, y); y += BODY_LINE_H; }
    }

    // Close last experience entry's timeline
    if (isExpSec && entryStartY !== null) {
      const entryEndY = y - 2;
      doc.setDrawColor(...ACCENT); doc.setLineWidth(0.5);
      doc.line(TL_X, entryStartY, TL_X, entryEndY);
      doc.setFillColor(...ACCENT);
      doc.circle(TL_X, entryStartY, 1.8, 'F');
      entryStartY = null;
    }
  }

  await triggerDownload(doc.output('blob'), filename + '.pdf');
}

async function downloadDOCX(content, filename) {
  const { Document, Paragraph, TextRun, Packer, AlignmentType, BorderStyle, TabStopType, ShadingType, Table, TableRow, TableCell, WidthType } = await import('docx');
  const parsed = parseResumeDoc(content);
  const paragraphs = [];

  // Layout constants — single source of truth for all alignment
  const marginTwips = 720; // ~0.5in margins
  const contentW = 10800;  // twips: 8.5in - 2*0.5in = 7.5in
  const CAL = 'Calibri';
  const ACCENT    = '6B21E8';
  const ACCENT_BG = 'F3EEFF';
  const DARK_GRAY = '2d2d2d';
  const BODY_CLR  = '374151';
  const DATE_CLR  = '4B5563';

  const sp = (before = 0, after = 0) => ({ spacing: { before, after } });

  // ── Header: name + title + contact with individual underlines
  if (parsed.name || parsed.headerLines.length > 0) {
    const titleLines   = parsed.headerLines.filter(h => h.type === 'title');
    const contactLines = parsed.headerLines.filter(h => h.type === 'contact');
    const contactItems = [];
    contactLines.forEach(h => h.text.split(/\s*[|·•]\s*/).filter(Boolean).forEach(p => { if (p.trim()) contactItems.push(p.trim()); }));

    const hdrIndent = { left: -marginTwips, right: -marginTwips };
    if (parsed.name) {
      paragraphs.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: parsed.name.toUpperCase(), bold: true, size: 30, font: CAL, color: ACCENT })],
        shading: { type: ShadingType.SOLID, color: ACCENT_BG, fill: ACCENT_BG },
        indent: hdrIndent,
        ...sp(60, 30),
      }));
    }
    titleLines.forEach(h => {
      paragraphs.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: h.text, size: 18, font: CAL, color: BODY_CLR })],
        shading: { type: ShadingType.SOLID, color: ACCENT_BG, fill: ACCENT_BG },
        indent: hdrIndent,
        ...sp(0, 15),
      }));
    });
    if (contactItems.length > 0) {
      // Each contact item gets its own underline — spacing runs separate them
      const contactRuns = [];
      contactItems.forEach((c, i) => {
        if (i > 0) contactRuns.push(new TextRun({ text: '   ', size: 16, font: CAL }));
        contactRuns.push(new TextRun({ text: c, size: 16, font: CAL, color: BODY_CLR, underline: { type: 'single', color: ACCENT } }));
      });
      paragraphs.push(new Paragraph({
        alignment: AlignmentType.CENTER,
        children: contactRuns,
        shading: { type: ShadingType.SOLID, color: ACCENT_BG, fill: ACCENT_BG },
        indent: hdrIndent,
        ...sp(0, 60),
      }));
    } else {
      // Close out header shading even with no contact row
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: '', size: 4 })],
        shading: { type: ShadingType.SOLID, color: ACCENT_BG, fill: ACCENT_BG },
        indent: hdrIndent,
        ...sp(0, 60),
      }));
    }
  }

  // ── Sections
  const DOCX_ICONS = { person: '◑', briefcase: '◈', graduation: '◆', code: '<>', award: '★', folder: '▭', globe: '◎' };
  const noBorder = { style: BorderStyle.NONE, size: 0, color: 'auto' };
  const allNoBorder = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder, insideHorizontal: noBorder, insideVertical: noBorder };

  for (let si = 0; si < parsed.sections.length; si++) {
    const sec = parsed.sections[si];
    const isBodySec = /summary|objective|profile|about|skills?|language/i.test(sec.title);
    const isExpSec  = /experience|work|employment|career|relevant|internship|volunteer/i.test(sec.title);
    const isEduSec  = /education|academic|university|college|school/i.test(sec.title);
    const secIcon   = DOCX_ICONS[getSectionIconType(sec.title)] || '○';

    // Section bar
    paragraphs.push(new Paragraph({
      children: [
        new TextRun({ text: `${secIcon}  `, bold: true, size: 18, font: CAL, color: ACCENT }),
        new TextRun({ text: sec.title, bold: true, size: 16, font: CAL, color: ACCENT, allCaps: true }),
      ],
      shading: { type: ShadingType.SOLID, color: ACCENT_BG, fill: ACCENT_BG },
      indent: { left: -marginTwips, right: -marginTwips, firstLine: marginTwips },
      ...sp(80, 60),
    }));

    const items = sec.items;
    for (let ii = 0; ii < items.length; ii++) {
      const item = items[ii];

      if (item.type === 'gap') {
        paragraphs.push(new Paragraph({
          children: [new TextRun({ text: '', size: 8 })],
          border: { bottom: { color: 'DDD6FE', space: 1, style: BorderStyle.DASHED, size: 2 } },
          ...sp(0, 60),
        }));
        continue;
      }

      if (item.type === 'roleHeader') {
        const { left, date } = extractRoleDate(item.text);
        const { role, company } = splitRoleAndCompany(left);

        if (isBodySec || (!company && !date && role.length > 60)) {
          paragraphs.push(new Paragraph({
            children: [new TextRun({ text: item.text, size: 20, font: CAL, color: BODY_CLR })],
            ...sp(0, 30),
          }));
          continue;
        }

        // Consume next text item as location
        let location = null;
        if (ii + 1 < items.length && items[ii + 1].type === 'text') { location = items[ii + 1].text; ii++; }

        const leftW = Math.floor(contentW * 0.68);
        const rightW = contentW - leftW;

        if (isExpSec) {
          // Experience: "● Role | Company" left + date/location right
          const leftRuns = [
            new TextRun({ text: '● ', size: 20, font: CAL, color: ACCENT, bold: true }),
            new TextRun({ text: role, bold: true, size: 21, font: CAL, color: DARK_GRAY }),
          ];
          if (company) {
            leftRuns.push(new TextRun({ text: ' | ', size: 20, font: CAL, color: BODY_CLR }));
            leftRuns.push(new TextRun({ text: company, italics: true, size: 20, font: CAL, color: ACCENT }));
          }
          const rightRuns = [];
          if (date)     rightRuns.push(new TextRun({ text: date, size: 17, font: CAL, color: DATE_CLR, break: rightRuns.length ? 1 : 0 }));
          if (location) rightRuns.push(new TextRun({ text: location, size: 17, font: CAL, color: DATE_CLR, break: 1 }));

          paragraphs.push(new Table({
            width: { size: contentW, type: WidthType.DXA },
            borders: allNoBorder,
            rows: [new TableRow({
              children: [
                new TableCell({
                  width: { size: leftW, type: WidthType.DXA },
                  borders: allNoBorder,
                  children: [new Paragraph({ children: leftRuns, indent: { left: 180 }, border: { left: { style: BorderStyle.SINGLE, size: 10, color: ACCENT, space: 4 } }, ...sp(80, 20) })],
                }),
                new TableCell({
                  width: { size: rightW, type: WidthType.DXA },
                  borders: allNoBorder,
                  children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: rightRuns.length ? rightRuns : [new TextRun({ text: '' })], ...sp(80, 20) })],
                }),
              ],
            })],
          }));
        } else if (isEduSec) {
          // Education: degree left + date/location right
          const rightRuns = [];
          if (date)     rightRuns.push(new TextRun({ text: date,     size: 17, font: CAL, color: DATE_CLR }));
          if (location) rightRuns.push(new TextRun({ text: location, size: 17, font: CAL, color: DATE_CLR, break: 1 }));

          paragraphs.push(new Table({
            width: { size: contentW, type: WidthType.DXA },
            borders: allNoBorder,
            rows: [new TableRow({
              children: [
                new TableCell({
                  width: { size: leftW, type: WidthType.DXA },
                  borders: allNoBorder,
                  children: [new Paragraph({ children: [new TextRun({ text: role, bold: true, size: 21, font: CAL, color: DARK_GRAY })], ...sp(80, 10) })],
                }),
                new TableCell({
                  width: { size: rightW, type: WidthType.DXA },
                  borders: allNoBorder,
                  children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: rightRuns.length ? rightRuns : [new TextRun({ text: '' })], ...sp(80, 10) })],
                }),
              ],
            })],
          }));
          if (company) {
            paragraphs.push(new Paragraph({
              children: [new TextRun({ text: company, italics: true, size: 20, font: CAL, color: ACCENT })],
              ...sp(0, 40),
            }));
          }
        } else {
          // Generic (projects, certifications, etc.)
          const rightRuns = date ? [new TextRun({ text: date, size: 17, font: CAL, color: DATE_CLR })] : [];
          paragraphs.push(new Table({
            width: { size: contentW, type: WidthType.DXA },
            borders: allNoBorder,
            rows: [new TableRow({
              children: [
                new TableCell({
                  width: { size: leftW, type: WidthType.DXA },
                  borders: allNoBorder,
                  children: [new Paragraph({ children: [new TextRun({ text: role, bold: true, size: 21, font: CAL, color: DARK_GRAY })], ...sp(80, 10) })],
                }),
                new TableCell({
                  width: { size: rightW, type: WidthType.DXA },
                  borders: allNoBorder,
                  children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: rightRuns.length ? rightRuns : [new TextRun({ text: '' })], ...sp(80, 10) })],
                }),
              ],
            })],
          }));
          if (company) {
            paragraphs.push(new Paragraph({
              children: [new TextRun({ text: company, italics: true, size: 20, font: CAL, color: ACCENT })],
              ...sp(0, 40),
            }));
          }
          if (location) {
            paragraphs.push(new Paragraph({
              children: [new TextRun({ text: location, size: 18, font: CAL, color: DATE_CLR })],
              ...sp(0, 20),
            }));
          }
        }
        continue;
      }

      if (item.type === 'bullet') {
        const bulletIndent = isExpSec ? { left: 540 } : {};
        paragraphs.push(new Paragraph({
          children: [new TextRun({ text: item.text, size: 20, font: CAL, color: BODY_CLR })],
          bullet: { level: 0 },
          indent: isExpSec ? { left: 540, hanging: 360 } : undefined,
          ...sp(0, 30),
        }));
        continue;
      }

      // Plain text item
      const inEduSec2 = /education|university|college|school/i.test(sec.title);
      const isYearGPA = /^\d{4}$|^GPA/i.test(item.text.trim());
      const txtColor = inEduSec2 && !isYearGPA ? ACCENT : (inEduSec2 && isYearGPA ? DATE_CLR : BODY_CLR);
      paragraphs.push(new Paragraph({
        children: [new TextRun({ text: item.text, size: 20, font: CAL, color: txtColor, italics: inEduSec2 && !isYearGPA })],
        ...sp(0, 30),
      }));
    }
  }

  const doc = new Document({
    sections: [{
      properties: {
        page: { margin: { top: marginTwips, bottom: marginTwips, left: marginTwips, right: marginTwips } },
      },
      children: paragraphs,
    }],
  });
  const blob = await Packer.toBlob(doc);
  await triggerDownload(blob, filename + '.docx');
}

// Cover letter exports — prose layout with paragraph awareness
async function downloadCoverLetterPDF(text, filename) {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const margin = 28;
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const maxW  = pageW - margin * 2;
  let y = margin;
  const lineH = 6.8;
  const chk = (n) => { if (y + n > pageH - margin) { doc.addPage(); y = margin; } };
  doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(34, 34, 34);

  const paras = (text || '').split(/\n{2,}/).map(p => p.replace(/\n/g, ' ').trim()).filter(Boolean);
  paras.forEach((para, i) => {
    const wrapped = doc.splitTextToSize(para, maxW);
    chk(lineH * wrapped.length);
    for (const l of wrapped) { doc.text(l, margin, y); y += lineH; }
    if (i < paras.length - 1) y += lineH * 0.7;
  });

  await triggerDownload(doc.output('blob'), filename + '.pdf');
}

async function downloadCoverLetterDOCX(text, filename) {
  const { Document, Paragraph, TextRun, Packer } = await import('docx');
  const paras = (text || '').split(/\n{2,}/).map(p => p.replace(/\n/g, ' ').trim()).filter(Boolean);
  const children = paras.map(p => new Paragraph({
    children: [new TextRun({ text: p, size: 22, font: 'Calibri', color: '222222' })],
    spacing: { after: 200, line: 360 },
  }));
  const doc = new Document({
    sections: [{
      properties: { page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      children,
    }],
  });
  const blob = await Packer.toBlob(doc);
  await triggerDownload(blob, filename + '.docx');
}

function Logo({ size = 36, onClick, className }) {
  return (
    <div className={className} onClick={onClick} style={{ width: size, height: size, background: `linear-gradient(135deg, ${C.purple}, ${C.purpleMid})`, borderRadius: size * 0.25, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: onClick ? "pointer" : "default" }}>
      <span className={className ? `${className}-glyph` : undefined} style={{ color: "#fff", fontWeight: 900, fontSize: size * 0.44, letterSpacing: "-1px" }}>CP</span>
    </div>
  );
}

function AppName({ size = 18, onClick, className }) {
  return (
    <span className={className} onClick={onClick} style={{ fontSize: size, fontWeight: 800, letterSpacing: "-0.5px", cursor: onClick ? "pointer" : "default" }}>
      <span style={{ color: C.text }}>Career</span><span style={{ color: C.purple }}>Persona</span>
      <span className={className ? `${className}-badge` : undefined} style={{ display: "inline-flex", justifyContent: "center", alignItems: "center", letterSpacing: "normal", background: `linear-gradient(135deg,${C.purple},${C.purpleMid})`, color: "#fff", fontSize: size * 0.65, fontWeight: 700, padding: "0 6px", borderRadius: 5, marginLeft: 5, verticalAlign: "middle" }}>AI</span>
    </span>
  );
}

function UserMenu({ profile, page, setPage, onLogout }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const active = page === "profile" || page === "settings";
  const name = profile?.full_name?.split(" ")[0] || t("userMenu.defaultName");
  return (
    <div style={{ position: "relative", flex: "0 0 105px", minWidth: 0 }}>
      <button title={name} onClick={() => setOpen(o => !o)} style={{ width: "100%", boxSizing: "border-box", minWidth: 0, padding: "6px 10px", borderRadius: 8, border: "none", background: active ? "#fff" : "transparent", color: active ? C.purple : C.textMuted, fontSize: 12, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
        <span style={{ flexShrink: 0 }}>👤</span>
        <span className="nav-label" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
        <span style={{ flexShrink: 0 }}>▾</span>
      </button>
      {open && (
        <div>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 99 }} />
          <div style={{ position: "absolute", top: "110%", right: 0, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 100, minWidth: 160, overflow: "hidden" }}>
            <button onClick={() => { setPage("profile"); setOpen(false); }} style={{ width: "100%", padding: "12px 16px", border: "none", background: page === "profile" ? C.bgSoft : "#fff", color: C.text, fontSize: 14, fontWeight: 600, cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 8 }}>👤 {t("userMenu.profile")}</button>
            <button onClick={() => { setPage("settings"); setOpen(false); }} style={{ width: "100%", padding: "12px 16px", border: "none", background: page === "settings" ? C.bgSoft : "#fff", color: C.text, fontSize: 14, fontWeight: 600, cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 8 }}>⚙️ {t("userMenu.settings")}</button>
            <div style={{ borderTop: `1px solid ${C.border}` }} />
            <button onClick={() => { onLogout(); setOpen(false); }} style={{ width: "100%", padding: "12px 16px", border: "none", background: "#fff", color: C.red, fontSize: 14, fontWeight: 600, cursor: "pointer", textAlign: "left", display: "flex", alignItems: "center", gap: 8 }}>🚪 {t("userMenu.signOut")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// Single shared implementation used by both the desktop header (variant="icon")
// and the mobile/tablet hamburger menu (variant="row") — same dropdown markup,
// same i18n context, same persistence, just a different trigger affordance.
function LanguageMenu({ variant = "icon" }) {
  const { language, setLanguage, t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      {variant === "row" ? (
        <button title={t("language.title")} onClick={() => setOpen(o => !o)} style={{ width: "100%", padding: "16px 20px", borderRadius: 10, border: "none", background: open ? C.purpleLight : "#fff", color: open ? C.purple : C.text, fontSize: 15, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 12, marginBottom: 6, textAlign: "left" }}>
          <span style={{ fontSize: 20 }}>🌐</span>
          <span style={{ fontSize: 18 }}>{LANGUAGES.find(l => l.code === language)?.flag}</span>
          <span style={{ marginLeft: "auto", color: C.textMuted, fontSize: 12 }}>▼</span>
        </button>
      ) : (
        <button onClick={() => setOpen(o => !o)} style={{ padding: "6px 10px", borderRadius: 8, border: "none", background: open ? "#fff" : "transparent", color: open ? C.purple : C.textMuted, fontSize: 14, cursor: "pointer" }} title={t("language.title")}>🌐</button>
      )}
      {open && (
        <div>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 99 }} />
          <div style={{ position: "absolute", top: "110%", right: 0, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 100, width: 220, overflow: "hidden" }}>
            <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}`, fontWeight: 700, fontSize: 14, color: C.text }}>{t("language.title")}</div>
            <div style={{ padding: "6px 0", maxHeight: 320, overflowY: "auto" }}>
              {LANGUAGES.map(lng => (
                <button key={lng.code} onClick={() => { setLanguage(lng.code); setOpen(false); }} style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "9px 16px", border: "none", background: lng.code === language ? C.bgSoft : "#fff", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                  <span style={{ fontSize: 16 }}>{lng.flag}</span>
                  <span style={{ fontSize: 14, color: C.text, fontWeight: 600, flex: 1 }}>{lng.native}</span>
                  {lng.code === language && <span style={{ color: C.purple, fontWeight: 700 }}>✓</span>}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Same idea as LanguageMenu: one shared notification-center implementation,
// data/handlers passed down from the single useNotifications() call in App()
// so there is only ever one fetch/poll source regardless of how many trigger
// affordances (desktop icon vs. mobile row) are mounted.
function NotificationsMenu({ variant = "icon", notifications, refresh, markAllRead, unreadCount = 0 }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) { await refresh(); markAllRead(); }
  };
  const pill = (n) => {
    const keys = { briefing: "notifications.modules.briefing", action_plan: "notifications.modules.actionPlan", smart_apply: "notifications.modules.smartApply", opportunity: "notifications.modules.opportunity", resume: "notifications.modules.resume", job_intel: "notifications.modules.jobs", interview: "notifications.modules.interview", salary: "notifications.modules.salary", career_progress: "notifications.modules.careerProgress", networking: "notifications.modules.networking" };
    if (keys[n.type]) return t(keys[n.type]);
    if (n.type === "ai_recommendation") {
      const title = (n.title || "").toLowerCase();
      return title.includes("action") || title.includes("plan") ? t("notifications.modules.actionPlan") : t("notifications.modules.briefing");
    }
    return n.type ? n.type.split("_").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ") : t("notifications.modules.fallback");
  };
  return (
    <div style={{ position: "relative" }}>
      {variant === "row" ? (
        <button onClick={toggle} style={{ width: "100%", padding: "16px 20px", borderRadius: 10, border: "none", background: open ? C.purpleLight : "#fff", color: open ? C.purple : C.text, fontSize: 15, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 12, marginBottom: 6, textAlign: "left" }}>
          <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
            <span style={{ fontSize: 20 }}>🔔</span>
            {unreadCount > 0 && <span style={{ position: "absolute", top: -6, right: -8, background: "#ef4444", color: "#fff", borderRadius: "50%", minWidth: 16, height: 16, fontSize: 9, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 3px", lineHeight: 1 }}>{unreadCount > 9 ? "9+" : unreadCount}</span>}
          </span>
          {t("notifications.title")}
        </button>
      ) : (
        <button onClick={toggle} style={{ padding: "6px 10px", borderRadius: 8, border: "none", background: open ? "#fff" : "transparent", color: open ? C.purple : C.textMuted, fontSize: 14, cursor: "pointer", position: "relative" }} title={t("notifications.title")}>
          🔔
          {unreadCount > 0 && <span style={{ position: "absolute", top: 0, right: 0, background: "#ef4444", color: "#fff", borderRadius: "50%", minWidth: 16, height: 16, fontSize: 9, fontWeight: 800, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 3px", lineHeight: 1 }}>{unreadCount > 9 ? "9+" : unreadCount}</span>}
        </button>
      )}
      {open && (
        <div>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 99 }} />
          <div style={{ position: "absolute", top: "110%", right: 0, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 100, width: 320, overflow: "hidden" }}>
            <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}`, fontWeight: 700, fontSize: 14, color: C.text }}>{t("notifications.title")}</div>
            {notifications.length === 0 ? (
              <div style={{ padding: "32px 16px", textAlign: "center" }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>🔔</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 4 }}>{t("notifications.emptyTitle")}</div>
                <div style={{ fontSize: 12, color: C.textMuted }}>{t("notifications.emptyBody")}</div>
              </div>
            ) : (
              <div style={{ maxHeight: 400, overflowY: "auto" }}>
                {notifications.map(n => (
                  <div key={n.id} style={{ padding: "9px 14px", borderBottom: `1px solid ${C.border}`, background: n.read ? "#fff" : C.purpleLight }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
                      <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.purple, flexShrink: 0 }} />
                      <span style={{ fontSize: 12, fontWeight: n.read ? 500 : 600, color: C.text, flex: 1 }}>{pill(n)}</span>
                      <span style={{ fontSize: 11, color: C.textMuted, whiteSpace: "nowrap" }}>{n.time}</span>
                    </div>
                    {(n.body || n.title) && <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.5, paddingLeft: 14 }}>{n.body || n.title}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export function Btn({ children, onClick, variant = "primary", disabled, loading, style = {}, className, title }) {
  const isDisabled = disabled || loading;
  const base = { border: "none", borderRadius: 10, padding: "11px 22px", fontSize: 14, fontWeight: 700, cursor: isDisabled ? "not-allowed" : "pointer", opacity: disabled && !loading ? 0.5 : 1, display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, transition: "all 0.15s" };
  const variants = { primary: { background: `linear-gradient(135deg,${C.purple},${C.purpleMid})`, color: "#fff" }, secondary: { background: C.bgSoft, color: C.textMid, border: `1px solid ${C.border}` }, green: { background: C.green, color: "#fff" }, ghost: { background: "transparent", color: C.textMuted, border: `1px solid ${C.border}` }, danger: { background: "transparent", color: C.red, border: `1px solid ${C.red}40` }, blue: { background: C.blue, color: "#fff" } };
  return (
    <button className={className} title={title} style={{ ...base, ...variants[variant], ...style }} onClick={onClick} disabled={isDisabled}>
      {loading && <span style={{ width: 13, height: 13, flexShrink: 0, border: "2px solid currentColor", borderTopColor: "transparent", borderRadius: "50%", opacity: 0.85, animation: "spin 0.8s linear infinite" }} />}
      {children}
    </button>
  );
}

export function Card({ children, style = {}, onClick, ...rest }) {
  return <div onClick={onClick} style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 16, padding: 24, boxShadow: "0 1px 4px rgba(0,0,0,0.04)", ...style }} {...rest}>{children}</div>;
}

function Label({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 7 }}>{children}</div>;
}

// error: optional validation message string. Omitted by every existing call
// site (identical rendering to before); when passed, highlights the field
// with a red border and shows the message directly beneath it.
function Input({ label, error, style = {}, ...props }) {
  return (
    <div>
      {label && <Label>{label}</Label>}
      <input style={{ width: "100%", background: "#ffffff", border: `1.5px solid ${error ? C.red : "#E2E8F0"}`, borderRadius: 9, color: "#0F172A", fontSize: 14, padding: "12px 14px", outline: "none", fontFamily: "inherit", boxSizing: "border-box", ...style }} {...props} />
      {error && <div style={{ fontSize: 12, color: C.red, marginTop: 4, fontWeight: 600 }}>{error}</div>}
    </div>
  );
}

function Textarea({ label, style = {}, ...props }) {
  const baseStyle = {
    width: "100%",
    minHeight: 220,
    background: "#FFFFFF",
    border: "1.5px solid #E2E8F0",
    borderRadius: 10,
    color: "#0F172A",
    fontSize: 14,
    lineHeight: 1.8,
    padding: "16px",
    resize: "vertical",
    outline: "none",
    fontFamily: "'Inter','Segoe UI',system-ui,sans-serif",
    boxSizing: "border-box",
    display: "block",
    fontWeight: 400,
    letterSpacing: "normal",
    ...style
  };
  return <div style={{ width: "100%" }}>{label && <Label>{label}</Label>}<textarea style={baseStyle} {...props} /></div>;
}

function Select({ label, children, ...props }) {
  return <div>{label && <Label>{label}</Label>}<select style={{ width: "100%", background: "#ffffff", border: "1.5px solid #E2E8F0", borderRadius: 9, color: "#0F172A", fontSize: 14, padding: "12px 14px", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} {...props}>{children}</select></div>;
}

function Badge({ children, color = C.purple }) {
  return <span style={{ background: `${color}15`, color, border: `1px solid ${color}30`, borderRadius: 6, padding: "2px 9px", fontSize: 11, fontWeight: 700 }}>{children}</span>;
}

function ScoreRing({ score, size = 80 }) {
  const color = score >= 80 ? C.green : score >= 60 ? C.yellow : score >= 40 ? "#EA580C" : C.red;
  const r = size / 2 - 7; const circ = 2 * Math.PI * r; const dash = (score / 100) * circ;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={C.border} strokeWidth="7" />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="7" strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontSize: size * 0.26, fontWeight: 800, color, lineHeight: 1 }}>{score}</span>
        <span style={{ fontSize: size * 0.13, color: C.textMuted }}>/ 100</span>
      </div>
    </div>
  );
}

function PBar({ val, color }) {
  const c = color || (val >= 80 ? C.green : val >= 60 ? C.yellow : C.red);
  return <div style={{ height: 6, background: C.border, borderRadius: 3, overflow: "hidden", marginTop: 5 }}><div style={{ height: "100%", width: `${val}%`, background: c, borderRadius: 3, transition: "width 1s ease" }} /></div>;
}

function Spinner({ steps = [], currentStep = 0 }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "48px 20px", gap: 20 }}>
      <div style={{ width: 44, height: 44, border: `3px solid ${C.border}`, borderTop: `3px solid ${C.purple}`, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      {steps.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, width: "100%", maxWidth: 320 }}>
          {steps.map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 20, height: 20, borderRadius: "50%", background: i < currentStep ? C.green : i === currentStep ? C.purple : C.border, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                {i < currentStep ? <span style={{ color: "#fff", fontSize: 11 }}>✓</span> : i === currentStep ? <div style={{ width: 8, height: 8, background: "#fff", borderRadius: "50%" }} /> : null}
              </div>
              <span style={{ fontSize: 13, color: i <= currentStep ? C.text : C.textMuted, fontWeight: i === currentStep ? 600 : 400 }}>{s}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function copyToClipboard(text) {
  // Modern clipboard API (requires HTTPS / secure context)
  if (navigator.clipboard && window.isSecureContext) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback for HTTP / iOS Safari / older Android
  return new Promise((resolve, reject) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;top:-9999px;left:-9999px;opacity:0;";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand("copy") ? resolve() : reject(); } catch (e) { reject(e); }
    document.body.removeChild(ta);
  });
}

function downloadTextFile(text, filename) {
  void triggerDownload(new Blob([text], { type: "text/plain;charset=utf-8" }), filename);
}

function CopyBtn({ text, label, variant = "ghost", style: outerStyle }) {
  const { t } = useI18n();
  const [c, setC] = useState(false);
  const handleCopy = () => {
    copyToClipboard(text)
      .then(() => { setC(true); setTimeout(() => setC(false), 2000); })
      .catch(() => { setC(true); setTimeout(() => setC(false), 2000); }); // still show feedback even if API errors
  };
  return <Btn variant={variant} style={{ padding: "6px 14px", fontSize: 12, ...outerStyle }} onClick={handleCopy}>{c ? t("common.copied") : (label ?? t("common.copy"))}</Btn>;
}

// highlightTokens: optional array of exact substrings (e.g. unresolved placeholder
// tokens) to underline in red directly in the text, in place of a separate warning box.
function ContentDisplay({ content, highlightTokens }) {
  const boxStyle = { background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px", fontSize: 14, lineHeight: 1.85, color: C.text, whiteSpace: "pre-wrap", maxHeight: 420, overflowY: "auto", fontFamily: "inherit" };
  if (!highlightTokens?.length) {
    return <div style={boxStyle}>{content}</div>;
  }
  const uniqueTokens = [...new Set(highlightTokens)];
  const pattern = new RegExp(`(${uniqueTokens.map(tok => tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "g");
  const parts = (content || "").split(pattern);
  return (
    <div style={boxStyle}>
      {parts.map((part, i) => uniqueTokens.includes(part)
        ? <span key={i} style={{ textDecoration: "underline", textDecorationColor: C.red, textDecorationThickness: 2, textUnderlineOffset: 3 }}>{part}</span>
        : part
      )}
    </div>
  );
}

// ─── Resume renderer helpers ─────────────────────────────────────────────────
// detectContactType now lives in ./lib/contactNormalization (Contact
// Normalization Service) — imported above, not redefined here.
function getSectionIconType(title) {
  const t = title.toLowerCase();
  if (/summary|profile|objective|about|overview|highlight/.test(t)) return 'person';
  if (/experience|work|employment|career|relevant|internship|volunteer/.test(t)) return 'briefcase';
  if (/education|academic|university|college|school/.test(t)) return 'graduation';
  if (/skill|competenc|expertise|technolog/.test(t)) return 'code';
  if (/cert|license|credential|training|development/.test(t)) return 'award';
  if (/project|portfolio|open.source/.test(t)) return 'folder';
  if (/language/.test(t)) return 'globe';
  return 'person';
}
function ContactIcon({ type, size = 13, color = '#6B21E8' }) {
  const props = { size, color, strokeWidth: 1.8, style: { display: 'block', flexShrink: 0 } };
  if (type === 'email')     return <Mail {...props}/>;
  if (type === 'phone')     return <Phone {...props}/>;
  if (type === 'portfolio') return <Globe {...props}/>;
  if (type === 'linkedin') return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z"/>
      <rect width="4" height="12" x="2" y="9"/><circle cx="4" cy="4" r="2"/>
    </svg>
  );
  if (type === 'github') return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block', flexShrink: 0 }}>
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/>
      <path d="M9 18c-4.51 2-5-2-7-2"/>
    </svg>
  );
  return <MapPin {...props}/>;
}
function SectionCircleIcon({ type, size = 28 }) {
  const iconProps = { size: Math.round(size * 0.55), color: '#fff', strokeWidth: 1.8, style: { display: 'block' } };
  const icon = {
    person:     <User {...iconProps}/>,
    briefcase:  <Briefcase {...iconProps}/>,
    graduation: <GraduationCap {...iconProps}/>,
    code:       <Code2 {...iconProps}/>,
    award:      <Award {...iconProps}/>,
    folder:     <FolderOpen {...iconProps}/>,
    globe:      <Globe {...iconProps}/>,
  }[type] || <User {...iconProps}/>;
  return (
    <div style={{ width: size, height: size, borderRadius: '50%', background: '#6B21E8', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
      {icon}
    </div>
  );
}

function ResumeDoc({ content, profile }) {
  const [parsed, setParsed] = useState(() => parseResumeDoc(content));
  useEffect(() => { setParsed(parseResumeDoc(content)); }, [content]);

  const titleLines  = parsed.headerLines.filter(h => h.type === 'title');
  const contactLines = parsed.headerLines.filter(h => h.type === 'contact');
  const contactItems = [];
  if (contactLines.length > 0) {
    contactLines.forEach(h => h.text.split(/\s*[|·•]\s*/).filter(Boolean).forEach(p => { if (p.trim()) contactItems.push(p.trim()); }));
  } else if (profile) {
    if (profile.location)      contactItems.push(profile.location);
    if (profile.email_address) contactItems.push(profile.email_address);
    if (profile.phone)         contactItems.push(profile.phone);
    if (profile.linkedin)      contactItems.push(profile.linkedin);
    if (profile.portfolio)     contactItems.push(profile.portfolio);
  }

  const ACC  = '#6B21E8';
  const ABGC = '#F3EEFF';
  const DARK = '#1F2937';
  const BODY = '#374151';
  const DATE = '#4B5563';
  const SEP  = '#DDD6FE';

  return (
    <div style={{ background: '#fff', border: `1px solid ${C.border}`, borderRadius: 8, maxHeight: 600, overflowY: 'auto', fontFamily: "Calibri,'Helvetica Neue',Arial,sans-serif", fontSize: 13, lineHeight: 1.5, color: '#111' }}>

      {/* ── Header: name + title + contacts — all on accentBg per blueprint ── */}
      {(parsed.name || titleLines.length > 0 || contactItems.length > 0) && (
        <div style={{ background: ABGC, borderRadius: 16, margin: '0 0 30px 0', padding: '4px 40px 4px', textAlign: 'center' }}>
          {parsed.name && (
            <div style={{ fontSize: 55, fontWeight: 800, color: ACC, textTransform: 'uppercase', letterSpacing: '0.05em', lineHeight: 1.0, marginBottom: 0 }}>
              {parsed.name}
            </div>
          )}
          {titleLines.map((h, i) => (
            <div key={i} style={{ fontSize: 23, fontWeight: 400, color: DARK, lineHeight: 1.0, marginBottom: 4 }}>{h.text}</div>
          ))}
          {contactItems.length > 0 && (
            <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: '6px 24px' }}>
              {contactItems.filter(Boolean).map((ci, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, color: BODY }}>
                  <ContactIcon type={detectContactType(ci, resolveCountry(profile?.country))} size={15} color={ACC}/>
                  <span style={{ borderBottom: `1.5px solid ${ACC}`, paddingBottom: 1, lineHeight: 1.3 }}>{ci}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Sections ── */}
      {parsed.sections.map((sec, si) => {
        const iconType  = getSectionIconType(sec.title);
        const isBodySec = /summary|objective|profile|about|skills?|language/i.test(sec.title);
        const isExpSec  = /experience|work|employment|career|relevant|internship|volunteer/i.test(sec.title);
        const isEduSec  = /education|academic|university|college|school/i.test(sec.title);

        // Build experience timeline entry groups
        let expEntries = null;
        if (isExpSec) {
          expEntries = [];
          let cur = null;
          sec.items.forEach(item => {
            if (item.type === 'gap') {
              if (cur) expEntries.push(cur);
              cur = null;
              expEntries.push({ isSep: true });
            } else if (item.type === 'roleHeader') {
              if (cur) expEntries.push(cur);
              cur = { header: item, location: null, bullets: [] };
            } else if (cur && !cur.location && !cur.bullets.length && item.type === 'text') {
              cur.location = item.text;
            } else if (cur && item.type === 'bullet') {
              cur.bullets.push({ isText: false, text: item.text });
            } else if (cur && item.type === 'text') {
              cur.bullets.push({ isText: true, text: item.text });
            } else {
              expEntries.push({ isSingle: true, item });
            }
          });
          if (cur) expEntries.push(cur);
          while (expEntries.length && expEntries[expEntries.length - 1].isSep) expEntries.pop();
        }

        return (
          <div key={si}>
            {/* Section bar: accentBg + filled circle icon + uppercase title */}
            <div style={{ background: ABGC, padding: '7px 20px', display: 'flex', alignItems: 'center', gap: 10 }}>
              <SectionCircleIcon type={iconType} size={26}/>
              <span style={{ fontSize: 11, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.09em', color: ACC }}>
                {sec.title}
              </span>
            </div>

            {/* Section content */}
            <div style={{ padding: '8px 24px 6px' }}>

              {/* ── Experience: timeline layout ── */}
              {isExpSec && expEntries ? (
                expEntries.map((entry, ei) => {
                  if (entry.isSep) return (
                    <div key={ei} style={{ borderTop: `1px dashed ${SEP}`, margin: '8px 0' }}/>
                  );
                  if (entry.isSingle) {
                    const it = entry.item;
                    if (it.type === 'bullet') return (
                      <div key={ei} style={{ display: 'flex', gap: 7, fontSize: 12.5, color: BODY, marginBottom: 3, paddingLeft: 20 }}>
                        <span style={{ flexShrink: 0, color: ACC, fontSize: 15, lineHeight: '1.3' }}>•</span>
                        <span>{it.text}</span>
                      </div>
                    );
                    return <div key={ei} style={{ fontSize: 12.5, color: BODY, marginBottom: 3 }}>{it.text}</div>;
                  }
                  const { left, date } = extractRoleDate(entry.header.text);
                  const { role, company } = splitRoleAndCompany(left);
                  return (
                    <div key={ei} style={{ position: 'relative', borderLeft: `2px solid ${ACC}`, paddingLeft: 16, marginLeft: 6, paddingTop: 6, paddingBottom: 4, marginBottom: 2 }}>
                      {/* Timeline dot */}
                      <div style={{ position: 'absolute', left: -5, top: 9, width: 9, height: 9, borderRadius: '50%', background: ACC }}/>
                      {/* Role | Company row + date/location */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 5 }}>
                        <div style={{ fontWeight: 700, fontSize: 13, color: DARK, lineHeight: 1.3 }}>
                          {role}
                          {company && (
                            <><span style={{ fontWeight: 400, color: BODY }}> | </span><em style={{ fontStyle: 'italic', color: ACC, fontWeight: 400 }}>{company}</em></>
                          )}
                        </div>
                        {(date || entry.location) && (
                          <div style={{ textAlign: 'right', flexShrink: 0, lineHeight: 1.4 }}>
                            {date     && <div style={{ fontSize: 11.5, color: DATE, whiteSpace: 'nowrap' }}>{date}</div>}
                            {entry.location && <div style={{ fontSize: 11.5, color: DATE, whiteSpace: 'nowrap' }}>{entry.location}</div>}
                          </div>
                        )}
                      </div>
                      {/* Bullets */}
                      {entry.bullets.map((b, bi) =>
                        b.isText ? (
                          <div key={bi} style={{ fontSize: 12.5, color: BODY, marginBottom: 3 }}>{b.text}</div>
                        ) : (
                          <div key={bi} style={{ display: 'flex', gap: 7, fontSize: 12.5, color: BODY, marginBottom: 3 }}>
                            <span style={{ flexShrink: 0, color: ACC, fontSize: 15, lineHeight: '1.3' }}>•</span>
                            <span>{b.text}</span>
                          </div>
                        )
                      )}
                    </div>
                  );
                })
              ) : (
                /* ── All other sections ── */
                (() => {
                  const elements = [];
                  const items = sec.items;
                  for (let ii = 0; ii < items.length; ii++) {
                    const item = items[ii];

                    if (item.type === 'gap') {
                      elements.push(<div key={ii} style={{ borderTop: `1px dashed ${SEP}`, margin: '6px 0' }}/>);
                      continue;
                    }

                    if (item.type === 'roleHeader') {
                      const { left, date } = extractRoleDate(item.text);
                      const { role, company } = splitRoleAndCompany(left);
                      // Body sections (summary, skills, languages): treat header text as plain body
                      if (isBodySec || (!company && !date && role.length > 60)) {
                        elements.push(<div key={ii} style={{ fontSize: 12.5, color: BODY, marginBottom: 5, lineHeight: 1.6 }}>{item.text}</div>);
                        continue;
                      }
                      // Consume next text item as location
                      let location = null;
                      if (ii + 1 < items.length && items[ii + 1].type === 'text') { location = items[ii + 1].text; ii++; }

                      if (isEduSec) {
                        // Education: degree left, date+location right, institution italic below
                        elements.push(
                          <div key={ii} style={{ marginTop: 6, marginBottom: 6 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                              <div style={{ fontWeight: 700, fontSize: 13, color: DARK }}>{role}</div>
                              {(date || location) && (
                                <div style={{ textAlign: 'right', flexShrink: 0, lineHeight: 1.4 }}>
                                  {date     && <div style={{ fontSize: 11.5, color: DATE, whiteSpace: 'nowrap' }}>{date}</div>}
                                  {location && <div style={{ fontSize: 11.5, color: DATE, whiteSpace: 'nowrap' }}>{location}</div>}
                                </div>
                              )}
                            </div>
                            {company && <div style={{ fontSize: 12.5, color: ACC, fontStyle: 'italic', marginTop: 2 }}>{company}</div>}
                          </div>
                        );
                      } else {
                        // Generic (projects, certs, etc.): name left, year right, company italic below
                        elements.push(
                          <div key={ii} style={{ marginTop: 6, marginBottom: 4 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
                              <div style={{ fontWeight: 700, fontSize: 13, color: DARK }}>{role}</div>
                              {date && <span style={{ fontSize: 11.5, color: DATE, whiteSpace: 'nowrap', flexShrink: 0 }}>{date}</span>}
                            </div>
                            {company  && <div style={{ fontSize: 12.5, color: ACC, fontStyle: 'italic', marginTop: 1 }}>{company}</div>}
                            {location && <div style={{ fontSize: 11.5, color: DATE, marginTop: 1 }}>{location}</div>}
                          </div>
                        );
                      }
                      continue;
                    }

                    if (item.type === 'bullet') {
                      elements.push(
                        <div key={ii} style={{ display: 'flex', gap: 7, fontSize: 12.5, color: BODY, marginBottom: 3, paddingLeft: 4 }}>
                          <span style={{ flexShrink: 0, color: ACC, fontSize: 15, lineHeight: '1.3' }}>•</span>
                          <span style={{ minWidth: 0 }}>{item.text}</span>
                        </div>
                      );
                      continue;
                    }

                    // Plain text item
                    const isEduAccent = isEduSec && !/^\d{4}$|^GPA/i.test(item.text.trim());
                    elements.push(
                      <div key={ii} style={{ fontSize: 12.5, color: isEduAccent ? ACC : BODY, fontStyle: isEduAccent ? 'italic' : 'normal', marginBottom: 3 }}>
                        {item.text}
                      </div>
                    );
                  }
                  return elements;
                })()
              )}
            </div>
          </div>
        );
      })}

      {!parsed.name && parsed.sections.length === 0 && (
        <div style={{ padding: '14px 24px', whiteSpace: 'pre-wrap', fontSize: 13, color: C.text }}>{content}</div>
      )}
    </div>
  );
}

// Clipboard copy that preserves paragraph structure for Word/Gmail/Docs.
// Uses copyToClipboard (has execCommand fallback) instead of navigator.clipboard directly.
function copyResumeToClipboard(content) {
  const parsed = parseResumeDoc(content);
  const text = resumeDocToHTML(parsed, true);
  return copyToClipboard(text);
}

// ─── RESET PASSWORD PAGE ───────────────────────────────────
function ResetPasswordPage({ onDone, t }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const handle = async () => {
    if (!password) { setError(t("auth.resetPasswordRequired")); return; }
    if (password.length < 6) { setError(t("auth.resetPasswordTooShort")); return; }
    if (password !== confirm) { setError(t("auth.resetPasswordMismatch")); return; }
    setLoading(true); setError("");
    const { error: err } = await supabase.auth.updateUser({ password });
    setLoading(false);
    if (err) { setError(err.message); return; }
    setSuccess(true);
    // Sign out so the user must log in fresh with their new password.
    await supabase.auth.signOut().catch(() => {});
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bgSoft, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}><Logo size={56} /></div>
          <AppName size={26} />
        </div>
        <Card>
          {success ? (
            <div style={{ textAlign: "center", padding: "12px 0" }}>
              <div style={{ fontSize: 36, marginBottom: 12 }}>✅</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("auth.resetSuccessTitle")}</div>
              <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 20 }}>{t("auth.resetSuccessBody")}</div>
              <Btn style={{ width: "100%", justifyContent: "center", padding: "13px" }} onClick={onDone}>{t("auth.resetGoToSignIn")}</Btn>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 4 }}>{t("auth.resetTitle")}</div>
              <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 20 }}>{t("auth.resetSubtitle")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <Input label={t("auth.resetNewPasswordLabel")} type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && handle()} />
                <Input label={t("auth.resetConfirmPasswordLabel")} type="password" placeholder="••••••••" value={confirm} onChange={e => setConfirm(e.target.value)} onKeyDown={e => e.key === "Enter" && handle()} />
              </div>
              {error && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, color: C.red, fontSize: 13, marginTop: 14 }}>{error}</div>}
              <div style={{ marginTop: 20 }}>
                <Btn onClick={handle} loading={loading} style={{ width: "100%", justifyContent: "center", padding: "13px 22px" }}>
                  {loading ? t("auth.resetSaving") : t("auth.resetSaveBtn")}
                </Btn>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

// ─── AUTH PAGE ─────────────────────────────────────────────
function AuthPage({ t }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ email: "", password: "", name: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [confirmPending, setConfirmPending] = useState(false);
  const [forgotPassword, setForgotPassword] = useState(false);
  const [forgotEmail, setForgotEmail] = useState("");
  const [forgotSent, setForgotSent] = useState(false);
  const [forgotLoading, setForgotLoading] = useState(false);
  const [forgotError, setForgotError] = useState("");

  const handle = async () => {
    if (!form.email) { setError(t("auth.emailRequired")); return; }
    if (!form.password) { setError(t("auth.passwordRequired")); return; }
    if (mode === "signup" && !form.name) { setError(t("auth.nameRequired")); return; }
    setLoading(true); setError("");
    const { data, error: authError } =
      mode === "login"
        ? await supabase.auth.signInWithPassword({ email: form.email, password: form.password })
        : await supabase.auth.signUp({ email: form.email, password: form.password, options: { data: { full_name: form.name }, emailRedirectTo: window.location.origin } });
    setLoading(false);
    if (authError) {
      console.error("[Auth] signUp/signIn error:", authError);
      const detail = [authError.message, authError.status ? `(HTTP ${authError.status})` : null].filter(Boolean).join(" ");
      setError(detail);
      return;
    }
    if (mode === "signup" && !data.session) { setConfirmPending(true); return; }
    // onAuthStateChange (in useAuth) picks up the new session and populates the profile;
    // App re-renders past AuthPage once `user` is set.
  };

  const handleGoogle = async () => {
    setLoading(true); setError("");
    const { error: authError } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: { redirectTo: window.location.origin },
    });
    if (authError) { setLoading(false); setError(authError.message); }
    // On success the browser redirects away — no further code runs here.
  };

  const handleForgot = async () => {
    if (!forgotEmail.trim()) { setForgotError(t("auth.forgotEmailRequired")); return; }
    setForgotLoading(true); setForgotError("");
    const { error: err } = await supabase.auth.resetPasswordForEmail(forgotEmail.trim(), {
      redirectTo: window.location.origin,
    });
    setForgotLoading(false);
    if (err) { setForgotError(err.message); return; }
    setForgotSent(true);
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bgSoft, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}><Logo size={56} /></div>
          <AppName size={26} />
          <div style={{ fontSize: 14, color: C.textMuted, marginTop: 10 }}>{t("auth.tagline")}</div>
        </div>
        <Card>
          {/* ── Forgot password flow ── */}
          {forgotPassword ? (
            forgotSent ? (
              <div style={{ textAlign: "center", padding: "12px 0" }}>
                <div style={{ fontSize: 32, marginBottom: 12 }}>📧</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("auth.checkEmailTitle")}</div>
                <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 20 }}>
                  {(() => { const [pre, post] = t("auth.forgotSentBody").split("{email}"); return <>{pre}<strong>{forgotEmail}</strong>{post}</>; })()}
                </div>
                <Btn variant="secondary" style={{ width: "100%", justifyContent: "center", padding: "13px" }} onClick={() => { setForgotPassword(false); setForgotSent(false); setForgotEmail(""); setForgotError(""); }}>
                  {t("auth.forgotBackBtn")}
                </Btn>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 4 }}>{t("auth.forgotTitle")}</div>
                <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 20 }}>{t("auth.forgotSubtitle")}</div>
                <Input label={t("auth.forgotEmailLabel")} type="email" placeholder="you@email.com" value={forgotEmail} onChange={e => setForgotEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && handleForgot()} />
                {forgotError && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, color: C.red, fontSize: 13, marginTop: 14 }}>{forgotError}</div>}
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 20 }}>
                  <Btn onClick={handleForgot} loading={forgotLoading} style={{ width: "100%", justifyContent: "center", padding: "13px 22px" }}>
                    {forgotLoading ? t("auth.forgotSending") : t("auth.forgotSendBtn")}
                  </Btn>
                  <Btn variant="secondary" style={{ width: "100%", justifyContent: "center", padding: "13px" }} onClick={() => { setForgotPassword(false); setForgotError(""); }}>
                    {t("auth.forgotBackBtn")}
                  </Btn>
                </div>
              </>
            )
          ) : confirmPending ? (
            /* ── Email confirmation pending ── */
            <div style={{ textAlign: "center", padding: "12px 0" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>📧</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("auth.checkEmailTitle")}</div>
              <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 20 }}>
                {(() => { const [pre, post] = t("auth.checkEmailBody").split("{email}"); return <>{pre}<strong>{form.email}</strong>{post}</>; })()}
              </div>
              <Btn variant="secondary" style={{ width: "100%", justifyContent: "center", padding: "13px" }} onClick={() => { setConfirmPending(false); setMode("login"); }}>{t("auth.backToSignIn")}</Btn>
            </div>
          ) : (
            /* ── Normal sign-in / sign-up ── */
            <>
              <div style={{ display: "flex", gap: 3, background: C.bgSoft, borderRadius: 10, padding: 3, marginBottom: 22 }}>
                {["login","signup"].map(m => <Btn key={m} variant="ghost" style={{ flex: 1, padding: "9px", borderRadius: 7, border: "none", background: mode === m ? "#fff" : "transparent", color: mode === m ? C.text : C.textMuted, fontSize: 13, fontWeight: 700, boxShadow: mode === m ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }} onClick={() => { setMode(m); setError(""); }}>{m === "login" ? t("auth.signIn") : t("auth.signUp")}</Btn>)}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                {mode === "signup" && <Input label={t("auth.fullNameLabel")} placeholder={t("auth.fullNamePlaceholder")} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />}
                <Input label={t("auth.emailLabel")} type="email" placeholder="you@email.com" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} onKeyDown={e => e.key === "Enter" && handle()} />
                <Input label={t("auth.passwordLabel")} type="password" placeholder="••••••••" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} onKeyDown={e => e.key === "Enter" && handle()} />
              </div>
              {mode === "login" && (
                <div style={{ textAlign: "right", marginTop: 8 }}>
                  <button onClick={() => { setForgotPassword(true); setForgotEmail(form.email); setError(""); }} style={{ background: "none", border: "none", color: C.purple, fontSize: 13, cursor: "pointer", fontWeight: 600, padding: 0, fontFamily: "inherit" }}>
                    {t("auth.forgotPasswordLink")}
                  </button>
                </div>
              )}
              {error && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, color: C.red, fontSize: 13, marginTop: 14 }}>{error}</div>}
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 20 }}>
                <Btn onClick={handle} loading={loading} style={{ width: "100%", justifyContent: "center", padding: "13px 22px" }}>
                  {loading ? t("auth.pleaseWait") : mode === "login" ? t("auth.signIn") : t("auth.createAccount")}
                </Btn>
                <Btn variant="secondary" style={{ width: "100%", justifyContent: "center", padding: "13px" }} onClick={handleGoogle} loading={loading}>
                  <span style={{ fontWeight: 800, color: C.blue, fontSize: 15 }}>G</span> {t("auth.continueWithGoogle")}
                </Btn>
              </div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

// Returns true when an ISO timestamp string falls on today's local date.
const isToday = (iso) => !!iso && iso.slice(0, 10) === new Date().toISOString().slice(0, 10);

// ─── BRIEFING PAYLOAD BUILDER (shared by DashboardPage + BriefingPage) ──────
async function buildBriefingPayload(ctx, appLanguage) {
  const prompt = `You are CareerPersona AI. Generate a personalized daily briefing based on this user's career data. Be specific, actionable, and encouraging. Return ONLY valid JSON, no markdown:\n{"v":2,"summary":"1-2 personalized sentences about career status today","newMatchingJobs":"1 sentence about job opportunities in their target role","highestPayingJobs":"1 sentence about highest-paying opportunities for their skills","jobsClosingSoon":"1 sentence about application urgency or follow-up timing","priorityRecommendation":"1 specific actionable task for today based on their data","companiesHiringNow":"1 sentence about active hiring in their target sector","newOpportunities":"1 sentence about emerging roles or adjacent opportunities","resumeUpdates":"1 sentence about resume quality, keyword coverage, or professional readiness — do NOT promise ATS score gains","atsScoreChanges":"1 sentence about resume strength and optimization progress","interviewInvitations":"1 sentence about interview prep or pipeline status","recruiterActivity":"1 sentence about recruiter visibility and profile tips","applicationUpdates":"1 sentence about application pipeline and follow-up strategy","salaryChanges":"1 sentence about salary trends for their role and location","marketUpdates":"1 sentence about job market conditions in their field","careerInsights":"1 strategic career insight specific to their situation","dailyHighlights":["short actionable highlight 1","short actionable highlight 2","short actionable highlight 3"]}\nUser data: ${ctx}`;
  const raw = await askClaude(withAppLanguage(prompt, appLanguage), 1600);
  let result;
  try {
    const s = raw.indexOf("{"); const e = raw.lastIndexOf("}");
    const parsed = s >= 0 && e > s ? JSON.parse(raw.slice(s, e + 1)) : null;
    result = parsed?.v === 2 ? { ...parsed, generatedAt: new Date().toISOString() } : null;
  } catch { result = null; }
  return result || {
    v: 2, generatedAt: new Date().toISOString(),
    summary: "Your career journey is underway with CareerPersona AI. Complete your profile and explore jobs to unlock personalized daily insights.",
    newMatchingJobs: "Search for jobs matching your target role to see new opportunities added daily in your field.",
    highestPayingJobs: "Run a salary analysis to discover the highest-paying roles available for your experience level.",
    jobsClosingSoon: "Save jobs you're interested in and apply promptly — competitive roles often close within days.",
    priorityRecommendation: "Complete your career profile to 100% — it unlocks all personalized AI features.",
    companiesHiringNow: "Use Job Search to discover which companies are actively hiring in your target sector this week.",
    newOpportunities: "New opportunities emerge daily — consistent job searching is the most effective strategy.",
    resumeUpdates: "Upload your resume to get an instant ATS score and keyword optimization recommendations.",
    atsScoreChanges: "A resume with 85%+ ATS compatibility gets significantly more interview callbacks.",
    interviewInvitations: "Practice interview questions daily to build confidence and improve your response quality.",
    recruiterActivity: "Keep your profile complete and updated to stay visible to recruiters in your field.",
    applicationUpdates: "Track all applications in the Tracker to manage follow-ups and never miss an opportunity.",
    salaryChanges: "Research market salaries before your next negotiation to ensure you receive fair compensation.",
    marketUpdates: "Your target job market is active — consistent daily applications yield the best results.",
    careerInsights: "Candidates who tailor their resume for each application get 3× more interview invitations.",
    dailyHighlights: ["Complete your profile to unlock personalized recommendations", "Upload your resume for an AI-powered ATS score", "Search and save your top job matches"]
  };
}

// ─── LANGUAGE HELPERS ────────────────────────────────────────────────────────

const LANG_NAMES = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian",
  pt: "Portuguese", nl: "Dutch", tr: "Turkish", ar: "Arabic", ru: "Russian",
  hi: "Hindi", zh: "Chinese", ja: "Japanese", ko: "Korean",
};

// Append App Language instruction at end of any prompt (security: always last)
function withAppLanguage(prompt, appLanguage) {
  if (!appLanguage || appLanguage === "en") return prompt;
  const name = LANG_NAMES[appLanguage] || appLanguage;
  return `${prompt}\n\nIMPORTANT: Respond entirely in ${name}. All explanations, analysis, coaching, and output must be written in ${name}.`;
}

// Dual-language: App Language for conversation, Resume Language for document content.
// When they match, falls back to withAppLanguage.
function withDualLanguage(prompt, appLanguage, resumeLanguage) {
  const docLang = resumeLanguage || appLanguage || "en";
  const appLang = appLanguage || "en";
  if (docLang === appLang) return withAppLanguage(prompt, appLang);
  const appName = LANG_NAMES[appLang] || appLang;
  const docName = LANG_NAMES[docLang] || docLang;
  let suffix = "\n\nIMPORTANT LANGUAGE RULES:";
  suffix += `\n- Write ALL resume document content in ${docName}.`;
  if (appLang !== "en") suffix += `\n- Write ALL explanations, coaching, and responses to the user in ${appName}.`;
  return prompt + suffix;
}

// Lightweight language detection — no external deps, Unicode + stop-word scoring.
// Returns { lang: string|null, confidence: number 0-1 }.
function detectResumeLanguage(text) {
  if (!text?.trim() || text.trim().length < 60) return { lang: null, confidence: 0 };
  const sample = text.slice(0, 3000);
  const nonSpace = sample.replace(/\s+/g, "").length;
  if (nonSpace < 30) return { lang: null, confidence: 0 };

  // Non-Latin scripts: character frequency is highly distinctive
  const scriptRanges = [
    { code: "ar", re: /[؀-ۿ]/g },
    { code: "zh", re: /[一-鿿㐀-䶿]/g },
    { code: "ja", re: /[぀-ヿ]/g },
    { code: "ko", re: /[가-퟿]/g },
    { code: "ru", re: /[Ѐ-ӿ]/g },
    { code: "hi", re: /[ऀ-ॿ]/g },
  ];
  for (const { code, re } of scriptRanges) {
    const cnt = (sample.match(re) || []).length;
    if (cnt / nonSpace > 0.08) return { lang: code, confidence: Math.min(0.97, 0.82 + (cnt / nonSpace) * 0.8) };
  }

  // Latin-script: distinctive diacritics + stop-word scoring
  const lower = sample.toLowerCase();
  const words = lower.match(/\b[a-zA-ZÀ-ÿ]{2,}\b/g) || [];
  if (words.length < 15) return { lang: "en", confidence: 0.5 };

  const scores = { en: 0, es: 0, fr: 0, de: 0, it: 0, pt: 0, nl: 0, tr: 0 };
  if (/[ßüöäÜÖÄ]/.test(sample)) scores.de += 8;
  if (/[ğşıİĞŞ]/.test(sample)) scores.tr += 8;
  if (/[ãõÃÕ]/.test(sample)) scores.pt += 5;
  if (/[àâæœÀÂÆŒ]/.test(sample) && !/[ãõ]/.test(sample)) scores.fr += 4;
  if (/[ñÑ]/.test(sample)) scores.es += 4;

  const stopWords = {
    en: ["the","and","for","with","in","at","on","my","work","skills","experience","years","company","education"],
    es: ["que","los","las","del","una","por","con","también","experiencia","trabajo","empresa","habilidades","años","educación"],
    fr: ["les","des","une","pour","dans","avec","sur","expérience","compétences","formation","entreprise","travail"],
    de: ["und","der","die","das","für","mit","ich","wir","berufserfahrung","kenntnisse","fähigkeiten","unternehmen","ausbildung"],
    it: ["che","per","con","una","delle","anche","lavoro","esperienza","competenze","anni","azienda","formazione"],
    pt: ["que","para","com","uma","dos","das","também","experiência","empresa","habilidades","anos","trabalho","educação"],
    nl: ["voor","van","het","een","met","ook","ervaring","vaardigheden","bedrijf","opleiding","werk"],
    tr: ["için","bir","ile","bu","deneyim","beceriler","yetenek","şirket","eğitim","yıl","çalışma"],
  };
  for (const w of words) {
    for (const [lang, wl] of Object.entries(stopWords)) {
      if (wl.includes(w)) scores[lang]++;
    }
  }

  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestLang, bestScore] = sorted[0];
  const secondScore = sorted[1]?.[1] || 0;
  if (bestScore === 0) return { lang: "en", confidence: 0.5 };
  const ratio = secondScore > 0 ? bestScore / secondScore : 5;
  const conf = Math.min(0.92, 0.46 + Math.min(0.36, (ratio - 1) * 0.1) + Math.min(0.1, bestScore * 0.004));
  return { lang: bestLang, confidence: conf };
}

// Country → primary job-market language. Conservative: only clear single-dominant-language markets.
// Multilingual countries (Switzerland, Belgium, India) are intentionally omitted to avoid false positives.
// Keyed by ISO 3166-1 alpha-2 country code (matches searchCountry, which
// comes from JobSearchPage's filters.country — see JS_COUNTRY_OPTIONS).
const COUNTRY_LANG = {
  DE: "de", AT: "de",
  FR: "fr",
  ES: "es", MX: "es", AR: "es", CO: "es", CL: "es",
  IT: "it",
  PT: "pt", BR: "pt",
  NL: "nl",
  TR: "tr",
  JP: "ja",
  KR: "ko",
  RU: "ru",
  CN: "zh",
  SA: "ar", AE: "ar",
};

// Returns the language code to suggest, or null.
// Decision priority: job posting text → search country → job language preference.
// Only fires when resume confidence ≥ 0.72 and resume language ≠ resolved target language.
function computeLanguageSuggestion({ resume, jobLanguage, jobDesc, searchCountry }) {
  if (!resume) return null;
  if ((resume.language_confidence ?? 0) < 0.72) return null;
  const resumeLang = resume.language || resume.detected_language;
  if (!resumeLang) return null;

  // Resolve target language from highest-priority available signal
  let targetLang = null;

  // 1. Job description text — detect language of the actual posting the user pasted.
  //    Only attempt detection if there's enough text for the stop-word scorer to be reliable.
  if (jobDesc && jobDesc.trim().length > 80) {
    const { lang, confidence } = detectResumeLanguage(jobDesc);
    if (lang && confidence >= 0.60) targetLang = lang;
  }

  // 2. Search country → primary job-market language (only used when no posting text is available)
  if (!targetLang && searchCountry) {
    targetLang = COUNTRY_LANG[searchCountry] || null;
  }

  // 3. User's explicit job language preference
  if (!targetLang) targetLang = jobLanguage || "en";

  if (resumeLang === targetLang) return null;
  return targetLang;
}

function tPlanCat(id, t, fallback) {
  const m = { priorities: "plan.catPriorities", applications: "plan.catApplications", resume: "plan.catResume", interview: "plan.catInterview" };
  return m[id] ? t(m[id]) : (fallback || id);
}

function tStatusVal(val, t) {
  if (!val) return val;
  const m = {
    "Excellent": "common.statusExcellent", "Strong": "common.statusStrong", "Good": "common.statusGood",
    "Fair": "common.statusFair", "Limited": "common.statusLimited", "Consistent": "common.statusConsistent",
    "Moderate": "common.statusModerate", "Developing": "common.statusDeveloping", "Focused": "common.statusFocused",
    "Aligned": "common.statusAligned", "Broad": "common.statusBroad", "Scattered": "common.statusScattered",
    "Needs Focus": "common.statusNeedsFocus", "Improving": "common.statusImproving", "Stable": "common.statusStable",
    "Needs Review": "common.statusNeedsReview", "Building": "common.statusBuilding",
    "Above Average": "common.statusAboveAverage", "Average": "common.statusAverage", "Below Average": "common.statusBelowAverage",
    "Exploding": "common.statusExploding", "High": "common.statusHigh", "Growing": "common.statusGrowing", "Low": "common.statusLow",
    "Very Good": "common.statusVeryGood", "Needs Improvement": "common.statusNeedsImprovement", "Poor": "common.statusPoor",
  };
  return m[val] ? t(m[val]) : val;
}

// ─── PLAN PAYLOAD BUILDER (shared by DashboardPage + PlanPage) ───────────────
async function buildPlanPayload(ctx, appLanguage) {
  const prompt = `You are CareerPersona AI. Generate today's personalized action plan for this job seeker. Be specific and data-driven. Return ONLY valid JSON, no markdown:\n{"v":2,"productivityScore":<integer 0-100 based on career activity and progress>,"categories":[{"id":"priorities","category":"Today's Priorities","task":"<one specific actionable sentence for today>","time":"<e.g. 15 min>","status":"pending"},{"id":"applications","category":"Recommended Applications","task":"<one specific sentence about which jobs to apply to today>","time":"<e.g. 30 min>","status":"pending"},{"id":"resume","category":"Resume Improvements","task":"<one specific sentence about resume quality, writing, or professional readiness — do NOT promise ATS score gains or specific point improvements>","time":"<e.g. 20 min>","status":"pending"},{"id":"interview","category":"Interview Practice","task":"<if interview data: specific prep task; if not: skill-building task>","time":"<e.g. 45 min>","status":"pending"}],"followUps":"<1 sentence about specific follow-up actions>","networking":"<1 sentence about specific networking task>","certifications":"<1 sentence recommending a specific certification relevant to the user's target role and industry — be concrete (e.g. AWS Solutions Architect, PMP, Security+, ISTQB, Google Cloud, Azure, Scrum, CPA) and suggest how to take the first step today>"}\nUser data: ${ctx}`;
  const raw = await askClaude(withAppLanguage(prompt, appLanguage), 900);
  let result;
  try {
    const s = raw.indexOf("{"); const e = raw.lastIndexOf("}");
    const parsed = s >= 0 && e > s ? JSON.parse(raw.slice(s, e + 1)) : null;
    result = parsed?.v === 2 && Array.isArray(parsed?.categories) ? { ...parsed, generatedAt: new Date().toISOString() } : null;
  } catch { result = null; }
  return result || {
    v: 2, generatedAt: new Date().toISOString(), productivityScore: 60,
    categories: [
      { id: "priorities", category: "Today's Priorities", task: "Complete your career profile to 100% to unlock all personalized AI recommendations.", time: "10 min", status: "pending" },
      { id: "applications", category: "Recommended Applications", task: "Search for jobs matching your target role and save at least 3 strong matches to apply today.", time: "30 min", status: "pending" },
      { id: "resume", category: "Resume Improvements", task: "Upload your resume to get an AI-powered ATS score and keyword optimization report.", time: "15 min", status: "pending" },
      { id: "interview", category: "Interview Practice", task: "Practice 5 STAR method behavioral responses to build interview confidence and readiness.", time: "20 min", status: "pending" }
    ],
    followUps: "Check your application tracker and send follow-up emails to any applications older than 5 business days.",
    networking: "Connect with 1 professional in your target industry and send a personalized introduction message.",
    certifications: "Research an in-demand certification for your target role — visit the official site today to review the requirements and exam format."
  };
}

// ─── CAREER PROGRESS PAYLOAD BUILDER ─────────────────────────────────────────
async function buildCareerProgressPayload(ctx, careerGoal, careerTimeline, t) {
  const goalLine = careerGoal ? `Career Goal: ${careerGoal}.${careerTimeline ? ` Target Timeline: ${careerTimeline}.` : ""}` : "No career goal set yet.";
  const raw = await askClaude(`You are CareerPersona AI. Assess this user's career progress against their stated goal. Be honest, specific, and actionable. Return ONLY valid JSON, no markdown:\n{"v":1,"progressPercent":<integer 0-100 based on how far they are toward their career goal given their current data>,"careerHealth":"excellent|good|fair|needs_attention","assessment":"<2-3 sentences: where they are today relative to their goal, what's working>","blockers":[{"issue":"<specific blocker>","priority":"high|medium|low","detail":"<1 sentence on how to address it>"}],"nextMilestone":"<the single most impactful next step they should take>","skills":[{"name":"<skill name relevant to their target role>","level":"advanced|intermediate|beginner","gap":"<one specific sentence on what to improve, or null if already strong>"}]}\nUser data: ${ctx}\n${goalLine}\nProvide 4-6 skills most critical for their target role, ordered by importance.`, 1000);
  let result;
  try {
    const s = raw.indexOf("{"); const e = raw.lastIndexOf("}");
    const parsed = s >= 0 && e > s ? JSON.parse(raw.slice(s, e + 1)) : null;
    result = parsed?.v === 1 ? { ...parsed, generatedAt: new Date().toISOString() } : null;
  } catch { result = null; }
  return result || {
    v: 1, generatedAt: new Date().toISOString(),
    progressPercent: 10,
    careerHealth: "fair",
    assessment: t ? t("progress.fallbackAssessment") : "Set your career goal in your profile to unlock a personalized AI progress assessment. The more data you add, the more accurate your progress tracking becomes.",
    blockers: [{ issue: t ? t("progress.fallbackBlockerIssue") : "Career goal not defined", priority: "high", detail: t ? t("progress.fallbackBlockerDetail") : "Set your target role, goal, and timeline in your profile to enable AI progress tracking." }],
    nextMilestone: t ? t("progress.fallbackMilestone") : "Complete your career profile with a specific goal and target timeline.",
    skills: []
  };
}

// ─── JOB INTELLIGENCE PAYLOAD BUILDER ────────────────────────────────────────
async function buildJobIntelligencePayload(profile, savedJobs, applications) {
  const saved = savedJobs ?? [];
  const apps = applications ?? [];

  // ── Pre-compute five isolated data summaries (one per analysis) ───────────
  // Each summary contains ONLY the inputs relevant to that specific analysis.
  // This prevents Claude from cross-referencing sections during generation.

  // Analysis 1 — Market Patterns: saved job search behavior only
  const titles = [...new Set(saved.map(j => j.title).filter(Boolean))].slice(0, 15);
  const companies = [...new Set(saved.map(j => j.company).filter(Boolean))].slice(0, 12);
  const locations = [...new Set(saved.map(j => j.location).filter(Boolean))].slice(0, 8);
  const remoteCount = saved.filter(j => j.remote).length;
  const empTypes = [...new Set(saved.map(j => j.employmentType).filter(Boolean))];
  const salaryMins = saved.filter(j => j.salaryMin).map(j => j.salaryMin);
  const salaryMaxs = saved.filter(j => j.salaryMax).map(j => j.salaryMax);
  const salaryRange = salaryMins.length ? `$${Math.round(Math.min(...salaryMins) / 1000)}K–$${Math.round(Math.max(...salaryMaxs) / 1000)}K` : "not specified";
  const d1 = [
    `Saved jobs: ${saved.length}.`,
    titles.length ? `Role types saved: ${titles.join(", ")}.` : "No roles saved.",
    companies.length ? `Companies: ${companies.join(", ")}.` : "",
    locations.length ? `Locations: ${locations.join(", ")}.` : "",
    `Work model: ${remoteCount} remote, ${saved.length - remoteCount} on-site/hybrid.`,
    empTypes.length ? `Employment types: ${empTypes.join(", ")}.` : "",
    `Salary range observed: ${salaryRange}.`,
  ].filter(Boolean).join(" ");

  // Analysis 2 — Employer Demand: skill signals from job description text only
  const SKILL_TOKENS = ["python","javascript","typescript","react","node.js","vue","angular","next.js","aws","azure","gcp","docker","kubernetes","terraform","sql","postgresql","mongodb","redis","graphql","rest api","microservices","ci/cd","git","java","go","rust","c#","swift","kotlin","machine learning","data analysis","product management","agile","scrum","figma","ux design","salesforce","excel","tableau","power bi","llm","ai","html","css","django","spring","fastapi","system design","leadership","communication"];
  const descCorpus = saved.map(j => (j.description || "").toLowerCase()).join(" ");
  const skillHits = descCorpus.length > 100
    ? SKILL_TOKENS.map(s => ({ s, n: descCorpus.split(s).length - 1 })).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 10).map(x => `${x.s} (×${x.n})`).join(", ")
    : "";
  const descCount = saved.filter(j => (j.description || "").length > 50).length;
  const d2 = [
    `Job descriptions available: ${descCount} of ${saved.length} saved jobs.`,
    skillHits ? `Skill frequency across descriptions: ${skillHits}.` : "Insufficient description text — save more jobs with descriptions.",
    titles.length ? `Role titles in landscape: ${titles.slice(0, 8).join(", ")}.` : "",
  ].filter(Boolean).join(" ");

  // Analysis 3 — Market Fit: user profile vs aggregate requirements, no outcomes
  const matchScores = saved.filter(j => j.matchScore != null).map(j => j.matchScore);
  const avgMatch = matchScores.length ? Math.round(matchScores.reduce((a, b) => a + b, 0) / matchScores.length) : null;
  const d3 = [
    `Current role: ${profile?.job_title || "not set"}.`,
    `Target role: ${profile?.preferred_job_title || "not set"}.`,
    `Years of experience: ${profile?.years_experience || "not specified"}.`,
    `Location: ${profile?.location || "not specified"}.`,
    `Work type preference: ${profile?.work_type || "not specified"}.`,
    avgMatch != null ? `Average match score against saved jobs: ${avgMatch}%.` : "",
    saved.length ? `Roles in target landscape: ${saved.length}.` : "",
    titles.length ? `Target roles: ${titles.slice(0, 6).join(", ")}.` : "",
  ].filter(Boolean).join(" ");

  // Analysis 4 — Search Strategy: career goal vs search behavior only, no outcomes
  const d4 = [
    `Career goal: ${profile?.career_goal || "not set"}.`,
    `Target timeline: ${profile?.career_timeline || "not set"}.`,
    `Target role: ${profile?.preferred_job_title || "not set"}.`,
    `Current role: ${profile?.job_title || "not set"}.`,
    `Total saved jobs: ${saved.length}.`,
    titles.length ? `Roles being saved: ${[...new Set(titles)].slice(0, 8).join(", ")}.` : "",
    companies.length ? `Companies targeted: ${companies.slice(0, 8).join(", ")}.` : "",
    `Work model focus: ${remoteCount} remote, ${saved.length - remoteCount} on-site (${saved.length > 0 ? Math.round(remoteCount / saved.length * 100) : 0}% remote).`,
    locations.length ? `Geographic targeting: ${locations.join(", ")}.` : "",
  ].filter(Boolean).join(" ");

  // Analysis 5 — Search Performance: application outcomes only, no jobs or profile
  const interviews = apps.filter(a => ["Interview", "Final Interview", "Phone Screen"].includes(a.status)).length;
  const offers = apps.filter(a => a.status === "Offer").length;
  const rejections = apps.filter(a => a.status === "Rejected").length;
  const pending = apps.filter(a => !["Offer", "Rejected", "Withdrawn"].includes(a.status)).length;
  const responseRate = apps.length > 0 ? Math.round(((interviews + offers) / apps.length) * 100) : 0;
  const statusMap = apps.reduce((acc, a) => { acc[a.status] = (acc[a.status] || 0) + 1; return acc; }, {});
  const statusBreakdown = Object.entries(statusMap).map(([s, c]) => `${s}: ${c}`).join(", ");
  const companiesApplied = [...new Set(apps.map(a => a.company).filter(Boolean))].slice(0, 10).join(", ");
  const d5 = [
    `Total applications submitted: ${apps.length}.`,
    statusBreakdown ? `Status breakdown: ${statusBreakdown}.` : "",
    `Interviews reached: ${interviews}. Offers: ${offers}. Rejections: ${rejections}. Pending: ${pending}.`,
    `Overall response rate: ${responseRate}%.`,
    companiesApplied ? `Companies applied to: ${companiesApplied}.` : "",
  ].filter(Boolean).join(" ");

  // ── Single Claude call with five isolated labeled sections ─────────────────
  const raw = await askClaude(
    `You are CareerPersona AI — Job Intelligence Analyst. Generate 5 independent AI analyses of a user's job search landscape.

CRITICAL RULE: Each analysis must derive exclusively from its own DATA block. Do NOT cross-reference, echo, or summarize content from any other section. Every section must stand alone.

=== ANALYSIS 1: MARKET PATTERNS ===
DATA: ${d1}
Task: Identify patterns in the saved job search landscape — role concentration, seniority signals, work model distribution, geographic focus, salary tier. Use ONLY the DATA above.

=== ANALYSIS 2: EMPLOYER DEMAND ===
DATA: ${d2}
Task: Identify what employers consistently request across job descriptions — most in-demand skills, recurring qualifications, technology patterns. Use ONLY the DATA above.

=== ANALYSIS 3: MARKET FIT ===
DATA: ${d3}
Task: Assess how the user's profile aligns with the aggregate target market. This is a profile-vs-market comparison — not ATS scoring, not resume advice. Use ONLY the DATA above.

=== ANALYSIS 4: SEARCH STRATEGY ===
DATA: ${d4}
Task: Evaluate whether search behavior aligns with stated career goals — role targeting consistency, geographic focus, goal alignment. Do NOT recommend today's action items. Use ONLY the DATA above.

=== ANALYSIS 5: SEARCH PERFORMANCE ===
DATA: ${d5}
Task: Analyze historical application outcomes — response rates, what patterns emerge from the results. Retrospective analytics only, not a task list. Use ONLY the DATA above.

Return ONLY this JSON, no markdown:
{"v":1,"marketPatterns":{"status":"<Excellent|Strong|Good|Fair|Limited>","summary":"<2-3 sentences>","evidence":["<pattern 1>","<pattern 2>","<pattern 3>"],"trends":"<1 sentence>"},"employerDemand":{"status":"<Excellent|Strong|Consistent|Good|Moderate|Limited>","summary":"<2-3 sentences>","topSkills":["<skill 1>","<skill 2>","<skill 3>","<skill 4>","<skill 5>"],"qualifications":["<qualification 1>","<qualification 2>"],"insight":"<1 sentence>"},"marketFit":{"status":"<Excellent|Strong|Good|Fair|Developing>","narrative":"<3-4 sentences>","strengths":["<strength 1>","<strength 2>"],"gaps":["<gap 1>","<gap 2>"],"positioning":"<1 sentence>"},"searchStrategy":{"status":"<Excellent|Focused|Aligned|Broad|Scattered|Needs Focus>","summary":"<2-3 sentences>","alignment":"<1 sentence>","recommendation":"<1 strategic sentence>"},"searchPerformance":{"status":"<Excellent|Strong|Improving|Stable|Fair|Needs Review>","summary":"<2-3 sentences>","patterns":["<pattern 1>","<pattern 2>"],"insight":"<1 sentence>"}}`,
    1400
  );

  let result;
  try {
    const s = raw.indexOf("{"); const e = raw.lastIndexOf("}");
    const parsed = s >= 0 && e > s ? JSON.parse(raw.slice(s, e + 1)) : null;
    result = parsed?.v === 1 ? { ...parsed, generatedAt: new Date().toISOString() } : null;
  } catch { result = null; }

  return result || {
    v: 1, generatedAt: new Date().toISOString(),
    marketPatterns: { status: "Building", summary: "Save jobs and search in your target market to build a landscape for AI pattern analysis. The more you search and save, the more accurate the patterns become.", evidence: ["Search for roles in your target field to begin building your landscape"], trends: "Start your job search to generate market pattern data." },
    employerDemand: { status: "Building", summary: "Search and save jobs in your target market to reveal what employers consistently ask for across many job descriptions.", topSkills: [], qualifications: [], insight: "Save at least 5 jobs to unlock employer demand analysis." },
    marketFit: { status: "Building", narrative: "Complete your profile and save some target jobs to unlock a market fit assessment. This analysis compares your full profile against the aggregate requirements of your target market — not a single job description.", strengths: [], gaps: [], positioning: "Add your target role and experience to your profile to begin market fit analysis." },
    searchStrategy: { status: "Building", summary: "Set your career goal in your profile and begin saving jobs to enable search strategy alignment analysis.", alignment: "No career goal set — add a target role and timeline to your profile.", recommendation: "Define your target role, preferred location, and career goal to enable strategic alignment analysis." },
    searchPerformance: { status: "Building", summary: "Apply to positions and track outcomes in the Tracker to enable search performance analysis. Response rate data builds over time.", patterns: [], insight: "Track at least 5 applications to begin performance analysis." },
  };
}

// ─── APPLICATION OUTCOME INTELLIGENCE ───────────────────────────────────────
// The six analyses (blueprint §8) are narrative synthesis ONLY -- confidence tiers,
// pattern direction/stability/response-rates are computed deterministically by
// src/lib/outcomeIntelligence/patternEngine.js and handed to Claude as DATA blocks,
// same "facts computed in code, AI only interprets" convention as buildJobIntelligencePayload.
function fmtPattern(p) {
  return `${p.pattern_value} (${Math.round(p.response_rate * 100)}% response, n=${p.sample_size}, ${p.direction}/${p.stability}/${p.confidence})`;
}

async function buildOutcomeIntelligencePayload({ applications, savedJobs, smartApplyQueue, patterns, funnel, rejectionStages, confidenceTier, availability }) {
  const byType = (type) => patterns.filter(p => p.pattern_type === type);

  const d1 = [
    `Overall funnel: ${funnel.applied} applied, ${funnel.responded} responded (${Math.round(funnel.responseRate * 100)}%), ${funnel.interviewed} interviewed, ${funnel.offered} offered.`,
    patterns.length ? `All patterns observed: ${patterns.map(fmtPattern).join("; ")}.` : "No patterns available yet.",
  ].join(" ");

  const d2 = [
    `Interview rate from response: ${Math.round(funnel.interviewRate * 100)}%. Offer rate from interview: ${Math.round(funnel.offerRate * 100)}%.`,
    rejectionStages.totalLogged > 0
      ? `Logged rejection stages (${rejectionStages.totalLogged} total): ${Object.entries(rejectionStages.counts).map(([k, v]) => `${k}: ${v}`).join(", ")}.`
      : "No rejection stages logged yet -- users can log where in the process a rejection occurred when editing a rejected application.",
  ].join(" ");

  const d3 = [
    byType("company_size").length ? `Company size patterns: ${byType("company_size").map(fmtPattern).join("; ")}.` : "No company size data logged yet.",
    byType("industry").length ? `Industry patterns: ${byType("industry").map(fmtPattern).join("; ")}.` : "No industry data logged yet.",
    byType("remote_policy").length ? `Remote policy patterns: ${byType("remote_policy").map(fmtPattern).join("; ")}.` : "No remote policy data logged yet.",
  ].join(" ");

  const d4 = [
    byType("smart_apply").length ? `Smart Apply usage patterns: ${byType("smart_apply").map(fmtPattern).join("; ")}.` : "No Smart Apply usage data logged yet.",
    byType("cover_letter").length ? `Cover letter patterns: ${byType("cover_letter").map(fmtPattern).join("; ")}.` : "No cover letter data logged yet.",
    byType("referral").length ? `Referral patterns: ${byType("referral").map(fmtPattern).join("; ")}.` : "No referral data logged yet.",
  ].join(" ");

  const d5 = byType("resume_version").length
    ? `Resume version patterns: ${byType("resume_version").map(fmtPattern).join("; ")}.`
    : "No resume-version-linked outcome data yet -- this requires applications submitted via Smart Apply with a resume version recorded.";

  const appliedJobKeys = new Set(eligibleApplications(applications).map(a => `${(a.company || "").toLowerCase()}|${(a.jobTitle || "").toLowerCase()}`));
  const unappliedSaved = (savedJobs || []).filter(j => !appliedJobKeys.has(`${(j.company || "").toLowerCase()}|${(j.title || "").toLowerCase()}`));
  const abandonedQueue = (smartApplyQueue || []).filter(q => q.status === "ready");
  const d6 = [
    `Saved jobs never applied to: ${unappliedSaved.length} of ${(savedJobs || []).length} saved.`,
    `Smart Apply packages prepared but never submitted: ${abandonedQueue.length}.`,
    `Overall confidence tier for this analysis: ${confidenceTier}.`,
  ].join(" ");

  // Each of the six blueprint analyses is only included in the prompt -- and only
  // requested in the response schema -- once ITS OWN data requirement is met
  // (computeAnalysisAvailability, decided deterministically before this call, never by
  // the AI). A section either has real data behind it or it isn't asked about at all;
  // the DATA-block text and Task instructions for every included section are byte-for-
  // byte unchanged from before this migration.
  const SECTIONS = [
    {
      key: "responsePattern", available: availability.responsePattern,
      block: `=== ANALYSIS 1: RESPONSE PATTERN ANALYSIS ===\nDATA: ${d1}\nTask: What do applications that received responses have in common? Identify the largest gap between responded and non-responded applications. Use ONLY the DATA above.`,
      schema: `"responsePattern":{"finding":"<2-3 sentences>","evidence":"<1 sentence citing sample size>"}`,
    },
    {
      key: "funnelStage", available: availability.funnelStage,
      block: `=== ANALYSIS 2: FUNNEL STAGE INTELLIGENCE ===\nDATA: ${d2}\nTask: Identify which pipeline stage has the biggest conversion leak, and if rejection stage data exists, route the finding toward the relevant fix (ATS/keyword issue, interview prep, technical depth, culture fit). Use ONLY the DATA above.`,
      schema: `"funnelStage":{"finding":"<2-3 sentences>","evidence":"<1 sentence>"}`,
    },
    {
      key: "companyProfileFit", available: availability.companyProfileFit,
      block: `=== ANALYSIS 3: COMPANY PROFILE FIT ===\nDATA: ${d3}\nTask: Build a "responsive company profile" and a "low-response profile" from the patterns given. Use ONLY the DATA above.`,
      schema: `"companyProfileFit":{"finding":"<2-3 sentences>","evidence":"<1 sentence>"}`,
    },
    {
      key: "applicationQuality", available: availability.applicationQuality,
      block: `=== ANALYSIS 4: APPLICATION QUALITY CORRELATION ===\nDATA: ${d4}\nTask: Does Smart Apply, a cover letter, or a referral correlate with better outcomes for this user? Use ONLY the DATA above.`,
      schema: `"applicationQuality":{"finding":"<2-3 sentences>","evidence":"<1 sentence>"}`,
    },
    {
      key: "resumeVersion", available: availability.resumeVersion,
      block: `=== ANALYSIS 5: RESUME VERSION EFFECTIVENESS ===\nDATA: ${d5}\nTask: Which resume version (if any) is outperforming others, and by how much? Use ONLY the DATA above.`,
      schema: `"resumeVersion":{"finding":"<2-3 sentences>","evidence":"<1 sentence>"}`,
    },
    {
      key: "strategicPrediction", available: availability.strategicPrediction,
      block: `=== ANALYSIS 6: STRATEGIC PREDICTION ENGINE ===\nDATA: ${d6}\nTask: Synthesize the other five analyses into forward-looking guidance: targeting recalibration, application approach changes, and resume/skills signals. Include an Opportunity Cost Intelligence finding using the saved-jobs and abandoned-package numbers given. Use ONLY the DATA above.`,
      schema: `"strategicPrediction":{"targeting":"<1-2 sentences>","approachChanges":"<1-2 sentences>","resumeSignals":"<1-2 sentences>","opportunityCost":"<1-2 sentences>"}`,
    },
  ].filter(s => s.available);

  const raw = await askClaude(
    `You are CareerPersona AI — Application Outcome Intelligence Analyst. Generate ${SECTIONS.length} independent AI ${SECTIONS.length === 1 ? "analysis" : "analyses"} of a user's job application outcomes, per the locked Application Outcome Intelligence blueprint.

CRITICAL RULES:
- Each analysis must derive exclusively from its own DATA block. Do NOT cross-reference other sections.
- Confidence tier for this run is "${confidenceTier}". At "early_signal", phrase findings as hedged hypotheses ("early evidence suggests"), never as firm conclusions. At "emerging" or "high_confidence", confident recommendations are appropriate.
- Never fabricate numbers not present in the DATA blocks. If a DATA block says no data is available, say so plainly instead of inventing a finding.
- Withdrawn applications have already been excluded from every number below -- do not mention them.

${SECTIONS.map(s => s.block).join("\n\n")}

Return ONLY this JSON, no markdown:
{"v":1,"confidenceTier":"${confidenceTier}","analyses":{${SECTIONS.map(s => s.schema).join(",")}},"topInsights":[{"text":"<finding>","evidence":"<basis>"},{"text":"<finding>","evidence":"<basis>"}],"whatWorking":["<point 1>","<point 2>"],"whatToChange":["<point 1>","<point 2>"]}`,
    2000, "outcome_intelligence"
  );

  try {
    const s = raw.indexOf("{"); const e = raw.lastIndexOf("}");
    const parsed = s >= 0 && e > s ? JSON.parse(raw.slice(s, e + 1)) : null;
    return parsed?.v === 1 ? parsed : null;
  } catch { return null; }
}

// Orchestrates one full analysis run: computes deterministic patterns/funnel, calls the
// AI for narrative synthesis, persists both the full record and the derived patterns.
async function runOutcomeAnalysis({ applications, savedJobs, smartApplyQueue, saveAnalysis, savePatterns, userId }) {
  const outcomesLoggedCount = computeOutcomesLoggedCount(applications);
  const confidenceTier = computeConfidenceTier(outcomesLoggedCount);
  const funnel = computeFunnel(applications);
  if (!confidenceTier) {
    return { confidenceTier: null, funnel, analysis: null, outcomesLoggedCount };
  }
  const patterns = computeAllPatterns(applications);
  const rejectionStages = computeRejectionStageBreakdown(applications);
  const availability = computeAnalysisAvailability({ outcomesLoggedCount, funnel, rejectionStages, patterns });
  const analysis = await buildOutcomeIntelligencePayload({ applications, savedJobs, smartApplyQueue, patterns, funnel, rejectionStages, confidenceTier, availability });
  const eligible = eligibleApplications(applications);
  const dates = eligible.map(a => a.date).filter(Boolean).sort();
  await saveAnalysis(userId, {
    periodStart: dates[0] ? new Date(dates[0]).toISOString() : new Date().toISOString(),
    periodEnd: new Date().toISOString(),
    applicationCount: eligible.length,
    outcomesLoggedCount,
    confidenceTier,
    analysis,
  });
  if (patterns.length) await savePatterns(userId, patterns);
  return { confidenceTier, funnel, analysis, outcomesLoggedCount, patterns };
}

// ─── MARKDOWN TEXT RENDERER ──────────────────────────────────
function MarkdownText({ text }) {
  if (!text) return null;
  const fmt = (str, pfx) => {
    if (!str) return null;
    const out = []; let rest = str; let k = 0;
    while (rest.length) {
      const m = [
        { pat: /\*\*(.+?)\*\*/, tag: "b" },
        { pat: /\*(.+?)\*/, tag: "i" },
        { pat: /`([^`]+)`/, tag: "c" },
        { pat: /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/, tag: "a" },
      ].reduce((best, { pat, tag }) => {
        const r = pat.exec(rest);
        return r && (!best || r.index < best.index) ? { tag, idx: r.index, len: r[0].length, g: r } : best;
      }, null);
      if (!m) { out.push(<span key={`${pfx}${k++}`}>{rest}</span>); break; }
      if (m.idx > 0) out.push(<span key={`${pfx}${k++}`}>{rest.slice(0, m.idx)}</span>);
      if (m.tag === "b") out.push(<strong key={`${pfx}${k++}`}>{m.g[1]}</strong>);
      else if (m.tag === "i") out.push(<em key={`${pfx}${k++}`}>{m.g[1]}</em>);
      else if (m.tag === "c") out.push(<code key={`${pfx}${k++}`} style={{ fontFamily: "monospace", fontSize: "0.88em", background: "rgba(0,0,0,0.08)", padding: "1px 4px", borderRadius: 3 }}>{m.g[1]}</code>);
      else if (m.tag === "a") out.push(<a key={`${pfx}${k++}`} href={m.g[2]} target="_blank" rel="noopener noreferrer" style={{ color: "inherit", textDecoration: "underline" }}>{m.g[1]}</a>);
      rest = rest.slice(m.idx + m.len);
    }
    return out;
  };
  const lines = text.split("\n");
  const els = []; let i = 0;
  while (i < lines.length) {
    const s = i; const line = lines[i];
    if (line.startsWith("```")) {
      const code = []; i++;
      while (i < lines.length && !lines[i].startsWith("```")) { code.push(lines[i]); i++; }
      els.push(<pre key={`cb${s}`} style={{ background: "rgba(0,0,0,0.06)", borderRadius: 6, padding: "8px 10px", margin: "4px 0", fontSize: 12, overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word" }}><code style={{ fontFamily: "monospace" }}>{code.join("\n")}</code></pre>);
      i++; continue;
    }
    const hm = line.match(/^(#{1,3}) (.+)/);
    if (hm) {
      const sz = [15, 14, 13][hm[1].length - 1] ?? 13;
      els.push(<div key={`h${s}`} style={{ fontWeight: 700, fontSize: sz, margin: "8px 0 3px", lineHeight: 1.4 }}>{fmt(hm[2], `h${s}`)}</div>);
      i++; continue;
    }
    if (/^[-*+] /.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*+] /.test(lines[i])) { items.push(<li key={i} style={{ marginBottom: 2 }}>{fmt(lines[i].slice(2), `ul${i}`)}</li>); i++; }
      els.push(<ul key={`ul${s}`} style={{ margin: "3px 0", paddingLeft: 18, lineHeight: 1.55 }}>{items}</ul>);
      continue;
    }
    if (/^\d+\. /.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) { items.push(<li key={i} style={{ marginBottom: 2 }}>{fmt(lines[i].replace(/^\d+\. /, ""), `ol${i}`)}</li>); i++; }
      els.push(<ol key={`ol${s}`} style={{ margin: "3px 0", paddingLeft: 18, lineHeight: 1.55 }}>{items}</ol>);
      continue;
    }
    if (line.includes("|") && lines[i + 1] && /^\|?[-| :]+\|?$/.test(lines[i + 1])) {
      const splitRow = r => r.replace(/^\||\|$/g, "").split("|").map(c => c.trim());
      const headers = splitRow(line); i += 2;
      const rows = []; while (i < lines.length && lines[i].includes("|")) { rows.push(splitRow(lines[i])); i++; }
      els.push(<div key={`tbl${s}`} style={{ overflowX: "auto", margin: "4px 0" }}><table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}><thead><tr>{headers.map((h, ci) => <th key={ci} style={{ padding: "4px 8px", borderBottom: "2px solid rgba(0,0,0,0.15)", textAlign: "left", fontWeight: 700 }}>{fmt(h, `th${s}${ci}`)}</th>)}</tr></thead><tbody>{rows.map((row, ri) => <tr key={ri}>{row.map((c, ci) => <td key={ci} style={{ padding: "3px 8px", borderBottom: "1px solid rgba(0,0,0,0.07)" }}>{fmt(c, `td${s}${ri}${ci}`)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    if (!line.trim()) { els.push(<div key={`g${s}`} style={{ height: 4 }} />); i++; continue; }
    els.push(<div key={`p${s}`} style={{ lineHeight: 1.6, marginBottom: 1 }}>{fmt(line, `p${s}`)}</div>);
    i++;
  }
  return <>{els}</>;
}

// ─── DASHBOARD PAGE ─────────────────────────────────────────
function DashboardPage({ profile, applications, savedJobs, setPage, resumes, smartApplyQueue, smartApplyQueueLoading, networkingSession, notifications, interviewSession, salaryData, networkContacts: networkContactsProp, activeResumeId, companyWatchlist, onNavigateResume, isPremium, latestOutcomeAnalysis, onOpenOutcomeIntelligence }) {
  const { t, language } = useI18n();
  const [briefing, setBriefing] = useState(() => { try { const c = sessionStorage.getItem("cp_briefing_dash"); if (!c) return null; const p = JSON.parse(c); if (p && !Array.isArray(p) && p.v === 2 && isToday(p.generatedAt)) return p; sessionStorage.removeItem("cp_briefing_dash"); return null; } catch { return null; } });
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [briefingError, setBriefingError] = useState(null);
  const [dailyPlan, setDailyPlan] = useState(() => { try { const c = sessionStorage.getItem("cp_plan_dash"); if (!c) return null; const p = JSON.parse(c); if (p?.v === 2 && Array.isArray(p?.categories) && isToday(p.generatedAt)) return p; sessionStorage.removeItem("cp_plan_dash"); return null; } catch { return null; } });
  const [planLoading, setPlanLoading] = useState(false);
  const [planError, setPlanError] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef();
  const chatScrollEnabledRef = useRef(false);
  const aiResponseStartRef = useRef(null);

  const { messages: savedChatMessages, loading: chatHistoryLoading, loadedFor: chatLoadedFor, addMessage: addChatMessage, newConversation: newChatConversation, clearConversation: clearChatConversation } = useAssistantChat(profile?.id);
  const chatAppliedForRef = useRef(undefined);

  // ── Load chat history once the Supabase fetch for this user resolves ──
  // Gated on `chatLoadedFor === profile?.id` (not just `!chatHistoryLoading`)
  // so a stale render — where loading already cleared for the previous user
  // right as profile.id flips to the real one — can't be mistaken for "loaded".
  useEffect(() => {
    if (chatHistoryLoading || chatLoadedFor !== profile?.id) return;
    if (chatAppliedForRef.current === profile?.id) return;
    chatAppliedForRef.current = profile?.id;
    if (savedChatMessages.length) setChatMessages(savedChatMessages);
  }, [savedChatMessages, chatHistoryLoading, chatLoadedFor, profile?.id]);

  const { briefing: savedBriefing, loading: briefingHistoryLoading, loadedFor: briefingLoadedFor, save: saveBriefing } = useAiBriefing(profile?.id);
  const briefingAppliedForRef = useRef(undefined);

  // ── Load the most recent briefing once the Supabase fetch resolves ──
  useEffect(() => {
    if (briefingHistoryLoading || briefingLoadedFor !== profile?.id) return;
    if (briefingAppliedForRef.current === profile?.id) return;
    briefingAppliedForRef.current = profile?.id;
    if (savedBriefing && !Array.isArray(savedBriefing) && savedBriefing.v === 2 && isToday(savedBriefing.generatedAt)) {
      setBriefing(savedBriefing);
      try { sessionStorage.setItem("cp_briefing_dash", JSON.stringify(savedBriefing)); } catch {}
    } else if (profile?.id && !(briefing && !Array.isArray(briefing) && briefing.v === 2 && isToday(briefing.generatedAt))) generateBriefing();
  }, [savedBriefing, briefingHistoryLoading, briefingLoadedFor, profile?.id]);

  const { plan: savedPlan, loading: planHistoryLoading, loadedFor: planLoadedFor, save: savePlan } = useAiActionPlan(profile?.id);
  const planAppliedForRef = useRef(undefined);
  const prevActiveResumeIdRef = useRef(undefined);
  const careerFingerprintRef = useRef(null);
  const regenTimerRef = useRef(null);

  // ── Load the most recent action plan once the Supabase fetch resolves ──
  useEffect(() => {
    if (planHistoryLoading || planLoadedFor !== profile?.id) return;
    if (planAppliedForRef.current === profile?.id) return;
    planAppliedForRef.current = profile?.id;
    if (savedPlan && savedPlan.v === 2 && Array.isArray(savedPlan.categories) && isToday(savedPlan.generatedAt)) {
      setDailyPlan(savedPlan);
      try { sessionStorage.setItem("cp_plan_dash", JSON.stringify(savedPlan)); } catch {}
    } else if (profile?.id && !(dailyPlan?.v === 2 && Array.isArray(dailyPlan?.categories) && isToday(dailyPlan.generatedAt))) generatePlan();
  }, [savedPlan, planHistoryLoading, planLoadedFor, profile?.id]);

  // ── Career Progress — load cached analysis for Dashboard summary card ──
  const { analysis: savedCpAnalysis, loading: cpAnalysisLoading, loadedFor: cpLoadedFor } = useCareerProgressAnalysis(profile?.id);
  const [cpAnalysis, setCpAnalysis] = useState(() => {
    try { const c = sessionStorage.getItem("cp_progress_analysis"); if (!c) return null; const p = JSON.parse(c); return p?.v === 1 ? p : null; } catch { return null; }
  });
  const cpAppliedRef = useRef(undefined);
  useEffect(() => {
    if (cpAnalysisLoading || cpLoadedFor !== profile?.id) return;
    if (cpAppliedRef.current === profile?.id) return;
    cpAppliedRef.current = profile?.id;
    if (savedCpAnalysis?.v === 1) {
      setCpAnalysis(savedCpAnalysis);
      try { sessionStorage.setItem("cp_progress_analysis", JSON.stringify(savedCpAnalysis)); } catch {}
    }
  }, [savedCpAnalysis, cpAnalysisLoading, cpLoadedFor, profile?.id]);

  // ── Job Intelligence — load cached landscape analysis for Dashboard summary card ──
  const { analysis: savedJiAnalysis, loading: jiAnalysisLoading, loadedFor: jiLoadedFor } = useJobIntelligenceAnalysis(profile?.id);
  const [jiAnalysis, setJiAnalysis] = useState(() => {
    try { const c = sessionStorage.getItem("cp_job_intel_analysis"); if (!c) return null; const p = JSON.parse(c); return p?.v === 1 ? p : null; } catch { return null; }
  });
  const jiAppliedRef = useRef(undefined);
  useEffect(() => {
    if (jiAnalysisLoading || jiLoadedFor !== profile?.id) return;
    if (jiAppliedRef.current === profile?.id) return;
    jiAppliedRef.current = profile?.id;
    if (savedJiAnalysis?.v === 1) {
      setJiAnalysis(savedJiAnalysis);
      try { sessionStorage.setItem("cp_job_intel_analysis", JSON.stringify(savedJiAnalysis)); } catch {}
    }
  }, [savedJiAnalysis, jiAnalysisLoading, jiLoadedFor, profile?.id]);

  const networkContacts = networkContactsProp || [];
  const apps = applications || [];
  const saved = savedJobs || [];

  // Computed stats
  const totalApps = apps.length;
  const interviews = apps.filter(a => ["Interview","Final Interview","Phone Screen"].includes(a.status)).length;
  const offers = apps.filter(a => a.status === "Offer").length;
  const profileFields = ["full_name","email_address","phone","location","job_title","years_experience","preferred_job_title","work_type"];
  const profileComplete = profile ? Math.round((profileFields.filter(f => profile[f]).length / profileFields.length) * 100) : 0;
  const questionsCount = interviewSession?.questions?.length || 0;

  // Smart Apply derived stats
  const saQueue = smartApplyQueue || [];
  const saReady = saQueue.filter(q => q.status === "ready").length;
  const saWaiting = saQueue.filter(q => q.status === "queued").length;
  const saApplied = applications.filter(a => saQueue.some(q => q.application_id === a.id)).length;
  const saHasResume = saQueue.some(q => q.status === "ready" && q.tailored_resume);
  const saHasCover = saQueue.some(q => q.status === "ready" && q.cover_letter);

  // Opportunity Intelligence derived stats
  const scoredJobs = saved.filter(j => j.matchScore != null).sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
  const topOpportunities = scoredJobs.length ? scoredJobs.slice(0, 3) : saved.slice(0, 3);
  const avgMatchScore = scoredJobs.length ? Math.round(scoredJobs.reduce((s, j) => s + (j.matchScore || 0), 0) / scoredJobs.length) : null;
  const highPriorityJobs = scoredJobs.filter(j => j.matchScore >= 80).length;
  const recentCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const newOpportunities = saved.filter(j => j.saved_at && j.saved_at > recentCutoff).length;

  // Resume Intelligence derived stats
  const resumeCount = (resumes || []).length;
  const appAtsScores = apps.filter(a => a.atsScore > 0).map(a => a.atsScore);
  const bestAts = appAtsScores.length ? Math.max(...appAtsScores) : null;
  const bestResume = (resumes || []).filter(r => r.ats_score != null).sort((a, b) => new Date(b.last_analyzed_at) - new Date(a.last_analyzed_at))[0] ?? null;

  // Job Intelligence derived stats
  const responseRate = totalApps > 0 ? Math.round(((interviews + offers) / totalApps) * 100) : 0;

  // Interview Intelligence derived stats
  const interviewAnswers = interviewSession?.answers || [];
  const answeredCount = interviewAnswers.length;
  const scoredAnswers = interviewAnswers.filter(a => a.feedback?.score);
  const avgFeedbackScore = scoredAnswers.length ? Math.round(scoredAnswers.reduce((s, a) => s + a.feedback.score, 0) / scoredAnswers.length * 10) / 10 : null;
  const mockInterviewScore = interviewSession?.mockSummary?.avgScore ?? null;
  const mockAnswered = interviewSession?.mockSummary?.answered ?? 0;
  const mockTotal = interviewSession?.mockSummary?.total ?? 0;
  const mockSkipped = interviewSession?.mockSummary?.skipped ?? 0;

  // Networking Intelligence derived stats
  const followUpNeeded = networkContacts.filter(c => c.status === "Waiting for Reply").length;
  const replied = networkContacts.filter(c => ["Replied", "Met", "Connected"].includes(c.status)).length;
  const outreachRate = networkContacts.length > 0 ? Math.round((replied / networkContacts.length) * 100) : 0;

  // AI Activity log
  const { activity: aiActivity, logActivity } = useActivityLog(profile?.id);

  // Unified user context — single source of truth for all AI modules.
  const userContext = useUserContext({
    profile,
    applications,
    savedJobs,
    resumes: resumes ?? [],
    smartApplyQueue: smartApplyQueue ?? [],
    interviewSession,
    salaryData,
    networkContacts,
    networkingSession,
    briefing,
    dailyPlan,
    activityLog: aiActivity,
    notifications: notifications ?? [],
    chatHistory: chatMessages,
    companyWatchlist: companyWatchlist ?? [],
  });

  // Generate AI Briefing
  const generateBriefing = async () => {
    setBriefingLoading(true);
    setBriefingError(null);
    console.log("[Briefing] Starting generation for user", profile?.id);
    try {
      const ctx = userContext.getContextString();
      const result = await buildBriefingPayload(ctx, language);
      if (!result || Array.isArray(result) || result.v !== 2) throw new Error("buildBriefingPayload returned invalid format: " + JSON.stringify(result)?.slice(0, 100));
      console.log("[Briefing] Generation succeeded — fields:", Object.keys(result).join(", "));
      setBriefing(result);
      try { sessionStorage.setItem("cp_briefing_dash", JSON.stringify(result)); } catch {}
      saveBriefing(result).catch(err => console.error("[Briefing] save failed", err));
      logActivity("Daily briefing generated");
      insertNotification(profile?.id, { type: "briefing", title: "Daily briefing ready", body: "Your personalized career briefing has been generated.", linkPage: "dashboard" });
    } catch (e) {
      console.error("[Briefing] Generation failed:", e?.message || e);
      setBriefingError(t("dashboard.briefingError"));
    }
    finally { setBriefingLoading(false); }
  };

  // Generate Daily Plan
  const generatePlan = async () => {
    setPlanLoading(true);
    setPlanError(null);
    console.log("[ActionPlan] Starting generation for user", profile?.id);
    try {
      const ctx = userContext.getContextString();
      const result = await buildPlanPayload(ctx, language);
      if (!result?.v || result.v !== 2 || !Array.isArray(result.categories)) throw new Error("buildPlanPayload returned invalid format: " + JSON.stringify(result)?.slice(0, 100));
      console.log("[ActionPlan] Generation succeeded — categories:", result.categories?.length);
      setDailyPlan(result);
      try { sessionStorage.setItem("cp_plan_dash", JSON.stringify(result)); } catch {}
      savePlan(result).catch(err => console.error("[ActionPlan] save failed", err));
      logActivity("Daily plan generated");
      insertNotification(profile?.id, { type: "action_plan", title: "Action plan ready", body: "Today's action plan has been generated.", linkPage: "dashboard" });
    } catch (e) {
      console.error("[ActionPlan] Generation failed:", e?.message || e);
      setPlanError(t("dashboard.planError"));
    }
    finally { setPlanLoading(false); }
  };

  // Chat
  const sendChat = async (directMsg) => {
    const userMsg = (typeof directMsg === "string" ? directMsg : chatInput).trim();
    if (!userMsg || chatLoading) return;
    chatScrollEnabledRef.current = true;
    setChatInput("");
    const history = chatMessages.slice(-12).map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.text}`).join("\n");
    setChatMessages(prev => [...prev, { role: "user", text: userMsg }]);
    addChatMessage("user", userMsg).catch(err => console.error("assistant chat save failed", err));
    setChatLoading(true);
    try {
      const ctx = userContext.getContextString();
      const prompt = `You are CareerPersona AI, a professional AI career coach. Give expert, personalized career advice based on this user's profile.\n\n${ctx}${history ? `\n\nConversation history:\n${history}` : ""}\n\nUser: ${userMsg}`;
      const raw = await askClaude(prompt, 2500);
      setChatMessages(prev => [...prev, { role: "ai", text: raw }]);
      addChatMessage("ai", raw).catch(err => console.error("assistant chat save failed", err));
      logActivity("Chat: " + userMsg.slice(0, 30));
    } catch {
      setChatMessages(prev => [...prev, { role: "ai", text: t("dashboard.chatError") }]);
    } finally { setChatLoading(false); }
  };

  useEffect(() => {
    if (!chatScrollEnabledRef.current || chatMessages.length === 0) return;
    const lastMsg = chatMessages[chatMessages.length - 1];
    if (lastMsg?.role === "ai" && aiResponseStartRef.current) {
      aiResponseStartRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [chatMessages]);

  const handleNewConversation = async () => {
    try { await newChatConversation(); } catch {}
    setChatMessages([]);
  };
  const handleClearConversation = async () => {
    try { await clearChatConversation(); } catch {}
    setChatMessages([]);
  };

  // Re-generate briefing and plan when the user switches to a different resume in the Library
  useEffect(() => {
    if (prevActiveResumeIdRef.current === undefined) { prevActiveResumeIdRef.current = activeResumeId; return; }
    if (!activeResumeId || activeResumeId === prevActiveResumeIdRef.current) return;
    prevActiveResumeIdRef.current = activeResumeId;
    try { sessionStorage.removeItem("cp_briefing_dash"); } catch {}
    try { sessionStorage.removeItem("cp_plan_dash"); } catch {}
    setBriefing(null);
    setDailyPlan(null);
    briefingAppliedForRef.current = undefined;
    planAppliedForRef.current = undefined;
    careerFingerprintRef.current = null; // reset so fingerprint re-baselines after regen
    generateBriefing();
    generatePlan();
  }, [activeResumeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const briefingReady = briefing && !Array.isArray(briefing) && briefing.v === 2;
  const planReady = dailyPlan?.v === 2 && Array.isArray(dailyPlan?.categories);

  // ── Event-driven briefing regeneration ───────────────────────────────────────
  // Once the initial briefing is ready, fingerprints key career metrics.
  // A 2s stabilisation delay absorbs concurrent initial data loads.
  // Any subsequent change schedules a debounced regen (3s) so rapid changes
  // (e.g. SA package + application submitted together) collapse into one call.
  useEffect(() => {
    if (!briefingReady) return;

    const best = (resumes || [])
      .filter(r => r.ats_score != null)
      .sort((a, b) => (b.ats_score ?? 0) - (a.ats_score ?? 0))[0] ?? null;

    const fp = [
      (resumes || []).length,                                               // resume uploaded
      best?.ats_score ?? 0,                                                 // ATS score changed
      best?.keywords_missing?.length ?? 0,                                  // optimization completed
      (applications || []).length,                                          // new application submitted
      (smartApplyQueue || []).filter(q => q.status === "ready").length,     // SA package generated
      (savedJobs || []).filter(j => (j.matchScore ?? 0) >= 80).length,     // high-match job discovered
      (interviewSession?.answers || []).length,                             // interview / mock completed
      salaryData?.results ? 1 : 0,                                         // salary research completed
      (networkContacts || []).length,                                       // new networking contact
    ].join("|");

    if (careerFingerprintRef.current === null) {
      // No baseline yet — wait 2 s for all data hooks to settle before capturing it.
      const t = setTimeout(() => { careerFingerprintRef.current = fp; }, 2000);
      return () => clearTimeout(t);
    }

    if (fp === careerFingerprintRef.current) return;

    // Meaningful career event detected — update baseline and schedule regen.
    careerFingerprintRef.current = fp;
    clearTimeout(regenTimerRef.current);
    regenTimerRef.current = setTimeout(generateBriefing, 3000);
  }, [briefingReady, resumes, applications, smartApplyQueue, savedJobs, interviewSession, salaryData, networkContacts]); // eslint-disable-line react-hooks/exhaustive-deps

  const priorityColor = { high: C.red, medium: C.yellow, low: C.green };
  const hlBriefing = (text) => {
    if (!text) return text;
    const parts = String(text).split(/(\$[\d,]+[kKmMbB]?(?:\s*[-–—]\s*\$[\d,]+[kKmMbB]?)?|\d+\+?(?:,\d{3})*(?:\.\d+)?%?(?:\s+(?:new\s+)?(?:jobs?|roles?|applications?|app(?:s)?|offers?|interviews?|matches?|positions?|opportunities?|companies?|years?|months?|days?|weeks?|hours?|contacts?|connections?|openings?|listings?|results?|candidates?|skills?|points?|times?|responses?|updates?|items?|tips?|insights?|actions?|tasks?|steps?))?)/gi);
    return parts.map((p, j) => /^\$?\d/.test(p) ? <span key={j} style={{ color: C.purple, fontWeight: 600 }}>{p}</span> : p);
  };
  const previewBriefing = (text) => {
    if (!text) return "";
    const words = String(text).trim().split(/\s+/);
    return words.length > 6 ? words.slice(0, 6).join(" ") + "…" : text;
  };

  return (
    <div>
      {/* WELCOME HERO */}
      <div className="hero-section" style={{ marginBottom: 14 }}>
        <h1 className="hero-greeting" style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 4 }}>
          {(() => { const h = new Date().getHours(); return h < 12 ? t("dashboard.greetingMorning") : h < 17 ? t("dashboard.greetingAfternoon") : t("dashboard.greetingEvening"); })()}, {profile?.full_name?.split(" ")[0] || t("dashboard.greetingDefaultName")}! 👋
        </h1>
        <p className="hero-subtitle" style={{ color: C.textMuted, fontSize: 13, lineHeight: 1.4 }}>{t("dashboard.subtitle")}</p>
      </div>

      {/* TOP ROW: Briefing + Daily Plan */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }} className="two-col">
        {/* Daily Briefing */}
        <Card style={{ padding: "8px 14px 8px", position: "relative", overflow: "hidden", alignSelf: "flex-start" }}>
          {/* Flex row: content + mobile spark only — robot is out of flow below */}
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
            {/* Left: content */}
            <div className="briefing-content-col" style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 2 }}>{t("dashboard.briefingTitle")}</div>
              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4, lineHeight: 1.4 }}>{t("dashboard.briefingSubtitle")}</div>
              {!briefingReady && !briefingError && (
                <div style={{ padding: "6px 0 2px", color: C.textMuted, fontSize: 13 }}>{briefingLoading || briefingHistoryLoading ? t("dashboard.briefingGenerating") : t("dashboard.briefingLoading")}</div>
              )}
              {!briefingReady && briefingError && (
                <div style={{ padding: "6px 0 2px", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, color: C.red }}>{briefingError}</span>
                  <button onClick={generateBriefing} style={{ border: "none", background: "none", color: C.purple, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>{t("dashboard.briefingRetry")}</button>
                </div>
              )}
              {briefingReady && (
                <div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 0 }}>
                    {[
                      briefing.summary,
                      briefing.newMatchingJobs,
                      briefing.highestPayingJobs,
                      briefing.jobsClosingSoon,
                    ].map((text, i) => (
                      <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                        <div style={{ width: 20, height: 20, borderRadius: "50%", background: C.green, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
                          <span style={{ color: "#fff", fontSize: 10, fontWeight: 900, lineHeight: 1 }}>✓</span>
                        </div>
                        <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.4 }}>{hlBriefing(previewBriefing(text))}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ paddingTop: 0 }}>
                    <button style={{ border: "none", background: "none", color: C.purple, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }} onClick={() => setPage("briefing")}>
                      {t("dashboard.viewFullBriefing")}
                    </button>
                  </div>
                </div>
              )}
            </div>
            {/* Mobile-only: AI Spark icon shown instead of robot */}
            <div className="briefing-spark-mobile" style={{ display: "none", flexShrink: 0, alignItems: "center", justifyContent: "center", alignSelf: "center" }}>
              <div style={{ width: 34, height: 34, borderRadius: 10, background: C.purple, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 2px 8px ${C.purple}30` }}>
                <svg width="18" height="18" viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <path d="M13 2 L15 10 L23 12 L15 14 L13 22 L11 14 L3 12 L11 10 Z" fill="white"/>
                </svg>
              </div>
            </div>
          </div>
          {/* Robot: absolutely positioned — never contributes to card height */}
          <div className="briefing-illus briefing-illus-desktop" style={{ display: "none", position: "absolute", right: 14, top: "50%", transform: "translateY(-50%)" }}>
            <div style={{ width: 48, height: 48, borderRadius: 14, background: C.purple, display: "flex", alignItems: "center", justifyContent: "center", boxShadow: `0 4px 16px ${C.purple}40` }}>
              <svg width="26" height="26" viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M13 2 L15 10 L23 12 L15 14 L13 22 L11 14 L3 12 L11 10 Z" fill="white"/>
                <path d="M21 2 L22 4.5 L24.5 5.5 L22 6.5 L21 9 L20 6.5 L17.5 5.5 L20 4.5 Z" fill="white" opacity="0.5"/>
              </svg>
            </div>
          </div>
        </Card>

        {/* Today's Action Plan */}
        <Card style={{ padding: "8px 14px 8px", alignSelf: "flex-start" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 2 }}>{t("dashboard.planTitle")}</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4, lineHeight: 1.4 }}>{t("dashboard.planSubtitle")}</div>
          {!planReady && !planError && (
            <div style={{ padding: "6px 0 2px", color: C.textMuted, fontSize: 13 }}>
              {planLoading || planHistoryLoading ? t("dashboard.planGenerating") : t("dashboard.planLoading")}
            </div>
          )}
          {!planReady && planError && (
            <div style={{ padding: "6px 0 2px", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: C.red }}>{planError}</span>
              <button onClick={generatePlan} style={{ border: "none", background: "none", color: C.purple, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>{t("dashboard.planRetry")}</button>
            </div>
          )}
          {planReady && (
            <div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 0 }}>
                {dailyPlan.categories.map((item, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <div style={{ width: 20, height: 20, borderRadius: "50%", border: `2px solid ${item.status === "completed" ? C.green : C.purple}`, background: item.status === "completed" ? C.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                      {item.status === "completed" && <span style={{ color: "#fff", fontSize: 9, fontWeight: 900, lineHeight: 1 }}>✓</span>}
                    </div>
                    <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.4, flex: 1, display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 4, minWidth: 0 }}>
                      <span style={{ display: "flex", flex: 1, minWidth: 0, overflow: "hidden" }}>
                        <span style={{ flexShrink: 0, whiteSpace: "nowrap" }}>{tPlanCat(item.id, t, item.category)}</span>
                        {item.task && <span style={{ color: C.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>&nbsp;—&nbsp;{item.task}</span>}
                      </span>
                      <span style={{ fontSize: 11, color: C.textMuted, fontWeight: 500, flexShrink: 0 }}>{item.time}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ paddingTop: 0 }}>
                <button style={{ border: "none", background: "none", color: C.purple, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }} onClick={() => setPage("plan")}>
                  {t("dashboard.viewFullPlan")}
                </button>
              </div>
            </div>
          )}
        </Card>
      </div>

      {/* ROW 2: Smart Apply + Opportunity Intelligence */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }} className="two-col">
        {/* Smart Apply Center */}
        <Card style={{ padding: "16px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 4 }}>{t("dashboard.smartApplyTitle")}</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12, lineHeight: 1.4 }}>{t("dashboard.smartApplySubtitle")}</div>
          {smartApplyQueueLoading && saQueue.length === 0 ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", marginBottom: 12 }}>
              <div style={{ width: 14, height: 14, border: `2px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
              <div style={{ fontSize: 13, color: C.textMuted, minWidth: 0 }}>{t("savedJobs.loadingQueue")}</div>
            </div>
          ) : saQueue.length === 0 ? (
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6, marginBottom: 12 }}>{t("dashboard.smartApplyEmpty")}</div>
          ) : (
            <div>
              <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                {[[t("dashboard.saReady"), saReady, C.green], [t("dashboard.saInQueue"), saWaiting, C.yellow], [t("dashboard.saApplied"), saApplied, C.purple]].map(([label, count, color]) => (
                  <div key={label} style={{ flex: 1, background: `${color}12`, borderRadius: 10, padding: "8px 6px", textAlign: "center" }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color }}>{count}</div>
                    <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 600 }}>{label}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: saHasResume ? C.green : C.textMuted }}>{saHasResume ? t("dashboard.resumeTailored") : t("dashboard.resumeNotTailored")}</div>
                <div style={{ fontSize: 12, color: saHasCover ? C.green : C.textMuted }}>{saHasCover ? t("dashboard.coverReady") : t("dashboard.coverNotReady")}</div>
                {saReady > 0 && <div style={{ fontSize: 12, fontWeight: 700, color: C.green, marginTop: 2 }}>{saReady === 1 ? t("dashboard.saJobsReadySingular") : t("dashboard.saJobsReadyPlural").replace("{n}", saReady)}</div>}
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn variant="secondary" style={{ padding: "6px 14px", fontSize: 12, color: C.purple }} onClick={() => setPage("jobs")}>{t("dashboard.findMatchingJobs")}</Btn>
            <Btn variant="secondary" style={{ padding: "6px 14px", fontSize: 12, color: C.purple }} onClick={() => setPage("saved")}>{t("dashboard.viewQueue")}</Btn>
          </div>
        </Card>

        {/* Opportunity Intelligence */}
        <Card style={{ padding: "16px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 4 }}>{t("dashboard.opportunityTitle")}</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12, lineHeight: 1.4 }}>{t("dashboard.opportunitySubtitle")}</div>
          {saved.length === 0 ? (
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6, marginBottom: 12 }}>{t("dashboard.opportunityEmpty")}</div>
          ) : (
            <div>
              <div style={{ display: "flex", gap: 10, marginBottom: 10, alignItems: "flex-start" }}>
                {avgMatchScore != null && (
                  <div style={{ background: `${avgMatchScore >= 80 ? C.green : avgMatchScore >= 60 ? C.yellow : C.red}12`, borderRadius: 10, padding: "8px 10px", textAlign: "center", minWidth: 68, flexShrink: 0 }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: avgMatchScore >= 80 ? C.green : avgMatchScore >= 60 ? C.yellow : C.red }}>{avgMatchScore}</div>
                    <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 600 }}>{t("dashboard.avgMatch")}</div>
                  </div>
                )}
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
                  {highPriorityJobs > 0 && <div style={{ fontSize: 12, color: C.green, fontWeight: 600 }}>{highPriorityJobs === 1 ? t("dashboard.highPriorityMatchSingular") : t("dashboard.highPriorityMatchPlural").replace("{n}", highPriorityJobs)}</div>}
                  {newOpportunities > 0 && <div style={{ fontSize: 12, color: C.blue }}>{t("dashboard.newThisWeek").replace("{n}", newOpportunities)}</div>}
                  {salaryData?.results?.demandLevel && <div style={{ fontSize: 12, color: C.textMuted }}>{t("dashboard.marketDemandLabel")} <strong>{tStatusVal(salaryData.results.demandLevel, t)}</strong></div>}
                  {!avgMatchScore && <div style={{ fontSize: 12, color: C.textMuted }}>{saved.length === 1 ? t("dashboard.savedJobSingular") : t("dashboard.savedJobPlural").replace("{n}", saved.length)}</div>}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 8 }}>
                {topOpportunities.map((j, i) => (
                  <div key={j.job_id || i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: C.text, padding: "3px 0", borderBottom: `1px solid ${C.border}` }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, marginRight: 8, minWidth: 0 }}>{j.title || j.jobTitle} — {j.company}</span>
                    {j.matchScore != null && <span style={{ fontSize: 11, fontWeight: 700, color: matchScoreColor(j.matchScore), flexShrink: 0 }}>{j.matchScore}%</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          <Btn variant="secondary" style={{ padding: "6px 14px", fontSize: 12, color: C.purple }} onClick={() => setPage("opportunity")}>{t("dashboard.viewOpportunities")}</Btn>
        </Card>
      </div>

      {/* Application Outcome Intelligence -- Premium Feature #2. Dashboard = hiring
          pulse (one What's Working + one What to Change line); full analysis lives in
          the Application Tracker's Insights tab. */}
      {isPremium && (() => {
        const oiFunnel = computeFunnel(applications);
        const oiAnalysis = latestOutcomeAnalysis?.analysis;
        const belowEmerging = !latestOutcomeAnalysis || latestOutcomeAnalysis.confidence_tier === "early_signal";
        return (
          <Card style={{ padding: "16px 18px", marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.navText }}>{t("dashboard.oiTitle")}</div>
              <button onClick={onOpenOutcomeIntelligence} style={{ background: "none", border: "none", color: C.purple, fontSize: 12, fontWeight: 700, cursor: "pointer", padding: 0 }}>{t("dashboard.oiFullAnalysis")} ↗</button>
            </div>
            <div style={{ display: "flex", gap: 16, marginBottom: belowEmerging ? 0 : 12, flexWrap: "wrap" }}>
              <div style={{ fontSize: 12, color: C.textMuted }}>{t("dashboard.oiApplied")} <strong style={{ color: C.text }}>{oiFunnel.applied}</strong></div>
              <div style={{ fontSize: 12, color: C.textMuted }}>{t("dashboard.oiResponse")} <strong style={{ color: C.text }}>{oiFunnel.responded} ({Math.round(oiFunnel.responseRate * 100)}%)</strong></div>
              <div style={{ fontSize: 12, color: C.textMuted }}>{t("dashboard.oiInterview")} <strong style={{ color: C.text }}>{oiFunnel.interviewed} ({Math.round(oiFunnel.interviewRate * 100)}%)</strong></div>
              <div style={{ fontSize: 12, color: C.textMuted }}>{t("dashboard.oiOffer")} <strong style={{ color: C.text }}>{oiFunnel.offered}</strong></div>
            </div>
            {belowEmerging ? (
              <div style={{ fontSize: 12, color: C.textMuted, marginTop: 8 }}>{t("dashboard.oiLogMore")}</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {oiAnalysis?.whatWorking?.[0] && <div style={{ fontSize: 12, color: C.green }}><strong>{t("dashboard.oiWorking")}:</strong> {oiAnalysis.whatWorking[0]}</div>}
                {oiAnalysis?.whatToChange?.[0] && <div style={{ fontSize: 12, color: C.orange }}><strong>{t("dashboard.oiChange")}:</strong> {oiAnalysis.whatToChange[0]}</div>}
              </div>
            )}
          </Card>
        );
      })()}

      {/* ROW 3: Resume + Job + Interview Intelligence */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 16 }} className="three-col">
        {/* Resume Intelligence */}
        <Card style={{ padding: "16px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 4 }}>{t("dashboard.resumeIntelTitle")}</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10, lineHeight: 1.4 }}>{t("dashboard.resumeIntelSubtitle")}</div>
          {bestResume ? (
            <div>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 8 }}>
                <ScoreRing score={bestResume.ats_score} size={80} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  {(() => {
                    const s = bestResume.ats_score;
                    const strength = s >= 80 ? t("dashboard.atsStrong") : s >= 60 ? t("dashboard.atsGood") : s >= 40 ? t("dashboard.atsFair") : t("dashboard.atsNeedsWork");
                    const strengthColor = s >= 80 ? C.green : s >= 60 ? C.yellow : s >= 40 ? "#EA580C" : C.red;
                    const missingCount = (bestResume.keywords_missing || []).length;
                    const topMissing = (bestResume.keywords_missing || []).slice(0, 3).join(", ");
                    const suggestCount = (bestResume.suggestions || []).length;
                    return (
                      <>
                        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 2 }}>{t("dashboard.resumeStrength")}</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: strengthColor, marginBottom: 6 }}>{strength}</div>
                        {missingCount > 0 && (
                          <>
                            <div style={{ fontSize: 11, color: C.textMuted }}>{t("dashboard.missingKeywords")} <span style={{ fontWeight: 700, color: "#EA580C" }}>{missingCount}</span></div>
                            {topMissing && <div style={{ fontSize: 10, color: C.textMuted, marginTop: 1, marginBottom: 4 }}>{topMissing}</div>}
                          </>
                        )}
                        {suggestCount > 0 && <div style={{ fontSize: 11, color: C.textMuted }}>{t("dashboard.aiSuggestions")} <span style={{ fontWeight: 700, color: C.blue }}>{suggestCount}</span></div>}
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>{t("dashboard.resumeHealth")} <span style={{ fontWeight: 700, color: strengthColor }}>{strength}</span></div>
                      </>
                    );
                  })()}
                </div>
              </div>
              {bestResume.top_priority && <div style={{ fontSize: 11, color: C.textMid, background: C.bgSoft, borderRadius: 7, padding: "6px 9px", marginBottom: 4, lineHeight: 1.5 }}>⚡ {bestResume.top_priority}</div>}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>{resumeCount > 0 ? t("dashboard.analyzeResumeHint") : t("dashboard.resumeIntelEmpty")}</div>
          )}
          <Btn variant="secondary" style={{ marginTop: 12, padding: "6px 14px", fontSize: 12, color: C.purple }} onClick={() => onNavigateResume ? onNavigateResume() : setPage("resume")}>{t("dashboard.goToResume")}</Btn>
        </Card>

        {/* Job Intelligence */}
        <Card style={{ padding: "16px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 4 }}>{t("dashboard.jobIntelTitle")}</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12, lineHeight: 1.4 }}>{t("dashboard.jobIntelSubtitle")}</div>
          {jiAnalysisLoading && !jiAnalysis ? (
            <div style={{ fontSize: 12, color: C.textMuted, paddingBottom: 4 }}>{t("dashboard.loading")}</div>
          ) : jiAnalysis ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {[
                [t("dashboard.marketPatterns"), jiAnalysis.marketPatterns?.status],
                [t("dashboard.employerDemand"), jiAnalysis.employerDemand?.status],
                [t("dashboard.marketFit"), jiAnalysis.marketFit?.status],
                [t("dashboard.searchStrategy"), jiAnalysis.searchStrategy?.status],
                [t("dashboard.searchPerformance"), jiAnalysis.searchPerformance?.status],
              ].map(([label, status]) => {
                const s = (status || "").toLowerCase();
                const color = ["excellent", "strong", "consistent"].includes(s) ? C.green
                  : ["good", "focused", "aligned", "improving", "solid"].includes(s) ? C.blue
                  : ["fair", "stable", "broad", "moderate"].includes(s) ? C.yellow
                  : ["limited", "scattered", "needs focus", "needs review"].includes(s) ? C.red
                  : C.textMuted;
                return (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: C.textMid }}>{label}</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color }}>{tStatusVal(status, t) || "—"}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>
              {saved.length > 0 ? t("dashboard.jiOpenAnalysis") : t("dashboard.jiSaveJobs")}
            </div>
          )}
          <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 14, paddingTop: 12 }}>
            <button style={{ border: "none", background: "none", color: C.purple, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }} onClick={() => setPage("jobintel")}>
              {t("dashboard.viewFullAnalysis")}
            </button>
          </div>
        </Card>

        {/* Interview Intelligence */}
        <Card style={{ padding: "16px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 4 }}>{t("dashboard.interviewIntelTitle")}</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10, lineHeight: 1.4 }}>{t("dashboard.interviewIntelSubtitle")}</div>
          {mockInterviewScore != null ? (
            <div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
                <div style={{ width: 52, height: 52, borderRadius: "50%", background: (mockInterviewScore >= 8 ? C.green : mockInterviewScore >= 6 ? C.yellow : C.red) + "18", border: `2.5px solid ${mockInterviewScore >= 8 ? C.green : mockInterviewScore >= 6 ? C.yellow : C.red}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <span style={{ fontSize: 15, fontWeight: 800, color: mockInterviewScore >= 8 ? C.green : mockInterviewScore >= 6 ? C.yellow : C.red, lineHeight: 1 }}>{mockInterviewScore}</span>
                  <span style={{ fontSize: 9, color: C.textMuted, lineHeight: 1.2 }}>/ 10</span>
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 2 }}>{t("dashboard.aiInterviewScore")}</div>
                  <div style={{ fontSize: 12, color: C.textMid }}>{t("dashboard.interviewAnsweredOf").replace("{answered}", mockAnswered).replace("{total}", mockTotal)}{mockSkipped > 0 ? ` ${t("dashboard.interviewSkippedLabel").replace("{n}", mockSkipped)}` : ""}</div>
                </div>
              </div>
              {(() => { const aiS = interviewSession?.mockSummary?.aiSummary; return aiS ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                  {[[t("dashboard.interviewTechnical"), aiS.technicalPerformance], [t("dashboard.interviewBehavioral"), aiS.behavioralPerformance], [t("dashboard.interviewCommunication"), aiS.communication], [t("dashboard.interviewConfidence"), aiS.confidence]].map(([label, val]) => {
                    const col = val === "Excellent" || val === "Strong" ? C.green : val === "Good" ? C.blue : val === "Fair" ? C.yellow : C.red;
                    return <div key={label} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}><span style={{ color: C.textMid }}>{label}</span><span style={{ fontWeight: 700, color: col }}>{tStatusVal(val, t)}</span></div>;
                  })}
                </div>
              ) : null; })()}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>{t("dashboard.interviewEmpty")}</div>
          )}
          <Btn variant="secondary" style={{ marginTop: 12, padding: "6px 14px", fontSize: 12, color: C.purple }} onClick={() => setPage("interview")}>{t("dashboard.goToInterviewPrep")}</Btn>
        </Card>
      </div>

      {/* ROW 4: Salary + Career Progress + Networking Intelligence */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 16 }} className="three-col">
        {/* Salary Intelligence */}
        <Card style={{ padding: "16px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 4 }}>{t("dashboard.marketIntelTitle")}</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10, lineHeight: 1.4 }}>{t("dashboard.marketSubtitle")}</div>
          {salaryData?.results ? (
            <div>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 2 }}>{t("dashboard.medianSalary")}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: C.green, marginBottom: 6 }}>${salaryData.results.salaryRange?.median?.toLocaleString() || "—"}</div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.textMuted, marginBottom: 6 }}>
                <span>{t("dashboard.salaryLow")} <strong style={{ color: C.text }}>${(salaryData.results.salaryRange?.low || 0).toLocaleString()}</strong></span>
                <span>{t("dashboard.salaryHigh")} <strong style={{ color: C.text }}>${(salaryData.results.salaryRange?.high || 0).toLocaleString()}</strong></span>
              </div>
              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4 }}>{t("dashboard.demandLabel")} <strong style={{ color: C.text }}>{tStatusVal(salaryData.results.demandLevel, t) || "—"}</strong></div>
              {salaryData.results.marketOutlook && <div style={{ fontSize: 12, color: C.textMid, lineHeight: 1.5 }}>{salaryData.results.marketOutlook.slice(0, 110)}…</div>}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>{t("dashboard.marketIntelEmpty")}</div>
          )}
          <Btn variant="secondary" style={{ marginTop: 12, padding: "6px 14px", fontSize: 12, color: C.purple }} onClick={() => setPage("salary")}>{t("dashboard.goToSalary")}</Btn>
        </Card>

        {/* Career Progress */}
        <Card style={{ padding: "16px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 12 }}>{t("dashboard.progressTitle")}</div>
          {cpAnalysisLoading && !cpAnalysis ? (
            <div style={{ fontSize: 12, color: C.textMuted, paddingBottom: 4 }}>{t("dashboard.loading")}</div>
          ) : cpAnalysis ? (() => {
            const cp = cpAnalysis;
            const hm = { excellent: { label: t("dashboard.healthExcellent"), color: C.green }, good: { label: t("dashboard.healthGood"), color: C.blue }, fair: { label: t("dashboard.healthFair"), color: C.yellow }, needs_attention: { label: t("dashboard.healthNeedsAttention"), color: C.red } }[cp.careerHealth] || { label: t("dashboard.healthFair"), color: C.yellow };
            const topBlocker = cp.blockers?.find(b => b.priority === "high") || cp.blockers?.[0];
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {/* Career Goal */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                  <span style={{ fontSize: 12, color: C.textMid, fontWeight: 600 }}>{t("dashboard.careerGoalLabel")}</span>
                  <span style={{ fontSize: 12, color: C.text, fontWeight: 600, textAlign: "right", maxWidth: "60%" }}>{profile?.career_goal || <span style={{ color: C.textMuted, fontWeight: 400 }}>{t("dashboard.notSet")}</span>}</span>
                </div>
                {/* AI Progress Score */}
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 4 }}>
                    <span style={{ color: C.textMid, fontWeight: 600 }}>{t("dashboard.aiProgressScore")}</span>
                    <span style={{ fontWeight: 800, color: C.purple }}>{cp.progressPercent}%</span>
                  </div>
                  <PBar val={cp.progressPercent} color={C.purple} />
                </div>
                {/* Current Blocker */}
                {topBlocker && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <span style={{ fontSize: 12, color: C.textMid, fontWeight: 600, flexShrink: 0 }}>{t("dashboard.currentBlocker")}</span>
                    <span style={{ fontSize: 12, color: C.red, fontWeight: 600, textAlign: "right", maxWidth: "60%" }}>{topBlocker.issue}</span>
                  </div>
                )}
                {/* Next Milestone */}
                {cp.nextMilestone && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                    <span style={{ fontSize: 12, color: C.textMid, fontWeight: 600, flexShrink: 0 }}>{t("dashboard.nextMilestoneLabel")}</span>
                    <span style={{ fontSize: 12, color: C.text, textAlign: "right", maxWidth: "60%", lineHeight: 1.4 }}>{cp.nextMilestone}</span>
                  </div>
                )}
                {/* Career Health */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 12, color: C.textMid, fontWeight: 600 }}>{t("dashboard.careerHealthLabel")}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: hm.color, background: `${hm.color}18`, borderRadius: 20, padding: "2px 10px" }}>{hm.label}</span>
                </div>
              </div>
            );
          })() : (
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6, marginBottom: 4 }}>
              {profile?.career_goal ? t("dashboard.viewProgressPrompt") : t("dashboard.setGoalPrompt")}
            </div>
          )}
          <div style={{ borderTop: `1px solid ${C.border}`, marginTop: 14, paddingTop: 12 }}>
            <button style={{ border: "none", background: "none", color: C.purple, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }} onClick={() => setPage("progress")}>
              {t("dashboard.viewCareerProgress")}
            </button>
          </div>
        </Card>

        {/* Networking Intelligence */}
        <Card style={{ padding: "16px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 4 }}>{t("dashboard.networkingTitle")}</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10, lineHeight: 1.4 }}>{t("dashboard.networkingSubtitle")}</div>
          {networkContacts.length > 0 ? (
            <div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                {[[t("dashboard.networkingContacts"), networkContacts.length, C.purple], [t("dashboard.networkingResponded"), replied, C.green], [t("dashboard.networkingFollowUp"), followUpNeeded, followUpNeeded > 0 ? C.yellow : C.textMuted]].map(([label, val, color]) => (
                  <div key={label} style={{ flex: 1, background: `${color}12`, borderRadius: 8, padding: "6px 4px", textAlign: "center" }}>
                    <div style={{ fontSize: 15, fontWeight: 800, color }}>{val}</div>
                    <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 600 }}>{label}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                <span style={{ color: C.textMid }}>{t("dashboard.responseRate")}</span>
                <span style={{ fontWeight: 700, color: outreachRate >= 50 ? C.green : C.yellow }}>{outreachRate}%</span>
              </div>
              <PBar val={outreachRate} color={outreachRate >= 50 ? C.green : C.yellow} />
              {followUpNeeded > 0 && <div style={{ marginTop: 8, fontSize: 12, color: C.yellow, fontWeight: 600 }}>⚠ {followUpNeeded === 1 ? t("dashboard.networkingContactsWaitingSingular") : t("dashboard.networkingContactsWaitingPlural").replace("{n}", followUpNeeded)}</div>}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>{t("dashboard.networkingEmpty")}</div>
          )}
          <Btn variant="secondary" style={{ marginTop: 12, padding: "6px 14px", fontSize: 12, color: C.purple }} onClick={() => setPage("network")}>{t("dashboard.goToNetworking")}</Btn>
        </Card>
      </div>

      {/* BOTTOM: AI Chat Assistant */}
      <Card>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 14, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>🤖 {t("dashboard.assistantTitle")}</span>
          {chatMessages.length > 0 && (
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={handleClearConversation} style={{ fontSize: 11, color: C.textMuted, background: "none", border: `1px solid ${C.border}`, borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontFamily: "inherit" }}>{t("dashboard.chatClear")}</button>
              <button onClick={handleNewConversation} style={{ fontSize: 11, color: C.purple, background: "none", border: `1px solid ${C.purple}50`, borderRadius: 6, padding: "2px 8px", cursor: "pointer", fontFamily: "inherit" }}>{t("dashboard.chatNew")}</button>
            </div>
          )}
        </div>
        <div style={{ background: C.bgSoft, borderRadius: 12, padding: 16, minHeight: 180, maxHeight: 320, overflowY: "auto", marginBottom: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {chatMessages.length === 0 && (
            <div>
              <div style={{ textAlign: "center", padding: "16px 0 10px", color: C.textMuted, fontSize: 14 }}>
                <div style={{ fontSize: 24, marginBottom: 6 }}>🤖</div>
                {t("dashboard.assistantEmpty")}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "center" }}>
                {[t("dashboard.chatSuggest1"), t("dashboard.chatSuggest2"), t("dashboard.chatSuggest3"), t("dashboard.chatSuggest4"), t("dashboard.chatSuggest5"), t("dashboard.chatSuggest6"), t("dashboard.chatSuggest7"), t("dashboard.chatSuggest8")].map(p => (
                  <button key={p} onClick={() => sendChat(p)} style={{ fontSize: 11, color: C.purple, background: `${C.purple}0D`, border: `1px solid ${C.purple}30`, borderRadius: 20, padding: "4px 11px", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>{p}</button>
                ))}
              </div>
            </div>
          )}
          {chatMessages.map((m, i) => (
            <div key={i} ref={m.role === "ai" && i === chatMessages.length - 1 ? aiResponseStartRef : null} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
              <div style={{ maxWidth: "75%", padding: "10px 14px", borderRadius: 12, background: m.role === "user" ? C.purple : "#fff", color: m.role === "user" ? "#fff" : C.text, fontSize: 14, lineHeight: 1.6, boxShadow: m.role === "ai" ? "0 1px 4px rgba(0,0,0,0.06)" : "none" }}>
                {m.role === "ai" ? <MarkdownText text={m.text} /> : m.text}
              </div>
            </div>
          ))}
          {chatLoading && <div style={{ color: C.purple, fontSize: 13 }}>{t("dashboard.thinking")}</div>}
          <div ref={chatEndRef} />
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === "Enter" && sendChat()} placeholder={t("dashboard.chatPlaceholder")} style={{ flex: 1, minWidth: 0, border: `1.5px solid ${C.border}`, borderRadius: 9, padding: "12px 14px", fontSize: 14, outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
          <Btn onClick={sendChat} disabled={!chatInput.trim()} loading={chatLoading} style={{ padding: "12px 20px", flexShrink: 0 }}>{t("dashboard.send")}</Btn>
        </div>
      </Card>
    </div>
  );
}


// ─── BRIEFING PAGE ──────────────────────────────────────────
function BriefingPage({ profile, applications, savedJobs, setPage, resumes, smartApplyQueue, networkingSession, companyWatchlist }) {
  const { t, language } = useI18n();
  const { session: interviewSession } = useInterviewSession(profile?.id);
  const { data: salaryData } = useSalaryResearch(profile?.id);
  const [networkContacts] = useNetworkingContacts(profile?.id);

  const [briefing, setBriefing] = useState(() => { try { const c = sessionStorage.getItem("cp_briefing_dash"); if (!c) return null; const p = JSON.parse(c); return (p && !Array.isArray(p) && p.v === 2) ? p : null; } catch { return null; } });
  const [genLoading, setGenLoading] = useState(false);
  const { briefing: savedBriefing, loading: briefingLoading, loadedFor, save: saveBriefing } = useAiBriefing(profile?.id);
  const { logActivity } = useActivityLog(profile?.id);
  const userContext = useUserContext({ profile, applications, savedJobs, resumes: resumes ?? [], smartApplyQueue: smartApplyQueue ?? [], interviewSession, salaryData, networkContacts, networkingSession, companyWatchlist: companyWatchlist ?? [] });
  const appliedRef = useRef(undefined);

  useEffect(() => {
    if (briefingLoading || loadedFor !== profile?.id) return;
    if (appliedRef.current === profile?.id) return;
    appliedRef.current = profile?.id;
    if (savedBriefing && !Array.isArray(savedBriefing) && savedBriefing.v === 2) {
      setBriefing(savedBriefing);
      try { sessionStorage.setItem("cp_briefing_dash", JSON.stringify(savedBriefing)); } catch {}
    }
  }, [savedBriefing, briefingLoading, loadedFor, profile?.id]);

  const generate = async () => {
    setGenLoading(true);
    try {
      const ctx = userContext.getContextString();
      const result = await buildBriefingPayload(ctx, language);
      setBriefing(result);
      try { sessionStorage.setItem("cp_briefing_dash", JSON.stringify(result)); } catch {}
      saveBriefing(result).catch(err => console.error("briefing save failed", err));
      logActivity("Daily briefing regenerated");
      insertNotification(profile?.id, { type: "briefing", title: "Daily briefing updated", body: "Your personalized career briefing has been regenerated.", linkPage: "briefing" });
    } catch { /* keep existing briefing */ }
    finally { setGenLoading(false); }
  };

  const isLoading = briefingLoading && !briefing;
  const b = briefing;

  const GreenCheck = () => (
    <div style={{ width: 20, height: 20, borderRadius: "50%", background: C.green, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <span style={{ color: "#fff", fontSize: 10, fontWeight: 900, lineHeight: 1 }}>✓</span>
    </div>
  );

  const insightSections = b ? [
    { label: t("briefing.newMatchingJobs"), text: b.newMatchingJobs },
    { label: t("briefing.highestPayingJobs"), text: b.highestPayingJobs },
    { label: t("briefing.jobsClosingSoon"), text: b.jobsClosingSoon },
    { label: t("briefing.aiPriorityRec"), text: b.priorityRecommendation },
    { label: t("briefing.companiesHiring"), text: b.companiesHiringNow },
    { label: t("briefing.newOpportunities"), text: b.newOpportunities },
    { label: t("briefing.resumeUpdates"), text: b.resumeUpdates },
    { label: t("briefing.resumeOpt"), text: b.atsScoreChanges },
    { label: t("briefing.interviewInvitations"), text: b.interviewInvitations },
    { label: t("briefing.recruiterActivity"), text: b.recruiterActivity },
    { label: t("briefing.applicationUpdates"), text: b.applicationUpdates },
    { label: t("briefing.salaryChanges"), text: b.salaryChanges },
    { label: t("briefing.marketUpdates"), text: b.marketUpdates },
    { label: t("briefing.careerInsights"), text: b.careerInsights },
  ] : [];

  return (
    <div>
      {/* Back navigation */}
      <button onClick={() => setPage("dashboard")} style={{ border: "none", background: "none", color: C.textMuted, fontSize: 13, cursor: "pointer", padding: "0 0 20px 0", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}>
        {t("briefing.backToDashboard")}
      </button>

      {/* Page header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: "#6B21E8", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: "0 4px 16px #6B21E840" }}>
            <svg width="26" height="26" viewBox="0 0 26 26" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M13 2 L15 10 L23 12 L15 14 L13 22 L11 14 L3 12 L11 10 Z" fill="white"/>
              <path d="M21 2 L22 4.5 L24.5 5.5 L22 6.5 L21 9 L20 6.5 L17.5 5.5 L20 4.5 Z" fill="white" opacity="0.5"/>
            </svg>
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: C.text, marginBottom: 4 }}>{t("briefing.title")}</h1>
            <p style={{ fontSize: 13, color: C.textMuted }}>{t("briefing.subtitle")}</p>
          </div>
        </div>
        <Btn variant="secondary" style={{ fontSize: 12, padding: "6px 14px", flexShrink: 0 }} onClick={generate} loading={genLoading}>
          {genLoading ? t("briefing.generating") : t("briefing.regenerate")}
        </Btn>
      </div>

      {b?.generatedAt && (
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 24 }}>
          {t("briefing.generatedAt").replace("{date}", new Date(b.generatedAt).toLocaleDateString())}
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div style={{ textAlign: "center", padding: "60px 0", color: C.textMuted }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>🗞️</div>
          <div style={{ fontSize: 14 }}>{t("briefing.loading")}</div>
        </div>
      )}

      {/* Empty state */}
      {!b && !isLoading && (
        <Card style={{ textAlign: "center", padding: "48px 24px" }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>🗞️</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("briefing.emptyTitle")}</div>
          <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 28, maxWidth: 420, margin: "0 auto 28px" }}>{t("briefing.emptyBody")}</div>
          <Btn onClick={generate} loading={genLoading}>{genLoading ? t("briefing.generating") : t("briefing.generateBtn")}</Btn>
        </Card>
      )}

      {b && (
        <div>
          {/* Personalized AI Summary — highlighted card */}
          <Card style={{ marginBottom: 20, background: C.purpleLight, border: `1.5px solid ${C.purple}20` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
              <div style={{ width: 22, height: 22, borderRadius: "50%", background: C.purple, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                <span style={{ color: "#fff", fontSize: 11, fontWeight: 900, lineHeight: 1 }}>✓</span>
              </div>
              <span style={{ fontSize: 12, fontWeight: 700, color: C.purple }}>{t("briefing.aiSummaryLabel")}</span>
            </div>
            <p style={{ fontSize: 14, color: C.textMid, lineHeight: 1.7 }}>{b.summary}</p>
          </Card>

          {/* All 14 insight sections in 2-column grid */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }} className="two-col">
            {insightSections.map(({ label, text }) => (
              <Card key={label} style={{ padding: 18 }}>
                <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                  <GreenCheck />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.text, marginBottom: 5 }}>{label}</div>
                    <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>{text}</div>
                  </div>
                </div>
              </Card>
            ))}
          </div>

          {/* Daily Highlights */}
          {b.dailyHighlights?.length > 0 && (
            <Card style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 14 }}>{t("briefing.dailyHighlights")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {b.dailyHighlights.map((h, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <div style={{ width: 20, height: 20, borderRadius: "50%", background: C.purple, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
                      <span style={{ color: "#fff", fontSize: 9, fontWeight: 900, lineHeight: 1 }}>★</span>
                    </div>
                    <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6 }}>{h}</div>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Bottom back action */}
          <div style={{ textAlign: "center", paddingBottom: 8 }}>
            <button onClick={() => setPage("dashboard")} style={{ border: "none", background: "none", color: C.purple, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{t("briefing.backToDashboard")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── FULL ACTION PLAN PAGE ───────────────────────────────────
function PlanPage({ profile, applications, savedJobs, setPage, onNavigateResume }) {
  const { t, language } = useI18n();
  const { session: interviewSession } = useInterviewSession(profile?.id);
  const { data: salaryData } = useSalaryResearch(profile?.id);
  const [networkContacts] = useNetworkingContacts(profile?.id);

  const [plan, setPlan] = useState(null);
  const [genLoading, setGenLoading] = useState(false);
  const [genError, setGenError] = useState(null);

  const { plan: savedPlan, loading: planLoading, loadedFor, save: savePlan } = useAiActionPlan(profile?.id);
  const { logActivity } = useActivityLog(profile?.id);
  const userContext = useUserContext({ profile, applications, savedJobs, interviewSession, salaryData, networkContacts });
  const appliedRef = useRef(undefined);

  useEffect(() => {
    if (planLoading || loadedFor !== profile?.id) return;
    if (appliedRef.current === profile?.id) return;
    appliedRef.current = profile?.id;

    // 1. sessionStorage has today's plan (set by Dashboard or a previous PlanPage generate)
    try {
      const c = sessionStorage.getItem("cp_plan_dash");
      if (c) {
        const cached = JSON.parse(c);
        if (cached?.v === 2 && Array.isArray(cached?.categories) && isToday(cached.generatedAt)) {
          setPlan(cached);
          return;
        }
      }
    } catch {}

    // 2. Supabase has today's plan
    if (savedPlan && savedPlan.v === 2 && Array.isArray(savedPlan.categories) && isToday(savedPlan.generatedAt)) {
      setPlan(savedPlan);
      try { sessionStorage.setItem("cp_plan_dash", JSON.stringify(savedPlan)); } catch {}
      return;
    }

    // 3. No today's plan anywhere — auto-generate
    if (profile?.id) generate();
  }, [savedPlan, planLoading, loadedFor, profile?.id]);

  const generate = async () => {
    setGenLoading(true);
    setGenError(null);
    console.log("[PlanPage] Starting generation for user", profile?.id);
    try {
      const ctx = userContext.getContextString();
      const result = await buildPlanPayload(ctx, language);
      console.log("[PlanPage] Generation succeeded");
      setPlan(result);
      try { sessionStorage.setItem("cp_plan_dash", JSON.stringify(result)); } catch {}
      savePlan(result).catch(err => console.error("[PlanPage] save failed", err));
      logActivity("Daily plan regenerated");
      insertNotification(profile?.id, { type: "action_plan", title: "Action plan updated", body: "Today's action plan has been regenerated.", linkPage: "plan" });
    } catch (e) {
      console.error("[PlanPage] Generation failed:", e?.message || e);
      setGenError(t("plan.genError"));
    }
    finally { setGenLoading(false); }
  };

  const toggleComplete = (id) => {
    if (!plan) return;
    const isCategory = plan.categories.some(c => c.id === id);
    let updated;
    if (isCategory) {
      const categories = plan.categories.map(c =>
        c.id === id ? { ...c, status: c.status === "completed" ? "pending" : "completed" } : c
      );
      updated = { ...plan, categories };
    } else {
      const sectionCompletions = { ...(plan.sectionCompletions || {}), [id]: !(plan.sectionCompletions?.[id]) };
      updated = { ...plan, sectionCompletions };
    }
    setPlan(updated);
    try { sessionStorage.setItem("cp_plan_dash", JSON.stringify(updated)); } catch {}
    savePlan(updated).catch(err => console.error("[PlanPage] completion save failed", err));
  };

  const isLoading = (planLoading && !plan) || (genLoading && !plan);
  const p = plan;
  const completedCategories = p?.categories?.filter(c => c.status === "completed").length || 0;
  const completedSections = Object.values(p?.sectionCompletions || {}).filter(Boolean).length;
  const completedCount = completedCategories + completedSections;
  const productivityScore = p ? Math.min(100, (p.productivityScore || 60) + completedCount * 5) : 0;

  const planSectionGoTo = { followups: t("plan.goToFollowups"), networking: t("plan.goToNetworking"), certifications: t("plan.goToCertifications") };
  const additionalSections = p ? [
    { id: "followups", label: t("plan.sectionFollowups"), text: p.followUps, page: "tracker" },
    { id: "networking", label: t("plan.sectionNetworking"), text: p.networking, page: "network" },
    { id: "certifications", label: t("plan.sectionCertifications"), text: p.certifications, page: "resume" },
  ] : [];

  const categoryPageMap = { priorities: null, applications: "saved", resume: "resume", interview: "interview" };

  const StatusCircle = ({ id, filled }) => (
    <div onClick={() => toggleComplete(id)} style={{ width: 22, height: 22, borderRadius: "50%", border: `2px solid ${filled ? C.green : C.purple}`, background: filled ? C.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer" }}>
      {filled && <span style={{ color: "#fff", fontSize: 11, fontWeight: 900, lineHeight: 1 }}>✓</span>}
    </div>
  );

  return (
    <div>
      <button onClick={() => setPage("dashboard")} style={{ border: "none", background: "none", color: C.textMuted, fontSize: 13, cursor: "pointer", padding: "0 0 20px 0", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}>
        {t("plan.backToDashboard")}
      </button>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: C.purple, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: `0 4px 16px ${C.purple}40` }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="4" y="5" width="16" height="17" rx="3" stroke="white" strokeWidth="1.8"/>
              <line x1="8" y1="10" x2="16" y2="10" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              <line x1="8" y1="14" x2="13" y2="14" stroke="white" strokeWidth="1.5" strokeLinecap="round"/>
              <rect x="9" y="2" width="6" height="5" rx="1.5" fill="white" opacity="0.75"/>
            </svg>
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: C.text, marginBottom: 4 }}>{t("plan.title")}</h1>
            <p style={{ fontSize: 13, color: C.textMuted }}>{t("plan.subtitle")}</p>
          </div>
        </div>
        <Btn variant="secondary" style={{ fontSize: 12, padding: "6px 14px", flexShrink: 0 }} onClick={generate} loading={genLoading}>
          {genLoading ? t("plan.generating") : t("plan.regenerate")}
        </Btn>
      </div>

      {p?.generatedAt && (
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 24 }}>
          {t("plan.generatedAt").replace("{date}", new Date(p.generatedAt).toLocaleDateString())}
        </div>
      )}

      {isLoading && (
        <div style={{ textAlign: "center", padding: "60px 0", color: C.textMuted }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>📋</div>
          <div style={{ fontSize: 14 }}>{genLoading ? t("plan.generatingPlan") : t("plan.loadingPlan")}</div>
        </div>
      )}

      {!p && !isLoading && genError && (
        <Card style={{ textAlign: "center", padding: "32px 24px" }}>
          <div style={{ fontSize: 14, color: C.red, marginBottom: 16 }}>{genError}</div>
          <Btn onClick={generate} loading={genLoading}>{t("plan.tryAgain")}</Btn>
        </Card>
      )}

      {p && (
        <div>
          {/* AI Productivity Score */}
          <Card style={{ marginBottom: 20, background: C.purpleLight, border: `1.5px solid ${C.purple}20` }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 22, height: 22, borderRadius: "50%", background: C.purple, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <span style={{ color: "#fff", fontSize: 11, fontWeight: 900, lineHeight: 1 }}>★</span>
                </div>
                <span style={{ fontSize: 12, fontWeight: 700, color: C.purple }}>{t("plan.aiProductivityScore")}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {completedCount > 0 && <span style={{ fontSize: 12, color: C.textMuted }}>{t("plan.completedOf").replace("{done}", completedCount).replace("{total}", p.categories.length + additionalSections.length)}</span>}
                <div style={{ fontSize: 28, fontWeight: 900, color: C.purple }}>{productivityScore}<span style={{ fontSize: 14, fontWeight: 600 }}>/100</span></div>
              </div>
            </div>
            <div style={{ marginTop: 12 }}>
              <div style={{ height: 6, borderRadius: 3, background: "#E8D5FF", overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${productivityScore}%`, background: C.purple, borderRadius: 3 }} />
              </div>
            </div>
          </Card>

          {/* 4 Main Categories */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }} className="two-col">
            {p.categories.map((item) => {
              const done = item.status === "completed";
              const goPage = categoryPageMap[item.id];
              return (
                <Card key={item.id} style={{ padding: 18 }}>
                  <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <StatusCircle id={item.id} filled={done} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8, marginBottom: 6 }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: done ? C.textMuted : C.text, textDecoration: done ? "line-through" : "none" }}>{tPlanCat(item.id, t, item.category)}</div>
                        <div style={{ fontSize: 11, color: C.textMuted, flexShrink: 0 }}>{item.time}</div>
                      </div>
                      <div style={{ fontSize: 13, color: done ? C.textMuted : C.textMid, lineHeight: 1.6, marginBottom: goPage ? 10 : 0, textDecoration: done ? "line-through" : "none" }}>{item.task}</div>
                      {goPage && (
                        <button onClick={() => {
                          if (goPage === "resume" && onNavigateResume) { onNavigateResume(); }
                          else if (goPage === "saved") { setPage("saved"); setTimeout(() => document.getElementById("smart-apply-queue")?.scrollIntoView({ behavior: "smooth", block: "start" }), 400); }
                          else { setPage(goPage); }
                        }} style={{ border: "none", background: "none", color: C.purple, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
                          {t("plan.goTo").replace("{n}", tPlanCat(item.id, t, item.category))}
                        </button>
                      )}
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>

          {/* Additional Sections */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }} className="two-col">
            {additionalSections.map(({ id, label, text, page: goPage }, idx) => {
              const done = !!p.sectionCompletions?.[id];
              return (
                <Card key={id} style={{ padding: 18, ...(idx === additionalSections.length - 1 && additionalSections.length % 2 !== 0 ? { gridColumn: "1 / -1" } : {}) }}>
                  <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                    <StatusCircle id={id} filled={done} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: done ? C.textMuted : C.text, marginBottom: 6, textDecoration: done ? "line-through" : "none" }}>{label}</div>
                      <div style={{ fontSize: 13, color: done ? C.textMuted : C.textMid, lineHeight: 1.6, marginBottom: 10, textDecoration: done ? "line-through" : "none" }}>{text}</div>
                      <button onClick={() => goPage === "resume" && onNavigateResume ? onNavigateResume() : setPage(goPage)} style={{ border: "none", background: "none", color: C.purple, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
                        {planSectionGoTo[id] || t("plan.goTo").replace("{n}", label.split(" ")[0])}
                      </button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>

          <div style={{ textAlign: "center", paddingBottom: 8 }}>
            <button onClick={() => setPage("dashboard")} style={{ border: "none", background: "none", color: C.purple, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{t("plan.backToDashboard")}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── CAREER PROGRESS PAGE ────────────────────────────────────────────────────
function CareerProgressPage({ profile, applications, savedJobs, setPage, updateProfile, resumes, analysisHistory, onNavigateResume }) {
  const { t } = useI18n();
  const { session: interviewSession } = useInterviewSession(profile?.id);
  const { data: salaryData } = useSalaryResearch(profile?.id);
  const [networkContacts] = useNetworkingContacts(profile?.id);
  const { logActivity } = useActivityLog(profile?.id);

  const { analysis: savedAnalysis, loading: analysisLoading, loadedFor, save: saveAnalysis } = useCareerProgressAnalysis(profile?.id);

  const [analysis, setAnalysis] = useState(() => {
    try { const c = sessionStorage.getItem("cp_progress_analysis"); if (!c) return null; const p = JSON.parse(c); return p?.v === 1 ? p : null; } catch { return null; }
  });
  const [genLoading, setGenLoading] = useState(false);
  const [editingGoal, setEditingGoal] = useState(false);
  const [goalDraft, setGoalDraft] = useState(profile?.career_goal || "");
  const [timelineDraft, setTimelineDraft] = useState(profile?.career_timeline || "");
  const [goalSaving, setGoalSaving] = useState(false);

  const userContext = useUserContext({ profile, applications, savedJobs, interviewSession, salaryData, networkContacts });
  const appliedRef = useRef(undefined);

  useEffect(() => {
    if (analysisLoading || loadedFor !== profile?.id) return;
    if (appliedRef.current === profile?.id) return;
    appliedRef.current = profile?.id;
    if (savedAnalysis?.v === 1) {
      setAnalysis(savedAnalysis);
      try { sessionStorage.setItem("cp_progress_analysis", JSON.stringify(savedAnalysis)); } catch {}
    }
  }, [savedAnalysis, analysisLoading, loadedFor, profile?.id]);

  const generate = async () => {
    setGenLoading(true);
    try {
      const ctx = userContext.getContextString();
      const result = await buildCareerProgressPayload(ctx, profile?.career_goal, profile?.career_timeline, t);
      setAnalysis(result);
      insertNotification(profile?.id, { type: "career_progress", title: "Career progress report ready.", body: "Your career progress report has been generated." });
      try { sessionStorage.setItem("cp_progress_analysis", JSON.stringify(result)); } catch {}
      saveAnalysis(result).catch(err => console.error("career progress save failed", err));
      logActivity("Career progress assessment generated");
    } catch {}
    finally { setGenLoading(false); }
  };

  // Auto-generate when Supabase load completes and there is no analysis yet
  const autoGenRef = useRef(false);
  useEffect(() => {
    if (analysisLoading || loadedFor !== profile?.id) return;
    if (analysis || genLoading || autoGenRef.current) return;
    autoGenRef.current = true;
    generate();
  }, [analysisLoading, loadedFor, analysis]);

  const saveGoal = async () => {
    setGoalSaving(true);
    try { await updateProfile({ career_goal: goalDraft.trim(), career_timeline: timelineDraft.trim() }); setEditingGoal(false); } catch {}
    finally { setGoalSaving(false); }
  };

  const isLoading = (analysisLoading && !analysis) || (genLoading && !analysis);
  const a = analysis;

  const healthMeta = {
    excellent: { label: t("progress.healthExcellent"), color: C.green, bg: C.greenLight },
    good: { label: t("progress.healthGood"), color: C.blue, bg: C.blueLight },
    fair: { label: t("progress.healthFair"), color: C.yellow, bg: C.yellowLight },
    needs_attention: { label: t("progress.healthNeedsAttention"), color: C.red, bg: C.redLight },
  };
  const hm = healthMeta[a?.careerHealth] || healthMeta.fair;

  const priorityMeta = { high: { color: C.red, bg: C.redLight, label: t("progress.priorityHigh") }, medium: { color: C.yellow, bg: C.yellowLight, label: t("progress.priorityMedium") }, low: { color: C.green, bg: C.greenLight, label: t("progress.priorityLow") } };

  // Real computed career metrics
  const apps = applications ?? [];
  const totalApps = apps.length;
  const interviews = apps.filter(a => ["Interview", "Final Interview", "Phone Screen"].includes(a.status)).length;
  const offers = apps.filter(a => a.status === "Offer").length;
  const atsScores = apps.map(a => Number(a.atsScore) || 0).filter(n => n > 0);
  const bestAts = atsScores.length ? Math.max(...atsScores) : null;
  const profileComplete = profile ? Math.round((["full_name","email_address","phone","location","job_title","years_experience","preferred_job_title","work_type"].filter(f => profile[f]).length / 8) * 100) : 0;

  // Resume Improvements — live data from existing Resume Intelligence module
  const resumeList = resumes ?? [];
  const bestResume = resumeList.filter(r => r.ats_score != null).sort((a, b) => (b.ats_score ?? 0) - (a.ats_score ?? 0))[0] ?? null;
  const resumeAts = bestResume?.ats_score ?? null;

  const goToResume = () => onNavigateResume ? onNavigateResume() : setPage("resume");

  // Salary Growth — live data from existing Market Intelligence module
  const salaryRange = salaryData?.results?.salaryRange || salaryData?.results?.marketRange || null;
  const marketMedian = salaryRange?.median ?? null;
  const desiredRaw = parseInt((profile?.desired_salary || "").replace(/[^0-9]/g, ""), 10);
  const desiredSalary = isNaN(desiredRaw) ? null : desiredRaw;
  const salaryGrowthPct = marketMedian && desiredSalary ? Math.round(((desiredSalary - marketMedian) / marketMedian) * 100) : null;

  return (
    <div>
      <button onClick={() => setPage("dashboard")} style={{ border: "none", background: "none", color: C.textMuted, fontSize: 13, cursor: "pointer", padding: "0 0 20px 0", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}>
        {t("progress.backToDashboard")}
      </button>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: C.purple, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: `0 4px 16px ${C.purple}40` }}>
            <span style={{ fontSize: 22 }}>📈</span>
          </div>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800, color: C.text, lineHeight: 1.1 }}>{t("progress.title")}</div>
            <div style={{ fontSize: 13, color: C.textMuted, marginTop: 3 }}>{t("progress.subtitle")}</div>
          </div>
        </div>
        <button onClick={generate} disabled={genLoading} style={{ border: `1px solid ${C.border}`, background: "#fff", color: C.purple, fontSize: 13, fontWeight: 600, cursor: genLoading ? "not-allowed" : "pointer", padding: "8px 16px", borderRadius: 8, fontFamily: "inherit", opacity: genLoading ? 0.6 : 1 }}>
          {genLoading ? t("progress.analyzing") : t("progress.regenerate")}
        </button>
      </div>

      {/* Career Goal */}
      <Card style={{ padding: "18px 20px", marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: editingGoal ? 14 : (profile?.career_goal ? 10 : 0) }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText }}>{t("progress.careerGoalLabel")}</div>
          {!editingGoal && (
            <button onClick={() => { setGoalDraft(profile?.career_goal || ""); setTimelineDraft(profile?.career_timeline || ""); setEditingGoal(true); }} style={{ border: "none", background: "none", color: C.purple, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
              {profile?.career_goal ? t("progress.editGoal") : t("progress.setGoal")}
            </button>
          )}
        </div>

        {editingGoal ? (
          <div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.textMid, marginBottom: 6 }}>{t("progress.goalQuestion")}</div>
              <textarea value={goalDraft} onChange={e => setGoalDraft(e.target.value)} placeholder={t("progress.goalPlaceholder")} rows={3} style={{ width: "100%", borderRadius: 8, border: `1px solid ${C.border}`, padding: "10px 12px", fontSize: 13, color: C.text, fontFamily: "inherit", resize: "vertical", boxSizing: "border-box", outline: "none" }} />
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: C.textMid, marginBottom: 6 }}>{t("progress.targetTimeline")}</div>
              <select value={timelineDraft} onChange={e => setTimelineDraft(e.target.value)} style={{ borderRadius: 8, border: `1px solid ${C.border}`, padding: "8px 12px", fontSize: 13, color: C.text, fontFamily: "inherit", background: "#fff", width: "100%" }}>
                <option value="">{t("progress.selectTimeline")}</option>
                <option value="3 months">{t("progress.timeline3m")}</option>
                <option value="6 months">{t("progress.timeline6m")}</option>
                <option value="1 year">{t("progress.timeline1y")}</option>
                <option value="18 months">{t("progress.timeline18m")}</option>
                <option value="2 years">{t("progress.timeline2y")}</option>
                <option value="3+ years">{t("progress.timeline3y")}</option>
              </select>
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button onClick={saveGoal} disabled={goalSaving || !goalDraft.trim()} style={{ background: C.purple, color: "#fff", border: "none", borderRadius: 8, padding: "8px 18px", fontSize: 13, fontWeight: 600, cursor: goalSaving || !goalDraft.trim() ? "not-allowed" : "pointer", fontFamily: "inherit", opacity: goalSaving || !goalDraft.trim() ? 0.6 : 1 }}>
                {goalSaving ? t("progress.savingGoal") : t("progress.saveGoal")}
              </button>
              <button onClick={() => setEditingGoal(false)} style={{ background: "none", color: C.textMuted, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 14px", fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>{t("progress.cancel")}</button>
            </div>
          </div>
        ) : profile?.career_goal ? (
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text, lineHeight: 1.4, marginBottom: profile?.career_timeline ? 6 : 0 }}>{profile.career_goal}</div>
            {profile?.career_timeline && <div style={{ fontSize: 13, color: C.textMuted }}>{t("progress.targetLabel").replace("{n}", profile.career_timeline)}</div>}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>{t("progress.noGoalSet")}</div>
        )}
      </Card>

      {isLoading ? (
        <Card style={{ padding: "36px 24px", textAlign: "center", marginBottom: 16 }}>
          <div style={{ fontSize: 24, marginBottom: 12 }}>📊</div>
          <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginBottom: 6 }}>{t("progress.analyzingProgress")}</div>
          <div style={{ fontSize: 13, color: C.textMuted }}>{t("progress.analyzingProgressBody")}</div>
        </Card>
      ) : a ? (
        <>
          {/* Progress Assessment */}
          <Card style={{ padding: "18px 20px", marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 14 }}>{t("progress.aiProgressAssessment")}</div>
            <div style={{ display: "flex", gap: 20, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
              {/* Progress ring */}
              <div style={{ position: "relative", width: 80, height: 80, flexShrink: 0 }}>
                <svg width="80" height="80" viewBox="0 0 80 80">
                  <circle cx="40" cy="40" r="32" fill="none" stroke={C.border} strokeWidth="8" />
                  <circle cx="40" cy="40" r="32" fill="none" stroke={C.purple} strokeWidth="8"
                    strokeDasharray={`${(a.progressPercent / 100) * 201} 201`}
                    strokeLinecap="round"
                    transform="rotate(-90 40 40)" />
                </svg>
                <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                  <div style={{ fontSize: 17, fontWeight: 800, color: C.purple, lineHeight: 1 }}>{a.progressPercent}%</div>
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{t("progress.careerHealth")}</span>
                  <span style={{ fontSize: 11, fontWeight: 700, color: hm.color, background: hm.bg, borderRadius: 20, padding: "2px 10px" }}>{hm.label}</span>
                </div>
                <div style={{ fontSize: 14, color: C.textMid, lineHeight: 1.6 }}>{a.assessment}</div>
              </div>
            </div>
            {a.generatedAt && <div style={{ fontSize: 11, color: C.textMuted }}>{t("progress.generatedAt").replace("{date}", new Date(a.generatedAt).toLocaleDateString())}</div>}
          </Card>

          {/* Current Blockers */}
          {a.blockers?.length > 0 && (
            <Card style={{ padding: "18px 20px", marginBottom: 16 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 12 }}>{t("progress.currentBlockers")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {a.blockers.map((b, i) => {
                  const pm = priorityMeta[b.priority] || priorityMeta.medium;
                  return (
                    <div key={i} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: pm.color, background: pm.bg, borderRadius: 20, padding: "2px 9px", flexShrink: 0, marginTop: 1 }}>{pm.label}</span>
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 2 }}>{b.issue}</div>
                        <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.5 }}>{b.detail}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Next Milestone */}
          {a.nextMilestone && (
            <Card style={{ padding: "18px 20px", marginBottom: 16, background: C.purpleLight, border: `1px solid ${C.purple}30` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.purple, marginBottom: 8 }}>{t("progress.nextMilestone")}</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text, lineHeight: 1.6 }}>{a.nextMilestone}</div>
            </Card>
          )}

          {/* Career Metrics */}
          <Card style={{ padding: "18px 20px", marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 14 }}>{t("progress.careerMetrics")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
              {[
                { label: t("progress.metricProfile"), value: `${profileComplete}%`, color: C.purple },
                { label: t("progress.metricApplications"), value: totalApps, color: C.blue },
                { label: t("progress.metricInterviews"), value: interviews, color: C.orange },
                { label: t("progress.metricOffers"), value: offers, color: C.green },
                { label: t("progress.metricBestAts"), value: bestAts != null ? `${bestAts}%` : "—", color: C.purple },
                { label: t("progress.metricNetwork"), value: networkContacts.length, color: "#0891B2" },
              ].map(({ label, value, color }) => (
                <div key={label} style={{ background: `${color}0F`, borderRadius: 10, padding: "10px 8px", textAlign: "center" }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: C.textMuted, marginTop: 4 }}>{label}</div>
                </div>
              ))}
            </div>
          </Card>

          {/* Skills Progress */}
          <Card style={{ padding: "18px 20px", marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 12 }}>{t("progress.skillsProgress")}</div>
            {a.skills?.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {a.skills.map((sk, i) => {
                  const lvl = { advanced: { label: t("progress.skillAdvanced"), color: C.green, bg: C.greenLight, pct: 90 }, intermediate: { label: t("progress.skillIntermediate"), color: C.blue, bg: C.blueLight, pct: 55 }, beginner: { label: t("progress.skillBeginner"), color: C.yellow, bg: C.yellowLight, pct: 25 } }[sk.level] || { label: sk.level, color: C.textMuted, bg: C.bgSoft, pct: 30 };
                  return (
                    <div key={i}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{sk.name}</span>
                        <span style={{ fontSize: 11, fontWeight: 700, color: lvl.color, background: lvl.bg, borderRadius: 20, padding: "2px 10px" }}>{lvl.label}</span>
                      </div>
                      <div style={{ height: 5, borderRadius: 3, background: C.border, overflow: "hidden", marginBottom: sk.gap ? 5 : 0 }}>
                        <div style={{ height: "100%", width: `${lvl.pct}%`, background: lvl.color, borderRadius: 3, transition: "width 0.4s ease" }} />
                      </div>
                      {sk.gap && <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.5 }}>{sk.gap}</div>}
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: C.textMuted }}>{t("progress.skillsEmpty")}</div>
            )}
          </Card>

          {/* Resume Improvements */}
          <Card style={{ padding: "18px 20px", marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 12 }}>{t("progress.resumeImprovements")}</div>
            {resumeAts != null ? (
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                  <span style={{ fontSize: 13, color: C.textMid }}>{bestResume?.name || "Resume"}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: resumeAts >= 80 ? C.green : resumeAts >= 60 ? C.yellow : C.red }}>{resumeAts}% ATS</span>
                </div>
                <div style={{ height: 6, borderRadius: 3, background: C.border, overflow: "hidden", marginBottom: 8 }}>
                  <div style={{ height: "100%", width: `${resumeAts}%`, background: resumeAts >= 80 ? C.green : resumeAts >= 60 ? C.yellow : C.red, borderRadius: 3 }} />
                </div>
                {resumeAts < 95 && (
                  <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>
                    {resumeAts < 60 ? t("progress.resumeOptLow") : resumeAts < 80 ? t("progress.resumeOptMid") : t("progress.resumeOptHigh")}
                  </div>
                )}
                <button onClick={goToResume} style={{ border: "none", background: "none", color: C.purple, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
                  {t("progress.goToResumeIntel")}
                </button>
              </div>
            ) : resumeList.length > 0 ? (
              <div>
                <div style={{ fontSize: 13, color: C.textMid, marginBottom: 10 }}>{resumeList.length !== 1 ? t("progress.resumesUploadedPlural").replace("{n}", resumeList.length) : t("progress.resumesUploadedSingular").replace("{n}", resumeList.length)}</div>
                <button onClick={goToResume} style={{ border: "none", background: "none", color: C.purple, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>{t("progress.goToResumeIntel")}</button>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 10 }}>{t("progress.uploadResumeBody")}</div>
                <button onClick={goToResume} style={{ border: "none", background: "none", color: C.purple, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>{t("progress.goToResumeIntel")}</button>
              </div>
            )}
          </Card>

          {/* Salary Growth */}
          <Card style={{ padding: "18px 20px", marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 12 }}>{t("progress.salaryGrowth")}</div>
            {marketMedian ? (
              <div>
                <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                  {[
                    { label: t("progress.marketMedian"), value: `$${Math.round(marketMedian / 1000)}K`, color: C.blue },
                    salaryRange?.low ? { label: t("progress.marketLow"), value: `$${Math.round(salaryRange.low / 1000)}K`, color: C.textMuted } : null,
                    salaryRange?.high ? { label: t("progress.marketHigh"), value: `$${Math.round(salaryRange.high / 1000)}K`, color: C.green } : null,
                    desiredSalary ? { label: t("progress.yourTarget"), value: `$${Math.round(desiredSalary / 1000)}K`, color: C.purple } : null,
                  ].filter(Boolean).map(({ label, value, color }) => (
                    <div key={label} style={{ flex: 1, background: `${color}0F`, borderRadius: 8, padding: "8px 6px", textAlign: "center" }}>
                      <div style={{ fontSize: 14, fontWeight: 800, color }}>{value}</div>
                      <div style={{ fontSize: 10, fontWeight: 600, color: C.textMuted, marginTop: 2 }}>{label}</div>
                    </div>
                  ))}
                </div>
                {salaryGrowthPct !== null && (
                  <div style={{ fontSize: 13, color: salaryGrowthPct > 0 ? C.green : salaryGrowthPct < 0 ? C.red : C.textMid, fontWeight: 600, marginBottom: 8 }}>
                    {salaryGrowthPct > 0 ? t("progress.targetAboveMarket").replace("{n}", salaryGrowthPct)
                      : salaryGrowthPct < 0 ? t("progress.targetBelowMarket").replace("{n}", Math.abs(salaryGrowthPct))
                      : t("progress.targetMatchesMarket")}
                  </div>
                )}
                {salaryData?.form?.jobTitle && <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>{salaryData.form.location ? t("progress.basedOnResearchLoc").replace("{role}", salaryData.form.jobTitle).replace("{location}", salaryData.form.location) : t("progress.basedOnResearchBase").replace("{role}", salaryData.form.jobTitle)}</div>}
                <button onClick={() => setPage("salary")} style={{ border: "none", background: "none", color: C.purple, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
                  {t("progress.goToMarketIntel")}
                </button>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 10 }}>{t("progress.runSalaryResearch")}</div>
                <button onClick={() => setPage("salary")} style={{ border: "none", background: "none", color: C.purple, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>{t("progress.goToMarketIntel")}</button>
              </div>
            )}
          </Card>
        </>
      ) : (
        <Card style={{ padding: "28px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>
            {profile?.career_goal ? t("progress.clickRegenerate") : t("progress.setGoalForTracking")}
          </div>
        </Card>
      )}

      <div style={{ textAlign: "center", paddingTop: 8, paddingBottom: 8 }}>
        <button onClick={() => setPage("dashboard")} style={{ border: "none", background: "none", color: C.purple, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{t("progress.backToDashboard")}</button>
      </div>
    </div>
  );
}

// ─── RESUME PAGE ───────────────────────────────────────────
const SAMPLE_RESUME = `John Smith | john@email.com | San Francisco, CA | (415) 555-0123

SUMMARY
Results-driven Software Engineer with 4 years of experience building scalable web applications using React, Node.js, and Python. Passionate about clean code and exceptional user experiences.

EXPERIENCE
Senior Software Engineer — Acme Corp (2022–Present)
• Built customer-facing dashboards serving 50,000+ daily active users
• Reduced API response time by 40% through query optimization
• Led team of 3 engineers on payment integration project

Software Engineer — StartupXYZ (2020–2022)
• Developed React components for e-commerce platform ($2M revenue)
• Implemented CI/CD pipeline reducing deployment time by 60%

EDUCATION
B.S. Computer Science — UC Berkeley, 2020 | GPA: 3.7

SKILLS
JavaScript, TypeScript, React, Node.js, Python, SQL, AWS, Git, Docker`;

const SAMPLE_JOB = `Senior Frontend Engineer — TechCorp (Remote)

We're looking for a Senior Frontend Engineer to join our growing team.

Requirements:
• 4+ years experience with React and TypeScript
• Experience with GraphQL, Redux, and Next.js
• Strong understanding of CI/CD pipelines
• Experience with AWS or similar cloud platforms

Salary: $140,000–$180,000 + equity + benefits
Location: Remote-first`;

// ─── JOB INTELLIGENCE PAGE ───────────────────────────────────────────────────
function JobIntelligencePage({ profile, applications, savedJobs, setPage }) {
  const { t } = useI18n();
  const { analysis: savedAnalysis, loading: analysisLoading, loadedFor, save: saveAnalysis } = useJobIntelligenceAnalysis(profile?.id);
  const { logActivity } = useActivityLog(profile?.id);

  const [analysis, setAnalysis] = useState(() => {
    try { const c = sessionStorage.getItem("cp_job_intel_analysis"); if (!c) return null; const p = JSON.parse(c); return p?.v === 1 ? p : null; } catch { return null; }
  });
  const [genLoading, setGenLoading] = useState(false);
  const [genError, setGenError] = useState(null);
  const appliedRef = useRef(undefined);

  useEffect(() => {
    if (analysisLoading || loadedFor !== profile?.id) return;
    if (appliedRef.current === profile?.id) return;
    appliedRef.current = profile?.id;
    if (savedAnalysis?.v === 1) {
      setAnalysis(savedAnalysis);
      try { sessionStorage.setItem("cp_job_intel_analysis", JSON.stringify(savedAnalysis)); } catch {}
    }
  }, [savedAnalysis, analysisLoading, loadedFor, profile?.id]);

  const generate = async () => {
    setGenLoading(true);
    setGenError(null);
    try {
      const result = await buildJobIntelligencePayload(profile, savedJobs, applications);
      setAnalysis(result);
      insertNotification(profile?.id, { type: "job_intel", title: "Job Intelligence updated.", body: "Job Intelligence has finished analyzing your opportunities." });
      try { sessionStorage.setItem("cp_job_intel_analysis", JSON.stringify(result)); } catch {}
      saveAnalysis(result).catch(err => console.error("[JobIntel] save failed", err));
      logActivity("Job Intelligence landscape analysis generated");
    } catch (e) {
      setGenError(t("jobIntel.genError"));
    } finally { setGenLoading(false); }
  };

  const autoGenRef = useRef(false);
  useEffect(() => {
    if (analysisLoading || loadedFor !== profile?.id) return;
    if (analysis || genLoading || autoGenRef.current) return;
    autoGenRef.current = true;
    generate();
  }, [analysisLoading, loadedFor, analysis]); // eslint-disable-line react-hooks/exhaustive-deps

  const statusColor = (status) => {
    const s = (status || "").toLowerCase();
    if (["excellent", "strong", "consistent"].includes(s)) return C.green;
    if (["good", "focused", "aligned", "improving", "solid"].includes(s)) return C.blue;
    if (["fair", "stable", "broad", "moderate"].includes(s)) return C.yellow;
    if (["limited", "scattered", "needs focus", "needs review"].includes(s)) return C.red;
    return C.textMuted;
  };

  const statusBg = (status) => {
    const color = statusColor(status);
    return `${color}14`;
  };

  const isLoading = (analysisLoading && !analysis) || (genLoading && !analysis);
  const a = analysis;

  const sections = [
    {
      key: "marketPatterns",
      title: t("jobIntel.secMarketPatternsTitle"),
      subtitle: t("jobIntel.secMarketPatternsSubtitle"),
      data: a?.marketPatterns,
      renderDetail: (d) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 14, color: C.textMid, lineHeight: 1.65 }}>{d.summary}</div>
          {d.evidence?.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>{t("jobIntel.observedPatterns")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {d.evidence.map((e, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <span style={{ color: C.blue, fontSize: 12, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>→</span>
                    <span style={{ fontSize: 13, color: C.textMid, lineHeight: 1.5 }}>{e}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {d.trends && (
            <div style={{ background: C.blueLight, borderRadius: 8, padding: "10px 12px", borderLeft: `3px solid ${C.blue}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.blue, marginBottom: 3 }}>{t("jobIntel.trend")}</div>
              <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.5 }}>{d.trends}</div>
            </div>
          )}
        </div>
      ),
    },
    {
      key: "employerDemand",
      title: t("jobIntel.secEmployerDemandTitle"),
      subtitle: t("jobIntel.secEmployerDemandSubtitle"),
      data: a?.employerDemand,
      renderDetail: (d) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 14, color: C.textMid, lineHeight: 1.65 }}>{d.summary}</div>
          {d.topSkills?.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>{t("jobIntel.mostRequestedSkills")}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {d.topSkills.map((skill, i) => (
                  <span key={i} style={{ fontSize: 12, fontWeight: 600, background: C.purpleLight, color: C.purple, borderRadius: 20, padding: "4px 12px" }}>{skill}</span>
                ))}
              </div>
            </div>
          )}
          {d.qualifications?.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>{t("jobIntel.commonQualifications")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {d.qualifications.map((q, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <span style={{ color: C.purple, fontSize: 12, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>·</span>
                    <span style={{ fontSize: 13, color: C.textMid, lineHeight: 1.5 }}>{q}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {d.insight && (
            <div style={{ background: C.purpleLight, borderRadius: 8, padding: "10px 12px", borderLeft: `3px solid ${C.purple}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.purple, marginBottom: 3 }}>{t("jobIntel.keyInsight")}</div>
              <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.5 }}>{d.insight}</div>
            </div>
          )}
        </div>
      ),
    },
    {
      key: "marketFit",
      title: t("jobIntel.secMarketFitTitle"),
      subtitle: t("jobIntel.secMarketFitSubtitle"),
      data: a?.marketFit,
      renderDetail: (d) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 14, color: C.textMid, lineHeight: 1.65 }}>{d.narrative}</div>
          {(d.strengths?.length > 0 || d.gaps?.length > 0) && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {d.strengths?.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.green, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>{t("jobIntel.strengths")}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {d.strengths.map((s, i) => (
                      <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                        <span style={{ color: C.green, fontSize: 11, flexShrink: 0, marginTop: 2 }}>✓</span>
                        <span style={{ fontSize: 12, color: C.textMid, lineHeight: 1.4 }}>{s}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {d.gaps?.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.yellow, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.5 }}>{t("jobIntel.gaps")}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {d.gaps.map((g, i) => (
                      <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                        <span style={{ color: C.yellow, fontSize: 11, flexShrink: 0, marginTop: 2 }}>△</span>
                        <span style={{ fontSize: 12, color: C.textMid, lineHeight: 1.4 }}>{g}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {d.positioning && (
            <div style={{ background: C.greenLight, borderRadius: 8, padding: "10px 12px", borderLeft: `3px solid ${C.green}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.green, marginBottom: 3 }}>{t("jobIntel.marketPositioning")}</div>
              <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.5 }}>{d.positioning}</div>
            </div>
          )}
        </div>
      ),
    },
    {
      key: "searchStrategy",
      title: t("jobIntel.secSearchStrategyTitle"),
      subtitle: t("jobIntel.secSearchStrategySubtitle"),
      data: a?.searchStrategy,
      renderDetail: (d) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 14, color: C.textMid, lineHeight: 1.65 }}>{d.summary}</div>
          {d.alignment && (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <span style={{ color: C.blue, fontSize: 12, fontWeight: 700, flexShrink: 0, marginTop: 2 }}>{t("jobIntel.goalAlignment")}</span>
              <span style={{ fontSize: 13, color: C.textMid, lineHeight: 1.5 }}>{d.alignment}</span>
            </div>
          )}
          {d.recommendation && (
            <div style={{ background: C.blueLight, borderRadius: 8, padding: "10px 12px", borderLeft: `3px solid ${C.blue}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.blue, marginBottom: 3 }}>{t("jobIntel.strategicRec")}</div>
              <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.5 }}>{d.recommendation}</div>
            </div>
          )}
        </div>
      ),
    },
    {
      key: "searchPerformance",
      title: t("jobIntel.secSearchPerfTitle"),
      subtitle: t("jobIntel.secSearchPerfSubtitle"),
      data: a?.searchPerformance,
      renderDetail: (d) => (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ fontSize: 14, color: C.textMid, lineHeight: 1.65 }}>{d.summary}</div>
          {d.patterns?.length > 0 && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>{t("jobIntel.performancePatterns")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {d.patterns.map((p, i) => (
                  <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                    <span style={{ color: C.green, fontSize: 12, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>↗</span>
                    <span style={{ fontSize: 13, color: C.textMid, lineHeight: 1.5 }}>{p}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {d.insight && (
            <div style={{ background: C.greenLight, borderRadius: 8, padding: "10px 12px", borderLeft: `3px solid ${C.green}` }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.green, marginBottom: 3 }}>{t("jobIntel.analyticalConclusion")}</div>
              <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.5 }}>{d.insight}</div>
            </div>
          )}
        </div>
      ),
    },
  ];

  return (
    <div>
      <button onClick={() => setPage("dashboard")} style={{ border: "none", background: "none", color: C.textMuted, fontSize: 13, cursor: "pointer", padding: "0 0 20px 0", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}>
        {t("jobIntel.backToDashboard")}
      </button>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: C.purple, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: `0 4px 16px ${C.purple}40` }}>
            <span style={{ fontSize: 22 }}>🧠</span>
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: C.text, marginBottom: 4 }}>{t("jobIntel.title")}</h1>
            <p style={{ fontSize: 13, color: C.textMuted }}>{t("jobIntel.subtitle")}</p>
          </div>
        </div>
        <Btn variant="secondary" style={{ fontSize: 12, padding: "6px 14px", flexShrink: 0 }} onClick={generate} loading={genLoading}>
          {genLoading ? t("jobIntel.analyzing") : t("jobIntel.regenerate")}
        </Btn>
      </div>

      {a?.generatedAt && (
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 24 }}>
          {t("jobIntel.generatedAt").replace("{date}", new Date(a.generatedAt).toLocaleDateString())}
        </div>
      )}

      {genError && (
        <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 10, padding: "10px 14px", marginBottom: 16, fontSize: 13, color: C.red }}>{genError}</div>
      )}

      {isLoading ? (
        <Card style={{ padding: "40px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 14, color: C.textMuted }}>{t("jobIntel.loadingLandscape")}</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6 }}>{t("jobIntel.loadingTakes")}</div>
        </Card>
      ) : !a ? (
        <Card style={{ padding: "40px 20px", textAlign: "center" }}>
          <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 16 }}>
            {(savedJobs?.length ?? 0) === 0
              ? t("jobIntel.emptyNoJobs")
              : t("jobIntel.emptyHasJobs")}
          </div>
          <Btn onClick={generate} disabled={genLoading}>{genLoading ? t("jobIntel.analyzing") : t("jobIntel.generateAnalysis")}</Btn>
        </Card>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Summary strip */}
          <Card style={{ padding: "16px 20px" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 12, textTransform: "uppercase", letterSpacing: 0.5 }}>{t("jobIntel.landscapeOverview")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8 }} className="five-col">
              {sections.map(({ title, key }) => {
                const status = a?.[key]?.status;
                return (
                  <div key={key} style={{ background: statusBg(status), borderRadius: 8, padding: "10px 8px", textAlign: "center" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: statusColor(status), marginBottom: 2 }}>{tStatusVal(status, t) || "—"}</div>
                    <div style={{ fontSize: 10, color: C.textMuted, lineHeight: 1.3 }}>{title}</div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Five analysis sections */}
          {sections.map(({ key, title, subtitle, data, renderDetail }) => (
            <Card key={key} style={{ padding: "20px 22px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 3 }}>{title}</div>
                  <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.4 }}>{subtitle}</div>
                </div>
                {data?.status && (
                  <span style={{ fontSize: 12, fontWeight: 700, color: statusColor(data.status), background: statusBg(data.status), borderRadius: 20, padding: "4px 12px", flexShrink: 0, marginLeft: 12 }}>
                    {data.status}
                  </span>
                )}
              </div>
              <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 14 }}>
                {data ? renderDetail(data) : (
                  <div style={{ fontSize: 13, color: C.textMuted }}>{t("jobIntel.noData")}</div>
                )}
              </div>
            </Card>
          ))}

          {a.generatedAt && (
            <div style={{ fontSize: 11, color: C.textMuted, textAlign: "center", paddingBottom: 8 }}>
              {t("jobIntel.analysisFooter").replace("{date}", new Date(a.generatedAt).toLocaleDateString())}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// RESUME_STEPS defined inline in JSX via t() — see Spinner usage below

function ResumePage({ onSave, onNavigate, profile, applications, savedJobs, resumes, resumesLoading, saveResume, deleteResume, downloadResume, saveAnalysis, updateVersionLabel, updateResumeLanguage, analysisHistory, saveHistoryToDb, activeResumeId, onResumeLoad, entryTarget, onConsumeEntryTarget, jobLanguage, isPremium, billingState }) {
  const { t, language } = useI18n();
  // Mirrors the exact billingState -> canUseAI derivation JobSearchPage already
  // uses (App.jsx handleSmartApplyClick) -- same computed value, not a second
  // entitlement source. Real enforcement stays server-side (worker.js handleClaude).
  const bs = billingState?.billingState || "FREE";
  const canUseAI = !["FREE", "PRO_EXPIRED"].includes(bs);
  const [resume, setResume] = useSessionState("cp_resume_text", "");
  const [jobDesc, setJobDesc] = useSessionState("cp_resume_jobdesc", profile?.preferred_job_title ? t("resume.lookingForPosition").replace("{title}", profile.preferred_job_title) : "");
  // Deterministic Resume Completeness Check -- zero AI cost, available to every
  // tier (same "free deterministic value stays visible to everyone" pattern
  // Job Search's compatibility breakdown already uses). Answers "what's present
  // or missing," never a quality score -- that distinction matters, see the
  // module's own comment.
  const resumeCompleteness = useMemo(() => computeResumeCompleteness(resume), [resume]);
  const [loading, setLoading] = useState(false);
  const [loadStep, setLoadStep] = useState(0);
  const [results, setResults] = useSessionState("cp_resume_results", null);
  const [error, setError] = useState("");
  const [tab, setTab] = useSessionState("cp_resume_tab", "resume");
  const [extracting, setExtracting] = useState(false);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [savingResume, setSavingResume] = useState(false);
  const [resumeSaved, setResumeSaved] = useState(false);
  const [resumeError, setResumeError] = useState("");
  const [deletingId, setDeletingId] = useState(null);
  // activeResumeId (prop) is the single shared source of truth for "which resume is
  // active" across the whole app (Job Search, Smart Apply, Dashboard, this page) —
  // there is no separate local "loaded resume" concept here anymore.
  const [editLabelId, setEditLabelId] = useState(null);
  const [labelValue, setLabelValue] = useState("");
  // Read job search filters from session so the language suggestion can use the active search country.
  const [searchFilters] = useSessionState("cp_jobs_filters", {});
  // Session-persistent: survive navigation away and back without losing the active session.
  const [resumeSource, setResumeSource] = useSessionState("cp_resume_source", "upload");
  const [selectedKeywords, setSelectedKeywords] = useSessionState("cp_resume_selected_kws", []);
  const [improveStats, setImproveStats] = useSessionState("cp_resume_improve_stats", null);
  const [masterMissingKws, setMasterMissingKws] = useSessionState("cp_resume_master_kws", []);
  const [isOptimized, setIsOptimized] = useSessionState("cp_resume_optimized", false);
  const [resultsInsights, setResultsInsights] = useSessionState("cp_resume_insights", null);
  const [librarySaved, setLibrarySaved] = useSessionState("cp_resume_lib_saved", false);
  // manualReset: set true by New Analysis so auto-load doesn't re-populate the cleared workspace.
  const [manualReset, setManualReset] = useSessionState("cp_resume_manual_reset", false);
  // Transient UI state (fine to reset on navigation)
  const [aiForm, setAiForm] = useState({ employment: "", education: "", skills: "", certifications: "" });
  const [aiBuilding, setAiBuilding] = useState(false);
  const [aiError, setAiError] = useState("");
  const [improving, setImproving] = useState(false);
  const [improveError, setImproveError] = useState("");
  const [improveStep, setImproveStep] = useState("");
  const [animatedAts, setAnimatedAts] = useState(null);
  const [animatedBreakdown, setAnimatedBreakdown] = useState(null);
  const [improvedBtnDone, setImprovedBtnDone] = useState(false);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsSectionExpanded, setInsightsSectionExpanded] = useState({});
  const toggleInsightSection = (key) => setInsightsSectionExpanded(s => ({ ...s, [key]: !s[key] }));
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [savingToLibrary, setSavingToLibrary] = useState(false);
  const [librarySaveError, setLibrarySaveError] = useState("");
  const [openDropdownId, setOpenDropdownId] = useState(null);
  const [editingResumeName, setEditingResumeName] = useState(null);
  const [editorHighlight, setEditorHighlight] = useState(false);
  const [editingPreview, setEditingPreview] = useState(false);
  // Tool 6: Score Benchmarking
  const [benchmarkData, setBenchmarkData] = useSessionState("cp_resume_benchmark", null);
  const [benchmarkLoading, setBenchmarkLoading] = useState(false);
  const [benchmarkError, setBenchmarkError] = useState("");
  // Tool 7: Job Fit Analyzer
  const [jobFitData, setJobFitData] = useSessionState("cp_resume_jobfit", null);
  const [jobFitLoading, setJobFitLoading] = useState(false);
  const [jobFitError, setJobFitError] = useState("");
  // Tool 8: LinkedIn Intelligence (evolved from LinkedIn Optimizer -- Phase 3).
  // linkedinOptData is no longer session-only: it's the most recent persisted
  // analysis for the active resume, read from linkedin_profile_analyses (the
  // single table LinkedIn Intelligence owns). linkedinProfile (the pasted
  // raw-text input) stays sessionStorage -- it's a transient input control,
  // not a generated fact the blueprint's schema persists.
  const linkedinAnalysesHook = useLinkedInProfileAnalyses(profile?.id);
  const linkedinResumeScopedAnalyses = useMemo(
    // Exact match, no "show anything" fallback -- a resume with no persisted
    // analyses yet (or no active resume selected) must show a blank slate,
    // never a stale analysis that actually belongs to a different resume.
    () => linkedinAnalysesHook.analyses.filter(a => a.resumeId === (activeResumeId || null)),
    [linkedinAnalysesHook.analyses, activeResumeId]
  );
  const linkedinOptData = linkedinResumeScopedAnalyses[0] || null;
  const linkedinPreviousData = linkedinResumeScopedAnalyses[1] || null;
  const [linkedinOptLoading, setLinkedinOptLoading] = useState(false);
  const [linkedinOptError, setLinkedinOptError] = useState("");
  const [linkedinProfile, setLinkedinProfile] = useSessionState("cp_resume_linkedin_profile", "");
  const [linkedinEvolution, setLinkedinEvolution] = useState(null);
  const [linkedinEvolutionLoading, setLinkedinEvolutionLoading] = useState(false);
  // Tool 4: Cover Letter Multiple Versions
  const [coverVersions, setCoverVersions] = useSessionState("cp_resume_cover_versions", null);
  const [coverVersionsLoading, setCoverVersionsLoading] = useState(false);
  const [coverVersionsError, setCoverVersionsError] = useState("");
  const [activeCoverVersion, setActiveCoverVersion] = useSessionState("cp_resume_cover_active", "professional");
  // Tool 3: Deep Insights
  const [deepInsights, setDeepInsights] = useSessionState("cp_resume_deep_insights", null);
  const [deepInsightsLoading, setDeepInsightsLoading] = useState(false);
  const [deepInsightsError, setDeepInsightsError] = useState("");
  // Active tool panel — all 7 toolkit tools open panels
  const [activeToolPanel, setActiveToolPanel] = useState(null);
  // Inline helper text shown inside the specific card that was clicked without required data
  const [toolGuidanceMsg, setToolGuidanceMsg] = useState("");
  const [toolGuidancePanelId, setToolGuidancePanelId] = useState("");
  // Coming-soon card notice
  const [comingSoonNotice, setComingSoonNotice] = useState("");
  // Cover letter edit mode
  const [editingCoverLetter, setEditingCoverLetter] = useState(false);
  const [editedCoverText, setEditedCoverText] = useState("");
  // AI Agent philosophy: transient action states
  const [tailoredApplied, setTailoredApplied] = useState(false);
  const [pendingAutoAnalyze, setPendingAutoAnalyze] = useState(false);
  const [applyingAllFixes, setApplyingAllFixes] = useState(false);
  const [insightsDone, setInsightsDone] = useState(false);
  const fileRef = useRef();
  const userContext = useUserContext({ profile, applications, savedJobs });
  // Capture the entry target at mount time so auto-load (which may fire later,
  // after onConsumeEntryTarget has set the prop to null) can still read it.
  const initialEntryRef = useRef(entryTarget);
  const entryScrolledRef = useRef(false);

  // Close the library Actions dropdown when clicking anywhere outside it.
  useEffect(() => {
    if (!openDropdownId) return;
    const handler = () => setOpenDropdownId(null);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [openDropdownId]);

  // Consume navigation intent and set the correct tab on mount.
  useEffect(() => {
    const target = initialEntryRef.current;
    if (!target) return;
    if (target === "insights") setTab("insights");
    else if (target === "keywords") setTab("resume");
    // "upload" needs no special routing — default workspace is correct
    onConsumeEntryTarget?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Once results are available, scroll to the correct section for the entry target.
  // Uses a 350ms delay so it fires after the root page-change force-scroll-to-top (300ms).
  useEffect(() => {
    if (!results || entryScrolledRef.current) return;
    const target = initialEntryRef.current;
    if (!target || target === "upload") return;
    entryScrolledRef.current = true;
    const id = target === "keywords" ? "missing-keywords-section" : "resume-tabs";
    setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" }), 350);
  }, [results]);

  // Auto-load a resume when the workspace is empty. If a resume is already
  // active elsewhere (Job Search, Dashboard, etc. via the shared activeResumeId),
  // load THAT one so this page reflects the same shared state; otherwise fall
  // back to the most recently analyzed resume.
  // Guards: skip if user deliberately cleared (New Analysis), if workspace already has content,
  // or if resumes are still loading.
  useEffect(() => {
    if (manualReset) return;
    if (resumesLoading || resume.trim() || results) return;
    if (!resumes || resumes.length === 0) return;
    const r = (activeResumeId && resumes.find(x => x.id === activeResumeId)) || resumes[0]; // sorted by last_analyzed_at desc
    if (!r?.content) return;
    setResume(r.content);
    onResumeLoad?.(r.id);
    setResumeSource("upload");
    if (r.ats_score != null) {
      setResults({
        atsScore: r.ats_score,
        potentialAtsScore: r.potential_ats_score || Math.min(r.ats_score + 20, 98),
        scoreBreakdown: r.score_breakdown || null,
        keywordsFound: r.keywords_found || [],
        keywordsMissing: r.keywords_missing || [],
        tailoredResume: r.content,
        suggestions: r.suggestions || [],
        coverLetter: "",
        jobTitle: "",
        company: "",
      });
      setMasterMissingKws(r.keywords_missing || []);
      if (!initialEntryRef.current) setTab("resume");
    }
  }, [resumes, resumesLoading, manualReset, activeResumeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tool 2: after AI Builder generates a resume, auto-trigger analysis if a job description is present.
  // Runs after the resume state has been committed to React so analyze() reads the correct value.
  useEffect(() => {
    if (pendingAutoAnalyze && resume.trim() && jobDesc.trim()) {
      setPendingAutoAnalyze(false);
      analyze();
    }
  }, [resume, pendingAutoAnalyze]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tool 3: auto-run Deep Analysis when user opens the Insights tab (once per session until reset).
  useEffect(() => {
    if (canUseAI && tab === "insights" && results && !deepInsights && !deepInsightsLoading && resume.trim()) {
      runDeepInsights();
    }
  }, [tab, results, canUseAI]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tool 4: auto-generate cover letter versions when user opens the Cover tab (once per session until reset).
  // Also fires when coverVersionsLoading transitions to false so a finished background call
  // that produced no versions (e.g. silent error) still gets a recovery attempt.
  useEffect(() => {
    if (canUseAI && tab === "cover" && results && !coverVersions && !coverVersionsLoading && resume.trim()) {
      generateCoverVersions();
    }
  }, [tab, coverVersionsLoading, canUseAI]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-run panels when they open for the first time
  useEffect(() => {
    if (!canUseAI) return;
    if (activeToolPanel === "benchmark" && resume.trim() && !benchmarkData && !benchmarkLoading) {
      runBenchmark();
    }
    if (activeToolPanel === "jobfit" && resume.trim() && jobDesc.trim() && !jobFitData && !jobFitLoading) {
      runJobFit();
    }
  }, [activeToolPanel, canUseAI]); // eslint-disable-line react-hooks/exhaustive-deps

  // LinkedIn Intelligence auto-fire is a separate effect (not the shared one
  // above) because linkedinOptData now comes from an async Supabase fetch
  // (useLinkedInProfileAnalyses), not sessionStorage -- firing before that
  // fetch resolves would generate a duplicate analysis for a resume that
  // already has one. Waits for linkedinAnalysesHook.loading to clear, and
  // re-evaluates when it does (the shared effect above only re-runs on
  // activeToolPanel change, which would miss this).
  useEffect(() => {
    if (canUseAI && activeToolPanel === "linkedin-opt" && resume.trim() && !linkedinAnalysesHook.loading && !linkedinOptData && !linkedinOptLoading) {
      runLinkedinOpt();
    }
  }, [activeToolPanel, linkedinAnalysesHook.loading, linkedinOptData, canUseAI]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear toolkit helper text once the user provides the required data
  useEffect(() => { if (toolGuidanceMsg && resume.trim()) { setToolGuidanceMsg(""); setToolGuidancePanelId(""); } }, [resume]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (toolGuidanceMsg && resume.trim() && jobDesc.trim()) { setToolGuidanceMsg(""); setToolGuidancePanelId(""); } }, [jobDesc]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploadedFile(file);
    const ext = file.name.split('.').pop().toLowerCase();
    setExtracting(true);

    if (['png','jpg','jpeg'].includes(ext)) {
      // Image: convert to base64 and send to Claude for OCR
      if (!canUseAI) { setError(t("resume.imageUploadLocked")); setExtracting(false); return; }
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const base64 = ev.target.result.split(',')[1];
          const mediaType = file.type || 'image/jpeg';
          const { data: { session: imgSession } } = await supabase.auth.getSession();
          const imgToken = imgSession?.access_token;
          const imgHeaders = { "Content-Type": "application/json" };
          if (imgToken) imgHeaders["Authorization"] = `Bearer ${imgToken}`;
          const res = await fetch(WORKER_URL, {
            method: "POST",
            headers: imgHeaders,
            body: JSON.stringify({
              feature: "resume_analysis",
              model: "claude-sonnet-4-6",
              max_tokens: 2000,
              messages: [{
                role: "user",
                content: [
                  { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
                  { type: "text", text: "Extract all text from this resume image exactly as it appears. Return only the extracted text, preserving the layout as much as possible." }
                ]
              }]
            }),
          });
          const data = await res.json();
          const text = data.content?.[0]?.text || '';
          if (text) setResume(text);
          else setError(t("resume.imageExtractFailed"));
        } catch { setError(t("resume.imageExtractFailedPaste")); }
        finally { setExtracting(false); }
      };
      reader.readAsDataURL(file);
    } else if (['pdf'].includes(ext)) {
      // PDF: extract text in-browser using PDF.js
      setError(""); setLoading(false);
      try {
        if (!window.pdfjsLib) {
          await new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
            s.onload = resolve; s.onerror = reject;
            document.head.appendChild(s);
          });
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        }
        const buf = await file.arrayBuffer();
        const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
        let text = "";
        for (let i = 1; i <= pdf.numPages; i++) {
          const pageObj = await pdf.getPage(i);
          const content = await pageObj.getTextContent();
          // Group items by Y-coordinate to reconstruct visual lines.
          // join(" ") would collapse all lines into one giant paragraph.
          const pageLines = [];
          let curLine = '';
          let curY = null;
          for (const item of content.items) {
            if (!item.str) continue;
            const y = item.transform[5]; // baseline Y in PDF coords
            if (curY === null || Math.abs(y - curY) <= 4) {
              // Same line (4pt tolerance handles mixed font sizes)
              curLine += (curLine && !curLine.endsWith(' ') && !item.str.startsWith(' ') ? ' ' : '') + item.str;
              curY = y;
            } else {
              if (curLine.trim()) pageLines.push(curLine.trim());
              curLine = item.str;
              curY = y;
            }
          }
          if (curLine.trim()) pageLines.push(curLine.trim());
          text += pageLines.join('\n') + '\n';
        }
        if (text.trim()) {
          setResume(text.trim());
        } else {
          setError(t("resume.pdfExtractFailed"));
        }
      } catch {
        setError(t("resume.pdfReadFailed"));
      } finally { setExtracting(false); }
    } else if (['doc','docx'].includes(ext)) {
      // DOCX: try to read as text (works for simple .docx)
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target.result;
        // Check if readable text was extracted
        const readableChars = (text.match(/[a-zA-Z\s.,!?]/g) || []).length;
        if (readableChars > 50) {
          setResume(text);
        } else {
          setError(t("resume.docxReadFailed"));
        }
        setExtracting(false);
      };
      reader.readAsText(file);
    } else {
      // TXT and other text files
      const reader = new FileReader();
      reader.onload = (ev) => { setResume(ev.target.result); setExtracting(false); };
      reader.readAsText(file);
    }
  };

  const resumeHealthFrom = (score) => {
    if (score == null) return null;
    if (score >= 90) return 'Excellent';
    if (score >= 80) return 'Very Good';
    if (score >= 70) return 'Good';
    if (score >= 60) return 'Needs Improvement';
    return 'Poor';
  };

  const validCompany = (name) => {
    if (!name) return null;
    const lower = name.toLowerCase().trim();
    return ['not specified', 'unknown', 'n/a', 'none', 'unspecified', 'not available', 'not stated', 'na'].includes(lower) ? null : name;
  };

  // explicitResumeId: pass the freshly-saved resumeId from handleSaveToLibrary because
  // onResumeLoad(id) is async — the closure still sees the old value.
  const saveHistoryEntry = (parsed, analysisType = 'Initial Analysis', resumeStatus = 'Draft', explicitResumeId = null) => {
    const effectiveResumeId = explicitResumeId ?? activeResumeId;
    const resumeName = uploadedFile?.name || (effectiveResumeId ? (resumes.find(r => r.id === effectiveResumeId)?.name || 'Resume') : 'Resume');
    const entry = {
      resumeName,
      atsScore: parsed.atsScore,
      potentialAtsScore: parsed.potentialAtsScore,
      jobTitle: parsed.jobTitle || '',
      company: validCompany(parsed.company) || '',
      analysisType,
      analysisMode: resumeSource === 'ai' ? 'AI Resume Creator' : 'Uploaded Resume',
      resumeStatus,
      resumeHealth: resumeHealthFrom(parsed.atsScore),
    };
    if (saveHistoryToDb && profile?.id) {
      saveHistoryToDb(entry, effectiveResumeId || null).catch(e => {
        // Supabase failed — write directly to localStorage cache so data is not lost.
        console.warn('[ResumeHistory] DB write failed, caching locally:', e.message);
        try {
          const key = `cp_resume_history_${profile.id}`;
          const existing = JSON.parse(localStorage.getItem(key) || '[]');
          localStorage.setItem(key, JSON.stringify([{ ...entry, id: Date.now().toString(), date: new Date().toISOString() }, ...existing].slice(0, 50)));
        } catch {}
      });
    } else {
      // Not authenticated or hook unavailable — localStorage only.
      try {
        const key = `cp_resume_history_${profile?.id || 'guest'}`;
        const existing = JSON.parse(localStorage.getItem(key) || '[]');
        localStorage.setItem(key, JSON.stringify([{ ...entry, id: Date.now().toString(), date: new Date().toISOString() }, ...existing].slice(0, 50)));
      } catch (e) {
        console.warn('[ResumeHistory]', e.message);
      }
    }
  };

  const analyze = async () => {
    if (!canUseAI) return;
    if (!resume.trim() || !jobDesc.trim()) { setError(t("resume.bothRequired")); return; }
    setManualReset(false);
    setError(""); setLoading(true); setResults(null); setLoadStep(0);
    const iv = setInterval(() => setLoadStep(s => Math.min(s + 1, 4)), 1800);
    try {
      const ctx = userContext.getContextString({ identity: true });
      const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}You are an expert ATS resume coach. Analyze the resume against the job description and return ONLY a JSON object, no markdown, no explanation:
{"atsScore":<0-100>,"potentialAtsScore":<estimated score after improvements 0-100>,"scoreBreakdown":{"keywordMatch":<0-100>,"formatting":<0-100>,"relevance":<0-100>},"keywordsFound":["<k1>","<k2>","<k3>","<k4>","<k5>","<k6>"],"keywordsMissing":["<m1>","<m2>","<m3>","<m4>","<m5>","<m6>"],"tailoredResume":"<full optimized resume maintaining original structure>","suggestions":["<specific tip 1>","<specific tip 2>","<specific tip 3>","<specific tip 4>","<specific tip 5>"],"coverLetter":"<professional 3 paragraph cover letter>","jobTitle":"<extracted job title>","company":"<company name>"}
RESUME:${resume}
JOB DESCRIPTION:${jobDesc}`, 4000, "resume_analysis");
      const parsed = JSON.parse(raw);
      setResults(parsed); setTab("resume");
      insertNotification(profile?.id, { type: "resume", title: "Resume analysis complete.", body: "Your resume has been analyzed. View your ATS score and improvement tips." });
      // Animate score bars from 0 to final (PBar has CSS transition: width 1s ease)
      setAnimatedBreakdown({ keywordMatch: 0, formatting: 0, relevance: 0 });
      requestAnimationFrame(() => requestAnimationFrame(() => {
        setAnimatedBreakdown(parsed.scoreBreakdown);
        setTimeout(() => setAnimatedBreakdown(null), 1100);
      }));
      setMasterMissingKws(parsed.keywordsMissing || []);
      setIsOptimized(false);
      setSelectedKeywords(parsed.keywordsMissing || []); // AI pre-selects all missing keywords
      setTailoredApplied(false);
      setResultsInsights(null);
      setLibrarySaved(false); setLibrarySaveError("");
      setInsightsLoading(true);
      const capturedResume = resume;
      const capturedJobDesc = jobDesc;
      askClaude(`You are a senior career coach. Analyze this resume against the job description and return ONLY a JSON object, no markdown, no explanation:
{"strengths":["<specific strength 1 that makes this candidate competitive for this role>","<specific strength 2>","<specific strength 3>"],"highPriorityImprovements":["<the single most important improvement that would increase resume quality and recruiter appeal>","<second most important improvement>","<third most important improvement>"],"missingSkills":["<broader skill or qualification this role requires that the resume does not demonstrate — do NOT duplicate ATS keyword suggestions>","<missing skill 2>","<missing skill 3>","<missing skill 4>","<missing skill 5>"],"tailoringOpportunities":["<specific intelligent recommendation to better tailor this resume for this role beyond keyword optimization>","<tailoring tip 2>","<tailoring tip 3>"]}
RESUME:${capturedResume}
JOB DESCRIPTION:${capturedJobDesc}`, 900, "resume_analysis_followup").then(insightRaw => {
        try { setResultsInsights(JSON.parse(insightRaw)); } catch {}
      }).catch(e => console.warn("[Insights]", e)).finally(() => setInsightsLoading(false));
    } catch (e) { console.error("[ResumeTailor]", e); setError(t("resume.analysisFailed")); }
    finally { clearInterval(iv); setLoading(false); }
  };

  const handleSaveResume = async () => {
    if (!resume.trim()) return;
    setResumeError(""); setSavingResume(true);
    try {
      const savedRow = await saveResume(uploadedFile?.name || t("resume.myResumeFallback"), resume, null);
      if (savedRow?.id) {
        onResumeLoad?.(savedRow.id);
        if (results && saveAnalysis) {
          await saveAnalysis(savedRow.id, results).catch(e => console.warn("[Resume] saveAnalysis on new resume failed:", e?.message));
        }
      }
      setResumeSaved(true);
      setTimeout(() => setResumeSaved(false), 3000);
    } catch (e) {
      console.error("handleSaveResume failed:", e?.code, e?.message, e);
      const isSessionError = e?.message?.includes("Session expired") || e?.message?.includes("Not signed in");
      setResumeError(isSessionError ? e.message : t("resume.saveResumeFailed"));
    } finally {
      setSavingResume(false);
    }
  };

  // Unified explicit save: saves resume to library, updates Resume Intelligence,
  // and records the history entry — all in one action, triggered by the user.
  const handleSaveToLibrary = async (forceNew = false) => {
    if (!results || !resume.trim() || !profile?.id) return;
    setSavingToLibrary(true); setLibrarySaveError("");
    try {
      let resumeId = activeResumeId;
      // When saving an improved (optimized) resume and there's already a loaded resume,
      // always create a new library entry so the original is never silently overwritten.
      const shouldSaveAsNew = isOptimized && activeResumeId && saveResume;
      if (!resumeId || forceNew || shouldSaveAsNew) {
        const originalName = resumes.find(r => r.id === activeResumeId)?.name || uploadedFile?.name;
        const name = shouldSaveAsNew
          ? `Optimized${results.jobTitle ? ` — ${results.jobTitle}` : ""}${originalName ? ` (${originalName.replace(/\.[^.]+$/, "")})` : ""}`
          : uploadedFile?.name || (results.jobTitle ? `Resume — ${results.jobTitle}` : t("resume.myResumeFallback"));
        const detection = detectResumeLanguage(resume);
        const langMeta = detection.lang ? { language: detection.lang, detected_language: detection.lang, language_confidence: detection.confidence } : undefined;
        const savedRow = await saveResume(name, resume, null, langMeta);
        if (savedRow?.id) { resumeId = savedRow.id; onResumeLoad?.(savedRow.id); }
      }
      if (resumeId && saveAnalysis) {
        await saveAnalysis(resumeId, results, isOptimized ? resume : null);
      }
      saveHistoryEntry(results, isOptimized ? 'Resume Improvement' : 'Initial Analysis', isOptimized ? 'Optimized' : 'Draft', resumeId || null);
      setLibrarySaved(true);
    } catch (e) {
      console.error("[SaveToLibrary]", e);
      setLibrarySaveError(t("resume.librarySaveError"));
    } finally {
      setSavingToLibrary(false);
    }
  };

  const handleLoadResume = (r) => {
    setResume(r.content || ""); setUploadedFile(null); onResumeLoad?.(r.id);
    // Backfill detection for existing resumes that were saved before this feature existed
    if (r.content && !r.detected_language && updateResumeLanguage) {
      const { lang, confidence } = detectResumeLanguage(r.content);
      if (lang && confidence >= 0.72) {
        updateResumeLanguage(r.id, r.language || lang, lang, confidence).catch(() => {});
      }
    }
  };

  const handleGenerateResume = async () => {
    if (!canUseAI) return;
    if (!profile?.id) return;
    setAiBuilding(true); setAiError("");
    try {
      const identity = [
        profile?.full_name ? `Name: ${profile.full_name}` : "",
        profile?.email_address ? `Email: ${profile.email_address}` : "",
        profile?.phone ? `Phone: ${profile.phone}` : "",
        profile?.location ? `Location: ${profile.location}` : "",
        profile?.job_title ? `Current Role: ${profile.job_title}` : "",
        profile?.preferred_job_title ? `Target Role: ${profile.preferred_job_title}` : "",
        profile?.years_experience ? `Years of Experience: ${profile.years_experience}` : "",
        profile?.work_type ? `Work Type: ${profile.work_type}` : "",
      ].filter(Boolean).join("\n");

      // Resume Language for this new document: use the loaded resume's language if one is
      // loaded, otherwise fall back to job language (what the user is targeting), otherwise "en".
      const loadedResumeLang = resumes.find(r => r.id === activeResumeId)?.language;
      const docLang = loadedResumeLang || jobLanguage || "en";

      const basePrompt = `You are an expert resume writer. Create a professional, ATS-optimized resume in plain text format.

PROFILE:
${identity}

EMPLOYMENT HISTORY:
${aiForm.employment}

EDUCATION:
${aiForm.education}

SKILLS: ${aiForm.skills}${aiForm.certifications ? `\n\nCERTIFICATIONS: ${aiForm.certifications}` : ""}

INSTRUCTIONS:
Write a complete, polished ATS-friendly resume in plain text. Include: Contact Information, Professional Summary, Work Experience (with bullet points and quantified achievements where possible), Skills, Education${aiForm.certifications ? ", Certifications" : ""}. Use UPPERCASE for section headers. Use action verbs. Return ONLY the resume text — no explanation, no markdown, no preamble.`;

      const generated = await askClaude(withDualLanguage(basePrompt, language, docLang), 3000, "resume_analysis");
      setResume(generated.trim());
      if (jobDesc.trim()) {
        setPendingAutoAnalyze(true);
      }
    } catch (e) {
      console.error("[AIBuilder]", e);
      setAiError(t("resume.aiError"));
    } finally {
      setAiBuilding(false);
    }
  };

  // ── Tool 6: Score Benchmarking ──────────────────────────────────────────────
  const runBenchmark = async () => {
    if (!canUseAI) return;
    if (!resume.trim()) return;
    setBenchmarkLoading(true); setBenchmarkError(""); setBenchmarkData(null);
    try {
      const ctx = userContext.getContextString({ identity: true, applications: true });
      const currentScore = results?.atsScore ?? null;
      // Evidence-based by design: this app has no real industry-average, candidate-percentile,
      // or market-comparison dataset anywhere -- there is nothing to compare this resume
      // against. The prompt therefore asks only for an assessment of THIS resume's own
      // content (quality/completeness of what's actually written), never a claim about
      // other candidates or the market. Do not reintroduce industryAverage/topCandidateAverage/
      // percentile/percentileLabel-style fields -- there is no data source to back them.
      const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}You are an expert ATS and resume quality analyst. Assess ONLY the resume text provided below. Do not invent, estimate, or imply any statistic about other candidates, industry averages, percentiles, or market data -- none of that data is available to you, so any such number would be fabricated. Return ONLY a JSON object, no markdown, no explanation:
{"atsScore":${currentScore !== null ? currentScore : "<calculate 0-100>"},"keywordCoverage":<0-100, how well this resume's own content covers relevant keywords for its apparent target role>,"formattingScore":<0-100, formatting quality of this resume's content>,"experienceScore":<0-100, strength and specificity of the experience section content>,"skillsScore":<0-100, strength and relevance of the skills section content>,"educationScore":<0-100, completeness of the education section>,"overallRanking":"<Below Average/Average/Above Average/Strong/Excellent -- a self-contained quality assessment of THIS resume's own content, not a comparison to other candidates or a market position>","recommendations":["<specific improvement 1>","<specific improvement 2>","<specific improvement 3>"]}
RESUME:${resume}${jobDesc.trim() ? "\nJOB DESCRIPTION:" + jobDesc : ""}`, 2000, "resume_analysis");
      const parsed = JSON.parse(raw);
      setBenchmarkData(parsed);
      if (profile?.id && saveHistoryToDb) {
        const entry = { resumeName: uploadedFile?.name || resumes.find(r => r.id === activeResumeId)?.name || 'Resume', atsScore: parsed.atsScore ?? results?.atsScore ?? null, potentialAtsScore: results?.potentialAtsScore ?? null, jobTitle: results?.jobTitle || '', company: validCompany(results?.company) || '', analysisType: 'Score Benchmarking', analysisMode: resumeSource === 'ai' ? 'AI Resume Creator' : 'Uploaded Resume', resumeStatus: 'Benchmarked', resumeHealth: resumeHealthFrom(parsed.atsScore ?? results?.atsScore) };
        saveHistoryToDb(entry, activeResumeId || null).catch(() => {});
      }
    } catch (e) { console.error("[Benchmark]", e); setBenchmarkError(t("resume.benchmarkError")); }
    finally { setBenchmarkLoading(false); }
  };

  // ── Tool 7: Job Fit Analyzer ─────────────────────────────────────────────────
  const runJobFit = async () => {
    if (!canUseAI) return;
    if (!resume.trim() || !jobDesc.trim()) return;
    setJobFitLoading(true); setJobFitError(""); setJobFitData(null);
    try {
      const ctx = userContext.getContextString({ identity: true });
      const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}You are an expert recruiter and career coach. Analyze how well this resume matches the job description. Return ONLY a JSON object, no markdown, no explanation:
{"overallMatch":<0-100>,"matchLabel":"<Strong Match/Good Match/Moderate Match/Weak Match>","requiredSkillsMatch":[{"skill":"<skill>","found":<true or false>,"evidence":"<brief quote from resume or null>"}],"preferredSkillsMatch":[{"skill":"<skill>","found":<true or false>}],"missingSkills":["<skill>","<skill>","<skill>"],"keywordMatchScore":<0-100>,"experienceMatch":{"score":<0-100>,"status":"<Over-qualified/Well-matched/Under-qualified>","detail":"<one sentence>"},"educationMatch":{"score":<0-100>,"status":"<Exceeds/Meets/Below requirement>","detail":"<one sentence>"},"seniorityMatch":{"score":<0-100>,"status":"<Well-matched/Junior for role/Senior for role>","detail":"<one sentence>"},"applicationReadiness":"<Ready to Apply/Almost Ready/Needs Work>","topRecommendations":["<action 1>","<action 2>","<action 3>"],"coverLetterTip":"<one specific cover letter tip for this role>"}
RESUME:${resume}
JOB DESCRIPTION:${jobDesc}`, 2500, "resume_analysis");
      const parsed = JSON.parse(raw);
      setJobFitData(parsed);
      if (profile?.id && saveHistoryToDb) {
        const entry = { resumeName: uploadedFile?.name || resumes.find(r => r.id === activeResumeId)?.name || 'Resume', atsScore: results?.atsScore ?? null, potentialAtsScore: results?.potentialAtsScore ?? null, jobTitle: results?.jobTitle || '', company: validCompany(results?.company) || '', analysisType: 'Job Fit Analysis', analysisMode: resumeSource === 'ai' ? 'AI Resume Creator' : 'Uploaded Resume', resumeStatus: 'Analyzed', resumeHealth: resumeHealthFrom(results?.atsScore) };
        saveHistoryToDb(entry, activeResumeId || null).catch(() => {});
      }
    } catch (e) { console.error("[JobFit]", e); setJobFitError(t("resume.jobFitError")); }
    finally { setJobFitLoading(false); }
  };

  // ── Tool 8: LinkedIn Intelligence ────────────────────────────────────────────
  // Deterministic scoring (zero AI cost) + content generation (Pro and above,
  // corrected 2026-08-08 -- was previously commented "Free, all tiers") +
  // interpretive analysis (Premium, when available) computed and persisted in
  // one orchestrated call -- see runLinkedinIntelligenceAnalysis in
  // src/data/linkedinIntelligence.js. Gated the same way as every other Resume
  // AI action on this page: guarded by canUseAI below, before any AI call.
  // Ownership boundary: this component never computes a score or writes a
  // deterministic/generated-content field itself -- it only supplies inputs and
  // renders the persisted result.
  const runLinkedinOpt = async () => {
    if (!canUseAI) return;
    if (!resume.trim()) return;
    setLinkedinOptLoading(true); setLinkedinOptError("");
    try {
      const ctx = userContext.getContextString({ identity: true });
      const saved = await runLinkedinIntelligenceAnalysis({
        resumeText: resume,
        linkedinProfileText: linkedinProfile,
        jobDesc,
        targetRole: profile?.job_title || "",
        resumeId: activeResumeId || null,
        isPremium,
        saveAnalysis: linkedinAnalysesHook.saveAnalysis,
        userContext: ctx,
      });
      if (!saved) throw new Error("linkedin_intelligence_no_content");
      if (profile?.id && saveHistoryToDb) {
        const entry = { resumeName: uploadedFile?.name || resumes.find(r => r.id === activeResumeId)?.name || 'Resume', atsScore: results?.atsScore ?? null, potentialAtsScore: null, jobTitle: results?.jobTitle || '', company: '', analysisType: 'LinkedIn Optimization', analysisMode: resumeSource === 'ai' ? 'AI Resume Creator' : 'Uploaded Resume', resumeStatus: 'LinkedIn Optimized', resumeHealth: resumeHealthFrom(results?.atsScore) };
        saveHistoryToDb(entry, activeResumeId || null).catch(() => {});
      }
    } catch (e) { console.error("[LinkedInOpt]", e); setLinkedinOptError(t("resume.linkedinOptError")); }
    finally { setLinkedinOptLoading(false); }
  };

  // Profile Evolution Tracking (Premium) -- on-demand, separate trigger, never
  // persisted (see runProfileEvolutionAnalysis's own comment for why).
  const runLinkedinEvolution = async () => {
    if (!isPremium || !linkedinOptData || !linkedinPreviousData) return;
    setLinkedinEvolutionLoading(true);
    try {
      const result = await runProfileEvolutionAnalysis({ latest: linkedinOptData, previous: linkedinPreviousData, targetRole: profile?.job_title || "" });
      setLinkedinEvolution(result);
    } catch (e) { console.error("[LinkedInEvolution]", e); }
    finally { setLinkedinEvolutionLoading(false); }
  };

  // ── Tool 4: Cover Letter Multiple Versions ───────────────────────────────────
  // resumeOverride: explicit text for background regeneration after resume edits.
  // Background calls suppress UI errors so nothing appears on the Cover tab unexpectedly.
  const generateCoverVersions = async (resumeOverride = null) => {
    if (!canUseAI) return;
    const resumeContent = resumeOverride ?? resume;
    const isBackground = resumeOverride !== null;
    if (!resumeContent.trim()) return;
    setCoverVersionsLoading(true);
    if (!isBackground) setCoverVersionsError("");
    try {
      const ctx = userContext.getContextString({ identity: true });
      const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}You are a professional cover letter writer. Generate 4 distinct cover letter versions. Return ONLY a JSON object, no markdown, no explanation:
{"professional":"<formal 3-paragraph professional cover letter>","friendly":"<warm conversational 3-paragraph cover letter, same substance different tone>","executive":"<confident executive-level cover letter emphasizing strategic leadership value>","ats":"<ATS-optimized cover letter that naturally incorporates all job keywords, structured for ATS parsing>"}
RESUME:${resumeContent}
JOB DESCRIPTION:${jobDesc || "General professional role"}
BASE COVER LETTER:${results?.coverLetter || ""}`, 4000, isBackground ? "resume_analysis_followup" : "resume_analysis");
      const parsed = JSON.parse(raw);
      setCoverVersions(parsed);
    } catch (e) { console.error("[CoverVersions]", e); if (!isBackground) setCoverVersionsError(t("resume.coverVersionsError")); }
    finally { setCoverVersionsLoading(false); }
  };

  // ── Tool 3: Deep Resume Insights ─────────────────────────────────────────────
  const runDeepInsights = async () => {
    if (!canUseAI) return;
    if (!resume.trim()) return;
    setDeepInsightsLoading(true); setDeepInsightsError("");
    try {
      const ctx = userContext.getContextString({ identity: true });
      const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}You are an expert resume quality analyst. Perform deep analysis of this resume. Return ONLY a JSON object, no markdown, no explanation:
{"grammarScore":<0-100>,"readabilityScore":<0-100>,"formattingScore":<0-100>,"keywordDensity":<0-100>,"actionVerbScore":<0-100>,"overallQualityScore":<0-100>,"issues":[{"category":"<Grammar/Formatting/Readability/ATS/Action Verbs/Structure>","problem":"<specific problem found>","reason":"<why this hurts resume quality and recruiter appeal — do NOT promise ATS score gains>","fix":"<specific actionable fix>","severity":"<high/medium/low>"}],"weakBullets":[{"original":"<weak bullet from resume>","improved":"<stronger rewritten version>"}],"weakActionVerbs":[{"original":"<weak verb>","stronger":"<powerful action verb>"}],"missingSections":["<missing section name>"],"resumeLengthStatus":"<Optimal/Too Short/Too Long>","contactInfoStatus":"<Complete/Incomplete>","sectionOrderIssue":"<description or null>"}
RESUME:${resume}${jobDesc.trim() ? "\nJOB DESCRIPTION:" + jobDesc : ""}`, 2500, "resume_analysis");
      const parsed = JSON.parse(raw);
      setDeepInsights(parsed);
      if (profile?.id && saveHistoryToDb) {
        const entry = { resumeName: uploadedFile?.name || resumes.find(r => r.id === activeResumeId)?.name || 'Resume', atsScore: results?.atsScore ?? null, potentialAtsScore: results?.potentialAtsScore ?? null, jobTitle: results?.jobTitle || '', company: validCompany(results?.company) || '', analysisType: 'Deep Insights Analysis', analysisMode: resumeSource === 'ai' ? 'AI Resume Creator' : 'Uploaded Resume', resumeStatus: 'Analyzed', resumeHealth: resumeHealthFrom(results?.atsScore) };
        saveHistoryToDb(entry, activeResumeId || null).catch(() => {});
      }
    } catch (e) { console.error("[DeepInsights]", e); setDeepInsightsError(t("resume.deepInsightsError")); }
    finally { setDeepInsightsLoading(false); }
  };

  const applyWeakBulletFix = (original, improved) => {
    setResume(prev => {
      const idx = prev.indexOf(original);
      if (idx === -1) return prev;
      return prev.slice(0, idx) + improved + prev.slice(idx + original.length);
    });
    setDeepInsights(prev => prev ? { ...prev, weakBullets: prev.weakBullets?.filter(b => b.original !== original) } : prev);
  };

  const applyVerbFix = (original, stronger) => {
    setResume(prev => prev.replace(new RegExp(`\\b${original}\\b`, 'gi'), stronger));
    setDeepInsights(prev => prev ? { ...prev, weakActionVerbs: prev.weakActionVerbs?.filter(v => v.original !== original) } : prev);
  };

  const [applyingIssueFix, setApplyingIssueFix] = useState(null);
  const applyIssueFix = async (issue) => {
    if (!canUseAI) return;
    setApplyingIssueFix(issue.problem);
    try {
      const fixed = await askClaude(`You are a professional resume editor. Apply exactly this fix to the resume: "${issue.fix}". Return ONLY the complete improved resume text — no explanation, no preamble, no markdown.\n\nRESUME:\n${resume}`, 3000, "resume_analysis");
      setResume(fixed.trim());
      setDeepInsights(prev => prev ? { ...prev, issues: prev.issues?.filter(i => i.problem !== issue.problem) } : prev);
    } catch (e) { console.error("[IssueFix]", e); }
    finally { setApplyingIssueFix(null); }
  };

  const applyAllDeepFixes = async () => {
    if (!canUseAI) return;
    if (!deepInsights || applyingAllFixes) return;
    setApplyingAllFixes(true);
    try {
      let current = resume;
      // Apply all weak bullet fixes (string replacement, no AI needed)
      if (deepInsights.weakBullets?.length) {
        deepInsights.weakBullets.forEach(({ original, improved }) => {
          const idx = current.indexOf(original);
          if (idx !== -1) current = current.slice(0, idx) + improved + current.slice(idx + original.length);
        });
      }
      // Apply all weak verb fixes (regex replacement, no AI needed)
      if (deepInsights.weakActionVerbs?.length) {
        deepInsights.weakActionVerbs.forEach(({ original, stronger }) => {
          current = current.replace(new RegExp(`\\b${original}\\b`, 'gi'), stronger);
        });
      }
      // Apply all issues in a single Claude call
      if (deepInsights.issues?.length) {
        const fixList = deepInsights.issues.map(i => `- ${i.fix}`).join('\n');
        const fixed = await askClaude(`You are a professional resume editor. Apply ALL of the following improvements to the resume:\n${fixList}\n\nReturn ONLY the complete improved resume text — no explanation, no preamble, no markdown.\n\nRESUME:\n${current}`, 3500, "resume_analysis");
        current = fixed.trim();
      }
      setResume(current);
      setDeepInsights(prev => prev ? { ...prev, weakBullets: [], weakActionVerbs: [], issues: [] } : prev);
      // Background: refresh cover letters with the fully-fixed resume.
      if (coverVersions) generateCoverVersions(current);
    } catch (e) { console.error("[ApplyAllFixes]", e); }
    finally { setApplyingAllFixes(false); }
  };

  const handleImproveResume = async () => {
    if (!canUseAI) return;
    if (!selectedKeywords.length) return;
    setImproving(true); setImproveError(""); setLibrarySaved(false); setLibrarySaveError("");
    const kwList = selectedKeywords.join(", ");
    const oldAts = results?.atsScore ?? null;
    const oldBreakdown = results?.scoreBreakdown ?? null;
    try {
      setImproveStep(t("resume.improveStepStart"));
      const stepTimer = setTimeout(() => setImproveStep(t("resume.improveStepKeywords")), 7000);
      const improvePrompt = `You are a professional resume editor. Improve the resume below by naturally incorporating the specified keywords where they genuinely fit the candidate's background.

KEYWORDS TO INCORPORATE: ${kwList}

RULES:
- Only weave in keywords where they authentically reflect the candidate's existing experience
- Never fabricate skills, roles, companies, or achievements the candidate does not have
- Write naturally — do not keyword-stuff or list keywords in isolation
- Improve grammar, action verbs, and bullet point impact throughout
- Maintain the original structure and section order exactly
- Keep ATS-friendly formatting (plain text, clear sections, no tables or graphics)
- Return ONLY the improved resume text — no explanation, no preamble, no markdown

CURRENT RESUME:
${resume}`;
      const improved = await askClaude(improvePrompt, 3500, "resume_analysis");
      clearTimeout(stepTimer);
      const improvedText = improved.trim();
      const addedCount = selectedKeywords.length;
      const addedKws = [...selectedKeywords]; // save before clearing for post-processing
      setResume(improvedText);
      setSelectedKeywords([]);
      if (jobDesc.trim()) {
        setImproveStep(t("resume.improveStepRecalculating"));
        const ctx = userContext.getContextString({ identity: true });
        const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}You are an expert ATS resume coach. Analyze the resume against the job description and return ONLY a JSON object, no markdown, no explanation.
Note: This resume was just improved by naturally incorporating the following keywords: ${kwList}. Score it accurately and fairly based on the current content — the ATS score should reflect the improvement.
{"atsScore":<0-100>,"potentialAtsScore":<estimated score after improvements 0-100>,"scoreBreakdown":{"keywordMatch":<0-100>,"formatting":<0-100>,"relevance":<0-100>},"keywordsFound":["<k1>","<k2>","<k3>","<k4>","<k5>","<k6>"],"keywordsMissing":["<m1>","<m2>","<m3>","<m4>","<m5>","<m6>"],"tailoredResume":"<full optimized resume maintaining original structure>","suggestions":["<specific tip 1>","<specific tip 2>","<specific tip 3>","<specific tip 4>","<specific tip 5>"],"coverLetter":"<professional 3 paragraph cover letter>","jobTitle":"<extracted job title>","company":"<company name>"}
RESUME:${improvedText}
JOB DESCRIPTION:${jobDesc}`, 4000, "resume_analysis_followup");
        setImproveStep(t("resume.improveStepRefreshing"));
        const parsed = JSON.parse(raw);
        // One improvement cycle → always complete. Move added keywords into Found,
        // clear Missing entirely. User must click New Analysis to start over.
        const mergedFound = [
          ...(parsed.keywordsFound || []),
          ...addedKws.filter(k => !(parsed.keywordsFound || []).some(f => f.toLowerCase() === k.toLowerCase())),
        ];
        const finalParsed = { ...parsed, keywordsFound: mergedFound, keywordsMissing: [] };
        setIsOptimized(true);
        if (oldAts != null) setAnimatedAts(oldAts);
        if (oldBreakdown) setAnimatedBreakdown(oldBreakdown);
        setResults(finalParsed); setTab("resume");
        setTimeout(() => {
          if (oldAts != null) {
            const from = oldAts; const to = finalParsed.atsScore;
            const start = Date.now();
            const tick = () => {
              const t2 = Math.min((Date.now() - start) / 1000, 1);
              const eased = 1 - Math.pow(1 - t2, 3);
              setAnimatedAts(Math.round(from + (to - from) * eased));
              if (t2 < 1) setTimeout(tick, 16); else { setAnimatedAts(to); setTimeout(() => setAnimatedAts(null), 200); }
            };
            tick();
          }
          if (oldBreakdown && finalParsed.scoreBreakdown) {
            setTimeout(() => setAnimatedBreakdown(finalParsed.scoreBreakdown), 100);
            setTimeout(() => setAnimatedBreakdown(null), 2000);
          }
        }, 150);
        setImproveStats({ oldAts, newAts: finalParsed.atsScore, addedCount });
        setImprovedBtnDone(true);
        setTimeout(() => setImprovedBtnDone(false), 3000);
      }
      // Background: regenerate cover letters with the improved resume so all versions stay current.
      // Clear deep insights so they auto-refresh with the new content on next Insights tab visit.
      generateCoverVersions(improvedText);
      if (deepInsights) setDeepInsights(null);
    } catch (e) {
      console.error("[ImproveResume]", e);
      setImproveError("Could not improve resume. Please check your connection and try again.");
    } finally {
      setImproving(false); setImproveStep("");
    }
  };

  const handleDeleteResume = async (r) => {
    setDeletingId(r.id);
    try { await deleteResume(r); } catch { setResumeError(t("resume.deleteResumeFailed")); }
    finally { setDeletingId(null); }
  };

  const handleDownloadResume = async (r) => {
    if (r.file_url) {
      try {
        const url = await downloadResume(r);
        if (url) window.open(url, "_blank");
      } catch { setResumeError(t("resume.downloadLinkFailed")); }
    } else {
      downloadPDF(r.content, r.name.replace(/\.[^.]+$/, ""));
    }
  };

  const handleEditResume = (r) => {
    setResume(r.content || "");
    onResumeLoad?.(r.id);
    setResumeSource("upload");
    setLibrarySaved(true);
    setLibrarySaveError("");
    setIsOptimized(false);
    setImproveStats(null);
    setSelectedKeywords([]);
    setResultsInsights(null);
    setEditingResumeName(r.name);
    if (r.ats_score != null) {
      setResults({
        atsScore: r.ats_score,
        potentialAtsScore: r.potential_ats_score || Math.min(r.ats_score + 20, 98),
        scoreBreakdown: r.score_breakdown || null,
        keywordsFound: r.keywords_found || [],
        keywordsMissing: r.keywords_missing || [],
        tailoredResume: r.content || "",
        suggestions: r.suggestions || [],
        coverLetter: "",
        jobTitle: "",
        company: "",
      });
      setMasterMissingKws(r.keywords_missing || []);
      setTab("resume");
      setTimeout(() => {
        const el = document.getElementById("resume-editor-preview");
        if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        setEditorHighlight(true);
        setTimeout(() => setEditorHighlight(false), 1500);
      }, 200);
    } else {
      setResults(null);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };

  const isFirstTime = resumes.length === 0 && !results;

  const hubHealthColor = (s) => s == null ? C.textMuted : s >= 80 ? C.green : s >= 70 ? C.yellow : s >= 60 ? C.orange : C.red;
  const hubHealthLabel = (s) => s == null ? null : s >= 90 ? t("resume.healthExcellent") : s >= 80 ? t("resume.healthVeryGood") : s >= 70 ? t("resume.healthGood") : s >= 60 ? t("resume.healthNeedsImprovement") : t("resume.healthPoor");

  const newAnalysisReset = () => {
    setResults(null); setResume(""); setJobDesc(""); onResumeLoad?.(null);
    setSelectedKeywords([]); setMasterMissingKws([]);
    setIsOptimized(false); setResultsInsights(null); setInsightsLoading(false);
    setImproveStats(null); setInsightsSectionExpanded({}); setShowAllHistory(false);
    setLibrarySaved(false); setLibrarySaveError("");
    setEditingResumeName(null);
    setBenchmarkData(null); setJobFitData(null);
    setCoverVersions(null); setDeepInsights(null);
    setLinkedinProfile(""); setLinkedinOptError(""); setLinkedinEvolution(null); setActiveCoverVersion("professional");
    setActiveToolPanel(null); setEditingCoverLetter(false); setEditedCoverText("");
    setTailoredApplied(false); setPendingAutoAnalyze(false); setApplyingAllFixes(false); setInsightsDone(false);
    setManualReset(true);
  };

  const workspaceInputsJSX = (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }} className="two-col">
            <Card style={{ display: "flex", flexDirection: "column" }}>
              {/* Always-mounted hidden file input — triggered by the Upload Resume selector */}
              <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg" style={{ display: "none" }} onChange={handleFile} />

              {/* Resume Source Selector */}
              <div className="resume-source-selector" style={{ display: "flex", gap: 8, marginBottom: 14 }}>
                <div onClick={() => { setResumeSource("upload"); fileRef.current?.click(); }} style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 9, cursor: "pointer", border: `1.5px solid ${resumeSource === "upload" ? C.purple : C.border}`, background: resumeSource === "upload" ? C.purpleLight : "transparent" }}>
                  <span style={{ fontSize: 15 }}>📤</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: resumeSource === "upload" ? C.purple : C.textMid }}>{extracting ? t("resume.extracting") : t("resume.uploadResume")}</span>
                </div>
                <div onClick={() => setResumeSource("ai")} style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 9, cursor: "pointer", border: `1.5px solid ${resumeSource === "ai" ? C.purple : C.border}`, background: resumeSource === "ai" ? C.purpleLight : "transparent" }}>
                  <span style={{ fontSize: 15 }}>✨</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: resumeSource === "ai" ? C.purple : C.textMid }}>{t("resume.createWithAi")}</span>
                </div>
              </div>

              {/* Upload mode */}
              {resumeSource === "upload" && (
                <>
                  <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>{t("resume.supportsHint")}</div>
                  <textarea style={{ flex: 1, width: "100%", minHeight: 200, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.8, padding: "14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} placeholder={t("resume.resumePlaceholder")} value={resume} onChange={e => setResume(e.target.value)} />
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>{resume ? t("resume.wordCount").replace("{n}", resume.split(/\s+/).filter(Boolean).length) : t("resume.plainTextHint")}</div>
                  {resumeError && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 10, color: C.red, fontSize: 12, marginTop: 8 }}>{resumeError}</div>}
                </>
              )}

              {/* AI Builder: form (resume not yet generated) */}
              {resumeSource === "ai" && !resume.trim() && !canUseAI && (
                <LockedAICard icon="✨" title={t("resume.lockedBuilderTitle")} description={t("resume.lockedBuilderDesc")} benefits={t("resume.lockedBuilderBenefits")} buttonLabel={t("settings.upgradeToPro")} onUpgrade={() => onNavigate?.("pricing")} />
              )}
              {resumeSource === "ai" && !resume.trim() && canUseAI && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ background: C.purpleLight, border: `1px solid ${C.purple}20`, borderRadius: 9, padding: "10px 14px" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.purple, marginBottom: 6 }}>{t("resume.prefilledFromProfile")}</div>
                    {(profile?.full_name || profile?.email_address || profile?.job_title) ? (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: 11, color: C.textMid }}>
                        {profile?.full_name && <span style={{ whiteSpace: "nowrap" }}>👤 {profile.full_name}</span>}
                        {profile?.email_address && <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>✉️ {profile.email_address}</span>}
                        {profile?.phone && <span style={{ whiteSpace: "nowrap" }}>📞 {profile.phone}</span>}
                        {profile?.location && <span style={{ whiteSpace: "nowrap" }}>📍 {profile.location}</span>}
                        {profile?.job_title && <span style={{ whiteSpace: "nowrap" }}>💼 {profile.job_title}</span>}
                        {profile?.preferred_job_title && <span style={{ whiteSpace: "nowrap" }}>🎯 {profile.preferred_job_title}</span>}
                        {profile?.years_experience && <span style={{ whiteSpace: "nowrap" }}>⏱️ {profile.years_experience}{t("resume.yrsExp")}</span>}
                        {profile?.work_type && <span style={{ whiteSpace: "nowrap" }}>🏢 {profile.work_type}</span>}
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: "#CA8A04" }}>⚠️ {t("resume.completeProfilePrompt")} <span style={{ cursor: "pointer", textDecoration: "underline", color: C.purple }} onClick={() => onNavigate?.("profile")}>{t("resume.goToProfile")}</span></div>
                    )}
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: C.textMid, marginBottom: 4 }}>{t("resume.employmentHistory")} <span style={{ color: C.red }}>*</span></div>
                    <textarea value={aiForm.employment} onChange={e => setAiForm(f => ({ ...f, employment: e.target.value }))} placeholder={t("resume.employmentPlaceholder")} style={{ width: "100%", minHeight: 90, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 13, lineHeight: 1.7, padding: "10px 12px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: C.textMid, marginBottom: 4 }}>{t("resume.education")} <span style={{ color: C.red }}>*</span></div>
                    <textarea value={aiForm.education} onChange={e => setAiForm(f => ({ ...f, education: e.target.value }))} placeholder={t("resume.educationPlaceholder")} style={{ width: "100%", minHeight: 55, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 13, lineHeight: 1.7, padding: "10px 12px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: C.textMid, marginBottom: 4 }}>{t("resume.skills")} <span style={{ color: C.red }}>*</span></div>
                    <input value={aiForm.skills} onChange={e => setAiForm(f => ({ ...f, skills: e.target.value }))} placeholder={t("resume.skillsPlaceholder")} style={{ width: "100%", background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 13, padding: "8px 12px", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: C.textMid, marginBottom: 4 }}>{t("resume.certifications")} <span style={{ fontSize: 10, fontWeight: 400, color: C.textMuted }}>({t("resume.optional")})</span></div>
                    <input value={aiForm.certifications} onChange={e => setAiForm(f => ({ ...f, certifications: e.target.value }))} placeholder={t("resume.certificationPlaceholder")} style={{ width: "100%", background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 13, padding: "8px 12px", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
                  </div>
                  {aiError && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: "8px 12px", color: C.red, fontSize: 12 }}>{aiError}</div>}
                  <Btn onClick={handleGenerateResume} loading={aiBuilding} disabled={!aiForm.employment.trim() || !aiForm.education.trim() || !aiForm.skills.trim()} style={{ width: "100%", padding: "11px", fontSize: 14 }}>
                    {aiBuilding ? t("resume.generatingResume") : t("resume.generateWithAi")}
                  </Btn>
                  {jobDesc.trim() && !aiBuilding && (
                    <div style={{ fontSize: 11, color: C.purple, fontWeight: 600, textAlign: "center" }}>{t("resume.willAutoAnalyze")}</div>
                  )}
                </div>
              )}

              {/* AI Builder: generated resume (editable textarea) */}
              {resumeSource === "ai" && resume.trim() && (
                <>
                  <div style={{ fontSize: 11, color: C.green, fontWeight: 600, marginBottom: 8 }}>{t("resume.resumeGenerated")}</div>
                  <textarea style={{ flex: 1, width: "100%", minHeight: 200, background: "#fff", border: `1.5px solid ${C.green}40`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.8, padding: "14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} value={resume} onChange={e => setResume(e.target.value)} />
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                    <div style={{ fontSize: 11, color: C.textMuted }}>{t("resume.wordCount").replace("{n}", resume.split(/\s+/).filter(Boolean).length)}</div>
                    <Btn variant="ghost" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => { setResume(""); setAiForm({ employment: "", education: "", skills: "", certifications: "" }); }}>{t("resume.rebuild")}</Btn>
                  </div>
                </>
              )}
            </Card>
            <Card style={{ display: "flex", flexDirection: "column" }}>
              {/* Header area: same padding + border as selector buttons → identical rendered height across platforms */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", border: "1.5px solid transparent", borderRadius: 9, marginBottom: 14 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: C.textMid }}>{t("resume.jobDescription")}</span>
              </div>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>{t("resume.jobDescHint")}</div>
              <textarea style={{ flex: 1, width: "100%", minHeight: 200, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.8, padding: "14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} placeholder={t("resume.jobDescPlaceholder")} value={jobDesc} onChange={e => setJobDesc(e.target.value)} />
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>{jobDesc ? t("resume.wordCount").replace("{n}", jobDesc.split(/\s+/).filter(Boolean).length) : t("resume.jobDescTip")}</div>
            </Card>
          </div>

          {/* Resume Completeness Check — deterministic, zero AI, all tiers.
              "What's present or missing" -- never a quality score. */}
          {resumeCompleteness && (
            <Card style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{t("resume.completenessTitle")}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.purple }}>{t("resume.completenessSummary").replace("{n}", resumeCompleteness.passedCount).replace("{total}", resumeCompleteness.totalCount)}</div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 8 }}>
                {[
                  ["contact", t("resume.completenessContact")],
                  ["summary", t("resume.completenessSummaryItem")],
                  ["experience", t("resume.completenessExperience")],
                  ["education", t("resume.completenessEducation")],
                  ["skills", t("resume.completenessSkills")],
                  ["lengthOk", t("resume.completenessLength")],
                ].map(([key, label]) => {
                  const present = resumeCompleteness.checks[key];
                  return (
                    <div key={key} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: present ? C.text : C.textMuted }}>
                      <span style={{ color: present ? C.green : C.textMuted, fontWeight: 800, flexShrink: 0 }}>{present ? "✓" : "—"}</span>
                      {label}
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {error && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 14, color: C.red, fontSize: 13, marginBottom: 16 }}>{error}</div>}
          <div className="resume-action-bar" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, maxWidth: 600, margin: "0 auto", width: "100%" }}>
            <Btn variant="secondary" loading={savingResume} disabled={!resume.trim() || !profile?.id} onClick={handleSaveResume} style={{ width: "100%", padding: "12px 16px", fontSize: 14 }}>{resumeSaved ? t("resume.savedShort") : savingResume ? t("resume.saving") : t("resume.saveResume")}</Btn>
            <Btn onClick={() => { if (!canUseAI) { document.getElementById("resume-locked-analysis")?.scrollIntoView({ behavior: "smooth", block: "start" }); return; } analyze(); }} loading={loading} style={{ width: "100%", padding: "12px 16px", fontSize: 14 }}>{loading ? t("resume.analyzing") : canUseAI ? t("resume.analyzeAndTailor") : t("resume.analyzeAndTailorLocked")}</Btn>
            <Btn variant="secondary" disabled={loading} onClick={() => { setResume(SAMPLE_RESUME); setJobDesc(SAMPLE_JOB); }} style={{ width: "100%", padding: "12px 16px", fontSize: 14 }}>{t("resume.trySample")}</Btn>
          </div>

          {/* First Pro upgrade moment -- featured, shown once there's a resume to analyze */}
          {!canUseAI && resume.trim() && (
            <div id="resume-locked-analysis" style={{ marginTop: 14 }}>
              <LockedAICard featured icon="🔒" title={t("resume.lockedAnalysisTitle")} description={t("resume.lockedAnalysisDesc")} benefits={t("resume.lockedAnalysisBenefits")} buttonLabel={t("settings.upgradeToPro")} onUpgrade={() => onNavigate?.("pricing")} />
            </div>
          )}
        </>
  );

  return (
    <div>
      {/* FIRST-TIME USER: no saved resumes and no current analysis — show workspace only */}
      {isFirstTime && (
        <>
          <div style={{ marginBottom: 28 }}>
            <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 8 }}>{t("resume.heading")}</h1>
            <p style={{ fontSize: 15, color: C.textMuted }}>{t("resume.subtitle")}</p>
          </div>
          {workspaceInputsJSX}
          {loading && <Spinner steps={[t("resume.resumeStep1"),t("resume.resumeStep2"),t("resume.resumeStep3"),t("resume.resumeStep4"),t("resume.resumeStep5")]} currentStep={loadStep} />}
        </>
      )}

      {/* RESUME HUB: returning user or active analysis */}
      {!isFirstTime && (
        <div>
          {!results && (
            <div style={{ marginBottom: 14 }}>
              <h1 style={{ fontSize: 24, fontWeight: 800, color: C.text, marginBottom: 4 }}>{t("resume.hubHeading")}</h1>
              <p style={{ fontSize: 14, color: C.textMuted }}>{t("resume.hubSubtitle")}</p>
            </div>
          )}

          {/* SECTION 1 — Resume Library: always visible when resumes exist */}
          {resumes.length > 0 && (
            <Card style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 12 }}>{t("resume.libraryTitle")}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {resumes.slice(0, 6).map(r => {
                  const hl = hubHealthLabel(r.ats_score);
                  const hc = hubHealthColor(r.ats_score);
                  const isLoaded = activeResumeId === r.id;
                  const isEditing = editingResumeName === r.name && isLoaded;
                  return (
                    <div key={r.id} className="resume-lib-item" style={{ padding: "10px 14px", background: C.bgSoft, border: `1.5px solid ${C.border}`, borderLeft: isLoaded ? `3px solid ${C.purple}` : `3px solid transparent`, borderRadius: 10, WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        {/* Circular selection toggle */}
                        <button
                          onClick={() => {
                            if (isLoaded) {
                              setResume(""); onResumeLoad?.(null); setResults(null);
                              setResumeSource("upload"); setLibrarySaved(false); setLibrarySaveError("");
                              setIsOptimized(false); setImproveStats(null); setSelectedKeywords([]); setResultsInsights(null);
                            } else {
                              setResume(r.content || ""); onResumeLoad?.(r.id);
                              setResumeSource("upload"); setLibrarySaved(false); setLibrarySaveError("");
                              setIsOptimized(false); setImproveStats(null); setSelectedKeywords([]); setResultsInsights(null);
                              if (r.ats_score != null) {
                                setResults({ atsScore: r.ats_score, potentialAtsScore: r.potential_ats_score || Math.min(r.ats_score + 20, 98), scoreBreakdown: r.score_breakdown || null, keywordsFound: r.keywords_found || [], keywordsMissing: r.keywords_missing || [], tailoredResume: r.content || "", suggestions: r.suggestions || [], coverLetter: "", jobTitle: "", company: "" });
                                setMasterMissingKws(r.keywords_missing || []); setTab("resume");
                              } else { setResults(null); }
                            }
                          }}
                          style={{ width: 22, height: 22, minWidth: 22, borderRadius: "50%", border: `2px solid ${isLoaded ? C.green : C.border}`, padding: 0, cursor: "pointer", flexShrink: 0, background: isLoaded ? C.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center", outline: "none", fontFamily: "inherit", WebkitTapHighlightColor: "transparent", transition: "background 0.15s, border-color 0.15s" }}
                          aria-label={isLoaded ? t("resume.deselectResume") : t("resume.selectResume")}
                        >
                          {isLoaded && <span style={{ color: "#fff", fontSize: 11, fontWeight: 700, lineHeight: 1, userSelect: "none" }}>✓</span>}
                        </button>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.name}</div>
                        </div>
                        {/* Actions dropdown — stopPropagation prevents card click from firing */}
                        <div style={{ position: "relative", flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                          <button
                            onClick={(e) => { e.stopPropagation(); setOpenDropdownId(v => v === r.id ? null : r.id); }}
                            style={{ padding: "4px 10px", fontSize: 11, fontWeight: 600, color: C.textMid, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 7, cursor: "pointer", fontFamily: "inherit" }}
                          >{t("resume.actionsMenu")}</button>
                          {openDropdownId === r.id && (
                            <div style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 300, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 10, boxShadow: "0 6px 24px rgba(0,0,0,0.13)", minWidth: 186, padding: "4px 0", animation: "summaryEntrance 0.12s ease-out" }}>
                              {[
                                { icon: "📄", label: t("resume.downloadPdfShort"),  action: () => downloadPDF(r.content, r.name.replace(/\.[^.]+$/, "")) },
                                { icon: "📝", label: t("resume.downloadDocxShort"), action: () => downloadDOCX(r.content, r.name.replace(/\.[^.]+$/, "")) },
                                { icon: "✏️", label: t("resume.editResume"),        action: () => handleEditResume(r) },
                                { icon: "🗑️", label: t("resume.deleteResume"),     action: () => handleDeleteResume(r), danger: true },
                              ].map(({ icon, label, action, danger }) => (
                                <button key={label} onClick={() => { action(); setOpenDropdownId(null); }}
                                  style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 14px", border: "none", background: "none", cursor: "pointer", fontSize: 13, color: danger ? C.red : C.text, textAlign: "left", fontFamily: "inherit" }}
                                  onMouseEnter={e => e.currentTarget.style.background = danger ? `${C.red}0A` : C.bgSoft}
                                  onMouseLeave={e => e.currentTarget.style.background = "none"}
                                >
                                  <span style={{ width: 18, textAlign: "center" }}>{icon}</span><span style={{ fontWeight: danger ? 600 : 400 }}>{label}</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap", marginTop: 6 }}>
                        {r.ats_score != null && <span style={{ fontSize: 11, fontWeight: 700, color: hc, background: `${hc}20`, borderRadius: 6, padding: "2px 7px" }}>ATS {r.ats_score}%</span>}
                        {hl && <span style={{ fontSize: 11, fontWeight: 600, color: hc, background: `${hc}15`, borderRadius: 6, padding: "2px 7px" }}>{hl}</span>}
                        {r.last_analyzed_at && <span style={{ fontSize: 11, color: C.textMuted }}>{new Date(r.last_analyzed_at).toLocaleDateString()}</span>}
                        {isLoaded && !isEditing && <span style={{ fontSize: 10, fontWeight: 700, color: C.green, background: C.greenLight, borderRadius: 6, padding: "2px 7px" }}>{t("resume.loaded")}</span>}
                        {isEditing && <span style={{ fontSize: 10, fontWeight: 700, color: C.purple, background: C.purpleLight, borderRadius: 6, padding: "2px 7px" }}>{t("resume.editingBadge")}</span>}
                      </div>
                      {/* Per-resume language row */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, flexWrap: "wrap" }} onClick={e => e.stopPropagation()}>
                        <span style={{ fontSize: 11, color: C.textMuted, flexShrink: 0 }}>{t("resume.resumeLanguageLabel")}:</span>
                        <select
                          value={r.language || "en"}
                          onChange={async e => {
                            e.stopPropagation();
                            if (updateResumeLanguage) {
                              try { await updateResumeLanguage(r.id, e.target.value, r.detected_language, r.language_confidence); } catch {}
                            }
                          }}
                          style={{ fontSize: 11, padding: "2px 6px", borderRadius: 6, border: `1px solid ${C.border}`, background: "#fff", color: C.text, fontFamily: "inherit", cursor: "pointer" }}
                        >
                          {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.native}</option>)}
                        </select>
                        {r.detected_language && r.detected_language !== (r.language || "en") && (
                          <span style={{ fontSize: 10, color: C.textMuted }}>
                            {t("resume.detectedLanguageLabel")}: {LANGUAGES.find(l => l.code === r.detected_language)?.flag} {LANGUAGES.find(l => l.code === r.detected_language)?.native}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Smart AI Language Suggestion — only when a resume is loaded and job language differs */}
          {(() => {
            const loadedResume = resumes.find(r => r.id === activeResumeId);
            const effectiveJobLang = jobLanguage || "en";
            const suggestLang = loadedResume ? computeLanguageSuggestion({
              resume: loadedResume,
              jobLanguage: effectiveJobLang,
              jobDesc,
              searchCountry: searchFilters?.country,
            }) : null;
            const suggestMeta = suggestLang ? LANGUAGES.find(l => l.code === suggestLang) : null;
            if (!suggestMeta) return null;
            const suggestBody = t("resume.langSuggestionBody");
            return (
              <div style={{ background: `linear-gradient(135deg,${C.purpleLight},#fff)`, border: `1.5px solid ${C.purple}30`, borderRadius: 14, padding: "14px 16px", marginBottom: 14, animation: "summaryEntrance 0.3s ease-out" }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                  <span style={{ fontSize: 20, flexShrink: 0 }}>🤖</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.purple, marginBottom: 4 }}>{t("resume.langSuggestionTitle")}</div>
                    <div style={{ fontSize: 13, color: C.textMid, marginBottom: 10 }}>{suggestBody}</div>
                    <Btn
                      onClick={async () => {
                        if (!loadedResume || !updateResumeLanguage) return;
                        try { await updateResumeLanguage(loadedResume.id, suggestLang, loadedResume.detected_language, loadedResume.language_confidence); } catch {}
                      }}
                      style={{ fontSize: 12, padding: "7px 14px" }}
                    >
                      {t("resume.langSuggestionBtn").replace("{flag}", suggestMeta.flag).replace("{name}", suggestMeta.native)}
                    </Btn>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* SECTION 2 — Resume Workspace */}
          <div id="resume-workspace">
            {!results && !loading && workspaceInputsJSX}
            {loading && <Spinner steps={[t("resume.resumeStep1"),t("resume.resumeStep2"),t("resume.resumeStep3"),t("resume.resumeStep4"),t("resume.resumeStep5")]} currentStep={loadStep} />}
          </div>
          {/* SECTION 3 — Resume Analysis */}
          {results && (
            <div id="resume-analysis-section" style={{ marginBottom: 16 }}>
              <Card style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>{t("resume.analysisComplete")}</div>
                    {results.jobTitle && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{results.jobTitle}{validCompany(results.company) ? t("resume.atSeparator") + results.company : ""}</div>}
                    {editingResumeName && <div style={{ fontSize: 11, color: C.purple, fontWeight: 700, marginTop: 2 }}>{t("resume.editingLabel")} {editingResumeName}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
                    <Btn onClick={handleSaveToLibrary} disabled={improving || savingToLibrary || !profile?.id} loading={savingToLibrary} style={{ fontSize: 13 }}>
                      {librarySaved ? t("resume.savedToLibrary") : isOptimized ? t("resume.saveOptimizedResume") : t("resume.saveToLibrary")}
                    </Btn>
                    <Btn variant="secondary" disabled={improving} onClick={newAnalysisReset} style={{ fontSize: 12 }}>{t("resume.newAnalysis")}</Btn>
                  </div>
                </div>
              </Card>

          {/* Improvement loading overlay */}
          {improving && (
            <div style={{ background: C.purpleLight, border: `1px solid ${C.purple}30`, borderRadius: 12, padding: "12px 16px", marginBottom: 14, display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 20, height: 20, flexShrink: 0, border: `2.5px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.purple }}>{improveStep || t("resume.improvingResume")}</div>
                <div style={{ fontSize: 11, color: C.textMid, marginTop: 2 }}>{t("resume.improvingWait")}</div>
              </div>
            </div>
          )}

          {/* Improvement Summary — persistent until New Analysis is clicked */}
          {isOptimized && improveStats && !improving && (() => {
            const delta = improveStats.newAts - improveStats.oldAts;
            const health = resumeHealthFrom(improveStats.newAts);
            const healthColor = hubHealthColor(improveStats.newAts);
            const remaining = resultsInsights?.highPriorityImprovements?.length ?? results.suggestions?.length ?? 0;
            return (
              <div style={{ background: `linear-gradient(135deg, ${C.greenLight}, #fff)`, border: `1.5px solid ${C.green}35`, borderRadius: 14, padding: "14px 16px", marginBottom: 14, animation: "summaryEntrance 0.4s ease-out" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                  <span style={{ fontSize: 18 }}>✅</span>
                  <div>
                    <span style={{ fontSize: 16, fontWeight: 800, color: C.green }}>{delta >= 0 ? `+${delta}` : delta} {t("resume.atsPoints")}</span>
                    <span style={{ fontSize: 12, color: C.textMid, marginLeft: 8 }}>{t("resume.optimizedSuccessfully")}</span>
                  </div>
                </div>
                <div className="improve-summary-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
                  {[
                    { label: t("resume.atsScoreLabel"), value: `${improveStats.oldAts} → ${improveStats.newAts}`, sub: `${delta >= 0 ? "+" : ""}${delta} pts`, subColor: delta >= 0 ? C.green : C.red },
                    { label: t("resume.keywordsAddedLabel"), value: improveStats.addedCount, sub: t("resume.incorporated"), subColor: C.purple },
                    { label: t("resume.remainingImprovements"), value: remaining, sub: remaining === 1 ? t("resume.opportunity") : t("resume.opportunities"), subColor: remaining > 0 ? C.yellow : C.green },
                    { label: t("resume.resumeHealth"), value: health || "—", sub: `${improveStats.newAts}% ATS`, subColor: healthColor },
                  ].map(({ label, value, sub, subColor }) => (
                    <div key={label} style={{ background: "#fff", borderRadius: 10, padding: "12px 8px", textAlign: "center", border: `1px solid ${C.border}` }}>
                      <div style={{ fontSize: 17, fontWeight: 800, color: C.text, lineHeight: 1.15, marginBottom: 2 }}>{value}</div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: subColor, marginBottom: 3 }}>{sub}</div>
                      <div style={{ fontSize: 10, color: C.textMuted, lineHeight: 1.3 }}>{label}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {insightsDone && !librarySaved && (
            <div style={{ background: C.greenLight, border: `1.5px solid ${C.green}35`, borderRadius: 10, padding: "12px 16px", marginBottom: 14, display: "flex", alignItems: "center", gap: 12, animation: "summaryEntrance 0.3s ease-out" }}>
              <span style={{ fontSize: 18, flexShrink: 0 }}>✅</span>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.green }}>{t("resume.allImprovementsApplied")}</div>
                <div style={{ fontSize: 12, color: C.textMid, marginTop: 2 }}>{t("resume.readyToSave")}</div>
              </div>
            </div>
          )}
          {librarySaved && isOptimized && (
            <div style={{ background: `linear-gradient(135deg,${C.purple},${C.purpleMid})`, borderRadius: 10, padding: "10px 18px", marginBottom: 16, textAlign: "center", boxShadow: `0 4px 16px ${C.purple}40`, animation: "summaryEntrance 0.3s ease-out" }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", marginBottom: 3 }}>{t("resume.optimizedSavedTitle")}</div>
              <div style={{ fontSize: 13, fontWeight: 400, color: "#fff", lineHeight: 1.5 }}>{t("resume.optimizedSavedBody")}</div>
            </div>
          )}
          {librarySaved && !isOptimized && (
            <div style={{ background: C.greenLight, border: `1.5px solid ${C.green}35`, borderRadius: 10, padding: "12px 16px", marginBottom: 16, animation: "summaryEntrance 0.3s ease-out" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 16 }}>✅</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.green }}>{t("resume.savedToLibraryShort")}</span>
              </div>
              <div style={{ fontSize: 12, color: C.textMuted }}>{t("resume.libraryUpdated")}</div>
            </div>
          )}
          {librarySaveError && (
            <div style={{ background: `${C.red}10`, border: `1px solid ${C.red}30`, borderRadius: 8, padding: "10px 14px", marginBottom: 16, fontSize: 12, color: C.red }}>
              {librarySaveError}
            </div>
          )}

          {/* ATS Score Section */}
          <Card style={{ marginBottom: 14, background: `linear-gradient(135deg, ${C.purpleLight}, #fff)` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 32, flexWrap: "wrap" }}>
              <div style={{ textAlign: "center", flexShrink: 0 }}>
                <ScoreRing score={animatedAts ?? results.atsScore} size={120} />
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 8, fontWeight: 600 }}>{t("resume.currentAtsScore")}</div>
                {!improveStats && analysisHistory?.length >= 2 && analysisHistory[1]?.atsScore != null && (
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>{t("resume.prevLabel")} {analysisHistory[1].atsScore}%</div>
                )}
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                {[[t("resume.keywordMatch"), (animatedBreakdown ?? results.scoreBreakdown)?.keywordMatch], [t("resume.formatting"), (animatedBreakdown ?? results.scoreBreakdown)?.formatting], [t("resume.relevance"), (animatedBreakdown ?? results.scoreBreakdown)?.relevance]].map(([l, v]) => (
                  <div key={l} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}><span style={{ color: C.textMid, fontWeight: 500 }}>{l}</span><span style={{ fontWeight: 700, color: v >= 80 ? C.green : v >= 60 ? C.yellow : C.red }}>{v}%</span></div>
                    <PBar val={v} />
                  </div>
                ))}
              </div>
            </div>
          </Card>

          {/* Keywords */}
          <div id="missing-keywords-section" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }} className="two-col">
            <div style={{ background: C.greenLight, border: `1px solid ${C.green}25`, borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 12, color: C.green, fontWeight: 700, marginBottom: 10 }}>{t("resume.keywordsFound")}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{results.keywordsFound?.map(k => <Badge key={k} color={C.green}>{k}</Badge>)}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {isOptimized ? (
                <div style={{ background: C.greenLight, border: `1px solid ${C.green}25`, borderRadius: 12, padding: 16 }}>
                  <div style={{ fontSize: 13, color: C.green, fontWeight: 700, marginBottom: 10 }}>{t("resume.successfullyOptimized")}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
                    <div style={{ color: C.green }}>{t("resume.atsScoreUpdated")}</div>
                    <div style={{ color: C.green }}>{t("resume.resumeTailored")}</div>
                    <div style={{ color: C.green }}>{t("resume.keywordsAddedSuccessfully")}</div>
                    <div style={{ color: C.green }}>{t("resume.readyToApply")}</div>
                    <div style={{ color: C.textMid }}>{t("resume.useNewAnalysisHint")}</div>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ background: C.redLight, border: `1px solid ${C.red}25`, borderRadius: 12, padding: 16 }}>
                    <div style={{ fontSize: 12, color: C.red, fontWeight: 700, marginBottom: 6 }}>{t("resume.keywordsMissing")}</div>
                    <div style={{ fontSize: 11, color: C.textMid, marginBottom: 8, lineHeight: 1.5 }}>{t("resume.aiPreselectedKeywords").replace("{n}", results.keywordsMissing?.length)}</div>
                    <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                      <button onClick={() => setSelectedKeywords(results.keywordsMissing || [])} style={{ fontSize: 10, padding: "3px 9px", borderRadius: 6, border: `1px solid ${C.purple}`, background: C.purpleLight, color: C.purple, cursor: "pointer", fontWeight: 700, fontFamily: "inherit" }}>{t("resume.selectAll")}</button>
                      <button onClick={() => setSelectedKeywords([])} style={{ fontSize: 10, padding: "3px 9px", borderRadius: 6, border: `1px solid ${C.border}`, background: "#fff", color: C.textMuted, cursor: "pointer", fontWeight: 600, fontFamily: "inherit" }}>{t("resume.deselectAll")}</button>
                    </div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {results.keywordsMissing?.map(k => {
                        const sel = selectedKeywords.includes(k);
                        return (
                          <div key={k} onClick={() => setSelectedKeywords(prev => prev.includes(k) ? prev.filter(x => x !== k) : [...prev, k])}
                            style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "5px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer", userSelect: "none", background: sel ? C.purple : "#fff", color: sel ? "#fff" : C.red, border: `1.5px solid ${sel ? C.purple : C.red}50`, boxShadow: sel ? `0 0 0 2px ${C.purple}25` : "none", transition: "all 0.15s", touchAction: "manipulation" }}>
                            {sel && <span style={{ fontSize: 10, fontWeight: 800 }}>✓</span>}
                            {k}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  {results.keywordsMissing?.length > 0 && !canUseAI && (
                    <LockedAICard title={t("resume.lockedImproveTitle")} description={t("resume.lockedImproveDesc")} benefits={t("resume.lockedImproveBenefits")} buttonLabel={t("settings.upgradeToPro")} onUpgrade={() => onNavigate?.("pricing")} />
                  )}
                  {results.keywordsMissing?.length > 0 && canUseAI && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {improveError && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: "8px 12px", color: C.red, fontSize: 12 }}>{improveError}</div>}
                      <Btn onClick={handleImproveResume} loading={improving} disabled={!selectedKeywords.length || improving || improvedBtnDone} style={{ width: "100%", ...(improvedBtnDone ? { background: C.green } : {}) }}>
                        {improving ? t("resume.improvingResume") : improvedBtnDone ? t("resume.resumeImproved") : selectedKeywords.length === 1 ? t("resume.improveMyResumeSingular") : selectedKeywords.length > 1 ? t("resume.improveMyResumePlural").replace("{n}", selectedKeywords.length) : t("resume.improveMyResume")}
                      </Btn>
                      {!selectedKeywords.length && <div style={{ fontSize: 11, color: C.textMuted }}>{t("resume.selectKeywordsHint")}</div>}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {isOptimized && improveStats && !improving && (
            <div style={{ background: `linear-gradient(135deg,${C.purple},${C.purpleMid})`, borderRadius: 10, padding: "10px 18px", marginBottom: 16, textAlign: "center", boxShadow: `0 4px 16px ${C.purple}40`, animation: "summaryEntrance 0.3s ease-out" }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", marginBottom: 3 }}>{t("resume.keywordsAppliedTitle")}</div>
              <div style={{ fontSize: 13, fontWeight: 400, color: "#fff", lineHeight: 1.5 }}>{t("resume.keywordsAppliedBody")}</div>
            </div>
          )}
          {/* Tabs */}
          <div id="resume-tabs" style={{ display: "flex", gap: 3, background: C.bgSoft, borderRadius: 10, padding: 3, marginBottom: 16 }}>
            {[["resume", t("resume.tabResume")],["suggestions", t("resume.tabSuggestions")],["cover", t("resume.tabCover")],["insights", t("resume.tabInsights")]].map(([id, lbl]) => (
              <Btn key={id} variant="ghost" style={{ flex: 1, padding: "10px", borderRadius: 7, border: "none", background: tab === id ? "#fff" : "transparent", color: tab === id ? C.purple : C.textMuted, fontSize: 13, fontWeight: tab === id ? 700 : 500, boxShadow: tab === id ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }} onClick={() => setTab(id)}>{lbl}</Btn>
            ))}
          </div>

          {tab === "resume" && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>
                {isOptimized ? t("resume.yourOptimizedResume") : t("resume.optimizedPreview")}
              </div>
              {/* minHeight matches the edit textarea's own minHeight so switching between
                  View Mode (ResumeDoc, height varies with content) and Edit Mode (fixed-
                  height textarea) doesn't visibly jump the surrounding page layout. */}
              <div id="resume-editor-preview" className={editorHighlight ? "editor-highlight-active" : ""} style={{ minHeight: 480 }}>
                {editingPreview ? (
                  <textarea
                    autoFocus
                    value={isOptimized ? resume : results.tailoredResume}
                    onChange={e => {
                      if (isOptimized) setResume(e.target.value);
                      else setResults(prev => ({ ...prev, tailoredResume: e.target.value }));
                    }}
                    style={{ width: "100%", minHeight: 480, background: "#fff", border: `1.5px solid ${C.purple}`, borderRadius: 9, color: C.text, fontSize: 13, lineHeight: 1.8, padding: "16px", resize: "vertical", outline: "none", fontFamily: "'Courier New', Courier, monospace", boxSizing: "border-box" }}
                  />
                ) : (
                  <ResumeDoc content={isOptimized ? resume : results.tailoredResume} profile={profile} />
                )}
              </div>
              <div className="cp-action-bar">
                {editingPreview ? (
                  <Btn variant="secondary" onClick={() => setEditingPreview(e => !e)} style={{ fontSize: 12, padding: "6px 14px", touchAction: "manipulation", color: C.purple, background: C.purpleLight, border: `1px solid ${C.purple}` }}>{t("resume.preview")}</Btn>
                ) : (
                  <Btn variant="secondary" onClick={() => setEditingPreview(e => !e)} style={{ fontSize: 12, padding: "6px 14px", touchAction: "manipulation" }}>{t("resume.editBtn")}</Btn>
                )}
                <Btn variant="secondary" onClick={() => downloadPDF(isOptimized ? resume : results.tailoredResume, isOptimized ? "optimized-resume" : "tailored-resume")} style={{ fontSize: 12, padding: "6px 14px" }}>{t("resume.downloadPdf")}</Btn>
                <Btn variant="secondary" onClick={() => downloadDOCX(isOptimized ? resume : results.tailoredResume, isOptimized ? "optimized-resume" : "tailored-resume")} style={{ fontSize: 12, padding: "6px 14px" }}>{t("resume.downloadDocx")}</Btn>
                <CopyBtn text={resumeDocToHTML(parseResumeDoc(isOptimized ? resume : results.tailoredResume), true)} variant="secondary" />
              </div>
            </div>
          )}
          {tab === "suggestions" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {results.suggestions?.map((s, i) => (
                <div key={i} style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 18px", display: "flex", gap: 12, alignItems: "flex-start" }}>
                  <span style={{ fontSize: 20 }}>{"🎯📝💼🔧⚡"[i]}</span>
                  <span style={{ fontSize: 14, lineHeight: 1.7, color: C.text }}>{s}</span>
                </div>
              ))}
            </div>
          )}
          {tab === "cover" && !canUseAI && (
            <LockedAICard title={t("resume.lockedCoverTitle")} description={t("resume.lockedCoverDesc")} benefits={t("resume.lockedCoverBenefits")} buttonLabel={t("settings.upgradeToPro")} onUpgrade={() => onNavigate?.("pricing")} />
          )}
          {tab === "cover" && canUseAI && (() => {
            const currentCoverText = editingCoverLetter ? editedCoverText : (coverVersions?.[activeCoverVersion] || results.coverLetter);
            return (
            <div>
              {/* Version selector + controls */}
              <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
                {[["professional",t("resume.coverStyleProfessional"),"★"],["friendly",t("resume.coverStyleFriendly"),null],["executive",t("resume.coverStyleExecutive"),null],["ats",t("resume.coverStyleAts"),null]].map(([v, lbl, badge]) => (
                  <button key={v} onClick={() => { setActiveCoverVersion(v); setEditingCoverLetter(false); setEditedCoverText(""); }}
                    disabled={!coverVersions}
                    style={{ padding: "5px 12px", borderRadius: 8, border: `1.5px solid ${activeCoverVersion === v && coverVersions ? C.purple : C.border}`, background: activeCoverVersion === v && coverVersions ? C.purpleLight : "#fff", color: activeCoverVersion === v && coverVersions ? C.purple : C.textMuted, fontSize: 11, fontWeight: activeCoverVersion === v ? 700 : 500, cursor: coverVersions ? "pointer" : "default", fontFamily: "inherit", opacity: coverVersions ? 1 : 0.5, display: "flex", alignItems: "center", gap: 4 }}>
                    {lbl}{badge && <span style={{ fontSize: 9, fontWeight: 800, color: C.yellow }}>★</span>}
                  </button>
                ))}
                {coverVersions && (
                  <Btn onClick={() => generateCoverVersions()} loading={coverVersionsLoading} variant="secondary" style={{ fontSize: 11, padding: "5px 12px", marginLeft: "auto" }}>
                    {t("resume.regenerateAll")}
                  </Btn>
                )}
              </div>
              {coverVersionsError && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 8, padding: "8px 12px", color: C.red, fontSize: 12, marginBottom: 10 }}>{coverVersionsError}</div>}
              {coverVersionsLoading && (
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: C.bgSoft, borderRadius: 10, marginBottom: 10 }}>
                  <div style={{ width: 16, height: 16, border: `2px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: C.textMid }}>{t("resume.generatingCoverVersions")}</span>
                </div>
              )}
              {coverVersions && !editingCoverLetter && (
                <div style={{ fontSize: 11, color: C.green, fontWeight: 600, marginBottom: 8 }}>{t("resume.coverVersionsReady")}</div>
              )}
              {/* Edit mode: textarea; display mode: ContentDisplay */}
              {editingCoverLetter ? (
                <textarea value={editedCoverText} onChange={e => setEditedCoverText(e.target.value)}
                  style={{ width: "100%", minHeight: 280, background: "#fff", border: `1.5px solid ${C.purple}`, borderRadius: 9, color: C.text, fontSize: 13, lineHeight: 1.8, padding: "14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
              ) : (
                <ContentDisplay content={currentCoverText} />
              )}
              {/* Action bar — identical to Resume action bar */}
              <div className="cp-action-bar">
                {editingCoverLetter ? (
                  <Btn variant="primary" style={{ fontSize: 12, padding: "6px 14px" }} onClick={() => {
                    if (coverVersions) setCoverVersions(prev => ({ ...prev, [activeCoverVersion]: editedCoverText }));
                    setEditingCoverLetter(false);
                  }}>{t("resume.doneBtn")}</Btn>
                ) : (
                  <Btn variant="secondary" style={{ fontSize: 12, padding: "6px 14px" }} onClick={() => { setEditingCoverLetter(true); setEditedCoverText(currentCoverText); }}>{t("resume.editBtn")}</Btn>
                )}
                <Btn variant="secondary" style={{ fontSize: 12, padding: "6px 14px" }} onClick={() => downloadCoverLetterPDF(currentCoverText, `cover-letter-${activeCoverVersion}`)}>{t("resume.downloadPdf")}</Btn>
                <Btn variant="secondary" style={{ fontSize: 12, padding: "6px 14px" }} onClick={() => downloadCoverLetterDOCX(currentCoverText, `cover-letter-${activeCoverVersion}`)}>{t("resume.downloadDocx")}</Btn>
                <CopyBtn text={currentCoverText} variant="secondary" />
              </div>
            </div>
            );
          })()}
          {tab === "insights" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {insightsLoading && (
                <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 20px", background: C.bgSoft, borderRadius: 12 }}>
                  <div style={{ width: 18, height: 18, flexShrink: 0, border: `2.5px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.textMid }}>{t("resume.generatingInsights")}</div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{t("resume.insightsReviewBody")}</div>
                  </div>
                </div>
              )}
              {isOptimized && !insightsLoading && (
                <div style={{ background: C.greenLight, border: `1px solid ${C.green}30`, borderRadius: 12, padding: "14px 16px" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.green, marginBottom: 4 }}>{t("resume.optimizedForJob")}</div>
                  <div style={{ fontSize: 12, color: C.textMid, lineHeight: 1.6 }}>{t("resume.insightsBasedOnOriginal")}</div>
                </div>
              )}
              {resultsInsights && (() => {
                const strengths = resultsInsights.strengths || [];
                const improvements = resultsInsights.highPriorityImprovements || resultsInsights.weaknesses || [];
                const missingSkills = resultsInsights.missingSkills || [];
                const tailoring = resultsInsights.tailoringOpportunities || [];
                const PRIORITY_TIERS = [
                  { label: "Critical", color: C.red, bg: C.redLight },
                  { label: "Important", color: C.yellow, bg: C.yellowLight },
                  { label: "Additional", color: C.blue, bg: C.blueLight },
                ];
                const ShowMoreBtn = ({ sectionKey, items, color, initialShow = 2 }) => {
                  if (items.length <= initialShow) return null;
                  const expanded = insightsSectionExpanded[sectionKey];
                  return (
                    <button onClick={() => toggleInsightSection(sectionKey)} style={{ marginTop: 10, background: "none", border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600, color, padding: 0, textAlign: "left" }}>
                      {expanded ? t("resume.showLessInsights") : t("resume.showMoreInsights").replace("{n}", items.length - initialShow)}
                    </button>
                  );
                };
                return (
                  <>
                    {/* Strengths */}
                    <div style={{ background: C.greenLight, border: `1px solid ${C.green}25`, borderRadius: 12, padding: 16 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.green, marginBottom: 10 }}>{t("resume.strengthsTitle")}</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {(insightsSectionExpanded.strengths ? strengths : strengths.slice(0, 2)).map((s, i) => (
                          <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                            <span style={{ color: C.green, flexShrink: 0, fontWeight: 700, marginTop: 2 }}>✓</span>
                            <span style={{ fontSize: 13, lineHeight: 1.65, color: C.text }}>{s}</span>
                          </div>
                        ))}
                      </div>
                      <ShowMoreBtn sectionKey="strengths" items={strengths} color={C.green} />
                    </div>

                    {/* Growth Opportunities — categorized by priority tier */}
                    {improvements.length > 0 && (
                      <div style={{ background: C.yellowLight, border: `1px solid ${C.yellow}30`, borderRadius: 12, padding: 16 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.yellow, marginBottom: 4 }}>{t("resume.growthTitle")}</div>
                        <div style={{ fontSize: 11, color: C.textMid, marginBottom: 12 }}>{t("resume.growthBody")}</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                          {(insightsSectionExpanded.improvements ? improvements : improvements.slice(0, 2)).map((w, i) => {
                            const tier = PRIORITY_TIERS[Math.min(i, 2)];
                            return (
                              <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", background: tier.bg, border: `1px solid ${tier.color}25`, borderRadius: 10, padding: "10px 12px" }}>
                                <span style={{ fontSize: 10, fontWeight: 700, color: tier.color, background: `${tier.color}20`, borderRadius: 6, padding: "2px 8px", flexShrink: 0, whiteSpace: "nowrap", marginTop: 1 }}>{tier.label}</span>
                                <span style={{ fontSize: 13, lineHeight: 1.65, color: C.text }}>{w}</span>
                              </div>
                            );
                          })}
                        </div>
                        <ShowMoreBtn sectionKey="improvements" items={improvements} color={C.yellow} />
                      </div>
                    )}

                    {/* Skills to Develop */}
                    {missingSkills.length > 0 && (
                      <div style={{ background: "#FFF7ED", border: "1px solid #EA580C25", borderRadius: 12, padding: 16 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#EA580C", marginBottom: 4 }}>{t("resume.skillsDevelopTitle")}</div>
                        <div style={{ fontSize: 11, color: C.textMid, marginBottom: 12 }}>{t("resume.skillsDevelopBody")}</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                          {(insightsSectionExpanded.skills ? missingSkills : missingSkills.slice(0, 6)).map((s, i) => (
                            <span key={i} style={{ background: "#fff", border: "1.5px solid #EA580C40", borderRadius: 20, padding: "5px 13px", fontSize: 12, fontWeight: 600, color: "#EA580C", lineHeight: 1.4 }}>{s}</span>
                          ))}
                        </div>
                        <ShowMoreBtn sectionKey="skills" items={missingSkills} color="#EA580C" initialShow={6} />
                      </div>
                    )}

                    {/* Tailoring Opportunities */}
                    {tailoring.length > 0 && (
                      <div style={{ background: C.purpleLight, border: `1px solid ${C.purple}25`, borderRadius: 12, padding: 16 }}>
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.purple, marginBottom: 10 }}>{t("resume.tailoringTitle")}</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                          {(insightsSectionExpanded.tailoring ? tailoring : tailoring.slice(0, 2)).map((o, i) => (
                            <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                              <span style={{ color: C.purple, flexShrink: 0, fontWeight: 700, marginTop: 2 }}>{i + 1}.</span>
                              <span style={{ fontSize: 13, lineHeight: 1.65, color: C.text }}>{o}</span>
                            </div>
                          ))}
                        </div>
                        <ShowMoreBtn sectionKey="tailoring" items={tailoring} color={C.purple} />
                      </div>
                    )}
                  </>
                );
              })()}
              {!resultsInsights && !insightsLoading && (
                <div style={{ padding: 24, background: C.bgSoft, borderRadius: 12, fontSize: 13, color: C.textMuted, textAlign: "center" }}>
                  {t("resume.insightsPending")}
                </div>
              )}

              {/* Deep Insights — grammar, readability, action verbs, formatting */}
              {!canUseAI && (
                <div style={{ borderTop: `1.5px solid ${C.border}`, paddingTop: 16 }}>
                  <LockedAICard title={t("resume.lockedDeepInsightsTitle")} description={t("resume.lockedDeepInsightsDesc")} benefits={t("resume.lockedDeepInsightsBenefits")} buttonLabel={t("settings.upgradeToPro")} onUpgrade={() => onNavigate?.("pricing")} />
                </div>
              )}
              {canUseAI && (
              <div style={{ borderTop: `1.5px solid ${C.border}`, paddingTop: 16 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{t("resume.deepAnalysisTitle")}</div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {deepInsights && (deepInsights.issues?.length > 0 || deepInsights.weakBullets?.length > 0 || deepInsights.weakActionVerbs?.length > 0) && (
                      <Btn onClick={applyAllDeepFixes} loading={applyingAllFixes} style={{ fontSize: 11, padding: "5px 12px" }}>
                        {t("resume.applyAllFixes")}
                      </Btn>
                    )}
                    <Btn onClick={runDeepInsights} loading={deepInsightsLoading} variant="secondary" style={{ fontSize: 11, padding: "5px 12px" }}>
                      {deepInsights ? t("resume.reanalyze") : t("resume.runDeepAnalysis")}
                    </Btn>
                  </div>
                </div>
                {deepInsightsError && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 8, padding: "8px 12px", color: C.red, fontSize: 12, marginBottom: 10 }}>{deepInsightsError}</div>}
                {deepInsightsLoading && (
                  <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: C.bgSoft, borderRadius: 10 }}>
                    <div style={{ width: 16, height: 16, border: `2px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: C.textMid }}>{t("resume.deepAnalysisLoading")}</span>
                  </div>
                )}
                {deepInsights && (() => {
                  const scores = [
                    { label: t("resume.grammarLabel"), val: deepInsights.grammarScore, color: hubHealthColor(deepInsights.grammarScore) },
                    { label: t("resume.readabilityLabel"), val: deepInsights.readabilityScore, color: hubHealthColor(deepInsights.readabilityScore) },
                    { label: t("resume.formatting"), val: deepInsights.formattingScore, color: hubHealthColor(deepInsights.formattingScore) },
                    { label: t("resume.keywordDensityLabel"), val: deepInsights.keywordDensity, color: hubHealthColor(deepInsights.keywordDensity) },
                    { label: t("resume.actionVerbsLabel"), val: deepInsights.actionVerbScore, color: hubHealthColor(deepInsights.actionVerbScore) },
                  ];
                  const severityColor = { high: C.red, medium: C.yellow, low: C.blue };
                  const severityBg = { high: C.redLight, medium: C.yellowLight, low: C.blueLight };
                  return (
                    <>
                      {/* Score bars */}
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 6, marginBottom: 16 }}>
                        {scores.map(({ label, val, color }) => (
                          <div key={label} style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 6px", textAlign: "center" }}>
                            <div style={{ fontSize: 16, fontWeight: 800, color }}>{val ?? "—"}</div>
                            <div style={{ fontSize: 9, color: C.textMuted, marginTop: 2 }}>{label}</div>
                          </div>
                        ))}
                      </div>
                      {/* Meta info */}
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                        {deepInsights.resumeLengthStatus && <span style={{ fontSize: 11, fontWeight: 600, color: C.textMid, background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 20, padding: "3px 10px" }}>{t("resume.lengthLabel")} {deepInsights.resumeLengthStatus}</span>}
                        {deepInsights.contactInfoStatus && <span style={{ fontSize: 11, fontWeight: 600, color: C.textMid, background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 20, padding: "3px 10px" }}>{t("resume.contactLabel")} {deepInsights.contactInfoStatus}</span>}
                        {deepInsights.missingSections?.length > 0 && <span style={{ fontSize: 11, fontWeight: 600, color: C.orange, background: C.orangeLight, border: `1px solid ${C.orange}30`, borderRadius: 20, padding: "3px 10px" }}>{t("resume.missingSectionsLabel")} {deepInsights.missingSections.join(", ")}</span>}
                      </div>
                      {/* Issues */}
                      {deepInsights.issues?.length > 0 && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 4 }}>{t("resume.issuesFound")}</div>
                          {deepInsights.issues.map((issue, i) => {
                            const isApplying = applyingIssueFix === issue.problem;
                            return (
                              <div key={i} style={{ background: severityBg[issue.severity] || C.bgSoft, border: `1px solid ${(severityColor[issue.severity] || C.blue)}25`, borderRadius: 10, padding: "10px 14px" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                                  <span style={{ fontSize: 9, fontWeight: 700, color: severityColor[issue.severity] || C.blue, background: `${(severityColor[issue.severity] || C.blue)}20`, borderRadius: 4, padding: "2px 7px", textTransform: "uppercase" }}>{issue.severity}</span>
                                  <span style={{ fontSize: 11, fontWeight: 700, color: C.textMid }}>{issue.category}</span>
                                  <Btn onClick={() => applyIssueFix(issue)} loading={isApplying} variant="secondary" style={{ fontSize: 10, padding: "3px 8px", marginLeft: "auto" }} disabled={!!applyingIssueFix}>
                                    {isApplying ? t("resume.fixing") : t("resume.aiFix")}
                                  </Btn>
                                </div>
                                <div style={{ fontSize: 12, color: C.text, marginBottom: 4, lineHeight: 1.5 }}>{issue.problem}</div>
                                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4 }}>{t("resume.whyItMatters")} {issue.reason}</div>
                                <div style={{ fontSize: 11, fontWeight: 600, color: C.green }}>{t("resume.fixLabel")} {issue.fix}</div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {/* Weak bullets */}
                      {deepInsights.weakBullets?.length > 0 && (
                        <div style={{ marginBottom: 14 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("resume.strongerBullets")}</div>
                          {deepInsights.weakBullets.map((b, i) => (
                            <div key={i} style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 9, padding: "10px 14px", marginBottom: 6 }}>
                              <div style={{ fontSize: 11, color: C.red, marginBottom: 4, lineHeight: 1.5 }}>{t("resume.beforeLabel")} {b.original}</div>
                              <div style={{ fontSize: 11, color: C.green, fontWeight: 600, lineHeight: 1.5, marginBottom: 6 }}>{t("resume.afterLabel")} {b.improved}</div>
                              <Btn onClick={() => applyWeakBulletFix(b.original, b.improved)} variant="secondary" style={{ fontSize: 10, padding: "3px 8px" }}>{t("resume.applyFix")}</Btn>
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Weak action verbs */}
                      {deepInsights.weakActionVerbs?.length > 0 && (
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("resume.strongerActionVerbs")}</div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {deepInsights.weakActionVerbs.map((v, i) => (
                              <div key={i} style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 8, padding: "4px 10px", fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ color: C.red, textDecoration: "line-through" }}>{v.original}</span>
                                <span style={{ color: C.textMuted }}>→</span>
                                <span style={{ color: C.green, fontWeight: 700 }}>{v.stronger}</span>
                                <button onClick={() => applyVerbFix(v.original, v.stronger)} style={{ marginLeft: 4, background: C.green, border: "none", borderRadius: 4, color: "#fff", fontSize: 9, fontWeight: 700, padding: "2px 6px", cursor: "pointer", fontFamily: "inherit" }}>{t("resume.applyVerb")}</button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  );
                })()}
                {deepInsights && !applyingAllFixes && !insightsDone && (
                  <div style={{ textAlign: "center", paddingTop: 16, borderTop: `1px solid ${C.border}`, marginTop: 10 }}>
                    <Btn onClick={() => {
                      setInsightsDone(true);
                      document.getElementById("resume-analysis-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }} style={{ padding: "9px 22px" }}>{t("resume.doneApplying")}</Btn>
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>{t("resume.scrollToSave")}</div>
                  </div>
                )}
                {!deepInsights && !deepInsightsLoading && (
                  <div style={{ fontSize: 12, color: C.textMuted, textAlign: "center", padding: "12px 0" }}>
                    {results ? t("resume.analyzingResumeText") : t("resume.deepAnalysisDesc")}
                  </div>
                )}
              </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* SECTIONS 4 + 5 — History & Analytics: side-by-side on desktop, stacked on mobile */}
      {!isFirstTime && (
        <div className="history-analytics-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12, alignItems: "stretch" }}>

          {/* Left column: Analysis History */}
          <div style={{ display: "flex", flexDirection: "column" }}>
            {analysisHistory?.length === 0 && (
              <Card style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "4px 0" }}>
                  <span style={{ fontSize: 20 }}>📊</span>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{t("resume.noHistory")}</div>
                    <div style={{ fontSize: 12, color: C.textMuted }}>{t("resume.noHistoryDesc")}</div>
                  </div>
                </div>
              </Card>
            )}
            {analysisHistory?.length > 0 && (
              <Card style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>{t("resume.historyTitle")}</div>
                  {analysisHistory.length > 3 && (
                    <button onClick={() => setShowAllHistory(v => !v)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600, color: C.purple, padding: 0 }}>
                      {showAllHistory ? t("resume.showLessHistory") : t("resume.viewAllHistory").replace("{n}", analysisHistory.length)}
                    </button>
                  )}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  {(showAllHistory ? analysisHistory.slice(0, 15) : analysisHistory.slice(0, 3)).map((entry, i, arr) => {
                    const nextEntry = analysisHistory[i + 1];
                    const delta = (entry.atsScore != null && nextEntry?.atsScore != null) ? entry.atsScore - nextEntry.atsScore : null;
                    const hc = hubHealthColor(entry.atsScore);
                    const isOptimizedEntry = entry.resumeStatus === "Optimized";
                    const isLast = i === arr.length - 1;
                    return (
                      <div key={entry.id || i} style={{ display: "flex", gap: 0, alignItems: "stretch" }}>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 24, flexShrink: 0 }}>
                          <div style={{ width: 9, height: 9, borderRadius: "50%", background: hc, marginTop: 10, flexShrink: 0 }} />
                          {!isLast && <div style={{ flex: 1, width: 2, background: `${hc}25`, marginTop: 2 }} />}
                        </div>
                        <div style={{ flex: 1, padding: "6px 6px 6px 5px" }}>
                          <div style={{ display: "flex", justifyContent: "space-between", gap: 6, alignItems: "flex-start" }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 12, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.resumeName || t("resume.resumeFallbackName")}</div>
                              <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
                                {entry.atsScore != null && <span style={{ fontSize: 11, fontWeight: 800, color: hc }}>ATS {entry.atsScore}%</span>}
                                {delta !== null && <span style={{ fontSize: 10, fontWeight: 700, color: delta > 0 ? C.green : delta < 0 ? C.red : C.textMuted }}>({delta > 0 ? `+${delta}` : delta})</span>}
                                {isOptimizedEntry
                                  ? <span style={{ fontSize: 9, fontWeight: 700, color: C.green, background: C.greenLight, borderRadius: 4, padding: "1px 4px" }}>{t("resume.optimizedBadge")}</span>
                                  : <span style={{ fontSize: 9, color: C.textMuted, background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 4, padding: "1px 4px" }}>{t("resume.originalBadge")}</span>
                                }
                              </div>
                            </div>
                            <div style={{ textAlign: "right", flexShrink: 0 }}>
                              <div style={{ fontSize: 9, color: C.textMuted }}>{entry.date ? new Date(entry.date).toLocaleDateString() : ""}</div>
                              <div style={{ fontSize: 9, color: C.textMuted, marginTop: 1 }}>{entry.analysisType}</div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}
          </div>

          {/* Right column: Performance Analytics */}
          <div style={{ display: "flex", flexDirection: "column" }}>
            {analysisHistory?.length > 0 && (() => {
              const total = analysisHistory.length;
              const improved = analysisHistory.filter(h => h.analysisType === "Resume Improvement").length;
              const scores = analysisHistory.map(h => h.atsScore).filter(s => s != null);
              const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
              const latest = scores[0] ?? null;
              const oldest = scores[scores.length - 1] ?? null;
              const trend = latest != null && oldest != null ? latest - oldest : null;
              const healthCounts = { Excellent: 0, "Very Good": 0, Good: 0, "Needs Improvement": 0, Poor: 0 };
              analysisHistory.forEach(h => { if (h.resumeHealth && healthCounts[h.resumeHealth] != null) healthCounts[h.resumeHealth]++; });
              const trendScores = scores.slice(0, 5).reverse();
              return (
                <Card style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 8 }}>{t("resume.analyticsTitle")}</div>
                  {/* 4 stat squares in one horizontal row */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 10 }}>
                    {[
                      { label: t("resume.savesLabel"), value: total, color: C.purple },
                      { label: t("resume.improvedLabel"), value: improved, color: C.green },
                      { label: t("resume.avgAtsLabel"), value: avgScore != null ? `${avgScore}%` : "—", color: C.yellow },
                      { label: t("resume.trendLabel"), value: trend != null ? `${trend > 0 ? "+" : ""}${trend}%` : "—", color: trend != null && trend > 0 ? C.green : trend != null && trend < 0 ? C.red : C.textMuted },
                    ].map(({ label, value, color }) => (
                      <div key={label} style={{ background: C.bgSoft, borderRadius: 6, padding: "5px 2px", textAlign: "center", border: `1px solid ${C.border}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 800, color, lineHeight: 1.1 }}>{value}</div>
                        <div style={{ fontSize: 8, color: C.textMuted, lineHeight: 1.2 }}>{label}</div>
                      </div>
                    ))}
                  </div>
                  {trendScores.length > 1 && (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: C.textMid, marginBottom: 5 }}>{t("resume.atsTrend").replace("{n}", trendScores.length)}</div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        {trendScores.map((s, i) => (
                          <div key={i} style={{ display: "flex", alignItems: "center", gap: 5 }}>
                            <div style={{ fontSize: 9, color: C.textMuted, width: 14, textAlign: "right", flexShrink: 0 }}>{i + 1}</div>
                            <PBar val={s} color={hubHealthColor(s)} />
                            <div style={{ fontSize: 9, fontWeight: 700, color: hubHealthColor(s), width: 26, flexShrink: 0 }}>{s}%</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {Object.values(healthCounts).some(v => v > 0) && (
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: C.textMid, marginBottom: 5 }}>{t("resume.healthDistribution")}</div>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {Object.entries(healthCounts).filter(([, v]) => v > 0).map(([k, v]) => {
                          const hc = hubHealthColor(k === "Excellent" ? 95 : k === "Very Good" ? 85 : k === "Good" ? 75 : k === "Needs Improvement" ? 65 : 30);
                          return (
                            <div key={k} style={{ background: C.bgSoft, borderRadius: 6, padding: "3px 7px", textAlign: "center", border: `1px solid ${C.border}` }}>
                              <div style={{ fontSize: 13, fontWeight: 800, color: hc }}>{v}</div>
                              <div style={{ fontSize: 9, color: hc }}>{tStatusVal(k, t)}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </Card>
              );
            })()}
          </div>

        </div>
      )}

      {/* SECTION 6 — AI Toolkit */}
      <Card style={{ marginBottom: activeToolPanel ? 0 : 12 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 12 }}>{t("resume.aiToolkitTitle")}</div>
        <div className="hub-toolkit-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
          {[
            { icon: "📊", title: t("resume.benchmarkToolTitle"), desc: t("resume.benchmarkToolDesc"),
              active: true, panelId: "benchmark",
              action: () => {
                if (!resume.trim()) { setToolGuidancePanelId("benchmark"); setToolGuidanceMsg(t("resume.selectResumeFirst")); return; }
                setToolGuidanceMsg(""); setToolGuidancePanelId(""); setActiveToolPanel(p => p === "benchmark" ? null : "benchmark"); setTimeout(() => document.getElementById("resume-toolkit-panels")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
              },
              getStatus: () => !canUseAI ? { text: t("resume.proOnlyStatus"), color: C.purple } : benchmarkData ? { text: benchmarkData.percentileLabel || benchmarkData.overallRanking, color: C.purple } : resume.trim() ? { text: t("resume.readyToBenchmark"), color: C.textMuted } : { text: t("resume.addResumeFirst"), color: C.textMuted } },
            { icon: "🔍", title: t("resume.jobFitToolTitle"), desc: t("resume.jobFitToolDesc"),
              active: true, panelId: "jobfit",
              action: () => {
                if (!resume.trim()) { setToolGuidancePanelId("jobfit"); setToolGuidanceMsg(t("resume.selectResumeFirst")); return; }
                if (!jobDesc.trim()) { setToolGuidancePanelId("jobfit"); setToolGuidanceMsg(t("resume.addJobDescFirst")); return; }
                setToolGuidanceMsg(""); setToolGuidancePanelId(""); setActiveToolPanel(p => p === "jobfit" ? null : "jobfit"); setTimeout(() => document.getElementById("resume-toolkit-panels")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
              },
              getStatus: () => !canUseAI ? { text: t("resume.proOnlyStatus"), color: C.purple } : jobFitData ? { text: `${jobFitData.overallMatch}% match — ${jobFitData.applicationReadiness}`, color: jobFitData.overallMatch >= 75 ? C.green : jobFitData.overallMatch >= 50 ? "#d97706" : C.red } : (resume.trim() && jobDesc.trim()) ? { text: t("resume.readyToAnalyze"), color: C.textMuted } : { text: t("resume.addResumeAndJob"), color: C.textMuted } },
            { icon: "📝", title: t("resume.linkedinToolTitle"), desc: t("resume.linkedinToolDesc"),
              active: true, panelId: "linkedin-opt",
              action: () => {
                if (!resume.trim()) { setToolGuidancePanelId("linkedin-opt"); setToolGuidanceMsg(t("resume.selectResumeFirst")); return; }
                setToolGuidanceMsg(""); setToolGuidancePanelId(""); setActiveToolPanel(p => p === "linkedin-opt" ? null : "linkedin-opt"); setTimeout(() => document.getElementById("resume-toolkit-panels")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
              },
              getStatus: () => !canUseAI ? { text: t("resume.proOnlyStatus"), color: C.purple } : linkedinOptData ? { text: t("resume.linkedinOptimizedStatus").replace("{score}", linkedinOptData.completenessScore ?? "—"), color: C.green } : resume.trim() ? { text: t("resume.readyToOptimize"), color: C.textMuted } : { text: t("resume.addResumeFirst"), color: C.textMuted } },
            { icon: "🎤", title: t("resume.voiceToolTitle"), desc: t("resume.voiceToolDesc"),
              active: false, panelId: null,
              comingSoon: t("resume.voiceToolComingSoon") },
          ].map(({ icon, title, desc, active, panelId, action, getStatus, comingSoon }) => {
            const status = getStatus ? getStatus() : null;
            const isHighlighted = panelId ? activeToolPanel === panelId : false;
            return (
              <div key={title} className={active ? "toolkit-active" : ""} onClick={() => {
                if (comingSoon) { setComingSoonNotice(comingSoon); setTimeout(() => setComingSoonNotice(""), 4000); return; }
                if (!active) return;
                if (action) action();
              }} style={{ background: isHighlighted ? `${C.purple}12` : active ? C.bgSoft : `${C.bgSoft}80`, border: `1.5px solid ${isHighlighted ? C.purple + "50" : C.border}`, borderRadius: 10, padding: "12px 12px", opacity: active ? 1 : 0.6, cursor: (active || comingSoon) ? "pointer" : "default", transition: "border-color 0.15s, box-shadow 0.15s" }}>
                <div style={{ fontSize: 20, marginBottom: 6 }}>{icon}</div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 3 }}>
                  <div style={{ fontSize: 12, fontWeight: 700, color: active ? C.text : C.textMuted }}>{title}</div>
                  {active && <span style={{ fontSize: 11, color: C.purple, fontWeight: 700 }}>→</span>}
                </div>
                <div style={{ fontSize: 11, color: "#475569", fontWeight: 400, lineHeight: 1.4, marginBottom: status ? 6 : 0 }}>{desc}</div>
                {status && <div style={{ fontSize: 10, fontWeight: 600, color: status.color, marginTop: 4 }}>{status.text}</div>}
                {!active && <div style={{ fontSize: 10, color: C.purple, fontWeight: 700, marginTop: 6 }}>{t("resume.comingSoon")}</div>}
                {toolGuidancePanelId === panelId && toolGuidanceMsg && (
                  <div style={{ fontSize: 10, color: "#334155", fontWeight: 500, marginTop: 5, lineHeight: 1.35 }}>{toolGuidanceMsg}</div>
                )}
              </div>
            );
          })}
        </div>
        {comingSoonNotice && (
          <div style={{ marginTop: 10, background: C.purpleLight, border: `1px solid ${C.purple}20`, borderRadius: 9, padding: "10px 14px", fontSize: 13, color: C.purple }}>
            {comingSoonNotice}
          </div>
        )}
      </Card>

      {/* Toolkit panels */}
      <div id="resume-toolkit-panels" style={{ marginTop: activeToolPanel ? 12 : 0 }}>

        {/* Tool: Score Benchmarking */}
        {activeToolPanel === "benchmark" && (
          <Card style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>{t("resume.benchmarkPanelTitle")}</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {canUseAI && benchmarkData && <Btn onClick={runBenchmark} loading={benchmarkLoading} variant="secondary" style={{ fontSize: 11, padding: "5px 12px" }}>{t("resume.refreshBtn")}</Btn>}
                <button onClick={() => setActiveToolPanel(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: C.textMuted, lineHeight: 1, padding: "13px 14px" }}>×</button>
              </div>
            </div>
            {!canUseAI && (
              <LockedAICard title={t("resume.lockedBenchmarkTitle")} description={t("resume.lockedBenchmarkDesc")} benefits={t("resume.lockedBenchmarkBenefits")} buttonLabel={t("settings.upgradeToPro")} onUpgrade={() => onNavigate?.("pricing")} />
            )}
            {canUseAI && resume.trim() && !benchmarkData && !benchmarkLoading && (
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 20px", background: C.bgSoft, borderRadius: 12 }}>
                <div style={{ width: 18, height: 18, border: `2.5px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                <div style={{ fontSize: 13, color: C.textMuted }}>{t("resume.benchmarkPreparing")}</div>
              </div>
            )}
            {canUseAI && benchmarkError &&<div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 8, padding: "8px 12px", color: C.red, fontSize: 12 }}>{benchmarkError}</div>}
            {canUseAI && benchmarkLoading && (
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 20px", background: C.bgSoft, borderRadius: 12 }}>
                <div style={{ width: 18, height: 18, border: `2.5px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.textMid }}>{t("resume.benchmarkAnalyzing")}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{t("resume.benchmarkAnalyzingBody")}</div>
                </div>
              </div>
            )}
            {canUseAI && benchmarkData && (() => {
              const { atsScore, keywordCoverage, formattingScore, experienceScore, skillsScore, educationScore, overallRanking, recommendations } = benchmarkData;
              const rankColor = overallRanking === "Excellent" ? C.green : overallRanking === "Strong" ? C.green : overallRanking === "Above Average" ? C.yellow : overallRanking === "Average" ? C.orange : C.red;
              return (
                <>
                  {/* Your resume's own score + quality assessment -- both computed from this
                      resume's actual content, never a claim about other candidates or the
                      market (no such comparison data exists in this app). */}
                  <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
                    <div style={{ flex: 1, background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 16px", textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 900, color: hubHealthColor(atsScore), lineHeight: 1 }}>{atsScore ?? "—"}</div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: C.text, marginTop: 4 }}>{t("resume.yourScore")}</div>
                      <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>{t("resume.atsScoreSub")}</div>
                    </div>
                    <div style={{ flex: 1, background: `${rankColor}12`, border: `1.5px solid ${rankColor}30`, borderRadius: 10, padding: "10px 16px", textAlign: "center" }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: rankColor }}>{tStatusVal(overallRanking, t)}</div>
                      <div style={{ fontSize: 11, color: rankColor, marginTop: 2 }}>{t("resume.overallRanking")}</div>
                    </div>
                  </div>
                  {/* Category scores */}
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("resume.categoryBreakdown")}</div>
                    {[
                      { label: t("resume.keywordCoverageLabel"), val: keywordCoverage },
                      { label: t("resume.formatting"), val: formattingScore },
                      { label: t("resume.experienceLabel"), val: experienceScore },
                      { label: t("resume.skills"), val: skillsScore },
                      { label: t("resume.educationLabel"), val: educationScore },
                    ].map(({ label, val }) => (
                      <div key={label} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                        <div style={{ fontSize: 12, color: C.textMid, width: 130, flexShrink: 0 }}>{label}</div>
                        <PBar val={val} color={hubHealthColor(val)} />
                        <div style={{ fontSize: 12, fontWeight: 700, color: hubHealthColor(val), width: 32, flexShrink: 0 }}>{val}%</div>
                      </div>
                    ))}
                  </div>
                  {/* Recommendations */}
                  {recommendations?.length > 0 && (
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("resume.benchmarkRecommendations")}</div>
                      {recommendations.map((r, i) => (
                        <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", background: C.bgSoft, borderRadius: 9, padding: "8px 12px", marginBottom: 6 }}>
                          <span style={{ color: C.purple, fontWeight: 700, flexShrink: 0 }}>{i + 1}.</span>
                          <span style={{ fontSize: 13, color: C.text, lineHeight: 1.5 }}>{r}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}
          </Card>
        )}

        {/* Tool 7: Job Fit Analyzer */}
        {activeToolPanel === "jobfit" && (
          <Card style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>{t("resume.jobFitPanelTitle")}</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {canUseAI && jobFitData && <Btn onClick={runJobFit} loading={jobFitLoading} variant="secondary" style={{ fontSize: 11, padding: "5px 12px" }}>{t("resume.reAnalyzeBtn")}</Btn>}
                <button onClick={() => setActiveToolPanel(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: C.textMuted, lineHeight: 1, padding: "13px 14px" }}>×</button>
              </div>
            </div>
            {!canUseAI && (
              <LockedAICard title={t("resume.lockedJobFitTitle")} description={t("resume.lockedJobFitDesc")} benefits={t("resume.lockedJobFitBenefits")} buttonLabel={t("settings.upgradeToPro")} onUpgrade={() => onNavigate?.("pricing")} />
            )}
            {canUseAI && resume.trim() && jobDesc.trim() && !jobFitData && !jobFitLoading && (
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 20px", background: C.bgSoft, borderRadius: 12 }}>
                <div style={{ width: 18, height: 18, border: `2.5px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                <div style={{ fontSize: 13, color: C.textMuted }}>{t("resume.analyzingJobFit")}</div>
              </div>
            )}
            {canUseAI && jobFitError && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 8, padding: "8px 12px", color: C.red, fontSize: 12 }}>{jobFitError}</div>}
            {canUseAI && jobFitLoading && (
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 20px", background: C.bgSoft, borderRadius: 12 }}>
                <div style={{ width: 18, height: 18, border: `2.5px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.textMid }}>{t("resume.calculatingJobFit")}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{t("resume.jobFitBody")}</div>
                </div>
              </div>
            )}
            {canUseAI && jobFitData && (() => {
              const { overallMatch, matchLabel, requiredSkillsMatch, preferredSkillsMatch, missingSkills, keywordMatchScore, experienceMatch, educationMatch, seniorityMatch, applicationReadiness, topRecommendations, coverLetterTip } = jobFitData;
              const matchColor = overallMatch >= 80 ? C.green : overallMatch >= 65 ? C.yellow : overallMatch >= 50 ? C.orange : C.red;
              const readinessColor = applicationReadiness === "Ready to Apply" ? C.green : applicationReadiness === "Almost Ready" ? C.yellow : C.orange;
              return (
                <>
                  {/* Overall match */}
                  <div style={{ display: "flex", gap: 12, marginBottom: 16, alignItems: "stretch" }}>
                    <div style={{ flex: 1, background: `${matchColor}12`, border: `2px solid ${matchColor}40`, borderRadius: 12, padding: "16px", textAlign: "center" }}>
                      <div style={{ fontSize: 36, fontWeight: 900, color: matchColor, lineHeight: 1 }}>{overallMatch}%</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: matchColor, marginTop: 4 }}>{matchLabel}</div>
                      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{t("resume.overallJobFit")}</div>
                    </div>
                    <div style={{ flex: 1, background: `${readinessColor}12`, border: `1.5px solid ${readinessColor}30`, borderRadius: 12, padding: "16px", textAlign: "center" }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: readinessColor, lineHeight: 1.2 }}>{applicationReadiness}</div>
                      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>{t("resume.applicationReadinessLabel")}</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                        <div style={{ fontSize: 10, color: C.textMuted, width: 60, flexShrink: 0 }}>{t("resume.keywordsQuickLabel")}</div>
                        <PBar val={keywordMatchScore} color={hubHealthColor(keywordMatchScore)} />
                        <div style={{ fontSize: 10, fontWeight: 700, color: hubHealthColor(keywordMatchScore), width: 28, flexShrink: 0 }}>{keywordMatchScore}%</div>
                      </div>
                    </div>
                  </div>
                  {/* Skills match */}
                  {requiredSkillsMatch?.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("resume.requiredSkills")}</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {requiredSkillsMatch.map((s, i) => (
                          <div key={i} style={{ background: s.found ? C.greenLight : C.redLight, border: `1px solid ${s.found ? C.green : C.red}30`, borderRadius: 20, padding: "4px 10px", fontSize: 11, fontWeight: 600, color: s.found ? C.green : C.red }}>
                            {s.found ? "✓" : "✗"} {s.skill}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {preferredSkillsMatch?.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("resume.preferredSkills")}</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {preferredSkillsMatch.map((s, i) => (
                          <div key={i} style={{ background: s.found ? C.greenLight : C.bgSoft, border: `1px solid ${s.found ? C.green : C.border}30`, borderRadius: 20, padding: "4px 10px", fontSize: 11, color: s.found ? C.green : C.textMuted }}>
                            {s.found ? "✓" : "○"} {s.skill}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {missingSkills?.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.red, marginBottom: 8 }}>{t("resume.missingSkillsLabel")}</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {missingSkills.map((s, i) => (
                          <span key={i} style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 20, padding: "4px 10px", fontSize: 11, fontWeight: 600, color: C.red }}>✗ {s}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* Quick Wins */}
                  {missingSkills?.length > 0 && (
                    <div style={{ background: C.purpleLight, border: `1.5px solid ${C.purple}25`, borderRadius: 10, padding: "12px 16px", marginBottom: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.purple, marginBottom: 6 }}>{t("resume.quickWins")}</div>
                      <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6 }}>
                        {t("resume.quickWinsBody").replace("{skills}", missingSkills.slice(0, 2).join(" and "))} {missingSkills.length > 2 ? (missingSkills.length - 2 === 1 ? t("resume.quickWinsExtraSingular").replace("{n}", 1) : t("resume.quickWinsExtraPlural").replace("{n}", missingSkills.length - 2)) : t("resume.quickWinsExactMatch")}
                      </div>
                    </div>
                  )}
                  {/* Dimension breakdown */}
                  {[experienceMatch, educationMatch, seniorityMatch].filter(Boolean).map((dim, i) => (
                    <div key={i} style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 9, padding: "10px 14px", marginBottom: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: C.textMid }}>{[t("resume.experienceLabel"), t("resume.educationLabel"), t("resume.seniorityLabel")][i]}{t("resume.matchSuffix")}</span>
                        <span style={{ fontSize: 11, fontWeight: 700, color: hubHealthColor(dim.score) }}>{dim.score}%</span>
                        <span style={{ fontSize: 10, color: C.textMuted }}>{dim.status}</span>
                      </div>
                      <div style={{ fontSize: 12, color: C.text, lineHeight: 1.5 }}>{dim.detail}</div>
                    </div>
                  ))}
                  {/* Recommendations */}
                  {topRecommendations?.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("resume.jobFitRecommendations")}</div>
                      {topRecommendations.map((r, i) => (
                        <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", background: C.bgSoft, borderRadius: 9, padding: "8px 12px", marginBottom: 6 }}>
                          <span style={{ color: C.purple, fontWeight: 700, flexShrink: 0 }}>{i + 1}.</span>
                          <span style={{ fontSize: 13, color: C.text, lineHeight: 1.5 }}>{r}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {coverLetterTip && (
                    <div style={{ background: C.purpleLight, border: `1px solid ${C.purple}20`, borderRadius: 9, padding: "10px 14px", fontSize: 12, color: C.purple }}>
                      <span style={{ fontWeight: 700 }}>{t("resume.coverLetterTipLabel")} </span>{coverLetterTip}
                    </div>
                  )}
                </>
              );
            })()}
          </Card>
        )}

        {/* Tool 8: LinkedIn Optimizer */}
        {activeToolPanel === "linkedin-opt" && (
          <Card style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>{t("resume.linkedinPanelTitle")}</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {canUseAI && linkedinOptData && <Btn onClick={runLinkedinOpt} loading={linkedinOptLoading} variant="secondary" style={{ fontSize: 11, padding: "5px 12px" }}>{t("resume.linkedinRegenerateBtn")}</Btn>}
                <button onClick={() => setActiveToolPanel(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: C.textMuted, lineHeight: 1, padding: "13px 14px" }}>×</button>
              </div>
            </div>
            {!canUseAI && (
              <LockedAICard title={t("resume.lockedLinkedinTitle")} description={t("resume.lockedLinkedinDesc")} benefits={t("resume.lockedLinkedinBenefits")} buttonLabel={t("settings.upgradeToPro")} onUpgrade={() => onNavigate?.("pricing")} />
            )}
            {canUseAI && resume.trim() && !linkedinOptData && !linkedinOptLoading && (
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 20px", background: C.bgSoft, borderRadius: 12 }}>
                <div style={{ width: 18, height: 18, border: `2.5px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                <div style={{ fontSize: 13, color: C.textMuted }}>{t("resume.generatingLinkedin")}</div>
              </div>
            )}
            {canUseAI && linkedinOptError && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 8, padding: "8px 12px", color: C.red, fontSize: 12 }}>{linkedinOptError}</div>}
            {canUseAI && linkedinOptLoading && (
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 20px", background: C.bgSoft, borderRadius: 12 }}>
                <div style={{ width: 18, height: 18, border: `2.5px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.textMid }}>{t("resume.generatingLinkedin")}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{t("resume.linkedinOptBody")}</div>
                </div>
              </div>
            )}
            {canUseAI && linkedinOptData && (() => {
              const {
                headline, aboutSection, experienceOptimizations, recruiterVisibilityTips,
                completenessScore, keywordCoverageScore, keywordsMissing,
                strategyAnalysis, recruiterVisibilityIntelligence,
              } = linkedinOptData;
              return (
                <>
                  {/* Score strip -- deterministic (src/lib/linkedinIntelligence/deterministicScoring.js), never AI-invented */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 8, marginBottom: 16 }}>
                    {[
                      { label: t("resume.profileCompleteLabel"), val: completenessScore, color: hubHealthColor(completenessScore) },
                      { label: t("resume.keywordCoverageLabel"), val: keywordCoverageScore, color: hubHealthColor(keywordCoverageScore) },
                    ].map(({ label, val, color }) => (
                      <div key={label} style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 9, padding: "10px 8px", textAlign: "center" }}>
                        <div style={{ fontSize: 18, fontWeight: 800, color }}>{val ?? "—"}</div>
                        <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>{label}</div>
                      </div>
                    ))}
                  </div>
                  {/* Headline */}
                  {headline && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>{t("resume.optimizedHeadline")}</div>
                      <div style={{ background: C.purpleLight, border: `1.5px solid ${C.purple}25`, borderRadius: 9, padding: "10px 14px", fontSize: 13, fontWeight: 600, color: C.purple }}>
                        {headline}
                      </div>
                      <CopyBtn text={headline} label={t("resume.copyHeadline")} variant="secondary" style={{ marginTop: 6, fontSize: 11 }} />
                    </div>
                  )}
                  {/* About section */}
                  {aboutSection && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>{t("resume.optimizedAbout")}</div>
                      <div style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 9, padding: "12px 14px", fontSize: 13, color: C.text, lineHeight: 1.7, whiteSpace: "pre-line" }}>
                        {aboutSection}
                      </div>
                      <CopyBtn text={aboutSection} label={t("resume.copyAbout")} variant="secondary" style={{ marginTop: 6, fontSize: 11 }} />
                    </div>
                  )}
                  {/* Skills/keywords to add -- deterministic gap (keyword coverage's keywords_missing), never AI-improvised */}
                  {keywordsMissing?.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("resume.skillsToAdd")}</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {keywordsMissing.map((s, i) => (
                          <span key={i} style={{ background: C.purpleLight, border: `1px solid ${C.purple}25`, borderRadius: 20, padding: "4px 12px", fontSize: 11, fontWeight: 600, color: C.purple }}>+ {s}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* Experience optimizations */}
                  {experienceOptimizations?.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("resume.bulletImprovements")}</div>
                      {experienceOptimizations.map((exp, i) => (
                        <div key={i} style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 9, padding: "10px 14px", marginBottom: 8 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>{exp.title} @ {exp.company}</div>
                          {exp.optimizedBullets?.map((b, j) => (
                            <div key={j} style={{ fontSize: 12, color: C.textMid, lineHeight: 1.6, marginBottom: 4, paddingLeft: 12 }}>• {b}</div>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                  {/* Recruiter visibility tips (Free) */}
                  {recruiterVisibilityTips?.length > 0 && (
                    <div style={{ marginBottom: isPremium ? 14 : 0 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("resume.recruiterTips")}</div>
                      {recruiterVisibilityTips.map((tip, i) => (
                        <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", background: C.purpleLight, border: `1px solid ${C.purple}15`, borderRadius: 9, padding: "8px 12px", marginBottom: 6 }}>
                          <span style={{ color: C.purple, fontWeight: 700, flexShrink: 0 }}>💡</span>
                          <span style={{ fontSize: 12, color: C.text, lineHeight: 1.5 }}>{tip}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Premium: Profile Strategy Analysis -- AI prioritization over the deterministic gaps above, never a re-score */}
                  {isPremium && strategyAnalysis && (
                    <div style={{ marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("resume.linkedinStrategyHeading")}</div>
                      {strategyAnalysis.priorityActions?.map((a, i) => (
                        <div key={i} style={{ fontSize: 12, color: C.textMid, lineHeight: 1.6, marginBottom: 4, paddingLeft: 12 }}>• {a}</div>
                      ))}
                      {strategyAnalysis.reasoning && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6, fontStyle: "italic" }}>{strategyAnalysis.reasoning}</div>}
                    </div>
                  )}

                  {/* Premium: Recruiter Visibility Intelligence -- deeper than the Free tips above */}
                  {isPremium && recruiterVisibilityIntelligence && (
                    <div style={{ marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("resume.linkedinRecruiterVisibilityHeading")}</div>
                      {recruiterVisibilityIntelligence.guidance?.map((g, i) => (
                        <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", background: C.purpleLight, border: `1px solid ${C.purple}15`, borderRadius: 9, padding: "8px 12px", marginBottom: 6 }}>
                          <span style={{ color: C.purple, fontWeight: 700, flexShrink: 0 }}>🔍</span>
                          <span style={{ fontSize: 12, color: C.text, lineHeight: 1.5 }}>{g}</span>
                        </div>
                      ))}
                      {recruiterVisibilityIntelligence.searchabilityNote && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6, fontStyle: "italic" }}>{recruiterVisibilityIntelligence.searchabilityNote}</div>}
                    </div>
                  )}

                  {/* Premium: Profile Evolution Tracking -- on-demand, needs 2+ persisted analyses for this resume */}
                  {isPremium && linkedinPreviousData && (
                    <div style={{ marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{t("resume.linkedinEvolutionHeading")}</div>
                        {!linkedinEvolution && <Btn onClick={runLinkedinEvolution} loading={linkedinEvolutionLoading} variant="secondary" style={{ fontSize: 11, padding: "5px 12px" }}>{t("resume.linkedinEvolutionBtn")}</Btn>}
                      </div>
                      {linkedinEvolutionLoading && <div style={{ fontSize: 12, color: C.textMuted }}>{t("resume.linkedinEvolutionLoading")}</div>}
                      {linkedinEvolution?.narrative && (
                        <div style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 9, padding: "10px 14px" }}>
                          <div style={{ fontSize: 12, color: C.text, lineHeight: 1.6 }}>{linkedinEvolution.narrative.narrative}</div>
                          {linkedinEvolution.narrative.focusNext && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6, fontStyle: "italic" }}>{linkedinEvolution.narrative.focusNext}</div>}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Non-Premium upsell -- Free content/scores above are complete and unreduced; this only points at what Premium adds */}
                  {!isPremium && (
                    <div style={{ marginTop: 14, borderTop: `1px solid ${C.border}`, paddingTop: 12, fontSize: 12, color: C.textMuted }}>
                      {t("resume.linkedinPremiumUpsell")}
                    </div>
                  )}
                </>
              );
            })()}
            {/* Refine with LinkedIn profile text — shown after results */}
            {canUseAI && linkedinOptData && (
              <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12, marginTop: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.textMid, marginBottom: 6 }}>{t("resume.refineWithLinkedin")}</div>
                <textarea value={linkedinProfile} onChange={e => setLinkedinProfile(e.target.value)} placeholder={t("resume.linkedinProfilePlaceholder")} style={{ width: "100%", minHeight: 70, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 12, lineHeight: 1.6, padding: "8px 12px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box", marginBottom: 10 }} />
                <Btn onClick={runLinkedinOpt} loading={linkedinOptLoading} variant="secondary" style={{ fontSize: 12 }}>{t("resume.regenerateWithProfile")}</Btn>
              </div>
            )}
          </Card>
        )}

      </div>

        </div>
      )}
    </div>
  );
}

// ─── JOB SEARCH ────────────────────────────────────────────
// ISO 3166-1 alpha-2 codes end-to-end (Profile, Smart Apply, this dropdown);
// labels come from Intl.DisplayNames, not a hand-translated name table.
// "REMOTE" is a sentinel for "Remote Worldwide" — not a real ISO region.
const JS_COUNTRY_OPTIONS = ["US","CA","GB","AU","DE","FR","NL","REMOTE"];
const JS_EMPLOYMENT_OPTIONS = ["Any","Full-time","Part-time","Contract","Internship","Freelance"];
const JS_EMPLOYMENT_LABEL_KEY = { Any: "employmentAny", "Full-time": "employmentFullTime", "Part-time": "employmentPartTime", Contract: "employmentContract", Internship: "employmentInternship", Freelance: "employmentFreelance" };
const JS_EXPERIENCE_OPTIONS = ["Any","Entry Level","Mid Level","Senior","Lead","Executive"];
const JS_EXPERIENCE_LABEL_KEY = { Any: "experienceAny", "Entry Level": "experienceEntry", "Mid Level": "experienceMid", Senior: "experienceSenior", Lead: "experienceLead", Executive: "experienceExecutive" };

// Explicit candidate identity block — same pattern as the AI Resume Builder's identity
// array (see handleGenerateResume). Passed directly into the prompt so Name/Email/Phone
// are never left to the lossy getContextString() summary, which drops contact fields.
// buildIdentityBlock/buildSmartApplyPrompt/SMART_APPLY_DOC_FIELDS/validateSmartApplyPackage/
// summarizeSmartApplyIntegrity relocated (2026-08-06) to the shared
// src/lib/smartApply/generation.js -- imported above -- so Smart Apply Auto Prep's
// server-side (worker.js) preparation calls the exact same, unmodified functions as
// this manual path, per the locked blueprint's §7.

// Maps a DB smart_apply_queue row (snake_case) to the camelCase document shape
// validateSmartApplyPackage expects — reused by PackageView to re-validate on render
// and after edits, since the validator itself works on the AI-response shape.
const smartApplyDocFieldsFromRow = (item) => ({
  tailoredResume: item.tailored_resume,
  coverLetter: item.cover_letter,
  recruiterMessage: item.recruiter_message,
  networkingMessage: item.networking_message,
  missingSkills: item.missing_skills,
  applicationQuestions: item.application_questions,
  salaryInsight: item.salary_insight,
  companyInsight: item.company_insight,
});

// Job Tracker "why this changed" interpretation (AI Justification Rule):
// given already-computed deterministic facts about what changed on a
// tracked job, produce ONE short sentence on whether it matters to this
// specific user. Never asked to describe or summarize the job posting
// itself -- that would be narration, not interpretation. Fired only when a
// real change was detected (event-triggered), never on a timer or per-poll.
const buildJobTrackerChangePrompt = (facts, profile) =>
  `A job the user is tracking (a watchlist, not an application) just changed. Facts already computed -- do not restate or describe the job posting itself, only interpret significance:
${facts.join("\n")}

User's desired salary: ${profile?.desired_salary || "not set"}.

In ONE short sentence (max ~20 words), explain whether this change is meaningful for this specific user and why. If it's not meaningful, say so plainly. Return ONLY that sentence -- no JSON, no preamble, no quotes.`;

async function interpretJobTrackerChange(row, patch, profile) {
  const facts = [];
  const salaryBefore = row.salary_min || row.salary_max;
  const salaryAfter = patch.salary_min || patch.salary_max;
  if (salaryBefore !== salaryAfter && (salaryBefore || salaryAfter)) {
    facts.push(`- Salary changed from ${salaryBefore ? `$${salaryBefore}` : "unlisted"} to ${salaryAfter ? `$${salaryAfter}` : "unlisted"}.`);
  }
  if ((patch.description || "") !== (row.description || "")) facts.push("- The job's requirements/description text changed.");
  if (!facts.length) return null;
  try {
    const raw = await askClaude(buildJobTrackerChangePrompt(facts, profile), 120, "job_tracker_change");
    return raw?.trim().replace(/^"|"$/g, "").slice(0, 300) || null;
  } catch {
    return null; // interpretation is best-effort -- the change itself is still recorded without it
  }
}

const buildJobChangePrompt = (prev, curr) =>
  `Compare these two job descriptions and identify only the meaningful changes that would affect an applicant's materials (cover letter, resume, recruiter message).

PREVIOUS JOB DESCRIPTION:
${prev.slice(0, 3000)}

UPDATED JOB DESCRIPTION:
${curr.slice(0, 3000)}

Return ONLY valid JSON. Use empty arrays [] and null for unchanged categories:
{"summary":"<one sentence describing the most important change>","newSkills":["<skill added>"],"removedSkills":["<skill removed>"],"responsibilitiesChanged":"<description of responsibility changes, or null>","experienceChanged":"<description of experience requirement changes, or null>","educationChanged":"<description of education/certification changes, or null>","toolsChanged":["<tool or technology added or removed>"],"workAuthorizationChanged":"<description of work authorization changes, or null>","otherChanges":["<other meaningful change>"]}`;

// Single matchScore color function — used by JobSearchPage, OpportunityPage, and Dashboard.
// Thresholds: 80+ green (strong/excellent), 65–79 yellow (good), below 65 red (moderate/weak).
const matchScoreColor = v => v == null ? C.textMuted : v >= 80 ? C.green : v >= 65 ? C.yellow : C.red;

// The single resume control on Job Search — always exactly one of three states:
// no resume anywhere ("Add Resume" -> create/upload dialog), resumes exist but none
// active ("Select Resume" -> picker), or a resume is active (its name -> picker to change
// it). Same anchored-dropdown pattern as LanguageMenu/NotificationsMenu elsewhere in the app.
function JobSearchResumeControl({ resumes, activeResume, open, setOpen, uploading, onSelect, onCreateAI, onUploadClick }) {
  const { t } = useI18n();
  const hasResumes = (resumes || []).length > 0;
  const label = activeResume ? activeResume.name : hasResumes ? t("jobSearch.selectResumeBtn") : t("jobSearch.addResumeBtn");
  return (
    <div style={{ position: "relative" }}>
      <Btn variant={activeResume ? "green" : "secondary"} loading={uploading} onClick={() => setOpen(o => !o)}>📄 {label}</Btn>
      {open && (
        <div>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 99 }} />
          <div style={{ position: "absolute", top: "110%", right: 0, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 100, width: 280, overflow: "hidden" }}>
            {hasResumes ? (
              <>
                <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}`, fontWeight: 700, fontSize: 14, color: C.text }}>{t("jobSearch.selectResumeTitle")}</div>
                <div style={{ padding: "6px 0", maxHeight: 280, overflowY: "auto" }}>
                  {resumes.map(r => (
                    <button key={r.id} onClick={() => { onSelect(r.id); setOpen(false); }} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "9px 16px", border: "none", background: activeResume?.id === r.id ? C.bgSoft : "#fff", cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}>
                      <span style={{ fontSize: 14, color: C.text, fontWeight: 600, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.name}{r.is_default && <span style={{ marginLeft: 6, fontSize: 10, color: C.purple, fontWeight: 700 }}>{t("jobSearch.defaultBadge")}</span>}
                      </span>
                      {activeResume?.id === r.id && <span style={{ color: C.purple, fontWeight: 700, flexShrink: 0 }}>✓</span>}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <div style={{ padding: 16, display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 2 }}>{t("jobSearch.addResumeTitle")}</div>
                <Btn onClick={() => { setOpen(false); onCreateAI(); }} style={{ justifyContent: "center" }}>✨ {t("jobSearch.createAiResumeBtn")}</Btn>
                <Btn variant="secondary" onClick={() => { setOpen(false); onUploadClick(); }} style={{ justifyContent: "center" }}>📤 {t("jobSearch.uploadResumeBtn")}</Btn>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Reusable locked-feature card for Job Search's richer, in-context Pro upsell.
// No existing shared component covers this shape (searched: OutcomeIntelligencePanel's
// and ReferralIntelligencePanel.jsx's premium gates are single-sentence, no benefits
// list, no featured variant) -- kept local to this file section since Job Search is
// its only consumer today, per "keep the component localized." All copy is passed in
// as already-translated strings, matching every other component in this file.
function LockedAICard({ icon = "🔒", title, description, benefits, buttonLabel, onUpgrade, featured = false }) {
  return (
    <div style={{
      background: "#fff",
      border: featured ? `2px solid ${C.purple}` : `1.5px solid ${C.purple}22`,
      borderRadius: 14,
      padding: "18px 20px",
      marginBottom: 10,
      boxShadow: featured ? "0 2px 12px rgba(107,33,232,0.08)" : "none",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 15 }}>{icon}</span>
        <span style={{ fontSize: 14.5, fontWeight: 800, color: C.text }}>{title}</span>
      </div>
      <div style={{ fontSize: 13, color: C.textMid, marginBottom: 10 }}>{description}</div>
      <ul style={{ listStyle: "none", margin: "0 0 14px", padding: 0, display: "grid", gap: 5 }}>
        {(benefits || []).map((b, i) => (
          <li key={i} style={{ fontSize: 12.5, color: C.textMid, display: "flex", gap: 7, alignItems: "flex-start" }}>
            <span style={{ color: C.purple, fontWeight: 800, flexShrink: 0 }}>✓</span>{b}
          </li>
        ))}
      </ul>
      <Btn onClick={onUpgrade} style={{ width: "100%" }}>{buttonLabel}</Btn>
    </div>
  );
}

function JobSearchPage({ savedJobs, setSavedJobs, applications, profile, resumes, onQueueChange, queue, enqueue, markReady, markNeedsReview, markFailed, purgeQueueByJobId, onNavigate, billingState, activeResumeId, onResumeLoad, saveResume, onNavigateResume, jobWatchlist, companyWatchlist }) {
  const { t, language } = useI18n();
  const [filters, setFilters] = useSessionState("cp_jobs_filters", { title: profile?.preferred_job_title || "", keywords: "", country: "US", city: profile?.location || "", remote: profile?.work_type === "Remote", employmentType: "Any", experienceLevel: "Any", salaryMin: "" });
  const [jobs, setJobs] = useSessionState("cp_jobs_results", []); const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [searched, setSearched] = useSessionState("cp_jobs_searched", false); const [page, setPage] = useSessionState("cp_jobs_page", 1); const [hasMore, setHasMore] = useSessionState("cp_jobs_hasmore", false); const [sourceCounts, setSourceCounts] = useSessionState("cp_jobs_sourcecounts", null);
  // Vendor split (Adzuna/JSearch) stays tracked for internal diagnostics only --
  // job seekers don't need provider names, so this no longer renders anywhere.
  useEffect(() => { if (sourceCounts) console.debug("[JobSearch] source split", sourceCounts); }, [sourceCounts]);
  // Active resume is derived from the single shared source of truth (resumes + activeResumeId,
  // both owned at the root and shared with Dashboard/SavedJobs/Resume pages) rather than a
  // separate local copy — this is what keeps every screen in sync automatically.
  const activeResume = useMemo(() => (resumes || []).find(r => r.id === activeResumeId) || null, [resumes, activeResumeId]);
  const resumeText = activeResume?.content || "";
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const resumeFileRef = useRef();
  const [uploadingResume, setUploadingResume] = useState(false);
  const [smartApplying, setSmartApplying] = useState(null);
  const userContext = useUserContext({ profile, applications, savedJobs });
  // Job Details expansion — same Set-based toggle pattern as SavedJobsPage's
  // expandedJobs/toggleJobExpanded (App.jsx ~10276), reused rather than a new pattern.
  const [expandedJobs, setExpandedJobs] = useState(new Set());
  const toggleJobExpanded = (jobId) => {
    setExpandedJobs(prev => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId); else next.add(jobId);
      return next;
    });
  };
  // Client-side-only signal for whether Smart Apply should attempt its real request.
  // Mirrors the exact billingState -> plan string the server's canUseAI already gates
  // on (worker.js getCapabilities) -- this does not duplicate or alter entitlement
  // logic, it just reads the same computed value to avoid firing a request the
  // server would reject anyway. Real enforcement stays server-side, unchanged.
  const bs = billingState?.billingState || "FREE";
  const canUseAI = !["FREE", "PRO_EXPIRED"].includes(bs);
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" ? window.matchMedia("(max-width: 767px)").matches : false);
  const [isTablet, setIsTablet] = useState(() => typeof window !== "undefined" ? window.matchMedia("(min-width: 768px) and (max-width: 1024px)").matches : false);
  // ── Job Intelligence features ────────────────────────────────────────────
  // Default is "match" (highest AI Match Score first) so ranked results are
  // trustworthy on first view; "relevance" (raw API order) stays selectable.
  const [sortBy, setSortBy] = useSessionState("cp_jobs_sort", "match");
  const [hideDupes, setHideDupes] = useSessionState("cp_jobs_hide_dupes", false);
  const [recentSearches, setRecentSearches] = useStorage("cp_recent_searches", []);
  const [lastVisit, setLastVisit] = useStorage("cp_jobs_last_visit", null);
  const prevVisitRef = useRef(lastVisit);
  const isSmartApplied = (job) => queue.some(q => q.job_id === job.id && (q.status === "queued" || q.status === "ready" || q.status === "needs_review"));
  // Job Tracker (watchlist), fully independent of applications/smart_apply_queue —
  // see the Explicit Non-Behavior Checklist in the Job Tracker blueprints.
  const isTracked = (job) => (jobWatchlist?.watchlist || []).some(w => w.job_id === job.id);
  const [trackToast, setTrackToast] = useState(null); // { message, undo } | null
  const trackToastTimer = useRef(null);
  const [hasSeenTrackIntro, setHasSeenTrackIntro] = useStorage("cp_seen_track_intro", false);
  const [showTrackIntro, setShowTrackIntro] = useState(false);
  const toggleTrack = async (job) => {
    if (!jobWatchlist) return;
    const existing = (jobWatchlist.watchlist || []).find(w => w.job_id === job.id);
    if (existing) { await jobWatchlist.remove(existing.id); return; }
    const row = await jobWatchlist.add(job);
    if (trackToastTimer.current) clearTimeout(trackToastTimer.current);
    setTrackToast({ message: t("jobSearch.trackToast").replace("{company}", job.company), undoId: row?.id });
    // 8s gives enough time to read the message, register "no application created",
    // and decide between Undo / View Job Tracker before it auto-dismisses.
    trackToastTimer.current = setTimeout(() => setTrackToast(null), 8000);
    if (!hasSeenTrackIntro) { setShowTrackIntro(true); setHasSeenTrackIntro(true); }
  };
  const undoTrack = async () => {
    if (trackToast?.undoId) await jobWatchlist.remove(trackToast.undoId);
    setTrackToast(null);
  };
  // Same match key as isTracked, narrowed to a genuine successful application
  // (status "Applied", written by SavedJobsPage's handleMarkApplied) so a job
  // already applied to never lingers in fresh search results.
  const isApplied = (job) => applications.some(a => a.jobTitle === job.title && a.company === job.company && a.status === "Applied");

  // Detect same title+company appearing from multiple sources
  const dupeSet = useMemo(() => {
    const seen = {};
    const dupes = new Set();
    jobs.forEach(job => {
      const key = `${(job.company || "").toLowerCase().trim()}|${(job.title || "").toLowerCase().trim().replace(/\s+/g, " ")}`;
      if (seen[key] !== undefined) dupes.add(job.id);
      else seen[key] = job.id;
    });
    return dupes;
  }, [jobs]);

  // Career Compatibility Engine — deterministic, zero-LLM-call Match % scoring.
  // Replaces the old AI Match Claude call entirely. The skill synonym dictionary
  // is Supabase-backed but fetched exactly once per session (see skillSynonyms.js),
  // never per job/search, so scoring itself stays fully synchronous and free.
  const [skillDictionary, setSkillDictionary] = useState({});
  useEffect(() => { loadSkillSynonyms().then(setSkillDictionary); }, []);

  const resumeSkills = useMemo(() => extractSkillKeywords(resumeText), [resumeText]);

  const compatibilityByJobId = useMemo(() => {
    if (!resumeText.trim()) return {};
    const out = {};
    for (const job of jobs) {
      out[job.id] = buildCompatibilityRecord({ job, profile, resumeSkills, skillDictionary });
    }
    return out;
  }, [jobs, resumeText, resumeSkills, profile, skillDictionary]);

  // Sort + dedup derived list — never mutates raw `jobs` session state.
  // Successfully-applied jobs are always excluded (not just when hideDupes is
  // on) so Job Search only ever shows new opportunities and re-applying to
  // the same listing is never possible from here.
  const displayJobs = useMemo(() => {
    let result = jobs.filter(j => !isApplied(j));
    if (hideDupes) result = result.filter(j => !dupeSet.has(j.id));
    if (sortBy === "match") {
      result = [...result].sort((a, b) => {
        const sa = compatibilityByJobId[a.id]?.match_score ?? a.matchScore ?? 0;
        const sb = compatibilityByJobId[b.id]?.match_score ?? b.matchScore ?? 0;
        return sb - sa;
      });
    } else if (sortBy === "date") {
      result = [...result].sort((a, b) => new Date(b.datePosted || 0) - new Date(a.datePosted || 0));
    }
    return result;
  }, [jobs, hideDupes, sortBy, compatibilityByJobId, dupeSet, applications]);

  const isNewJob = (job) => !!(prevVisitRef.current && job.datePosted && new Date(job.datePosted) > new Date(prevVisitRef.current));

  // Auto-activate the default saved resume the first time resumes arrive, but only if
  // no resume is active yet anywhere in the app (activeResumeId is the shared source of
  // truth, so this also benefits Dashboard/SavedJobs if Job Search happens to load first).
  useEffect(() => {
    if (activeResumeId) return;
    if (!resumes || resumes.length === 0) return;
    const def = resumes.find(r => r.is_default) || resumes[0];
    if (def) onResumeLoad?.(def.id);
  }, [resumes, activeResumeId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Back-fill: when fresh Compatibility Engine scores are computed, write them to any
  // already-saved jobs whose score is absent or has changed. Fires on every new search
  // so re-scores from updated job descriptions propagate to Dashboard / SavedJobs /
  // Opportunity Intelligence. No Claude call involved -- compatibilityByJobId is
  // synchronous, so this simply mirrors it onto the persisted savedJobs list.
  useEffect(() => {
    const keys = Object.keys(compatibilityByJobId);
    if (!keys.length) return;
    setSavedJobs(prev => {
      let changed = false;
      const next = prev.map(j => {
        const cr = compatibilityByJobId[j.job_id];
        if (cr && cr.match_score != null && cr.match_score !== j.matchScore) {
          changed = true;
          return { ...j, matchScore: cr.match_score, compatibilityBreakdown: cr };
        }
        return j;
      });
      return changed ? next : prev;
    });
  }, [compatibilityByJobId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const tq = window.matchMedia("(min-width: 768px) and (max-width: 1024px)");
    const onMq = e => setIsMobile(e.matches);
    const onTq = e => setIsTablet(e.matches);
    mq.addEventListener("change", onMq);
    tq.addEventListener("change", onTq);
    return () => { mq.removeEventListener("change", onMq); tq.removeEventListener("change", onTq); };
  }, []);

  // Record this visit so next session can badge "new since last visit"
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setLastVisit(new Date().toISOString()); }, []);

  // Shared extraction core — accepts a File object, extracts its text, persists it as a
  // proper entry in the shared resume library (saveResume), and activates it immediately
  // via the shared activeResumeId so every screen reflects it with no extra step.
  const extractResumeFile = async (file) => {
    if (!file) return;
    const ext = file.name.split(".").pop().toLowerCase();
    if (file.size > 5 * 1024 * 1024) { setError(t("jobSearch.fileTooLarge")); return; }
    setError(""); setUploadingResume(true);
    try {
      let text = "";
      if (ext === "pdf") {
        if (!window.pdfjsLib) {
          await new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
            s.onload = resolve; s.onerror = reject;
            document.head.appendChild(s);
          });
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        }
        const buf = await file.arrayBuffer();
        const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
        for (let i = 1; i <= pdf.numPages; i++) {
          const pageObj = await pdf.getPage(i);
          const content = await pageObj.getTextContent();
          text += content.items.map(it => it.str).join(" ") + "\n";
        }
        text = text.trim();
        if (!text) { setError(t("jobSearch.pdfExtractFailed")); return; }
      } else if (ext === "docx" || ext === "doc" || ext === "txt") {
        const raw = await file.text();
        text = (ext === "docx" || ext === "doc") ? String(raw).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : raw.trim();
        if (!text) { setError(t("jobSearch.fileReadFailed")); return; }
      } else {
        setError(t("jobSearch.unsupportedFileType"));
        return;
      }
      const saved = await saveResume(file.name, text, file);
      onResumeLoad?.(saved.id);
    } catch (err) {
      setError(t("jobSearch.fileReadFailedGeneric"));
    } finally {
      setUploadingResume(false);
    }
  };

  const handleResumeUpload = async (e) => {
    const file = e.target.files[0];
    await extractResumeFile(file);
    e.target.value = "";
  };

  const search = async (loadMore = false) => {
    if (!filters.title.trim()) { setError(t("jobSearch.enterTitlePrompt")); return; }
    setError("");
    setLoading(true);
    const nextPage = loadMore ? page + 1 : 1;
    if (!loadMore) { setJobs([]); setSearched(true); setPage(1); setSourceCounts(null); }

    try {
      const data = await workerBillingPost("/api/jobs", {
        title: filters.title.trim(),
        keywords: filters.keywords?.trim() || "",
        country: filters.country,
        city: filters.city.trim(),
        remote: filters.remote,
        employmentType: filters.employmentType,
        experienceLevel: filters.experienceLevel,
        salaryMin: filters.salaryMin,
        page: nextPage,
      });
      const newJobs = data.jobs || [];

      setJobs(prev => loadMore ? [...prev, ...newJobs] : newJobs);
      setPage(nextPage);
      setHasMore(newJobs.length >= 10); // if we got results, there may be more
      if (data.sources) setSourceCounts(data.sources);

      // Track recent searches (last 8 unique titles)
      if (!loadMore && filters.title.trim()) {
        setRecentSearches(prev => {
          const entry = { title: filters.title.trim(), city: filters.city.trim(), ts: Date.now() };
          const deduped = prev.filter(r => r.title.toLowerCase() !== filters.title.trim().toLowerCase());
          return [entry, ...deduped].slice(0, 8);
        });
      }

      // Sync saved job data from fresh API results — Match % itself is computed
      // synchronously by the Career Compatibility Engine (compatibilityByJobId),
      // no Claude call and no explicit trigger needed here.
      if (newJobs.length > 0) { syncSavedJobData(newJobs); syncJobTrackerData(newJobs); }
    } catch (e) {
      setError(t("jobSearch.searchFailed").replace("{message}", e.message));
    } finally {
      setLoading(false);
    }
  };

  // Smart Apply: AI prepares a full application package (tailored resume, cover
  // letter, recruiter/networking messages, fit probabilities, likely application
  // questions) and queues it for review — the user still clicks the real "Apply
  // Now" link themselves, this just does the prep work.
  const smartApply = async (job) => {
    if (!resumeText.trim()) { setResumeDialogOpen(true); return; }
    if (!profile?.id) { setError(t("jobSearch.signInForSmartApply")); return; }
    const _cr = compatibilityByJobId[job.id];
    const _enriched = _cr ? { ...job, matchScore: _cr.match_score, compatibilityBreakdown: _cr } : job;
    setSavedJobs(p => p.some(j => j.job_id === job.id) ? p : [{ job_id: job.id, ..._enriched, saved_at: new Date().toISOString() }, ...p]);
    setSmartApplying(job.id);
    let queued;
    // TEMPORARY FORENSIC INSTRUMENTATION — remove after diagnosis, no business logic changed.
    let _stage = "start";
    let _raw = null;
    let _cleanRaw = null;
    let _braceStart = null, _braceEnd = null;
    let _integrity = null;
    try {
      console.log(`[SmartApply] ⏳ [1/6] Enqueueing "${job.title}" at ${job.company} (job_id: ${job.id})`);
      _stage = "enqueue";
      queued = await enqueue(profile.id, job, activeResumeId);
      if (!queued) {
        console.log(`[SmartApply] ⏭️ [1/6] Skipped "${job.title}" — already queued/ready`);
        return; // existing queued/ready row — no generation needed
      }
      console.log(`[SmartApply] ✅ [1/6] Enqueued: queue_id=${queued.id}, status=${queued.status}`);
      console.log(`[FORENSIC] job_id=${job.id} queue_id=${queued.id} — Queue row created`);

      console.log(`[SmartApply] ⏳ [2/6] Building context for "${job.title}"`);
      const ctx = userContext.getContextString({ identity: true, applications: true });
      console.log(`[SmartApply] ✅ [2/6] Context ready: ${ctx.length} chars`);

      console.log(`[SmartApply] ⏳ [3/6] Calling Claude API for "${job.title}" (max 8000 tokens)`);
      _stage = "before_anthropic_request";
      console.log(`[FORENSIC] job_id=${job.id} queue_id=${queued.id} — Before Anthropic request`);
      _raw = await askClaude(buildSmartApplyPrompt(ctx, resumeText, job, profile), 8000);
      _stage = "after_anthropic_response";
      console.log(`[SmartApply] ✅ [3/6] Claude responded: ${_raw.length} chars`);
      console.log(`[FORENSIC] job_id=${job.id} queue_id=${queued.id} — After Anthropic response. length=${_raw.length} first500=${JSON.stringify(_raw.slice(0, 500))}`);

      console.log(`[SmartApply] ⏳ [4/6] Parsing JSON for "${job.title}"`);
      _stage = "before_json_parse";
      _braceStart = _raw.indexOf("{"); _braceEnd = _raw.lastIndexOf("}");
      _cleanRaw = (_braceStart >= 0 && _braceEnd > _braceStart) ? _raw.slice(_braceStart, _braceEnd + 1) : _raw;
      console.log(`[FORENSIC] job_id=${job.id} queue_id=${queued.id} — Before JSON.parse. braceStart=${_braceStart} braceEnd=${_braceEnd} extractedLength=${_cleanRaw.length}`);
      const result = JSON.parse(_cleanRaw);
      _stage = "after_json_parse";
      console.log(`[SmartApply] ✅ [4/6] JSON parsed. Keys: ${Object.keys(result).join(", ")}`);
      console.log(`[FORENSIC] job_id=${job.id} queue_id=${queued.id} — After JSON.parse succeeded`);

      console.log(`[SmartApply] ⏳ [5/6] Validating package integrity for "${job.title}"`);
      _integrity = validateSmartApplyPackage(result, resolveCountry(filters.country !== "REMOTE" ? filters.country : undefined, profile?.country));
      _stage = "after_validation";
      console.log(`[SmartApply] ✅ [5/6] Integrity check: ${_integrity.ok ? "passed" : "FAILED — " + summarizeSmartApplyIntegrity(_integrity)}`);
      console.log(`[FORENSIC] job_id=${job.id} queue_id=${queued.id} — After validateSmartApplyPackage. ok=${_integrity.ok}`);

      console.log(`[SmartApply] ⏳ [6/6] Saving to Supabase (queue_id: ${queued.id})`);
      if (_integrity.ok) {
        _stage = "before_markReady";
        console.log(`[FORENSIC] job_id=${job.id} queue_id=${queued.id} — Before markReady()`);
        await markReady(queued.id, result);
        console.log(`[SmartApply] ✅ [6/6] Package saved — status: ready ✓`);
      } else {
        _stage = "before_markNeedsReview";
        console.log(`[FORENSIC] job_id=${job.id} queue_id=${queued.id} — Before markNeedsReview()`);
        await markNeedsReview(queued.id, result);
        console.log(`[SmartApply] ⚠️ [6/6] Package saved — status: needs_review`);
      }
    } catch (e) {
      console.error(`[FORENSIC] ===================== CATCH BLOCK (manual smartApply) =====================`);
      console.error(`[FORENSIC] job_id=${job.id}`);
      console.error(`[FORENSIC] queue_id=${queued?.id || "(none — failure occurred before/during enqueue)"}`);
      console.error(`[FORENSIC] stage_reached=${_stage}`);
      console.error(`[FORENSIC] exception.message=${e?.message}`);
      console.error(`[FORENSIC] exception.stack=${e?.stack}`);
      console.error(`[FORENSIC] exception.code=${e?.code}`);
      console.error(`[FORENSIC] exception.status=${e?.status}`);
      console.error(`[FORENSIC] response_length=${_raw != null ? _raw.length : "N/A — no response received"}`);
      console.error(`[FORENSIC] response_first_500=${_raw != null ? JSON.stringify(_raw.slice(0, 500)) : "N/A"}`);
      console.error(`[FORENSIC] brace_indices=start:${_braceStart} end:${_braceEnd}`);
      console.error(`[FORENSIC] validation_result=${_integrity ? JSON.stringify(_integrity) : "N/A — not reached"}`);
      console.error(`[SmartApply] ❌ MANUAL failed for "${job.title}":`, e?.code, e?.message, e);
      if (queued) {
        _stage = "before_markFailed";
        console.log(`[FORENSIC] job_id=${job.id} queue_id=${queued.id} — Before markFailed()`);
        await markFailed(queued.id, queued.retry_count);
        console.log(`[FORENSIC] job_id=${job.id} queue_id=${queued.id} — markFailed executed. Final status: failed`);
      }
      const isRls = e?.code === "42501" || e?.message?.includes("row-level security");
      setError(isRls ? t("jobSearch.signInForSmartApply") : t("jobSearch.smartApplyFailed"));
    } finally {
      setSmartApplying(null);
      onQueueChange?.(); // keep root-level queue and Dashboard in sync
    }
  };

  // Free-tier gate for the Smart Apply button. The server already rejects this
  // request safely with zero Claude cost (verified: worker.js handleClaude's
  // entitlement check runs before the Anthropic fetch) -- this exists purely so
  // a Free user's click never fires a request that's going to be rejected, and
  // never sees the resulting generic failure message. Paid users are completely
  // unaffected: canUseAI is true, so this falls straight through to smartApply.
  const handleSmartApplyClick = (job) => {
    if (!canUseAI) { toggleJobExpanded(job.id); return; }
    smartApply(job);
  };

  // Sync lightweight employer/job fields for any saved job that appears in fresh search results.
  // Called after every successful search — initial and load-more.
  // Captures the previous description before overwriting so Employer Change Intelligence
  // (next phase) can detect meaningful changes without additional API calls.
  // Never touches any AI package field — those live in smart_apply_queue, not saved_jobs.
  const syncSavedJobData = (freshJobs) => {
    const freshById = new Map(freshJobs.map(j => [j.id, j]));
    setSavedJobs(prev => {
      let changed = false;
      const now = new Date().toISOString();
      const next = prev.map(saved => {
        const fresh = freshById.get(saved.job_id);
        if (!fresh) return saved;

        const descriptionChanged = (fresh.description || "") !== (saved.description || "");
        const fieldsChanged =
          fresh.title !== saved.title ||
          fresh.company !== saved.company ||
          (fresh.location || "") !== (saved.location || "") ||
          (fresh.salaryMin ?? null) !== saved.salaryMin ||
          (fresh.salaryMax ?? null) !== saved.salaryMax ||
          (fresh.employmentType || "") !== (saved.employmentType || "") ||
          !!fresh.remote !== !!saved.remote ||
          descriptionChanged ||
          (fresh.applyUrl || "") !== (saved.applyUrl || "") ||
          (fresh.datePosted || "") !== (saved.datePosted || "");

        if (!fieldsChanged) return saved;
        changed = true;

        return {
          ...saved,
          title: fresh.title,
          company: fresh.company,
          location: fresh.location || "",
          salaryMin: fresh.salaryMin ?? null,
          salaryMax: fresh.salaryMax ?? null,
          employmentType: fresh.employmentType || "",
          remote: !!fresh.remote,
          description: fresh.description || "",
          applyUrl: fresh.applyUrl || "",
          datePosted: fresh.datePosted || "",
          previous_description: descriptionChanged ? (saved.description || "") : saved.previous_description,
          last_synced_at: now,
        };
      });
      return changed ? next : prev;
    });
  };

  // Job Tracker change detection — passive, fires only when a fresh search
  // happens to resurface a tracked job/company, the same honest scope as
  // Employer Change Intelligence above (no scheduled backend polling exists
  // yet — see Job Tracker Blueprint §8/§12). Never touches saved_jobs,
  // applications, or smart_apply_queue.
  const syncJobTrackerData = async (freshJobs) => {
    if (!jobWatchlist) return;
    const freshById = new Map(freshJobs.map(j => [j.id, j]));

    for (const row of jobWatchlist.watchlist || []) {
      const fresh = freshById.get(row.job_id);
      if (!fresh) continue;
      const salaryChanged = (fresh.salaryMin ?? null) !== row.salary_min || (fresh.salaryMax ?? null) !== row.salary_max;
      const descriptionChanged = (fresh.description || "") !== (row.description || "");
      if (!salaryChanged && !descriptionChanged) continue;

      const salaryIncreased = salaryChanged && ((fresh.salaryMax ?? fresh.salaryMin ?? 0) > (row.salary_max ?? row.salary_min ?? 0));
      const patch = {
        salary_min: fresh.salaryMin ?? null,
        salary_max: fresh.salaryMax ?? null,
        description: fresh.description || "",
        previous_salary_min: salaryChanged ? row.salary_min : row.previous_salary_min,
        previous_salary_max: salaryChanged ? row.salary_max : row.previous_salary_max,
        previous_description: descriptionChanged ? row.description : row.previous_description,
        has_unread_change: true,
      };
      const summary = await interpretJobTrackerChange(row, patch, profile);
      if (summary) patch.ai_change_summary = summary;
      await jobWatchlist.applyChange(row.id, patch);
      if (salaryIncreased) {
        insertNotification(profile?.id, { type: "job_tracker", title: t("jobSearch.notifySalaryTitle").replace("{title}", row.job_title), body: t("jobSearch.notifySalaryBody").replace("{company}", row.company), linkPage: "jobtracker" });
      }
    }

    if (!companyWatchlist) return;
    for (const company of companyWatchlist.watchlist || []) {
      const matches = freshJobs.filter(j => (j.company || "").toLowerCase() === (company.company_name || "").toLowerCase());
      if (!matches.length) continue;
      let best = company.best_seen_match ?? null;
      for (const job of matches) {
        const cr = resumeText.trim() ? buildCompatibilityRecord({ job, profile, resumeSkills, skillDictionary }) : null;
        if (cr?.match_score != null && (best == null || cr.match_score > best)) best = cr.match_score;
      }
      if (best != null && best !== company.best_seen_match) {
        const meaningfullyBetter = company.best_seen_match == null || best >= company.best_seen_match + 10;
        await companyWatchlist.updateBestSeenMatch(company.id, best);
        if (meaningfullyBetter) {
          insertNotification(profile?.id, { type: "job_tracker", title: t("jobSearch.notifyBetterMatchTitle").replace("{company}", company.company_name), body: t("jobSearch.notifyBetterMatchBody").replace("{score}", best), linkPage: "jobtracker" });
        }
      }
    }
  };

  const toggleSave = (job) => {
    const s = savedJobs.find(j => j.job_id === job.id);
    if (s) {
      setSavedJobs(p => p.filter(j => j.job_id !== job.id));
      purgeQueueByJobId(job.id);
    } else {
      // Merge in the Compatibility Engine score already computed this session so it persists to the DB.
      const cr = compatibilityByJobId[job.id];
      const enriched = cr ? { ...job, matchScore: cr.match_score, compatibilityBreakdown: cr } : job;
      setSavedJobs(p => [{ job_id: job.id, ...enriched, saved_at: new Date().toISOString() }, ...p]);
    }
  };
  const isSaved = (id) => savedJobs.some(j => j.job_id === id);
  const fmtSalary = (min, max) => { if (!min && !max) return t("jobSearch.salaryNotListed"); const f = n => `$${Math.round(n/1000)}K`; if (min && max) return `${f(min)} – ${f(max)}`; return min ? `${f(min)}+` : t("jobSearch.upTo").replace("{v}", f(max)); };

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 6 }}>{t("jobSearch.heading")}</h1>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24 }}>{t("jobSearch.subtitle")}</p>
      {!activeResume && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.purpleLight, border: `1px solid ${C.purple}20`, borderRadius: 10, padding: "10px 16px", marginBottom: 20, fontSize: 13, color: C.text, fontWeight: 500 }}>
          <span style={{ fontSize: 16 }}>✨</span>
          <span>{t("jobSearch.aiUnlockGuidance")}</span>
        </div>
      )}
      {/* First-click Job Tracker intro — shown automatically once, then never again.
          No modal, no "don't show again" checkbox, per the Job Tracker UX blueprint. */}
      {showTrackIntro && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, background: C.purpleLight, border: `1px solid ${C.purple}20`, borderRadius: 10, padding: "10px 16px", marginBottom: 20, fontSize: 13, color: C.text, fontWeight: 500 }}>
          <span style={{ fontSize: 16 }}>👁️</span>
          <span style={{ flex: 1 }}>{t("jobSearch.trackIntro")}</span>
          <Btn variant="ghost" style={{ fontSize: 12, padding: "4px 10px", flexShrink: 0 }} onClick={() => onNavigate?.("jobtracker")}>{t("jobSearch.trackIntroViewLink")}</Btn>
          <button onClick={() => setShowTrackIntro(false)} style={{ border: "none", background: "none", color: C.textMuted, cursor: "pointer", fontSize: 16, padding: 0, lineHeight: 1, flexShrink: 0 }}>✕</button>
        </div>
      )}
      {/* Post-track confirmation toast — instant, local, reversible; never a navigation.
          Fixed-position (bottom-right desktop, bottom-center mobile) so it stays visible
          regardless of scroll position within the results list. Mobile gets a bolder
          presentation (badge icon, stronger shadow, overshoot entrance) since that's
          where it's easiest to miss right after a tap. */}
      {trackToast && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: isMobile ? "calc(20px + env(safe-area-inset-bottom, 0px))" : 24, display: "flex", justifyContent: isMobile ? "center" : "flex-end", padding: isMobile ? "0 16px" : "0 24px", zIndex: 60, pointerEvents: "none" }}>
          <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 12 : 10, background: C.greenLight, border: `1px solid ${C.green}30`, borderLeft: isMobile ? `4px solid ${C.green}` : `1px solid ${C.green}30`, borderRadius: 10, padding: isMobile ? "14px 16px" : "10px 16px", fontSize: isMobile ? 14 : 13, color: C.text, fontWeight: 500, maxWidth: isMobile ? "calc(100vw - 32px)" : 420, boxShadow: isMobile ? "0 12px 32px rgba(0,0,0,0.22)" : "0 8px 24px rgba(0,0,0,0.15)", pointerEvents: "auto", animation: isMobile ? "cp-toast-in-mobile 0.35s ease-out" : "cp-toast-in 0.25s ease-out" }}>
            {isMobile ? (
              <span style={{ width: 24, height: 24, borderRadius: "50%", background: C.green, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, flexShrink: 0 }}>✓</span>
            ) : (
              <span style={{ fontSize: 16 }}>✓</span>
            )}
            <span style={{ flex: 1 }}>{trackToast.message}</span>
            <Btn variant="ghost" style={{ fontSize: 12, padding: "4px 10px", flexShrink: 0 }} onClick={undoTrack}>{t("jobSearch.undo")}</Btn>
            <Btn variant="ghost" style={{ fontSize: 12, padding: "4px 10px", flexShrink: 0 }} onClick={() => onNavigate?.("jobtracker")}>{t("jobSearch.trackIntroViewLink")}</Btn>
          </div>
        </div>
      )}
      <Card style={{ marginBottom: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 14 }} className="three-col">
          <Input label={t("jobSearch.jobTitleLabel")} placeholder={t("jobSearch.jobTitlePlaceholder")} value={filters.title} onChange={e => setFilters(f => ({ ...f, title: e.target.value }))} onKeyDown={e => e.key === "Enter" && search()} />
          <Input label={t("jobSearch.keywordsLabel")} placeholder={t("jobSearch.keywordsPlaceholder")} value={filters.keywords || ""} onChange={e => setFilters(f => ({ ...f, keywords: e.target.value }))} onKeyDown={e => e.key === "Enter" && search()} />
          <Select label={t("jobSearch.countryLabel")} value={filters.country} onChange={e => setFilters(f => ({ ...f, country: e.target.value }))}>
            {JS_COUNTRY_OPTIONS.map(c => <option key={c} value={c}>{c === "REMOTE" ? t("jobSearch.countryRemoteWorldwide") : new Intl.DisplayNames([language], { type: "region" }).of(c)}</option>)}
          </Select>
          <Input label={t("jobSearch.cityLabel")} placeholder={t("jobSearch.cityPlaceholder")} value={filters.city} onChange={e => setFilters(f => ({ ...f, city: e.target.value }))} />
          <Select label={t("jobSearch.employmentTypeLabel")} value={filters.employmentType} onChange={e => setFilters(f => ({ ...f, employmentType: e.target.value }))}>
            {JS_EMPLOYMENT_OPTIONS.map(o => <option key={o} value={o}>{t(`jobSearch.${JS_EMPLOYMENT_LABEL_KEY[o]}`)}</option>)}
          </Select>
          <Select label={t("jobSearch.experienceLevelLabel")} value={filters.experienceLevel} onChange={e => setFilters(f => ({ ...f, experienceLevel: e.target.value }))}>
            {JS_EXPERIENCE_OPTIONS.map(o => <option key={o} value={o}>{t(`jobSearch.${JS_EXPERIENCE_LABEL_KEY[o]}`)}</option>)}
          </Select>
          <Input label={t("jobSearch.minSalaryLabel")} type="number" placeholder={t("jobSearch.minSalaryPlaceholder")} value={filters.salaryMin} onChange={e => setFilters(f => ({ ...f, salaryMin: e.target.value }))} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 14, color: C.textMid, fontWeight: 500 }}><input type="checkbox" checked={filters.remote} onChange={e => setFilters(f => ({ ...f, remote: e.target.checked }))} /> {t("jobSearch.remoteOnly")}</label>
          {error && <span style={{ color: C.red, fontSize: 13 }}>{error}</span>}
          <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
            <input ref={resumeFileRef} type="file" accept=".pdf,.docx,.doc,.txt" style={{ display: "none" }} onChange={handleResumeUpload} />
            <JobSearchResumeControl
              resumes={resumes || []}
              activeResume={activeResume}
              open={resumeDialogOpen}
              setOpen={setResumeDialogOpen}
              uploading={uploadingResume}
              onSelect={(id) => onResumeLoad?.(id)}
              onCreateAI={() => onNavigateResume?.("upload")}
              onUploadClick={() => resumeFileRef.current?.click()}
            />
            <Btn onClick={() => search(false)} loading={loading} style={{ padding: "12px 28px" }}>{loading ? t("jobSearch.searching") : t("jobSearch.searchJobs")}</Btn>
          </div>
        </div>
      </Card>

      {/* Recent search chips */}
      {recentSearches.length > 0 && (
        <div style={{ marginBottom: 10, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 11, color: C.textMuted, fontWeight: 600 }}>{t("jobSearch.recentLabel")}</span>
          {recentSearches.map(r => (
            <span key={r.ts} onClick={() => setFilters(f => ({ ...f, title: r.title, city: r.city || f.city }))} style={{ background: C.bgSoft, color: C.textMid, borderRadius: 20, padding: "3px 10px", fontSize: 12, cursor: "pointer", border: `1px solid ${C.border}` }}>{r.title}</span>
          ))}
        </div>
      )}

      {loading && jobs.length === 0 && <Spinner steps={[t("jobSearch.step1"), t("jobSearch.step2"), t("jobSearch.step3")]} currentStep={1} />}
      {searched && !loading && jobs.length === 0 && <Card style={{ textAlign: "center", padding: 48 }}><div style={{ fontSize: 36, marginBottom: 12 }}>🔍</div><div style={{ fontWeight: 700, fontSize: 16 }}>{t("jobSearch.noResultsFound")}</div><div style={{ color: C.textMuted, marginTop: 6 }}>{t("jobSearch.tryDifferentKeywords")}</div></Card>}

      {jobs.length > 0 && (
        <div>
          {/* Results toolbar */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
            <div style={{ fontSize: 14, color: C.textMuted, fontWeight: 500 }}>
              {t("jobSearch.jobsFoundFor").replace("{n}", displayJobs.length !== jobs.length ? `${displayJobs.length} of ${jobs.length}` : jobs.length)}"<strong style={{ color: C.text }}>{filters.title}</strong>"
              {(() => { const nc = jobs.filter(isNewJob).length; return nc > 0 ? <span style={{ marginLeft: 8, background: C.green, color: "#fff", borderRadius: 20, padding: "2px 8px", fontSize: 11, fontWeight: 700 }}>{nc} {t("jobSearch.newBadge")}</span> : null; })()}
            </div>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ fontSize: 12, padding: "5px 8px", borderRadius: 7, border: `1px solid ${C.border}`, background: C.bgSoft, color: C.textMid, cursor: "pointer" }}>
                <option value="relevance">{t("jobSearch.sortRelevance")}</option>
                <option value="match">{t("jobSearch.sortMatch")}</option>
                <option value="date">{t("jobSearch.sortDate")}</option>
              </select>
              {dupeSet.size > 0 && <Btn variant={hideDupes ? "secondary" : "ghost"} style={{ fontSize: 12, padding: "5px 10px" }} onClick={() => setHideDupes(v => !v)}>{hideDupes ? t("jobSearch.showAll") : t("jobSearch.dupesFilter").replace("{n}", dupeSet.size)}</Btn>}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 8 : isTablet ? 10 : 14 }}>
            {displayJobs.map(job => {
              const cr = compatibilityByJobId[job.id];
              const displayMatch = cr ? cr.match_score : job.matchScore;
              const isExpanded = expandedJobs.has(job.id);

              // Matched/missing skill names for display -- recomputed here with the
              // exact same normalizeSkillSet the Compatibility Engine uses internally
              // (src/lib/compatibility/compatibility.js scoreSkillsMatch), so what's
              // shown always agrees with the score. The engine itself is untouched;
              // this is presentation only, using data already in scope.
              let matchedSkills = [], missingSkills = [];
              if (cr && job.skills?.length && resumeSkills?.length) {
                const normJob = normalizeSkillSet(job.skills, skillDictionary);
                const normResume = normalizeSkillSet(resumeSkills, skillDictionary);
                matchedSkills = [...normJob].filter(s => normResume.has(s));
                missingSkills = [...normJob].filter(s => !normResume.has(s));
              }
              const compatRows = cr ? [
                { key: "skills", label: t("jobSearch.compatSkillsLabel"), raw: cr.raw_components.skills },
                { key: "jobTitle", label: t("jobSearch.compatTitleLabel"), raw: cr.raw_components.jobTitle },
                { key: "salary", label: t("jobSearch.compatSalaryLabel"), raw: cr.raw_components.salary },
                { key: "location", label: t("jobSearch.compatLocationLabel"), raw: cr.raw_components.location },
              ] : [];

              // Free, always: full description + the deterministic compatibility
              // breakdown (buildCompatibilityRecord, zero LLM cost). Locked cards
              // (Pro-only) render below, gated on !canUseAI so Pro/Premium users who
              // already have these features never see an upgrade prompt for them.
              const expandedContent = isExpanded && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
                  {job.description && (
                    <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.7, marginBottom: 14, whiteSpace: "pre-wrap" }}>{job.description}</div>
                  )}
                  {cr && (
                    <div style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px", marginBottom: 14 }}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: C.text, marginBottom: 10 }}>{t("jobSearch.compatBreakdownTitle").replace("{v}", displayMatch)}</div>
                      {compatRows.map(row => (
                        <div key={row.key} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
                          <span style={{ fontSize: 12.5, color: C.textMid, fontWeight: 600, width: 90, flexShrink: 0 }}>{row.label}</span>
                          {row.raw == null ? (
                            <span style={{ fontSize: 11.5, color: C.textMuted }}>{t("jobSearch.compatDataUnavailable")}</span>
                          ) : row.key === "skills" ? (
                            <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                              {matchedSkills.map(s => <span key={s} style={{ background: C.greenLight, color: C.green, borderRadius: 5, padding: "2px 7px", fontSize: 11, fontWeight: 600 }}>✓ {s}</span>)}
                              {missingSkills.map(s => <span key={s} style={{ background: C.redLight, color: C.red, borderRadius: 5, padding: "2px 7px", fontSize: 11, fontWeight: 600 }}>✗ {s}</span>)}
                            </div>
                          ) : (
                            <>
                              <div style={{ flex: 1, height: 6, borderRadius: 4, background: C.border, overflow: "hidden" }}>
                                <div style={{ height: "100%", borderRadius: 4, width: `${Math.round(row.raw * 100)}%`, background: matchScoreColor(Math.round(row.raw * 100)) }} />
                              </div>
                              <span style={{ fontFamily: "monospace", fontSize: 11, color: C.textMuted, width: 34, textAlign: "right", flexShrink: 0 }}>{Math.round(row.raw * 100)}%</span>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                  {!canUseAI && (
                    <>
                      {cr && <div style={{ fontSize: 12.5, color: C.textMid, fontWeight: 600, marginBottom: 12 }}>{t("jobSearch.proTransitionHeading")}</div>}
                      <LockedAICard title={t("jobSearch.lockedAtsTitle")} description={t("jobSearch.lockedAtsDesc")} benefits={t("jobSearch.lockedAtsBenefits")} buttonLabel={t("settings.upgradeToPro")} onUpgrade={() => onNavigate?.("pricing")} />
                      <LockedAICard title={t("jobSearch.lockedTailorTitle")} description={t("jobSearch.lockedTailorDesc")} benefits={t("jobSearch.lockedTailorBenefits")} buttonLabel={t("settings.upgradeToPro")} onUpgrade={() => onNavigate?.("pricing")} />
                      <LockedAICard title={t("jobSearch.lockedCoverTitle")} description={t("jobSearch.lockedCoverDesc")} benefits={t("jobSearch.lockedCoverBenefits")} buttonLabel={t("settings.upgradeToPro")} onUpgrade={() => onNavigate?.("pricing")} />
                      <LockedAICard featured title={t("jobSearch.lockedSmartApplyTitle")} description={t("jobSearch.lockedSmartApplyDesc")} benefits={t("jobSearch.lockedSmartApplyBenefits")} buttonLabel={t("settings.upgradeToPro")} onUpgrade={() => onNavigate?.("pricing")} />
                    </>
                  )}
                </div>
              );

              if (isMobile || isTablet) {
                const compact = isMobile;
                return (
                  <Card key={job.id} style={{ padding: compact ? "10px 12px" : "14px 18px", ...(displayMatch != null ? { border: `1.5px solid ${matchScoreColor(displayMatch)}30` } : {}) }}>
                    {/* Badges + match score */}
                    <div style={{ display: "flex", gap: 4, marginBottom: 5, flexWrap: "wrap", alignItems: "center" }}>
                      <span style={{ background: `${C.blue}15`, color: C.blue, borderRadius: 5, padding: "2px 6px", fontSize: 10, fontWeight: 700 }}>{job.source}</span>
                      {job.remote && <span style={{ background: `${C.green}15`, color: C.green, borderRadius: 5, padding: "2px 6px", fontSize: 10, fontWeight: 700 }}>{t("jobSearch.remoteBadge")}</span>}
                      <span style={{ background: `${C.textMuted}12`, color: C.textMuted, borderRadius: 5, padding: "2px 6px", fontSize: 10, fontWeight: 600 }}>{job.employmentType}</span>
                      {job.experienceLevel && <span style={{ background: `${C.purple}12`, color: C.purple, borderRadius: 5, padding: "2px 6px", fontSize: 10, fontWeight: 600 }}>{job.experienceLevel}</span>}
                      {isNewJob(job) && <span style={{ background: C.green, color: "#fff", borderRadius: 5, padding: "2px 6px", fontSize: 10, fontWeight: 700 }}>{t("jobSearch.newBadge")}</span>}
                      {dupeSet.has(job.id) && <span style={{ background: `${C.yellow}25`, color: C.yellow, borderRadius: 5, padding: "2px 6px", fontSize: 10, fontWeight: 700 }}>{t("jobSearch.dupBadge")}</span>}
                      {displayMatch != null && <span style={{ marginLeft: "auto", background: `${matchScoreColor(displayMatch)}15`, color: matchScoreColor(displayMatch), border: `1px solid ${matchScoreColor(displayMatch)}30`, borderRadius: 20, padding: "2px 8px", fontSize: 10, fontWeight: 800 }}>{t("jobSearch.matchSuffix").replace("{v}", displayMatch)}</span>}
                    </div>
                    {/* Title */}
                    <div style={{ fontSize: compact ? 14 : 15, fontWeight: 800, color: C.text, marginBottom: 2, lineHeight: 1.3 }}>{job.title}</div>
                    {/* Company · Location */}
                    <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 3 }}>{job.company} · {job.location}</div>
                    {/* Salary + Posted date on one line */}
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                      <span style={{ fontSize: 12, color: C.green, fontWeight: 700 }}>{fmtSalary(job.salaryMin, job.salaryMax)}</span>
                      <span style={{ fontSize: 10, color: C.textMuted }}>{job.datePosted ? new Date(job.datePosted).toLocaleDateString(language, { month: "short", day: "numeric" }) : t("jobSearch.recently")}</span>
                    </div>
                    {/* Skill badges (compact) */}
                    {job.skills?.length > 0 && (
                      <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginBottom: 8 }}>
                        {job.skills.slice(0, compact ? 4 : 5).map(s => (
                          <span key={s} style={{ background: C.purpleLight, color: C.purple, borderRadius: 5, padding: "2px 6px", fontSize: 10, fontWeight: 600 }}>{s}</span>
                        ))}
                      </div>
                    )}
                    {/* Row 1: Save | Track */}
                    <div style={{ display: "flex", gap: 5, marginBottom: 5 }}>
                      <Btn variant={isSaved(job.id) ? "danger" : "secondary"} style={{ flex: 1, fontSize: 11, padding: "7px 4px", minWidth: 0, whiteSpace: "nowrap" }} onClick={() => toggleSave(job)}>{isSaved(job.id) ? t("jobSearch.saved") : t("jobSearch.saveJob")}</Btn>
                      <Btn variant={isTracked(job) ? "danger" : "secondary"} style={{ flex: 1, fontSize: 11, padding: "7px 4px", minWidth: 0, whiteSpace: "nowrap" }} onClick={() => toggleTrack(job)}>{isTracked(job) ? t("jobSearch.tracked") : t("jobSearch.track")}</Btn>
                    </div>
                    {/* Row 2: Smart Apply — full width, state machine */}
                    <div>
                      {smartApplying === job.id ? (
                        <Btn variant="secondary" loading style={{ width: "100%", fontSize: 11, padding: "8px 4px" }}>{t("jobSearch.preparingAiPackage")}</Btn>
                      ) : isSmartApplied(job) ? (
                        <Btn variant="secondary" style={{ width: "100%", fontSize: 11, padding: "8px 4px", color: C.purple, fontWeight: 700 }} onClick={() => onNavigate?.("saved")}>{t("jobSearch.continueInSaved")}</Btn>
                      ) : (
                        <Btn variant="secondary" style={{ width: "100%", fontSize: 11, padding: "8px 4px" }} onClick={() => handleSmartApplyClick(job)}>{canUseAI ? t("jobSearch.smartApply") : t("jobSearch.smartApplyLocked")}</Btn>
                      )}
                    </div>
                    {/* View Details toggle — full-width, generous tap target: this is
                        carrying more weight on mobile than before, since mobile cards
                        never showed a description at all until now. */}
                    <button onClick={() => toggleJobExpanded(job.id)} style={{ width: "100%", marginTop: 8, paddingTop: 10, borderTop: `1px dashed ${C.border}`, border: "none", borderTopStyle: "dashed", background: "none", color: C.purple, fontSize: 12.5, fontWeight: 700, cursor: "pointer", textAlign: "center" }}>
                      {isExpanded ? t("savedJobs.hideDetails") : t("savedJobs.viewDetails")} {isExpanded ? "▴" : "▾"}
                    </button>
                    {expandedContent}
                  </Card>
                );
              }

              // Desktop
              return (
                <Card key={job.id} style={{ ...(displayMatch != null ? { border: `1.5px solid ${matchScoreColor(displayMatch)}30` } : {}) }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 220 }}>
                      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
                        <Badge color={C.blue}>{job.source}</Badge>
                        {job.remote && <Badge color={C.green}>{t("jobSearch.remoteBadge")}</Badge>}
                        <Badge color={C.textMuted}>{job.employmentType}</Badge>
                        {job.experienceLevel && <Badge color={C.purple}>{job.experienceLevel}</Badge>}
                        {isNewJob(job) && <Badge color={C.green}>{t("jobSearch.newBadge")}</Badge>}
                        {dupeSet.has(job.id) && <Badge color={C.yellow}>{t("jobSearch.dupBadge")}</Badge>}
                        {displayMatch != null && <span style={{ marginLeft: "auto", background: `${matchScoreColor(displayMatch)}15`, color: matchScoreColor(displayMatch), border: `1px solid ${matchScoreColor(displayMatch)}30`, borderRadius: 20, padding: "3px 12px", fontSize: 12, fontWeight: 800 }}>{t("jobSearch.matchSuffix").replace("{v}", displayMatch)}</span>}
                      </div>
                      <div style={{ fontSize: 17, fontWeight: 800, color: C.text, marginBottom: 4 }}>{job.title}</div>
                      <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 6 }}>{job.company} · {job.location}</div>
                      <div style={{ fontSize: 14, color: C.green, fontWeight: 700, marginBottom: 10 }}>{fmtSalary(job.salaryMin, job.salaryMax)}</div>
                      {!isExpanded && <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.7, marginBottom: 10 }}>{job.description?.slice(0, 200)}…</div>}
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>{job.skills?.slice(0, 5).map(s => <span key={s} style={{ background: C.purpleLight, color: C.purple, borderRadius: 6, padding: "3px 9px", fontSize: 12, fontWeight: 600 }}>{s}</span>)}</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                        <span style={{ fontSize: 11, color: C.textMuted }}>{t("jobSearch.posted")} {job.datePosted ? new Date(job.datePosted).toLocaleDateString(language, { month: 'short', day: 'numeric', year: 'numeric' }) : t("jobSearch.recently")}</span>
                        <button onClick={() => toggleJobExpanded(job.id)} style={{ border: "none", background: "none", color: C.purple, fontSize: 12.5, fontWeight: 700, cursor: "pointer", padding: 0 }}>
                          {isExpanded ? t("savedJobs.hideDetails") : t("savedJobs.viewDetails")} {isExpanded ? "▴" : "▾"}
                        </button>
                      </div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, flexShrink: 0, minWidth: 120 }}>
                      <Btn variant={isSaved(job.id) ? "danger" : "secondary"} style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => toggleSave(job)}>{isSaved(job.id) ? t("jobSearch.saved") : t("jobSearch.saveJob")}</Btn>
                      <Btn variant={isTracked(job) ? "danger" : "secondary"} style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => toggleTrack(job)}>{isTracked(job) ? t("jobSearch.tracked") : t("jobSearch.track")}</Btn>
                      {smartApplying === job.id ? (
                        <Btn variant="secondary" loading style={{ fontSize: 13, padding: "9px 14px" }}>{t("jobSearch.preparingAiPackage")}</Btn>
                      ) : isSmartApplied(job) ? (
                        <Btn variant="secondary" style={{ fontSize: 13, padding: "9px 14px", color: C.purple, fontWeight: 700 }} onClick={() => onNavigate?.("saved")}>{t("jobSearch.continueInSaved")}</Btn>
                      ) : (
                        <Btn variant="secondary" style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => handleSmartApplyClick(job)}>{canUseAI ? t("jobSearch.smartApply") : t("jobSearch.smartApplyLocked")}</Btn>
                      )}
                    </div>
                  </div>
                  {expandedContent}
                </Card>
              );
            })}
          </div>
          <div style={{ textAlign: "center", marginTop: 24 }}>
            {hasMore && (
              <Btn variant="secondary" onClick={() => search(true)} disabled={loading} style={{ padding: "13px 32px", fontSize: 14 }}>
                {loading ? t("jobSearch.loadingMore") : t("jobSearch.loadMoreJobs")}
              </Btn>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Voice input button — renders only when the Web Speech API is available.
// `onTranscript` receives the full accumulated string (existing text + voice).
// `currentText`  is the textarea value at the moment recording starts so
//                typed content is preserved and the voice portion is appended.
// `key` the parent should pass `key={activeQ?.id}` or `key={mockIdx}` so the
//       hook resets between questions and any in-progress recording is stopped.
function VoiceInputBtn({ onTranscript, currentText, language }) {
  const { t } = useI18n();
  const { status, errorCode, start, stop } = useVoiceInput({ lang: language, onTranscript });

  if (!voiceSupported()) return null;

  const isRecording = status === "recording";
  const errMsg = {
    "permission-denied": t("interview.voiceErrPermission"),
    "no-microphone": t("interview.voiceErrNoMic"),
    "no-speech": t("interview.voiceErrNoSpeech"),
    "not-supported": t("interview.voiceErrUnsupported"),
  }[errorCode] || (errorCode ? t("interview.voiceErrDefault") : null);

  return (
    <div>
      <button
        type="button"
        onClick={isRecording ? stop : () => start(currentText)}
        aria-label={isRecording ? t("interview.voiceStop") : t("interview.voiceStart")}
        style={{
          display: "inline-flex", alignItems: "center", gap: 8,
          padding: "10px 16px",
          background: isRecording ? C.redLight : C.bgSoft,
          border: `1.5px solid ${isRecording ? C.red + "60" : C.border}`,
          borderRadius: 9,
          color: isRecording ? C.red : C.textMid,
          fontSize: 13, fontWeight: 600,
          cursor: "pointer", fontFamily: "inherit",
          whiteSpace: "nowrap", lineHeight: 1,
        }}
      >
        <span
          aria-hidden="true"
          style={{
            width: 9, height: 9, borderRadius: "50%", flexShrink: 0,
            background: isRecording ? C.red : C.textMid,
            boxShadow: isRecording ? `0 0 0 3px ${C.red}30` : "none",
          }}
        />
        {isRecording ? t("interview.voiceStop") : t("interview.voiceStart")}
      </button>
      {errMsg && (
        <div style={{ fontSize: 12, color: C.red, marginTop: 6, lineHeight: 1.5, maxWidth: 320 }}>
          {errMsg}
        </div>
      )}
    </div>
  );
}

// ─── INTERVIEW PAGE ────────────────────────────────────────
function InterviewPage({ profile, applications, savedJobs }) {
  const { t, language } = useI18n();
  const INTERVIEW_CAT_LABEL_KEY = { "All": "interview.catAll", "Behavioral": "interview.catBehavioral", "Technical": "interview.catTechnical", "Situational": "interview.catSituational", "Culture Fit": "interview.catCultureFit" };
  const tCat = (c) => t(INTERVIEW_CAT_LABEL_KEY[c] || c);
  const [jobDesc, setJobDesc] = useState(""); const [loading, setLoading] = useState(false); const [questions, setQuestions] = useState([]); const [activeQ, setActiveQ] = useState(null); const [answer, setAnswer] = useState(""); const [feedback, setFeedback] = useState(null); const [fbLoading, setFbLoading] = useState(false); const [filterCat, setFilterCat] = useSessionState("cp_interview_filter", "All");
  const [error, setError] = useState("");
  const [resume, setResume] = useState("");
  const [showResume, setShowResume] = useState(false);
  const resumeFileRef = useRef();
  const [uploadingResume, setUploadingResume] = useState(false);
  const [resumeFileName, setResumeFileName] = useState("");
  const [savedFeedback, setSavedFeedback] = useState({}); // {questionId: feedbackObj}
  const [mode, setMode] = useState("browse"); // browse | mock
  const [mockIdx, setMockIdx] = useState(0);
  const [mockAnswers, setMockAnswers] = useState({}); // {qId: {answer, feedback}}
  const [mockSummary, setMockSummary] = useState(null);
  const [showReview, setShowReview] = useState(false);
  const [mockAnswerDraft, setMockAnswerDraft] = useState("");
  const [mockLoading, setMockLoading] = useState(false);
  const [answerTab, setAnswerTab] = useState("strong");
  const [restored, setRestored] = useState(false);
  const diffColor = { Easy: C.green, Medium: C.yellow, Hard: C.red };
  const userContext = useUserContext({ profile, applications, savedJobs });

  const { session, loading: sessionLoading, loadedFor: sessionLoadedFor, save: saveSession, clear: clearSessionRow, complete: completeSession } = useInterviewSession(profile?.id);
  const { history: interviewHistory } = useInterviewHistory(profile?.id);
  const [loadApplied, setLoadApplied] = useState(false);
  const appliedForRef = useRef(undefined);
  const saveTimerRef = useRef(null);
  // Suppresses the debounced save after a session is completed so the completed
  // record is never overwritten by a trailing state-change write.
  const sessionCompletedRef = useRef(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  // ── Session persistence: load once the Supabase fetch for this user resolves ──
  // Gated on `sessionLoadedFor === profile?.id` (not just `!sessionLoading`) so a
  // stale render — where loading already cleared for the previous user right as
  // profile.id flips to the real one — can't be mistaken for "loaded".
  useEffect(() => {
    if (sessionLoading || sessionLoadedFor !== profile?.id) return;
    if (appliedForRef.current === profile?.id) return;
    appliedForRef.current = profile?.id;
    if (session?.questions?.length) {
      setQuestions(session.questions);
      setFilterCat("All");
      setJobDesc(session.jobDesc || "");
      setResume(session.resume || "");
      setResumeFileName(session.resumeFileName || "");
      setSavedFeedback(session.savedFeedback || {});
      setMockAnswers(session.mockAnswers || {});
      setMockSummary(session.mockSummary || null);
      setMode(session.mode || "browse");
      setMockIdx(session.mockIdx || 0);
      setMockAnswerDraft(session.mockAnswerDraft || "");
      setActiveQ(session.activeQ || null);
      setShowReview(session.showReview || false);
      setRestored(true);
    }
    setLoadApplied(true);
  }, [session, sessionLoading, sessionLoadedFor, profile?.id]);

  // ── Session persistence: save on change (debounced to avoid a write per keystroke) ──
  useEffect(() => {
    if (!loadApplied || !questions.length || sessionCompletedRef.current) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveSession({ questions, jobDesc, resume, resumeFileName, savedFeedback, mockAnswers, mockSummary, mode, mockIdx, mockAnswerDraft, activeQ, showReview }).catch(() => {});
    }, 600);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [loadApplied, questions, jobDesc, resume, resumeFileName, savedFeedback, mockAnswers, mockSummary, mode, mockIdx, mockAnswerDraft, activeQ, showReview, saveSession]);

  const resetLocalSession = () => {
    sessionCompletedRef.current = false;
    setConfirmDiscard(false);
    setQuestions([]); setJobDesc(""); setActiveQ(null); setFeedback(null);
    setSavedFeedback({}); setMockAnswers({}); setMockSummary(null); setMode("browse"); setShowReview(false);
    setMockIdx(0); setRestored(false); setError("");
  };

  const clearSession = () => {
    if (sessionCompletedRef.current) {
      // Completed sessions have no active DB row (complete() already cleared rowIdRef),
      // so there is nothing to delete — just reset the local display state.
      resetLocalSession();
    } else {
      // Active (unfinished) sessions need a confirmation before discarding.
      setConfirmDiscard(true);
    }
  };

  const doDiscard = () => {
    clearSessionRow().catch(() => {});
    resetLocalSession();
  };

  // ── Resume upload (PDF/DOCX/TXT) — local to Interview page ──
  const extractResumeFile = async (file) => {
    if (!file) return;
    const ext = file.name.split(".").pop().toLowerCase();
    if (file.size > 5 * 1024 * 1024) { setError(t("interview.fileTooLarge")); return; }
    setError(""); setUploadingResume(true);
    try {
      if (ext === "pdf") {
        if (!window.pdfjsLib) {
          await new Promise((resolve, reject) => {
            const s = document.createElement("script");
            s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
            s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
          });
          window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
        }
        const buf = await file.arrayBuffer();
        const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
        let text = "";
        for (let i = 1; i <= pdf.numPages; i++) {
          const pageObj = await pdf.getPage(i);
          const content = await pageObj.getTextContent();
          text += content.items.map(it => it.str).join(" ") + "\n";
        }
        if (text.trim()) { setResume(text.trim()); setResumeFileName(file.name); }
        else setError(t("interview.pdfScanError"));
      } else if (["docx","doc","txt"].includes(ext)) {
        const text = await file.text();
        let clean = (ext === "txt") ? text : String(text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (clean && clean.trim()) { setResume(clean.trim()); setResumeFileName(file.name); }
        else setError(t("interview.fileReadError"));
      } else setError(t("interview.unsupportedFile"));
    } catch { setError(t("interview.fileError")); }
    finally { setUploadingResume(false); }
  };
  const handleResumeUpload = async (e) => { await extractResumeFile(e.target.files[0]); e.target.value = ""; };
  const handleResumeDrop = async (e) => { e.preventDefault(); e.stopPropagation(); await extractResumeFile(e.dataTransfer.files?.[0]); };

  // ── Safe JSON parse helper ──
  const safeParse = (raw) => {
    try { return JSON.parse(raw); }
    catch {
      // attempt to recover JSON substring
      const start = raw.indexOf("[") >= 0 ? raw.indexOf("[") : raw.indexOf("{");
      const end = raw.lastIndexOf("]") >= 0 ? raw.lastIndexOf("]") : raw.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* fall through */ }
      }
      // recover a truncated array: keep complete objects up to the last full one
      if (raw.indexOf("[") >= 0) {
        const arrStart = raw.indexOf("[");
        const lastComplete = raw.lastIndexOf("}");
        if (lastComplete > arrStart) {
          try { return JSON.parse(raw.slice(arrStart, lastComplete + 1) + "]"); } catch { return null; }
        }
      }
      return null;
    }
  };

  // ── Generate questions (with full JD, resume context, STAR) ──
  const generate = async () => {
    if (!jobDesc.trim()) { setError(t("interview.noJobDesc")); return; }
    setLoading(true); setQuestions([]); setError("");
    try {
      const ctx = userContext.getContextString({ identity: true });
      const resumeBlock = resume.trim() ? `\nCANDIDATE RESUME (tailor questions to this background):\n${resume.slice(0, 1000)}` : "";
      const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}You are an expert interview coach. Generate 8 interview questions for the job below. Mix Behavioral, Technical, Situational, and Culture Fit. For Behavioral, tipToAnswer must reference STAR (Situation, Task, Action, Result). Keep every answer field to 2-3 sentences MAX to stay concise. Return ONLY a JSON array, no markdown:
[{"id":1,"category":"Behavioral|Technical|Situational|Culture Fit","difficulty":"Easy|Medium|Hard","question":"<question>","whyAsked":"<1 sentence>","tipToAnswer":"<1-2 sentences; STAR for behavioral>","strongAnswer":"<2-3 sentences>","weakAnswer":"<1-2 sentences>","aiRecommendedAnswer":"<2-3 sentences>","star":true}]
JOB:
${jobDesc.slice(0, 2500)}${resumeBlock}`, 8000, "interview_prep");
      const parsed = safeParse(raw);
      if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
        setError(t("interview.parseError"));
      } else {
        setQuestions(parsed);
        setFilterCat("All");
        setRestored(false);
        // Save immediately so quick navigation doesn't race the 600ms debounce
        saveSession({ questions: parsed, jobDesc, resume, resumeFileName, savedFeedback: {}, mockAnswers: {}, mockSummary: null, mode: "browse", mockIdx: 0, mockAnswerDraft: "", activeQ: null, showReview: false }).catch(() => {});
      }
    } catch (e) {
      setError(t("interview.generationFailed").replace("{msg}", e.message || "please try again."));
    } finally { setLoading(false); }
  };

  // ── Feedback for a single answer (now includes JD + resume context) ──
  const getFeedbackFor = async (question, ans) => {
    const ctx = userContext.getContextString({ identity: true });
    const resumeBlock = resume.trim() ? `\nCANDIDATE BACKGROUND:${resume.slice(0, 600)}` : "";
    const jdBlock = jobDesc.trim() ? `\nJOB CONTEXT:${jobDesc.slice(0, 600)}` : "";
    const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}You are an interview coach. Rate this practice answer for the given question and role. Return ONLY JSON:
{"score":<1-10>,"strengths":["<s1>","<s2>"],"improvements":["<i1>","<i2>"],"revisedAnswer":"<stronger version using STAR if behavioral>","scoreExplanation":"<1 sentence: why this specific score was given>"}
QUESTION:${question.question}${jdBlock}${resumeBlock}
CANDIDATE ANSWER:${ans.slice(0, 800)}`, 1200, "interview_prep");
    const parsed = safeParse(raw);
    if (!parsed) throw new Error("invalid feedback");
    return parsed;
  };

  const getFeedback = async () => {
    if (!answer.trim()) return;
    setFbLoading(true); setFeedback(null); setError("");
    try {
      const fb = await getFeedbackFor(activeQ, answer);
      setFeedback(fb);
      setSavedFeedback(prev => ({ ...prev, [activeQ.id]: { answer, feedback: fb } }));
    } catch {
      setError(t("interview.answerError"));
    } finally { setFbLoading(false); }
  };

  // ── Mock interview mode ──
  const startMock = () => { setMode("mock"); setMockIdx(0); setMockSummary(null); setError(""); };
  const mockQuestions = questions;

  const submitMockAnswer = async () => {
    if (!mockAnswerDraft.trim()) return;
    const q = mockQuestions[mockIdx];
    setMockLoading(true); setError("");
    try {
      const fb = await getFeedbackFor(q, mockAnswerDraft);
      setMockAnswers(prev => ({ ...prev, [q.id]: { answer: mockAnswerDraft, feedback: fb } }));
      setMockAnswerDraft("");
      if (mockIdx + 1 < mockQuestions.length) {
        setMockIdx(mockIdx + 1);
      } else {
        await buildMockSummary({ ...mockAnswers, [q.id]: { answer: mockAnswerDraft, feedback: fb } });
      }
    } catch {
      setError(t("interview.scoreError"));
    } finally { setMockLoading(false); }
  };

  const skipMock = () => {
    if (mockIdx + 1 < mockQuestions.length) { setMockIdx(mockIdx + 1); setMockAnswerDraft(""); }
    else buildMockSummary(mockAnswers);
  };

  const buildMockSummary = async (answersMap) => {
    const scores = Object.values(answersMap).map(a => a.feedback?.score).filter(n => typeof n === "number");
    const avg = scores.length ? Math.round((scores.reduce((x, y) => x + y, 0) / scores.length) * 10) / 10 : 0;
    const answeredCount = Object.keys(answersMap).length;
    const baseSummary = { answered: answeredCount, skipped: mockQuestions.length - answeredCount, total: mockQuestions.length, avgScore: avg, aiSummary: null };
    setMockSummary(baseSummary);
    insertNotification(profile?.id, { type: "interview", title: "Mock interview complete.", body: "AI Score: " + avg + "/10 — your interview feedback is ready." });

    let finalSummary = baseSummary;
    if (answeredCount > 0) {
      try {
        const details = mockQuestions.filter(q => answersMap[q.id]).map(q => `${q.category} (${answersMap[q.id].feedback?.score ?? "?"}/10): strengths: ${(answersMap[q.id].feedback?.strengths || []).join("; ")} | improvements: ${(answersMap[q.id].feedback?.improvements || []).join("; ")}`).join("\n");
        const raw = await askClaude(`You are an interview coach. Return an interview performance summary as JSON only.
OVERALL SCORE: ${avg}/10
QUESTIONS ANSWERED: ${answeredCount} of ${mockQuestions.length}
PER-QUESTION PERFORMANCE:
${details}

Return ONLY this JSON (no markdown):
{"technicalPerformance":"<Excellent|Strong|Good|Fair|Needs Work>","behavioralPerformance":"<Excellent|Strong|Good|Fair|Needs Work>","communication":"<Excellent|Strong|Good|Fair|Needs Work>","confidence":"<Excellent|Strong|Good|Fair|Needs Work>","biggestStrength":"<1 sentence>","biggestImprovement":"<1 sentence>"}`, 350, "interview_prep_followup");
        const parsed = safeParse(raw);
        if (parsed) {
          finalSummary = { ...baseSummary, aiSummary: parsed };
          setMockSummary(finalSummary);
        }
      } catch {}
    }

    // Mark session as completed with the full final data. This writes the
    // completed record once and clears rowIdRef so no subsequent debounce
    // write can overwrite it.
    sessionCompletedRef.current = true;
    completeSession({ questions, jobDesc, resume, resumeFileName, savedFeedback, mockAnswers: answersMap, mockSummary: finalSummary, mode: "mock", mockIdx, mockAnswerDraft: "", activeQ, showReview: false }).catch(() => {});
  };

  const cats = ["All","Behavioral","Technical","Situational","Culture Fit"];
  const filtered = questions.filter(q => filterCat === "All" || q.category === filterCat);

  // Reliable behavioral detection — STAR applies to behavioral/situational questions
  const isBehavioral = (q) => {
    if (!q) return false;
    if (q.star === true) return true;
    const cat = (q.category || "").toLowerCase();
    if (cat.includes("behavior") || cat.includes("situational")) return true;
    // keyword fallback for questions phrased as "tell me about a time…"
    const txt = (q.question || "").toLowerCase();
    return /tell me about a time|describe a situation|give me an example|a time when|how did you handle|walk me through a/.test(txt);
  };

  // Reusable STAR guidance card
  const StarCard = () => (
    <div style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 20 }}>
      <div style={{ fontSize: 12, color: C.purple, fontWeight: 700, marginBottom: 10 }}>{t("interview.starTitle")}</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }} className="two-col">
        {[[t("interview.starS"),t("interview.starSDesc")],[t("interview.starT"),t("interview.starTDesc")],[t("interview.starA"),t("interview.starADesc")],[t("interview.starR"),t("interview.starRDesc")]].map(([h, d]) => (
          <div key={h} style={{ fontSize: 13, color: C.text }}><strong style={{ color: C.purple }}>{h}</strong><br/><span style={{ color: C.textMid }}>{d}</span></div>
        ))}
      </div>
    </div>
  );

  // ── RENDER ──
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 6 }}>{t("interview.title")} <span style={{ fontSize: 11, color: C.green, fontWeight: 600 }}>v11</span></h1>
          <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24 }}>{t("interview.subtitle")}</p>
        </div>
        {questions.length > 0 && !confirmDiscard && <Btn variant="secondary" onClick={clearSession}>{t("interview.clearSession")}</Btn>}
      </div>

      {/* Discard confirmation — shown instead of the Clear Session button */}
      {confirmDiscard && (
        <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: "12px 16px", marginBottom: 16, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
          <span style={{ fontSize: 13, color: C.text, flex: 1 }}>{t("interview.discardConfirmMsg")}</span>
          <Btn variant="danger" onClick={doDiscard} style={{ padding: "7px 16px", fontSize: 13 }}>{t("interview.discardConfirm")}</Btn>
          <Btn variant="secondary" onClick={() => setConfirmDiscard(false)} style={{ padding: "7px 16px", fontSize: 13 }}>{t("interview.discardCancel")}</Btn>
        </div>
      )}

      {/* Interview history — completed sessions, shown when no active session is loaded */}
      {!questions.length && interviewHistory.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 11, fontWeight: 800, color: C.textMuted, letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 12 }}>{t("interview.historyTitle")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {interviewHistory.map((row) => {
              // Title priority: job_title → first non-empty line of job_description → fallback key
              const rawTitle = row.job_title || (row.job_description || "").split("\n").map(l => l.trim()).find(l => l.length > 0) || "";
              const title = rawTitle.length > 62 ? rawTitle.slice(0, 62) + "…" : rawTitle || t("interview.historyUnlabeled");
              const score = row.readiness_score != null ? (row.readiness_score / 10).toFixed(1) : null;
              const scoreNum = score != null ? parseFloat(score) : null;
              const scoreColor = scoreNum == null ? C.textMuted : scoreNum >= 8 ? C.green : scoreNum >= 6 ? C.yellow : C.red;
              const dateStr = row.updated_at ? new Date(row.updated_at).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "";
              const modeKey = row.mode === "mock" ? "interview.historyModeMock" : row.mode === "voice" ? "interview.historyModeVoice" : "interview.historyModePractice";
              const modeLabel = t(modeKey);
              const modeColor = row.mode === "mock" ? C.purple : C.blue;
              const modeBg = row.mode === "mock" ? C.purpleLight : C.blueLight;
              return (
                <div key={row.id} style={{ display: "flex", alignItems: "center", gap: 14, background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 9, padding: "13px 16px" }}>
                  <span style={{ color: C.green, fontWeight: 800, fontSize: 15, flexShrink: 0, lineHeight: 1 }}>✓</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, color: C.text, fontWeight: 700, lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                      {row.company && <span style={{ fontSize: 12, color: C.textMid, fontWeight: 500 }}>{row.company}</span>}
                      {row.company && <span style={{ fontSize: 11, color: C.textMuted, lineHeight: 1, userSelect: "none" }}>·</span>}
                      <span style={{ fontSize: 11, fontWeight: 700, color: modeColor, background: modeBg, padding: "2px 8px", borderRadius: 20, lineHeight: 1.5 }}>{modeLabel}</span>
                    </div>
                  </div>
                  <div style={{ textAlign: "right", flexShrink: 0 }}>
                    {score != null && <div style={{ fontSize: 15, fontWeight: 800, color: scoreColor, lineHeight: 1 }}>{score}<span style={{ fontSize: 11, fontWeight: 500, color: C.textMuted }}>/10</span></div>}
                    {dateStr && <div style={{ fontSize: 11, color: C.textMuted, marginTop: score != null ? 4 : 0 }}>{dateStr}</div>}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ height: 1, background: C.border, margin: "20px 0" }} />
        </div>
      )}

      {restored && questions.length > 0 && (
        <div style={{ background: C.purpleLight, border: `1px solid ${C.purple}30`, borderRadius: 9, padding: "10px 14px", color: C.purple, fontSize: 13, marginBottom: 16 }}>
          {t("interview.restored").replace("{count}", questions.length)} <span style={{ textDecoration: "underline", cursor: "pointer" }} onClick={clearSession}>{t("interview.startFresh")}</span>
        </div>
      )}

      {error && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 14, color: C.red, fontSize: 13, marginBottom: 16 }}>{error}</div>}

      {/* SETUP */}
      {!questions.length && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 20 }}>
          <Card style={{ width: "100%" }}>
            <Textarea label={t("interview.jobDescLabel")} placeholder={t("interview.jobDescPlaceholder")} value={jobDesc} onChange={e => setJobDesc(e.target.value)} style={{ minHeight: 220, width: "100%" }} />
            <div style={{ marginTop: 14 }}>
              <Btn variant={resume ? "green" : "secondary"} onClick={() => setShowResume(!showResume)}>{resume ? t("interview.resumeAdded") : t("interview.addResume")}</Btn>
            </div>
            {showResume && (
              <div style={{ marginTop: 14 }}>
                <input ref={resumeFileRef} type="file" accept=".pdf,.docx,.doc,.txt" style={{ display: "none" }} onChange={handleResumeUpload} />
                <div
                  onClick={() => resumeFileRef.current.click()}
                  onDragOver={e => { e.preventDefault(); }}
                  onDrop={handleResumeDrop}
                  style={{ border: `1.5px solid ${resumeFileName ? C.green : C.border}`, background: resumeFileName ? C.greenLight : C.bgSoft, borderRadius: 9, padding: "22px", textAlign: "center", cursor: "pointer", marginBottom: 12, boxSizing: "border-box" }}
                >
                  {uploadingResume ? <span style={{ color: C.purple, fontWeight: 600 }}>{t("interview.extracting")}</span>
                    : resumeFileName ? <span><span style={{ background: C.green, color: "#fff", padding: "4px 12px", borderRadius: 20, fontSize: 13, fontWeight: 600 }}>{t("interview.resumeLoaded")}</span> <span style={{ display: "block", marginTop: 8, color: C.text, fontWeight: 600 }}>📄 {resumeFileName}</span></span>
                    : <span><span style={{ color: C.purple, fontWeight: 700, fontSize: 15 }}>{t("interview.uploadResume")}</span><br/><span style={{ color: C.textMuted, fontSize: 13 }}>{t("interview.uploadHint")}</span></span>}
                </div>
                <textarea style={{ width: "100%", minHeight: 120, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.7, padding: "14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} placeholder={t("interview.resumePastePlaceholder")} value={resume} onChange={e => { setResume(e.target.value); if (resumeFileName) setResumeFileName(""); }} />
              </div>
            )}
          </Card>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn onClick={generate} disabled={!jobDesc.trim()} loading={loading} style={{ padding: "13px 28px" }}>{loading ? t("interview.generating") : t("interview.generateBtn")}</Btn>
            <Btn variant="secondary" disabled={loading} onClick={() => setJobDesc(SAMPLE_JOB)}>{t("interview.trySample")}</Btn>
          </div>
        </div>
      )}

      {loading && <Spinner steps={[t("interview.spinner1"),t("interview.spinner2"),t("interview.spinner3"),t("interview.spinner4")]} currentStep={1} />}

      {/* MODE SWITCH */}
      {questions.length > 0 && !activeQ && mode === "browse" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
            <div style={{ fontWeight: 700, color: C.text, fontSize: 16 }}>{t("interview.questionsGenerated").replace("{count}", questions.length)}</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{cats.map(c => <Btn key={c} variant="ghost" style={{ padding: "6px 14px", borderRadius: 8, border: `1.5px solid ${filterCat === c ? C.purple : C.border}`, background: filterCat === c ? C.purpleLight : "#fff", color: filterCat === c ? C.purple : C.textMuted, fontSize: 13, fontWeight: 600 }} onClick={() => setFilterCat(c)}>{tCat(c)}</Btn>)}</div>
            <Btn onClick={startMock} style={{ padding: "8px 18px" }}>{t("interview.startMock")}</Btn>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {filtered.map((q, i) => (
              <Card key={q.id} style={{ cursor: "pointer", userSelect: "none" }} onClick={() => { setActiveQ(q); const sv = savedFeedback[q.id]; setAnswer(sv?.answer || ""); setFeedback(sv?.feedback || null); setAnswerTab("strong"); }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}><Badge color={C.purple}>{tCat(q.category)}</Badge><Badge color={diffColor[q.difficulty]}>{q.difficulty}</Badge>{q.star && <Badge color={C.blue}>{t("interview.starBadge")}</Badge>}{savedFeedback[q.id] && <Badge color={C.green}>{t("interview.practicedBadge").replace("{score}", savedFeedback[q.id].feedback?.score)}</Badge>}</div>
                    <div style={{ fontSize: 15, color: C.text, lineHeight: 1.6, fontWeight: 500 }}>Q{i+1}. {q.question}</div>
                  </div>
                  <span style={{ color: C.textMuted, fontSize: 22, marginLeft: 12, pointerEvents: "none" }}>›</span>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* MOCK INTERVIEW MODE */}
      {questions.length > 0 && mode === "mock" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <Btn variant="secondary" onClick={() => { setMode("browse"); setMockSummary(null); setShowReview(false); }}>{t("interview.exitMock")}</Btn>
            {!mockSummary && <div style={{ fontWeight: 700, color: C.text }}>{t("interview.questionOf").replace("{current}", mockIdx + 1).replace("{total}", mockQuestions.length)}</div>}
          </div>

          {!mockSummary && (
            <Card>
              <div style={{ display: "flex", gap: 6, marginBottom: 14 }}><Badge color={C.purple}>{tCat(mockQuestions[mockIdx].category)}</Badge><Badge color={diffColor[mockQuestions[mockIdx].difficulty]}>{mockQuestions[mockIdx].difficulty}</Badge></div>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.text, lineHeight: 1.4, marginBottom: 8 }}>{mockQuestions[mockIdx].question}</div>
              <div style={{ height: 6, background: C.bgSoft, borderRadius: 4, marginBottom: 20, overflow: "hidden" }}><div style={{ width: `${((mockIdx) / mockQuestions.length) * 100}%`, height: "100%", background: C.purple }} /></div>
              {isBehavioral(mockQuestions[mockIdx]) && <StarCard />}
              <Textarea label={t("interview.yourAnswer")} placeholder={t("interview.yourAnswerPlaceholder")} value={mockAnswerDraft} onChange={e => setMockAnswerDraft(e.target.value)} style={{ minHeight: 160, width: "100%", marginBottom: 14 }} />
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-start" }}>
                <Btn onClick={submitMockAnswer} disabled={!mockAnswerDraft.trim()} loading={mockLoading}>{mockLoading ? t("interview.scoringBtn") : (mockIdx + 1 < mockQuestions.length ? t("interview.submitNext") : t("interview.submitFinish"))}</Btn>
                <Btn variant="secondary" onClick={skipMock} disabled={mockLoading}>{t("interview.skipBtn")}</Btn>
                <VoiceInputBtn key={mockIdx} onTranscript={setMockAnswerDraft} currentText={mockAnswerDraft} language={language} />
              </div>
            </Card>
          )}

          {mockSummary && !showReview && (
            <Card style={{ padding: 32 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: C.text, marginBottom: 24, textAlign: "center" }}>{t("interview.mockComplete")}</div>

              {/* Performance + Progress — clearly separated */}
              <div style={{ display: "flex", flexDirection: "column", gap: 0, background: C.bgSoft, borderRadius: 12, padding: "4px 0", marginBottom: 20, overflow: "hidden" }}>
                {[
                  [t("interview.summaryInterviewScore"), <span style={{ fontSize: 18, fontWeight: 800, color: mockSummary.avgScore >= 8 ? C.green : mockSummary.avgScore >= 6 ? C.yellow : C.red }}>{mockSummary.avgScore} / 10</span>],
                  [t("interview.summaryAnswered"), <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{mockSummary.answered} / {mockSummary.total}</span>],
                  [t("interview.summarySkipped"), <span style={{ fontSize: 15, fontWeight: 700, color: mockSummary.skipped > 0 ? C.yellow : C.text }}>{mockSummary.skipped}</span>],
                  [t("interview.summaryCompletion"), <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{mockSummary.total ? Math.round((mockSummary.answered / mockSummary.total) * 100) : 0}%</span>],
                ].map(([label, value], i, arr) => (
                  <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 18px", borderBottom: i < arr.length - 1 ? `1px solid ${C.border}` : "none" }}>
                    <span style={{ fontSize: 14, color: C.textMid }}>{label}</span>
                    {value}
                  </div>
                ))}
              </div>

              {/* AI Performance Summary */}
              {mockSummary.aiSummary ? (
                <div style={{ background: `linear-gradient(135deg, ${C.purpleLight}, #fff)`, border: `1px solid ${C.purple}25`, borderRadius: 12, padding: 18, marginBottom: 24 }}>
                  <div style={{ fontSize: 11, color: C.purple, fontWeight: 700, marginBottom: 14, letterSpacing: "0.05em" }}>{t("interview.aiPerfSummaryTitle")}</div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
                    {[[t("interview.perfTechnical"), mockSummary.aiSummary.technicalPerformance], [t("interview.perfBehavioral"), mockSummary.aiSummary.behavioralPerformance], [t("interview.perfCommunication"), mockSummary.aiSummary.communication], [t("interview.perfConfidence"), mockSummary.aiSummary.confidence]].map(([label, val]) => {
                      const col = val === "Excellent" || val === "Strong" ? C.green : val === "Good" ? C.blue : val === "Fair" ? C.yellow : C.red;
                      return (
                        <div key={label} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "#fff", borderRadius: 8, padding: "8px 12px", fontSize: 13 }}>
                          <span style={{ color: C.textMid }}>{label}</span>
                          <span style={{ fontWeight: 700, color: col }}>{tStatusVal(val, t)}</span>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 13, color: C.text, marginBottom: 8, lineHeight: 1.5 }}>
                    <span style={{ color: C.green, fontWeight: 700 }}>{t("interview.biggestStrengthLabel")}</span>{mockSummary.aiSummary.biggestStrength}
                  </div>
                  <div style={{ fontSize: 13, color: C.text, lineHeight: 1.5 }}>
                    <span style={{ color: C.yellow, fontWeight: 700 }}>{t("interview.keyImprovementLabel")}</span>{mockSummary.aiSummary.biggestImprovement}
                  </div>
                </div>
              ) : mockSummary.answered > 0 && (
                <div style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 18px", marginBottom: 24, color: C.textMuted, fontSize: 13 }}>{t("interview.generatingAiSummary")}</div>
              )}

              <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                <Btn onClick={() => setShowReview(true)}>{t("interview.reviewAnswers")}</Btn>
                <Btn variant="secondary" onClick={() => { sessionCompletedRef.current = false; setMockIdx(0); setMockSummary(null); setMockAnswers({}); setShowReview(false); }}>{t("interview.retryMock")}</Btn>
              </div>
            </Card>
          )}

          {mockSummary && showReview && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>{t("interview.interviewReview")}</div>
                <Btn variant="secondary" onClick={() => setShowReview(false)}>{t("interview.backToSummary")}</Btn>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {mockQuestions.map((q, i) => {
                  const ans = mockAnswers[q.id];
                  const score = ans?.feedback?.score;
                  const scoreColor = score >= 8 ? C.green : score >= 6 ? C.yellow : C.red;
                  return (
                    <Card key={q.id}>
                      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                        <Badge color={C.purple}>{tCat(q.category)}</Badge>
                        <Badge color={diffColor[q.difficulty]}>{q.difficulty}</Badge>
                        {ans ? <Badge color={score >= 8 ? C.green : score >= 6 ? C.yellow : C.red}>✓ {score}/10</Badge> : <Badge color={C.textMuted}>⊘ {t("interview.skippedBadge")}</Badge>}
                      </div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 14, lineHeight: 1.4 }}>Q{i + 1}. {q.question}</div>
                      {ans ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                          {/* AI Score */}
                          {score != null && (
                            <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "10px 14px", background: `${scoreColor}10`, border: `1.5px solid ${scoreColor}30`, borderRadius: 10 }}>
                              <span style={{ fontSize: 28, fontWeight: 800, color: scoreColor, lineHeight: 1 }}>{score}<span style={{ fontSize: 16, color: C.textMuted, fontWeight: 500 }}>/10</span></span>
                              <div>
                                <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, marginBottom: 2 }}>{t("interview.aiScoreLabel")}</div>
                                {ans.feedback.scoreExplanation && <div style={{ fontSize: 12, color: C.textMid, lineHeight: 1.5 }}>{ans.feedback.scoreExplanation}</div>}
                              </div>
                            </div>
                          )}
                          {/* Your Answer */}
                          <div>
                            <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, marginBottom: 4 }}>{t("interview.yourAnswerLabel")}</div>
                            <div style={{ background: C.bgSoft, borderRadius: 8, padding: "12px 14px", fontSize: 14, lineHeight: 1.7, color: C.text, whiteSpace: "pre-wrap" }}>{ans.answer}</div>
                          </div>
                          {/* Strengths + Improvements */}
                          {ans.feedback && (
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }} className="two-col">
                              <div style={{ background: C.greenLight, borderRadius: 8, padding: 12 }}><div style={{ fontSize: 11, color: C.green, fontWeight: 700, marginBottom: 6 }}>{t("interview.strengths")}</div>{(ans.feedback.strengths || []).map((s, j) => <div key={j} style={{ fontSize: 12, color: C.text, marginBottom: 4, lineHeight: 1.5 }}>• {s}</div>)}</div>
                              <div style={{ background: C.yellowLight, borderRadius: 8, padding: 12 }}><div style={{ fontSize: 11, color: C.yellow, fontWeight: 700, marginBottom: 6 }}>{t("interview.improve")}</div>{(ans.feedback.improvements || []).map((s, j) => <div key={j} style={{ fontSize: 12, color: C.text, marginBottom: 4, lineHeight: 1.5 }}>• {s}</div>)}</div>
                            </div>
                          )}
                          {/* AI Recommended Answer */}
                          {ans.feedback?.revisedAnswer && (
                            <div style={{ background: `linear-gradient(135deg, ${C.purpleLight}, #fff)`, border: `1px solid ${C.purple}25`, borderRadius: 10, padding: "12px 14px" }}>
                              <div style={{ fontSize: 11, color: C.purple, fontWeight: 700, marginBottom: 6 }}>{t("interview.aiRecommendedLabel")}</div>
                              <div style={{ fontSize: 13, lineHeight: 1.7, color: C.text, whiteSpace: "pre-wrap" }}>{ans.feedback.revisedAnswer}</div>
                              <div style={{ marginTop: 8 }}><CopyBtn text={ans.feedback.revisedAnswer} /></div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div>
                          <div style={{ fontSize: 13, color: C.textMuted, fontStyle: "italic", marginBottom: 10 }}>{t("interview.skippedMsg")}</div>
                          <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, marginBottom: 4 }}>{t("interview.strongAnswerLabel")}</div>
                          <div style={{ background: C.bgSoft, borderRadius: 8, padding: "12px 14px", fontSize: 14, lineHeight: 1.7, color: C.text, whiteSpace: "pre-wrap" }}>{q.strongAnswer}</div>
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
                <Btn variant="secondary" onClick={() => { setMode("browse"); setMockSummary(null); setShowReview(false); }}>{t("interview.backToList")}</Btn>
                <Btn onClick={() => { sessionCompletedRef.current = false; setMockIdx(0); setMockSummary(null); setMockAnswers({}); setShowReview(false); }}>{t("interview.retryMock")}</Btn>
              </div>
            </div>
          )}
        </div>
      )}

      {/* SINGLE QUESTION DETAIL */}
      {activeQ && (
        <div>
          <Btn variant="secondary" style={{ marginBottom: 18 }} onClick={() => { setActiveQ(null); setFeedback(null); }}>{t("interview.backToQuestions")}</Btn>
          <Card>
            <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}><Badge color={C.purple}>{tCat(activeQ.category)}</Badge><Badge color={diffColor[activeQ.difficulty]}>{activeQ.difficulty}</Badge>{activeQ.star && <Badge color={C.blue}>{t("interview.starBadge")}</Badge>}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.text, lineHeight: 1.4, marginBottom: 20 }}>{activeQ.question}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }} className="two-col">
              <div style={{ background: C.blueLight, borderRadius: 12, padding: 16 }}><div style={{ fontSize: 11, color: C.blue, fontWeight: 700, marginBottom: 8 }}>{t("interview.whyTheyAsk")}</div><div style={{ fontSize: 14, lineHeight: 1.7, color: C.text }}>{activeQ.whyAsked}</div></div>
              <div style={{ background: C.yellowLight, borderRadius: 12, padding: 16 }}><div style={{ fontSize: 11, color: C.yellow, fontWeight: 700, marginBottom: 8 }}>{activeQ.star ? t("interview.howToAnswerStar") : t("interview.howToAnswer")}</div><div style={{ fontSize: 14, lineHeight: 1.7, color: C.text }}>{activeQ.tipToAnswer}</div></div>
            </div>

            {isBehavioral(activeQ) && <StarCard />}

            <div style={{ marginBottom: 24 }}>
              <div style={{ display: "flex", gap: 3, background: C.bgSoft, borderRadius: 10, padding: 3, marginBottom: 14 }}>
                {[["strong",t("interview.strongAnswerTab")],["weak",t("interview.weakAnswerTab")],["ai",t("interview.aiRecommendedTab")]].map(([id, lbl]) => (
                  <Btn key={id} variant="ghost" style={{ flex: 1, padding: "9px", borderRadius: 7, border: "none", background: answerTab === id ? "#fff" : "transparent", color: answerTab === id ? C.text : C.textMuted, fontSize: 13, fontWeight: 600 }} onClick={() => setAnswerTab(id)}>{lbl}</Btn>
                ))}
              </div>
              {answerTab === "strong" && <div><ContentDisplay content={activeQ.strongAnswer} /><div style={{ marginTop: 8 }}><CopyBtn text={activeQ.strongAnswer} label={t("interview.copyStrong")} /></div></div>}
              {answerTab === "weak" && <div style={{ background: C.redLight, border: `1px solid ${C.red}25`, borderRadius: 12, padding: "16px 20px" }}><div style={{ fontSize: 12, color: C.red, fontWeight: 700, marginBottom: 10 }}>{t("interview.weakAnswerLabel")}</div><div style={{ fontSize: 14, lineHeight: 1.8, color: C.text, whiteSpace: "pre-wrap" }}>{activeQ.weakAnswer}</div></div>}
              {answerTab === "ai" && <div><div style={{ background: `linear-gradient(135deg, ${C.purpleLight}, #fff)`, border: `1px solid ${C.purple}25`, borderRadius: 12, padding: "16px 20px" }}><div style={{ fontSize: 12, color: C.purple, fontWeight: 700, marginBottom: 10 }}>{t("interview.aiAnswerLabel")}</div><div style={{ fontSize: 14, lineHeight: 1.8, color: C.text, whiteSpace: "pre-wrap" }}>{activeQ.aiRecommendedAnswer}</div></div><div style={{ marginTop: 8 }}><CopyBtn text={activeQ.aiRecommendedAnswer} label={t("interview.copyAiAnswer")} /></div></div>}
            </div>

            <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 12 }}>{t("interview.practiceLabel")}</div>
              <Textarea label={t("interview.typeAnswerLabel")} placeholder={t("interview.typeAnswerPlaceholder")} value={answer} onChange={e => setAnswer(e.target.value)} style={{ minHeight: 180, marginBottom: 16, width: "100%" }} />
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start", flexWrap: "wrap" }}>
                <Btn onClick={getFeedback} disabled={!answer.trim()} loading={fbLoading}>{fbLoading ? t("interview.analyzing") : t("interview.getFeedback")}</Btn>
                <VoiceInputBtn key={activeQ?.id} onTranscript={setAnswer} currentText={answer} language={language} />
              </div>
            </div>

            {fbLoading && <Spinner steps={[t("interview.feedbackSpinner1"),t("interview.feedbackSpinner2"),t("interview.feedbackSpinner3")]} currentStep={1} />}
            {feedback && !fbLoading && (
              <div style={{ marginTop: 20 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
                  <span style={{ fontSize: 14, color: C.textMuted }}>{t("interview.yourScore")}</span>
                  <span style={{ fontSize: 36, fontWeight: 800, color: feedback.score >= 8 ? C.green : feedback.score >= 6 ? C.yellow : C.red }}>{feedback.score}/10</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }} className="two-col">
                  <div style={{ background: C.greenLight, borderRadius: 12, padding: 16 }}><div style={{ fontSize: 11, color: C.green, fontWeight: 700, marginBottom: 8 }}>{t("interview.strengths")}</div>{feedback.strengths?.map((s, i) => <div key={i} style={{ fontSize: 13, marginBottom: 6, color: C.text, lineHeight: 1.5 }}>• {s}</div>)}</div>
                  <div style={{ background: C.yellowLight, borderRadius: 12, padding: 16 }}><div style={{ fontSize: 11, color: C.yellow, fontWeight: 700, marginBottom: 8 }}>{t("interview.improve")}</div>{feedback.improvements?.map((s, i) => <div key={i} style={{ fontSize: 13, marginBottom: 6, color: C.text, lineHeight: 1.5 }}>• {s}</div>)}</div>
                </div>
                {feedback.revisedAnswer && <div><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}><div style={{ fontSize: 12, color: C.purple, fontWeight: 700 }}>{t("interview.strongerVersion")}</div><CopyBtn text={feedback.revisedAnswer} /></div><ContentDisplay content={feedback.revisedAnswer} /></div>}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

// ─── TRACKER PAGE ──────────────────────────────────────────
const STATUSES = ["Applied","Phone Screen","Interview","Final Interview","Offer","Rejected","Withdrawn","Ghosted"];
// Single source of truth for status color -- reused by summary cards, filter chips,
// the status dropdown, and status badges so all four stay visually in sync.
const SCOLOR = { Applied: C.blue, "Phone Screen": C.orange, Interview: C.purple, "Final Interview": "#7C3AED", Offer: C.green, Rejected: C.red, Withdrawn: C.borderStrong, Ghosted: C.text };
// Fixed pixel width for the Status Indicator, same principle as NAV_PILL_WIDTH:
// measured directly against the live rendered pill (gap:0 override + compact
// horizontal padding, vertical padding matched to View/Edit/Delete's height
// for visual consistency) so the longest English label ("Final Interview ▾",
// ~123px natural) never clips; wider translations clip with an ellipsis and
// the full label is available via the title tooltip. Keeps View/Edit/Delete
// from shifting horizontally when the status changes -- same fix as the nav
// pill stabilization. borderRadius:20 matches this app's existing colored
// status-pill convention (see statusColor/statusBg usage elsewhere).
const STATUS_INDICATOR_WIDTH = 128;
// "All" is a view filter, not a hiring status -- kept visually neutral rather than
// reusing a status color so it doesn't read as an implied 9th status.
const NEUTRAL_FILTER_COLOR = C.textMuted;

const STATUS_LABEL_KEY = { Applied: "statusApplied", "Phone Screen": "statusPhoneScreen", Interview: "statusInterview", "Final Interview": "statusFinalInterview", Offer: "statusOffer", Rejected: "statusRejected", Withdrawn: "statusWithdrawn", Ghosted: "statusGhosted" };

// ─── APPLICATION OUTCOME INTELLIGENCE PANEL (Premium Feature #2) ────────────
// Each of the six fixed analyses becomes available based on ITS OWN data requirement
// (computeAnalysisAvailability in patternEngine.js), never a global application or
// outcome count. The copy here explains what enables each one -- positive and
// forward-looking, never "locked"/"unlocks at N".
const OI_AVAILABILITY_COPY = {
  responsePattern: "oiAvailableResponsePattern",
  funnelStage: "oiAvailableFunnelStage",
  companyProfileFit: "oiAvailableCompanyProfileFit",
  applicationQuality: "oiAvailableApplicationQuality",
  resumeVersion: "oiAvailableResumeVersion",
  strategicPrediction: "oiAvailableStrategicPrediction",
};

// Always renders all six section rows, regardless of whether any analysis has ever
// been generated -- `analysis` may be null/undefined (before the first run). Each row
// independently shows its real finding if present in the last generated analysis, or
// its own positive availability message if not, with no dependency on the others.
function OutcomeAnalysisDeepDives({ analysis, t }) {
  const [openKey, setOpenKey] = useState(null);
  const sections = [
    { key: "responsePattern", title: t("tracker.oiAnalysis01") },
    { key: "funnelStage", title: t("tracker.oiAnalysis02") },
    { key: "companyProfileFit", title: t("tracker.oiAnalysis03") },
    { key: "applicationQuality", title: t("tracker.oiAnalysis04") },
    { key: "resumeVersion", title: t("tracker.oiAnalysis05") },
    { key: "strategicPrediction", title: t("tracker.oiAnalysis06") },
  ];
  return (
    <Card>
      <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 12 }}>{t("tracker.oiDeepDivesHeading")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {sections.map(s => {
          const data = analysis?.analyses?.[s.key];
          if (!data) {
            return (
              <div key={s.key} style={{ border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 4 }}>{s.title}</div>
                <div style={{ fontSize: 12, color: C.textMuted }}>{t(`tracker.${OI_AVAILABILITY_COPY[s.key]}`)}</div>
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
                  {s.key === "strategicPrediction" ? (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                      <div><strong>{t("tracker.oiTargeting")}:</strong> {data.targeting}</div>
                      <div><strong>{t("tracker.oiApproachChanges")}:</strong> {data.approachChanges}</div>
                      <div><strong>{t("tracker.oiResumeSignals")}:</strong> {data.resumeSignals}</div>
                      <div><strong>{t("tracker.oiOpportunityCost")}:</strong> {data.opportunityCost}</div>
                    </div>
                  ) : (
                    <>
                      <div style={{ marginBottom: 6 }}>{data.finding}</div>
                      <div style={{ fontSize: 12, color: C.textMuted }}>{data.evidence}</div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function RecommendationResults({ evaluations, t, language }) {
  if (!evaluations.length) return null;
  const resultLabel = { confirmed: t("tracker.oiConfirmed"), no_change: t("tracker.oiNoChange"), insufficient_data: t("tracker.oiPending") };
  const resultColor = { confirmed: C.green, no_change: C.textMuted, insufficient_data: C.yellow };
  return (
    <Card>
      <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 12 }}>{t("tracker.oiRecommendationResultsHeading")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {evaluations.map(ev => (
          <div key={ev.id} style={{ background: C.bgSoft, borderRadius: 10, padding: "12px 14px" }}>
            <div style={{ fontSize: 13, color: C.text, marginBottom: 6 }}>{ev.recommendation_text}</div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 11, color: C.textMuted }}>{new Date(ev.applied_at).toLocaleDateString(language)}</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: resultColor[ev.evaluation_result || "insufficient_data"] }}>{resultLabel[ev.evaluation_result || "insufficient_data"]}</span>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// Permanent explainer for what this feature does. Renders in full before any real
// analysis exists; collapses to a small expandable panel once one does -- it must
// never disappear entirely, so the user always has a reminder of the feature's value.
function OutcomeIntelligenceIntro({ collapsed, t }) {
  // Starts closed. Deliberately NOT derived from `collapsed` at mount time: `collapsed`
  // depends on an async-loaded analysis (useOutcomeAnalyses fetches after first render),
  // so it's still false on mount and only flips true later -- a useState(!collapsed)
  // initializer would capture that stale first value and never re-collapse once the
  // analysis loads. The uncollapsed branch below ignores `open` entirely, so this
  // default only ever governs the already-collapsed panel, where "closed by default" is
  // exactly the desired behavior.
  const [open, setOpen] = useState(false);
  const bullets = [
    t("tracker.oiIntroBullet1"),
    t("tracker.oiIntroBullet2"),
    t("tracker.oiIntroBullet3"),
    t("tracker.oiIntroBullet4"),
    t("tracker.oiIntroBullet5"),
  ];
  const body = (
    <>
      <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.7, marginBottom: 12 }}>{t("tracker.oiIntroBody")}</div>
      <ul style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6 }}>
        {bullets.map((b, i) => <li key={i} style={{ fontSize: 13, color: C.textMid }}>{b}</li>)}
      </ul>
    </>
  );
  if (!collapsed) {
    return (
      <Card>
        <div style={{ fontWeight: 700, fontSize: 16, color: C.text, marginBottom: 10 }}>📈 {t("tracker.oiIntroTitle")}</div>
        {body}
      </Card>
    );
  }
  return (
    <Card style={{ padding: 0, overflow: "hidden" }}>
      <button onClick={() => setOpen(o => !o)} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 18px", background: open ? C.bgSoft : "#fff", border: "none", cursor: "pointer", fontSize: 14, fontWeight: 700, color: C.text, textAlign: "left" }}>
        {t("tracker.oiIntroTitle")}<span>{open ? "−" : "+"}</span>
      </button>
      {open && <div style={{ padding: "0 18px 18px" }}>{body}</div>}
    </Card>
  );
}

// Illustrative-only examples shown before a real analysis exists, so the user can see
// the kind of value they're building toward. Visually distinguished (dashed border +
// EXAMPLE badge) so they can never be mistaken for the user's own data.
function OutcomeExampleInsights({ t }) {
  const examples = [t("tracker.oiExample1"), t("tracker.oiExample2"), t("tracker.oiExample3"), t("tracker.oiExample4"), t("tracker.oiExample5")];
  return (
    <Card style={{ border: `1px dashed ${C.border}` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>{t("tracker.oiExampleHeading")}</div>
        <span style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, background: C.bgSoft, padding: "2px 8px", borderRadius: 8, letterSpacing: 0.5 }}>{t("tracker.oiExampleBadge")}</span>
      </div>
      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12, fontStyle: "italic" }}>{t("tracker.oiExampleDisclaimer")}</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {examples.map((ex, i) => (
          <div key={i} style={{ display: "flex", gap: 8, fontSize: 13, color: C.textMid, opacity: 0.8 }}>
            <span>•</span><span>{ex}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function OutcomeIntelligencePanel({ applications, savedJobs, smartApplyQueue, profile, isPremium, patternsHook, analysesHook, recommendationEvalHook }) {
  const { t, language } = useI18n();
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");
  const { savePatterns } = patternsHook;
  const { analyses, latest, saveAnalysis } = analysesHook;
  const { evaluations } = recommendationEvalHook;

  const funnel = useMemo(() => computeFunnel(applications), [applications]);
  const outcomesLoggedCount = useMemo(() => computeOutcomesLoggedCount(applications), [applications]);
  const confidenceTier = computeConfidenceTier(outcomesLoggedCount);

  const runAnalysis = async () => {
    if (!isPremium || !profile?.id) return;
    setRunning(true); setRunError("");
    try {
      await runOutcomeAnalysis({ applications, savedJobs, smartApplyQueue, saveAnalysis, savePatterns, userId: profile.id });
    } catch (e) {
      console.error("[OutcomeIntelligence]", e);
      setRunError(t("tracker.oiRunFailed"));
    } finally {
      setRunning(false);
    }
  };

  if (!isPremium) {
    return (
      <Card style={{ textAlign: "center", padding: 48 }}>
        <div style={{ fontSize: 40, marginBottom: 14 }}>📈</div>
        <div style={{ fontWeight: 700, fontSize: 18, color: C.text, marginBottom: 8 }}>{t("tracker.oiPremiumTitle")}</div>
        <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 20, maxWidth: 480, marginLeft: "auto", marginRight: "auto" }}>{t("tracker.oiPremiumBody")}</div>
        <Btn onClick={() => { window.location.hash = "#pricing"; }}>{t("tracker.oiUpgradeBtn")}</Btn>
      </Card>
    );
  }

  const latestAnalysis = latest?.analysis;
  const tierLabel = { early_signal: t("tracker.tierEarlySignal"), emerging: t("tracker.tierEmerging"), high_confidence: t("tracker.tierHighConfidence") };
  const tierColor = { early_signal: C.yellow, emerging: C.blue, high_confidence: C.green };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Permanent explainer -- full before any real analysis exists, collapses to a
          small expandable panel once one does, but never disappears entirely. */}
      <OutcomeIntelligenceIntro collapsed={!!latestAnalysis} t={t} />

      {/* Illustrative-only examples of the value being built toward -- removed once
          a real analysis exists, since the real Top Insights zone replaces them. */}
      {!latestAnalysis && <OutcomeExampleInsights t={t} />}

      {/* Zone 1 -- Funnel Overview: real data, not AI, always visible regardless of tier.
          Always available from the first tracked application. */}
      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 10 }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>{t("tracker.oiFunnelHeading")}</div>
          <Btn onClick={runAnalysis} loading={running} disabled={outcomesLoggedCount < 1} style={{ fontSize: 12, padding: "7px 14px" }}>{t("tracker.oiRunAnalysis")}</Btn>
        </div>
        {runError && <div style={{ color: C.red, fontSize: 12, marginBottom: 10 }}>{runError}</div>}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }} className="two-col">
          {[
            { label: t("tracker.oiApplied"), value: String(funnel.applied) },
            { label: t("tracker.oiResponded"), value: `${funnel.responded} (${Math.round(funnel.responseRate * 100)}%)` },
            { label: t("tracker.oiInterviewed"), value: `${funnel.interviewed} (${Math.round(funnel.interviewRate * 100)}%)` },
            { label: t("tracker.oiOffered"), value: `${funnel.offered} (${Math.round(funnel.offerRate * 100)}%)` },
          ].map((f, i) => (
            <div key={i} style={{ background: C.bgSoft, borderRadius: 10, padding: "12px 10px", textAlign: "center" }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>{f.value}</div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{f.label}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* At 0 decided outcomes there's nothing to synthesize yet -- no separate locked
          panel; the six analysis cards below already explain what's coming and why,
          independently of each other. */}
      {confidenceTier && !latestAnalysis && (
        <Card style={{ textAlign: "center", padding: 40 }}>
          <div style={{ fontSize: 13, color: C.textMuted }}>{t("tracker.oiReadyToAnalyze")}</div>
        </Card>
      )}

      {latestAnalysis && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.textMuted, flexWrap: "wrap" }}>
          <span style={{ background: `${tierColor[latest.confidence_tier]}15`, color: tierColor[latest.confidence_tier], fontWeight: 700, padding: "3px 10px", borderRadius: 12 }}>{tierLabel[latest.confidence_tier]}</span>
          <span>{t("tracker.oiLastAnalyzed").replace("{date}", new Date(latest.generated_at).toLocaleDateString(language))}</span>
        </div>
      )}

      {/* Zone 2 -- Top AI Insights */}
      {latestAnalysis && (
        <Card>
          <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 12 }}>{t("tracker.oiTopInsights")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {(latestAnalysis.topInsights || []).map((ins, i) => (
              <div key={i} style={{ background: C.bgSoft, borderRadius: 10, padding: "12px 14px" }}>
                <div style={{ fontSize: 13, color: C.text, marginBottom: 4 }}>{ins.text}</div>
                <div style={{ fontSize: 11, color: C.textMuted }}>{ins.evidence}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Zone 3 -- What's Working / What to Change */}
      {latestAnalysis && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }} className="two-col">
          <Card>
            <div style={{ fontWeight: 700, fontSize: 14, color: C.green, marginBottom: 10 }}>✓ {t("tracker.oiWhatsWorking")}</div>
            {(latestAnalysis.whatWorking || []).map((w, i) => <div key={i} style={{ fontSize: 13, color: C.textMid, marginBottom: 8 }}>{w}</div>)}
          </Card>
          <Card>
            <div style={{ fontWeight: 700, fontSize: 14, color: C.orange, marginBottom: 10 }}>→ {t("tracker.oiWhatToChange")}</div>
            {(latestAnalysis.whatToChange || []).map((w, i) => <div key={i} style={{ fontSize: 13, color: C.textMid, marginBottom: 8 }}>{w}</div>)}
          </Card>
        </div>
      )}

      {/* Zone 4 -- Six Analysis Deep Dives: always rendered, each section independently
          shows a real finding or its own positive availability message. Works even
          before the very first Run Analysis click (latestAnalysis undefined). */}
      <OutcomeAnalysisDeepDives analysis={latestAnalysis} t={t} />

      {/* Zone 5 -- Recommendation Results: self-hides when there are none */}
      <RecommendationResults evaluations={evaluations} t={t} language={language} />

      {/* Zone 6 -- Analysis History */}
      {analyses.length > 1 && (
        <Card>
          <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 12 }}>{t("tracker.oiHistoryHeading")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {analyses.map(a => (
              <div key={a.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: C.textMid, padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
                <span>{new Date(a.generated_at).toLocaleDateString(language)}</span>
                <span style={{ color: tierColor[a.confidence_tier] }}>{tierLabel[a.confidence_tier]}</span>
                <span>{t("tracker.oiOutcomesLogged").replace("{n}", a.outcomes_logged_count)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

function TrackerPage({ applications, deleteApplication, saveApplication, resumes, savedJobs, smartApplyQueue, profile, isPremium, outcomePatternsHook, outcomeAnalysesHook, recommendationEvalHook, forceInsightsTab, onForceInsightsTabHandled }) {
  const { t } = useI18n();
  const tStatus = s => t(`tracker.${STATUS_LABEL_KEY[s]}`, s);
  const [tab, setTab] = useSessionState("cp_tracker_tab", "applications");
  // Dashboard's "Full Analysis" button always wants Insights, regardless of whatever
  // tab was last remembered here -- overrides cp_tracker_tab once, then hands control
  // back to normal remembered-tab behavior for any further in-Tracker navigation.
  useEffect(() => {
    if (!forceInsightsTab) return;
    setTab("insights");
    onForceInsightsTabHandled?.();
  }, [forceInsightsTab, setTab, onForceInsightsTabHandled]);
  const [showForm, setShowForm] = useState(false); const [editId, setEditId] = useState(null); const [form, setForm] = useState({ company: "", jobTitle: "", status: "Applied", date: new Date().toISOString().split("T")[0], atsScore: "", notes: "", url: "", followUpDate: "", contactName: "", contactEmail: "" }); const [filterStatus, setFilterStatus] = useSessionState("cp_tracker_filter", "All"); const [viewApp, setViewApp] = useState(null);
  const [formErrors, setFormErrors] = useState({});
  const [search, setSearch] = useSessionState("cp_tracker_search", "");
  const [deleteError, setDeleteError] = useState("");
  const [deletingId, setDeletingId] = useState(null);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);
  const [openStatusMenu, setOpenStatusMenu] = useState(null);
  const [updatingStatusId, setUpdatingStatusId] = useState(null);
  const [statusToast, setStatusToast] = useState(false);
  const statusToastTimer = useRef(null);
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" ? window.matchMedia("(max-width: 767px)").matches : false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = e => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const blankForm = { company: "", jobTitle: "", status: "Applied", date: new Date().toISOString().split("T")[0], atsScore: "", notes: "", url: "", followUpDate: "", contactName: "", contactEmail: "", rejectionStage: "", applicationSource: "", coverLetterSent: false, companySizeEstimate: "", industry: "", remotePolicy: "", referralUsed: false, salaryRangeMin: "", salaryRangeMax: "" };

  // Application Outcome Intelligence: response_received_at / first_interview_at are
  // set once, on first occurrence, never overwritten -- derived here (not in toRow,
  // which has no access to prior state) so both the quick-status dropdown and the
  // full edit form share one first-occurrence rule instead of two.
  const withOutcomeTimestamps = (existingApp, newStatus) => {
    const now = new Date().toISOString();
    const patch = {};
    if (newStatus !== "Applied" && !existingApp.responseReceivedAt) patch.responseReceivedAt = now;
    if (isInterviewStage(newStatus) && !existingApp.firstInterviewAt) patch.firstInterviewAt = now;
    return patch;
  };

  // Quick status change from the row-level dropdown -- reuses the same saveApplication
  // (upsert) path as the full edit form, just with only `status` changed, so there is
  // no second/duplicate write path and no risk of clobbering the app's other fields.
  const quickUpdateStatus = async (app, newStatus) => {
    setOpenStatusMenu(null);
    if (app.status === newStatus) return;
    setUpdatingStatusId(app.id);
    setSaveError("");
    try {
      await saveApplication({ ...app, status: newStatus, ...withOutcomeTimestamps(app, newStatus) });
      if (statusToastTimer.current) clearTimeout(statusToastTimer.current);
      setStatusToast(true);
      statusToastTimer.current = setTimeout(() => setStatusToast(false), 3500);
    } catch {
      setSaveError(t("tracker.saveFailed"));
    } finally {
      setUpdatingStatusId(null);
    }
  };

  const save = async () => {
    const errors = {};
    if (!form.company.trim()) errors.company = t("tracker.companyRequired");
    if (!form.jobTitle.trim()) errors.jobTitle = t("tracker.jobTitleRequired");
    let atsClean = form.atsScore;
    if (form.atsScore !== "" && form.atsScore !== null) {
      const n = Number(form.atsScore);
      if (isNaN(n)) errors.atsScore = t("tracker.atsScoreNumber");
      else if (n < 0 || n > 100) errors.atsScore = t("tracker.atsScoreRange");
      else atsClean = String(Math.round(n));
    }
    if (form.date && form.followUpDate && form.followUpDate < form.date) {
      errors.followUpDate = t("tracker.followUpBeforeApply");
    }
    const dupe = applications.find(a =>
      a.id !== editId &&
      (a.company || "").trim().toLowerCase() === form.company.trim().toLowerCase() &&
      (a.jobTitle || "").trim().toLowerCase() === form.jobTitle.trim().toLowerCase()
    );
    if (dupe) errors.company = t("tracker.duplicateApplication").replace("{title}", form.jobTitle).replace("{company}", form.company);

    const { values: contactValues, errors: contactErrors } = validateFields(form,
      { contactName: "fullName", contactEmail: "email" }, {});
    if (contactErrors.contactEmail) errors.contactEmail = t("tracker.invalidContactEmail");

    if (Object.keys(errors).length > 0) { setFormErrors(errors); return; }
    setFormErrors({});
    setSaveError("");

    const salaryMinClean = form.salaryRangeMin !== "" && form.salaryRangeMin != null ? Number(form.salaryRangeMin) : null;
    const salaryMaxClean = form.salaryRangeMax !== "" && form.salaryRangeMax != null ? Number(form.salaryRangeMax) : null;
    const cleanForm = { ...form, atsScore: atsClean, contactName: contactValues.contactName, contactEmail: contactValues.contactEmail, salaryRangeMin: salaryMinClean, salaryRangeMax: salaryMaxClean };
    const priorApp = editId ? (applications.find(a => a.id === editId) || {}) : {};
    const fullApp = editId
      ? { ...priorApp, ...cleanForm, ...withOutcomeTimestamps(priorApp, cleanForm.status) }
      : { ...cleanForm, id: uid(), ...withOutcomeTimestamps({}, cleanForm.status) };

    setSaving(true);
    try {
      await saveApplication(fullApp); // DB upsert + root setApplications
      setEditId(null);
      setForm(blankForm);
      setShowForm(false);
    } catch {
      setSaveError(t("tracker.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const del = async (id) => {
    setDeleteError("");
    setDeletingId(id);
    try {
      await deleteApplication(id); // confirmed Supabase delete first
      if (viewApp?.id === id) setViewApp(null);
    } catch {
      setDeleteError(t("tracker.deleteFailed"));
    } finally {
      setDeletingId(null);
    }
  };
  const edit = app => { setForm({ ...blankForm, ...app }); setEditId(app.id); setShowForm(true); setViewApp(null); setFormErrors({}); };
  const closeForm = () => { setShowForm(false); setEditId(null); setFormErrors({}); setForm(blankForm); };

  const filtered = applications.filter(a => {
    const statusOk = filterStatus === "All" || a.status === filterStatus;
    const q = search.trim().toLowerCase();
    const searchOk = !q || (a.company || "").toLowerCase().includes(q) || (a.jobTitle || "").toLowerCase().includes(q);
    return statusOk && searchOk;
  });

  const stats = STATUSES.reduce((acc, s) => { acc[s] = applications.filter(a => a.status === s).length; return acc; }, {});
  const decided = (stats["Offer"] || 0) + (stats["Rejected"] || 0) + (stats["Withdrawn"] || 0);
  const successRate = decided > 0 ? Math.round(((stats["Offer"] || 0) / decided) * 100) : null;

  return (
    <div>
      {deleteError && <div style={{ background: "#FEF2F2", border: "1.5px solid #FCA5A5", borderRadius: 8, padding: "10px 14px", marginBottom: 12, color: "#DC2626", fontSize: 13 }}>{deleteError}</div>}
      {saveError && <div style={{ background: "#FEF2F2", border: "1.5px solid #FCA5A5", borderRadius: 8, padding: "10px 14px", marginBottom: 12, color: "#DC2626", fontSize: 13 }}>{saveError}</div>}
      {/* Quick status-change confirmation -- same fixed-position toast pattern used
          by Job Tracker's track confirmation, for visual consistency across the app. */}
      {statusToast && (
        <div style={{ position: "fixed", left: 0, right: 0, bottom: isMobile ? "calc(20px + env(safe-area-inset-bottom, 0px))" : 24, display: "flex", justifyContent: isMobile ? "center" : "flex-end", padding: isMobile ? "0 16px" : "0 24px", zIndex: 60, pointerEvents: "none" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, background: C.greenLight, border: `1px solid ${C.green}30`, borderRadius: 10, padding: "10px 16px", fontSize: 13, color: C.text, fontWeight: 500, maxWidth: isMobile ? "calc(100vw - 32px)" : 420, boxShadow: "0 8px 24px rgba(0,0,0,0.15)", pointerEvents: "auto", animation: isMobile ? "cp-toast-in-mobile 0.35s ease-out" : "cp-toast-in 0.25s ease-out" }}>
            <span style={{ fontSize: 16 }}>✓</span>
            <span>{t("tracker.statusUpdated")}</span>
          </div>
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 10 }}>
        <div><h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 4 }}>{t("tracker.heading")}</h1><p style={{ color: C.textMuted, fontSize: 15 }}>{t("tracker.applicationsTracked").replace("{n}", applications.length)}</p><p style={{ color: C.textMuted, fontSize: 13, marginTop: 4 }}>{t("tracker.workflowHintAction")}</p><p style={{ color: C.textMuted, fontSize: 13 }}>{t("tracker.workflowHintWhy")}</p></div>
        <Btn onClick={() => { setShowForm(true); setEditId(null); }} style={{ padding: "12px 24px" }}>{t("tracker.addApplication")}</Btn>
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 20, borderBottom: `1px solid ${C.border}` }}>
        <button onClick={() => setTab("applications")} style={{ padding: "10px 4px", marginRight: 20, background: "none", border: "none", borderBottom: `2px solid ${tab === "applications" ? C.purple : "transparent"}`, color: tab === "applications" ? C.purple : C.textMuted, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>{t("tracker.applicationsTab")}</button>
        <button onClick={() => setTab("insights")} style={{ padding: "10px 4px", marginRight: 20, background: "none", border: "none", borderBottom: `2px solid ${tab === "insights" ? C.purple : "transparent"}`, color: tab === "insights" ? C.purple : C.textMuted, fontSize: 14, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
          {t("tracker.insightsTab")}
          {!isPremium && <span style={{ fontSize: 10, fontWeight: 800, color: C.purple, background: C.purpleLight, padding: "2px 7px", borderRadius: 10 }}>{t("tracker.premiumBadge")}</span>}
        </button>
      </div>
      {tab === "insights" && (
        <OutcomeIntelligencePanel
          applications={applications}
          savedJobs={savedJobs}
          smartApplyQueue={smartApplyQueue}
          profile={profile}
          isPremium={isPremium}
          patternsHook={outcomePatternsHook}
          analysesHook={outcomeAnalysesHook}
          recommendationEvalHook={recommendationEvalHook}
        />
      )}
      {tab === "applications" && applications.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 16, overflowX: "auto", paddingBottom: 4 }}>
          <div onClick={() => setFilterStatus("All")} style={{ cursor: "pointer", background: `${NEUTRAL_FILTER_COLOR}12`, border: `1.5px solid ${filterStatus === "All" ? NEUTRAL_FILTER_COLOR : NEUTRAL_FILTER_COLOR + "30"}`, borderRadius: 12, padding: "10px 18px", flexShrink: 0, textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 800, color: NEUTRAL_FILTER_COLOR }}>{applications.length}</div><div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{t("tracker.total")}</div></div>
          {STATUSES.filter(s => stats[s] > 0).map(s => <div key={s} onClick={() => setFilterStatus(filterStatus === s ? "All" : s)} style={{ cursor: "pointer", background: `${SCOLOR[s]}12`, border: `1.5px solid ${filterStatus === s ? SCOLOR[s] : SCOLOR[s] + "30"}`, borderRadius: 12, padding: "10px 18px", flexShrink: 0, textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 800, color: SCOLOR[s] }}>{stats[s]}</div><div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{tStatus(s)}</div></div>)}
          {successRate !== null && <div style={{ background: `${C.green}12`, border: `1.5px solid ${C.green}40`, borderRadius: 12, padding: "10px 18px", flexShrink: 0, textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 800, color: C.green }}>{successRate}%</div><div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{t("tracker.successRate")}</div></div>}
        </div>
      )}
      {tab === "applications" && <>
      {applications.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t("tracker.searchPlaceholder")} style={{ width: "100%", border: `1.5px solid ${C.border}`, borderRadius: 9, padding: "10px 14px", fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit" }} />
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {["All", ...STATUSES].map(s => <Btn key={s} variant="ghost" style={{ padding: "6px 14px", borderRadius: 8, border: `1.5px solid ${filterStatus === s ? SCOLOR[s] || NEUTRAL_FILTER_COLOR : C.border}`, background: filterStatus === s ? `${SCOLOR[s] || NEUTRAL_FILTER_COLOR}12` : "#fff", color: filterStatus === s ? SCOLOR[s] || NEUTRAL_FILTER_COLOR : C.textMuted, fontSize: 12, fontWeight: 600 }} onClick={() => setFilterStatus(s)}>{s === "All" ? t("tracker.all") : tStatus(s)}</Btn>)}
      </div>
      {showForm && (
        <Card style={{ marginBottom: 20, border: `1.5px solid ${C.purple}30` }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 18 }}>{editId ? t("tracker.editApplication") : t("tracker.addApplicationTitle")}</div>
          {Object.keys(formErrors).length > 0 && (
            <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: "10px 14px", marginBottom: 14, color: C.red, fontSize: 13 }}>
              {Object.values(formErrors).map((e, i) => <div key={i}>• {e}</div>)}
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }} className="two-col">
            <div><Input label={t("tracker.companyLabel")} placeholder={t("tracker.companyPlaceholder")} value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value }))} style={formErrors.company ? { borderColor: C.red } : {}} />{formErrors.company && <div style={{ fontSize: 12, color: C.red, marginTop: 4 }}>{formErrors.company}</div>}</div>
            <div><Input label={t("tracker.jobTitleLabel")} placeholder={t("tracker.jobTitlePlaceholder")} value={form.jobTitle} onChange={e => setForm(f => ({ ...f, jobTitle: e.target.value }))} style={formErrors.jobTitle ? { borderColor: C.red } : {}} />{formErrors.jobTitle && <div style={{ fontSize: 12, color: C.red, marginTop: 4 }}>{formErrors.jobTitle}</div>}</div>
            <Input label={t("tracker.dateAppliedLabel")} type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
            <div><Input label={t("tracker.followUpDateLabel")} type="date" value={form.followUpDate} onChange={e => setForm(f => ({ ...f, followUpDate: e.target.value }))} style={formErrors.followUpDate ? { borderColor: C.red } : {}} />{formErrors.followUpDate && <div style={{ fontSize: 12, color: C.red, marginTop: 4 }}>{formErrors.followUpDate}</div>}</div>
            <div><Input label={t("tracker.atsScoreLabel")} type="number" min="0" max="100" placeholder={t("tracker.atsScorePlaceholder")} value={form.atsScore} onChange={e => setForm(f => ({ ...f, atsScore: e.target.value }))} style={formErrors.atsScore ? { borderColor: C.red } : {}} />{formErrors.atsScore && <div style={{ fontSize: 12, color: C.red, marginTop: 4 }}>{formErrors.atsScore}</div>}</div>
            <Input label={t("tracker.contactNameLabel")} placeholder={t("tracker.contactNamePlaceholder")} value={form.contactName} onChange={e => setForm(f => ({ ...f, contactName: e.target.value }))} />
            <div><Input label={t("tracker.contactEmailLabel")} type="email" placeholder={t("tracker.contactEmailPlaceholder")} value={form.contactEmail} onChange={e => setForm(f => ({ ...f, contactEmail: e.target.value }))} style={formErrors.contactEmail ? { borderColor: C.red } : {}} />{formErrors.contactEmail && <div style={{ fontSize: 12, color: C.red, marginTop: 4 }}>{formErrors.contactEmail}</div>}</div>
            <div style={{ gridColumn: "1 / -1" }}><Input label={t("tracker.jobUrlLabel")} placeholder={t("tracker.jobUrlPlaceholder")} value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} /></div>
          </div>
          {/* Optional -- powers Application Outcome Intelligence pattern analysis. Never
              required, since the feature is designed to degrade gracefully with partial
              data (see blueprint §3, data completeness factor). */}
          <div style={{ marginTop: 4, marginBottom: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 10 }}>{t("tracker.outcomeDetailsHeading")}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }} className="two-col">
              <Select label={t("tracker.applicationSourceLabel")} value={form.applicationSource} onChange={e => setForm(f => ({ ...f, applicationSource: e.target.value }))}>
                <option value="">{t("tracker.notSpecified")}</option>
                <option value="linkedin">{t("tracker.sourceLinkedin")}</option>
                <option value="indeed">{t("tracker.sourceIndeed")}</option>
                <option value="company_website">{t("tracker.sourceCompanyWebsite")}</option>
                <option value="referral">{t("tracker.sourceReferral")}</option>
                <option value="direct">{t("tracker.sourceDirect")}</option>
              </Select>
              <Select label={t("tracker.companySizeLabel")} value={form.companySizeEstimate} onChange={e => setForm(f => ({ ...f, companySizeEstimate: e.target.value }))}>
                <option value="">{t("tracker.notSpecified")}</option>
                <option value="startup">{t("tracker.sizeStartup")}</option>
                <option value="small">{t("tracker.sizeSmall")}</option>
                <option value="mid">{t("tracker.sizeMid")}</option>
                <option value="large">{t("tracker.sizeLarge")}</option>
                <option value="enterprise">{t("tracker.sizeEnterprise")}</option>
              </Select>
              <Input label={t("tracker.industryLabel")} placeholder={t("tracker.industryPlaceholder")} value={form.industry} onChange={e => setForm(f => ({ ...f, industry: e.target.value }))} />
              <Select label={t("tracker.remotePolicyLabel")} value={form.remotePolicy} onChange={e => setForm(f => ({ ...f, remotePolicy: e.target.value }))}>
                <option value="">{t("tracker.notSpecified")}</option>
                <option value="remote">{t("tracker.policyRemote")}</option>
                <option value="hybrid">{t("tracker.policyHybrid")}</option>
                <option value="onsite">{t("tracker.policyOnsite")}</option>
              </Select>
              <Input label={t("tracker.salaryRangeMinLabel")} type="number" min="0" placeholder="120000" value={form.salaryRangeMin} onChange={e => setForm(f => ({ ...f, salaryRangeMin: e.target.value }))} />
              <Input label={t("tracker.salaryRangeMaxLabel")} type="number" min="0" placeholder="160000" value={form.salaryRangeMax} onChange={e => setForm(f => ({ ...f, salaryRangeMax: e.target.value }))} />
              {form.status === "Rejected" && (
                <Select label={t("tracker.rejectionStageLabel")} value={form.rejectionStage} onChange={e => setForm(f => ({ ...f, rejectionStage: e.target.value }))}>
                  <option value="">{t("tracker.notSpecified")}</option>
                  <option value="ats">{t("tracker.stageAts")}</option>
                  <option value="phone_screen">{t("tracker.stagePhoneScreen")}</option>
                  <option value="technical">{t("tracker.stageTechnical")}</option>
                  <option value="final_round">{t("tracker.stageFinalRound")}</option>
                  <option value="offer_stage">{t("tracker.stageOfferStage")}</option>
                </Select>
              )}
            </div>
            <div style={{ display: "flex", gap: 20, marginTop: 12 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.textMid, cursor: "pointer" }}>
                <input type="checkbox" checked={form.coverLetterSent} onChange={e => setForm(f => ({ ...f, coverLetterSent: e.target.checked }))} />
                {t("tracker.coverLetterSentLabel")}
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: C.textMid, cursor: "pointer" }}>
                <input type="checkbox" checked={form.referralUsed} onChange={e => setForm(f => ({ ...f, referralUsed: e.target.checked }))} />
                {t("tracker.referralUsedLabel")}
              </label>
            </div>
          </div>
          <div style={{ marginBottom: 16 }}><Textarea label={t("tracker.notesLabel")} placeholder={t("tracker.notesPlaceholder")} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ minHeight: 200 }} /></div>
          <div style={{ display: "flex", gap: 10 }}><Btn onClick={save} disabled={saving}>{saving ? t("tracker.saving") : t("tracker.saveApplication")}</Btn><Btn variant="secondary" onClick={closeForm} disabled={saving}>{t("tracker.cancel")}</Btn></div>
        </Card>
      )}
      {filtered.length === 0 && !showForm && <Card style={{ textAlign: "center", padding: 56 }}><div style={{ fontSize: 40, marginBottom: 14 }}>📋</div><div style={{ fontWeight: 700, fontSize: 16, color: C.text, marginBottom: 6 }}>{applications.length === 0 ? t("tracker.noApplicationsYet") : t("tracker.noMatchesFound")}</div><div style={{ fontSize: 14, color: C.textMuted }}>{applications.length === 0 ? t("tracker.addManuallyHint") : t("tracker.tryDifferentSearch")}</div></Card>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {filtered.map(app => (
          <div key={app.id} style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 14, padding: "16px 20px", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{app.jobTitle || t("tracker.untitledRole")}</div>
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>{app.company || t("tracker.unknownCompany")}{app.date ? t("tracker.appliedOn").replace("{date}", app.date) : ""}</div>
                {app.followUpDate && <div style={{ fontSize: 12, color: C.yellow, marginTop: 3, fontWeight: 500 }}>{t("tracker.followUp").replace("{date}", app.followUpDate)}</div>}
                {app.contactName && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>👤 {app.contactName}{app.contactEmail ? ` · ${app.contactEmail}` : ""}</div>}
                {app.resumeId && resumes && (() => { const r = resumes.find(x => x.id === app.resumeId); return r ? <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>📄 {r.name}{r.version_label ? ` · ${r.version_label}` : ""}</div> : null; })()}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", flexBasis: isMobile ? "100%" : "auto", minWidth: 0 }}>
                {/* flexBasis:100% on mobile makes this whole actions cluster claim the
                    full card width once it wraps below the info block -- without this,
                    the inner Status/View/Edit/Delete group's own flexBasis:100% would
                    only be 100% of THIS wrapper's shrink-to-fit width, not the card's. */}
                {app.atsScore > 0 && <span style={{ fontSize: 12, color: C.blue, fontWeight: 700, background: C.blueLight, padding: "3px 9px", borderRadius: 6, flexShrink: 0 }}>ATS {app.atsScore}</span>}
                {app.url && <a href={app.url} target="_blank" rel="noreferrer" className="btn-link" style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, background: "transparent", padding: "5px 12px", border: `1px solid ${C.border}`, borderRadius: 10, textDecoration: "none", display: "inline-flex", alignItems: "center", flexShrink: 0 }}>{t("tracker.job")}</a>}
                {/* Status, View, Edit, Delete always stay together on one row, in a fixed
                    order and spacing, regardless of viewport or which status is selected.
                    flexWrap:nowrap guarantees they never break onto separate lines. No
                    overflowX here deliberately: setting overflow-x clips overflow-y too
                    (CSS spec forces the visible axis to become "auto" once the other isn't
                    visible), which silently clipped the status dropdown menu -- a real
                    regression caught in production. The Status pill (below) is therefore
                    kept OUTSIDE any overflow container, always; only View/Edit/Delete
                    (plain buttons with no dropdown of their own) sit inside one, as a
                    genuine fallback for extreme widths rather than something that can
                    ever reclip the menu. */}
                <div style={{ display: "flex", alignItems: "center", gap: isMobile ? 0 : 6, flexWrap: "nowrap", flexBasis: isMobile ? "100%" : "auto", minWidth: 0, justifyContent: isMobile ? "space-between" : "flex-start" }}>
                  {/* Status Indicator -- the status display IS the status control, same
                      dropdown-on-click pattern as the Networking module's contact status pill.
                      flexBasis:100% on mobile forces this group onto its own full-width line
                      (pushing any ATS/Job badges above it) and justifyContent:space-between
                      spreads Status and the View/Edit/Delete cluster across that width instead
                      of clustering them left with dead space on the right. */}
                  <div style={{ position: "relative", display: "inline-block", flexShrink: 0 }}>
                    <Btn variant="ghost" title={app.status ? tStatus(app.status) : t("tracker.statusUnknown")} style={{ width: STATUS_INDICATOR_WIDTH, flexShrink: 0, justifyContent: "center", gap: 0, borderRadius: 20, padding: "5px 6px", fontSize: 12, background: `${SCOLOR[app.status] || C.textMuted}15`, color: SCOLOR[app.status] || C.textMuted, border: `1px solid ${SCOLOR[app.status] || C.textMuted}30` }} loading={updatingStatusId === app.id} onClick={() => setOpenStatusMenu(openStatusMenu === app.id ? null : app.id)}>
                      {/* gap:0 above overrides Btn's base flex gap so this margin is the
                          ONLY space between the dot and the label -- avoids the two rules
                          stacking into a double gap. */}
                      <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: SCOLOR[app.status] || C.textMuted, marginRight: 4, flexShrink: 0 }} />
                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", textAlign: "center" }}>{app.status ? tStatus(app.status) : t("tracker.statusUnknown")} ▾</span>
                    </Btn>
                    {openStatusMenu === app.id && (
                      <div>
                        <div onClick={() => setOpenStatusMenu(null)} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 49 }} />
                        {/* left:0 (not right:0) so the menu's left edge aligns with the
                            trigger's left edge, opening directly beneath the pill --
                            matches the Networking module's contact status dropdown. The
                            trigger is now the leftmost item in a full-width mobile row, so
                            right-anchoring would extend the menu off the left edge of the
                            card instead of sitting under the pill. */}
                        <div style={{ position: "absolute", top: "110%", left: 0, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 50, minWidth: 190, overflow: "hidden" }}>
                          {STATUSES.map(s => (
                            <Btn key={s} variant="ghost" style={{ width: "100%", borderRadius: 0, border: "none", padding: "10px 14px", background: app.status === s ? C.bgSoft : "#fff", color: C.text, fontSize: 13, fontWeight: 600, justifyContent: "flex-start" }} onClick={() => quickUpdateStatus(app, s)}>
                              <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: SCOLOR[s], marginRight: 9, flexShrink: 0 }} />
                              {tStatus(s)}
                            </Btn>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                  {/* View/Edit/Delete have no dropdown or other overflowing descendant, so
                      it's safe to give this cluster its own scroll fallback -- unlike the
                      Status pill above, clipping here can never hide an open menu. */}
                  <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "nowrap", overflowX: "auto", minWidth: 0 }}>
                    {(app.resume || app.coverLetter || app.notes) && <Btn variant="ghost" style={{ padding: "5px 8px", fontSize: 12, flexShrink: 0, whiteSpace: "nowrap" }} onClick={() => setViewApp(viewApp?.id === app.id ? null : app)}>{t("tracker.view")}</Btn>}
                    <Btn variant="ghost" style={{ padding: "5px 8px", fontSize: 12, flexShrink: 0, whiteSpace: "nowrap" }} onClick={() => edit(app)}>{t("tracker.edit")}</Btn>
                    <Btn variant="danger" style={{ padding: "5px 9px", fontSize: 12, flexShrink: 0 }} loading={deletingId === app.id} onClick={() => del(app.id)}>✕</Btn>
                  </div>
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
      {viewApp && (
        <Card style={{ marginTop: 16, border: `1.5px solid ${SCOLOR[viewApp.status]}30` }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}>
            <div style={{ fontSize: 16, fontWeight: 700 }}>{viewApp.jobTitle} — {viewApp.company}</div>
            <Btn variant="ghost" style={{ padding: "5px 12px" }} onClick={() => setViewApp(null)}>✕</Btn>
          </div>
          {viewApp.resume && <div style={{ marginBottom: 16 }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><Label>{t("tracker.tailoredResume")}</Label><div style={{ display: "flex", gap: 6 }}><Btn variant="ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => downloadPDF(viewApp.resume, "resume")}>{t("tracker.pdf")}</Btn><CopyBtn text={viewApp.resume} label={t("tracker.copy")} /></div></div><ContentDisplay content={viewApp.resume} /></div>}
          {viewApp.coverLetter && <div style={{ marginBottom: 16 }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><Label>{t("tracker.coverLetter")}</Label><div style={{ display: "flex", gap: 6 }}><Btn variant="ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => downloadPDF(viewApp.coverLetter, "cover-letter")}>{t("tracker.pdf")}</Btn><CopyBtn text={viewApp.coverLetter} label={t("tracker.copy")} /></div></div><ContentDisplay content={viewApp.coverLetter} /></div>}
          {viewApp.notes && <div><Label>{t("tracker.notes")}</Label><div style={{ fontSize: 14, lineHeight: 1.7, color: C.text, padding: "12px 0" }}>{viewApp.notes}</div></div>}
        </Card>
      )}
      </>}
    </div>
  );
}

// ─── SALARY PAGE ───────────────────────────────────────────
function SalaryPage({ profile, applications, savedJobs }) {
  const { t } = useI18n();
  const [form, setForm] = useState({ jobTitle: profile?.preferred_job_title || "", location: profile?.location || "", experience: profile?.years_experience || "", skills: "", company: "" });
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false); const [error, setError] = useState("");

  const { data: savedSearch, loading: searchLoading, loadedFor: searchLoadedFor, save: saveSearch } = useSalaryResearch(profile?.id);
  const [loadApplied, setLoadApplied] = useState(false);
  const appliedForRef = useRef(undefined);
  const saveTimerRef = useRef(null);
  const userContext = useUserContext({ profile, applications, savedJobs });

  // ── Load once the Supabase fetch for this user resolves ──
  // Gated on `searchLoadedFor === profile?.id` (not just `!searchLoading`) so a
  // stale render — where loading already cleared for the previous user right as
  // profile.id flips to the real one — can't be mistaken for "loaded".
  useEffect(() => {
    if (searchLoading || searchLoadedFor !== profile?.id) return;
    if (appliedForRef.current === profile?.id) return;
    appliedForRef.current = profile?.id;
    if (savedSearch) {
      setForm(f => ({ ...f, ...savedSearch.form }));
      setResults(savedSearch.results);
    }
    setLoadApplied(true);
  }, [savedSearch, searchLoading, searchLoadedFor, profile?.id]);

  // ── Save on change (debounced) — keeps the form and results in sync with Supabase ──
  useEffect(() => {
    if (!loadApplied || !form.jobTitle) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveSearch(form, results).catch(() => {});
    }, 600);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [loadApplied, form, results, saveSearch]);
  const fmt = n => (n !== undefined && n !== null && n !== "" && !isNaN(Number(n))) ? `$${Number(n).toLocaleString()}` : "—";
  const txt = (v, fallback = "—") => (v !== undefined && v !== null && String(v).trim() !== "") ? v : fallback;

  // Safe JSON parse with truncation recovery (same approach as Interview page)
  const safeParse = (raw) => {
    try { return JSON.parse(raw); }
    catch {
      const start = raw.indexOf("{") >= 0 ? raw.indexOf("{") : raw.indexOf("[");
      const end = raw.lastIndexOf("}") >= 0 ? raw.lastIndexOf("}") : raw.lastIndexOf("]");
      if (start >= 0 && end > start) {
        try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
      }
      return null;
    }
  };

  const analyze = async () => {
    if (!form.jobTitle || !form.location) { setError(t("salary.titleLocationRequired")); return; }
    setError(""); setLoading(true); setResults(null);
    try {
      const ctx = userContext.getContextString({ identity: true, applications: true });
      const companyBlock = form.company ? `, company type: ${form.company}` : "";
      const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}2026 salary data. Return ONLY JSON, no markdown:
{"salaryRange":{"low":<n>,"median":<n>,"high":<n>},"totalComp":{"median":<n>},"equityRange":"<range>","bonusRange":"<range>","topPayingCompanies":[{"name":"<co>","avgComp":"<c>"},{"name":"<co>","avgComp":"<c>"},{"name":"<co>","avgComp":"<c>"}],"salaryByExperience":[{"level":"Entry","salary":<n>},{"level":"Mid","salary":<n>},{"level":"Senior","salary":<n>}],"negotiationTips":["<t1>","<t2>","<t3>"],"marketOutlook":"<2 sentence outlook>","skillPremiums":[{"skill":"<s>","premium":"<p>"},{"skill":"<s>","premium":"<p>"}],"benchmarkInsight":"<1 sentence>","demandLevel":"<High|Medium|Low>","jobOpenings":"<estimate>"}
${form.jobTitle} in ${form.location}, ${form.experience || "any"} exp, skills: ${form.skills || "general"}${companyBlock}`, 2500, "salary_analysis");
      const parsed = safeParse(raw);
      if (!parsed || !parsed.salaryRange) {
        setError(t("salary.incompleteData"));
      } else {
        setResults(parsed);
        insertNotification(profile?.id, { type: "salary", title: "Salary report ready.", body: "Your salary and market report is ready to view." });
        // Save immediately so quick navigation doesn't race the 600ms debounce
        saveSearch(form, parsed).catch(() => {});
      }
    } catch (e) {
      setError(t("salary.serviceUnreachable"));
    } finally { setLoading(false); }
  };

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 6 }}>{t("salary.heading")}</h1>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24 }}>{t("salary.subtitle")}</p>
      <Card style={{ marginBottom: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }} className="two-col">
          <Input label={t("salary.jobTitleLabel")} placeholder={t("salary.jobTitlePlaceholder")} value={form.jobTitle} onChange={e => setForm(f => ({ ...f, jobTitle: e.target.value }))} />
          <Input label={t("salary.locationLabel")} placeholder={t("salary.locationPlaceholder")} value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} />
          <Input label={t("salary.experienceLabel")} placeholder={t("salary.experiencePlaceholder")} value={form.experience} onChange={e => setForm(f => ({ ...f, experience: e.target.value }))} />
          <Input label={t("salary.skillsLabel")} placeholder={t("salary.skillsPlaceholder")} value={form.skills} onChange={e => setForm(f => ({ ...f, skills: e.target.value }))} />
          <div style={{ gridColumn: "1 / -1" }}><Input label={t("salary.companyTypeLabel")} placeholder={t("salary.companyTypePlaceholder")} value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value }))} /></div>
        </div>
        {error && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, color: C.red, fontSize: 13, marginBottom: 14 }}>{error}</div>}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Btn onClick={analyze} loading={loading} style={{ padding: "13px 28px" }}>{loading ? t("salary.calculating") : t("salary.getSalaryData")}</Btn>
          {results && <Btn variant="secondary" onClick={() => { setResults(null); setError(""); }}>{t("salary.newSearch")}</Btn>}
        </div>
      </Card>
      {loading && <Spinner steps={[t("salary.step1"), t("salary.step2"), t("salary.step3")]} currentStep={1} />}
      {results && (
        <div>
          <div style={{ fontSize: 11, color: C.textMuted, fontStyle: "italic", marginBottom: 12, padding: "8px 12px", background: C.bgSoft, borderRadius: 8, border: `1px solid ${C.border}` }}>
            {t("salary.disclaimer")}
          </div>
          <Card style={{ marginBottom: 16, background: `linear-gradient(135deg, ${C.purpleLight}, #fff)`, border: `1.5px solid ${C.purple}20` }}>
            <div style={{ fontSize: 14, color: C.purple, fontWeight: 600, marginBottom: 16 }}>{txt(results.benchmarkInsight, t("salary.estimatedCompFallback"))}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 0, borderBottom: `1px solid ${C.border}`, marginBottom: 18, paddingBottom: 18 }} className="three-col">
              {[[t("salary.low"), results.salaryRange?.low, C.textMuted], [t("salary.median"), results.salaryRange?.median, C.purple], [t("salary.high"), results.salaryRange?.high, C.green]].map(([l, v, c]) => (
                <div key={l} style={{ textAlign: "center", borderRight: l !== t("salary.high") ? `1px solid ${C.border}` : "none", padding: "8px 0" }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: c }}>{fmt(v)}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>{t("salary.salarySuffix").replace("{level}", l)}</div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {[[t("salary.totalCompMedian"), fmt(results.totalComp?.median), C.purple], [t("salary.equity"), txt(results.equityRange), C.yellow], [t("salary.bonus"), txt(results.bonusRange), C.green], [t("salary.marketDemand"), tStatusVal(results.demandLevel, t) || txt(results.demandLevel), C.blue]].map(([l, v, c]) => (
                <div key={l} style={{ background: `${c}12`, border: `1px solid ${c}25`, borderRadius: 10, padding: "10px 16px" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: c }}>{v}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>{l}</div>
                </div>
              ))}
            </div>
          </Card>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }} className="two-col">
            <Card>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 14 }}>{t("salary.salaryByExperience")}</div>
              {results.salaryByExperience?.map(({ level, salary }) => {
                const vals = results.salaryByExperience.map(x => Number(x.salary) || 0);
                const max = Math.max(...vals, 1);
                return <div key={level} style={{ marginBottom: 12 }}><div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}><span style={{ color: C.textMid }}>{level}</span><span style={{ color: C.purple, fontWeight: 700 }}>{fmt(salary)}</span></div><PBar val={Math.round(((Number(salary) || 0)/max)*100)} color={C.purple} /></div>;
              })}
            </Card>
            <Card>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 14 }}>{t("salary.skillPremiums")}</div>
              {results.skillPremiums?.map(({ skill, premium }) => (
                <div key={skill} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                  <span style={{ fontSize: 14, color: C.text }}>{skill}</span>
                  <span style={{ fontSize: 13, fontWeight: 700, color: C.green }}>{premium}</span>
                </div>
              ))}
            </Card>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }} className="two-col">
            <Card>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 14 }}>{t("salary.topPayingCompanies")}</div>
              {results.topPayingCompanies?.map(({ name, avgComp }, i) => (
                <div key={name} style={{ display: "flex", justifyContent: "space-between", padding: "10px 0", borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                    <span style={{ width: 22, height: 22, background: C.purpleLight, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: C.purple }}>{i+1}</span>
                    <span style={{ fontSize: 14 }}>{name}</span>
                  </div>
                  <span style={{ fontSize: 13, fontWeight: 700, color: C.green }}>{avgComp}</span>
                </div>
              ))}
            </Card>
            <Card>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 14 }}>{t("salary.negotiationTips")}</div>
              {results.negotiationTips?.map((tip, i) => (
                <div key={i} style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                  <span style={{ width: 20, height: 20, background: C.blueLight, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: C.blue, flexShrink: 0 }}>{i+1}</span>
                  <span style={{ fontSize: 13, lineHeight: 1.7, color: C.text }}>{tip}</span>
                </div>
              ))}
            </Card>
          </div>
          {results.marketOutlook && (
            <Card style={{ marginTop: 16, border: `1px solid ${C.green}25` }}>
              <div style={{ fontSize: 12, color: C.green, fontWeight: 700, marginBottom: 10 }}>{t("salary.marketOutlook")}</div>
              <div style={{ fontSize: 14, lineHeight: 1.8, color: C.text }}>{results.marketOutlook}</div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// ─── NETWORKING PAGE ───────────────────────────────────────
function NetworkingPage({ profile, applications, savedJobs, isPremium, watchlist, referralPatterns, referralAnalysesHook }) {
  const { t } = useI18n();
  // Outer tab: Outreach (everything that already existed, untouched below) vs.
  // Intelligence (new, Phase 2 stub only -- real functionality lands in Phase 6).
  // Separate from `tab` (the existing linkedin/email/followup/tips selector) so
  // neither state touches the other.
  const [mainTab, setMainTab] = useSessionState("cp_net_maintab", "outreach");
  const { form, setForm, results, setResults, draft, setDraft, emailTo, setEmailTo, emailSent, setEmailSent } = useNetworkingSession(profile?.id, { yourBackground: profile?.job_title ? (profile.full_name ? profile.full_name + ", " : "") + profile.job_title + (profile.years_experience ? " with " + profile.years_experience + " years experience" : "") : "" });
  const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [tab, setTab] = useSessionState("cp_net_tab", "linkedin");
  const [savedContacts, setSavedContacts] = useNetworkingContacts(profile?.id);
  const [showSavePrompt, setShowSavePrompt] = useState(false);
  const [openStatusMenu, setOpenStatusMenu] = useState(null);
  const statusColors = {"Waiting for Reply": C.yellow, "Replied": C.green, "Met": "#7C3AED", "Connected": C.blue, "No Response": C.red};
  const statusEmoji = {"Waiting for Reply": "🟡", "Replied": "🟢", "Met": "🟣", "Connected": "🔵", "No Response": "🔴"};
  const NET_STATUS_LABEL_KEY = { "Waiting for Reply": "networking.statusWaiting", "Replied": "networking.statusReplied", "Met": "networking.statusMet", "Connected": "networking.statusConnected", "No Response": "networking.statusNoResponse" };
  const tStatus = (s) => t(NET_STATUS_LABEL_KEY[s] || s);
  const [fuContact, setFuContact] = useState(null);
  const [fuDraft, setFuDraft] = useState("");
  const [fuLoading, setFuLoading] = useState(false);
  const userContext = useUserContext({ profile, applications, savedJobs });

  const handleSendEmail = () => {
    // Trigger save prompt after user clicks Send Email (the mailto fires via the <a> tag)
    setTimeout(() => setShowSavePrompt(true), 500);
  };

  const saveContact = () => {
    const normalizedEmail = normalizeEmail(emailTo);
    if (!isEmailValid(normalizedEmail)) { setError(t("networking.invalidEmail")); return; }
    const contact = {
      id: uid(),
      name: normalizeFullName(form.targetName || ""),
      company: form.targetCompany || "",
      role: form.targetRole || "",
      email: normalizedEmail,
      method: "email",
      subject: draft?.emailSubject || "",
      originalMessage: draft?.emailBody || "",
      linkedinMessage: draft?.linkedinMessage || "",
      linkedinNote: draft?.linkedinNote || "",
      dateSaved: new Date().toISOString().split("T")[0],
      status: "Waiting for Reply",
    };
    // Duplicate prevention by email (or name+company if no email)
    const key = contact.email ? contact.email.toLowerCase() : `${contact.name}|${contact.company}`.toLowerCase();
    const exists = savedContacts.some(c => {
      const ck = c.email ? c.email.toLowerCase() : `${c.name}|${c.company}`.toLowerCase();
      return ck === key;
    });
    if (!exists) {
      setSavedContacts(p => [contact, ...p]);
      insertNotification(profile?.id, { type: "networking", title: "Contact saved.", body: contact.name + (contact.company ? " at " + contact.company : "") + " added to your Saved Outreach." });
    }
    setShowSavePrompt(false);
  };

  const deleteContact = (id) => setSavedContacts(p => p.filter(c => c.id !== id));
  const updateContactStatus = (id, status) => setSavedContacts(p => p.map(c => c.id === id ? { ...c, status } : c));

  const generateFollowUp = async (contact) => {
    setFuContact(contact); setFuDraft(""); setFuLoading(true);
    try {
      const ctx = userContext.getContextString({ identity: true });
      const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}Write a professional follow-up message. Context:
Original outreach to ${contact.name || "contact"}${contact.company ? " at " + contact.company : ""}.
Original subject: ${contact.subject || "N/A"}
Original message: ${(contact.originalMessage || contact.linkedinMessage || "").slice(0, 400)}
Method: ${contact.method}
It has been about 7 days since the original outreach.
Return ONLY the follow-up message text, no JSON, no markdown fences. Keep it brief, professional, and warm. 2-3 paragraphs max.`, 800);
      setFuDraft(cleanPlaceholders(raw) || t("networking.followupError"));
    } catch (e) { console.error("[Networking] followup", e); setFuDraft(t("networking.followupError")); }
    finally { setFuLoading(false); }
  };

  // Replace template placeholders with the user's actual data
  const cleanPlaceholders = (s) => {
    if (!s || typeof s !== "string") return s;
    const name = (form.targetName || "there").trim();
    const company = (form.targetCompany || "your company").trim();
    const role = (form.targetRole || "your role").trim();
    return s
      .replace(/\[(their |target )?name\]/gi, name)
      .replace(/\[(your )?name\]/gi, "")
      .replace(/\[company( name)?\]/gi, company)
      .replace(/\[(their |target )?(role|title|position)\]/gi, role)
      .replace(/\[[^\]]*\]/g, "") // strip any remaining [placeholder]
      .replace(/\s{2,}/g, " ")
      .trim();
  };

  // Seed editable draft from generated results (and on refresh-restore)
  useEffect(() => {
    if (results && !draft) {
      setDraft({
        linkedinMessage: cleanPlaceholders(results.linkedinMessage) || "",
        linkedinNote: cleanPlaceholders(results.linkedinNote) || "",
        callToAction: cleanPlaceholders(results.callToAction) || "",
        emailSubject: cleanPlaceholders(results.email?.subject) || "",
        emailBody: cleanPlaceholders(results.email?.body) || "",
        followUp: cleanPlaceholders(results.followUp) || "",
        icebreakers: (results.icebreakers || []).map(cleanPlaceholders),
      });
    }
  }, [results]);

  const updateDraft = (key, val) => setDraft(d => ({ ...(d || {}), [key]: val }));
  const updateIcebreaker = (i, val) => setDraft(d => { const ic = [...(d?.icebreakers || [])]; ic[i] = val; return { ...d, icebreakers: ic }; });
  const purposes = [{ value: "coffee-chat", label: t("networking.coffeeChatLabel") }, { value: "referral", label: t("networking.referralLabel") }, { value: "informational", label: t("networking.informationalLabel") }, { value: "reconnect", label: t("networking.reconnectLabel") }, { value: "cold-outreach", label: t("networking.coldOutreachLabel") }];
  const txt = (v, fallback = "—") => (v !== undefined && v !== null && String(v).trim() !== "") ? v : fallback;

  // Safe JSON parse with truncation recovery
  const safeParse = (raw) => {
    try { return JSON.parse(raw); }
    catch {
      const start = raw.indexOf("{") >= 0 ? raw.indexOf("{") : raw.indexOf("[");
      const end = raw.lastIndexOf("}") >= 0 ? raw.lastIndexOf("}") : raw.lastIndexOf("]");
      if (start >= 0 && end > start) {
        try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
      }
      return null;
    }
  };

  const generate = async () => {
    if (!form.targetCompany || !form.yourBackground) { setError(t("networking.fillRequired")); return; }
    setError(""); setLoading(true); setResults(null);
    try {
      const ctx = userContext.getContextString({ identity: true });
      const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}Networking outreach. Return ONLY JSON, no markdown:
{"linkedinMessage":"<280 chars max>","linkedinNote":"<2 para InMail>","email":{"subject":"<subject>","body":"<100 word email>"},"followUp":"<follow up>","icebreakers":["<i1>","<i2>"],"doList":["<d1>","<d2>"],"dontList":["<dont1>","<dont2>"],"callToAction":"<ask>"}
To: ${form.targetName||"contact"} (${form.targetRole||"role"} at ${form.targetCompany}), From: ${form.yourBackground.slice(0,200)}, Purpose: ${form.purpose}${form.purpose === "referral" && form.jobDesc ? `, Referral for: ${form.jobDesc.slice(0,200)}` : ""}`, 2500);
      const parsed = safeParse(raw);
      if (!parsed) {
        setError(t("networking.aiError"));
      } else if (!parsed.linkedinMessage && !parsed.email) {
        setError(t("networking.incompleteResponse"));
      } else {
        setResults(parsed); setTab("linkedin");
        setDraft(null);
        setEmailTo("");
      }
    } catch (e) {
      setError(t("networking.networkError"));
    } finally { setLoading(false); }
  };

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 6 }}>{t("networking.title")}</h1>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24 }}>{t("networking.subtitle")}</p>

      {/* Phase 2 (structural only): new outer tab, sibling to the existing
          linkedin/email/followup/tips selector below, which is completely
          untouched inside the "outreach" branch. */}
      <div style={{ display: "flex", gap: 8, borderBottom: `1px solid ${C.border}`, marginBottom: 20 }}>
        <button onClick={() => setMainTab("outreach")} style={{ padding: "10px 4px", marginRight: 16, background: "none", border: "none", borderBottom: mainTab === "outreach" ? `2px solid ${C.purple}` : "2px solid transparent", color: mainTab === "outreach" ? C.purple : C.textMuted, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>{t("networking.outreachTab")}</button>
        <button onClick={() => setMainTab("intelligence")} style={{ padding: "10px 4px", background: "none", border: "none", borderBottom: mainTab === "intelligence" ? `2px solid ${C.purple}` : "2px solid transparent", color: mainTab === "intelligence" ? C.purple : C.textMuted, fontSize: 14, fontWeight: 700, cursor: "pointer" }}>{t("networking.intelligenceTab")}</button>
      </div>

      {mainTab === "outreach" && (
      <>
      <Card style={{ marginBottom: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }} className="two-col">
          <Input label={t("networking.theirName")} placeholder={t("networking.theirNamePlaceholder")} value={form.targetName} onChange={e => setForm(f => ({ ...f, targetName: e.target.value }))} />
          <Input label={t("networking.theirRole")} placeholder={t("networking.theirRolePlaceholder")} value={form.targetRole} onChange={e => setForm(f => ({ ...f, targetRole: e.target.value }))} />
          <Input label={t("networking.company")} placeholder={t("networking.companyPlaceholder")} value={form.targetCompany} onChange={e => setForm(f => ({ ...f, targetCompany: e.target.value }))} />
          <Select label={t("networking.purpose")} value={form.purpose} onChange={e => setForm(f => ({ ...f, purpose: e.target.value }))}>{purposes.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</Select>
          <div style={{ gridColumn: "1 / -1" }}><Textarea label={t("networking.yourBackground")} placeholder={t("networking.yourBackgroundPlaceholder")} value={form.yourBackground} onChange={e => setForm(f => ({ ...f, yourBackground: e.target.value }))} style={{ minHeight: 160, width: "100%" }} /></div>
          {form.purpose === "referral" && <div style={{ gridColumn: "1 / -1" }}><Textarea label={t("networking.referralJob")} placeholder={t("networking.referralJobPlaceholder")} value={form.jobDesc} onChange={e => setForm(f => ({ ...f, jobDesc: e.target.value }))} style={{ minHeight: 160, width: "100%" }} /></div>}
        </div>
        {error && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, color: C.red, fontSize: 13, marginBottom: 14 }}>{error}</div>}
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Btn onClick={generate} loading={loading} style={{ padding: "13px 28px" }}>{loading ? t("networking.generating") : t("networking.generateBtn")}</Btn>
          {results && <Btn variant="secondary" onClick={() => { setResults(null); setDraft(null); setError(""); setEmailSent(false); setShowSavePrompt(false); }}>{t("networking.newMessageBtn")}</Btn>}
        </div>
      </Card>
      {loading && <Spinner steps={[t("networking.spinnerStep1"),t("networking.spinnerStep2"),t("networking.spinnerStep3"),t("networking.spinnerStep4")]} currentStep={1} />}
      {results && (
        <div>
          <div style={{ display: "flex", gap: 3, background: C.bgSoft, borderRadius: 10, padding: 3, marginBottom: 20 }}>
            {[["linkedin",t("networking.linkedinTab")],["email",t("networking.emailTab")],["followup",t("networking.followupTab")],["tips",t("networking.tipsTab")]].map(([id, lbl]) => (
              <Btn key={id} variant="ghost" style={{ flex: 1, padding: "10px", borderRadius: 7, border: "none", background: tab === id ? "#fff" : "transparent", color: tab === id ? C.text : C.textMuted, fontSize: 13, fontWeight: 600, boxShadow: tab === id ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }} onClick={() => setTab(id)}>{lbl}</Btn>
            ))}
          </div>
          {tab === "linkedin" && draft && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Card>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}><Label>{t("networking.connectionRequest")}</Label><CopyBtn text={draft.linkedinMessage} label={t("networking.copyLinkedinMsg")} /></div>
                <textarea value={draft.linkedinMessage} onChange={e => updateDraft("linkedinMessage", e.target.value)} style={{ width: "100%", minHeight: 90, background: "#fff", border: `1.5px solid ${(draft.linkedinMessage?.length || 0) > 280 ? C.red : C.border}`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.6, padding: "12px 14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
                <div style={{ fontSize: 12, color: (draft.linkedinMessage?.length || 0) > 280 ? C.red : C.textMuted, marginTop: 8 }}>{t("networking.charCount").replace("{count}", draft.linkedinMessage?.length || 0)}</div>
              </Card>
              <Card>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}><Label>{t("networking.inmailLabel")}</Label><CopyBtn text={draft.linkedinNote} label={t("networking.copyBtn")} /></div>
                <textarea value={draft.linkedinNote} onChange={e => updateDraft("linkedinNote", e.target.value)} style={{ width: "100%", minHeight: 160, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.7, padding: "14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
              </Card>
              <div style={{ background: C.greenLight, border: `1px solid ${C.green}25`, borderRadius: 12, padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><Label>{t("networking.yourAsk")}</Label><CopyBtn text={draft.callToAction} label={t("networking.copyBtn")} /></div>
                <textarea value={draft.callToAction} onChange={e => updateDraft("callToAction", e.target.value)} style={{ width: "100%", minHeight: 60, background: "#fff", border: `1.5px solid ${C.green}30`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.6, padding: "12px 14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
              </div>
            </div>
          )}
          {tab === "email" && draft && (
            <Card>
              <div style={{ marginBottom: 14 }}>
                <Label>{t("networking.toLabel")}</Label>
                <input value={emailTo} onChange={e => setEmailTo(e.target.value)} placeholder="name@company.com" style={{ width: "100%", background: "#fff", border: `1.5px solid ${emailTo && !isEmailValid(emailTo) ? C.red : C.border}`, borderRadius: 9, color: C.text, fontSize: 14, padding: "12px 14px", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
              </div>
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><Label>{t("networking.subjectLabel")}</Label><CopyBtn text={draft.emailSubject} label={t("networking.copySubject")} /></div>
                <input value={draft.emailSubject} onChange={e => updateDraft("emailSubject", e.target.value)} placeholder={t("networking.emailSubjectPlaceholder")} style={{ width: "100%", background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 15, fontWeight: 600, padding: "12px 14px", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><Label>{t("networking.emailBodyLabel")}</Label><CopyBtn text={draft.emailBody} label={t("networking.copyEmail")} /></div>
              <textarea value={draft.emailBody} onChange={e => updateDraft("emailBody", e.target.value)} style={{ width: "100%", minHeight: 240, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.7, padding: "14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
              <div style={{ marginTop: 16, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <a href={`mailto:${encodeURIComponent(emailTo)}?subject=${encodeURIComponent(draft.emailSubject || "")}&body=${encodeURIComponent(draft.emailBody || "")}`} style={{ textDecoration: "none" }} onClick={() => { handleSendEmail(); setEmailSent(true); }}>
                  <Btn variant="primary">{emailSent ? t("networking.sentBtn") : t("networking.sendEmailBtn")}</Btn>
                </a>
                {!emailSent && <span style={{ fontSize: 12, color: C.textMuted }}>{t("networking.emailDisclaimer")}</span>}
              </div>

              {/* Save Outreach Popup */}
              {showSavePrompt && (
                <div style={{ marginTop: 16, background: C.purpleLight, border: `1.5px solid ${C.purple}40`, borderRadius: 12, padding: 20 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: C.purple, marginBottom: 12 }}>{t("networking.savePromptTitle")}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 16 }}>
                    {form.targetName && <div style={{ fontSize: 14, color: C.text }}>👤 {form.targetName}</div>}
                    {form.targetCompany && <div style={{ fontSize: 14, color: C.text }}>🏢 {form.targetCompany}</div>}
                    {emailTo && <div style={{ fontSize: 14, color: C.text }}>📧 {emailTo}</div>}
                  </div>
                  <div style={{ fontSize: 13, color: C.textMid, marginBottom: 14 }}>{t("networking.savePromptBody")}</div>
                  {error && <div style={{ color: C.red, fontSize: 13, fontWeight: 600, marginBottom: 12 }}>{error}</div>}
                  <div style={{ display: "flex", gap: 10 }}>
                    <Btn onClick={saveContact}>{t("networking.saveContactBtn")}</Btn>
                    <Btn variant="secondary" onClick={() => setShowSavePrompt(false)}>{t("networking.notNowBtn")}</Btn>
                  </div>
                </div>
              )}
            </Card>
          )}
          {tab === "followup" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

              {/* SAVED CONTACTS */}
              {savedContacts.length > 0 && (
                <Card>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                    <Label>{t("networking.savedContactsLabel").replace("{count}", savedContacts.length)}</Label>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {savedContacts.map(c => (
                      <div key={c.id} style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 16px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
                          <div style={{ minWidth: 160 }}>
                            {c.name && <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>👤 {c.name}</div>}
                            {c.company && <div style={{ fontSize: 13, color: C.textMid, marginTop: 2 }}>🏢 {c.company}</div>}
                            {c.email && <div style={{ fontSize: 13, color: C.textMid, marginTop: 2 }}>📧 {c.email}</div>}
                            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>📅 {c.dateSaved}</div>
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                            <div style={{ position: "relative", display: "inline-block" }}>
                              <Btn variant="secondary" style={{ borderRadius: 20, padding: "5px 14px", fontSize: 12 }} onClick={() => setOpenStatusMenu(openStatusMenu === c.id ? null : c.id)}>
                                {statusEmoji[c.status] || "⚪"} {tStatus(c.status)} ▾
                              </Btn>
                              {openStatusMenu === c.id && (
                                <div>
                                <div onClick={() => setOpenStatusMenu(null)} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 49 }} />
                                <div style={{ position: "absolute", top: "110%", left: 0, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 50, minWidth: 180, overflow: "hidden" }}>
                                  {["Waiting for Reply","Replied","Met","Connected","No Response"].map(s => (
                                    <Btn key={s} variant="ghost" style={{ width: "100%", borderRadius: 0, border: "none", padding: "10px 14px", background: c.status === s ? C.bgSoft : "#fff", color: C.text, fontSize: 13, fontWeight: 600, justifyContent: "flex-start" }} onClick={() => { updateContactStatus(c.id, s); setOpenStatusMenu(null); }}>
                                      {statusEmoji[s]} {tStatus(s)}
                                    </Btn>
                                  ))}
                                </div>
                                </div>
                              )}
                            </div>
                            <Btn variant="secondary" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => generateFollowUp(c)} loading={fuLoading && fuContact?.id === c.id}>{t("networking.generateFollowupBtn")}</Btn>
                            {c.email && <a href={`mailto:${encodeURIComponent(c.email)}?subject=Re: ${encodeURIComponent(c.subject || "")}`} style={{ textDecoration: "none" }}><Btn variant="secondary" style={{ padding: "5px 12px", fontSize: 12 }}>{t("networking.emailBtn")}</Btn></a>}
                            <Btn variant="secondary" style={{ padding: "5px 12px", fontSize: 12, color: C.red }} onClick={() => deleteContact(c.id)}>✕</Btn>
                          </div>
                        </div>
                        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 8 }}>{t("networking.replyReminderText")}</div>

                        {/* Generated follow-up for this contact */}
                        {fuContact?.id === c.id && (
                          <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 12, background: "#fff" }}>
                            {fuLoading && <div style={{ color: C.purple, fontSize: 13, fontWeight: 600 }}>{t("networking.generatingFollowup")}</div>}
                            {!fuLoading && fuDraft && (
                              <div>
                                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><Label>{t("networking.followupMessageLabel")}</Label><CopyBtn text={fuDraft} label={t("networking.copyBtn")} /></div>
                                <textarea value={fuDraft} onChange={e => setFuDraft(e.target.value)} style={{ width: "100%", minHeight: 120, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.7, padding: "14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
                                {c.email && <div style={{ marginTop: 10 }}><a href={`mailto:${encodeURIComponent(c.email)}?subject=Re: ${encodeURIComponent(c.subject || "")}&body=${encodeURIComponent(fuDraft)}`} style={{ textDecoration: "none" }} onClick={() => { const now = new Date().toISOString(); setSavedContacts(p => p.map(x => x.id === c.id ? { ...x, lastFollowUpAt: now, followUpsSent: (x.followUpsSent || 0) + 1, followUpHistory: [...(x.followUpHistory || []), { sentAt: now, message: fuDraft }] } : x)); }}><Btn variant="primary" style={{ fontSize: 13 }}>{t("networking.sendFollowupBtn")}</Btn></a></div>}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </Card>
              )}

              {/* GENERATED FOLLOW-UP FROM CURRENT OUTREACH */}
              {draft && (
                <Card>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                    <div><Label>{t("networking.followupTemplateLabel")}</Label><div style={{ fontSize: 12, color: C.textMuted, marginTop: 3 }}>{t("networking.followupTemplateSub")}</div></div>
                    <CopyBtn text={draft.followUp} label={t("networking.copyBtn")} />
                  </div>
                  <textarea value={draft.followUp} onChange={e => updateDraft("followUp", e.target.value)} style={{ width: "100%", minHeight: 140, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.7, padding: "14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
                  <div style={{ marginTop: 20 }}>
                    <Label>{t("networking.icebreakerLabel")}</Label>
                    {(draft.icebreakers || []).map((ic, i) => (
                      <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 8 }}>
                        <span style={{ color: C.blue, fontWeight: 700, flexShrink: 0, paddingTop: 12 }}>{i+1}.</span>
                        <textarea value={ic} onChange={e => updateIcebreaker(i, e.target.value)} style={{ flex: 1, minHeight: 50, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.6, padding: "10px 14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
                      </div>
                    ))}
                  </div>
                </Card>
              )}
            </div>
          )}
          {tab === "tips" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }} className="two-col">
              <Card>
                <div style={{ fontSize: 12, color: C.green, fontWeight: 700, marginBottom: 14 }}>{t("networking.doThisLabel")}</div>
                {results.doList?.map((t, i) => <div key={i} style={{ display: "flex", gap: 10, marginBottom: 12 }}><span style={{ color: C.green, flexShrink: 0, fontWeight: 700 }}>✓</span><span style={{ fontSize: 14, lineHeight: 1.7, color: C.text }}>{t}</span></div>)}
              </Card>
              <Card>
                <div style={{ fontSize: 12, color: C.red, fontWeight: 700, marginBottom: 14 }}>{t("networking.avoidThisLabel")}</div>
                {results.dontList?.map((t, i) => <div key={i} style={{ display: "flex", gap: 10, marginBottom: 12 }}><span style={{ color: C.red, flexShrink: 0, fontWeight: 700 }}>✗</span><span style={{ fontSize: 14, lineHeight: 1.7, color: C.text }}>{t}</span></div>)}
              </Card>
            </div>
          )}
        </div>
      )}
      </>
      )}

      {mainTab === "intelligence" && (
        <ReferralIntelligencePanel
          contacts={savedContacts}
          watchlist={watchlist}
          savedJobs={savedJobs}
          applications={applications}
          referralPatterns={referralPatterns}
          profile={profile}
          isPremium={isPremium}
          referralAnalysesHook={referralAnalysesHook}
        />
      )}
    </div>
  );
}

// ─── SAVED JOBS ────────────────────────────────────────────
function SwipeToApply({ onApply, applying, justApplied, containerStyle }) {
  const { t } = useI18n();
  const [offset, setOffset] = useState(0);
  const [swiping, setSwiping] = useState(false);
  const startX = useRef(null);
  const THRESHOLD = 80;
  const MAX = 140;

  const onTouchStart = (e) => {
    if (justApplied || applying) return;
    startX.current = e.touches[0].clientX;
    setSwiping(true);
  };
  const onTouchMove = (e) => {
    if (startX.current == null) return;
    const delta = Math.max(0, Math.min(MAX, e.touches[0].clientX - startX.current));
    setOffset(delta);
  };
  const onTouchEnd = () => {
    if (offset >= THRESHOLD) { setOffset(MAX); onApply(); }
    else setOffset(0);
    startX.current = null;
    setSwiping(false);
  };

  if (justApplied) {
    return <div style={{ background: C.green, color: "#fff", borderRadius: 10, padding: "10px 20px", fontWeight: 700, fontSize: 14, textAlign: "center", minWidth: 120, ...containerStyle }}>{t("savedJobs.appliedConfirm")}</div>;
  }
  const progress = Math.min(1, offset / THRESHOLD);
  return (
    <div style={{ position: "relative", borderRadius: 10, overflow: "hidden", background: C.green, height: 40, minWidth: 140, userSelect: "none", touchAction: "pan-y", cursor: "pointer", ...containerStyle }}
      onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", paddingLeft: 16, color: "#fff", fontSize: 13, fontWeight: 700, opacity: progress }}>{t("savedJobs.appliedConfirm")}</div>
      <div style={{ position: "absolute", left: offset, top: 0, bottom: 0, width: "100%", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 13, fontWeight: 700, color: C.text, borderRadius: 10, boxShadow: "0 2px 8px rgba(0,0,0,0.12)", transition: swiping ? "none" : "left 0.2s ease" }}>
        {applying ? t("savedJobs.applyingBtn") : t("savedJobs.swipeToApply")}
      </div>
    </div>
  );
}

// Contact fields checked on the resume (see checkResumeContactInfo) — order they render in
// the compact "missing field" strip, and the issue code / translation key each maps to.
const SMART_APPLY_CONTACT_FIELDS = [
  { issue: "missing_full_name", labelKey: "savedJobs.contactFieldFullName" },
  { issue: "missing_email", labelKey: "savedJobs.contactFieldEmail" },
  { issue: "missing_phone", labelKey: "savedJobs.contactFieldPhone" },
];

// Deterministic, local re-check — no new AI call. A previously-missing skill
// is considered resolved once its name appears (case-insensitively) anywhere
// in the freshly-edited tailored resume text, so the Missing Skills list
// always reflects the newest version of the resume without re-running the
// original AI analysis.
const resolvedMissingSkills = (skills, resumeText) => {
  const lower = String(resumeText || "").toLowerCase();
  return (skills || []).filter(s => !lower.includes(String(s).toLowerCase()));
};

function PackageView({ item, resumes, savedJob, patchQueueItem, profile }) {
  const { t } = useI18n();
  const [editingField, setEditingField] = useState(null);
  const [editText, setEditText] = useState("");
  const [saving, setSaving] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState(false);
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" ? window.matchMedia("(max-width: 767px)").matches : false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = e => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  const selectedResumeName = resumes && item.resume_id ? (resumes.find(r => r.id === item.resume_id)?.name || null) : null;
  const statusLabel = { ready: t("savedJobs.statusReady"), applied: t("savedJobs.statusApplied"), needs_review: t("savedJobs.statusNeedsReview") }[item.status] || item.status;
  const hasJobChanges = !!savedJob?.previous_description && savedJob.previous_description !== savedJob.description;
  // Package Integrity Validation, recomputed live from the current stored fields on every
  // render — drives the per-document ✅/🔴 indicators below. Editing + saving a field
  // re-runs this same check (see handleSaveEdit) so status stays accurate automatically.
  const integrity = validateSmartApplyPackage(smartApplyDocFieldsFromRow(item), resolveCountry(profile?.country));

  useEffect(() => {
    if (!hasJobChanges || item.job_change_analysis || !savedJob || !patchQueueItem) return;
    let cancelled = false;
    const run = async () => {
      setAnalyzing(true);
      setAnalysisError(false);
      try {
        const raw = await askClaude(buildJobChangePrompt(savedJob.previous_description, savedJob.description), 1500, "job_change_analysis");
        if (cancelled) return;
        const jsonStart = raw.indexOf("{"); const jsonEnd = raw.lastIndexOf("}");
        const clean = (jsonStart >= 0 && jsonEnd > jsonStart) ? raw.slice(jsonStart, jsonEnd + 1) : raw;
        const result = JSON.parse(clean);
        await patchQueueItem(item.id, { jobChangeAnalysis: result });
      } catch { if (!cancelled) setAnalysisError(true); }
      finally { if (!cancelled) setAnalyzing(false); }
    };
    run();
    return () => { cancelled = true; };
  }, [hasJobChanges, !!item.job_change_analysis, savedJob?.job_id, item.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleStartEdit = (field, currentValue) => { setEditingField(field); setEditText(currentValue || ""); };
  // Saving an edit re-runs Package Integrity Validation against the updated document set
  // and writes the resulting status in the same update — this is the "Automatic validation
  // runs" step of the Needs Attention workflow. Only ready/needs_review rows have their
  // status touched; other statuses (e.g. applied) are never altered by an edit.
  const handleSaveEdit = async (field) => {
    if (!patchQueueItem) return;
    setSaving(true);
    try {
      const country = resolveCountry(profile?.country);
      const normalizedText = normalizePhonesInText(editText, country);
      const patch = { [field]: normalizedText };
      if (item.status === "ready" || item.status === "needs_review") {
        const merged = { ...smartApplyDocFieldsFromRow(item), [field]: normalizedText };
        patch.status = validateSmartApplyPackage(merged, country).ok ? "ready" : "needs_review";
      }
      // Editing the tailored resume is the one place a Missing Skill can actually
      // become resolved — re-check locally (no new AI call) and drop any skill
      // that now appears in the updated text, so the list never shows a skill
      // the user already addressed.
      if (field === "tailoredResume" && item.missing_skills?.length) {
        const stillMissing = resolvedMissingSkills(item.missing_skills, normalizedText);
        if (stillMissing.length !== item.missing_skills.length) patch.missingSkills = stillMissing;
      }
      await patchQueueItem(item.id, patch);
      setEditingField(null);
    }
    catch { /* keep editing mode on error so user can retry */ }
    finally { setSaving(false); }
  };

  const taStyle = { width: "100%", fontSize: 13, lineHeight: 1.75, color: C.text, background: C.bg, border: `1px solid ${C.borderStrong}`, borderRadius: 8, padding: "10px 12px", resize: "vertical", fontFamily: "inherit", boxSizing: "border-box" };

  const renderDocButtons = (field, storedValue, showDownload, fileName) => {
    const isEditing = editingField === field;
    const mobileBtnStyle = { flex: "1 1 0", minWidth: 0, height: 44, padding: "0 8px", fontSize: 12, whiteSpace: "nowrap", overflow: "hidden" };
    const desktopBtnStyle = { padding: "6px 14px", fontSize: 12 };
    const btnStyle = isMobile ? mobileBtnStyle : desktopBtnStyle;
    const containerStyle = isMobile
      ? { display: "flex", gap: 6, marginTop: 8 }
      : { display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" };
    return (
      <div style={containerStyle}>
        {patchQueueItem && (isEditing ? (
          <Btn style={btnStyle} loading={saving} onClick={() => handleSaveEdit(field)}>
            {saving ? t("savedJobs.savingEdit") : t("savedJobs.doneEditing")}
          </Btn>
        ) : (
          <Btn variant="ghost" style={btnStyle} onClick={() => handleStartEdit(field, storedValue)}>
            {t("savedJobs.editDocument")}
          </Btn>
        ))}
        <CopyBtn text={isEditing ? editText : storedValue} label={t("savedJobs.copy")} style={isMobile ? mobileBtnStyle : undefined} />
        {showDownload && <>
          <Btn variant="ghost" style={btnStyle} onClick={() => downloadPDF(storedValue, fileName)}>
            {isMobile ? t("savedJobs.downloadPdfMobile") : t("savedJobs.downloadPdf")}
          </Btn>
          <Btn variant="ghost" style={btnStyle} onClick={() => downloadDOCX(storedValue, fileName)}>
            {isMobile ? t("savedJobs.downloadDocxMobile") : t("savedJobs.downloadDocx")}
          </Btn>
        </>}
      </div>
    );
  };

  // Per-document heading + red warning block for the Needs Attention UI. A document is
  // always shown — even when it failed to generate — so the user never has to search the
  // package to find what's wrong; an empty document just shows a "not generated" state
  // with editing still available so it can be filled in and saved.
  // Minimal per-document status: a name + a one-line count ("✅ Ready" or "🔴 N Issues –
  // See Below"), never a reason list. The specific problem is only ever shown as a small
  // highlight on the exact item — a red-underlined field for missing contact info, or the
  // literal placeholder token underlined in place, plus a generic instruction line (never
  // the raw internal token text) telling the user where to look. Package Validation
  // doesn't check whether a document generated or how long it is (that's an AI generation
  // concern), so there's no whole-document highlight state here.
  const renderDocSection = (field, label, storedValue, minHeight) => {
    const doc = integrity.documents[field];
    const statusText = doc.ok
      ? "✅ " + t("savedJobs.docStatusReady")
      : "🔴 " + (doc.issues.length === 1 ? t("savedJobs.docStatusIssueOne") : t("savedJobs.docStatusIssueMany").replace("{n}", doc.issues.length));
    const missingContactFields = SMART_APPLY_CONTACT_FIELDS.filter(f => doc.issues.includes(f.issue));
    return (
      <>
        <Label>{label}</Label>
        <div style={{ fontSize: 12, fontWeight: 700, color: doc.ok ? C.green : C.red, marginBottom: 8 }}>{statusText}</div>
        {missingContactFields.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
            {missingContactFields.map(f => (
              <div key={f.issue} style={{ fontSize: 12, color: C.red, fontWeight: 600 }}>{t(f.labelKey)}</div>
            ))}
          </div>
        )}
        {doc.placeholderTokens.length > 0 && (
          <div style={{ fontSize: 12, color: C.red, fontWeight: 600, marginBottom: 10 }}>{t("savedJobs.placeholderReviewMessage")}</div>
        )}
        {editingField === field ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {/* Plain <textarea> can't render inline red-underlined highlights the way
                ContentDisplay does, so the still-outstanding placeholder tokens are
                listed here as chips instead -- same validation state (doc.placeholderTokens,
                unaffected by edit mode), just a rendering form the textarea can carry. This
                keeps "what still needs attention" visible while editing, per the requirement
                that entering edit mode must never make issue indicators disappear. */}
            {doc.placeholderTokens.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {doc.placeholderTokens.map((tok, i) => (
                  <span key={i} style={{ fontSize: 11, fontWeight: 700, color: C.red, background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 6, padding: "2px 8px" }}>{tok}</span>
                ))}
              </div>
            )}
            <textarea value={editText} onChange={e => setEditText(e.target.value)} style={{ ...taStyle, minHeight }} />
          </div>
        ) : (
          <ContentDisplay content={storedValue} highlightTokens={doc.placeholderTokens} />
        )}
      </>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 16px" }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: C.purple, letterSpacing: 1, marginBottom: 8 }}>{t("savedJobs.applicationPackage")}</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 2 }}>{item.job_title} — {item.company}</div>
        {selectedResumeName && <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6 }}>{t("savedJobs.resumePrefix")}: {selectedResumeName}</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Badge color={item.status === "needs_review" ? C.orange : C.green}>{statusLabel}</Badge>
          {item.interview_probability != null && <Badge color={C.purple}>{t("savedJobs.interviewLabel").replace("{pct}", item.interview_probability)}</Badge>}
          {item.hiring_probability != null && <Badge color={C.green}>{t("savedJobs.hiringLabel").replace("{pct}", item.hiring_probability)}</Badge>}
        </div>
      </div>
      {hasJobChanges && (
        <div style={{ background: C.yellowLight, border: `1px solid ${C.yellow}40`, borderRadius: 10, padding: "14px 16px" }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: C.yellow, letterSpacing: 1, marginBottom: 6 }}>{t("savedJobs.jobPostingChanges")}</div>
          <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6, marginBottom: 12 }}>{t("savedJobs.jobPostingChangesIntro")}</div>
          {analyzing && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ width: 12, height: 12, border: `2px solid ${C.yellow}40`, borderTopColor: C.yellow, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
              <div style={{ fontSize: 13, color: C.textMuted }}>{t("savedJobs.analyzingChanges")}</div>
            </div>
          )}
          {!analyzing && analysisError && (
            <div style={{ fontSize: 13, color: C.textMuted }}>{t("savedJobs.changeAnalysisFailed")}</div>
          )}
          {!analyzing && item.job_change_analysis && (() => {
            const ch = item.job_change_analysis;
            return (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {ch.summary && <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6, fontStyle: "italic" }}>{ch.summary}</div>}
                {ch.newSkills?.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.green, letterSpacing: 0.5, marginBottom: 4 }}>{t("savedJobs.newSkillsAdded")}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{ch.newSkills.map(s => <Badge key={s} color={C.green}>{s}</Badge>)}</div>
                  </div>
                )}
                {ch.removedSkills?.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.red, letterSpacing: 0.5, marginBottom: 4 }}>{t("savedJobs.skillsRemoved")}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{ch.removedSkills.map(s => <Badge key={s} color={C.red}>{s}</Badge>)}</div>
                  </div>
                )}
                {ch.responsibilitiesChanged && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: 0.5, marginBottom: 4 }}>{t("savedJobs.responsibilitiesChanged")}</div>
                    <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>{ch.responsibilitiesChanged}</div>
                  </div>
                )}
                {ch.experienceChanged && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: 0.5, marginBottom: 4 }}>{t("savedJobs.experienceChanged")}</div>
                    <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>{ch.experienceChanged}</div>
                  </div>
                )}
                {ch.educationChanged && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: 0.5, marginBottom: 4 }}>{t("savedJobs.educationChanged")}</div>
                    <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>{ch.educationChanged}</div>
                  </div>
                )}
                {ch.toolsChanged?.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: 0.5, marginBottom: 4 }}>{t("savedJobs.toolsChanged")}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{ch.toolsChanged.map(s => <Badge key={s} color={C.yellow}>{s}</Badge>)}</div>
                  </div>
                )}
                {ch.workAuthorizationChanged && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: 0.5, marginBottom: 4 }}>{t("savedJobs.workAuthorizationChanged")}</div>
                    <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>{ch.workAuthorizationChanged}</div>
                  </div>
                )}
                {ch.otherChanges?.length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: 0.5, marginBottom: 4 }}>{t("savedJobs.otherChanges")}</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {ch.otherChanges.map((c, i) => <div key={i} style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>• {c}</div>)}
                    </div>
                  </div>
                )}
                {savedJob?.applyUrl && (
                  <a href={savedJob.applyUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: C.purple, fontWeight: 600, textDecoration: "none" }}>
                    {t("savedJobs.viewJobPosting")}
                  </a>
                )}
              </div>
            );
          })()}
        </div>
      )}
      {integrity.otherPlaceholders.length > 0 && (
        <div style={{ fontSize: 12, fontWeight: 700, color: C.red }}>🔴 {t("savedJobs.issuePlaceholderElsewhere")}</div>
      )}
      {item.missing_skills?.length > 0 && (
        <div>
          <div style={{ fontSize: 12, color: C.red, fontWeight: 700, marginBottom: 4 }}>{t("savedJobs.missingSkills")}</div>
          {/* Makes the score -> missing skills -> resume edit -> higher score connection
              explicit — presentation only, no change to what generates this list. */}
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 8, lineHeight: 1.5 }}>{t("savedJobs.missingSkillsExplainer")}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{item.missing_skills.map(s => <Badge key={s} color={C.red}>{s}</Badge>)}</div>
        </div>
      )}
      <div>
        {renderDocSection("coverLetter", t("savedJobs.coverLetter"), item.cover_letter, 200)}
        {renderDocButtons("coverLetter", item.cover_letter, true, "cover-letter")}
      </div>
      <div>
        {renderDocSection("tailoredResume", t("savedJobs.tailoredResume"), item.tailored_resume, 300)}
        {renderDocButtons("tailoredResume", item.tailored_resume, true, "tailored-resume")}
      </div>
      <div>
        {renderDocSection("recruiterMessage", t("savedJobs.recruiterMessage"), item.recruiter_message, 150)}
        {renderDocButtons("recruiterMessage", item.recruiter_message, false, null)}
      </div>
      <div>
        {renderDocSection("networkingMessage", t("savedJobs.networkingMessage"), item.networking_message, 150)}
        {renderDocButtons("networkingMessage", item.networking_message, false, null)}
      </div>
      {item.application_questions?.length > 0 && (
        <div>
          <Label>{t("savedJobs.likelyQuestions")}</Label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
            {item.application_questions.map((q, i) => <div key={i} style={{ fontSize: 13, color: C.textMid, background: C.bgSoft, borderRadius: 8, padding: "8px 12px" }}>{q}</div>)}
          </div>
        </div>
      )}
      {item.salary_insight && (() => {
        const si = item.salary_insight;
        const r = si.marketRange || {};
        const fmt = n => n ? `$${Math.round(n / 1000)}K` : null;
        const low = fmt(r.low); const med = fmt(r.median); const high = fmt(r.high);
        return (
          <div>
            <Label>{t("savedJobs.salaryInsightLabel")}</Label>
            <div style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
              {(low || med || high) && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 8, letterSpacing: 0.5 }}>{t("savedJobs.marketRange")}</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {[[t("savedJobs.salaryLow"), low, C.yellow], [t("savedJobs.salaryMedian"), med, C.green], [t("savedJobs.salaryHigh"), high, C.blue]].filter(([, v]) => v).map(([label, val, color]) => (
                      <div key={label} style={{ flex: 1, background: `${color}12`, border: `1px solid ${color}30`, borderRadius: 8, padding: "8px 6px", textAlign: "center" }}>
                        <div style={{ fontSize: 15, fontWeight: 800, color }}>{val}</div>
                        <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 600, marginTop: 2 }}>{label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {si.userPositioning && <div><div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 4, letterSpacing: 0.5 }}>{t("savedJobs.yourPositioning")}</div><div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>{si.userPositioning}</div></div>}
              {si.negotiationLeverage && <div><div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 4, letterSpacing: 0.5 }}>{t("savedJobs.negotiationLeverage")}</div><div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>{si.negotiationLeverage}</div></div>}
              {si.benchmarks?.length > 0 && <div><div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 6, letterSpacing: 0.5 }}>{t("savedJobs.benchmarks")}</div><div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{si.benchmarks.map((b, i) => <Badge key={i} color={C.textMuted}>{b}</Badge>)}</div></div>}
            </div>
          </div>
        );
      })()}
      {item.company_insight && (() => {
        const ci = item.company_insight;
        const trendColor = ci.hiringTrend === "growing" ? C.green : ci.hiringTrend === "shrinking" ? C.red : C.yellow;
        const trendLabel = ci.hiringTrend === "growing" ? t("savedJobs.hiringTrendGrowing") : ci.hiringTrend === "shrinking" ? t("savedJobs.hiringTrendShrinking") : t("savedJobs.hiringTrendStable");
        return (
          <div>
            <Label>{t("savedJobs.companyInsightLabel")}</Label>
            <div style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
              {ci.hiringTrend && <div style={{ display: "flex", alignItems: "center", gap: 8 }}><div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: 0.5 }}>{t("savedJobs.hiringTrendHeader")}</div><Badge color={trendColor}>{trendLabel}</Badge></div>}
              {ci.culture && <div><div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 4, letterSpacing: 0.5 }}>{t("savedJobs.cultureHeader")}</div><div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>{ci.culture}</div></div>}
              {ci.recentNews && <div><div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 4, letterSpacing: 0.5 }}>{t("savedJobs.recentNewsHeader")}</div><div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>{ci.recentNews}</div></div>}
              {ci.greenFlags?.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.green, marginBottom: 6, letterSpacing: 0.5 }}>{t("savedJobs.greenFlagsHeader")}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {ci.greenFlags.map((f, i) => <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}><span style={{ color: C.green, fontWeight: 700, flexShrink: 0, fontSize: 13 }}>✓</span><span style={{ fontSize: 13, color: C.textMid, lineHeight: 1.5 }}>{f}</span></div>)}
                  </div>
                </div>
              )}
              {ci.redFlags?.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.red, marginBottom: 6, letterSpacing: 0.5 }}>{t("savedJobs.redFlagsHeader")}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {ci.redFlags.map((f, i) => <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}><span style={{ color: C.red, fontWeight: 700, flexShrink: 0, fontSize: 13 }}>✗</span><span style={{ fontSize: 13, color: C.textMid, lineHeight: 1.5 }}>{f}</span></div>)}
                  </div>
                </div>
              )}
              {ci.talkingPoints?.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.purple, marginBottom: 6, letterSpacing: 0.5 }}>{t("savedJobs.interviewTalkingPoints")}</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {ci.talkingPoints.map((p, i) => <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}><span style={{ color: C.purple, fontWeight: 700, flexShrink: 0, fontSize: 13 }}>{i + 1}.</span><span style={{ fontSize: 13, color: C.textMid, lineHeight: 1.5 }}>{p}</span></div>)}
                  </div>
                </div>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function extractSkillName(raw) {
  if (!raw || typeof raw !== "string") return raw;
  let s = raw.trim();
  // Remove parenthetical phrases: "Java (primary language)" → "Java"
  s = s.replace(/\s*\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  // Remove trailing punctuation
  s = s.replace(/[.,;:]+$/, "").trim();
  // Split on SPACED slash only — preserves "CI/CD", splits "Java / Spring Boot"
  s = s.split(/\s+\/\s+/)[0].trim();
  // "...using X" → take X: "development using C#" → "C#"
  const usingIdx = s.search(/\busing\s+/i);
  if (usingIdx >= 0) s = s.slice(usingIdx).replace(/^using\s+/i, "").trim();
  // "...with [Capital word(s)]" → take capital phrase: "Linux with Yocto Project" → "Yocto Project"
  const withMatch = s.match(/\bwith\s+([A-Z]\S+(?:\s+[A-Z]\S+)?)/);
  if (withMatch) s = withMatch[1].trim();
  // "A and B [descriptor]" → take A: "Firmware and hardware integration" → "Firmware"
  if (/\band\b.*\b(experience|knowledge|integration|development|hardware|software|skills?)\b/i.test(s)) {
    s = s.split(/\s+and\s+/i)[0].trim();
  }
  // Strip one or more trailing generic descriptor words in one pass
  s = s.replace(
    /(\s+(experience|knowledge|expertise|background|proficiency|familiarity|domain|tooling|engineering|programming|coding|methodology|methodologies|project|architecture|principles?|patterns?|practices?|concepts?|technologies?|language|pipelines?|frameworks?|stack|infrastructure|platform|environment|analysis|integration|development))+\s*$/gi,
    ""
  ).trim();
  // Strip leading filler/context modifiers: "Production monitoring" → "monitoring"
  s = s.replace(/^(production|enterprise|embedded|server|client|advanced|basic|strong|deep|solid)\s+/i, "").trim();
  // Capitalize first letter
  if (s) s = s.charAt(0).toUpperCase() + s.slice(1);
  // Limit to 2 words max
  const words = s.split(/\s+/);
  if (words.length > 2) s = words.slice(0, 2).join(" ");
  return s || raw.trim().split(/\s+/).slice(0, 2).join(" ");
}

function MissingSkillsBadges({ skills }) {
  const { t } = useI18n();
  if (!skills?.length) return null;
  const cleaned = skills.map(extractSkillName).filter(Boolean);
  const show = cleaned.slice(0, 3);
  const extra = cleaned.length - show.length;
  const text = show.join(" • ") + (extra > 0 ? ` • +${extra}` : "");
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, background: `${C.red}12`, border: `1px solid ${C.red}25`, borderRadius: 6, padding: "3px 10px", fontSize: 11, color: C.red, whiteSpace: "nowrap", overflow: "hidden", maxWidth: "100%" }}>
      <span style={{ fontWeight: 700, flexShrink: 0 }}>{t("savedJobs.missingSkillsPrefix")}</span>
      <span style={{ fontWeight: 500 }}>{text}</span>
    </span>
  );
}

function SmartApplyQueueCard({ item, onApply, onRemove, onRetry, applying, retrying, resumes, justApplied, savedJobs, patchQueueItem, profile }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" ? window.matchMedia("(max-width: 1024px)").matches : false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1024px)");
    const handler = (e) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  const savedJob = (savedJobs || []).find(j => j.job_id === item.job_id);
  const hasJobChanges = !!savedJob?.previous_description && savedJob.previous_description !== savedJob.description;
  const statusLabel = { ready: t("savedJobs.statusReady"), applied: t("savedJobs.statusApplied"), skipped: t("savedJobs.statusSkipped"), queued: t("savedJobs.statusQueued"), failed: t("savedJobs.statusFailed"), needs_review: t("savedJobs.statusNeedsReview") }[item.status] || item.status;
  const isViewable = item.status === "ready" || item.status === "needs_review";
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text }}>{item.job_title}</div>
            <Badge color={item.status === "ready" ? C.green : item.status === "applied" ? C.blue : item.status === "skipped" ? C.textMuted : item.status === "failed" ? C.red : item.status === "needs_review" ? C.orange : C.yellow}>{statusLabel}</Badge>
            {item.generation_source === "automatic" && <Badge color={C.purple}>{t("savedJobs.autoPreparedBadge")}</Badge>}
          </div>
          <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 8 }}>{item.company}</div>
          {item.status === "ready" && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {item.interview_probability != null && <Badge color={C.purple}>{t("savedJobs.interviewLabel").replace("{pct}", item.interview_probability)}</Badge>}
              {item.hiring_probability != null && <Badge color={C.green}>{t("savedJobs.hiringLabel").replace("{pct}", item.hiring_probability)}</Badge>}
              <MissingSkillsBadges skills={item.missing_skills} />
            </div>
          )}
        </div>
        {(isViewable || justApplied) && (
          <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap", alignItems: "center" }}>
            {!justApplied && (
              <Btn variant="ghost" style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => setExpanded(e => !e)}>{expanded ? t("savedJobs.hideDetails") : t("savedJobs.viewDetails")}</Btn>
            )}
            {!justApplied && (
              <Btn variant="secondary" style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => onRemove(item)}>{t("savedJobs.removeBtn")}</Btn>
            )}
            {item.status === "ready" && (isMobile ? (
              <SwipeToApply onApply={() => onApply(item)} applying={applying} justApplied={justApplied} />
            ) : justApplied ? (
              <Btn variant="green" disabled style={{ fontSize: 13, padding: "9px 14px" }}>{t("savedJobs.appliedConfirm")}</Btn>
            ) : (
              <Btn style={{ fontSize: 13, padding: "9px 14px" }} loading={applying} onClick={() => onApply(item)}>
                {applying ? t("savedJobs.applyingBtn") : t("savedJobs.applyBtn")}
              </Btn>
            ))}
          </div>
        )}
      </div>
      {hasJobChanges && (
        <div style={{ marginTop: 10, padding: "8px 12px", background: C.yellowLight, border: `1px solid ${C.yellow}30`, borderRadius: 8, fontSize: 13, color: C.yellow, fontWeight: 600 }}>
          {t("savedJobs.jobChangedNotice")}
        </div>
      )}
      {item.status === "queued" && <div style={{ fontSize: 13, color: C.textMuted, marginTop: 10 }}>{t("savedJobs.preparingApplication")}</div>}
      {item.status === "failed" && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 13, color: C.red, marginBottom: 8 }}>{t("savedJobs.generationFailed")}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn variant="secondary" style={{ fontSize: 13, padding: "9px 14px" }} loading={retrying} onClick={() => onRetry(item)}>{t("savedJobs.retryGeneration")}</Btn>
            <Btn variant="ghost" style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => onRemove(item)}>{t("savedJobs.removeBtn")}</Btn>
          </div>
        </div>
      )}
      {item.status === "needs_review" && (
        <div style={{ marginTop: 10 }}>
          <Btn variant="secondary" style={{ fontSize: 13, padding: "9px 14px" }} loading={retrying} onClick={() => onRetry(item)}>{t("savedJobs.retryGeneration")}</Btn>
        </div>
      )}
      {expanded && isViewable && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
          <PackageView item={item} resumes={resumes} savedJob={savedJob} patchQueueItem={patchQueueItem} profile={profile} />
        </div>
      )}
    </Card>
  );
}

function SavedJobDetailsView({ job }) {
  const { t } = useI18n();
  const hasJobChanges = !!job.previous_description && job.previous_description !== job.description;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: 0.5, marginBottom: 6 }}>{t("savedJobs.jobDescriptionLabel")}</div>
        {job.description ? (
          <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.75, whiteSpace: "pre-wrap", maxHeight: 320, overflowY: "auto" }}>{job.description}</div>
        ) : (
          <div style={{ fontSize: 13, color: C.textMuted }}>{t("savedJobs.noDescriptionAvailable")}</div>
        )}
      </div>
      {hasJobChanges && (
        <div style={{ fontSize: 13, color: C.yellow, fontWeight: 600, lineHeight: 1.5 }}>
          {t("savedJobs.jobChangedDetailUnprepared")}
        </div>
      )}
      {job.applyUrl && (
        <a href={job.applyUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, color: C.purple, fontWeight: 600, textDecoration: "none" }}>
          {t("savedJobs.viewJobPosting")}
        </a>
      )}
    </div>
  );
}

function SavedJobsPage({ savedJobs, setSavedJobs, setApplications, applications, profile, resumes, onQueueChange, queue, queueLoading, markApplied, markReady, markNeedsReview, markFailed, resetToQueued, purgeQueueByJobId, enqueue, activeResumeId, patchQueueItem }) {
  const { t, language } = useI18n();
  const userContext = useUserContext({ profile, applications: applications || [], savedJobs: savedJobs || [] });
  const fmtSalary = (min, max) => { if (!min && !max) return t("savedJobs.salaryNotListed"); const f = n => `$${Math.round(n/1000)}K`; if (min && max) return `${f(min)} – ${f(max)}`; return min ? `${f(min)}+` : t("savedJobs.salaryUpTo").replace("{v}", f(max)); };
  const fmtDate = (str) => { if (!str) return ""; try { return new Date(str).toLocaleDateString(language, { month: "short", day: "numeric", year: "numeric" }); } catch { return ""; } };

  const [applyingId, setApplyingId] = useState(null);
  const [appliedId, setAppliedId] = useState(null);
  const [retryingId, setRetryingId] = useState(null);
  const [preparingIds, setPreparingIds] = useState(new Set());
  const [expandedJobs, setExpandedJobs] = useState(new Set());
  const [queueError, setQueueError] = useState("");
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" ? window.matchMedia("(max-width: 1024px)").matches : false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1024px)");
    const handler = (e) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // Per-job queue status helpers
  const getActiveEntry = (job) => queue.find(q => q.job_id === (job.job_id || job.id) && q.status !== "applied" && q.status !== "skipped");
  const getAppliedEntry = (job) => queue.find(q => q.job_id === (job.job_id || job.id) && q.status === "applied");
  const getReadyEntry = (job) => queue.find(q => q.job_id === (job.job_id || job.id) && q.status === "ready");

  const savedJobIds = new Set((savedJobs || []).map(j => j.job_id));
  const visibleQueue = queue.filter(q =>
    !savedJobIds.has(q.job_id) &&
    ((q.status !== "applied" && q.status !== "skipped") || q.id === appliedId)
  );

  const handleMarkApplied = async (item) => {
    setApplyingId(item.id);
    setQueueError("");
    try {
      const appId = uid();
      const newApp = { id: appId, company: item.company, jobTitle: item.job_title, status: "Applied", date: new Date().toISOString().split("T")[0], notes: "", resume: item.tailored_resume || "", coverLetter: item.cover_letter || "" };
      await insertApplicationRow(profile.id, newApp);
      setApplications(p => [newApp, ...p]);
      await markApplied(item.id, appId);
      await purgeQueueByJobId?.(item.job_id);
      setSavedJobs(p => p.filter(j => j.job_id !== item.job_id));
      onQueueChange?.();
      setAppliedId(item.id);
      setTimeout(() => setAppliedId(null), 1500);
    } catch {
      setQueueError(t("savedJobs.markAppliedError"));
    } finally {
      setApplyingId(null);
    }
  };

  const handleRemoveFromQueue = async (item) => {
    setQueueError("");
    try {
      await purgeQueueByJobId?.(item.job_id);
      setSavedJobs(p => p.filter(j => j.job_id !== item.job_id));
      onQueueChange?.();
    } catch { setQueueError(t("savedJobs.removeError")); }
  };

  const handleRetry = async (item) => {
    const resumeText = (resumes || []).find(r => r.id === item.resume_id)?.content ||
      (typeof sessionStorage !== "undefined" ? sessionStorage.getItem("cp_jobs_resume") || "" : "");
    if (!resumeText.trim()) { setQueueError(t("savedJobs.retryNoResume")); return; }
    setRetryingId(item.id);
    setQueueError("");
    try {
      console.log(`[SmartApply] 🔄 RETRY — "${item.job_title}" at ${item.company} (queue_id: ${item.id})`);
      await resetToQueued(item.id);
      const ctx = userContext.getContextString({ identity: true });
      const job = { title: item.job_title, company: item.company, description: item.job_description || "" };
      const raw = await askClaude(buildSmartApplyPrompt(ctx, resumeText, job, profile), 8000);
      const jsonStart = raw.indexOf("{"); const jsonEnd = raw.lastIndexOf("}");
      const cleanRaw = (jsonStart >= 0 && jsonEnd > jsonStart) ? raw.slice(jsonStart, jsonEnd + 1) : raw;
      const result = JSON.parse(cleanRaw);
      const integrity = validateSmartApplyPackage(result, resolveCountry(profile?.country));
      if (integrity.ok) {
        await markReady(item.id, result);
        console.log(`[SmartApply] ✅ Retry complete — status: ready ✓`);
      } else {
        await markNeedsReview(item.id, result);
        console.log(`[SmartApply] ⚠️ Retry complete — status: needs_review (${summarizeSmartApplyIntegrity(integrity)})`);
      }
    } catch (e) {
      console.error(`[SmartApply] ❌ RETRY failed for "${item.job_title}":`, e?.code, e?.message, e);
      await markFailed(item.id, item.retry_count);
      setQueueError(t("savedJobs.retryError"));
    } finally {
      setRetryingId(null);
      onQueueChange?.();
    }
  };

  const handlePrepareSmartApply = async (job) => {
    if (!profile?.id) return;
    const resumeText =
      (resumes || []).find(r => r.id === activeResumeId)?.content ||
      (resumes || [])[0]?.content ||
      (typeof sessionStorage !== "undefined" ? sessionStorage.getItem("cp_jobs_resume") || "" : "");
    if (!resumeText.trim()) { setQueueError(t("savedJobs.retryNoResume")); return; }
    const resumeId = activeResumeId || (resumes || [])[0]?.id || null;
    setPreparingIds(prev => new Set([...prev, job.job_id]));
    setQueueError("");
    let queued;
    try {
      const jobForQueue = { id: job.job_id, title: job.title, company: job.company, description: job.job_description || job.description || "" };
      queued = await enqueue(profile.id, jobForQueue, resumeId);
      if (!queued) { onQueueChange?.(); return; } // already queued/ready
      const ctx = userContext.getContextString({ identity: true, applications: true });
      const raw = await askClaude(buildSmartApplyPrompt(ctx, resumeText, jobForQueue, profile), 8000);
      const jsonStart = raw.indexOf("{"); const jsonEnd = raw.lastIndexOf("}");
      const cleanRaw = (jsonStart >= 0 && jsonEnd > jsonStart) ? raw.slice(jsonStart, jsonEnd + 1) : raw;
      const result = JSON.parse(cleanRaw);
      const integrity = validateSmartApplyPackage(result, resolveCountry(profile?.country));
      if (integrity.ok) await markReady(queued.id, result);
      else await markNeedsReview(queued.id, result);
    } catch (e) {
      console.error(`[SmartApply] ❌ Prepare failed for "${job.title}":`, e?.message || e);
      if (queued) await markFailed(queued.id, queued.retry_count);
      setQueueError(t("savedJobs.retryError"));
    } finally {
      setPreparingIds(prev => { const next = new Set(prev); next.delete(job.job_id); return next; });
      onQueueChange?.();
    }
  };

  const removeSavedJob = (jobId) => {
    setSavedJobs(p => p.filter(j => j.job_id !== jobId));
    purgeQueueByJobId?.(jobId);
  };

  const toggleJobExpanded = (jobId) => {
    setExpandedJobs(prev => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId); else next.add(jobId);
      return next;
    });
  };

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 6 }}>{t("savedJobs.heading")}</h1>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 28 }}>{t("savedJobs.subtitleCount").replace("{n}", savedJobs.length)}</p>

      {queueError && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, color: C.red, fontSize: 13, marginBottom: 16 }}>{queueError}</div>}

      {/* ── Section 1: Your Saved Jobs ─────────────────────────── */}
      <div style={{ marginBottom: 36 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("savedJobs.sectionTitle")}</div>
        <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 14 }}>{t("savedJobs.smartApplyHelperText")}</div>
        {savedJobs.length === 0 && (
          <Card style={{ textAlign: "center", padding: 64 }}>
            <div style={{ fontSize: 48, marginBottom: 16 }}>♡</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("savedJobs.emptyTitle")}</div>
            <div style={{ fontSize: 14, color: C.textMuted }}>{t("savedJobs.emptyBody")}</div>
          </Card>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {savedJobs.map(job => {
            const activeEntry = getActiveEntry(job);
            const appliedEntry = getAppliedEntry(job);
            const readyEntry = getReadyEntry(job);
            const isQueued = !!activeEntry;
            const isApplied = !!appliedEntry;
            const isExpanded = expandedJobs.has(job.job_id);
            const hasJobChanges = !!job.previous_description && job.previous_description !== job.description;

            // Status badge
            const isPreparing = preparingIds.has(job.job_id);
            let statusColor = C.textMuted;
            let statusLabel = t("savedJobs.statusSaved");
            if (isApplied) { statusColor = C.blue; statusLabel = t("savedJobs.statusApplied"); }
            else if (activeEntry?.status === "ready") { statusColor = C.green; statusLabel = t("savedJobs.statusAiReady"); }
            else if (activeEntry?.status === "needs_review") { statusColor = C.orange; statusLabel = t("savedJobs.statusNeedsReview"); }
            else if (isPreparing || activeEntry?.status === "queued") { statusColor = C.yellow; statusLabel = t("savedJobs.statusInQueue"); }
            else if (activeEntry?.status === "failed") { statusColor = C.red; statusLabel = t("savedJobs.statusGenFailed"); }

            return (
              <Card key={job.job_id}>
                <div style={{ display: "flex", flexDirection: isMobile ? "column" : "row", justifyContent: isMobile ? "flex-start" : "space-between", gap: isMobile ? 12 : 16, alignItems: isMobile ? "stretch" : "flex-start" }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
                      <div style={{ fontSize: 17, fontWeight: 700, color: C.text }}>{job.title}</div>
                      <Badge color={statusColor}>{statusLabel}</Badge>
                    </div>
                    <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 6 }}>{job.company}{job.location ? ` · ${job.location}` : ""}</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      {job.matchScore && <Badge color={C.purple}>{job.matchScore}{t("savedJobs.matchSuffix")}</Badge>}
                      {(job.salaryMin || job.salaryMax) && <span style={{ fontSize: 13, color: C.green, fontWeight: 600 }}>{fmtSalary(job.salaryMin, job.salaryMax)}</span>}
                      {job.saved_at && <span style={{ fontSize: 12, color: C.textMuted }}>{t("savedJobs.savedDateLabel").replace("{date}", fmtDate(job.saved_at))}</span>}
                      <MissingSkillsBadges skills={readyEntry?.missing_skills} />
                    </div>
                  </div>
                  {(() => {
                    // compact = true on all mobile cards so every state uses identical
                    // row sizing: tighter gap, reduced horizontal padding, primary action flex:1.
                    const compact = isMobile;
                    const secPad = compact ? "9px 10px" : "9px 14px";
                    return (
                    <div style={{ display: "flex", gap: compact ? 6 : 8, flexShrink: 0, alignItems: "center", flexWrap: "nowrap" }}>
                      {!isApplied && (
                        <Btn variant="ghost" style={{ fontSize: 13, padding: secPad, whiteSpace: "nowrap", flexShrink: 0 }} onClick={() => toggleJobExpanded(job.job_id)}>
                          {isExpanded ? t("savedJobs.hideDetails") : t("savedJobs.viewDetails")}
                        </Btn>
                      )}
                      {!isApplied && !readyEntry && (
                        isPreparing || activeEntry?.status === "queued" ? (
                          <Btn disabled style={{ fontSize: 13, padding: secPad, whiteSpace: "nowrap", ...(compact ? { flex: 1, minWidth: 0 } : {}) }}>{t("savedJobs.preparingSmartApply")}</Btn>
                        ) : activeEntry?.status === "failed" ? (
                          <Btn variant="secondary" style={{ fontSize: 13, padding: secPad, whiteSpace: "nowrap", ...(compact ? { flex: 1, minWidth: 0 } : {}) }} onClick={() => handlePrepareSmartApply(job)}>{t("savedJobs.retryGeneration")}</Btn>
                        ) : activeEntry?.status === "needs_review" ? (
                          <Btn variant="secondary" style={{ fontSize: 13, padding: secPad, whiteSpace: "nowrap", ...(compact ? { flex: 1, minWidth: 0 } : {}) }} loading={retryingId === activeEntry.id} onClick={() => handleRetry(activeEntry)}>{t("savedJobs.retryGeneration")}</Btn>
                        ) : (
                          <Btn style={{ fontSize: 13, padding: secPad, whiteSpace: "nowrap", ...(compact ? { flex: 1, minWidth: 0 } : {}) }} onClick={() => handlePrepareSmartApply(job)}>{t("savedJobs.prepareSmartApply")}</Btn>
                        )
                      )}
                      <Btn variant="secondary" style={{ fontSize: 13, padding: secPad, whiteSpace: "nowrap", flexShrink: 0 }} disabled={isPreparing} onClick={() => removeSavedJob(job.job_id)}>{t("savedJobs.remove")}</Btn>
                      {readyEntry && (isMobile ? (
                        <SwipeToApply onApply={() => handleMarkApplied(readyEntry)} applying={applyingId === readyEntry.id} justApplied={appliedId === readyEntry.id} containerStyle={{ flex: 1 }} />
                      ) : appliedId === readyEntry.id ? (
                        <Btn variant="green" disabled style={{ fontSize: 13, padding: secPad }}>{t("savedJobs.appliedConfirm")}</Btn>
                      ) : (
                        <Btn style={{ fontSize: 13, padding: secPad, ...(compact ? { flex: 1, minWidth: 0 } : {}) }} loading={applyingId === readyEntry.id} onClick={() => handleMarkApplied(readyEntry)}>
                          {applyingId === readyEntry.id ? t("savedJobs.applyingBtn") : t("savedJobs.applyBtn")}
                        </Btn>
                      ))}
                    </div>
                  );
                  })()}
                </div>
                {hasJobChanges && !isApplied && (
                  <div style={{ marginTop: 12, padding: "8px 12px", background: C.yellowLight, border: `1px solid ${C.yellow}30`, borderRadius: 8, fontSize: 13, color: C.yellow, fontWeight: 600 }}>
                    {t("savedJobs.jobChangedNotice")}
                  </div>
                )}
                {isExpanded && (() => {
                  const viewEntry = readyEntry || (activeEntry?.status === "needs_review" ? activeEntry : null);
                  return (
                    <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
                      {viewEntry ? <PackageView item={viewEntry} resumes={resumes} savedJob={job} patchQueueItem={patchQueueItem} profile={profile} /> : <SavedJobDetailsView job={job} />}
                    </div>
                  );
                })()}
              </Card>
            );
          })}
        </div>
      </div>

      {/* ── Section 2: Smart Apply Queue ───────────────────────── */}
      {(visibleQueue.length > 0 || queueLoading) && (
        <div id="smart-apply-queue">
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 14 }}>{t("savedJobs.smartApplyQueue")}</div>
          {queueLoading && visibleQueue.length === 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 0" }}>
              <div style={{ width: 14, height: 14, border: `2px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
              <div style={{ fontSize: 13, color: C.textMuted, minWidth: 0 }}>{t("savedJobs.loadingQueue")}</div>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {visibleQueue.map(item => (
              <SmartApplyQueueCard key={item.id} item={item} onApply={handleMarkApplied} onRemove={handleRemoveFromQueue} onRetry={handleRetry} applying={applyingId === item.id} retrying={retryingId === item.id} resumes={resumes} justApplied={appliedId === item.id} savedJobs={savedJobs} patchQueueItem={patchQueueItem} profile={profile} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── PRICING PAGE ──────────────────────────────────────────
function PricingPage({ profile, setPage, billingState, refreshBillingState }) {
  const { t } = useI18n();
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [checkoutError, setCheckoutError] = useState("");
  const [confirmLoading, setConfirmLoading] = useState(false);
  const [checkoutSuccess, setCheckoutSuccess] = useState(false);
  const [confirmError, setConfirmError] = useState("");
  const [successPlanName, setSuccessPlanName] = useState("");
  const bs = billingState?.billingState || "FREE";
  const isAlreadyPro = ["PRO_ACTIVE", "PRO_CANCELING", "PRO_PAST_DUE", "PREMIUM_ACTIVE", "PREMIUM_CANCELING", "ADMIN"].includes(bs);

  // Checkout return: detect session_id in URL hash after Stripe redirect
  useEffect(() => {
    const hashParts = window.location.hash.split("?");
    if (hashParts.length < 2) return;
    const params = new URLSearchParams(hashParts[1]);
    const sessionId = params.get("session_id");
    if (!sessionId) return;
    window.history.replaceState({ page: "pricing" }, "", "#pricing");
    setConfirmLoading(true);
    workerBillingPost("/api/billing/confirm-session", { session_id: sessionId })
      .then(async (data) => {
        if (data.success) {
          const newState = refreshBillingState ? await refreshBillingState() : null;
          setSuccessPlanName(newState?.planDisplayName || "Pro");
          setCheckoutSuccess(true);
        } else {
          setConfirmError(t("pricing.checkoutFailed"));
        }
      })
      .catch((e) => {
        setConfirmError(
          e.workerError === "stripe_not_configured"
            ? t("pricing.connectStripe").replace("{name}", "Pro")
            : t("pricing.checkoutFailed")
        );
      })
      .finally(() => setConfirmLoading(false));
  }, []);

  const handleCheckout = async () => {
    setCheckoutLoading(true); setCheckoutError("");
    try {
      const { url } = await workerBillingPost("/api/billing/checkout-session");
      window.location.href = url;
    } catch (e) {
      setCheckoutError(e.workerError === "stripe_not_configured" ? t("pricing.connectStripe").replace("{name}", "Pro") : e.message);
    } finally { setCheckoutLoading(false); }
  };

  const plans = [
    { id: "free", name: t("pricing.freeName"), price: "$0", sub: t("pricing.freeSub"), color: C.textMuted, features: [t("pricing.freeFeature1"), t("pricing.freeFeature2"), t("pricing.freeFeature3"), t("pricing.freeFeature4"), t("pricing.freeFeature5")], cta: t("pricing.freeCta"), disabled: true },
    { id: "pro", name: t("pricing.proName"), price: "$19", sub: t("pricing.proSub"), color: C.purple, popular: true, features: [t("pricing.proFeature1"), t("pricing.proFeature2"), t("pricing.proFeature3"), t("pricing.proFeature4"), t("pricing.proFeature5"), t("pricing.proFeature6"), t("pricing.proFeature7"), t("pricing.proFeature8")], cta: t("pricing.proCta"), disabled: false },
  ];

  return (
    <div>
      {/* Checkout return — verifying */}
      {confirmLoading && (
        <div style={{ textAlign: "center", padding: "12px 16px", marginBottom: 24, background: C.bgSoft, borderRadius: 12, fontSize: 14, color: C.textMuted }}>
          {t("pricing.checkoutVerifying")}
        </div>
      )}

      {/* Checkout return — success */}
      {checkoutSuccess && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, background: C.greenLight, border: `1.5px solid ${C.green}`, borderRadius: 12, padding: "16px 20px", marginBottom: 24 }}>
          <span style={{ fontSize: 20, flexShrink: 0 }}>🎉</span>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: C.green, fontSize: 15 }}>{t("pricing.checkoutSuccess").replace("{plan}", successPlanName || "Pro")}</div>
          </div>
          <button style={{ background: "none", border: "none", cursor: "pointer", fontSize: 16, color: C.green, padding: 0, lineHeight: 1 }} onClick={() => setCheckoutSuccess(false)}>✕</button>
        </div>
      )}

      {/* Checkout return — error */}
      {confirmError && (
        <div style={{ background: C.redLight, border: `1.5px solid ${C.red}`, borderRadius: 12, padding: "14px 18px", marginBottom: 24, fontSize: 14, color: C.red }}>
          {confirmError}
        </div>
      )}

      <div style={{ textAlign: "center", marginBottom: 36 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 10 }}>{t("pricing.heading")}</h1>
        <p style={{ color: C.textMuted, fontSize: 15 }}>{t("pricing.subheading")}</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, maxWidth: 700, margin: "0 auto" }} className="two-col">
        {plans.map(plan => (
          <Card key={plan.id} style={{ position: "relative", border: plan.popular ? `2px solid ${C.purple}` : `1px solid ${C.border}` }}>
            {plan.popular && <div style={{ position: "absolute", top: -13, left: "50%", transform: "translateX(-50%)", background: `linear-gradient(135deg,${C.purple},${C.purpleMid})`, color: "#fff", fontSize: 11, fontWeight: 700, padding: "3px 16px", borderRadius: 20, whiteSpace: "nowrap" }}>{t("pricing.mostPopular")}</div>}
            <div style={{ fontSize: 17, fontWeight: 800, color: plan.color, marginBottom: 4 }}>{plan.name}</div>
            <div style={{ marginBottom: 6 }}><span style={{ fontSize: 32, fontWeight: 900, color: C.text }}>{plan.price}</span><span style={{ fontSize: 14, color: C.textMuted, marginLeft: 4 }}>{plan.sub}</span></div>
            <div style={{ height: 1, background: C.border, margin: "16px 0 18px" }} />
            {plan.features.map((f, i) => <div key={i} style={{ display: "flex", gap: 10, marginBottom: 10, fontSize: 14, color: C.textMid, lineHeight: 1.5 }}><span style={{ color: plan.color, flexShrink: 0, fontWeight: 700 }}>✓</span>{f}</div>)}
            <div style={{ marginTop: 20 }}>
              {checkoutError && plan.id === "pro" && <div style={{ color: C.red, fontSize: 12, marginBottom: 8 }}>{checkoutError}</div>}
              <Btn
                variant={plan.id === "free" ? "secondary" : "primary"}
                style={{ width: "100%", justifyContent: "center", padding: "13px", opacity: (plan.disabled || (plan.id === "pro" && isAlreadyPro)) ? 0.5 : 1 }}
                disabled={plan.disabled || (plan.id === "pro" && isAlreadyPro) || checkoutLoading}
                onClick={plan.id === "pro" && !isAlreadyPro ? handleCheckout : undefined}
              >
                {plan.id === "pro" && isAlreadyPro ? t("pricing.currentPlan") : (checkoutLoading && plan.id === "pro" ? "…" : plan.cta)}
              </Btn>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ─── PROFILE PAGE ──────────────────────────────────────────
// ─── Career Profile — country-aware display helpers ────────────────────────
// Small built-in tables, same convention as POSTAL_PATTERNS in
// contactNormalization.js: cover common countries explicitly, fall back to a
// sensible generic default for the rest, so salary/location examples reflect
// the profile's selected country instead of always assuming the US.
const COUNTRY_CURRENCY = {
  US: "USD", CA: "CAD", GB: "GBP", AU: "AUD", DE: "EUR", FR: "EUR", ES: "EUR", IT: "EUR",
  PT: "EUR", NL: "EUR", IE: "EUR", TR: "TRY", RU: "RUB", JP: "JPY", KR: "KRW", CN: "CNY",
  IN: "INR", SA: "SAR", AE: "AED", EG: "EGP", MX: "MXN", BR: "BRL", CH: "CHF", SE: "SEK",
  NO: "NOK", PL: "PLN",
};
const COUNTRY_LOCALE = {
  US: "en-US", CA: "en-CA", GB: "en-GB", AU: "en-AU", DE: "de-DE", FR: "fr-FR", ES: "es-ES",
  IT: "it-IT", PT: "pt-PT", NL: "nl-NL", IE: "en-IE", TR: "tr-TR", RU: "ru-RU", JP: "ja-JP",
  KR: "ko-KR", CN: "zh-CN", IN: "hi-IN", SA: "ar-SA", AE: "ar-AE", EG: "ar-EG", MX: "es-MX",
  BR: "pt-BR", CH: "de-CH", SE: "sv-SE", NO: "nb-NO", PL: "pl-PL",
};
const LOCATION_PLACEHOLDER_BY_COUNTRY = {
  US: "San Francisco, CA", CA: "Toronto, ON", GB: "London", AU: "Sydney, NSW", DE: "Berlin",
  FR: "Paris", ES: "Madrid", IT: "Milan", PT: "Lisbon", NL: "Amsterdam", IE: "Dublin",
  TR: "Istanbul", RU: "Moscow", JP: "Tokyo", KR: "Seoul", CN: "Shanghai", IN: "Bengaluru",
  SA: "Riyadh", AE: "Dubai", EG: "Cairo", MX: "Mexico City", BR: "São Paulo", CH: "Zurich",
  SE: "Stockholm", NO: "Oslo", PL: "Warsaw",
};
// Formats a raw digit string as a localized currency amount for display only
// — the stored value (form.desired_salary) always stays a plain digit
// string; this never feeds back into what gets saved. Falls back to
// USD/en-US for any country not in the table above.
function formatSalaryDisplay(raw, country) {
  const digits = String(raw || "").replace(/\D/g, "");
  if (!digits) return "";
  const currency = COUNTRY_CURRENCY[country] || "USD";
  const locale = COUNTRY_LOCALE[country] || "en-US";
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 }).format(Number(digits));
  } catch {
    return digits;
  }
}

// Every free-text field on Career Profile goes through the same Contact
// Normalization Service engine (trim + collapse spacing) — "text" fields
// never fail validation, they only normalize; full_name/email_address/phone
// are the only fields that can actually block a save.
const PROFILE_FIELD_SCHEMA = {
  full_name: "fullName",
  email_address: "email",
  phone: "phone",
  location: "text",
  job_title: "text",
  preferred_job_title: "text",
  preferred_industry: "text",
};
const PROFILE_ERROR_MESSAGE_KEY = {
  full_name: "profile.fullNameRequired",
  email_address: "profile.invalidEmail",
  phone: "profile.invalidPhone",
};

function ProfilePage({ profile, updateProfile }) {
  const { t, language } = useI18n();
  const [form, setForm] = useState({
    full_name: profile?.full_name || "",
    email_address: profile?.email_address || "",
    phone: profile?.phone || "",
    country: profile?.country || "",
    location: profile?.location || "",
    job_title: profile?.job_title || "",
    years_experience: profile?.years_experience || "",
    preferred_job_title: profile?.preferred_job_title || "",
    preferred_industry: profile?.preferred_industry || "",
    work_type: profile?.work_type || "",
    desired_salary: profile?.desired_salary || "",
  });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});
  const [submitted, setSubmitted] = useState(false);
  const [salaryFocused, setSalaryFocused] = useState(false);
  const workTypes = [
    { value: "Remote", label: t("profile.workTypeRemote") },
    { value: "Hybrid", label: t("profile.workTypeHybrid") },
    { value: "On-site", label: t("profile.workTypeOnsite") },
  ];
  const countryDisplayNames = new Intl.DisplayNames([language], { type: "region" });
  const countryOptions = getCountries()
    .map(code => ({ code, label: countryDisplayNames.of(code) }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // Re-runs the shared normalization/validation engine over the whole form.
  // Safe to call on every blur: normalization is idempotent, and the only
  // fields that can ever fail are full_name/email_address/phone.
  const runValidation = (values) => {
    const ctx = { country: resolveCountry(values.country) };
    const { values: normalized, errors: fieldErrors } = validateFields(values, PROFILE_FIELD_SCHEMA, ctx);
    if (!normalized.full_name.trim()) fieldErrors.full_name = "required";
    return { normalized, fieldErrors };
  };

  const handleFieldBlur = (field) => {
    setTouched(p => ({ ...p, [field]: true }));
    const { normalized, fieldErrors } = runValidation(form);
    setForm(normalized);
    setErrors(fieldErrors);
  };

  const save = () => {
    const { normalized, fieldErrors } = runValidation(form);
    setForm(normalized);
    setErrors(fieldErrors);
    setSubmitted(true);
    const firstError = Object.keys(fieldErrors)[0];
    if (firstError) { setError(t(PROFILE_ERROR_MESSAGE_KEY[firstError])); return; } // invalid data never reaches the database
    setError("");
    updateProfile(normalized);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  // Visible once a field has been blurred at least once, or a save was
  // attempted (whichever happens first) — never on first render.
  const fieldError = (field) => ((touched[field] || submitted) && errors[field]) ? t(PROFILE_ERROR_MESSAGE_KEY[field]) : undefined;

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 4 }}>{t("profile.heading")}</h1>
        <p style={{ color: C.textMuted, fontSize: 13 }}>{t("profile.loggedInAs").replace("{email}", profile?.email || "—")}</p>
      </div>

      {error && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, color: C.red, fontSize: 13, marginBottom: 14 }}>{error}</div>}
      {saved && <div style={{ background: C.greenLight, border: `1px solid ${C.green}30`, borderRadius: 9, padding: 12, color: C.green, fontSize: 13, marginBottom: 14 }}>{t("profile.savedSuccess")}</div>}

      {/* Profile Picture */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ width: 72, height: 72, borderRadius: "50%", background: C.purpleLight, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 28, fontWeight: 800, color: C.purple, flexShrink: 0 }}>
            {form.full_name ? form.full_name.split(" ").map(n => n[0]).join("").slice(0, 2).toUpperCase() : "👤"}
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>{form.full_name || t("profile.yourName")}</div>
            <div style={{ fontSize: 14, color: C.textMuted, marginTop: 2 }}>{form.job_title || t("profile.addJobTitle")}</div>
          </div>
        </div>
      </Card>

      <Card style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 18 }}>{t("profile.personalInfo")}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 18 }} className="two-col">
          <Input label={t("profile.fullNameLabel")} value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} onBlur={() => handleFieldBlur("full_name")} placeholder={t("profile.fullNamePlaceholder")} error={fieldError("full_name")} />
          <Input label={t("profile.emailLabel")} value={form.email_address} onChange={e => setForm(f => ({ ...f, email_address: e.target.value }))} onBlur={() => handleFieldBlur("email_address")} placeholder={t("profile.emailPlaceholder")} error={fieldError("email_address")} />
          <Input label={t("profile.phoneLabel")} placeholder={t("profile.phonePlaceholder")} value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} onBlur={() => handleFieldBlur("phone")} error={fieldError("phone")} />
          <Select label={t("profile.countryLabel")} value={form.country} onChange={e => setForm(f => ({ ...f, country: e.target.value }))}>
            <option value="">—</option>
            {countryOptions.map(c => <option key={c.code} value={c.code}>{c.label}</option>)}
          </Select>
          <Input label={t("profile.locationLabel")} placeholder={LOCATION_PLACEHOLDER_BY_COUNTRY[form.country] || t("profile.locationPlaceholder")} value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} onBlur={() => handleFieldBlur("location")} />
        </div>
      </Card>

      <Card>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 18 }}>{t("profile.careerInfo")}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 18 }} className="two-col">
          <Input label={t("profile.currentJobTitleLabel")} placeholder={t("profile.currentJobTitlePlaceholder")} value={form.job_title} onChange={e => setForm(f => ({ ...f, job_title: e.target.value }))} onBlur={() => handleFieldBlur("job_title")} />
          <Input label={t("profile.yearsExpLabel")} placeholder={t("profile.yearsExpPlaceholder")} value={form.years_experience} onChange={e => setForm(f => ({ ...f, years_experience: e.target.value }))} />
          <Input label={t("profile.preferredJobTitleLabel")} placeholder={t("profile.preferredJobTitlePlaceholder")} value={form.preferred_job_title} onChange={e => setForm(f => ({ ...f, preferred_job_title: e.target.value }))} onBlur={() => handleFieldBlur("preferred_job_title")} />
          <Input label={t("profile.preferredIndustryLabel")} placeholder={t("profile.preferredIndustryPlaceholder")} value={form.preferred_industry} onChange={e => setForm(f => ({ ...f, preferred_industry: e.target.value }))} onBlur={() => handleFieldBlur("preferred_industry")} />
          <div>
            <Label>{t("profile.preferredWorkType")}</Label>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              {workTypes.map(wt => (
                <Btn key={wt.value} variant="ghost" onClick={() => setForm(f => ({ ...f, work_type: f.work_type === wt.value ? "" : wt.value }))} style={{ padding: "8px 16px", borderRadius: 20, border: `1.5px solid ${form.work_type === wt.value ? C.purple : C.border}`, background: form.work_type === wt.value ? C.purpleLight : "#fff", color: form.work_type === wt.value ? C.purple : C.textMid, fontSize: 13, fontWeight: 600 }}>{wt.label}</Btn>
              ))}
            </div>
          </div>
          <Input
            label={t("profile.desiredSalaryLabel")}
            placeholder={formatSalaryDisplay(120000, form.country) || t("profile.desiredSalaryPlaceholder")}
            value={salaryFocused ? form.desired_salary : (formatSalaryDisplay(form.desired_salary, form.country) || form.desired_salary)}
            onFocus={() => setSalaryFocused(true)}
            onBlur={() => setSalaryFocused(false)}
            onChange={e => setForm(f => ({ ...f, desired_salary: e.target.value.replace(/[^\d]/g, "") }))}
          />
        </div>
        {submitted && Object.keys(errors).length > 0 && (
          <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, marginBottom: 14 }}>
            <div style={{ color: C.red, fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{t("profile.pleaseFixFollowing")}</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {Object.keys(errors).map(field => <li key={field} style={{ color: C.red, fontSize: 13 }}>{t(PROFILE_ERROR_MESSAGE_KEY[field])}</li>)}
            </ul>
          </div>
        )}
        {/* Mirrors the validation summary above: immediate feedback exactly where
            the user performed the save action, not just at the top of the page. */}
        {saved && <div style={{ background: C.greenLight, border: `1px solid ${C.green}30`, borderRadius: 9, padding: 12, color: C.green, fontSize: 13, marginBottom: 14 }}>{t("profile.savedSuccess")}</div>}
        <Btn onClick={save} style={{ padding: "12px 28px" }}>{saved ? t("profile.saved") : t("profile.saveChanges")}</Btn>
      </Card>
    </div>
  );
}


// ─── OPPORTUNITY INTELLIGENCE PAGE ─────────────────────────
function OpportunityPage({ profile, savedJobs, applications, setPage, watchlist, watchlistAdd, watchlistRemove, watchlistUpdateStatus, referralPatterns, referralAnalysesHook }) {
  const { t } = useI18n();
  const [tab, setTab] = useState("opportunities");
  const [analysis, setAnalysis] = useState(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState(null);
  const [addInput, setAddInput] = useState("");
  const [addingCompany, setAddingCompany] = useState(false);
  const [addError, setAddError] = useState("");

  const { data: salaryData } = useSalaryResearch(profile?.id);
  const [networkContacts] = useNetworkingContacts(profile?.id);

  const saved = savedJobs || [];
  const apps = applications || [];
  const contacts = networkContacts || [];
  const wl = watchlist || [];

  // ── Better Job Opportunities ──────────────────────────────
  const scoredJobs = saved.filter(j => j.matchScore != null).sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));
  const betterJobs = scoredJobs.length ? scoredJobs.slice(0, 8) : saved.slice(0, 8);
  const appliedCompanies = new Set(apps.map(a => (a.company || "").toLowerCase()));

  // ── Salary Improvement Opportunities ─────────────────────
  const desiredNum = profile?.desired_salary ? parseInt(String(profile.desired_salary).replace(/[^0-9]/g, "")) || null : null;
  const marketMedian = salaryData?.results?.marketRange?.median || null;
  const salaryJobs = saved.filter(j => {
    const hi = j.salaryMax || j.salaryMin;
    if (!hi) return false;
    if (desiredNum && hi > desiredNum * 0.95) return true;
    if (marketMedian && hi >= marketMedian * 0.95) return true;
    return false;
  }).sort((a, b) => (b.salaryMax || b.salaryMin || 0) - (a.salaryMax || a.salaryMin || 0));

  // ── Referral Opportunities ────────────────────────────────
  // Single source of truth: every company match, score, and rank below comes from
  // Referral Intelligence's scoringEngine.js (LOCKED as the only referral-scoring
  // implementation) -- this page never recomputes a match, score, or ranking of its
  // own, it only reads what the shared engine already produced.
  const referralPattern = (referralPatterns || []).find(p => p.pattern_type === "referral" && p.pattern_value === "used") || null;
  const referralTargetCompanies = computeTargetCompanies({ watchlist: wl, savedJobs: saved, applications: apps });
  const referralReadinessList = referralTargetCompanies.map(tc => computeCompanyReadiness({
    companyName: tc.companyName, contacts, watchlistEntry: tc.watchlistEntry, hasSavedOrAppliedJob: tc.hasSavedOrAppliedJob, referralPattern,
  }));
  const referralOpportunities = rankByScore(referralReadinessList.filter(Boolean)).map(rc => ({
    ...rc,
    job: saved.find(j => j.company && j.company.toLowerCase() === rc.companyName.toLowerCase()) || null,
  }));
  // Referral Intelligence's persisted AI narrative, read directly -- never recomputed
  // or re-derived here.
  const referralInsight = referralAnalysesHook?.latest?.content?.analyses?.topOpportunities?.finding || null;

  // ── Trending Skills from saved jobs ──────────────────────
  const skillFreq = {};
  saved.forEach(j => (j.skills || []).forEach(s => { skillFreq[s] = (skillFreq[s] || 0) + 1; }));
  const jobTrendingSkills = Object.entries(skillFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // ── Growing Companies from saved jobs ────────────────────
  const coFreq = {};
  saved.forEach(j => { if (j.company) coFreq[j.company] = (coFreq[j.company] || 0) + 1; });
  const frequentCompanies = Object.entries(coFreq).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]);

  // ── Watchlist with saved job counts ──────────────────────
  const watchlistEnriched = wl.map(w => ({
    ...w,
    jobCount: saved.filter(j => j.company && j.company.toLowerCase() === w.company_name.toLowerCase()).length,
    hasContact: matchContactsToCompany(w.company_name, contacts).length > 0,
  }));

  const userContext = useUserContext({ profile, applications, savedJobs, networkContacts: contacts, companyWatchlist: wl });
  const matchColor = matchScoreColor;
  const fmtSal = (min, max) => {
    if (!min && !max) return null;
    const f = n => `$${Math.round(n / 1000)}K`;
    if (min && max) return `${f(min)}–${f(max)}`;
    return min ? `${f(min)}+` : t("opportunity.upTo").replace("{amount}", f(max));
  };

  const refreshAnalysis = async () => {
    setAnalysisLoading(true);
    setAnalysisError(null);
    try {
      const ctx = userContext.getContextString();
      const topSkills = jobTrendingSkills.slice(0, 5).map(([s]) => s).join(", ");
      const topCos = [...new Set(saved.slice(0, 8).map(j => j.company).filter(Boolean))].join(", ");
      const raw = await askClaude(
        `You are a career intelligence advisor. Generate opportunity intelligence for this job seeker. Return ONLY valid JSON with these exact keys:
{"careerPivotOpportunities":[{"role":"...","fit":0,"reason":"1 sentence","skillsNeeded":["..."],"salaryUplift":"+X%"}],"trendingSkills":[{"skill":"...","demand":"Exploding|High|Growing","frequency":0,"salaryPremium":"+X%"}],"emergingIndustries":[{"industry":"...","growth":"+X% YoY","roles":["..."],"avgSalary":"$XXXk"}],"growingCompanies":[{"company":"...","signal":"1 sentence","category":"...","openRoles":0,"yourMatch":0}],"internalPromotionSignals":["1 sentence"]}
User context: ${ctx}. Target role: ${profile?.preferred_job_title || profile?.job_title || "not set"}. Skills from jobs: ${topSkills}. Companies: ${topCos}.`,
        1800
      );
      const s = raw.indexOf("{"); const e = raw.lastIndexOf("}");
      const result = s >= 0 && e > s ? JSON.parse(raw.slice(s, e + 1)) : null;
      if (!result?.careerPivotOpportunities) throw new Error("invalid");
      setAnalysis({ ...result, generatedAt: new Date().toISOString() });
      insertNotification(profile?.id, { type: "opportunity", title: "Opportunity analysis ready.", body: "A new career opportunity analysis is available." });
    } catch {
      setAnalysisError(t("opportunity.analysisFailed"));
    } finally {
      setAnalysisLoading(false);
    }
  };

  const handleAdd = async (status = "watching") => {
    if (!addInput.trim()) return;
    setAddingCompany(true);
    setAddError("");
    try {
      await watchlistAdd(addInput.trim(), status);
      setAddInput("");
    } catch {
      setAddError(t("opportunity.addCompanyFailed"));
    } finally {
      setAddingCompany(false);
    }
  };

  const pageTabs = [
    { id: "opportunities", label: t("opportunity.tabOpportunities") },
    { id: "watchlist", label: `${t("opportunity.tabWatchlist")}${wl.length ? ` (${wl.length})` : ""}` },
    { id: "trends", label: t("opportunity.tabTrends") },
  ];

  return (
    <div>
      <button onClick={() => setPage("dashboard")} style={{ border: "none", background: "none", color: C.textMuted, fontSize: 13, cursor: "pointer", padding: "0 0 20px 0", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}>
        {t("opportunity.backToDashboard")}
      </button>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8, gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: C.purple, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: `0 4px 16px ${C.purple}40` }}>
            <span style={{ fontSize: 24 }}>🎯</span>
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: C.text, marginBottom: 4 }}>{t("opportunity.pageTitle")}</h1>
            <p style={{ fontSize: 13, color: C.textMuted }}>{t("opportunity.pageSubtitle")}</p>
          </div>
        </div>
        <Btn variant="secondary" style={{ fontSize: 12, padding: "6px 14px", flexShrink: 0 }} onClick={refreshAnalysis} loading={analysisLoading}>
          {analysisLoading ? t("opportunity.analyzing") : t("opportunity.refreshAnalysis")}
        </Btn>
      </div>

      {analysis?.generatedAt && (
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 20 }}>
          {t("opportunity.analysisGenerated").replace("{date}", new Date(analysis.generatedAt).toLocaleString())}
        </div>
      )}

      {analysisError && (
        <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, color: C.red, fontSize: 13, marginBottom: 16 }}>{analysisError}</div>
      )}

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 24 }}>
        {pageTabs.map(tItem => (
          <button key={tItem.id} onClick={() => setTab(tItem.id)} style={{ border: "none", background: "none", padding: "10px 16px", fontSize: 14, fontWeight: tab === tItem.id ? 700 : 500, color: tab === tItem.id ? C.purple : C.textMuted, cursor: "pointer", borderBottom: `2px solid ${tab === tItem.id ? C.purple : "transparent"}`, marginBottom: -1, fontFamily: "inherit" }}>
            {tItem.label}
          </button>
        ))}
      </div>

      {/* ── OPPORTUNITIES TAB ── */}
      {tab === "opportunities" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Better Job Opportunities */}
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 3 }}>{t("opportunity.betterJobsTitle")}</div>
                <div style={{ fontSize: 12, color: C.textMuted }}>{t("opportunity.betterJobsSubtitle")}</div>
              </div>
              <Btn variant="secondary" style={{ padding: "5px 12px", fontSize: 12, flexShrink: 0 }} onClick={() => setPage("jobs")}>{t("opportunity.findMoreJobs")}</Btn>
            </div>
            {betterJobs.length === 0 ? (
              <div style={{ fontSize: 13, color: C.textMuted, textAlign: "center", padding: "24px 0" }}>
                {t("opportunity.betterJobsEmpty")}
                <div style={{ marginTop: 12 }}><Btn variant="secondary" style={{ fontSize: 12, padding: "6px 14px" }} onClick={() => setPage("jobs")}>{t("opportunity.goToJobSearch")}</Btn></div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {betterJobs.map((j, i) => {
                  const sal = fmtSal(j.salaryMin, j.salaryMax);
                  const applied = appliedCompanies.has((j.company || "").toLowerCase());
                  const watched = wl.some(w => w.company_name?.toLowerCase() === (j.company || "").toLowerCase());
                  const refCon = matchContactsToCompany(j.company, contacts)[0];
                  return (
                    <div key={j.job_id || i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 0", borderBottom: i < betterJobs.length - 1 ? `1px solid ${C.border}` : "none", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap", marginBottom: 3 }}>
                          <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{j.title}</span>
                          {watched && <span style={{ fontSize: 10, fontWeight: 700, color: C.purple, background: C.purpleLight, borderRadius: 8, padding: "2px 6px" }}>{t("opportunity.watchedBadge")}</span>}
                          {refCon && <span style={{ fontSize: 10, fontWeight: 700, color: C.green, background: C.greenLight, borderRadius: 8, padding: "2px 6px" }}>{t("opportunity.referralBadge")}</span>}
                          {applied && <span style={{ fontSize: 10, fontWeight: 700, color: C.blue, background: C.blueLight, borderRadius: 8, padding: "2px 6px" }}>{t("opportunity.appliedBadge")}</span>}
                        </div>
                        <div style={{ fontSize: 13, color: C.textMuted }}>{j.company}{j.location ? ` · ${j.location}` : ""}{sal ? ` · ${sal}` : ""}</div>
                        {refCon && <div style={{ fontSize: 11, color: C.green, marginTop: 3 }}>{t("opportunity.youKnowContact").replace("{name}", refCon.name)}</div>}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                        {j.matchScore != null && (
                          <div style={{ textAlign: "center" }}>
                            <div style={{ fontSize: 18, fontWeight: 800, color: matchColor(j.matchScore) }}>{j.matchScore}%</div>
                            <div style={{ fontSize: 9, color: C.textMuted, fontWeight: 600 }}>{t("opportunity.matchLabel")}</div>
                          </div>
                        )}
                        {j.applyUrl && <a href={j.applyUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: C.purple, fontWeight: 600, textDecoration: "none" }}>{t("opportunity.applyLink")}</a>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {saved.length > 0 && (
              <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Btn variant="secondary" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => setPage("saved")}>{t("opportunity.allSavedJobs")}</Btn>
                <Btn variant="secondary" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => setPage("tracker")}>{t("opportunity.applicationTracker")}</Btn>
              </div>
            )}
          </Card>

          {/* Salary Improvement Opportunities */}
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 3 }}>{t("opportunity.salaryOppTitle")}</div>
                <div style={{ fontSize: 12, color: C.textMuted }}>
                  {desiredNum ? t("opportunity.salaryOppTargetSubtitle").replace("{n}", Math.round(desiredNum / 1000)) : marketMedian ? t("opportunity.salaryOppMarketSubtitle").replace("{n}", Math.round(marketMedian / 1000)) : t("opportunity.salaryOppDefaultSubtitle")}
                </div>
              </div>
              <Btn variant="secondary" style={{ padding: "5px 12px", fontSize: 12, flexShrink: 0 }} onClick={() => setPage("salary")}>{t("opportunity.salaryResearch")}</Btn>
            </div>
            {salaryData?.results?.marketRange && (
              <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                {[[t("opportunity.marketLow"), salaryData.results.marketRange.low, C.textMuted], [t("opportunity.marketMedian"), salaryData.results.marketRange.median, C.green], [t("opportunity.marketHigh"), salaryData.results.marketRange.high, C.purple]].map(([label, val, color]) => val ? (
                  <div key={label} style={{ flex: 1, minWidth: 72, background: C.bgSoft, borderRadius: 8, padding: "8px 10px", textAlign: "center" }}>
                    <div style={{ fontSize: 15, fontWeight: 800, color }}>${Math.round(val / 1000)}K</div>
                    <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 600 }}>{label}</div>
                  </div>
                ) : null)}
              </div>
            )}
            {salaryJobs.length === 0 ? (
              <div style={{ fontSize: 13, color: C.textMuted, padding: "12px 0" }}>
                {!desiredNum && !marketMedian
                  ? t("opportunity.salaryOppEmpty1")
                  : t("opportunity.salaryOppEmpty2")}
                <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {!desiredNum && <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("profile")}>{t("opportunity.updateProfile")}</Btn>}
                  <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("salary")}>{t("opportunity.researchSalaries")}</Btn>
                  <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("jobs")}>{t("opportunity.findJobs")}</Btn>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {salaryJobs.slice(0, 5).map((j, i) => {
                  const sal = fmtSal(j.salaryMin, j.salaryMax);
                  return (
                    <div key={j.job_id || i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 0", borderBottom: i < Math.min(salaryJobs.length, 5) - 1 ? `1px solid ${C.border}` : "none", gap: 12 }}>
                      <div style={{ flex: 1, minWidth: 180 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{j.title}</div>
                        <div style={{ fontSize: 13, color: C.textMuted }}>{j.company}{j.location ? ` · ${j.location}` : ""}</div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 800, color: C.green }}>{sal}</div>
                        {j.matchScore != null && <span style={{ fontSize: 11, fontWeight: 700, color: matchColor(j.matchScore) }}>{j.matchScore}%</span>}
                        {j.applyUrl && <a href={j.applyUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: C.purple, fontWeight: 600, textDecoration: "none" }}>{t("opportunity.applyLink")}</a>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Referral Opportunities */}
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 3 }}>{t("opportunity.referralOppTitle")}</div>
                <div style={{ fontSize: 12, color: C.textMuted }}>{t("opportunity.referralOppSubtitle")}</div>
              </div>
              <Btn variant="secondary" style={{ padding: "5px 12px", fontSize: 12, flexShrink: 0 }} onClick={() => setPage("network")}>{t("opportunity.manageNetwork")}</Btn>
            </div>
            {referralOpportunities.length === 0 ? (
              <div style={{ fontSize: 13, color: C.textMuted, padding: "12px 0" }}>
                {contacts.length === 0 ? t("opportunity.referralEmpty1") : t("opportunity.referralEmpty2")}
                <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("network")}>{t("opportunity.addContacts")}</Btn>
                  <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("jobs")}>{t("opportunity.saveMoreJobs")}</Btn>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {referralInsight && (
                  <div style={{ background: C.purpleLight, border: `1px solid ${C.purple}20`, borderRadius: 10, padding: "10px 14px", fontSize: 12, color: C.textMid, lineHeight: 1.6 }}>
                    <span style={{ fontWeight: 700, color: C.purple }}>{t("opportunity.referralAiInsightLabel")}</span> {referralInsight}
                  </div>
                )}
                {referralOpportunities.slice(0, 5).map(rc => (
                  <div key={rc.companyName} style={{ background: C.greenLight, border: `1px solid ${C.green}20`, borderRadius: 10, padding: "12px 14px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 2 }}>{rc.job ? `${rc.job.title} — ${rc.companyName}` : rc.companyName}</div>
                        <div style={{ fontSize: 12, color: C.green, fontWeight: 600 }}>{t("opportunity.contactWorksHere").replace("{name}", rc.bestContact.contact.name)}</div>
                        {rc.bestContact.contact.email && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>{rc.bestContact.contact.email}</div>}
                        {rc.job?.matchScore != null && <div style={{ fontSize: 12, color: matchColor(rc.job.matchScore), fontWeight: 600, marginTop: 4 }}>{t("opportunity.matchPct").replace("{pct}", rc.job.matchScore)}</div>}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
                        <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("network")}>{t("opportunity.draftMessage")}</Btn>
                        {rc.job?.applyUrl && <a href={rc.job.applyUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}><Btn style={{ fontSize: 12, padding: "5px 12px" }}>{t("opportunity.applyBtn")}</Btn></a>}
                        {!rc.job && <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("jobs")}>{t("opportunity.findJobs")}</Btn>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Internal Promotion Signals */}
          <Card>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>{t("opportunity.promoSignalsTitle")}</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>{t("opportunity.promoSignalsSubtitle")}</div>
            {analysis?.internalPromotionSignals?.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {analysis.internalPromotionSignals.map((sig, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span style={{ color: C.purple, fontWeight: 800, flexShrink: 0, fontSize: 14 }}>→</span>
                    <span style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>{sig}</span>
                  </div>
                ))}
                <div style={{ marginTop: 6, display: "flex", gap: 8 }}>
                  <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("interview")}>{t("opportunity.interviewPrep")}</Btn>
                  <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("resume")}>{t("opportunity.updateResume")}</Btn>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: C.textMuted }}>
                {analysisLoading ? t("opportunity.promoSignalsLoading") : t("opportunity.promoSignalsEmpty")}
                {!analysisLoading && <div style={{ marginTop: 10 }}><Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={refreshAnalysis}>{t("opportunity.generateAnalysis")}</Btn></div>}
              </div>
            )}
          </Card>

          {/* Career Pivot Opportunities */}
          <Card>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>{t("opportunity.pivotTitle")}</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>{t("opportunity.pivotSubtitle")}</div>
            {analysis?.careerPivotOpportunities?.length > 0 ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }} className="three-col">
                {analysis.careerPivotOpportunities.map((opp, i) => (
                  <div key={i} style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.text, lineHeight: 1.3, flex: 1, marginRight: 8 }}>{opp.role}</div>
                      <div style={{ textAlign: "center", flexShrink: 0 }}>
                        <div style={{ fontSize: 16, fontWeight: 800, color: matchColor(opp.fit) }}>{opp.fit}%</div>
                        <div style={{ fontSize: 9, color: C.textMuted, fontWeight: 600 }}>{t("opportunity.fitLabel")}</div>
                      </div>
                    </div>
                    {opp.salaryUplift && <div style={{ fontSize: 12, color: C.green, fontWeight: 700, marginBottom: 8 }}>{t("opportunity.salaryUplift").replace("{n}", opp.salaryUplift)}</div>}
                    <div style={{ fontSize: 12, color: C.textMid, lineHeight: 1.5, marginBottom: 10 }}>{opp.reason}</div>
                    {opp.skillsNeeded?.length > 0 && (
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, marginBottom: 5, letterSpacing: 0.5 }}>{t("opportunity.skillsToAdd")}</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
                          {opp.skillsNeeded.map(s => <span key={s} style={{ fontSize: 11, color: C.purple, background: C.purpleLight, borderRadius: 6, padding: "2px 7px", fontWeight: 600 }}>{s}</span>)}
                        </div>
                      </div>
                    )}
                    <Btn variant="secondary" style={{ fontSize: 11, padding: "4px 10px", width: "100%" }} onClick={() => setPage("jobs")}>{t("opportunity.searchThisRole")}</Btn>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: C.textMuted }}>
                {analysisLoading ? t("opportunity.pivotLoading") : t("opportunity.pivotEmpty")}
                {!analysisLoading && <div style={{ marginTop: 10 }}><Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={refreshAnalysis}>{t("opportunity.generateAnalysis")}</Btn></div>}
              </div>
            )}
          </Card>

          {/* Cross-module quick actions */}
          <Card style={{ background: C.bgSoft }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.navText, marginBottom: 12 }}>{t("opportunity.continueInApp")}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[[t("opportunity.quickLinkResume"), "resume"], [t("opportunity.quickLinkInterview"), "interview"], [t("opportunity.quickLinkSalary"), "salary"], [t("opportunity.quickLinkNetworking"), "network"], [t("opportunity.quickLinkSmartApply"), "saved"], [t("opportunity.quickLinkApplicationTracker"), "tracker"], [t("opportunity.quickLinkBriefing"), "briefing"], [t("opportunity.quickLinkPlan"), "plan"]].map(([label, pid]) => (
                <Btn key={pid} variant="secondary" style={{ fontSize: 12, padding: "6px 14px" }} onClick={() => setPage(pid)}>{label} →</Btn>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* ── COMPANY WATCHLIST TAB ── */}
      {tab === "watchlist" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <Card>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 14 }}>{t("opportunity.trackCompanyTitle")}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                value={addInput}
                onChange={e => setAddInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleAdd("watching")}
                placeholder={t("opportunity.trackCompanyPlaceholder")}
                style={{ flex: 1, minWidth: 200, border: `1.5px solid ${C.border}`, borderRadius: 9, padding: "10px 14px", fontSize: 14, color: C.text, outline: "none", fontFamily: "inherit" }}
              />
              <Btn style={{ padding: "10px 20px" }} onClick={() => handleAdd("watching")} loading={addingCompany}>{t("opportunity.watchBtn")}</Btn>
              <Btn variant="secondary" style={{ padding: "10px 20px" }} onClick={() => handleAdd("dream_company")} loading={addingCompany}>{t("opportunity.dreamBtn")}</Btn>
            </div>
            {addError && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{addError}</div>}
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 10 }}>{t("opportunity.trackCompanyHint")}</div>
          </Card>

          {watchlistEnriched.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "40px 24px" }}>
              <div style={{ fontSize: 36, marginBottom: 14 }}>🏢</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("opportunity.watchlistEmptyTitle")}</div>
              <div style={{ fontSize: 13, color: C.textMuted, maxWidth: 380, margin: "0 auto" }}>
                {t("opportunity.watchlistEmptyBody")}
              </div>
            </Card>
          ) : (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {watchlistEnriched.map(w => (
                  <Card key={w.id}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 14, flexWrap: "wrap", alignItems: "flex-start" }}>
                      <div style={{ flex: 1, minWidth: 180 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6, flexWrap: "wrap" }}>
                          <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{w.company_name}</div>
                          <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 10, background: w.status === "dream_company" ? "#FEF3C7" : C.purpleLight, color: w.status === "dream_company" ? "#B45309" : C.purple }}>
                            {w.status === "dream_company" ? t("opportunity.dreamBadge") : t("opportunity.watchingBadge")}
                          </span>
                        </div>
                        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                          {w.jobCount > 0 && <div style={{ fontSize: 12, color: C.blue }}>{w.jobCount !== 1 ? t("opportunity.savedJobPlural").replace("{n}", w.jobCount) : t("opportunity.savedJobSingular").replace("{n}", w.jobCount)}</div>}
                          {w.hasContact && <div style={{ fontSize: 12, color: C.green }}>{t("opportunity.hasContactHere")}</div>}
                        </div>
                        {w.notes && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6, lineHeight: 1.5 }}>{w.notes}</div>}
                      </div>
                      <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap" }}>
                        <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => watchlistUpdateStatus(w.id, w.status === "dream_company" ? "watching" : "dream_company")}>
                          {w.status === "dream_company" ? t("opportunity.toWatching") : t("opportunity.dreamBtn")}
                        </Btn>
                        {w.jobCount > 0 && <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("saved")}>{t("opportunity.viewJobs")}</Btn>}
                        {w.hasContact && <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("network")}>{t("opportunity.contactBtn")}</Btn>}
                        <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px", color: C.red }} onClick={() => watchlistRemove(w.id)}>✕</Btn>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>

              <Card style={{ background: C.bgSoft }}>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "space-around" }}>
                  {[[t("opportunity.statTracked"), wl.length, C.purple], [t("opportunity.statDreamCos"), wl.filter(w => w.status === "dream_company").length, "#B45309"], [t("opportunity.statJobsFound"), watchlistEnriched.reduce((s, w) => s + w.jobCount, 0), C.blue], [t("opportunity.statWithContacts"), watchlistEnriched.filter(w => w.hasContact).length, C.green]].map(([label, val, color]) => (
                    <div key={label} style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color }}>{val}</div>
                      <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600 }}>{label}</div>
                    </div>
                  ))}
                </div>
              </Card>
            </>
          )}
        </div>
      )}

      {/* ── MARKET TRENDS TAB ── */}
      {tab === "trends" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

          {/* Trending Skills */}
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 3 }}>{t("opportunity.trendingSkillsTitle")}</div>
                <div style={{ fontSize: 12, color: C.textMuted }}>{t("opportunity.trendingSkillsSubtitle")}</div>
              </div>
              <Btn variant="secondary" style={{ padding: "5px 12px", fontSize: 12, flexShrink: 0 }} onClick={() => setPage("resume")}>{t("opportunity.updateResume")}</Btn>
            </div>
            {analysis?.trendingSkills?.length > 0 ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }} className="two-col">
                {analysis.trendingSkills.map((s, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: C.bgSoft, borderRadius: 9, padding: "10px 14px" }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{s.skill}</div>
                      <div style={{ fontSize: 11, fontWeight: 700, marginTop: 2, color: s.demand === "Exploding" ? C.red : s.demand === "High" ? C.orange : C.yellow }}>
                        {s.demand === "Exploding" ? "🔥" : s.demand === "High" ? "📈" : "↗"} {tStatusVal(s.demand, t)}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 14, fontWeight: 800, color: C.green }}>{s.salaryPremium}</div>
                      <div style={{ fontSize: 10, color: C.textMuted }}>{t("opportunity.salaryPremium")}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : jobTrendingSkills.length > 0 ? (
              <div>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10 }}>{t("opportunity.fromSavedJobs").replace("{n}", saved.length)}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                  {jobTrendingSkills.map(([skill, count]) => (
                    <div key={skill} style={{ display: "flex", alignItems: "center", gap: 5, background: C.purpleLight, borderRadius: 20, padding: "6px 12px" }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: C.purple }}>{skill}</span>
                      <span style={{ fontSize: 11, color: C.textMuted }}>×{count}</span>
                    </div>
                  ))}
                </div>
                <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={refreshAnalysis} loading={analysisLoading}>{analysisLoading ? t("opportunity.analyzing") : t("opportunity.getAiDemandInsights")}</Btn>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: C.textMuted }}>
                {t("opportunity.trendingSkillsEmpty")}
                <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                  <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("jobs")}>{t("opportunity.findJobs")}</Btn>
                  <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={refreshAnalysis} loading={analysisLoading}>{t("opportunity.aiAnalysis")}</Btn>
                </div>
              </div>
            )}
          </Card>

          {/* Emerging Industries */}
          <Card>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>{t("opportunity.emergingIndustriesTitle")}</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>{t("opportunity.emergingIndustriesSubtitle")}</div>
            {analysis?.emergingIndustries?.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {analysis.emergingIndustries.map((ind, i) => (
                  <div key={i} style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{ind.industry}</div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 800, color: C.green, background: C.greenLight, borderRadius: 8, padding: "3px 9px" }}>↑ {ind.growth}</span>
                        {ind.avgSalary && <span style={{ fontSize: 12, fontWeight: 700, color: C.purple, background: C.purpleLight, borderRadius: 8, padding: "3px 9px" }}>{ind.avgSalary} {t("opportunity.avgLabel")}</span>}
                      </div>
                    </div>
                    {ind.roles?.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
                        {ind.roles.map(r => <span key={r} style={{ fontSize: 11, color: C.textMid, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 6, padding: "2px 8px" }}>{r}</span>)}
                      </div>
                    )}
                    <Btn variant="secondary" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => setPage("jobs")}>{t("opportunity.exploreJobs")}</Btn>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: C.textMuted }}>
                {analysisLoading ? t("opportunity.emergingLoading") : t("opportunity.emergingEmpty")}
                {!analysisLoading && <div style={{ marginTop: 10 }}><Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={refreshAnalysis}>{t("opportunity.generateAnalysis")}</Btn></div>}
              </div>
            )}
          </Card>

          {/* Growing Companies */}
          <Card>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>{t("opportunity.growingCompaniesTitle")}</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>{t("opportunity.growingCompaniesSubtitle")}</div>
            {frequentCompanies.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 8 }}>{t("opportunity.activeInSavedJobs")}</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {frequentCompanies.map(([company, count]) => (
                    <div key={company} style={{ display: "flex", alignItems: "center", gap: 5, background: C.purpleLight, borderRadius: 20, padding: "6px 12px" }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: C.purple }}>{company}</span>
                      <span style={{ fontSize: 11, color: C.textMuted }}>{t("opportunity.rolesCount").replace("{n}", count)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {analysis?.growingCompanies?.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {frequentCompanies.length > 0 && <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 2 }}>{t("opportunity.aiMarketIntelligence")}</div>}
                {analysis.growingCompanies.map((c, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "12px 14px", background: C.bgSoft, borderRadius: 9, flexWrap: "wrap", alignItems: "flex-start" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{c.company}</span>
                        {c.category && <Badge color={C.purple}>{c.category}</Badge>}
                      </div>
                      <div style={{ fontSize: 12, color: C.textMid, lineHeight: 1.5, marginBottom: 4 }}>{c.signal}</div>
                      {c.openRoles > 0 && <div style={{ fontSize: 11, color: C.blue }}>{t("opportunity.openRoles").replace("{n}", c.openRoles)}</div>}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
                      {c.yourMatch != null && (
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 15, fontWeight: 800, color: matchColor(c.yourMatch) }}>{c.yourMatch}%</div>
                          <div style={{ fontSize: 9, color: C.textMuted }}>{t("opportunity.matchLabel")}</div>
                        </div>
                      )}
                      <Btn variant="secondary" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => setPage("jobs")}>{t("opportunity.searchBtn")}</Btn>
                    </div>
                  </div>
                ))}
              </div>
            ) : frequentCompanies.length === 0 ? (
              <div style={{ fontSize: 13, color: C.textMuted }}>
                {analysisLoading ? t("opportunity.growingLoading") : t("opportunity.growingEmpty")}
                {!analysisLoading && <div style={{ marginTop: 10 }}><Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={refreshAnalysis}>{t("opportunity.generateAnalysis")}</Btn></div>}
              </div>
            ) : null}
          </Card>

          {/* Market Intelligence from Salary Research */}
          {salaryData?.results ? (
            <Card>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>{t("opportunity.marketIntelTitle")}</div>
              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>
                {salaryData.results.location
                  ? t("opportunity.marketIntelSubtitleWithLocation").replace("{role}", salaryData.results.jobTitle || profile?.preferred_job_title || "your role").replace("{location}", salaryData.results.location)
                  : t("opportunity.marketIntelSubtitleBase").replace("{role}", salaryData.results.jobTitle || profile?.preferred_job_title || "your role")}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                {[[t("opportunity.demandLabel"), tStatusVal(salaryData.results.demandLevel, t), salaryData.results.demandLevel === "High" ? C.green : C.yellow], [t("opportunity.trendLabel"), salaryData.results.trend, salaryData.results.trendDirection === "up" ? C.green : C.textMuted]].map(([label, val, color]) => val ? (
                  <div key={label} style={{ background: C.bgSoft, borderRadius: 9, padding: "8px 14px" }}>
                    <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600 }}>{label}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color }}>{val}</div>
                  </div>
                ) : null)}
                {(salaryData.results.skills || []).length > 0 && (
                  <div style={{ flex: 1, background: C.bgSoft, borderRadius: 9, padding: "8px 14px" }}>
                    <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, marginBottom: 4 }}>{t("opportunity.topSkillsLabel")}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {salaryData.results.skills.slice(0, 4).map(s => <Badge key={s} color={C.purple}>{s}</Badge>)}
                    </div>
                  </div>
                )}
              </div>
              {salaryData.results.topPayingCompanies?.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 8 }}>{t("opportunity.topPayingCompanies")}</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {salaryData.results.topPayingCompanies.map(co => <span key={co} style={{ fontSize: 12, color: C.textMid, background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 8, padding: "4px 10px" }}>{co}</span>)}
                  </div>
                </div>
              )}
              <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("salary")}>{t("opportunity.fullSalaryReport")}</Btn>
            </Card>
          ) : (
            <Card style={{ background: C.bgSoft }}>
              <div style={{ fontSize: 13, color: C.textMuted }}>
                <strong style={{ color: C.text }}>{t("opportunity.unlockMarketIntel")}</strong> {t("opportunity.unlockMarketIntelBody")}
                <div style={{ marginTop: 10 }}><Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("salary")}>{t("opportunity.researchSalaries")}</Btn></div>
              </div>
            </Card>
          )}
        </div>
      )}

      <div style={{ textAlign: "center", paddingTop: 32 }}>
        <button onClick={() => setPage("dashboard")} style={{ border: "none", background: "none", color: C.purple, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>{t("opportunity.backToDashboard")}</button>
      </div>
    </div>
  );
}

// ─── JOB TRACKER PAGE ──────────────────────────────────────
// Job Tracker is a watchlist, not an application tool. Per the locked
// architecture and the Explicit Non-Behavior Checklist, this page and every
// handler in it must never read from or write to applications or
// smart_apply_queue, and must never use the Application Tracker's status
// vocabulary (Applied, Phone Screen, Interview, ...). It only ever writes to
// job_watchlist / company_watchlist, both fully independent tables.
const JOB_TRACKER_STATUS_FILTERS = ["All", "Updated", "New Match", "Closed"];

function JobTrackerPage({ profile, resumes, activeResumeId, companyWatchlist, jobWatchlist, setPage }) {
  const { t, language } = useI18n();
  const [tab, setTab] = useSessionState("cp_tracker_tab", "opportunities");
  const [filterStatus, setFilterStatus] = useSessionState("cp_jobtracker_filter", "All");
  const [search, setSearch] = useSessionState("cp_jobtracker_search", "");
  const [sortBy, setSortBy] = useSessionState("cp_jobtracker_sort", "changed");
  const [addCompanyInput, setAddCompanyInput] = useState("");
  const [addingCompany, setAddingCompany] = useState(false);
  const [addError, setAddError] = useState("");
  const [removingId, setRemovingId] = useState(null);

  const [skillDictionary, setSkillDictionary] = useState({});
  useEffect(() => { loadSkillSynonyms().then(setSkillDictionary); }, []);
  const activeResume = useMemo(() => (resumes || []).find(r => r.id === activeResumeId) || null, [resumes, activeResumeId]);
  const resumeText = activeResume?.content || "";
  const resumeSkills = useMemo(() => extractSkillKeywords(resumeText), [resumeText]);
  const fmtDate = (str) => { if (!str) return ""; try { return new Date(str).toLocaleDateString(language, { month: "short", day: "numeric", year: "numeric" }); } catch { return ""; } };
  const fmtSal = (min, max) => { if (!min && !max) return null; const f = n => `$${Math.round(n / 1000)}K`; return min && max ? `${f(min)}–${f(max)}` : f(min || max); };

  const jobs = useMemo(() => jobWatchlist.watchlist || [], [jobWatchlist.watchlist]);
  const companies = useMemo(() => companyWatchlist.watchlist || [], [companyWatchlist.watchlist]);

  // Live Match % via the same deterministic Compatibility Engine used
  // everywhere else -- zero AI calls. Skills are re-extracted from the
  // stored description snapshot since job_watchlist doesn't duplicate the
  // worker's server-side skills array.
  const jobsWithMatch = useMemo(() => jobs.map(row => {
    const job = { id: row.job_id, title: row.job_title, company: row.company, location: row.location, salaryMin: row.salary_min, salaryMax: row.salary_max, remote: row.remote, skills: extractSkillKeywords(row.description || "") };
    const cr = resumeText.trim() ? buildCompatibilityRecord({ job, profile, resumeSkills, skillDictionary }) : null;
    return { ...row, matchScore: cr?.match_score ?? null };
  }), [jobs, profile, resumeSkills, skillDictionary, resumeText]);

  const filteredJobs = jobsWithMatch.filter(row => {
    if (filterStatus === "Updated" && !row.has_unread_change) return false;
    if (filterStatus === "Closed" && row.status !== "closed") return false;
    if (filterStatus === "New Match" && !(row.matchScore != null && row.matchScore >= 80)) return false;
    const q = search.trim().toLowerCase();
    if (q && !(row.job_title || "").toLowerCase().includes(q) && !(row.company || "").toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => {
    if (sortBy === "match") return (b.matchScore ?? -1) - (a.matchScore ?? -1);
    if (sortBy === "date") return new Date(b.created_at) - new Date(a.created_at);
    if (!!b.has_unread_change !== !!a.has_unread_change) return b.has_unread_change ? 1 : -1;
    return new Date(b.last_checked_at || b.created_at) - new Date(a.last_checked_at || a.created_at);
  });

  const filteredCompanies = companies.filter(c => {
    const q = search.trim().toLowerCase();
    return !q || (c.company_name || "").toLowerCase().includes(q);
  });

  const updatedCount = jobs.filter(j => j.has_unread_change).length;

  const handleAddCompany = async () => {
    if (!addCompanyInput.trim()) return;
    setAddingCompany(true); setAddError("");
    try { await companyWatchlist.add(addCompanyInput.trim()); setAddCompanyInput(""); }
    catch { setAddError(t("jobTracker.addCompanyFailed")); }
    finally { setAddingCompany(false); }
  };
  const handleRemoveJob = async (id) => { setRemovingId(id); try { await jobWatchlist.remove(id); } catch {} finally { setRemovingId(null); } };
  const handleRemoveCompany = async (id) => { setRemovingId(id); try { await companyWatchlist.remove(id); } catch {} finally { setRemovingId(null); } };
  const markSeen = (row) => { if (row.has_unread_change) jobWatchlist.applyChange(row.id, { has_unread_change: false }); };

  const activity = jobs.filter(j => j.has_unread_change)
    .map(j => ({ id: `job-${j.id}`, title: j.job_title, company: j.company, summary: j.ai_change_summary, date: j.last_checked_at }))
    .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  const tabs = [
    { id: "opportunities", label: `${t("jobTracker.tabOpportunities")}${jobs.length ? ` (${jobs.length})` : ""}` },
    { id: "companies", label: `${t("jobTracker.tabCompanies")}${companies.length ? ` (${companies.length})` : ""}` },
    { id: "activity", label: `${t("jobTracker.tabActivity")}${activity.length ? ` (${activity.length})` : ""}` },
  ];

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 4 }}>{t("jobTracker.heading")}</h1>
        <p style={{ color: C.textMuted, fontSize: 14 }}>{t("jobTracker.summaryLine").replace("{n}", jobs.length + companies.length).replace("{u}", updatedCount)}</p>
      </div>

      <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 20, overflowX: "auto" }} className="two-col">
        {tabs.map(tItem => (
          <button key={tItem.id} onClick={() => setTab(tItem.id)} style={{ border: "none", background: "none", padding: "10px 16px", fontSize: 14, fontWeight: tab === tItem.id ? 700 : 500, color: tab === tItem.id ? C.purple : C.textMuted, cursor: "pointer", borderBottom: `2px solid ${tab === tItem.id ? C.purple : "transparent"}`, marginBottom: -1, fontFamily: "inherit", whiteSpace: "nowrap" }}>
            {tItem.label}
          </button>
        ))}
      </div>

      {tab === "opportunities" && (
        <div>
          <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
            {JOB_TRACKER_STATUS_FILTERS.map(s => (
              <Btn key={s} variant="ghost" style={{ padding: "6px 14px", borderRadius: 8, border: `1.5px solid ${filterStatus === s ? C.purple : C.border}`, background: filterStatus === s ? C.purpleLight : "#fff", color: filterStatus === s ? C.purple : C.textMuted, fontSize: 12, fontWeight: 600 }} onClick={() => setFilterStatus(s)}>
                {s === "All" ? t("jobTracker.filterAll") : s === "Updated" ? t("jobTracker.filterUpdated") : s === "New Match" ? t("jobTracker.filterNewMatch") : t("jobTracker.filterClosed")}
              </Btn>
            ))}
            <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ marginLeft: "auto", fontSize: 12, padding: "5px 8px", borderRadius: 7, border: `1px solid ${C.border}`, background: C.bgSoft, color: C.textMid, cursor: "pointer" }}>
              <option value="changed">{t("jobTracker.sortChanged")}</option>
              <option value="match">{t("jobTracker.sortMatch")}</option>
              <option value="date">{t("jobTracker.sortDate")}</option>
            </select>
          </div>
          {jobs.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t("jobTracker.searchPlaceholder")} style={{ width: "100%", border: `1.5px solid ${C.border}`, borderRadius: 9, padding: "10px 14px", fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit" }} />
            </div>
          )}

          {filteredJobs.length === 0 ? (
            <Card style={{ textAlign: "center", padding: 56 }}>
              <div style={{ fontSize: 40, marginBottom: 14 }}>👁️</div>
              <div style={{ fontWeight: 700, fontSize: 16, color: C.text, marginBottom: 6 }}>{jobs.length === 0 ? t("jobTracker.emptyOpportunitiesTitle") : t("jobTracker.noMatchesFound")}</div>
              <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 16 }}>{jobs.length === 0 ? t("jobTracker.emptyOpportunitiesHint") : t("jobTracker.tryDifferentSearch")}</div>
              {jobs.length === 0 && <Btn onClick={() => setPage("jobs")} style={{ padding: "10px 20px" }}>{t("jobTracker.goToJobSearch")}</Btn>}
            </Card>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {filteredJobs.map(row => {
                const salaryChanged = row.previous_salary_min != null && (row.previous_salary_min !== row.salary_min || row.previous_salary_max !== row.salary_max);
                return (
                  <Card key={row.id} onClick={() => markSeen(row)} style={{ borderLeft: row.has_unread_change ? `3px solid ${C.purple}` : undefined, cursor: row.has_unread_change ? "pointer" : "default" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
                          <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{row.job_title}</div>
                          {row.has_unread_change && <Badge color={C.purple}>{t("jobTracker.updatedBadge")}</Badge>}
                          {row.status === "closed" && <Badge color={C.textMuted}>{t("jobTracker.closedBadge")}</Badge>}
                        </div>
                        <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 6 }}>{row.company}{row.location ? ` · ${row.location}` : ""}</div>
                        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                          {fmtSal(row.salary_min, row.salary_max) && <span style={{ fontSize: 13, color: C.green, fontWeight: 700 }}>{salaryChanged ? "↑ " : ""}{fmtSal(row.salary_min, row.salary_max)}</span>}
                          {salaryChanged && <span style={{ fontSize: 11, color: C.textMuted }}>{t("jobTracker.wasSalary").replace("{v}", fmtSal(row.previous_salary_min, row.previous_salary_max) || "—")}</span>}
                          <span style={{ fontSize: 11, color: C.textMuted }}>{t("jobTracker.trackedSince").replace("{date}", fmtDate(row.created_at))}</span>
                        </div>
                        {row.ai_change_summary && <div style={{ fontSize: 12, color: C.purple, marginTop: 8, fontStyle: "italic" }}>💡 {row.ai_change_summary}</div>}
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, flexShrink: 0 }}>
                        {row.matchScore != null && (
                          <div style={{ textAlign: "center" }}>
                            <div style={{ fontSize: 18, fontWeight: 800, color: matchScoreColor(row.matchScore) }}>{row.matchScore}%</div>
                            <div style={{ fontSize: 9, color: C.textMuted, fontWeight: 600 }}>{t("jobTracker.matchLabel")}</div>
                          </div>
                        )}
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                          {row.apply_url && <a href={row.apply_url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: C.purple, fontWeight: 600, textDecoration: "none" }}>{t("jobTracker.viewPosting")}</a>}
                          <Btn variant="danger" style={{ padding: "5px 12px", fontSize: 12 }} loading={removingId === row.id} onClick={(e) => { e.stopPropagation(); handleRemoveJob(row.id); }}>{t("jobTracker.stopTracking")}</Btn>
                        </div>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {tab === "companies" && (
        <div>
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 10 }}>{t("jobTracker.trackCompanyTitle")}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <input value={addCompanyInput} onChange={e => setAddCompanyInput(e.target.value)} placeholder={t("jobTracker.trackCompanyPlaceholder")} onKeyDown={e => e.key === "Enter" && handleAddCompany()} style={{ flex: 1, border: `1.5px solid ${C.border}`, borderRadius: 9, padding: "10px 14px", fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit" }} />
              <Btn onClick={handleAddCompany} loading={addingCompany} style={{ padding: "10px 18px" }}>{t("jobTracker.trackBtn")}</Btn>
            </div>
            {addError && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{addError}</div>}
          </Card>

          {filteredCompanies.length === 0 ? (
            <Card style={{ textAlign: "center", padding: 56 }}>
              <div style={{ fontSize: 40, marginBottom: 14 }}>🏢</div>
              <div style={{ fontWeight: 700, fontSize: 16, color: C.text, marginBottom: 6 }}>{t("jobTracker.emptyCompaniesTitle")}</div>
              <div style={{ fontSize: 14, color: C.textMuted }}>{t("jobTracker.emptyCompaniesHint")}</div>
            </Card>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {filteredCompanies.map(c => (
                <Card key={c.id} style={{ borderLeft: c.status === "new_activity" ? `3px solid ${C.purple}` : undefined }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 200 }}>
                      <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 4 }}>{c.company_name}</div>
                      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6 }}>{t("jobTracker.watchingSince").replace("{date}", fmtDate(c.created_at))}</div>
                      {c.notes && <div style={{ fontSize: 13, color: C.textMid }}>{c.notes}</div>}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8, flexShrink: 0 }}>
                      {c.best_seen_match != null && (
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 18, fontWeight: 800, color: matchScoreColor(c.best_seen_match) }}>{c.best_seen_match}%</div>
                          <div style={{ fontSize: 9, color: C.textMuted, fontWeight: 600 }}>{t("jobTracker.bestMatchLabel")}</div>
                        </div>
                      )}
                      <div style={{ display: "flex", gap: 6 }}>
                        <Btn variant="secondary" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => setPage("jobs")}>{t("jobTracker.viewOpenRoles")}</Btn>
                        <Btn variant="danger" style={{ padding: "5px 12px", fontSize: 12 }} loading={removingId === c.id} onClick={() => handleRemoveCompany(c.id)}>{t("jobTracker.stopTracking")}</Btn>
                      </div>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "activity" && (
        activity.length === 0 ? (
          <Card style={{ textAlign: "center", padding: 56 }}>
            <div style={{ fontSize: 40, marginBottom: 14 }}>📭</div>
            <div style={{ fontWeight: 700, fontSize: 16, color: C.text, marginBottom: 6 }}>{t("jobTracker.emptyActivityTitle")}</div>
            <div style={{ fontSize: 14, color: C.textMuted }}>{t("jobTracker.emptyActivityHint")}</div>
          </Card>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {activity.map(a => (
              <Card key={a.id}>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 2 }}>{a.title} — {a.company}</div>
                {a.summary && <div style={{ fontSize: 13, color: C.textMid, marginTop: 4 }}>{a.summary}</div>}
                <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>{fmtDate(a.date)}</div>
              </Card>
            ))}
          </div>
        )
      )}
    </div>
  );
}

// ─── SETTINGS PAGE ─────────────────────────────────────────
function SettingsPage({ profile, updateProfile, logout, setPage, billingState, refreshBillingState }) {
  const { t, language, setLanguage } = useI18n();
  const [notifyEmail, setNotifyEmail] = useStorage("cp_notify_email", true);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteText, setDeleteText] = useState("");
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingError, setBillingError] = useState("");
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const deleteConfirmPhrase = t("settings.deleteConfirmPhrase");

  // Canonical billing state from Worker — all UI decisions derive from here
  const bs = billingState?.billingState || "FREE";
  const isActive = ["PRO_ACTIVE", "PRO_CANCELING", "PRO_PAST_DUE", "PREMIUM_ACTIVE", "PREMIUM_CANCELING", "ADMIN"].includes(bs);
  const isCanceling = bs === "PRO_CANCELING" || bs === "PREMIUM_CANCELING";
  const isPastDue = bs === "PRO_PAST_DUE";
  const isExpired = bs === "PRO_EXPIRED";
  const planDisplayName = billingState?.planDisplayName || "Free";
  const periodEnd = billingState?.periodEnd ? new Date(billingState.periodEnd) : null;
  const cancelAtPeriodEnd = billingState?.cancelAtPeriodEnd ?? false;
  const paymentMethodOnFile = billingState?.paymentMethodOnFile ?? false;
  const quotas = billingState?.quotas ?? {};
  const formatDate = (d) => d ? d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

  // Refresh billing state on mount (ensures fresh data after portal return or any external change)
  useEffect(() => { if (refreshBillingState) refreshBillingState(); }, []);

  const openPortal = async () => {
    setBillingLoading(true); setBillingError("");
    try {
      const { url } = await workerBillingPost("/api/billing/portal-session");
      window.location.href = url;
    } catch (e) {
      setBillingError(e.workerError === "stripe_not_configured" ? t("settings.stripeManageSoon") : e.message);
    } finally { setBillingLoading(false); }
  };

  const cancelSub = async () => {
    setBillingLoading(true); setBillingError("");
    try {
      await workerBillingPost("/api/billing/cancel");
      setShowCancelConfirm(false);
      if (refreshBillingState) await refreshBillingState();
    } catch (e) {
      setBillingError(e.workerError === "stripe_not_configured" ? t("settings.stripeManageSoon") : e.message);
    } finally { setBillingLoading(false); }
  };

  const resumeSub = async () => {
    setBillingLoading(true); setBillingError("");
    try {
      await workerBillingPost("/api/billing/resume");
      if (refreshBillingState) await refreshBillingState();
    } catch (e) {
      setBillingError(e.workerError === "stripe_not_configured" ? t("settings.stripeManageSoon") : e.message);
    } finally { setBillingLoading(false); }
  };

  const handleDelete = () => {
    if (deleteText.toLowerCase() === deleteConfirmPhrase.toLowerCase()) {
      localStorage.clear();
      logout();
    }
  };

  const USAGE_FEATURES = [
    { key: "ai_request",      label: t("settings.usageFeatureAI"),        quota: quotas.ai_request },
    { key: "resume_analysis", label: t("settings.usageFeatureResume"),     quota: quotas.resume_analysis },
    { key: "interview_prep",  label: t("settings.usageFeatureInterview"),  quota: quotas.interview_prep },
    { key: "salary_analysis", label: t("settings.usageFeatureSalary"),     quota: quotas.salary_analysis },
    { key: "linkedin_intelligence", label: t("settings.usageFeatureLinkedIn"), quota: quotas.linkedin_intelligence },
  ];

  // Smart Apply Auto Prep (Premium Feature #5) — §5/§11 of the locked
  // blueprint: a plain daily-count preference (0/1/2), no "Level"/"Tier"
  // terminology anywhere in this UI. isPremium computed locally from the
  // same canonical billing state this page already derives `bs` from,
  // rather than threading a new prop through.
  const isPremium = bs === "PREMIUM_ACTIVE" || bs === "PREMIUM_CANCELING" || bs === "ADMIN";
  const { value: autoPrepValue, setPreference: setAutoPrepValue, loading: autoPrepLoading } = useAutomationPreference(isPremium ? profile?.id : null, "smart_apply_auto_prep");
  const [autoPrepSaving, setAutoPrepSaving] = useState(false);
  const handleAutoPrepChange = async (newValue) => {
    setAutoPrepSaving(true);
    try { await setAutoPrepValue(newValue); } catch (e) { console.error("automation_preferences update failed:", e.message); }
    finally { setAutoPrepSaving(false); }
  };

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 24 }}>{t("settings.heading")}</h1>

      {/* LANGUAGE SETTINGS */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}><span style={{ fontSize: 20 }}>🌐</span><span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{t("settings.languagesHeading")}</span></div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 4 }}>{t("settings.appLanguageLabel")}</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 8 }}>{t("settings.appLanguageHint")}</div>
            <select
              value={language}
              onChange={e => { setLanguage(e.target.value); updateProfile({ preferred_language: e.target.value }); }}
              style={{ width: "100%", padding: "10px 14px", borderRadius: 9, border: `1.5px solid ${C.border}`, fontSize: 14, fontFamily: "inherit", cursor: "pointer" }}
            >
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.native}</option>)}
            </select>
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 4 }}>{t("settings.jobLanguageLabel")}</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 8 }}>{t("settings.jobLanguageHint")}</div>
            <select
              value={profile?.job_language || "en"}
              onChange={e => updateProfile({ job_language: e.target.value })}
              style={{ width: "100%", padding: "10px 14px", borderRadius: 9, border: `1.5px solid ${C.border}`, fontSize: 14, fontFamily: "inherit", cursor: "pointer" }}
            >
              {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.flag} {l.native}</option>)}
            </select>
          </div>
        </div>
      </Card>

      {/* SUBSCRIPTION */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}><span style={{ fontSize: 20 }}>💳</span><span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{t("settings.subscription")}</span></div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }} className="two-col">
          {/* Plan name */}
          <div style={{ background: C.bgSoft, borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4 }}>{t("settings.currentPlan")}</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: isActive ? C.purple : C.text }}>{planDisplayName}</div>
          </div>

          {/* Status */}
          <div style={{ background: C.bgSoft, borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4 }}>{t("settings.status")}</div>
            {bs === "PRO_EXPIRED" && (
              <div style={{ fontSize: 14, fontWeight: 700, color: C.red }}>{t("settings.subExpiredStatus")}</div>
            )}
            {(bs === "PRO_ACTIVE" || bs === "PREMIUM_ACTIVE" || bs === "ADMIN") && !cancelAtPeriodEnd && (
              <div style={{ fontSize: 14, fontWeight: 700, color: C.green }}>{t("settings.active")}</div>
            )}
            {(bs === "PRO_CANCELING" || bs === "PREMIUM_CANCELING") && (
              <div style={{ fontSize: 14, fontWeight: 700, color: C.orange }}>{t("settings.cancelsOn").replace("{date}", formatDate(periodEnd))}</div>
            )}
            {bs === "PRO_PAST_DUE" && (
              <div style={{ fontSize: 14, fontWeight: 700, color: C.red }}>{t("settings.pastDue")}</div>
            )}
            {bs === "FREE" && (
              <div style={{ fontSize: 14, fontWeight: 700, color: C.textMuted }}>—</div>
            )}
          </div>

          {/* Renewal / expiry date */}
          {isActive && periodEnd && !cancelAtPeriodEnd && (
            <div style={{ background: C.bgSoft, borderRadius: 10, padding: 14 }}>
              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4 }}>{t("settings.nextRenewal")}</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{formatDate(periodEnd)}</div>
            </div>
          )}
          {isActive && periodEnd && cancelAtPeriodEnd && (
            <div style={{ background: C.bgSoft, borderRadius: 10, padding: 14 }}>
              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4 }}>{t("settings.cancelsOn").replace("{date}", "")}</div>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.orange }}>{formatDate(periodEnd)}</div>
            </div>
          )}
        </div>

        {billingError && <div style={{ color: C.red, fontSize: 13, marginBottom: 10 }}>{billingError}</div>}

        {/* Inline cancel confirm */}
        {showCancelConfirm && (
          <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 10, padding: 16, marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.red, marginBottom: 6 }}>{t("settings.cancelConfirm")}</div>
            <div style={{ fontSize: 13, color: C.text, marginBottom: 12 }}>{t("settings.cancelConfirmBody")}</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Btn variant="danger" disabled={billingLoading} onClick={cancelSub}>{billingLoading ? "…" : t("settings.cancelConfirmYes")}</Btn>
              <Btn variant="secondary" disabled={billingLoading} onClick={() => setShowCancelConfirm(false)}>{t("settings.cancelConfirmNo")}</Btn>
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {!isActive && <Btn onClick={() => setPage("pricing")}>{t("settings.upgradeToPro")}</Btn>}
          {isActive && !showCancelConfirm && !cancelAtPeriodEnd && (
            <Btn variant="secondary" disabled={billingLoading} onClick={() => setShowCancelConfirm(true)}>{t("settings.cancelSubscription")}</Btn>
          )}
          {isActive && cancelAtPeriodEnd && (
            <Btn variant="secondary" disabled={billingLoading} onClick={resumeSub}>{billingLoading ? "…" : t("settings.resumeSub")}</Btn>
          )}
          {isActive && (
            <Btn variant="secondary" disabled={billingLoading} onClick={openPortal}>{billingLoading ? "…" : t("settings.manageSub")}</Btn>
          )}
        </div>
      </Card>

      {/* USAGE */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}><span style={{ fontSize: 20 }}>📊</span><span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{t("settings.usageHeading")}</span></div>
        {!billingState ? (
          <div style={{ color: C.textMuted, fontSize: 14, padding: "4px 0" }}>…</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {USAGE_FEATURES.map(({ key, label, quota }) => {
              const q = quota || { used: 0, limit: 0, remaining: 0, unlimited: false };
              const pct = q.unlimited ? 0 : q.limit ? Math.min(100, Math.round((q.used / q.limit) * 100)) : 0;
              const barColor = pct >= 90 ? C.red : pct >= 70 ? C.yellow : C.purple;
              return (
                <div key={key}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 5 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{label}</span>
                    <span style={{ fontSize: 12, color: q.unlimited ? C.green : pct >= 90 ? C.red : C.textMuted, fontWeight: q.unlimited ? 600 : 400 }}>
                      {q.unlimited ? t("settings.usageUnlimited") : t("settings.usageUsedOf").replace("{used}", q.used).replace("{limit}", q.limit ?? "?")}
                    </span>
                  </div>
                  {!q.unlimited && (
                    <div style={{ height: 5, background: C.border, borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${pct}%`, background: barColor, borderRadius: 3, transition: "width 0.3s ease" }} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {/* SMART APPLY AUTO PREP */}
      {isPremium && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}><span style={{ fontSize: 20 }}>⚡</span><span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{t("settings.autoPrepHeading")}</span></div>
          <Select
            label={t("settings.autoPrepLabel")}
            value={autoPrepLoading ? "" : autoPrepValue}
            disabled={autoPrepLoading || autoPrepSaving}
            onChange={e => handleAutoPrepChange(Number(e.target.value))}
          >
            <option value={0}>{t("settings.autoPrepOff")}</option>
            <option value={1}>{t("settings.autoPrep1")}</option>
            <option value={2}>{t("settings.autoPrep2")}</option>
          </Select>
          <div style={{ fontSize: 12, color: C.textMuted, marginTop: 8 }}>{t("settings.autoPrepHelper")}</div>
        </Card>
      )}

      {/* BILLING */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}><span style={{ fontSize: 20 }}>💰</span><span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{t("settings.billing")}</span></div>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 8 }}>{t("settings.paymentMethod")}</div>
          <div style={{ background: C.bgSoft, borderRadius: 10, padding: 16, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
            <div style={{ color: C.textMuted, fontSize: 14 }}>
              {paymentMethodOnFile ? t("settings.changeCard") : t("settings.noPaymentMethod")}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {!paymentMethodOnFile && <Btn variant="secondary" style={{ padding: "6px 14px", fontSize: 12 }} disabled={billingLoading} onClick={openPortal}>{t("settings.addCard")}</Btn>}
              {paymentMethodOnFile && <Btn variant="secondary" style={{ padding: "6px 14px", fontSize: 12 }} disabled={billingLoading} onClick={openPortal}>{t("settings.changeCard")}</Btn>}
            </div>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 8 }}>{t("settings.billingHistory")}</div>
          <div style={{ background: C.bgSoft, borderRadius: 10, padding: 16 }}>
            <div style={{ color: C.textMuted, fontSize: 14, textAlign: "center", padding: "20px 0" }}>{isActive ? t("settings.noBillingHistory") : t("settings.invoicesWillAppear")}</div>
          </div>
          {isActive && (
            <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
              <Btn variant="secondary" style={{ padding: "6px 14px", fontSize: 12 }} disabled={billingLoading} onClick={openPortal}>{t("settings.viewInvoice")}</Btn>
              <Btn variant="secondary" style={{ padding: "6px 14px", fontSize: 12 }} disabled={billingLoading} onClick={openPortal}>{t("settings.downloadPdf")}</Btn>
              <Btn variant="secondary" style={{ padding: "6px 14px", fontSize: 12 }} disabled={billingLoading} onClick={openPortal}>{t("settings.printInvoice")}</Btn>
            </div>
          )}
        </div>
      </Card>

      {/* SECURITY */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}><span style={{ fontSize: 20 }}>🔒</span><span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{t("settings.security")}</span></div>
        <Btn variant="secondary" onClick={() => alert(t("settings.passwordChangeSoon"))}>{t("settings.changePassword")}</Btn>
      </Card>

      {/* NOTIFICATIONS */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}><span style={{ fontSize: 20 }}>🔔</span><span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{t("notifications.title")}</span></div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 14, color: C.text, fontWeight: 600 }}>{t("settings.emailNotifications")}</div>
            <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>{t("settings.emailNotificationsHint")}</div>
          </div>
          <Btn variant="ghost" onClick={() => setNotifyEmail(!notifyEmail)} style={{ width: 48, height: 26, padding: 0, borderRadius: 13, border: "none", background: notifyEmail ? C.purple : C.border, position: "relative" }}>
            <div style={{ width: 20, height: 20, borderRadius: 10, background: "#fff", position: "absolute", top: 3, left: notifyEmail ? 25 : 3, transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.15)" }} />
          </Btn>
        </div>
      </Card>

      {/* ACCOUNT */}
      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}><span style={{ fontSize: 20 }}>👤</span><span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{t("settings.account")}</span></div>
        <Btn variant="danger" onClick={() => setShowDeleteConfirm(true)}>{t("settings.deleteAccount")}</Btn>
        {showDeleteConfirm && (
          <div style={{ marginTop: 16, background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 12, padding: 18 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.red, marginBottom: 8 }}>⚠️ {t("settings.deletePermanentlyTitle")}</div>
            <div style={{ fontSize: 13, color: C.text, marginBottom: 12 }}>{t("settings.deletePermanentlyBody")}</div>
            <div style={{ fontSize: 13, color: C.textMid, marginBottom: 10 }}>{t("settings.typeToConfirm")} <strong>{deleteConfirmPhrase}</strong>:</div>
            <input value={deleteText} onChange={e => setDeleteText(e.target.value)} placeholder={deleteConfirmPhrase} style={{ width: "100%", border: `1.5px solid ${C.red}40`, borderRadius: 9, padding: "10px 14px", fontSize: 14, outline: "none", marginBottom: 12, boxSizing: "border-box", fontFamily: "inherit" }} />
            <div style={{ display: "flex", gap: 10 }}>
              <Btn variant="danger" onClick={handleDelete} disabled={deleteText.toLowerCase() !== deleteConfirmPhrase.toLowerCase()}>{t("settings.permanentlyDelete")}</Btn>
              <Btn variant="secondary" onClick={() => { setShowDeleteConfirm(false); setDeleteText(""); }}>{t("settings.cancel")}</Btn>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── MAIN APP ──────────────────────────────────────────────
export default function App() {
  const { user, logout, recoveryMode, clearRecovery, authResolving } = useAuth();
  const [profile, setProfile] = useState(() => { try { return JSON.parse(localStorage.getItem("cp_user") || "null"); } catch { return null; } });
  const [applications, setApplications] = useApplications(user?.id);
  const [savedJobs, setSavedJobs] = useSavedJobs(user?.id);
  const [billingState, setBillingState] = useState(null);
  const validPages = new Set(["dashboard","briefing","plan","progress","resume","jobs","saved","jobtracker","interview","tracker","salary","network","alerts","pricing","profile","settings","opportunity","jobintel"]);

  // Read initial page from URL hash, then localStorage fallback
  const getInitialPage = () => {
    const hash = window.location.hash.replace("#", "").split("?")[0];
    if (hash && validPages.has(hash)) return hash;
    try { const stored = localStorage.getItem("cp_active_page"); if (stored) { const p = JSON.parse(stored); if (validPages.has(p)) return p; } } catch {}
    return "dashboard";
  };

  const [page, setPageRaw] = useState(getInitialPage);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // Separate from mobileMenuOpen on purpose -- desktop and mobile nav must be
  // independently openable/closable and never share state, per the desktop
  // nav architecture refactor (both read the same `nav` array, though).
  const [desktopMenuOpen, setDesktopMenuOpen] = useState(false);
  useEffect(() => {
    if (!desktopMenuOpen) return;
    const onKey = (e) => { if (e.key === "Escape") setDesktopMenuOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [desktopMenuOpen]);

  // Keep `profile` in sync with whatever useAuth resolves (fake local account,
  // or a real Supabase session synced via onAuthStateChange) and land on the
  // dashboard the moment a logged-out user becomes logged-in.
  const wasLoggedIn = useRef(!!profile);
  useEffect(() => {
    setProfile(user);
    if (user && !wasLoggedIn.current) { setPage("dashboard"); window.scrollTo(0, 0); }
    wasLoggedIn.current = !!user;
  }, [user]);

  // Navigate: update state + localStorage + browser history
  const setPage = useCallback((p) => {
    setPageRaw(p);
    localStorage.setItem("cp_active_page", JSON.stringify(p));
    if (window.location.hash !== "#" + p) {
      window.history.pushState({ page: p }, "", "#" + p);
    }
  }, []);

  // Scroll to top on every page change
  useEffect(() => {
    window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0;
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
    const t1 = setTimeout(() => { window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; }, 50);
    const t2 = setTimeout(() => { window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; }, 300);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [page]);

  // Handle browser Back/Forward
  useEffect(() => {
    const onPop = (e) => {
      const p = e.state?.page || window.location.hash.replace("#", "") || "dashboard";
      if (validPages.has(p)) { setPageRaw(p); localStorage.setItem("cp_active_page", JSON.stringify(p)); }
    };
    window.addEventListener("popstate", onPop);
    // Set initial history entry
    if (!window.location.hash) window.history.replaceState({ page: page }, "", "#" + page);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const handleLogout = async () => {
    await logout();
    setProfile(null);
    // Session state — scoped to current tab, always cleared on logout
    ["cp_resume_text","cp_resume_jobdesc","cp_resume_results","cp_resume_tab","cp_resume_loaded_id","cp_resume_source","cp_resume_selected_kws","cp_resume_improve_stats","cp_resume_master_kws","cp_resume_optimized","cp_resume_insights","cp_resume_lib_saved","cp_resume_manual_reset","cp_resume_benchmark","cp_resume_jobfit","cp_resume_linkedin_opt","cp_resume_linkedin_profile","cp_resume_cover_versions","cp_resume_cover_active","cp_resume_deep_insights","cp_jobs_filters","cp_jobs_results","cp_jobs_page","cp_jobs_hasmore","cp_jobs_searched","cp_jobs_match","cp_jobs_resume","cp_jobs_resumefilename","cp_jobs_sourcecounts","cp_tracker_filter","cp_tracker_search","cp_interview_filter","cp_net_tab","cp_briefing_dash","cp_plan_dash","cp_progress_analysis","cp_job_intel_analysis"].forEach(k => { try { sessionStorage.removeItem(k); } catch {} });
    // User-specific localStorage — cleared so a subsequent login (same or different account)
    // starts from Supabase, not from the previous user's stale cached data
    ["cp_apps","cp_saved","cp_network_contacts","cp_network_form","cp_network_results","cp_network_draft","cp_network_emailto","cp_network_emailsent"].forEach(k => { try { localStorage.removeItem(k); } catch {} });
  };
  const updateProfile = (updates) => {
    const updated = { ...profile, ...updates };
    setProfile(updated);
    localStorage.setItem("cp_user", JSON.stringify(updated));
    saveAccount(updated);
    if (updated.id) upsertProfile(updated.id, updates).catch(() => {});
  };

  // Single billing refresh entry point. Every billing action funnels through here.
  // Fires "billing:updated" so any future subscriber can react without a rewrite.
  const refreshBillingState = async () => {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return null;
    try {
      const res = await fetch(`${WORKER_URL}/api/billing/state`, {
        headers: { "Authorization": `Bearer ${session.access_token}` },
      });
      if (!res.ok) return null;
      const state = await res.json();
      setBillingState(state);
      const merged = await fetchProfile(session.user.id, session.user.email);
      setProfile(merged);
      localStorage.setItem("cp_user", JSON.stringify(merged));
      saveAccount(merged);
      window.dispatchEvent(new CustomEvent("billing:updated", { detail: state }));
      return state;
    } catch {
      return null;
    }
  };
  const handleSaveApp = (app) => setApplications(p => [app, ...p]);
  const goHome = () => { setPage("dashboard"); window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; };

  const { language, setLanguage, t } = useLanguagePreference(profile?.preferred_language, (code) => updateProfile({ preferred_language: code }));

  const companyWatchlistHook = useCompanyWatchlist(profile?.id);
  const { watchlist: companyWatchlist, add: watchlistAdd, remove: watchlistRemove, updateStatus: watchlistUpdateStatus } = companyWatchlistHook;
  // Job Tracker (job-level half) -- fully independent of applications/smart_apply_queue.
  const jobWatchlistHook = useJobWatchlist(profile?.id);
  // Application Outcome Intelligence (Premium Feature #2).
  const outcomePatternsHook = useOutcomePatterns(profile?.id);
  const outcomeAnalysesHook = useOutcomeAnalyses(profile?.id);
  const recommendationEvalHook = useRecommendationEvaluations(profile?.id);
  // Referral Intelligence (Premium Feature #3).
  const referralAnalysesHook = useReferralAnalyses(profile?.id);
  // Proactive Job Alerts (Premium Feature #4). Read-only -- all 6 analyses
  // run server-side on a schedule (worker.js); this hook only reads what the
  // Delivery Pipeline already persisted.
  const proactiveAlertsHook = useProactiveAlerts(profile?.id);
  // One-shot override so the Dashboard's "Full Analysis" button always lands on the
  // Insights tab, regardless of cp_tracker_tab's remembered value. TrackerPage consumes
  // it once (via onForceInsightsTabHandled) so normal in-Tracker tab navigation keeps
  // remembering the user's last selected tab afterward, unaffected.
  const [forceTrackerInsightsTab, setForceTrackerInsightsTab] = useState(false);
  const openTrackerInsights = useCallback(() => { setForceTrackerInsightsTab(true); setPage("tracker"); }, [setPage]);

  const nav = [
    { id: "dashboard", icon: "📊", label: t("nav.dashboard") },
    { id: "resume", icon: "⚡", label: t("nav.resume") },
    { id: "jobs", icon: "🔍", label: t("nav.jobSearch") },
    { id: "saved", icon: "♥", label: `${t("nav.saved")}${savedJobs.length > 0 ? ` (${savedJobs.length})` : ""}` },
    { id: "jobtracker", icon: "👁️", label: `${t("nav.jobTracker")}${(jobWatchlistHook.watchlist.length + companyWatchlistHook.watchlist.length) > 0 ? ` (${jobWatchlistHook.watchlist.length + companyWatchlistHook.watchlist.length})` : ""}` },
    { id: "interview", icon: "🎤", label: t("nav.interview") },
    { id: "tracker", icon: "📋", label: `${t("nav.tracker")}${applications.length > 0 ? ` (${applications.length})` : ""}` },
    { id: "salary", icon: "💰", label: t("nav.salary") },
    { id: "network", icon: "🤝", label: t("nav.network") },
    { id: "alerts", icon: "🔔", label: t("nav.alerts") },
    { id: "pricing", icon: "💎", label: t("nav.pricing") },
  ];
  const subStatus = profile?.subscription_status || "no_subscription";
  const SUB_LABEL = { pro_active: "Pro", pro_past_due: "Pro", pro_cancelled: "Pro", premium_active: "Premium", admin: "Admin" };
  const planName = SUB_LABEL[subStatus] || "Free";
  const isPaidPlan = ["pro_active", "pro_past_due", "pro_cancelled", "premium_active", "admin"].includes(subStatus);
  // Application Outcome Intelligence is "Gate: Premium Only" per its locked blueprint --
  // distinct from isPaidPlan, which also includes the Pro tier.
  const isPremium = ["premium_active", "admin"].includes(subStatus);
  const { notifications, refresh: refreshNotifications, markAllRead } = useNotifications(profile?.id);
  const unreadCount = notifications.filter(n => !n.read).length;

  // Data lifted to App level so UserContext can aggregate them as the single
  // source of truth. Page-level hook instances keep their full mutation APIs.
  const { resumes, loading: resumesLoading, saveResume: rootSaveResume, deleteResume: rootDeleteResume, downloadResume: rootDownloadResume, setDefaultResume: rootSetDefaultResume, refresh: refreshResumes, saveAnalysis: rootSaveAnalysis, updateVersionLabel: rootUpdateVersionLabel, updateResumeLanguage: rootUpdateResumeLanguage } = useResumes(profile?.id);
  const [activeResumeId, setActiveResumeId] = useState(null);
  const { entries: analysisHistory, saveEntry: saveHistoryToDb } = useResumeHistory(profile?.id);
  // Resume Intelligence navigation state machine — computed once at root so every
  // entry point (nav bar, Dashboard, Action Plan, Career Progress) routes to the
  // correct workflow step based on the user's current resume progress.
  const [resumeEntryTarget, setResumeEntryTarget] = useState(null);
  const resumeNavTarget = useMemo(() => {
    const best = resumes.filter(r => r.ats_score != null).sort((a, b) => (b.ats_score ?? 0) - (a.ats_score ?? 0))[0] ?? null;
    if (!best) return "upload";
    if ((best.keywords_missing?.length ?? 0) > 0) return "keywords";
    return "insights";
  }, [resumes]);
  const navigateToResume = useCallback((overrideTarget) => {
    setResumeEntryTarget(overrideTarget ?? resumeNavTarget);
    setPage("resume");
  }, [resumeNavTarget]);

  // Confirmed Tracker delete — awaits Supabase before updating local state.
  // Prevents the "deleted items return on refresh" ghost caused by syncListDiff's
  // fire-and-forget DELETE failing silently without reverting optimistic state.
  const handleDeleteApplication = async (id) => {
    console.log(`[Tracker] handleDeleteApplication called id=${id} profile.id=${profile?.id}`);
    if (!profile?.id) throw new Error("Cannot delete: not signed in");
    await deleteApplicationRow(profile.id, id); // throws only on real DB error
    setApplications(p => p.filter(a => a.id !== id));
    console.log(`[Tracker] State updated — id=${id} removed`);
  };

  // Confirmed Tracker save/edit — upserts to Supabase first, then updates React state.
  // This prevents ghost-restores caused by syncListDiff swallowing upsert errors silently.
  const handleSaveApplication = async (app) => {
    console.log(`[Tracker] handleSaveApplication called id=${app.id} profile.id=${profile?.id}`);
    if (!profile?.id) throw new Error("Cannot save: not signed in");
    await upsertApplicationRow(profile.id, app); // throws on DB error
    setApplications(p => {
      const exists = p.some(a => a.id === app.id);
      if (exists) return p.map(a => a.id === app.id ? app : a);
      return [app, ...p];
    });
    console.log(`[Tracker] State updated — id=${app.id} saved`);
  };
  const { queue: smartApplyQueue, loading: smartApplyQueueLoading, refresh: refreshSmartApplyQueue, enqueue: rootEnqueue, markApplied: rootMarkApplied, markReady: rootMarkReady, markNeedsReview: rootMarkNeedsReview, markFailed: rootMarkFailed, resetToQueued: rootResetToQueued, purgeByJobId: rootPurgeByJobId, patchQueueItem: rootPatchQueueItem } = useSmartApplyQueue(profile?.id);
  // Lifted to App root so Dashboard always sees current values without remounting.
  // InterviewPage, SalaryPage, NetworkingPage keep their own hook instances for mutations.
  const { session: rootInterviewSession, refresh: refreshRootInterviewSession } = useInterviewSession(profile?.id);
  const { data: rootSalaryData } = useSalaryResearch(profile?.id);
  const [rootNetworkContacts, , refreshRootNetworkContacts] = useNetworkingContacts(profile?.id);
  const networkingSessionCtx = useNetworkingSession(profile?.id);

  // Re-sync root hook instances whenever user navigates to the dashboard.
  // Page components (InterviewPage, NetworkingPage) write via their own hook
  // instances; this ensures DashboardPage always reads the latest persisted
  // data rather than the stale initial fetch.
  useEffect(() => {
    if (page === "dashboard") {
      refreshRootInterviewSession();
      refreshRootNetworkContacts();
    }
  }, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  if (recoveryMode) return <ResetPasswordPage onDone={() => { clearRecovery(); window.history.replaceState({}, "", window.location.pathname); }} t={t} />;
  // Show a branded loading screen while Supabase exchanges the auth callback
  // token (email verification, magic link, OAuth). This replaces the confusing
  // login-form flash that users would otherwise see before the session resolves.
  if (authResolving) return (
    <div style={{ minHeight: "100vh", background: C.bgSoft, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
      <Logo size={52} />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        <div style={{ width: 28, height: 28, border: `3px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
        <div style={{ fontSize: 15, fontWeight: 600, color: C.textMid }}>{t("auth.completingSignIn")}</div>
        <div style={{ fontSize: 12, color: C.textMuted }}>{t("auth.signInMoment")}</div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
  if (!user) return <AuthPage t={t} />;

  return (
    <I18nContext.Provider value={{ language, setLanguage, t }}>
    <div style={{ minHeight: "100vh", background: C.bgSoft, fontFamily: "'Inter','Segoe UI',system-ui,sans-serif", color: C.text }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input:focus, textarea:focus, select:focus { border-color: ${C.purple} !important; box-shadow: 0 0 0 3px ${C.purple}15 !important; }
        ::placeholder { color: ${C.textMuted}; opacity: 0.55; }
        textarea { background: #ffffff !important; color: #0F172A !important; border-color: #E2E8F0 !important; font-size: 14px !important; font-family: 'Inter','Segoe UI',system-ui,sans-serif !important; }
        input:not([type=checkbox]) { background: #ffffff !important; color: #0F172A !important; font-family: 'Inter','Segoe UI',system-ui,sans-serif !important; }
        select { background: #ffffff !important; color: #0F172A !important; font-family: 'Inter','Segoe UI',system-ui,sans-serif !important; }
        @keyframes spin { to { transform: rotate(360deg); } } textarea { background: white !important; color: #0F172A !important; } input[type=text], input[type=email], input[type=password], input[type=number] { background: white !important; color: #0F172A !important; }
        button:hover:not(:disabled), .btn-link:hover { opacity: 0.88; transform: translateY(-1px); }
        button:active:not(:disabled), .btn-link:active { transform: translateY(0); }
        ::-webkit-scrollbar { width: 5px; } ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
        @media (max-width: 400px) {
  .resume-source-selector { flex-direction: column !important; }
}
@keyframes summaryEntrance { from { opacity: 0; transform: translateY(-4px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
.toolkit-active:hover { box-shadow: 0 4px 16px rgba(107,33,232,0.12) !important; border-color: rgba(107,33,232,0.35) !important; }
.resume-lib-item { display: block; -webkit-tap-highlight-color: transparent; touch-action: manipulation; transition: border-color 0.15s; }
@media (hover: hover) { .resume-lib-item:hover { background: ${C.purpleLight} !important; border-color: ${C.purple}40 !important; } }
.editor-highlight-active > div { box-shadow: 0 0 0 3px rgba(107,33,232,0.3), 0 0 16px rgba(107,33,232,0.12) !important; border-color: #6B21E8 !important; transition: box-shadow 0.3s, border-color 0.3s; }
@media (max-width: 600px) {
  .improve-summary-grid { grid-template-columns: repeat(2, 1fr) !important; }
}
@media (max-width: 900px) {
  .hub-stats-grid { grid-template-columns: repeat(2, 1fr) !important; }
  .hub-toolkit-grid { grid-template-columns: repeat(2, 1fr) !important; }
  .history-analytics-grid { grid-template-columns: 1fr !important; }
}
.cp-action-bar { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; justify-content: center; }
.two-col > *, .three-col > * { min-width: 0; }
@media (max-width: 700px) {
  .cp-action-bar { display: grid; grid-template-columns: repeat(2, 1fr); }
  .two-col, .three-col { grid-template-columns: 1fr !important; }
  .resume-action-bar { grid-template-columns: 1fr !important; max-width: 100% !important; }
  .hub-stats-grid { grid-template-columns: repeat(2, 1fr) !important; }
  .hub-toolkit-grid { grid-template-columns: 1fr !important; }
  .hero-section { margin-bottom: 10px !important; }
  .hero-greeting { font-size: 22px !important; margin-bottom: 2px !important; }
  .hero-subtitle { font-size: 12px !important; }
  .briefing-illus { display: none !important; }
  .briefing-spark-mobile { display: flex !important; }
}
@media (min-width: 701px) {
  .briefing-illus-desktop { display: flex !important; }
  .briefing-content-col { padding-right: 76px; }
}
@media (min-width: 701px) and (max-width: 1024px) {
  .hero-greeting { font-size: 24px !important; margin-bottom: 4px !important; }
  .hero-section { margin-bottom: 14px !important; }
}
@media (max-width: 1024px) {
  .nav-label { display: none; }
  .desktop-nav { display: none !important; }
  .desktop-hamburger-wrap { display: none !important; }
  .mobile-logo-row { gap: 2px !important; padding: 10px 4px 0 !important; }
  .hamburger-btn { display: block !important; width: 50px !important; height: 50px !important; font-size: 35px !important; line-height: 34px !important; }
  .subscription-badge { display: flex !important; align-items: center !important; }
  .brand-logo { width: 43px !important; height: 43px !important; border-radius: 9px !important; }
  .brand-logo-glyph { font-size: 18px !important; }
  .brand-name { font-size: 24px !important; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; max-width: 100%; }
  .brand-name-badge { font-size: 15px !important; margin-left: 0 !important; }
  .logo-block { gap: 5px !important; }
}
@media (min-width: 1025px) {
  /* 3-column grid: hamburger pinned left (auto), logo centered (1fr), utility pinned
     right (auto). grid-column:1/2 override the inline gridColumn the mobile-logo-row
     grid sets on these same elements for their own mobile-only 3-col layout. */
  .hamburger-btn { display: none !important; }
  .subscription-badge { display: none !important; }
  header { display: grid !important; grid-template-columns: auto 1fr auto !important; align-items: center !important; padding: 8px 14px !important; column-gap: 8px !important; }
  .mobile-logo-row { display: contents !important; }
  .desktop-hamburger-wrap { display: block !important; grid-column: 1 !important; grid-row: 1 !important; justify-self: start !important; }
  /* Absolute + translate, not grid-column:2/justify-self:center -- the left (hamburger)
     and right (language/notifications/user) columns are different widths, so centering
     within the middle 1fr grid track alone would not be centered relative to the whole
     header. header has position:sticky, which already establishes the containing block
     this needs. */
  /* grid-column/row: auto is required here -- an absolutely-positioned grid item that
     still has explicit grid-line placement (the inline gridColumn:2 from the mobile
     layout) keeps using that grid AREA as its containing block for left:50%, not the
     full header, which silently re-introduces the exact off-center bug this was meant
     to fix. Resetting placement to auto makes left:50% resolve against the header. */
  .logo-block { position: absolute !important; grid-column: auto !important; grid-row: auto !important; left: 50% !important; top: 50% !important; transform: translate(-50%, -50%) !important; justify-content: center !important; white-space: nowrap !important; gap: 7px !important; }
  .brand-logo { width: 38px !important; height: 38px !important; }
  .brand-logo-glyph { font-size: 17px !important; }
  .brand-name { font-size: 20px !important; }
  .brand-name-badge { font-size: 13px !important; margin-left: 0 !important; }
  .desktop-nav { display: contents !important; }
  .nav-utility { grid-column: 3 !important; grid-row: 1 !important; justify-self: end !important; gap: 0 !important; }
  .nav-utility button { padding: 6px 4px !important; }
}
        a { color: inherit; }
        input[type="date"] { color: ${C.text}; }
      `}</style>
      <header style={{ background: "#fff", borderBottom: `1px solid ${C.border}`, position: "sticky", top: 0, zIndex: 100, boxShadow: "0 1px 6px rgba(0,0,0,0.06)", minHeight: 52 }}>
        {/* Row 1: Hamburger (left) + Logo (center) + Subscription badge (right) — grid keeps the logo centered regardless of side-element width */}
        <div className="mobile-logo-row" style={{ display: "grid", gridTemplateColumns: "auto 1fr auto", alignItems: "center", gap: 6, padding: "10px 16px 0" }}>
          <button className="hamburger-btn" onClick={() => setMobileMenuOpen(m => !m)} style={{ display: "none", gridColumn: 1, justifySelf: "start", background: "none", border: "none", cursor: "pointer", padding: "8px", fontSize: 26, color: "#6B21E8", width: 44, height: 44, lineHeight: "24px", textAlign: "center" }}>☰</button>
          {/* Desktop-only hamburger trigger — completely separate element/state from the
              mobile hamburger above (mobileMenuOpen). Hidden by default; shown only at
              >=1025px via .desktop-hamburger-wrap in the <style> block below, where it's
              also placed in the header's left grid column. Reuses the same `nav` array
              as the mobile menu and the old NavPills bar — single source of truth. */}
          <div className="desktop-hamburger-wrap" style={{ display: "none", position: "relative" }}>
            <button aria-haspopup="true" aria-expanded={desktopMenuOpen} aria-label={t("nav.menu")} onClick={() => setDesktopMenuOpen(m => !m)} style={{ background: "none", border: "none", cursor: "pointer", padding: 8, fontSize: 24, color: "#6B21E8", width: 40, height: 40, lineHeight: "24px", textAlign: "center" }}>☰</button>
            {desktopMenuOpen && (
              <div>
                <div onClick={() => setDesktopMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 149 }} />
                <div role="menu" style={{ position: "absolute", top: "100%", left: 0, marginTop: 6, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: "0 8px 24px rgba(0,0,0,0.14)", zIndex: 150, minWidth: 230, maxHeight: "calc(100vh - 80px)", overflowY: "auto", padding: 6 }}>
                  {nav.map(n => (
                    <button key={n.id} role="menuitem" style={{ width: "100%", padding: "10px 14px", borderRadius: 8, border: "none", background: page === n.id ? C.purpleLight : "#fff", color: page === n.id ? C.purple : C.text, fontSize: 14, fontWeight: page === n.id ? 700 : 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 10, textAlign: "left" }} onClick={() => { if (n.id === "resume" && navigateToResume) { navigateToResume("upload"); } else { setPage(n.id); } setDesktopMenuOpen(false); }}>
                      {/* Fixed-width, centered icon slot -- not a per-item fix. Every nav
                          icon here is a wide-presentation emoji (~22px natural width)
                          except "♥" (Saved Jobs), which renders as a narrow text-style
                          glyph without an emoji variation selector, so its un-contained
                          span was ~12px narrower than every other icon and shifted its
                          label left. A shared fixed-width slot makes every item's label
                          start at the same x-coordinate regardless of the icon's own
                          natural glyph width, current and future. */}
                      <span style={{ fontSize: 16, flexShrink: 0, width: 22, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>{n.icon}</span>{n.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="logo-block" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14, minWidth: 0, cursor: "pointer", gridColumn: 2 }} onClick={goHome}>
            <Logo size={32} className="brand-logo" /><AppName size={17} className="brand-name" />
          </div>
          <button className="subscription-badge" onClick={() => setPage(isPaidPlan ? "settings" : "pricing")} style={{ display: "none", gridColumn: 3, justifySelf: "end", background: "none", border: "none", padding: "8px 12px 8px 4px", cursor: "pointer", lineHeight: 1 }}>
            <span style={{ display: "flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
              <span style={{ width: 9, height: 9, borderRadius: "50%", background: C.purple, flexShrink: 0, display: "block" }} />
              <span style={{ fontSize: 13, fontWeight: 800, letterSpacing: "-0.5px", color: C.purple, fontFamily: "'Inter','Segoe UI',system-ui,sans-serif", lineHeight: 1 }}>{planName}</span>
            </span>
          </button>
        </div>
        {/* Row 2: Utility only -- desktop navigation now lives in the hamburger menu
            in Row 1 (.desktop-hamburger-wrap), not a horizontal pill bar here. */}
        <div className="desktop-nav" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "6px 16px 8px", gap: 4 }}>
          <div className="nav-utility" style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <LanguageMenu variant="icon" />
            <NotificationsMenu variant="icon" notifications={notifications} refresh={refreshNotifications} markAllRead={markAllRead} unreadCount={unreadCount} />
            <UserMenu profile={profile} page={page} setPage={setPage} onLogout={handleLogout} />
          </div>
        </div>
      </header>
      {mobileMenuOpen && (
        <div style={{ position: "fixed", top: 52, left: 0, right: 0, bottom: 0, background: "#fff", zIndex: 99, overflowY: "auto", padding: "16px" }}>
          {nav.map(n => (
            <button key={n.id} style={{ width: "100%", padding: "16px 20px", borderRadius: 10, border: "none", background: page === n.id ? C.purpleLight : "#fff", color: page === n.id ? C.purple : C.text, fontSize: 15, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 12, marginBottom: 6, textAlign: "left" }} onClick={() => { setPage(n.id); setMobileMenuOpen(false); }}>
              <span style={{ fontSize: 20 }}>{n.icon}</span>{n.label}
            </button>
          ))}
          <div style={{ borderTop: `1px solid ${C.border}`, margin: "8px 0" }} />
          <LanguageMenu variant="row" />
          <NotificationsMenu variant="row" notifications={notifications} refresh={refreshNotifications} markAllRead={markAllRead} unreadCount={unreadCount} />
          <div style={{ borderTop: `1px solid ${C.border}`, margin: "8px 0" }} />
          <button style={{ width: "100%", padding: "16px 20px", borderRadius: 10, border: "none", background: page === "profile" ? C.purpleLight : "#fff", color: page === "profile" ? C.purple : C.text, fontSize: 15, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 12, marginBottom: 6, textAlign: "left" }} onClick={() => { setPage("profile"); setMobileMenuOpen(false); }}>
            <span style={{ fontSize: 20 }}>👤</span>{t("userMenu.profile")}
          </button>
          <button style={{ width: "100%", padding: "16px 20px", borderRadius: 10, border: "none", background: page === "settings" ? C.purpleLight : "#fff", color: page === "settings" ? C.purple : C.text, fontSize: 15, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 12, marginBottom: 6, textAlign: "left" }} onClick={() => { setPage("settings"); setMobileMenuOpen(false); }}>
            <span style={{ fontSize: 20 }}>⚙️</span>{t("userMenu.settings")}
          </button>
          <button style={{ width: "100%", padding: "16px 20px", borderRadius: 10, border: "none", background: "#fff", color: C.red, fontSize: 15, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 12, marginBottom: 6, textAlign: "left" }} onClick={() => { handleLogout(); setMobileMenuOpen(false); }}>
            <span style={{ fontSize: 20 }}>🚪</span>{t("userMenu.signOut")}
          </button>
        </div>
      )}
      <main style={{ maxWidth: 1124, margin: "0 auto", padding: "32px 24px 80px" }}>
        {page === "dashboard" && <DashboardPage profile={profile} applications={applications} savedJobs={savedJobs} setPage={setPage} resumes={resumes} smartApplyQueue={smartApplyQueue} smartApplyQueueLoading={smartApplyQueueLoading} networkingSession={networkingSessionCtx} notifications={notifications} interviewSession={rootInterviewSession} salaryData={rootSalaryData} networkContacts={rootNetworkContacts} activeResumeId={activeResumeId} companyWatchlist={companyWatchlist} onNavigateResume={navigateToResume} isPremium={isPremium} latestOutcomeAnalysis={outcomeAnalysesHook.latest} onOpenOutcomeIntelligence={openTrackerInsights} />}
        {page === "briefing" && <BriefingPage profile={profile} applications={applications} savedJobs={savedJobs} setPage={setPage} resumes={resumes} smartApplyQueue={smartApplyQueue} networkingSession={networkingSessionCtx} companyWatchlist={companyWatchlist} />}
        {page === "plan" && <PlanPage profile={profile} applications={applications} savedJobs={savedJobs} setPage={setPage} onNavigateResume={navigateToResume} />}
        {page === "progress" && <CareerProgressPage profile={profile} applications={applications} savedJobs={savedJobs} setPage={setPage} updateProfile={updateProfile} resumes={resumes} analysisHistory={analysisHistory} onNavigateResume={navigateToResume} />}
        {page === "resume" && <ResumePage onSave={handleSaveApp} onNavigate={setPage} profile={profile} applications={applications} savedJobs={savedJobs} resumes={resumes} resumesLoading={resumesLoading} saveResume={rootSaveResume} deleteResume={rootDeleteResume} downloadResume={rootDownloadResume} saveAnalysis={rootSaveAnalysis} updateVersionLabel={rootUpdateVersionLabel} updateResumeLanguage={rootUpdateResumeLanguage} jobLanguage={profile?.job_language || "en"} analysisHistory={analysisHistory} saveHistoryToDb={saveHistoryToDb} activeResumeId={activeResumeId} onResumeLoad={setActiveResumeId} entryTarget={resumeEntryTarget} onConsumeEntryTarget={() => setResumeEntryTarget(null)} isPremium={isPremium} billingState={billingState} />}
        {page === "jobs" && <JobSearchPage savedJobs={savedJobs} setSavedJobs={setSavedJobs} setApplications={setApplications} applications={applications} profile={profile} resumes={resumes} onQueueChange={refreshSmartApplyQueue} queue={smartApplyQueue} enqueue={rootEnqueue} markReady={rootMarkReady} markNeedsReview={rootMarkNeedsReview} markFailed={rootMarkFailed} purgeQueueByJobId={rootPurgeByJobId} onNavigate={setPage} billingState={billingState} activeResumeId={activeResumeId} onResumeLoad={setActiveResumeId} saveResume={rootSaveResume} onNavigateResume={navigateToResume} jobWatchlist={jobWatchlistHook} companyWatchlist={companyWatchlistHook} />}
        {page === "saved" && <SavedJobsPage savedJobs={savedJobs} setSavedJobs={setSavedJobs} setApplications={setApplications} applications={applications} profile={profile} resumes={resumes} onQueueChange={refreshSmartApplyQueue} queue={smartApplyQueue} queueLoading={smartApplyQueueLoading} markApplied={rootMarkApplied} markReady={rootMarkReady} markNeedsReview={rootMarkNeedsReview} markFailed={rootMarkFailed} resetToQueued={rootResetToQueued} purgeQueueByJobId={rootPurgeByJobId} enqueue={rootEnqueue} activeResumeId={activeResumeId} patchQueueItem={rootPatchQueueItem} />}
        {page === "jobtracker" && <JobTrackerPage profile={profile} resumes={resumes} activeResumeId={activeResumeId} companyWatchlist={companyWatchlistHook} jobWatchlist={jobWatchlistHook} setPage={setPage} />}
        {page === "interview" && <InterviewPage profile={profile} applications={applications} savedJobs={savedJobs} />}
        {page === "tracker" && <TrackerPage applications={applications} deleteApplication={handleDeleteApplication} saveApplication={handleSaveApplication} resumes={resumes} savedJobs={savedJobs} smartApplyQueue={smartApplyQueue} profile={profile} isPremium={isPremium} outcomePatternsHook={outcomePatternsHook} outcomeAnalysesHook={outcomeAnalysesHook} recommendationEvalHook={recommendationEvalHook} forceInsightsTab={forceTrackerInsightsTab} onForceInsightsTabHandled={() => setForceTrackerInsightsTab(false)} />}
        {page === "salary" && <SalaryPage profile={profile} applications={applications} savedJobs={savedJobs} />}
        {page === "network" && <NetworkingPage profile={profile} applications={applications} savedJobs={savedJobs} isPremium={isPremium} watchlist={companyWatchlist} referralPatterns={outcomePatternsHook.patterns} referralAnalysesHook={referralAnalysesHook} />}
        {page === "pricing" && <PricingPage profile={profile} setPage={setPage} billingState={billingState} refreshBillingState={refreshBillingState} />}
        {page === "opportunity" && <OpportunityPage profile={profile} savedJobs={savedJobs} applications={applications} setPage={setPage} watchlist={companyWatchlist} watchlistAdd={watchlistAdd} watchlistRemove={watchlistRemove} watchlistUpdateStatus={watchlistUpdateStatus} referralPatterns={outcomePatternsHook.patterns} referralAnalysesHook={referralAnalysesHook} />}

        {page === "alerts" && <ProactiveAlertsPanel userId={profile?.id} isPremium={isPremium} alertsHook={proactiveAlertsHook} />}
        {page === "jobintel" && <JobIntelligencePage profile={profile} applications={applications} savedJobs={savedJobs} setPage={setPage} />}
        {page === "settings" && <SettingsPage profile={profile} updateProfile={updateProfile} logout={handleLogout} setPage={setPage} billingState={billingState} refreshBillingState={refreshBillingState} />}
        {page === "profile" && <ProfilePage profile={profile} updateProfile={updateProfile} />}
      </main>
    </div>
    </I18nContext.Provider>
  );
}

// v4.1 - fast prompts update

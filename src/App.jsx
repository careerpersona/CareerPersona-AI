import { useState, useCallback, useRef, useEffect } from "react";
import { supabase, initialLocationHash, initialLocationSearch } from "./lib/supabaseClient";
import { fetchProfile, upsertProfile } from "./data/profile";
import { useApplications, insertApplicationRow, deleteApplicationRow, upsertApplicationRow } from "./data/applications";
import { useSavedJobs } from "./data/savedJobs";
import { useResumes, useResumeHistory } from "./data/resumes";
import { useSmartApplyQueue } from "./data/smartApply";
import { useInterviewSession } from "./data/interviewSession";
import { useSalaryResearch } from "./data/salaryResearch";
import { useNetworkingContacts } from "./data/networkingContacts";
import { useNetworkingSession } from "./data/networkingSession";
import { useAssistantChat } from "./data/assistantChat";
import { useActivityLog } from "./data/activityLog";
import { useNotifications, insertNotification } from "./data/notifications";
import { useAiBriefing } from "./data/aiBriefing";
import { useAiActionPlan } from "./data/aiActionPlan";
import { useUserContext } from "./data/userContext";
import { useCompanyWatchlist } from "./data/opportunityIntelligence";
import { I18nContext, useLanguagePreference, useI18n } from "./i18n/I18nContext";
import { LANGUAGES } from "./i18n/languages";
import { MapPin, Mail, Phone, Globe, User, Briefcase, GraduationCap, Code2, Award, FolderOpen } from 'lucide-react';

// Disable browser scroll restoration before React mounts — prevents the
// browser from jumping to the last scroll position on page refresh.
if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";

const C = {
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

const useSessionState = (key, initial) => {
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

async function askClaude(prompt, maxTokens = 2500) {
  if (DEV_MODE) {
    // Simulate realistic network latency so all loading states, progress bars,
    // banners, and animations behave exactly as they do in production.
    await new Promise(r => setTimeout(r, 850 + Math.random() * 400));
    return _devMockRoute(prompt);
  }
  const WORKER_URL = "https://proxy.dawn-voice-2790.workers.dev";
  const res = await fetch(WORKER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || "API error");
  return (data.content?.[0]?.text || "{}").replace(/```json|```/g, "").trim();
}

// Routes every askClaude prompt to the appropriate mock response.
// Checks for distinguishing keywords present in each prompt string.
function _devMockRoute(prompt) {
  const p = prompt.toLowerCase();

  // ── Daily Briefing ─────────────────────────────────────────────────────────
  if (p.includes("daily briefing")) {
    return JSON.stringify({ v: 2, summary: "You have 3 active applications in progress and your ATS score is trending up. Today is a strong day to follow up with recruiters.", newMatchingJobs: "23 new Software Engineer roles posted this week matching your skills.", highestPayingJobs: "Senior roles at Series B startups offer $150K–$185K with strong equity packages.", jobsClosingSoon: "2 applications haven't received a response in 7 days — now is the right time to follow up.", priorityRecommendation: "Add Docker, Kubernetes, and CI/CD to your resume to push your ATS score above 85.", companiesHiringNow: "Amazon, Stripe, and Notion are actively sourcing for mid-senior engineers this month.", newOpportunities: "Staff Engineer and Tech Lead roles are open in adjacent areas matching your trajectory.", resumeUpdates: "Your resume is scoring 82 — one targeted keyword pass could push you into the top 20% of applicants.", atsScoreChanges: "Your ATS score improved 8 points after the last resume update. Keep the momentum.", interviewInvitations: "1 interview stage pending — prep a strong STAR answer for 'Tell me about a time you led a project.'", recruiterActivity: "Your LinkedIn profile is at 87% completeness — adding 2 skills boosts recruiter visibility.", applicationUpdates: "3 applications are in 'Under Review' — follow up with a brief check-in email.", salaryChanges: "Median comp for Senior Software Engineers in your location increased 6% YoY.", marketUpdates: "Demand for full-stack engineers remains high. Your skills are in demand.", careerInsights: "Candidates who customize their resume per application see a 40% higher interview rate.", dailyHighlights: ["Follow up on 2 applications", "Add Docker & Kubernetes to resume", "Check 3 new job matches"] });
  }

  // ── Action Plan ────────────────────────────────────────────────────────────
  if (p.includes("action plan") || p.includes("productivityscore")) {
    return JSON.stringify({ v: 2, productivityScore: 72, categories: [{ id: "priorities", category: "Today's Priorities", task: "Follow up on your Stripe application — it's been 6 days since submission.", time: "10 min", status: "pending" }, { id: "applications", category: "Recommended Applications", task: "Apply to the Staff Engineer role at Notion — it's a strong match for your background.", time: "30 min", status: "pending" }, { id: "resume", category: "Resume Improvements", task: "Add Docker and Kubernetes to your skills section to improve ATS score by ~8 points.", time: "15 min", status: "pending" }, { id: "interview", category: "Interview Practice", task: "Practice STAR method for 'Tell me about a time you handled a production incident.'", time: "20 min", status: "pending" }], followUps: "Send a brief check-in email to the recruiter at Amazon who reached out last week.", networking: "Connect with 2 engineers at Notion on LinkedIn and mention your shared interest in developer tools.", skills: "Spend 30 minutes on a Docker tutorial — it appears in 68% of your target job descriptions.", certifications: "AWS Solutions Architect certification would strengthen 40% of your target roles.", careerGoals: "You're on track for a Senior→Staff promotion path if you land a role with system design scope." });
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

  // ── LinkedIn Optimizer ─────────────────────────────────────────────────────
  if (p.includes("linkedin profile expert") || (p.includes("linkedin") && p.includes("headline") && p.includes("aboutsection"))) {
    return JSON.stringify({ headline: "Senior Software Engineer | Python · AWS · React | Building Scalable Systems That Perform", aboutSection: "I'm a software engineer with 5+ years building high-performance distributed systems. I specialize in Python, AWS, and React — with a track record of shipping products used by tens of thousands of users and driving a 40% reduction in API latency.\n\nI'm passionate about clean architecture, developer experience, and working on teams that care about engineering quality. Currently exploring Senior and Staff Engineer opportunities where I can drive technical strategy alongside great people.", experienceOptimizations: [{ company: "Acme Corp", title: "Senior Software Engineer", optimizedBullets: ["Architected microservices platform handling 2M+ daily requests using Python and AWS Lambda, reducing infrastructure costs by 35%", "Drove 40% API latency reduction through Redis caching strategy and query optimization", "Led cross-functional team of 5 engineers delivering real-time data pipeline 2 weeks ahead of schedule"] }, { company: "Tech Startup", title: "Software Engineer", optimizedBullets: ["Built React/TypeScript frontend serving 50K+ monthly active users, improving Core Web Vitals by 28%", "Established CI/CD pipeline with Docker and Jenkins, reducing deployment time from 45 to 8 minutes", "Integrated Stripe and Twilio APIs processing $2M+ in annual transactions"] }], topSkillsToAdd: ["System Design", "Microservices Architecture", "PostgreSQL", "Terraform", "GraphQL", "Data Engineering"], keywordsToFeature: ["distributed systems", "high availability", "cloud architecture", "API design", "performance optimization", "agile"], recruiterVisibilityTips: ["Set your profile to 'Open to Work' with specific role titles to appear in recruiter searches", "Post one technical insight per week — LinkedIn algorithm boosts profiles with consistent engagement", "Request recommendations from managers who can speak to your leadership and technical impact"], atsAlignmentScore: 81, profileCompleteness: 78, headlineScore: 88 });
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

  // ── Job Search AI Match (per-job match score) ──────────────────────────────
  if (p.includes("analyze resume-job match") || (p.includes("matchscore") && p.includes("interviewprobability"))) {
    return JSON.stringify({ matchScore: 76, atsScore: 74, interviewProbability: 62, matchingSkills: ["Python", "AWS", "React"], missingSkills: ["Docker", "Kubernetes", "GraphQL"], summary: "Strong technical match with core requirements; adding container experience would close the remaining gap." });
  }

  // ── Smart Apply Full Package ───────────────────────────────────────────────
  if (p.includes("application package") || (p.includes("tailoredresume") && p.includes("recruitermessage"))) {
    return JSON.stringify({ tailoredResume: _devMockResume(), coverLetter: "Dear Hiring Manager,\n\nI am excited to apply for this position. My background in Python, AWS, and scalable system design aligns directly with your requirements.\n\nAt Acme Corp I drove a 40% reduction in API latency and led a team of 5 engineers delivering critical data pipelines ahead of schedule. I would welcome the opportunity to discuss how I can contribute.\n\nBest regards,\nJohn Smith", recruiterMessage: "Hi [Name], I came across this role and was immediately drawn to the distributed systems work your team is doing. I have 5 years of Python/AWS experience and a track record of 40% latency improvements. Would you be open to a quick chat?", networkingMessage: "Hi [Name], I saw you work at [company] — I've been following the engineering blog and am very interested in the team's infrastructure work. Would love to connect if you have 15 minutes!", missingSkills: ["Docker", "Kubernetes", "Terraform"], interviewProbability: 68, hiringProbability: 42, applicationQuestions: ["Describe your experience with distributed systems at scale.", "How do you approach debugging a production incident with no runbook?", "Tell me about a time you led a technical project from design to deployment."], salaryInsight: { marketRange: { low: 140000, median: 165000, high: 195000 }, userPositioning: "Your experience level positions you in the 55th–70th percentile of the market range.", negotiationLeverage: "Your measurable 40% latency reduction is strong negotiation leverage — it demonstrates direct business impact.", benchmarks: ["Staff Engineer at similar-stage companies: $170K–$200K total comp"] }, companyInsight: { culture: "Engineering-driven culture with strong emphasis on technical excellence and ownership.", recentNews: "Recently announced Series C of $150M — actively expanding engineering headcount across platform teams.", hiringTrend: "growing", redFlags: ["High interview bar may result in extended hiring timeline"], greenFlags: ["Strong eng culture with open-source contributions", "Competitive equity refreshes"], talkingPoints: ["Their caching architecture work aligns directly with your Redis optimization experience"] } });
  }

  // ── Match Score Only (lightweight call in job search) ─────────────────────
  if (p.includes("match score only")) {
    return JSON.stringify({ matchScore: 74, explanation: "Strong Python/AWS match; missing container orchestration skills." });
  }

  // ── Interview Questions ────────────────────────────────────────────────────
  if ((p.includes("interview questions") || p.includes("interview coach")) && p.includes("behavioral")) {
    return JSON.stringify([{ question: "Tell me about a time you led a complex technical project from design to delivery.", category: "Behavioral", difficulty: "Medium", tipToAnswer: "Use the STAR method: Situation (project scope and stakes), Task (your role), Action (key decisions you made and why), Result (measurable outcome — timeline, performance, business value).", starGuidance: { situation: "Describe the project context and why it was complex", task: "Explain your specific responsibilities", action: "Walk through 2–3 key decisions and the reasoning behind each", result: "Quantify the outcome: timeline, performance, team impact, business value" } }, { question: "How do you approach debugging a production incident with no runbook and customers impacted?", category: "Technical", difficulty: "Hard", tipToAnswer: "Walk through your mental model: triage by impact, isolate the failure domain, form hypotheses, test carefully. Show you can stay calm, communicate status, and learn from post-mortems.", starGuidance: null }, { question: "Describe a system you designed that needed to scale significantly. What tradeoffs did you navigate?", category: "Technical", difficulty: "Hard", tipToAnswer: "Pick a concrete example. Name the scale target, bottlenecks identified, architectural options considered, and what you chose — and why. Acknowledge tradeoffs honestly.", starGuidance: null }, { question: "Tell me about a time you disagreed with a technical decision your team made. How did you handle it?", category: "Behavioral", difficulty: "Medium", tipToAnswer: "Use STAR. Show you can advocate constructively with data and reasoning, not just opinion.", starGuidance: { situation: "Describe the decision and its context", task: "Explain your concern and why it mattered", action: "Describe how you raised it — data, framing, the conversation", result: "Outcome and what you learned about technical advocacy" } }, { question: "How do you prioritize technical debt against product feature delivery?", category: "Situational", difficulty: "Medium", tipToAnswer: "Show you think in tradeoffs, not absolutes. Name a framework (risk-based, velocity-based). Give an example.", starGuidance: null }, { question: "Tell me about your experience with cloud infrastructure and cost optimization.", category: "Technical", difficulty: "Easy", tipToAnswer: "Be specific: which services, at what scale, and what you optimized. Quantify savings if possible.", starGuidance: null }, { question: "How do you ensure code quality across a team with varying experience levels?", category: "Culture Fit", difficulty: "Medium", tipToAnswer: "Talk about systems, not just standards: code review culture, pair programming, automated testing, documentation. Show you think about enablement, not enforcement.", starGuidance: null }, { question: "Where do you see your engineering career in 3–5 years?", category: "Culture Fit", difficulty: "Easy", tipToAnswer: "Be genuine but frame it around growth in the domain they care about. Show ambition balanced with commitment to this role.", starGuidance: null }]);
  }

  // ── Interview Answer Rating ────────────────────────────────────────────────
  if (p.includes("rate this practice answer") || (p.includes("interview coach") && p.includes("score"))) {
    return JSON.stringify({ score: 7.8, scoreLabel: "Strong", strengths: ["Clear structure with specific details", "Good use of quantifiable outcome", "Confident delivery without hedging"], improvements: ["Could be 15% more concise — trim the setup to get to the action faster", "Add the business impact beyond the technical result"], starFeedback: { situation: "Well set — 8/10", task: "Clear ownership stated — 9/10", action: "Good detail on decisions — 8/10", result: "Solid quantification — add business impact — 7/10" }, revisedAnswer: "At Acme Corp I inherited a system with 800ms API latency causing cart abandonment. I analyzed query patterns, identified N+1 database calls, and implemented Redis caching for the hot path. Latency dropped 40% to 480ms, cart completion improved 12%, and database load fell 30% — saving $1,800/month in RDS costs.", paceWpm: 142, fillerWordCount: 2 });
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

  // ── Fallback ───────────────────────────────────────────────────────────────
  return "{}";
}

function _devMockResume() {
  return `John Smith
Senior Software Engineer | San Francisco, CA
john.smith@email.com | (555) 123-4567 | linkedin.com/in/johnsmith

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

const RESUME_SECTION_NAMES = new Set([
  'SUMMARY','PROFESSIONAL SUMMARY','CAREER SUMMARY','EXECUTIVE SUMMARY','OBJECTIVE',
  'CAREER OBJECTIVE','PROFESSIONAL OBJECTIVE','PROFILE','ABOUT','OVERVIEW','HIGHLIGHTS',
  'EXPERIENCE','WORK EXPERIENCE','PROFESSIONAL EXPERIENCE','EMPLOYMENT','EMPLOYMENT HISTORY',
  'WORK HISTORY','CAREER HISTORY','RELEVANT EXPERIENCE',
  'EDUCATION','ACADEMIC BACKGROUND','EDUCATIONAL BACKGROUND','ACADEMIC HISTORY',
  'SKILLS','TECHNICAL SKILLS','CORE COMPETENCIES','COMPETENCIES','KEY SKILLS','EXPERTISE',
  'CORE SKILLS','PROFESSIONAL SKILLS','TECHNOLOGIES','TECHNICAL EXPERTISE',
  'CERTIFICATIONS','CERTIFICATION','LICENSES','LICENSE','CREDENTIALS',
  'PROFESSIONAL CERTIFICATIONS','PROFESSIONAL DEVELOPMENT','TRAINING',
  'PROJECTS','KEY PROJECTS','PORTFOLIO','SELECTED PROJECTS','NOTABLE PROJECTS',
  'TECHNICAL PROJECTS','PERSONAL PROJECTS','OPEN SOURCE','OPEN SOURCE CONTRIBUTIONS',
  'ACHIEVEMENTS','ACCOMPLISHMENTS','AWARDS','HONORS','RECOGNITIONS','HONORS AND AWARDS',
  'PUBLICATIONS','RESEARCH','PAPERS','PRESENTATIONS','SPEAKING ENGAGEMENTS',
  'VOLUNTEER','VOLUNTEERING','VOLUNTEER EXPERIENCE','COMMUNITY SERVICE','CIVIC ACTIVITIES',
  'LANGUAGES','INTERESTS','HOBBIES','PERSONAL INTERESTS','ACTIVITIES','EXTRACURRICULAR',
  'ADDITIONAL','ADDITIONAL INFORMATION','OTHER','LEADERSHIP','LEADERSHIP EXPERIENCE',
  'PROFESSIONAL MEMBERSHIPS','MEMBERSHIPS','AFFILIATIONS','PROFESSIONAL AFFILIATIONS',
  'REFERENCES','PROFESSIONAL REFERENCES','CONFERENCES','PATENTS','CONSULTING',
  'FREELANCE','CONTRACT WORK','INDEPENDENT PROJECTS','MILITARY','MILITARY SERVICE',
  'MILITARY EXPERIENCE','INTERNSHIPS','INTERNSHIP EXPERIENCE','VOLUNTEER WORK',
]);

function parseResumeDoc(rawText) {
  const result = { name: '', headerLines: [], sections: [] };
  if (!rawText) return result;

  // Flat-text normalization: if text has very few newlines (old PDF extraction produced
  // one long space-joined string per page), insert \n before every known section name
  // that is preceded by a lowercase character. This fixes existing stored Supabase data
  // without requiring re-upload.
  let text = rawText;
  const newlineCount = (text.match(/\n/g) || []).length;
  if (newlineCount < 3 && text.length > 80) {
    const names = Array.from(RESUME_SECTION_NAMES).sort((a, b) => b.length - a.length);
    for (const name of names) {
      const re = new RegExp('([a-z0-9.,;!?]) +(' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?= )', 'g');
      text = text.replace(re, '$1\n$2\n');
    }
  }

  const isSec  = (t) => RESUME_SECTION_NAMES.has(t.trim().toUpperCase());
  const isBullet = (t) => /^[•\-\*▪▸◦]\s/.test(t);
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length && !lines[i].trim()) i++;
  if (i < lines.length) { result.name = lines[i].trim(); i++; }

  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) { i++; continue; }
    if (isSec(t)) break;
    const isContactLine = /[@]/.test(t) || /\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/.test(t);
    result.headerLines.push({ text: t, type: isContactLine ? 'contact' : 'title' });
    i++;
  }

  while (i < lines.length) {
    const t = lines[i].trim();
    if (!t) { i++; continue; }
    if (!isSec(t)) { i++; continue; }

    const section = { title: t.trim().toUpperCase(), items: [] };
    i++;
    let afterGap = true;

    while (i < lines.length) {
      const l = lines[i].trim();
      if (isSec(l)) break;
      if (!l) {
        if (section.items.length) section.items.push({ type: 'gap' });
        afterGap = true;
        i++;
        continue;
      }
      if (isBullet(l)) {
        section.items.push({ type: 'bullet', text: l.replace(/^[•\-\*▪▸◦]\s*/, '').trim() });
        afterGap = false;
      } else {
        section.items.push({ type: afterGap ? 'roleHeader' : 'text', text: l });
        afterGap = false;
      }
      i++;
    }
    while (section.items.length && section.items[section.items.length - 1].type === 'gap') {
      section.items.pop();
    }
    result.sections.push(section);
  }

  return result;
}

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

// Fixed pixel widths per button, measured at 11.5px Inter on 1280px viewport.
// Values ≥ English natural width (English never clips). Wider translations
// render invisibly clipped by overflow:hidden; the icon always shows and
// the full label is in the title tooltip on hover.
const NAV_PILL_WIDTH = {
  dashboard: 110, resume: 89, jobs: 112, saved: 80,
  interview: 98, tracker: 88, salary: 79, network: 95, pricing: 84,
};

function NavPills({ nav, page, setPage }) {
  return (
    <nav className="nav-pills" style={{ display: "flex", gap: 4, background: C.bgSoft, borderRadius: 11, padding: "3px" }}>
      {nav.map(n => (
        <button key={n.id} title={n.label} className="nav-pill" style={{ width: NAV_PILL_WIDTH[n.id], flexShrink: 0, overflow: "hidden", padding: "6px 11px", borderRadius: 8, border: "none", background: page === n.id ? "#fff" : "transparent", color: page === n.id ? C.purple : C.navText, opacity: 1, fontSize: 11.5, fontWeight: page === n.id ? 700 : 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, whiteSpace: "nowrap", boxShadow: page === n.id ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }} onClick={() => setPage(n.id)}>
          <span style={{ fontSize: 13, flexShrink: 0 }}>{n.icon}</span><span className="nav-label" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.label}</span>
        </button>
      ))}
    </nav>
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
        <button onClick={() => setOpen(o => !o)} style={{ padding: "6px 10px", borderRadius: 8, border: "none", background: open ? "#fff" : "transparent", color: open ? C.purple : C.textMuted, fontSize: 14, cursor: "pointer" }} title="Language">🌐</button>
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
function NotificationsMenu({ variant = "icon", notifications, refresh, markAllRead }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next) { await refresh(); markAllRead(); }
  };
  return (
    <div style={{ position: "relative" }}>
      {variant === "row" ? (
        <button onClick={toggle} style={{ width: "100%", padding: "16px 20px", borderRadius: 10, border: "none", background: open ? C.purpleLight : "#fff", color: open ? C.purple : C.text, fontSize: 15, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 12, marginBottom: 6, textAlign: "left" }}>
          <span style={{ fontSize: 20 }}>🔔</span>{t("notifications.title")}
        </button>
      ) : (
        <button onClick={toggle} style={{ padding: "6px 10px", borderRadius: 8, border: "none", background: open ? "#fff" : "transparent", color: open ? C.purple : C.textMuted, fontSize: 14, cursor: "pointer" }} title="Notifications">🔔</button>
      )}
      {open && (
        <div>
          <div onClick={() => setOpen(false)} style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, zIndex: 99 }} />
          <div style={{ position: "absolute", top: "110%", right: 0, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 12, boxShadow: "0 4px 16px rgba(0,0,0,0.12)", zIndex: 100, width: 280, overflow: "hidden" }}>
            <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.border}`, fontWeight: 700, fontSize: 14, color: C.text }}>{t("notifications.title")}</div>
            {notifications.length === 0 ? (
              <div style={{ padding: "32px 16px", textAlign: "center" }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>🔔</div>
                <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 4 }}>{t("notifications.emptyTitle")}</div>
                <div style={{ fontSize: 12, color: C.textMuted }}>{t("notifications.emptyBody")}</div>
              </div>
            ) : (
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                {notifications.map(n => (
                  <div key={n.id} style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`, background: n.read ? "#fff" : C.purpleLight }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.text, marginBottom: 3 }}>{n.title}</div>
                    {n.body && <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.5, marginBottom: 4 }}>{n.body}</div>}
                    <div style={{ fontSize: 11, color: C.textMuted }}>{n.time}</div>
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

function Btn({ children, onClick, variant = "primary", disabled, loading, style = {}, className, title }) {
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

function Card({ children, style = {}, onClick, ...rest }) {
  return <div onClick={onClick} style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 16, padding: 24, boxShadow: "0 1px 4px rgba(0,0,0,0.04)", ...style }} {...rest}>{children}</div>;
}

function Label({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 7 }}>{children}</div>;
}

function Input({ label, style = {}, ...props }) {
  return <div>{label && <Label>{label}</Label>}<input style={{ width: "100%", background: "#ffffff", border: "1.5px solid #E2E8F0", borderRadius: 9, color: "#0F172A", fontSize: 14, padding: "12px 14px", outline: "none", fontFamily: "inherit", boxSizing: "border-box", ...style }} {...props} /></div>;
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

function CopyBtn({ text, label = "Copy", variant = "ghost", style: outerStyle }) {
  const [c, setC] = useState(false);
  const handleCopy = () => {
    copyToClipboard(text)
      .then(() => { setC(true); setTimeout(() => setC(false), 2000); })
      .catch(() => { setC(true); setTimeout(() => setC(false), 2000); }); // still show feedback even if API errors
  };
  return <Btn variant={variant} style={{ padding: "6px 14px", fontSize: 12, ...outerStyle }} onClick={handleCopy}>{c ? "✓ Copied!" : label}</Btn>;
}

function ContentDisplay({ content }) {
  return (
    <div style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px", fontSize: 14, lineHeight: 1.85, color: C.text, whiteSpace: "pre-wrap", maxHeight: 420, overflowY: "auto", fontFamily: "inherit" }}>
      {content}
    </div>
  );
}

// ─── Resume renderer helpers ─────────────────────────────────────────────────
function detectContactType(text) {
  if (/@/.test(text)) return 'email';
  if (/\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/.test(text)) return 'phone';
  if (/linkedin/i.test(text)) return 'linkedin';
  if (/github/i.test(text)) return 'github';
  if (/portfolio|website/i.test(text) || /^https?:\/\/|\.(io|dev|me|co|org|net|app|site)\b/i.test(text)) return 'portfolio';
  return 'location';
}
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
                  <ContactIcon type={detectContactType(ci)} size={15} color={ACC}/>
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
function ResetPasswordPage({ onDone }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  const handle = async () => {
    if (!password) { setError("Password is required."); return; }
    if (password.length < 6) { setError("Password must be at least 6 characters."); return; }
    if (password !== confirm) { setError("Passwords do not match."); return; }
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
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>Password updated!</div>
              <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 20 }}>Your password has been changed. Please sign in with your new password.</div>
              <Btn style={{ width: "100%", justifyContent: "center", padding: "13px" }} onClick={onDone}>Go to Sign In →</Btn>
            </div>
          ) : (
            <>
              <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 4 }}>Set New Password</div>
              <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 20 }}>Choose a new password for your account.</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <Input label="New Password" type="password" placeholder="••••••••" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && handle()} />
                <Input label="Confirm New Password" type="password" placeholder="••••••••" value={confirm} onChange={e => setConfirm(e.target.value)} onKeyDown={e => e.key === "Enter" && handle()} />
              </div>
              {error && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, color: C.red, fontSize: 13, marginTop: 14 }}>{error}</div>}
              <div style={{ marginTop: 20 }}>
                <Btn onClick={handle} loading={loading} style={{ width: "100%", justifyContent: "center", padding: "13px 22px" }}>
                  {loading ? "Saving…" : "💾 Save New Password"}
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
    if (!forgotEmail.trim()) { setForgotError("Please enter your email address."); return; }
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
                <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>Check Your Email</div>
                <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 20 }}>
                  We sent a password reset link to <strong>{forgotEmail}</strong>. Open it on this device to set a new password.
                </div>
                <Btn variant="secondary" style={{ width: "100%", justifyContent: "center", padding: "13px" }} onClick={() => { setForgotPassword(false); setForgotSent(false); setForgotEmail(""); setForgotError(""); }}>
                  ← Back to Sign In
                </Btn>
              </div>
            ) : (
              <>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 4 }}>Forgot Password?</div>
                <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 20 }}>Enter your email and we'll send you a reset link.</div>
                <Input label="Email Address" type="email" placeholder="you@email.com" value={forgotEmail} onChange={e => setForgotEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && handleForgot()} />
                {forgotError && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, color: C.red, fontSize: 13, marginTop: 14 }}>{forgotError}</div>}
                <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 20 }}>
                  <Btn onClick={handleForgot} loading={forgotLoading} style={{ width: "100%", justifyContent: "center", padding: "13px 22px" }}>
                    {forgotLoading ? "Sending…" : "Send Reset Link"}
                  </Btn>
                  <Btn variant="secondary" style={{ width: "100%", justifyContent: "center", padding: "13px" }} onClick={() => { setForgotPassword(false); setForgotError(""); }}>
                    ← Back to Sign In
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
                    Forgot password?
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
async function buildBriefingPayload(ctx) {
  const raw = await askClaude(`You are CareerPersona AI. Generate a personalized daily briefing based on this user's career data. Be specific, actionable, and encouraging. Return ONLY valid JSON, no markdown:\n{"v":2,"summary":"1-2 personalized sentences about career status today","newMatchingJobs":"1 sentence about job opportunities in their target role","highestPayingJobs":"1 sentence about highest-paying opportunities for their skills","jobsClosingSoon":"1 sentence about application urgency or follow-up timing","priorityRecommendation":"1 specific actionable task for today based on their data","companiesHiringNow":"1 sentence about active hiring in their target sector","newOpportunities":"1 sentence about emerging roles or adjacent opportunities","resumeUpdates":"1 sentence about resume strength or ATS improvement tips","atsScoreChanges":"1 sentence about ATS optimization and score improvements","interviewInvitations":"1 sentence about interview prep or pipeline status","recruiterActivity":"1 sentence about recruiter visibility and profile tips","applicationUpdates":"1 sentence about application pipeline and follow-up strategy","salaryChanges":"1 sentence about salary trends for their role and location","marketUpdates":"1 sentence about job market conditions in their field","careerInsights":"1 strategic career insight specific to their situation","dailyHighlights":["short actionable highlight 1","short actionable highlight 2","short actionable highlight 3"]}\nUser data: ${ctx}`, 1600);
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

// ─── PLAN PAYLOAD BUILDER (shared by DashboardPage + PlanPage) ───────────────
async function buildPlanPayload(ctx) {
  const raw = await askClaude(`You are CareerPersona AI. Generate today's personalized action plan for this job seeker. Be specific and data-driven. Return ONLY valid JSON, no markdown:\n{"v":2,"productivityScore":<integer 0-100 based on career activity and progress>,"categories":[{"id":"priorities","category":"Today's Priorities","task":"<one specific actionable sentence for today>","time":"<e.g. 15 min>","status":"pending"},{"id":"applications","category":"Recommended Applications","task":"<one specific sentence about which jobs to apply to today>","time":"<e.g. 30 min>","status":"pending"},{"id":"resume","category":"Resume Improvements","task":"<one specific sentence about the highest-impact resume change>","time":"<e.g. 20 min>","status":"pending"},{"id":"interview","category":"Interview Practice","task":"<if interview data: specific prep task; if not: skill-building task>","time":"<e.g. 45 min>","status":"pending"}],"followUps":"<1 sentence about specific follow-up actions>","networking":"<1 sentence about specific networking task>","skills":"<1 sentence about specific skill to develop>","certifications":"<1 sentence about specific certification recommendation>","careerGoals":"<1 sentence about progress toward career goals>"}\nUser data: ${ctx}`, 900);
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
    skills: "Identify the top 3 in-demand skills listed in your target job descriptions and create a focused learning plan.",
    certifications: "Research certifications relevant to your target role that could increase your earning potential by 15–20%.",
    careerGoals: "Set your target role, salary, and timeline in your profile so AI can track and optimize your progress."
  };
}

// ─── DASHBOARD PAGE ─────────────────────────────────────────
function DashboardPage({ profile, applications, savedJobs, setPage, resumes, smartApplyQueue, smartApplyQueueLoading, networkingSession, notifications, interviewSession, salaryData, networkContacts: networkContactsProp, activeResumeId, companyWatchlist }) {
  const { t } = useI18n();
  const [briefing, setBriefing] = useState(() => { try { const c = sessionStorage.getItem("cp_briefing_dash"); if (!c) return null; const p = JSON.parse(c); if (p && !Array.isArray(p) && p.v === 2) return p; sessionStorage.removeItem("cp_briefing_dash"); return null; } catch { return null; } });
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

  const { messages: savedChatMessages, loading: chatHistoryLoading, loadedFor: chatLoadedFor, addMessage: addChatMessage } = useAssistantChat(profile?.id);
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
    if (savedBriefing && !Array.isArray(savedBriefing) && savedBriefing.v === 2) {
      setBriefing(savedBriefing);
      try { sessionStorage.setItem("cp_briefing_dash", JSON.stringify(savedBriefing)); } catch {}
    } else if (profile?.id && !(briefing && !Array.isArray(briefing) && briefing.v === 2)) generateBriefing();
  }, [savedBriefing, briefingHistoryLoading, briefingLoadedFor, profile?.id]);

  const { plan: savedPlan, loading: planHistoryLoading, loadedFor: planLoadedFor, save: savePlan } = useAiActionPlan(profile?.id);
  const planAppliedForRef = useRef(undefined);
  const prevActiveResumeIdRef = useRef(undefined);

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
      const result = await buildBriefingPayload(ctx);
      if (!result || Array.isArray(result) || result.v !== 2) throw new Error("buildBriefingPayload returned invalid format: " + JSON.stringify(result)?.slice(0, 100));
      console.log("[Briefing] Generation succeeded — fields:", Object.keys(result).join(", "));
      setBriefing(result);
      try { sessionStorage.setItem("cp_briefing_dash", JSON.stringify(result)); } catch {}
      saveBriefing(result).catch(err => console.error("[Briefing] save failed", err));
      logActivity("Daily briefing generated");
      insertNotification(profile?.id, { type: "ai_recommendation", title: "Daily briefing ready", body: "Your personalized career briefing has been generated.", linkPage: "dashboard" });
    } catch (e) {
      console.error("[Briefing] Generation failed:", e?.message || e);
      setBriefingError("Generation failed. Tap Retry to try again.");
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
      const result = await buildPlanPayload(ctx);
      if (!result?.v || result.v !== 2 || !Array.isArray(result.categories)) throw new Error("buildPlanPayload returned invalid format: " + JSON.stringify(result)?.slice(0, 100));
      console.log("[ActionPlan] Generation succeeded — categories:", result.categories?.length);
      setDailyPlan(result);
      try { sessionStorage.setItem("cp_plan_dash", JSON.stringify(result)); } catch {}
      savePlan(result).catch(err => console.error("[ActionPlan] save failed", err));
      logActivity("Daily plan generated");
      insertNotification(profile?.id, { type: "ai_recommendation", title: "Action plan ready", body: "Today's action plan has been generated.", linkPage: "dashboard" });
    } catch (e) {
      console.error("[ActionPlan] Generation failed:", e?.message || e);
      setPlanError("Generation failed. Tap Retry to try again.");
    }
    finally { setPlanLoading(false); }
  };

  // Chat
  const sendChat = async () => {
    if (!chatInput.trim() || chatLoading) return;
    chatScrollEnabledRef.current = true;
    const userMsg = chatInput.trim();
    setChatInput("");
    setChatMessages(prev => [...prev, { role: "user", text: userMsg }]);
    addChatMessage("user", userMsg).catch(err => console.error("assistant chat save failed", err));
    setChatLoading(true);
    try {
      const context = `You are CareerPersona AI career assistant. ${userContext.getContextString()} Answer concisely (2-3 sentences) using this context.`;
      const raw = await askClaude(`${context}\nUser question: ${userMsg}`, 400);
      setChatMessages(prev => [...prev, { role: "ai", text: raw }]);
      addChatMessage("ai", raw).catch(err => console.error("assistant chat save failed", err));
      logActivity("Chat: " + userMsg.slice(0, 30));
    } catch {
      setChatMessages(prev => [...prev, { role: "ai", text: "Sorry, I couldn't process that. Please try again." }]);
    } finally { setChatLoading(false); }
  };

  useEffect(() => { if (!chatScrollEnabledRef.current || chatMessages.length === 0) return; chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages]);

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
    generateBriefing();
    generatePlan();
  }, [activeResumeId]); // eslint-disable-line react-hooks/exhaustive-deps

  const briefingReady = briefing && !Array.isArray(briefing) && briefing.v === 2;
  const planReady = dailyPlan?.v === 2 && Array.isArray(dailyPlan?.categories);

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
              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4, lineHeight: 1.4 }}>Here's what CareerPersona AI accomplished for you today.</div>
              {!briefingReady && !briefingError && (
                <div style={{ padding: "6px 0 2px", color: C.textMuted, fontSize: 13 }}>{briefingLoading || briefingHistoryLoading ? "Generating your daily briefing…" : "Loading briefing…"}</div>
              )}
              {!briefingReady && briefingError && (
                <div style={{ padding: "6px 0 2px", display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 12, color: C.red }}>{briefingError}</span>
                  <button onClick={generateBriefing} style={{ border: "none", background: "none", color: C.purple, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>Retry</button>
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
                      View Full Briefing →
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
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4, lineHeight: 1.4 }}>AI-generated career actions to complete today.</div>
          {!planReady && !planError && (
            <div style={{ padding: "6px 0 2px", color: C.textMuted, fontSize: 13 }}>
              {planLoading || planHistoryLoading ? "Generating your action plan…" : "Loading action plan…"}
            </div>
          )}
          {!planReady && planError && (
            <div style={{ padding: "6px 0 2px", display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: 12, color: C.red }}>{planError}</span>
              <button onClick={generatePlan} style={{ border: "none", background: "none", color: C.purple, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>Retry</button>
            </div>
          )}
          {planReady && (
            <div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 0 }}>
                {dailyPlan.categories.map((item, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <div style={{ width: 20, height: 20, borderRadius: "50%", border: `2px solid ${item.status === "completed" ? C.green : C.purple}`, background: item.status === "completed" ? C.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>
                      {item.status === "completed" && <span style={{ color: "#fff", fontSize: 9, fontWeight: 900, lineHeight: 1 }}>✓</span>}
                    </div>
                    <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.4, flex: 1, display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 4 }}>
                      <span>{item.category}</span>
                      <span style={{ fontSize: 11, color: C.textMuted, fontWeight: 500, flexShrink: 0 }}>{item.time}</span>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ paddingTop: 0 }}>
                <button style={{ border: "none", background: "none", color: C.purple, fontSize: 13, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }} onClick={() => setPage("plan")}>
                  View Full Action Plan →
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
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 4 }}>AI Smart Apply Center</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12, lineHeight: 1.4 }}>Find matching jobs and analyze description fit. Your application preparation pipeline.</div>
          {smartApplyQueueLoading && saQueue.length === 0 ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", marginBottom: 12 }}>
              <div style={{ width: 14, height: 14, border: `2px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
              <div style={{ fontSize: 13, color: C.textMuted, minWidth: 0 }}>Loading your Smart Apply queue…</div>
            </div>
          ) : saQueue.length === 0 ? (
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6, marginBottom: 12 }}>No jobs in your Smart Apply queue yet. Find matching jobs to analyze and add to your pipeline.</div>
          ) : (
            <div>
              <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                {[["Ready", saReady, C.green], ["In Queue", saWaiting, C.yellow], ["Applied", saApplied, C.purple]].map(([label, count, color]) => (
                  <div key={label} style={{ flex: 1, background: `${color}12`, borderRadius: 10, padding: "8px 6px", textAlign: "center" }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color }}>{count}</div>
                    <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 600 }}>{label}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
                <div style={{ fontSize: 12, color: saHasResume ? C.green : C.textMuted }}>{saHasResume ? "✓ Tailored resume ready" : "○ Resume not yet tailored"}</div>
                <div style={{ fontSize: 12, color: saHasCover ? C.green : C.textMuted }}>{saHasCover ? "✓ Cover letter ready" : "○ Cover letter not yet generated"}</div>
                {saReady > 0 && <div style={{ fontSize: 12, fontWeight: 700, color: C.green, marginTop: 2 }}>{saReady} job{saReady !== 1 ? "s" : ""} ready to apply now</div>}
              </div>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn variant="secondary" style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => setPage("jobs")}>Find Matching Jobs →</Btn>
            <Btn variant="secondary" style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => setPage("saved")}>View Queue →</Btn>
          </div>
        </Card>

        {/* Opportunity Intelligence */}
        <Card style={{ padding: "16px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 4 }}>Opportunity Intelligence</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 12, lineHeight: 1.4 }}>Best matching opportunities from your saved jobs.</div>
          {saved.length === 0 ? (
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6, marginBottom: 12 }}>Save jobs from Job Search to see AI-ranked opportunities and match scores.</div>
          ) : (
            <div>
              <div style={{ display: "flex", gap: 10, marginBottom: 10, alignItems: "flex-start" }}>
                {avgMatchScore != null && (
                  <div style={{ background: `${avgMatchScore >= 80 ? C.green : avgMatchScore >= 60 ? C.yellow : C.red}12`, borderRadius: 10, padding: "8px 10px", textAlign: "center", minWidth: 68, flexShrink: 0 }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: avgMatchScore >= 80 ? C.green : avgMatchScore >= 60 ? C.yellow : C.red }}>{avgMatchScore}</div>
                    <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 600 }}>Avg Match</div>
                  </div>
                )}
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 3 }}>
                  {highPriorityJobs > 0 && <div style={{ fontSize: 12, color: C.green, fontWeight: 600 }}>{highPriorityJobs} high priority match{highPriorityJobs !== 1 ? "es" : ""} (80+)</div>}
                  {newOpportunities > 0 && <div style={{ fontSize: 12, color: C.blue }}>{newOpportunities} new this week</div>}
                  {salaryData?.results?.demandLevel && <div style={{ fontSize: 12, color: C.textMuted }}>Market demand: <strong>{salaryData.results.demandLevel}</strong></div>}
                  {!avgMatchScore && <div style={{ fontSize: 12, color: C.textMuted }}>{saved.length} saved job{saved.length !== 1 ? "s" : ""}</div>}
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 8 }}>
                {topOpportunities.map((j, i) => (
                  <div key={j.job_id || i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: C.text, padding: "3px 0", borderBottom: `1px solid ${C.border}` }}>
                    <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, marginRight: 8, minWidth: 0 }}>{j.title || j.jobTitle} — {j.company}</span>
                    {j.matchScore != null && <span style={{ fontSize: 11, fontWeight: 700, color: j.matchScore >= 80 ? C.green : j.matchScore >= 60 ? C.yellow : C.red, flexShrink: 0 }}>{j.matchScore}%</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          <Btn variant="secondary" style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => setPage("opportunity")}>View Opportunities →</Btn>
        </Card>
      </div>

      {/* ROW 3: Resume + Job + Interview Intelligence */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 16 }} className="three-col">
        {/* Resume Intelligence */}
        <Card style={{ padding: "16px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 4 }}>{t("dashboard.resumeIntelTitle")}</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10, lineHeight: 1.4 }}>Resume strength and ATS readiness.</div>
          {bestResume ? (
            <div>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 8 }}>
                <ScoreRing score={bestResume.ats_score} size={80} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  {(() => {
                    const s = bestResume.ats_score;
                    const strength = s >= 80 ? "Strong" : s >= 60 ? "Good" : s >= 40 ? "Fair" : "Needs Work";
                    const strengthColor = s >= 80 ? C.green : s >= 60 ? C.yellow : s >= 40 ? "#EA580C" : C.red;
                    const missingCount = (bestResume.keywords_missing || []).length;
                    const topMissing = (bestResume.keywords_missing || []).slice(0, 3).join(", ");
                    const suggestCount = (bestResume.suggestions || []).length;
                    return (
                      <>
                        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 2 }}>Resume Strength</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: strengthColor, marginBottom: 6 }}>{strength}</div>
                        {missingCount > 0 && (
                          <>
                            <div style={{ fontSize: 11, color: C.textMuted }}>Missing Keywords <span style={{ fontWeight: 700, color: "#EA580C" }}>{missingCount}</span></div>
                            {topMissing && <div style={{ fontSize: 10, color: C.textMuted, marginTop: 1, marginBottom: 4 }}>{topMissing}</div>}
                          </>
                        )}
                        {suggestCount > 0 && <div style={{ fontSize: 11, color: C.textMuted }}>AI Suggestions <span style={{ fontWeight: 700, color: C.blue }}>{suggestCount}</span></div>}
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>Resume Health <span style={{ fontWeight: 700, color: strengthColor }}>{strength}</span></div>
                      </>
                    );
                  })()}
                </div>
              </div>
              {bestResume.top_priority && <div style={{ fontSize: 11, color: C.textMid, background: C.bgSoft, borderRadius: 7, padding: "6px 9px", marginBottom: 4, lineHeight: 1.5 }}>⚡ {bestResume.top_priority}</div>}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>{resumeCount > 0 ? "Analyze a resume on the Resume page to see insights here." : t("dashboard.resumeIntelEmpty")}</div>
          )}
          <Btn variant="secondary" style={{ marginTop: 12, padding: "6px 14px", fontSize: 12 }} onClick={() => setPage("resume")}>{t("dashboard.goToResume")}</Btn>
        </Card>

        {/* Job Intelligence */}
        <Card style={{ padding: "16px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 4 }}>{t("dashboard.jobIntelTitle")}</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10, lineHeight: 1.4 }}>Saved jobs and application pipeline summary.</div>
          {saved.length > 0 || totalApps > 0 ? (
            <div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                {[["Saved", saved.length, C.blue], ["Applied", totalApps, C.purple], ["Response", `${responseRate}%`, C.green]].map(([label, val, color]) => (
                  <div key={label} style={{ flex: 1, background: `${color}12`, borderRadius: 8, padding: "6px 4px", textAlign: "center" }}>
                    <div style={{ fontSize: 15, fontWeight: 800, color }}>{val}</div>
                    <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 600 }}>{label}</div>
                  </div>
                ))}
              </div>
              {saved.slice(0, 3).map((j, i) => (
                <div key={j.job_id || i} style={{ fontSize: 12, color: C.text, padding: "3px 0", borderBottom: `1px solid ${C.border}` }}>{j.title || j.jobTitle} — {j.company}</div>
              ))}
              {saved.length > 3 && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>{t("dashboard.moreCount").replace("{n}", saved.length - 3)}</div>}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>{t("dashboard.jobIntelEmpty")}</div>
          )}
          <Btn variant="secondary" style={{ marginTop: 12, padding: "6px 14px", fontSize: 12 }} onClick={() => setPage("jobs")}>{t("dashboard.goToJobSearch")}</Btn>
        </Card>

        {/* Interview Intelligence */}
        <Card style={{ padding: "16px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 4 }}>Interview Intelligence</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10, lineHeight: 1.4 }}>Practice readiness and feedback progress.</div>
          {questionsCount > 0 ? (
            <div>
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 8 }}>
                <ScoreRing score={Math.round((answeredCount / questionsCount) * 100)} size={60} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: C.textMid, marginBottom: 2 }}>{questionsCount} question{questionsCount !== 1 ? "s" : ""} generated</div>
                  <div style={{ fontSize: 12, color: C.textMid }}>{answeredCount} answered</div>
                  {avgFeedbackScore != null && <div style={{ fontSize: 12, color: C.green, fontWeight: 600, marginTop: 2 }}>Avg score: {avgFeedbackScore}/10</div>}
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                <span style={{ color: C.textMid }}>Readiness</span>
                <span style={{ fontWeight: 700, color: C.purple }}>{Math.round((answeredCount / questionsCount) * 100)}%</span>
              </div>
              <PBar val={Math.round((answeredCount / questionsCount) * 100)} color={C.purple} />
            </div>
          ) : (
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>No interview session yet. Generate questions from a job description to start practicing.</div>
          )}
          <Btn variant="secondary" style={{ marginTop: 12, padding: "6px 14px", fontSize: 12 }} onClick={() => setPage("interview")}>Go to Interview Prep →</Btn>
        </Card>
      </div>

      {/* ROW 4: Salary + Career Progress + Networking Intelligence */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 16 }} className="three-col">
        {/* Salary Intelligence */}
        <Card style={{ padding: "16px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 4 }}>{t("dashboard.marketIntelTitle")}</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10, lineHeight: 1.4 }}>Market value and salary benchmarks.</div>
          {salaryData?.results ? (
            <div>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 2 }}>{t("dashboard.medianSalary")}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: C.green, marginBottom: 6 }}>${salaryData.results.salaryRange?.median?.toLocaleString() || "—"}</div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.textMuted, marginBottom: 6 }}>
                <span>Low: <strong style={{ color: C.text }}>${(salaryData.results.salaryRange?.low || 0).toLocaleString()}</strong></span>
                <span>High: <strong style={{ color: C.text }}>${(salaryData.results.salaryRange?.high || 0).toLocaleString()}</strong></span>
              </div>
              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4 }}>{t("dashboard.demandLabel")} <strong style={{ color: C.text }}>{salaryData.results.demandLevel || "—"}</strong></div>
              {salaryData.results.marketOutlook && <div style={{ fontSize: 12, color: C.textMid, lineHeight: 1.5 }}>{salaryData.results.marketOutlook.slice(0, 110)}…</div>}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>{t("dashboard.marketIntelEmpty")}</div>
          )}
          <Btn variant="secondary" style={{ marginTop: 12, padding: "6px 14px", fontSize: 12 }} onClick={() => setPage("salary")}>{t("dashboard.goToSalary")}</Btn>
        </Card>

        {/* Career Progress */}
        <Card style={{ padding: "16px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 10 }}>{t("dashboard.progressTitle")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
            {[
              [t("dashboard.progressProfile"), `${profileComplete}%`, profileComplete, C.purple],
              ["Tracked Jobs",        totalApps,               Math.min(totalApps * 10, 100),               C.blue],
              [t("dashboard.progressApplications"), totalApps, Math.min(totalApps * 10, 100),               C.green],
              [t("dashboard.progressInterviews"), interviews,  Math.min(interviews * 20, 100),              "#EA580C"],
              [t("dashboard.progressOffers"),     offers,      Math.min(offers * 50, 100),                  "#CA8A04"],
              ["Network Contacts",    networkContacts.length,  Math.min(networkContacts.length * 10, 100),  "#0891B2"],
              ["Smart Apply",         saApplied,               Math.min(saApplied * 20, 100),               C.purple],
            ].map(([label, value, pct, color]) => (
              <div key={label}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                  <span style={{ color: C.textMid }}>{label}</span>
                  <span style={{ fontWeight: 700, color }}>{value}</span>
                </div>
                <PBar val={pct} color={color} />
              </div>
            ))}
          </div>
        </Card>

        {/* Networking Intelligence */}
        <Card style={{ padding: "16px 18px" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 4 }}>Networking Intelligence</div>
          <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10, lineHeight: 1.4 }}>Contacts, outreach progress, and follow-ups.</div>
          {networkContacts.length > 0 ? (
            <div>
              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                {[["Contacts", networkContacts.length, C.purple], ["Responded", replied, C.green], ["Follow-up", followUpNeeded, followUpNeeded > 0 ? C.yellow : C.textMuted]].map(([label, val, color]) => (
                  <div key={label} style={{ flex: 1, background: `${color}12`, borderRadius: 8, padding: "6px 4px", textAlign: "center" }}>
                    <div style={{ fontSize: 15, fontWeight: 800, color }}>{val}</div>
                    <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 600 }}>{label}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 2 }}>
                <span style={{ color: C.textMid }}>Response rate</span>
                <span style={{ fontWeight: 700, color: outreachRate >= 50 ? C.green : C.yellow }}>{outreachRate}%</span>
              </div>
              <PBar val={outreachRate} color={outreachRate >= 50 ? C.green : C.yellow} />
              {followUpNeeded > 0 && <div style={{ marginTop: 8, fontSize: 12, color: C.yellow, fontWeight: 600 }}>⚠ {followUpNeeded} contact{followUpNeeded !== 1 ? "s" : ""} waiting for reply</div>}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>No networking contacts yet. Build your network to track outreach and follow-ups.</div>
          )}
          <Btn variant="secondary" style={{ marginTop: 12, padding: "6px 14px", fontSize: 12 }} onClick={() => setPage("network")}>Go to Networking →</Btn>
        </Card>
      </div>

      {/* BOTTOM: AI Chat Assistant */}
      <Card>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>🤖 {t("dashboard.assistantTitle")}</div>
        <div style={{ background: C.bgSoft, borderRadius: 12, padding: 16, minHeight: 180, maxHeight: 320, overflowY: "auto", marginBottom: 14, display: "flex", flexDirection: "column", gap: 10 }}>
          {chatMessages.length === 0 && (
            <div style={{ textAlign: "center", padding: "40px 0", color: C.textMuted, fontSize: 14 }}>
              <div style={{ fontSize: 24, marginBottom: 8 }}>🤖</div>
              {t("dashboard.assistantEmpty")}
            </div>
          )}
          {chatMessages.map((m, i) => (
            <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
              <div style={{ maxWidth: "75%", padding: "10px 14px", borderRadius: 12, background: m.role === "user" ? C.purple : "#fff", color: m.role === "user" ? "#fff" : C.text, fontSize: 14, lineHeight: 1.6, boxShadow: m.role === "ai" ? "0 1px 4px rgba(0,0,0,0.06)" : "none" }}>
                {m.text}
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
function BriefingPage({ profile, applications, savedJobs, setPage }) {
  const { t } = useI18n();
  const { session: interviewSession } = useInterviewSession(profile?.id);
  const { data: salaryData } = useSalaryResearch(profile?.id);
  const [networkContacts] = useNetworkingContacts(profile?.id);

  const [briefing, setBriefing] = useState(() => { try { const c = sessionStorage.getItem("cp_briefing_dash"); if (!c) return null; const p = JSON.parse(c); return (p && !Array.isArray(p) && p.v === 2) ? p : null; } catch { return null; } });
  const [genLoading, setGenLoading] = useState(false);
  const { briefing: savedBriefing, loading: briefingLoading, loadedFor, save: saveBriefing } = useAiBriefing(profile?.id);
  const { logActivity } = useActivityLog(profile?.id);
  const userContext = useUserContext({ profile, applications, savedJobs, interviewSession, salaryData, networkContacts });
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
      const result = await buildBriefingPayload(ctx);
      setBriefing(result);
      try { sessionStorage.setItem("cp_briefing_dash", JSON.stringify(result)); } catch {}
      saveBriefing(result).catch(err => console.error("briefing save failed", err));
      logActivity("Daily briefing regenerated");
      insertNotification(profile?.id, { type: "ai_recommendation", title: "Daily briefing updated", body: "Your personalized career briefing has been regenerated.", linkPage: "briefing" });
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
    { label: "New Matching Jobs", text: b.newMatchingJobs },
    { label: "Highest-Paying Jobs", text: b.highestPayingJobs },
    { label: "Jobs Closing Soon", text: b.jobsClosingSoon },
    { label: "AI Priority Recommendation", text: b.priorityRecommendation },
    { label: "Companies Hiring Now", text: b.companiesHiringNow },
    { label: "New Opportunities", text: b.newOpportunities },
    { label: "Resume Updates", text: b.resumeUpdates },
    { label: "ATS Score Changes", text: b.atsScoreChanges },
    { label: "Interview Invitations", text: b.interviewInvitations },
    { label: "Recruiter Activity", text: b.recruiterActivity },
    { label: "Application Updates", text: b.applicationUpdates },
    { label: "Salary Changes", text: b.salaryChanges },
    { label: "Market Updates", text: b.marketUpdates },
    { label: "Career Insights", text: b.careerInsights },
  ] : [];

  return (
    <div>
      {/* Back navigation */}
      <button onClick={() => setPage("dashboard")} style={{ border: "none", background: "none", color: C.textMuted, fontSize: 13, cursor: "pointer", padding: "0 0 20px 0", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}>
        ← Back to Dashboard
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
            <h1 style={{ fontSize: 22, fontWeight: 800, color: C.text, marginBottom: 4 }}>AI Daily Briefing</h1>
            <p style={{ fontSize: 13, color: C.textMuted }}>Here's what CareerPersona AI accomplished for you today.</p>
          </div>
        </div>
        <Btn variant="secondary" style={{ fontSize: 12, padding: "6px 14px", flexShrink: 0 }} onClick={generate} loading={genLoading}>
          {genLoading ? "Generating…" : "↻ Regenerate"}
        </Btn>
      </div>

      {b?.generatedAt && (
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 24 }}>
          Generated {new Date(b.generatedAt).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
        </div>
      )}

      {/* Loading */}
      {isLoading && (
        <div style={{ textAlign: "center", padding: "60px 0", color: C.textMuted }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>🗞️</div>
          <div style={{ fontSize: 14 }}>Loading your briefing…</div>
        </div>
      )}

      {/* Empty state */}
      {!b && !isLoading && (
        <Card style={{ textAlign: "center", padding: "48px 24px" }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>🗞️</div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>Generate Your Daily Briefing</div>
          <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 28, maxWidth: 420, margin: "0 auto 28px" }}>Get a personalized AI briefing with career insights, job opportunities, and today's priority actions.</div>
          <Btn onClick={generate} loading={genLoading}>{genLoading ? "Generating…" : "✨ Generate Daily Briefing"}</Btn>
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
              <span style={{ fontSize: 12, fontWeight: 700, color: C.purple }}>Personalized AI Summary</span>
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
              <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 14 }}>Daily Highlights</div>
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
            <button onClick={() => setPage("dashboard")} style={{ border: "none", background: "none", color: C.purple, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>← Back to Dashboard</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── FULL ACTION PLAN PAGE ───────────────────────────────────
function PlanPage({ profile, applications, savedJobs, setPage }) {
  const { t } = useI18n();
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
      const result = await buildPlanPayload(ctx);
      console.log("[PlanPage] Generation succeeded");
      setPlan(result);
      try { sessionStorage.setItem("cp_plan_dash", JSON.stringify(result)); } catch {}
      savePlan(result).catch(err => console.error("[PlanPage] save failed", err));
      logActivity("Daily plan regenerated");
      insertNotification(profile?.id, { type: "ai_recommendation", title: "Action plan updated", body: "Today's action plan has been regenerated.", linkPage: "plan" });
    } catch (e) {
      console.error("[PlanPage] Generation failed:", e?.message || e);
      setGenError("Generation failed. Please try again.");
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

  const additionalSections = p ? [
    { id: "followups", label: "Follow-up Reminders", text: p.followUps, page: "tracker" },
    { id: "networking", label: "Networking Tasks", text: p.networking, page: "network" },
    { id: "skills", label: "Skill Recommendations", text: p.skills, page: "resume" },
    { id: "certifications", label: "Certification Recommendations", text: p.certifications, page: "resume" },
    { id: "goals", label: "Career Goals", text: p.careerGoals, page: "profile" },
  ] : [];

  const categoryPageMap = { priorities: null, applications: "jobs", resume: "resume", interview: "interview" };

  const StatusCircle = ({ id, filled }) => (
    <div onClick={() => toggleComplete(id)} style={{ width: 22, height: 22, borderRadius: "50%", border: `2px solid ${filled ? C.green : C.purple}`, background: filled ? C.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: "pointer" }}>
      {filled && <span style={{ color: "#fff", fontSize: 11, fontWeight: 900, lineHeight: 1 }}>✓</span>}
    </div>
  );

  return (
    <div>
      <button onClick={() => setPage("dashboard")} style={{ border: "none", background: "none", color: C.textMuted, fontSize: 13, cursor: "pointer", padding: "0 0 20px 0", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}>
        ← Back to Dashboard
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
            <h1 style={{ fontSize: 22, fontWeight: 800, color: C.text, marginBottom: 4 }}>Today's Action Plan</h1>
            <p style={{ fontSize: 13, color: C.textMuted }}>Your personalized AI career actions for today.</p>
          </div>
        </div>
        <Btn variant="secondary" style={{ fontSize: 12, padding: "6px 14px", flexShrink: 0 }} onClick={generate} loading={genLoading}>
          {genLoading ? "Generating…" : "↻ Regenerate"}
        </Btn>
      </div>

      {p?.generatedAt && (
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 24 }}>
          Generated {new Date(p.generatedAt).toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
        </div>
      )}

      {isLoading && (
        <div style={{ textAlign: "center", padding: "60px 0", color: C.textMuted }}>
          <div style={{ fontSize: 28, marginBottom: 12 }}>📋</div>
          <div style={{ fontSize: 14 }}>{genLoading ? "Generating your action plan…" : "Loading your action plan…"}</div>
        </div>
      )}

      {!p && !isLoading && genError && (
        <Card style={{ textAlign: "center", padding: "32px 24px" }}>
          <div style={{ fontSize: 14, color: C.red, marginBottom: 16 }}>{genError}</div>
          <Btn onClick={generate} loading={genLoading}>↻ Try Again</Btn>
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
                <span style={{ fontSize: 12, fontWeight: 700, color: C.purple }}>AI Productivity Score</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {completedCount > 0 && <span style={{ fontSize: 12, color: C.textMuted }}>{completedCount} of {p.categories.length + additionalSections.length} completed</span>}
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
                        <div style={{ fontSize: 11, fontWeight: 700, color: done ? C.textMuted : C.text, textDecoration: done ? "line-through" : "none" }}>{item.category}</div>
                        <div style={{ fontSize: 11, color: C.textMuted, flexShrink: 0 }}>{item.time}</div>
                      </div>
                      <div style={{ fontSize: 13, color: done ? C.textMuted : C.textMid, lineHeight: 1.6, marginBottom: goPage ? 10 : 0, textDecoration: done ? "line-through" : "none" }}>{item.task}</div>
                      {goPage && (
                        <button onClick={() => setPage(goPage)} style={{ border: "none", background: "none", color: C.purple, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
                          Go to {item.category} →
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
                      <button onClick={() => setPage(goPage)} style={{ border: "none", background: "none", color: C.purple, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
                        Go to {label.split(" ")[0]} →
                      </button>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>

          <div style={{ textAlign: "center", paddingBottom: 8 }}>
            <button onClick={() => setPage("dashboard")} style={{ border: "none", background: "none", color: C.purple, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>← Back to Dashboard</button>
          </div>
        </div>
      )}
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

const RESUME_STEPS = ["Reading your resume…", "Extracting skills & keywords…", "Calculating ATS score…", "Generating AI analysis…", "Building recommendations…"];

function ResumePage({ onSave, onNavigate, profile, applications, savedJobs, resumes, resumesLoading, saveResume, deleteResume, downloadResume, saveAnalysis, updateVersionLabel, analysisHistory, saveHistoryToDb, onResumeLoad }) {
  const { t } = useI18n();
  const [resume, setResume] = useSessionState("cp_resume_text", "");
  const [jobDesc, setJobDesc] = useSessionState("cp_resume_jobdesc", profile?.preferred_job_title ? t("resume.lookingForPosition").replace("{title}", profile.preferred_job_title) : "");
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
  const [loadedResumeId, setLoadedResumeId] = useSessionState("cp_resume_loaded_id", null);
  const [editLabelId, setEditLabelId] = useState(null);
  const [labelValue, setLabelValue] = useState("");
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
  // Tool 8: LinkedIn Optimizer
  const [linkedinOptData, setLinkedinOptData] = useSessionState("cp_resume_linkedin_opt", null);
  const [linkedinOptLoading, setLinkedinOptLoading] = useState(false);
  const [linkedinOptError, setLinkedinOptError] = useState("");
  const [linkedinProfile, setLinkedinProfile] = useSessionState("cp_resume_linkedin_profile", "");
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

  // Close the library Actions dropdown when clicking anywhere outside it.
  useEffect(() => {
    if (!openDropdownId) return;
    const handler = () => setOpenDropdownId(null);
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, [openDropdownId]);

  // Auto-load the most recently saved resume when the workspace is empty.
  // Guards: skip if user deliberately cleared (New Analysis), if workspace already has content,
  // or if resumes are still loading.
  useEffect(() => {
    if (manualReset) return;
    if (resumesLoading || resume.trim() || results || loadedResumeId) return;
    if (!resumes || resumes.length === 0) return;
    const r = resumes[0]; // sorted by last_analyzed_at desc
    if (!r?.content) return;
    setResume(r.content);
    setLoadedResumeId(r.id);
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
      setTab("resume");
    }
  }, [resumes, resumesLoading, manualReset]); // eslint-disable-line react-hooks/exhaustive-deps

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
    if (tab === "insights" && results && !deepInsights && !deepInsightsLoading && resume.trim()) {
      runDeepInsights();
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tool 4: auto-generate cover letter versions when user opens the Cover tab (once per session until reset).
  // Also fires when coverVersionsLoading transitions to false so a finished background call
  // that produced no versions (e.g. silent error) still gets a recovery attempt.
  useEffect(() => {
    if (tab === "cover" && results && !coverVersions && !coverVersionsLoading && resume.trim()) {
      generateCoverVersions();
    }
  }, [tab, coverVersionsLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-run panels when they open for the first time
  useEffect(() => {
    if (activeToolPanel === "benchmark" && resume.trim() && !benchmarkData && !benchmarkLoading) {
      runBenchmark();
    }
    if (activeToolPanel === "jobfit" && resume.trim() && jobDesc.trim() && !jobFitData && !jobFitLoading) {
      runJobFit();
    }
    if (activeToolPanel === "linkedin-opt" && resume.trim() && !linkedinOptData && !linkedinOptLoading) {
      runLinkedinOpt();
    }
  }, [activeToolPanel]); // eslint-disable-line react-hooks/exhaustive-deps

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
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const base64 = ev.target.result.split(',')[1];
          const mediaType = file.type || 'image/jpeg';
          const WORKER_URL = "https://proxy.dawn-voice-2790.workers.dev";
          const res = await fetch(WORKER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
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
  // setLoadedResumeId(id) is async — the closure still sees the old null value.
  const saveHistoryEntry = (parsed, analysisType = 'Initial Analysis', resumeStatus = 'Draft', explicitResumeId = null) => {
    const effectiveResumeId = explicitResumeId ?? loadedResumeId;
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
    if (!resume.trim() || !jobDesc.trim()) { setError(t("resume.bothRequired")); return; }
    setManualReset(false);
    setError(""); setLoading(true); setResults(null); setLoadStep(0);
    const iv = setInterval(() => setLoadStep(s => Math.min(s + 1, 4)), 1800);
    try {
      const ctx = userContext.getContextString({ identity: true });
      const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}You are an expert ATS resume coach. Analyze the resume against the job description and return ONLY a JSON object, no markdown, no explanation:
{"atsScore":<0-100>,"potentialAtsScore":<estimated score after improvements 0-100>,"scoreBreakdown":{"keywordMatch":<0-100>,"formatting":<0-100>,"relevance":<0-100>},"keywordsFound":["<k1>","<k2>","<k3>","<k4>","<k5>","<k6>"],"keywordsMissing":["<m1>","<m2>","<m3>","<m4>","<m5>","<m6>"],"tailoredResume":"<full optimized resume maintaining original structure>","suggestions":["<specific tip 1>","<specific tip 2>","<specific tip 3>","<specific tip 4>","<specific tip 5>"],"coverLetter":"<professional 3 paragraph cover letter>","jobTitle":"<extracted job title>","company":"<company name>"}
RESUME:${resume}
JOB DESCRIPTION:${jobDesc}`, 4000);
      const parsed = JSON.parse(raw);
      setResults(parsed); setTab("resume");
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
{"strengths":["<specific strength 1 that makes this candidate competitive for this role>","<specific strength 2>","<specific strength 3>"],"highPriorityImprovements":["<the single most important improvement that would increase resume quality and ATS score>","<second most important improvement>","<third most important improvement>"],"missingSkills":["<broader skill or qualification this role requires that the resume does not demonstrate — do NOT duplicate ATS keyword suggestions>","<missing skill 2>","<missing skill 3>","<missing skill 4>","<missing skill 5>"],"tailoringOpportunities":["<specific intelligent recommendation to better tailor this resume for this role beyond keyword optimization>","<tailoring tip 2>","<tailoring tip 3>"]}
RESUME:${capturedResume}
JOB DESCRIPTION:${capturedJobDesc}`, 900).then(insightRaw => {
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
        setLoadedResumeId(savedRow.id);
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
      let resumeId = loadedResumeId;
      // When saving an improved (optimized) resume and there's already a loaded resume,
      // always create a new library entry so the original is never silently overwritten.
      const shouldSaveAsNew = isOptimized && loadedResumeId && saveResume;
      if (!resumeId || forceNew || shouldSaveAsNew) {
        const originalName = resumes.find(r => r.id === loadedResumeId)?.name || uploadedFile?.name;
        const name = shouldSaveAsNew
          ? `Optimized${results.jobTitle ? ` — ${results.jobTitle}` : ""}${originalName ? ` (${originalName.replace(/\.[^.]+$/, "")})` : ""}`
          : uploadedFile?.name || (results.jobTitle ? `Resume — ${results.jobTitle}` : t("resume.myResumeFallback"));
        const savedRow = await saveResume(name, resume, null);
        if (savedRow?.id) { resumeId = savedRow.id; setLoadedResumeId(savedRow.id); }
      }
      if (resumeId && saveAnalysis) {
        await saveAnalysis(resumeId, results, isOptimized ? resume : null);
      }
      saveHistoryEntry(results, isOptimized ? 'Resume Improvement' : 'Initial Analysis', isOptimized ? 'Optimized' : 'Draft', resumeId || null);
      setLibrarySaved(true);
    } catch (e) {
      console.error("[SaveToLibrary]", e);
      setLibrarySaveError("Save failed. Please try again.");
    } finally {
      setSavingToLibrary(false);
    }
  };

  const handleLoadResume = (r) => { setResume(r.content || ""); setUploadedFile(null); setLoadedResumeId(r.id); onResumeLoad?.(r.id); };

  const handleGenerateResume = async () => {
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

      const prompt = `You are an expert resume writer. Create a professional, ATS-optimized resume in plain text format.

PROFILE:
${identity}

EMPLOYMENT HISTORY:
${aiForm.employment}

EDUCATION:
${aiForm.education}

SKILLS: ${aiForm.skills}${aiForm.certifications ? `\n\nCERTIFICATIONS: ${aiForm.certifications}` : ""}

INSTRUCTIONS:
Write a complete, polished ATS-friendly resume in plain text. Include: Contact Information, Professional Summary, Work Experience (with bullet points and quantified achievements where possible), Skills, Education${aiForm.certifications ? ", Certifications" : ""}. Use UPPERCASE for section headers. Use action verbs. Return ONLY the resume text — no explanation, no markdown, no preamble.`;

      const generated = await askClaude(prompt, 3000);
      setResume(generated.trim());
      if (jobDesc.trim()) {
        setPendingAutoAnalyze(true);
      }
    } catch (e) {
      console.error("[AIBuilder]", e);
      setAiError("Could not generate resume. Please check your connection and try again.");
    } finally {
      setAiBuilding(false);
    }
  };

  // ── Tool 6: Score Benchmarking ──────────────────────────────────────────────
  const runBenchmark = async () => {
    if (!resume.trim()) return;
    setBenchmarkLoading(true); setBenchmarkError(""); setBenchmarkData(null);
    try {
      const ctx = userContext.getContextString({ identity: true, applications: true });
      const currentScore = results?.atsScore ?? null;
      const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}You are an expert ATS and recruitment analyst. Analyze this resume and return ONLY a JSON object with realistic market benchmark data, no markdown, no explanation:
{"atsScore":${currentScore !== null ? currentScore : "<calculate 0-100>"},"industryAverage":<realistic industry average 52-68>,"topCandidateAverage":<realistic top 25% average 80-92>,"percentile":<what percentile this resume is at 1-99>,"percentileLabel":"<e.g. Top 15%>","keywordCoverage":<0-100>,"formattingScore":<0-100>,"experienceScore":<0-100>,"skillsScore":<0-100>,"educationScore":<0-100>,"overallRanking":"<Below Average/Average/Above Average/Strong/Excellent>","industryLabel":"<inferred industry>","recommendations":["<specific improvement 1>","<specific improvement 2>","<specific improvement 3>"]}
RESUME:${resume}${jobDesc.trim() ? "\nJOB DESCRIPTION:" + jobDesc : ""}`, 2000);
      const parsed = JSON.parse(raw);
      setBenchmarkData(parsed);
      if (profile?.id && saveHistoryToDb) {
        const entry = { resumeName: uploadedFile?.name || resumes.find(r => r.id === loadedResumeId)?.name || 'Resume', atsScore: parsed.atsScore ?? results?.atsScore ?? null, potentialAtsScore: results?.potentialAtsScore ?? null, jobTitle: results?.jobTitle || '', company: validCompany(results?.company) || '', analysisType: 'Score Benchmarking', analysisMode: resumeSource === 'ai' ? 'AI Resume Creator' : 'Uploaded Resume', resumeStatus: 'Benchmarked', resumeHealth: resumeHealthFrom(parsed.atsScore ?? results?.atsScore) };
        saveHistoryToDb(entry, loadedResumeId || null).catch(() => {});
      }
    } catch (e) { console.error("[Benchmark]", e); setBenchmarkError("Benchmarking failed. Please try again."); }
    finally { setBenchmarkLoading(false); }
  };

  // ── Tool 7: Job Fit Analyzer ─────────────────────────────────────────────────
  const runJobFit = async () => {
    if (!resume.trim() || !jobDesc.trim()) return;
    setJobFitLoading(true); setJobFitError(""); setJobFitData(null);
    try {
      const ctx = userContext.getContextString({ identity: true });
      const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}You are an expert recruiter and career coach. Analyze how well this resume matches the job description. Return ONLY a JSON object, no markdown, no explanation:
{"overallMatch":<0-100>,"matchLabel":"<Strong Match/Good Match/Moderate Match/Weak Match>","requiredSkillsMatch":[{"skill":"<skill>","found":<true or false>,"evidence":"<brief quote from resume or null>"}],"preferredSkillsMatch":[{"skill":"<skill>","found":<true or false>}],"missingSkills":["<skill>","<skill>","<skill>"],"keywordMatchScore":<0-100>,"experienceMatch":{"score":<0-100>,"status":"<Over-qualified/Well-matched/Under-qualified>","detail":"<one sentence>"},"educationMatch":{"score":<0-100>,"status":"<Exceeds/Meets/Below requirement>","detail":"<one sentence>"},"seniorityMatch":{"score":<0-100>,"status":"<Well-matched/Junior for role/Senior for role>","detail":"<one sentence>"},"applicationReadiness":"<Ready to Apply/Almost Ready/Needs Work>","topRecommendations":["<action 1>","<action 2>","<action 3>"],"coverLetterTip":"<one specific cover letter tip for this role>"}
RESUME:${resume}
JOB DESCRIPTION:${jobDesc}`, 2500);
      const parsed = JSON.parse(raw);
      setJobFitData(parsed);
      if (profile?.id && saveHistoryToDb) {
        const entry = { resumeName: uploadedFile?.name || resumes.find(r => r.id === loadedResumeId)?.name || 'Resume', atsScore: results?.atsScore ?? null, potentialAtsScore: results?.potentialAtsScore ?? null, jobTitle: results?.jobTitle || '', company: validCompany(results?.company) || '', analysisType: 'Job Fit Analysis', analysisMode: resumeSource === 'ai' ? 'AI Resume Creator' : 'Uploaded Resume', resumeStatus: 'Analyzed', resumeHealth: resumeHealthFrom(results?.atsScore) };
        saveHistoryToDb(entry, loadedResumeId || null).catch(() => {});
      }
    } catch (e) { console.error("[JobFit]", e); setJobFitError("Job fit analysis failed. Please try again."); }
    finally { setJobFitLoading(false); }
  };

  // ── Tool 8: LinkedIn Optimizer ───────────────────────────────────────────────
  const runLinkedinOpt = async () => {
    if (!resume.trim()) return;
    setLinkedinOptLoading(true); setLinkedinOptError(""); setLinkedinOptData(null);
    try {
      const ctx = userContext.getContextString({ identity: true });
      const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}You are a LinkedIn profile expert and personal branding coach. ${linkedinProfile.trim() ? "Analyze and optimize this LinkedIn profile." : "Generate LinkedIn profile content from this resume."} Return ONLY a JSON object, no markdown, no explanation:
{"headline":"<optimized LinkedIn headline max 120 chars>","aboutSection":"<optimized About section 200-250 words, first person, engaging, keyword-rich>","experienceOptimizations":[{"company":"<company name>","title":"<job title>","optimizedBullets":["<impactful bullet 1>","<impactful bullet 2>","<impactful bullet 3>"]}],"topSkillsToAdd":["<skill 1>","<skill 2>","<skill 3>","<skill 4>","<skill 5>","<skill 6>","<skill 7>","<skill 8>"],"keywordsToFeature":["<keyword 1>","<keyword 2>","<keyword 3>","<keyword 4>","<keyword 5>","<keyword 6>"],"recruiterVisibilityTips":["<tip 1>","<tip 2>","<tip 3>"],"atsAlignmentScore":<0-100>,"profileCompleteness":<0-100>,"headlineScore":<0-100>}
RESUME:${resume}${linkedinProfile.trim() ? "\n\nCURRENT LINKEDIN PROFILE:\n" + linkedinProfile : ""}${jobDesc.trim() ? "\nTARGET JOB:\n" + jobDesc : ""}`, 3000);
      const parsed = JSON.parse(raw);
      setLinkedinOptData(parsed);
      if (profile?.id && saveHistoryToDb) {
        const entry = { resumeName: uploadedFile?.name || resumes.find(r => r.id === loadedResumeId)?.name || 'Resume', atsScore: results?.atsScore ?? null, potentialAtsScore: null, jobTitle: results?.jobTitle || '', company: '', analysisType: 'LinkedIn Optimization', analysisMode: resumeSource === 'ai' ? 'AI Resume Creator' : 'Uploaded Resume', resumeStatus: 'LinkedIn Optimized', resumeHealth: resumeHealthFrom(results?.atsScore) };
        saveHistoryToDb(entry, loadedResumeId || null).catch(() => {});
      }
    } catch (e) { console.error("[LinkedInOpt]", e); setLinkedinOptError("LinkedIn optimization failed. Please try again."); }
    finally { setLinkedinOptLoading(false); }
  };

  // ── Tool 4: Cover Letter Multiple Versions ───────────────────────────────────
  // resumeOverride: explicit text for background regeneration after resume edits.
  // Background calls suppress UI errors so nothing appears on the Cover tab unexpectedly.
  const generateCoverVersions = async (resumeOverride = null) => {
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
BASE COVER LETTER:${results?.coverLetter || ""}`, 4000);
      const parsed = JSON.parse(raw);
      setCoverVersions(parsed);
    } catch (e) { console.error("[CoverVersions]", e); if (!isBackground) setCoverVersionsError("Could not generate versions. Please try again."); }
    finally { setCoverVersionsLoading(false); }
  };

  // ── Tool 3: Deep Resume Insights ─────────────────────────────────────────────
  const runDeepInsights = async () => {
    if (!resume.trim()) return;
    setDeepInsightsLoading(true); setDeepInsightsError("");
    try {
      const ctx = userContext.getContextString({ identity: true });
      const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}You are an expert resume quality analyst. Perform deep analysis of this resume. Return ONLY a JSON object, no markdown, no explanation:
{"grammarScore":<0-100>,"readabilityScore":<0-100>,"formattingScore":<0-100>,"keywordDensity":<0-100>,"actionVerbScore":<0-100>,"overallQualityScore":<0-100>,"issues":[{"category":"<Grammar/Formatting/Readability/ATS/Action Verbs/Structure>","problem":"<specific problem found>","reason":"<why this hurts the resume>","fix":"<specific actionable fix>","severity":"<high/medium/low>"}],"weakBullets":[{"original":"<weak bullet from resume>","improved":"<stronger rewritten version>"}],"weakActionVerbs":[{"original":"<weak verb>","stronger":"<powerful action verb>"}],"missingSections":["<missing section name>"],"resumeLengthStatus":"<Optimal/Too Short/Too Long>","contactInfoStatus":"<Complete/Incomplete>","sectionOrderIssue":"<description or null>"}
RESUME:${resume}${jobDesc.trim() ? "\nJOB DESCRIPTION:" + jobDesc : ""}`, 2500);
      const parsed = JSON.parse(raw);
      setDeepInsights(parsed);
      if (profile?.id && saveHistoryToDb) {
        const entry = { resumeName: uploadedFile?.name || resumes.find(r => r.id === loadedResumeId)?.name || 'Resume', atsScore: results?.atsScore ?? null, potentialAtsScore: results?.potentialAtsScore ?? null, jobTitle: results?.jobTitle || '', company: validCompany(results?.company) || '', analysisType: 'Deep Insights Analysis', analysisMode: resumeSource === 'ai' ? 'AI Resume Creator' : 'Uploaded Resume', resumeStatus: 'Analyzed', resumeHealth: resumeHealthFrom(results?.atsScore) };
        saveHistoryToDb(entry, loadedResumeId || null).catch(() => {});
      }
    } catch (e) { console.error("[DeepInsights]", e); setDeepInsightsError("Deep analysis failed. Please try again."); }
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
    setApplyingIssueFix(issue.problem);
    try {
      const fixed = await askClaude(`You are a professional resume editor. Apply exactly this fix to the resume: "${issue.fix}". Return ONLY the complete improved resume text — no explanation, no preamble, no markdown.\n\nRESUME:\n${resume}`, 3000);
      setResume(fixed.trim());
      setDeepInsights(prev => prev ? { ...prev, issues: prev.issues?.filter(i => i.problem !== issue.problem) } : prev);
    } catch (e) { console.error("[IssueFix]", e); }
    finally { setApplyingIssueFix(null); }
  };

  const applyAllDeepFixes = async () => {
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
        const fixed = await askClaude(`You are a professional resume editor. Apply ALL of the following improvements to the resume:\n${fixList}\n\nReturn ONLY the complete improved resume text — no explanation, no preamble, no markdown.\n\nRESUME:\n${current}`, 3500);
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
    if (!selectedKeywords.length) return;
    setImproving(true); setImproveError(""); setLibrarySaved(false); setLibrarySaveError("");
    const kwList = selectedKeywords.join(", ");
    const oldAts = results?.atsScore ?? null;
    const oldBreakdown = results?.scoreBreakdown ?? null;
    try {
      setImproveStep("CareerPersona AI is improving your resume…");
      const stepTimer = setTimeout(() => setImproveStep("Adding selected keywords naturally…"), 7000);
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
      const improved = await askClaude(improvePrompt, 3500);
      clearTimeout(stepTimer);
      const improvedText = improved.trim();
      const addedCount = selectedKeywords.length;
      const addedKws = [...selectedKeywords]; // save before clearing for post-processing
      setResume(improvedText);
      setSelectedKeywords([]);
      if (jobDesc.trim()) {
        setImproveStep("Recalculating your ATS score…");
        const ctx = userContext.getContextString({ identity: true });
        const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}You are an expert ATS resume coach. Analyze the resume against the job description and return ONLY a JSON object, no markdown, no explanation.
Note: This resume was just improved by naturally incorporating the following keywords: ${kwList}. Score it accurately and fairly based on the current content — the ATS score should reflect the improvement.
{"atsScore":<0-100>,"potentialAtsScore":<estimated score after improvements 0-100>,"scoreBreakdown":{"keywordMatch":<0-100>,"formatting":<0-100>,"relevance":<0-100>},"keywordsFound":["<k1>","<k2>","<k3>","<k4>","<k5>","<k6>"],"keywordsMissing":["<m1>","<m2>","<m3>","<m4>","<m5>","<m6>"],"tailoredResume":"<full optimized resume maintaining original structure>","suggestions":["<specific tip 1>","<specific tip 2>","<specific tip 3>","<specific tip 4>","<specific tip 5>"],"coverLetter":"<professional 3 paragraph cover letter>","jobTitle":"<extracted job title>","company":"<company name>"}
RESUME:${improvedText}
JOB DESCRIPTION:${jobDesc}`, 4000);
        setImproveStep("Refreshing Resume Intelligence…");
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
    setLoadedResumeId(r.id);
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
  const hubHealthLabel = (s) => s == null ? null : s >= 90 ? "Excellent" : s >= 80 ? "Very Good" : s >= 70 ? "Good" : s >= 60 ? "Needs Improvement" : "Poor";

  const newAnalysisReset = () => {
    setResults(null); setResume(""); setJobDesc(""); setLoadedResumeId(null);
    setSelectedKeywords([]); setMasterMissingKws([]);
    setIsOptimized(false); setResultsInsights(null); setInsightsLoading(false);
    setImproveStats(null); setInsightsSectionExpanded({}); setShowAllHistory(false);
    setLibrarySaved(false); setLibrarySaveError("");
    setEditingResumeName(null);
    setBenchmarkData(null); setJobFitData(null); setLinkedinOptData(null);
    setCoverVersions(null); setDeepInsights(null);
    setLinkedinProfile(""); setActiveCoverVersion("professional");
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
                  <span style={{ fontSize: 12, fontWeight: 700, color: resumeSource === "upload" ? C.purple : C.textMid }}>{extracting ? t("resume.extracting") : "Upload Resume"}</span>
                </div>
                <div onClick={() => setResumeSource("ai")} style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 9, cursor: "pointer", border: `1.5px solid ${resumeSource === "ai" ? C.purple : C.border}`, background: resumeSource === "ai" ? C.purpleLight : "transparent" }}>
                  <span style={{ fontSize: 15 }}>✨</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: resumeSource === "ai" ? C.purple : C.textMid }}>Create with AI</span>
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
              {resumeSource === "ai" && !resume.trim() && (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ background: C.purpleLight, border: `1px solid ${C.purple}20`, borderRadius: 9, padding: "10px 14px" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.purple, marginBottom: 6 }}>Pre-filled from your profile</div>
                    {(profile?.full_name || profile?.email_address || profile?.job_title) ? (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", fontSize: 11, color: C.textMid }}>
                        {profile?.full_name && <span style={{ whiteSpace: "nowrap" }}>👤 {profile.full_name}</span>}
                        {profile?.email_address && <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: "100%" }}>✉️ {profile.email_address}</span>}
                        {profile?.phone && <span style={{ whiteSpace: "nowrap" }}>📞 {profile.phone}</span>}
                        {profile?.location && <span style={{ whiteSpace: "nowrap" }}>📍 {profile.location}</span>}
                        {profile?.job_title && <span style={{ whiteSpace: "nowrap" }}>💼 {profile.job_title}</span>}
                        {profile?.preferred_job_title && <span style={{ whiteSpace: "nowrap" }}>🎯 {profile.preferred_job_title}</span>}
                        {profile?.years_experience && <span style={{ whiteSpace: "nowrap" }}>⏱️ {profile.years_experience}yrs exp</span>}
                        {profile?.work_type && <span style={{ whiteSpace: "nowrap" }}>🏢 {profile.work_type}</span>}
                      </div>
                    ) : (
                      <div style={{ fontSize: 11, color: "#CA8A04" }}>⚠️ Complete your profile for better results. <span style={{ cursor: "pointer", textDecoration: "underline", color: C.purple }} onClick={() => onNavigate?.("profile")}>Go to Profile →</span></div>
                    )}
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: C.textMid, marginBottom: 4 }}>Employment History <span style={{ color: C.red }}>*</span></div>
                    <textarea value={aiForm.employment} onChange={e => setAiForm(f => ({ ...f, employment: e.target.value }))} placeholder={"e.g. Software Engineer at Acme Corp (2021–2024)\n• Led migration to React — reduced load time by 40%\n• Built reporting dashboard used by 50k users"} style={{ width: "100%", minHeight: 90, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 13, lineHeight: 1.7, padding: "10px 12px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: C.textMid, marginBottom: 4 }}>Education <span style={{ color: C.red }}>*</span></div>
                    <textarea value={aiForm.education} onChange={e => setAiForm(f => ({ ...f, education: e.target.value }))} placeholder={"e.g. B.S. Computer Science, MIT, 2019"} style={{ width: "100%", minHeight: 55, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 13, lineHeight: 1.7, padding: "10px 12px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: C.textMid, marginBottom: 4 }}>Skills <span style={{ color: C.red }}>*</span></div>
                    <input value={aiForm.skills} onChange={e => setAiForm(f => ({ ...f, skills: e.target.value }))} placeholder="React, TypeScript, Python, SQL, AWS, Leadership..." style={{ width: "100%", background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 13, padding: "8px 12px", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
                  </div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: C.textMid, marginBottom: 4 }}>Certifications <span style={{ fontSize: 10, fontWeight: 400, color: C.textMuted }}>(optional)</span></div>
                    <input value={aiForm.certifications} onChange={e => setAiForm(f => ({ ...f, certifications: e.target.value }))} placeholder="AWS Solutions Architect, PMP, Google Analytics..." style={{ width: "100%", background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 13, padding: "8px 12px", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
                  </div>
                  {aiError && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: "8px 12px", color: C.red, fontSize: 12 }}>{aiError}</div>}
                  <Btn onClick={handleGenerateResume} loading={aiBuilding} disabled={!aiForm.employment.trim() || !aiForm.education.trim() || !aiForm.skills.trim()} style={{ width: "100%", padding: "11px", fontSize: 14 }}>
                    {aiBuilding ? "Generating your resume…" : "✨ Generate Resume with AI"}
                  </Btn>
                  {jobDesc.trim() && !aiBuilding && (
                    <div style={{ fontSize: 11, color: C.purple, fontWeight: 600, textAlign: "center" }}>⚡ Will auto-analyze against your job description</div>
                  )}
                </div>
              )}

              {/* AI Builder: generated resume (editable textarea) */}
              {resumeSource === "ai" && resume.trim() && (
                <>
                  <div style={{ fontSize: 11, color: C.green, fontWeight: 600, marginBottom: 8 }}>✓ Resume generated — review and edit as needed</div>
                  <textarea style={{ flex: 1, width: "100%", minHeight: 200, background: "#fff", border: `1.5px solid ${C.green}40`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.8, padding: "14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} value={resume} onChange={e => setResume(e.target.value)} />
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
                    <div style={{ fontSize: 11, color: C.textMuted }}>{resume.split(/\s+/).filter(Boolean).length} words</div>
                    <Btn variant="ghost" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => { setResume(""); setAiForm({ employment: "", education: "", skills: "", certifications: "" }); }}>← Rebuild</Btn>
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
          {error && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 14, color: C.red, fontSize: 13, marginBottom: 16 }}>{error}</div>}
          <div className="resume-action-bar" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, maxWidth: 600, margin: "0 auto", width: "100%" }}>
            <Btn variant="secondary" loading={savingResume} disabled={!resume.trim() || !profile?.id} onClick={handleSaveResume} style={{ width: "100%", padding: "12px 16px", fontSize: 14 }}>{resumeSaved ? "✓ Saved" : savingResume ? t("resume.saving") : "💾 Save Resume"}</Btn>
            <Btn onClick={analyze} loading={loading} style={{ width: "100%", padding: "12px 16px", fontSize: 14 }}>{loading ? t("resume.analyzing") : t("resume.analyzeAndTailor")}</Btn>
            <Btn variant="secondary" disabled={loading} onClick={() => { setResume(SAMPLE_RESUME); setJobDesc(SAMPLE_JOB); }} style={{ width: "100%", padding: "12px 16px", fontSize: 14 }}>{t("resume.trySample")}</Btn>
          </div>
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
          {loading && <Spinner steps={RESUME_STEPS} currentStep={loadStep} />}
        </>
      )}

      {/* RESUME HUB: returning user or active analysis */}
      {!isFirstTime && (
        <div>
          {!results && (
            <div style={{ marginBottom: 14 }}>
              <h1 style={{ fontSize: 24, fontWeight: 800, color: C.text, marginBottom: 4 }}>Resume Hub</h1>
              <p style={{ fontSize: 14, color: C.textMuted }}>Your resume workspace, history, and AI tools — all in one place.</p>
            </div>
          )}

          {/* SECTION 1 — Resume Library: always visible when resumes exist */}
          {resumes.length > 0 && (
            <Card style={{ marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 12 }}>📁 Resume Library</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {resumes.slice(0, 6).map(r => {
                  const hl = hubHealthLabel(r.ats_score);
                  const hc = hubHealthColor(r.ats_score);
                  const isLoaded = loadedResumeId === r.id;
                  const isEditing = editingResumeName === r.name && isLoaded;
                  return (
                    <div key={r.id} className="resume-lib-item" style={{ padding: "10px 14px", background: C.bgSoft, border: `1.5px solid ${C.border}`, borderLeft: isLoaded ? `3px solid ${C.purple}` : `3px solid transparent`, borderRadius: 10, WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        {/* Circular selection toggle */}
                        <button
                          onClick={() => {
                            if (isLoaded) {
                              setResume(""); setLoadedResumeId(null); setResults(null);
                              setResumeSource("upload"); setLibrarySaved(false); setLibrarySaveError("");
                              setIsOptimized(false); setImproveStats(null); setSelectedKeywords([]); setResultsInsights(null);
                            } else {
                              setResume(r.content || ""); setLoadedResumeId(r.id);
                              setResumeSource("upload"); setLibrarySaved(false); setLibrarySaveError("");
                              setIsOptimized(false); setImproveStats(null); setSelectedKeywords([]); setResultsInsights(null);
                              if (r.ats_score != null) {
                                setResults({ atsScore: r.ats_score, potentialAtsScore: r.potential_ats_score || Math.min(r.ats_score + 20, 98), scoreBreakdown: r.score_breakdown || null, keywordsFound: r.keywords_found || [], keywordsMissing: r.keywords_missing || [], tailoredResume: r.content || "", suggestions: r.suggestions || [], coverLetter: "", jobTitle: "", company: "" });
                                setMasterMissingKws(r.keywords_missing || []); setTab("resume");
                              } else { setResults(null); }
                            }
                          }}
                          style={{ width: 22, height: 22, minWidth: 22, borderRadius: "50%", border: `2px solid ${isLoaded ? C.green : C.border}`, padding: 0, cursor: "pointer", flexShrink: 0, background: isLoaded ? C.green : "transparent", display: "flex", alignItems: "center", justifyContent: "center", outline: "none", fontFamily: "inherit", WebkitTapHighlightColor: "transparent", transition: "background 0.15s, border-color 0.15s" }}
                          aria-label={isLoaded ? "Deselect resume" : "Select resume"}
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
                          >Actions ▾</button>
                          {openDropdownId === r.id && (
                            <div style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 300, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 10, boxShadow: "0 6px 24px rgba(0,0,0,0.13)", minWidth: 186, padding: "4px 0", animation: "summaryEntrance 0.12s ease-out" }}>
                              {[
                                { icon: "📄", label: "Download PDF",  action: () => downloadPDF(r.content, r.name.replace(/\.[^.]+$/, "")) },
                                { icon: "📝", label: "Download DOCX", action: () => downloadDOCX(r.content, r.name.replace(/\.[^.]+$/, "")) },
                                { icon: "✏️", label: "Edit Resume",   action: () => handleEditResume(r) },
                                { icon: "🗑️", label: "Delete Resume", action: () => handleDeleteResume(r), danger: true },
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
                        {isLoaded && !isEditing && <span style={{ fontSize: 10, fontWeight: 700, color: C.green, background: C.greenLight, borderRadius: 6, padding: "2px 7px" }}>✓ Loaded</span>}
                        {isEditing && <span style={{ fontSize: 10, fontWeight: 700, color: C.purple, background: C.purpleLight, borderRadius: 6, padding: "2px 7px" }}>✏️ Editing</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* SECTION 2 — Resume Workspace */}
          <div id="resume-workspace">
            {!results && !loading && workspaceInputsJSX}
            {loading && <Spinner steps={RESUME_STEPS} currentStep={loadStep} />}
          </div>
          {/* SECTION 3 — Resume Analysis */}
          {results && (
            <div id="resume-analysis-section" style={{ marginBottom: 16 }}>
              <Card style={{ marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>{t("resume.analysisComplete")}</div>
                    {results.jobTitle && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{results.jobTitle}{validCompany(results.company) ? ` at ${results.company}` : ""}</div>}
                    {editingResumeName && <div style={{ fontSize: 11, color: C.purple, fontWeight: 700, marginTop: 2 }}>✏️ Editing: {editingResumeName}</div>}
                  </div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
                    <Btn onClick={handleSaveToLibrary} disabled={improving || savingToLibrary || !profile?.id} loading={savingToLibrary} style={{ fontSize: 13 }}>
                      {librarySaved ? "✓ Saved to Library" : isOptimized ? "💾 Save Optimized Resume" : "💾 Save to Resume Library"}
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
                <div style={{ fontSize: 13, fontWeight: 700, color: C.purple }}>{improveStep || "Improving your resume…"}</div>
                <div style={{ fontSize: 11, color: C.textMid, marginTop: 2 }}>Please wait while CareerPersona AI processes your changes</div>
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
                    <span style={{ fontSize: 16, fontWeight: 800, color: C.green }}>{delta >= 0 ? `+${delta}` : delta} ATS Points</span>
                    <span style={{ fontSize: 12, color: C.textMid, marginLeft: 8 }}>Resume optimized successfully</span>
                  </div>
                </div>
                <div className="improve-summary-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
                  {[
                    { label: "ATS Score", value: `${improveStats.oldAts} → ${improveStats.newAts}`, sub: `${delta >= 0 ? "+" : ""}${delta} pts`, subColor: delta >= 0 ? C.green : C.red },
                    { label: "Keywords Added", value: improveStats.addedCount, sub: "incorporated", subColor: C.purple },
                    { label: "Remaining Improvements", value: remaining, sub: remaining === 1 ? "opportunity" : "opportunities", subColor: remaining > 0 ? C.yellow : C.green },
                    { label: "Resume Health", value: health || "—", sub: `${improveStats.newAts}% ATS`, subColor: healthColor },
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
                <div style={{ fontSize: 13, fontWeight: 700, color: C.green }}>All selected AI improvements have been applied.</div>
                <div style={{ fontSize: 12, color: C.textMid, marginTop: 2 }}>Your optimized resume is ready to save. Click <strong>Save Optimized Resume</strong> above to preserve this version.</div>
              </div>
            </div>
          )}
          {librarySaved && isOptimized && (
            <div style={{ background: `linear-gradient(135deg,${C.purple},${C.purpleMid})`, borderRadius: 10, padding: "10px 18px", marginBottom: 16, textAlign: "center", boxShadow: `0 4px 16px ${C.purple}40`, animation: "summaryEntrance 0.3s ease-out" }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", marginBottom: 3 }}>✅ Optimized Resume Saved Successfully!</div>
              <div style={{ fontSize: 13, fontWeight: 400, color: "#fff", lineHeight: 1.5 }}>Your optimized resume has been saved to your Resume Library. Click &ldquo;New Analysis&rdquo; to optimize another resume or tailor your resume for a different job.</div>
            </div>
          )}
          {librarySaved && !isOptimized && (
            <div style={{ background: C.greenLight, border: `1.5px solid ${C.green}35`, borderRadius: 10, padding: "12px 16px", marginBottom: 16, animation: "summaryEntrance 0.3s ease-out" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 16 }}>✅</span>
                <span style={{ fontSize: 13, fontWeight: 700, color: C.green }}>Saved to Resume Library.</span>
              </div>
              <div style={{ fontSize: 12, color: C.textMuted }}>Resume Library, Resume Intelligence, and Analysis History updated.</div>
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
              <div style={{ textAlign: "center" }}>
                <ScoreRing score={animatedAts ?? results.atsScore} size={90} />
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6, fontWeight: 600 }}>{t("resume.currentAtsScore")}</div>
                {!improveStats && analysisHistory?.length >= 2 && analysisHistory[1]?.atsScore != null && (
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>prev. {analysisHistory[1].atsScore}%</div>
                )}
              </div>
              <div style={{ fontSize: 28, color: C.textMuted }}>→</div>
              <div style={{ textAlign: "center" }}>
                <div style={{ width: 90, height: 90, border: `7px solid ${C.green}`, borderRadius: "50%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                  <span style={{ fontSize: 24, fontWeight: 800, color: C.green }}>{results.potentialAtsScore || Math.min(results.atsScore + 20, 98)}+</span>
                  <span style={{ fontSize: 11, color: C.textMuted }}>/100</span>
                </div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6, fontWeight: 600 }}>{t("resume.potentialAtsScore")}</div>
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
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }} className="two-col">
            <div style={{ background: C.greenLight, border: `1px solid ${C.green}25`, borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 12, color: C.green, fontWeight: 700, marginBottom: 10 }}>{t("resume.keywordsFound")}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{results.keywordsFound?.map(k => <Badge key={k} color={C.green}>{k}</Badge>)}</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {isOptimized ? (
                <div style={{ background: C.greenLight, border: `1px solid ${C.green}25`, borderRadius: 12, padding: 16 }}>
                  <div style={{ fontSize: 13, color: C.green, fontWeight: 700, marginBottom: 10 }}>🎉 Resume Successfully Optimized</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3, fontSize: 11 }}>
                    <div style={{ color: C.green }}>✅ ATS score updated</div>
                    <div style={{ color: C.green }}>✅ Resume tailored for this job</div>
                    <div style={{ color: C.green }}>✅ Missing keywords successfully added</div>
                    <div style={{ color: C.green }}>✅ Ready to apply</div>
                    <div style={{ color: C.textMid }}>✅ Use "New Analysis" to optimize for another job or updated resume</div>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ background: C.redLight, border: `1px solid ${C.red}25`, borderRadius: 12, padding: 16 }}>
                    <div style={{ fontSize: 12, color: C.red, fontWeight: 700, marginBottom: 6 }}>{t("resume.keywordsMissing")}</div>
                    <div style={{ fontSize: 11, color: C.textMid, marginBottom: 8, lineHeight: 1.5 }}>⚡ AI pre-selected all {results.keywordsMissing?.length} missing keywords. Deselect any that don't apply to your real experience.</div>
                    <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                      <button onClick={() => setSelectedKeywords(results.keywordsMissing || [])} style={{ fontSize: 10, padding: "3px 9px", borderRadius: 6, border: `1px solid ${C.purple}`, background: C.purpleLight, color: C.purple, cursor: "pointer", fontWeight: 700, fontFamily: "inherit" }}>Select All</button>
                      <button onClick={() => setSelectedKeywords([])} style={{ fontSize: 10, padding: "3px 9px", borderRadius: 6, border: `1px solid ${C.border}`, background: "#fff", color: C.textMuted, cursor: "pointer", fontWeight: 600, fontFamily: "inherit" }}>Deselect All</button>
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
                  {results.keywordsMissing?.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {improveError && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: "8px 12px", color: C.red, fontSize: 12 }}>{improveError}</div>}
                      <Btn onClick={handleImproveResume} loading={improving} disabled={!selectedKeywords.length || improving || improvedBtnDone} style={{ width: "100%", ...(improvedBtnDone ? { background: C.green } : {}) }}>
                        {improving ? "Improving your resume…" : improvedBtnDone ? "✅ Resume Improved" : selectedKeywords.length ? `⚡ Improve My Resume (${selectedKeywords.length} keyword${selectedKeywords.length > 1 ? "s" : ""} selected)` : "⚡ Improve My Resume"}
                      </Btn>
                      {!selectedKeywords.length && <div style={{ fontSize: 11, color: C.textMuted }}>Select missing keywords above to enable</div>}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {isOptimized && improveStats && !improving && (
            <div style={{ background: `linear-gradient(135deg,${C.purple},${C.purpleMid})`, borderRadius: 10, padding: "10px 18px", marginBottom: 16, textAlign: "center", boxShadow: `0 4px 16px ${C.purple}40`, animation: "summaryEntrance 0.3s ease-out" }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: "#fff", marginBottom: 3 }}>✅ Resume Optimization Complete!</div>
              <div style={{ fontSize: 13, fontWeight: 400, color: "#fff", lineHeight: 1.5 }}>Click the &ldquo;Insights&rdquo; tab below to review additional AI recommendations before saving your optimized resume.</div>
            </div>
          )}
          {/* Tabs */}
          <div style={{ display: "flex", gap: 3, background: C.bgSoft, borderRadius: 10, padding: 3, marginBottom: 16 }}>
            {[["resume", t("resume.tabResume")],["suggestions", t("resume.tabSuggestions")],["cover", t("resume.tabCover")],["insights", "Insights"]].map(([id, lbl]) => (
              <Btn key={id} variant="ghost" style={{ flex: 1, padding: "10px", borderRadius: 7, border: "none", background: tab === id ? "#fff" : "transparent", color: tab === id ? C.purple : C.textMuted, fontSize: 13, fontWeight: tab === id ? 700 : 500, boxShadow: tab === id ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }} onClick={() => setTab(id)}>{lbl}</Btn>
            ))}
          </div>

          {tab === "resume" && (
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>
                {isOptimized ? "Your Optimized Resume" : "Optimized Resume Preview"}
              </div>
              <div id="resume-editor-preview" className={editorHighlight ? "editor-highlight-active" : ""}>
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
                  <Btn variant="secondary" onClick={() => setEditingPreview(e => !e)} style={{ fontSize: 12, padding: "6px 14px", touchAction: "manipulation", color: C.purple, background: C.purpleLight, border: `1px solid ${C.purple}` }}>👁 Preview</Btn>
                ) : (
                  <Btn variant="secondary" onClick={() => setEditingPreview(e => !e)} style={{ fontSize: 12, padding: "6px 14px", touchAction: "manipulation" }}>✏️ Edit</Btn>
                )}
                <Btn variant="secondary" onClick={() => downloadPDF(isOptimized ? resume : results.tailoredResume, isOptimized ? "optimized-resume" : "tailored-resume")} style={{ fontSize: 12, padding: "6px 14px" }}>📄 Download PDF</Btn>
                <Btn variant="secondary" onClick={() => downloadDOCX(isOptimized ? resume : results.tailoredResume, isOptimized ? "optimized-resume" : "tailored-resume")} style={{ fontSize: 12, padding: "6px 14px" }}>📝 Download DOCX</Btn>
                <CopyBtn text={resumeDocToHTML(parseResumeDoc(isOptimized ? resume : results.tailoredResume), true)} label="📋 Copy" variant="secondary" />
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
          {tab === "cover" && (() => {
            const currentCoverText = editingCoverLetter ? editedCoverText : (coverVersions?.[activeCoverVersion] || results.coverLetter);
            return (
            <div>
              {/* Version selector + controls */}
              <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
                {[["professional","Professional","★"],["friendly","Friendly",null],["executive","Executive",null],["ats","ATS Optimized",null]].map(([v, lbl, badge]) => (
                  <button key={v} onClick={() => { setActiveCoverVersion(v); setEditingCoverLetter(false); setEditedCoverText(""); }}
                    disabled={!coverVersions}
                    style={{ padding: "5px 12px", borderRadius: 8, border: `1.5px solid ${activeCoverVersion === v && coverVersions ? C.purple : C.border}`, background: activeCoverVersion === v && coverVersions ? C.purpleLight : "#fff", color: activeCoverVersion === v && coverVersions ? C.purple : C.textMuted, fontSize: 11, fontWeight: activeCoverVersion === v ? 700 : 500, cursor: coverVersions ? "pointer" : "default", fontFamily: "inherit", opacity: coverVersions ? 1 : 0.5, display: "flex", alignItems: "center", gap: 4 }}>
                    {lbl}{badge && <span style={{ fontSize: 9, fontWeight: 800, color: C.yellow }}>★</span>}
                  </button>
                ))}
                {coverVersions && (
                  <Btn onClick={() => generateCoverVersions()} loading={coverVersionsLoading} variant="secondary" style={{ fontSize: 11, padding: "5px 12px", marginLeft: "auto" }}>
                    ↻ Regenerate All
                  </Btn>
                )}
              </div>
              {coverVersionsError && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 8, padding: "8px 12px", color: C.red, fontSize: 12, marginBottom: 10 }}>{coverVersionsError}</div>}
              {coverVersionsLoading && (
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: C.bgSoft, borderRadius: 10, marginBottom: 10 }}>
                  <div style={{ width: 16, height: 16, border: `2px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: C.textMid }}>⚡ AI is generating all 4 cover letter versions — Professional (recommended), Friendly, Executive, ATS Optimized…</span>
                </div>
              )}
              {coverVersions && !editingCoverLetter && (
                <div style={{ fontSize: 11, color: C.green, fontWeight: 600, marginBottom: 8 }}>✓ 4 versions ready — select a style above</div>
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
                  }}>✓ Done</Btn>
                ) : (
                  <Btn variant="secondary" style={{ fontSize: 12, padding: "6px 14px" }} onClick={() => { setEditingCoverLetter(true); setEditedCoverText(currentCoverText); }}>✏️ Edit</Btn>
                )}
                <Btn variant="secondary" style={{ fontSize: 12, padding: "6px 14px" }} onClick={() => downloadCoverLetterPDF(currentCoverText, `cover-letter-${activeCoverVersion}`)}>📄 Download PDF</Btn>
                <Btn variant="secondary" style={{ fontSize: 12, padding: "6px 14px" }} onClick={() => downloadCoverLetterDOCX(currentCoverText, `cover-letter-${activeCoverVersion}`)}>📝 Download DOCX</Btn>
                <CopyBtn text={currentCoverText} label="📋 Copy" variant="secondary" />
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
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.textMid }}>Generating your personalized insights…</div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>CareerPersona AI is reviewing your resume against this role's requirements</div>
                  </div>
                </div>
              )}
              {isOptimized && !insightsLoading && (
                <div style={{ background: C.greenLight, border: `1px solid ${C.green}30`, borderRadius: 12, padding: "14px 16px" }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.green, marginBottom: 4 }}>✅ Resume optimized for this job.</div>
                  <div style={{ fontSize: 12, color: C.textMid, lineHeight: 1.6 }}>These insights are based on the original analysis. Run <strong>New Analysis</strong> after updating your resume or selecting another job to generate new insights.</div>
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
                      {expanded ? "Show less ↑" : `Show ${items.length - initialShow} more ↓`}
                    </button>
                  );
                };
                return (
                  <>
                    {/* Strengths */}
                    <div style={{ background: C.greenLight, border: `1px solid ${C.green}25`, borderRadius: 12, padding: 16 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.green, marginBottom: 10 }}>💪 Resume Strengths</div>
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
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.yellow, marginBottom: 4 }}>💡 Growth Opportunities</div>
                        <div style={{ fontSize: 11, color: C.textMid, marginBottom: 12 }}>Addressing these areas can meaningfully boost your ATS score and recruiter interest:</div>
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
                        <div style={{ fontSize: 13, fontWeight: 700, color: "#EA580C", marginBottom: 4 }}>🎯 Skills to Develop</div>
                        <div style={{ fontSize: 11, color: C.textMid, marginBottom: 12 }}>Adding these capabilities could further strengthen your candidacy for this role:</div>
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
                        <div style={{ fontSize: 13, fontWeight: 700, color: C.purple, marginBottom: 10 }}>✨ Tailoring Opportunities</div>
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
                  Insights will appear here after your analysis completes.
                </div>
              )}

              {/* Deep Insights — grammar, readability, action verbs, formatting */}
              <div style={{ borderTop: `1.5px solid ${C.border}`, paddingTop: 16 }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10, flexWrap: "wrap", gap: 6 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>🔬 Deep Resume Analysis</div>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    {deepInsights && (deepInsights.issues?.length > 0 || deepInsights.weakBullets?.length > 0 || deepInsights.weakActionVerbs?.length > 0) && (
                      <Btn onClick={applyAllDeepFixes} loading={applyingAllFixes} style={{ fontSize: 11, padding: "5px 12px" }}>
                        ⚡ Apply All Fixes
                      </Btn>
                    )}
                    <Btn onClick={runDeepInsights} loading={deepInsightsLoading} variant="secondary" style={{ fontSize: 11, padding: "5px 12px" }}>
                      {deepInsights ? "↻ Re-analyze" : "Run Deep Analysis"}
                    </Btn>
                  </div>
                </div>
                {deepInsightsError && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 8, padding: "8px 12px", color: C.red, fontSize: 12, marginBottom: 10 }}>{deepInsightsError}</div>}
                {deepInsightsLoading && (
                  <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "14px 16px", background: C.bgSoft, borderRadius: 10 }}>
                    <div style={{ width: 16, height: 16, border: `2px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                    <span style={{ fontSize: 12, color: C.textMid }}>Analyzing grammar, readability, action verbs, and formatting…</span>
                  </div>
                )}
                {deepInsights && (() => {
                  const scores = [
                    { label: "Grammar", val: deepInsights.grammarScore, color: hubHealthColor(deepInsights.grammarScore) },
                    { label: "Readability", val: deepInsights.readabilityScore, color: hubHealthColor(deepInsights.readabilityScore) },
                    { label: "Formatting", val: deepInsights.formattingScore, color: hubHealthColor(deepInsights.formattingScore) },
                    { label: "Keywords", val: deepInsights.keywordDensity, color: hubHealthColor(deepInsights.keywordDensity) },
                    { label: "Action Verbs", val: deepInsights.actionVerbScore, color: hubHealthColor(deepInsights.actionVerbScore) },
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
                        {deepInsights.resumeLengthStatus && <span style={{ fontSize: 11, fontWeight: 600, color: C.textMid, background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 20, padding: "3px 10px" }}>📏 Length: {deepInsights.resumeLengthStatus}</span>}
                        {deepInsights.contactInfoStatus && <span style={{ fontSize: 11, fontWeight: 600, color: C.textMid, background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 20, padding: "3px 10px" }}>📋 Contact: {deepInsights.contactInfoStatus}</span>}
                        {deepInsights.missingSections?.length > 0 && <span style={{ fontSize: 11, fontWeight: 600, color: C.orange, background: C.orangeLight, border: `1px solid ${C.orange}30`, borderRadius: 20, padding: "3px 10px" }}>⚠️ Missing: {deepInsights.missingSections.join(", ")}</span>}
                      </div>
                      {/* Issues */}
                      {deepInsights.issues?.length > 0 && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 4 }}>Issues Found</div>
                          {deepInsights.issues.map((issue, i) => {
                            const isApplying = applyingIssueFix === issue.problem;
                            return (
                              <div key={i} style={{ background: severityBg[issue.severity] || C.bgSoft, border: `1px solid ${(severityColor[issue.severity] || C.blue)}25`, borderRadius: 10, padding: "10px 14px" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                                  <span style={{ fontSize: 9, fontWeight: 700, color: severityColor[issue.severity] || C.blue, background: `${(severityColor[issue.severity] || C.blue)}20`, borderRadius: 4, padding: "2px 7px", textTransform: "uppercase" }}>{issue.severity}</span>
                                  <span style={{ fontSize: 11, fontWeight: 700, color: C.textMid }}>{issue.category}</span>
                                  <Btn onClick={() => applyIssueFix(issue)} loading={isApplying} variant="secondary" style={{ fontSize: 10, padding: "3px 8px", marginLeft: "auto" }} disabled={!!applyingIssueFix}>
                                    {isApplying ? "Fixing…" : "⚡ AI Fix"}
                                  </Btn>
                                </div>
                                <div style={{ fontSize: 12, color: C.text, marginBottom: 4, lineHeight: 1.5 }}>{issue.problem}</div>
                                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4 }}>Why it matters: {issue.reason}</div>
                                <div style={{ fontSize: 11, fontWeight: 600, color: C.green }}>✓ Fix: {issue.fix}</div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                      {/* Weak bullets */}
                      {deepInsights.weakBullets?.length > 0 && (
                        <div style={{ marginBottom: 14 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>💪 Stronger Bullet Points</div>
                          {deepInsights.weakBullets.map((b, i) => (
                            <div key={i} style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 9, padding: "10px 14px", marginBottom: 6 }}>
                              <div style={{ fontSize: 11, color: C.red, marginBottom: 4, lineHeight: 1.5 }}>Before: {b.original}</div>
                              <div style={{ fontSize: 11, color: C.green, fontWeight: 600, lineHeight: 1.5, marginBottom: 6 }}>After: {b.improved}</div>
                              <Btn onClick={() => applyWeakBulletFix(b.original, b.improved)} variant="secondary" style={{ fontSize: 10, padding: "3px 8px" }}>⚡ Apply Fix</Btn>
                            </div>
                          ))}
                        </div>
                      )}
                      {/* Weak action verbs */}
                      {deepInsights.weakActionVerbs?.length > 0 && (
                        <div>
                          <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>⚡ Stronger Action Verbs</div>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            {deepInsights.weakActionVerbs.map((v, i) => (
                              <div key={i} style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 8, padding: "4px 10px", fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
                                <span style={{ color: C.red, textDecoration: "line-through" }}>{v.original}</span>
                                <span style={{ color: C.textMuted }}>→</span>
                                <span style={{ color: C.green, fontWeight: 700 }}>{v.stronger}</span>
                                <button onClick={() => applyVerbFix(v.original, v.stronger)} style={{ marginLeft: 4, background: C.green, border: "none", borderRadius: 4, color: "#fff", fontSize: 9, fontWeight: 700, padding: "2px 6px", cursor: "pointer", fontFamily: "inherit" }}>Apply</button>
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
                    }} style={{ padding: "9px 22px" }}>✅ Done Applying</Btn>
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>Scroll up to save your optimized resume.</div>
                  </div>
                )}
                {!deepInsights && !deepInsightsLoading && (
                  <div style={{ fontSize: 12, color: C.textMuted, textAlign: "center", padding: "12px 0" }}>
                    {results ? "Analyzing your resume…" : "Grammar, readability, action verbs, bullet quality, missing sections, and more."}
                  </div>
                )}
              </div>
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
                    <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>No analysis history yet</div>
                    <div style={{ fontSize: 12, color: C.textMuted }}>Save a resume to start tracking progress.</div>
                  </div>
                </div>
              </Card>
            )}
            {analysisHistory?.length > 0 && (
              <Card style={{ flex: 1 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: C.text }}>📊 Analysis History</div>
                  {analysisHistory.length > 3 && (
                    <button onClick={() => setShowAllHistory(v => !v)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, fontWeight: 600, color: C.purple, padding: 0 }}>
                      {showAllHistory ? "Show Less ↑" : `View All ${analysisHistory.length} ↓`}
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
                              <div style={{ fontSize: 12, fontWeight: 700, color: C.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.resumeName || "Resume"}</div>
                              <div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap", marginTop: 2 }}>
                                {entry.atsScore != null && <span style={{ fontSize: 11, fontWeight: 800, color: hc }}>ATS {entry.atsScore}%</span>}
                                {delta !== null && <span style={{ fontSize: 10, fontWeight: 700, color: delta > 0 ? C.green : delta < 0 ? C.red : C.textMuted }}>({delta > 0 ? `+${delta}` : delta})</span>}
                                {isOptimizedEntry
                                  ? <span style={{ fontSize: 9, fontWeight: 700, color: C.green, background: C.greenLight, borderRadius: 4, padding: "1px 4px" }}>✅ Optimized</span>
                                  : <span style={{ fontSize: 9, color: C.textMuted, background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 4, padding: "1px 4px" }}>Original</span>
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
                  <div style={{ fontWeight: 700, fontSize: 14, color: C.text, marginBottom: 8 }}>📈 Performance Analytics</div>
                  {/* 4 stat squares in one horizontal row */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 10 }}>
                    {[
                      { label: "Saves", value: total, color: C.purple },
                      { label: "Improved", value: improved, color: C.green },
                      { label: "Avg ATS", value: avgScore != null ? `${avgScore}%` : "—", color: C.yellow },
                      { label: "Trend", value: trend != null ? `${trend > 0 ? "+" : ""}${trend}%` : "—", color: trend != null && trend > 0 ? C.green : trend != null && trend < 0 ? C.red : C.textMuted },
                    ].map(({ label, value, color }) => (
                      <div key={label} style={{ background: C.bgSoft, borderRadius: 6, padding: "5px 2px", textAlign: "center", border: `1px solid ${C.border}`, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 1 }}>
                        <div style={{ fontSize: 12, fontWeight: 800, color, lineHeight: 1.1 }}>{value}</div>
                        <div style={{ fontSize: 8, color: C.textMuted, lineHeight: 1.2 }}>{label}</div>
                      </div>
                    ))}
                  </div>
                  {trendScores.length > 1 && (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontSize: 10, fontWeight: 700, color: C.textMid, marginBottom: 5 }}>ATS Trend (last {trendScores.length})</div>
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
                      <div style={{ fontSize: 10, fontWeight: 700, color: C.textMid, marginBottom: 5 }}>Health Distribution</div>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {Object.entries(healthCounts).filter(([, v]) => v > 0).map(([k, v]) => {
                          const hc = hubHealthColor(k === "Excellent" ? 95 : k === "Very Good" ? 85 : k === "Good" ? 75 : k === "Needs Improvement" ? 65 : 30);
                          return (
                            <div key={k} style={{ background: C.bgSoft, borderRadius: 6, padding: "3px 7px", textAlign: "center", border: `1px solid ${C.border}` }}>
                              <div style={{ fontSize: 13, fontWeight: 800, color: hc }}>{v}</div>
                              <div style={{ fontSize: 9, color: hc }}>{k}</div>
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
        <div style={{ fontWeight: 700, fontSize: 15, color: C.text, marginBottom: 12 }}>🤖 AI Resume Toolkit</div>
        <div className="hub-toolkit-grid" style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
          {[
            { icon: "📊", title: "Score Benchmarking", desc: "Compare ATS score against industry average",
              active: true, panelId: "benchmark",
              action: () => {
                if (!resume.trim()) { setToolGuidancePanelId("benchmark"); setToolGuidanceMsg("Select a resume from your Resume Library, or upload/create one first."); return; }
                setToolGuidanceMsg(""); setToolGuidancePanelId(""); setActiveToolPanel(p => p === "benchmark" ? null : "benchmark"); setTimeout(() => document.getElementById("resume-toolkit-panels")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
              },
              getStatus: () => benchmarkData ? { text: benchmarkData.percentileLabel || benchmarkData.overallRanking, color: C.purple } : resume.trim() ? { text: "Ready to benchmark", color: C.textMuted } : { text: "Add a resume first", color: C.textMuted } },
            { icon: "🔍", title: "Job Fit Analyzer", desc: "Skill-by-skill match for any job description",
              active: true, panelId: "jobfit",
              action: () => {
                if (!resume.trim()) { setToolGuidancePanelId("jobfit"); setToolGuidanceMsg("Select a resume from your Resume Library, or upload/create one first."); return; }
                if (!jobDesc.trim()) { setToolGuidancePanelId("jobfit"); setToolGuidanceMsg("Add a job description to analyze your fit for this role."); return; }
                setToolGuidanceMsg(""); setToolGuidancePanelId(""); setActiveToolPanel(p => p === "jobfit" ? null : "jobfit"); setTimeout(() => document.getElementById("resume-toolkit-panels")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
              },
              getStatus: () => jobFitData ? { text: `${jobFitData.overallMatch}% match — ${jobFitData.applicationReadiness}`, color: jobFitData.overallMatch >= 75 ? C.green : jobFitData.overallMatch >= 50 ? "#d97706" : C.red } : (resume.trim() && jobDesc.trim()) ? { text: "Ready to analyze", color: C.textMuted } : { text: "Add resume + job desc", color: C.textMuted } },
            { icon: "📝", title: "LinkedIn Optimizer", desc: "Headline, About section, experience bullets",
              active: true, panelId: "linkedin-opt",
              action: () => {
                if (!resume.trim()) { setToolGuidancePanelId("linkedin-opt"); setToolGuidanceMsg("Select a resume from your Resume Library, or upload/create one first."); return; }
                setToolGuidanceMsg(""); setToolGuidancePanelId(""); setActiveToolPanel(p => p === "linkedin-opt" ? null : "linkedin-opt"); setTimeout(() => document.getElementById("resume-toolkit-panels")?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
              },
              getStatus: () => linkedinOptData ? { text: `Optimized · ${linkedinOptData.headlineScore ?? "—"}% headline`, color: C.green } : resume.trim() ? { text: "Ready to optimize", color: C.textMuted } : { text: "Add a resume first", color: C.textMuted } },
            { icon: "🎤", title: "AI Voice Resume Writer", desc: "Speak naturally — AI writes your ATS-optimized resume",
              active: false, panelId: null,
              comingSoon: "AI Voice Resume Writer is coming soon. This feature will be available in a future update." },
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
                {!active && <div style={{ fontSize: 10, color: C.purple, fontWeight: 700, marginTop: 6 }}>Coming Soon</div>}
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
              <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>📊 Score Benchmarking</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {benchmarkData && <Btn onClick={runBenchmark} loading={benchmarkLoading} variant="secondary" style={{ fontSize: 11, padding: "5px 12px" }}>↻ Refresh</Btn>}
                <button onClick={() => setActiveToolPanel(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: C.textMuted, lineHeight: 1, padding: "13px 14px" }}>×</button>
              </div>
            </div>
            {resume.trim() && !benchmarkData && !benchmarkLoading && (
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 20px", background: C.bgSoft, borderRadius: 12 }}>
                <div style={{ width: 18, height: 18, border: `2.5px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                <div style={{ fontSize: 13, color: C.textMuted }}>Preparing benchmark analysis…</div>
              </div>
            )}
            {benchmarkError &&<div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 8, padding: "8px 12px", color: C.red, fontSize: 12 }}>{benchmarkError}</div>}
            {benchmarkLoading && (
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 20px", background: C.bgSoft, borderRadius: 12 }}>
                <div style={{ width: 18, height: 18, border: `2.5px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.textMid }}>Analyzing against market benchmarks…</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>Comparing keyword coverage, formatting, experience, and skills against your industry</div>
                </div>
              </div>
            )}
            {benchmarkData && (() => {
              const { atsScore, industryAverage, topCandidateAverage, percentile, percentileLabel, keywordCoverage, formattingScore, experienceScore, skillsScore, educationScore, overallRanking, industryLabel, recommendations } = benchmarkData;
              const rankColor = overallRanking === "Excellent" ? C.green : overallRanking === "Strong" ? C.green : overallRanking === "Above Average" ? C.yellow : overallRanking === "Average" ? C.orange : C.red;
              return (
                <>
                  {/* Vs market comparison */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10, marginBottom: 16 }}>
                    {[
                      { label: "Your Score", val: `${atsScore ?? "—"}`, color: hubHealthColor(atsScore), sub: "ATS score" },
                      { label: "Industry Avg", val: `${industryAverage ?? "—"}`, color: C.textMid, sub: industryLabel || "Your industry" },
                      { label: "Top 25%", val: `${topCandidateAverage ?? "—"}`, color: C.purple, sub: "Target benchmark" },
                    ].map(({ label, val, color, sub }) => (
                      <div key={label} style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 10px", textAlign: "center" }}>
                        <div style={{ fontSize: 22, fontWeight: 900, color, lineHeight: 1 }}>{val}</div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: C.text, marginTop: 4 }}>{label}</div>
                        <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>{sub}</div>
                      </div>
                    ))}
                  </div>
                  {/* Percentile + ranking */}
                  <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
                    <div style={{ flex: 1, background: C.purpleLight, border: `1.5px solid ${C.purple}20`, borderRadius: 10, padding: "10px 16px", textAlign: "center" }}>
                      <div style={{ fontSize: 20, fontWeight: 900, color: C.purple }}>{percentileLabel || `Top ${100 - (percentile || 50)}%`}</div>
                      <div style={{ fontSize: 11, color: C.purple, marginTop: 2 }}>Candidate Percentile</div>
                    </div>
                    <div style={{ flex: 1, background: `${rankColor}12`, border: `1.5px solid ${rankColor}30`, borderRadius: 10, padding: "10px 16px", textAlign: "center" }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: rankColor }}>{overallRanking}</div>
                      <div style={{ fontSize: 11, color: rankColor, marginTop: 2 }}>Overall Ranking</div>
                    </div>
                  </div>
                  {/* Category scores */}
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Category Breakdown</div>
                    {[
                      { label: "Keyword Coverage", val: keywordCoverage },
                      { label: "Formatting", val: formattingScore },
                      { label: "Experience", val: experienceScore },
                      { label: "Skills", val: skillsScore },
                      { label: "Education", val: educationScore },
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
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Recommendations to Improve Your Ranking</div>
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
              <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>🔍 Job Fit Analyzer</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {jobFitData && <Btn onClick={runJobFit} loading={jobFitLoading} variant="secondary" style={{ fontSize: 11, padding: "5px 12px" }}>↻ Re-analyze</Btn>}
                <button onClick={() => setActiveToolPanel(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: C.textMuted, lineHeight: 1, padding: "13px 14px" }}>×</button>
              </div>
            </div>
            {resume.trim() && jobDesc.trim() && !jobFitData && !jobFitLoading && (
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 20px", background: C.bgSoft, borderRadius: 12 }}>
                <div style={{ width: 18, height: 18, border: `2.5px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                <div style={{ fontSize: 13, color: C.textMuted }}>Analyzing job fit…</div>
              </div>
            )}
            {jobFitError && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 8, padding: "8px 12px", color: C.red, fontSize: 12 }}>{jobFitError}</div>}
            {jobFitLoading && (
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 20px", background: C.bgSoft, borderRadius: 12 }}>
                <div style={{ width: 18, height: 18, border: `2.5px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.textMid }}>Calculating job fit…</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>Matching skills, experience, keywords, education, and seniority</div>
                </div>
              </div>
            )}
            {jobFitData && (() => {
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
                      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>Overall Job Fit</div>
                    </div>
                    <div style={{ flex: 1, background: `${readinessColor}12`, border: `1.5px solid ${readinessColor}30`, borderRadius: 12, padding: "16px", textAlign: "center" }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: readinessColor, lineHeight: 1.2 }}>{applicationReadiness}</div>
                      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>Application Readiness</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10 }}>
                        <div style={{ fontSize: 10, color: C.textMuted, width: 60, flexShrink: 0 }}>Keywords</div>
                        <PBar val={keywordMatchScore} color={hubHealthColor(keywordMatchScore)} />
                        <div style={{ fontSize: 10, fontWeight: 700, color: hubHealthColor(keywordMatchScore), width: 28, flexShrink: 0 }}>{keywordMatchScore}%</div>
                      </div>
                    </div>
                  </div>
                  {/* Skills match */}
                  {requiredSkillsMatch?.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Required Skills</div>
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
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Preferred Skills</div>
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
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.red, marginBottom: 8 }}>Missing Skills</div>
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
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.purple, marginBottom: 6 }}>⚡ Quick Wins</div>
                      <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6 }}>
                        Adding <strong>{missingSkills.slice(0, 2).join(" and ")}</strong> to your resume could significantly improve your match score. {missingSkills.length > 2 ? `${missingSkills.length - 2} more gap${missingSkills.length - 2 !== 1 ? "s" : ""} identified above.` : "These skills are explicitly listed in the job description."}
                      </div>
                    </div>
                  )}
                  {/* Dimension breakdown */}
                  {[experienceMatch, educationMatch, seniorityMatch].filter(Boolean).map((dim, i) => (
                    <div key={i} style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 9, padding: "10px 14px", marginBottom: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: C.textMid }}>{["Experience", "Education", "Seniority"][i]} Match</span>
                        <span style={{ fontSize: 11, fontWeight: 700, color: hubHealthColor(dim.score) }}>{dim.score}%</span>
                        <span style={{ fontSize: 10, color: C.textMuted }}>{dim.status}</span>
                      </div>
                      <div style={{ fontSize: 12, color: C.text, lineHeight: 1.5 }}>{dim.detail}</div>
                    </div>
                  ))}
                  {/* Recommendations */}
                  {topRecommendations?.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Recommendations to Improve Fit</div>
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
                      <span style={{ fontWeight: 700 }}>💌 Cover Letter Tip: </span>{coverLetterTip}
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
              <div style={{ fontWeight: 700, fontSize: 15, color: C.text }}>📝 LinkedIn Optimizer</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {linkedinOptData && <Btn onClick={runLinkedinOpt} loading={linkedinOptLoading} variant="secondary" style={{ fontSize: 11, padding: "5px 12px" }}>↻ Regenerate</Btn>}
                <button onClick={() => setActiveToolPanel(null)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 18, color: C.textMuted, lineHeight: 1, padding: "13px 14px" }}>×</button>
              </div>
            </div>
            {resume.trim() && !linkedinOptData && !linkedinOptLoading && (
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 20px", background: C.bgSoft, borderRadius: 12 }}>
                <div style={{ width: 18, height: 18, border: `2.5px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                <div style={{ fontSize: 13, color: C.textMuted }}>Generating LinkedIn optimizations…</div>
              </div>
            )}
            {linkedinOptError && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 8, padding: "8px 12px", color: C.red, fontSize: 12 }}>{linkedinOptError}</div>}
            {linkedinOptLoading && (
              <div style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 20px", background: C.bgSoft, borderRadius: 12 }}>
                <div style={{ width: 18, height: 18, border: `2.5px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.textMid }}>Generating LinkedIn optimizations…</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>Crafting headline, About section, experience bullets, and recruiter visibility tips</div>
                </div>
              </div>
            )}
            {linkedinOptData && (() => {
              const { headline, aboutSection, experienceOptimizations, topSkillsToAdd, keywordsToFeature, recruiterVisibilityTips, atsAlignmentScore, profileCompleteness, headlineScore } = linkedinOptData;
              return (
                <>
                  {/* Score strip */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginBottom: 16 }}>
                    {[
                      { label: "ATS Alignment", val: atsAlignmentScore, color: hubHealthColor(atsAlignmentScore) },
                      { label: "Profile Complete", val: profileCompleteness, color: hubHealthColor(profileCompleteness) },
                      { label: "Headline Score", val: headlineScore, color: hubHealthColor(headlineScore) },
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
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>Optimized Headline</div>
                      <div style={{ background: C.purpleLight, border: `1.5px solid ${C.purple}25`, borderRadius: 9, padding: "10px 14px", fontSize: 13, fontWeight: 600, color: C.purple }}>
                        {headline}
                      </div>
                      <CopyBtn text={headline} label="Copy Headline" variant="secondary" style={{ marginTop: 6, fontSize: 11 }} />
                    </div>
                  )}
                  {/* About section */}
                  {aboutSection && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 6 }}>Optimized About Section</div>
                      <div style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 9, padding: "12px 14px", fontSize: 13, color: C.text, lineHeight: 1.7, whiteSpace: "pre-line" }}>
                        {aboutSection}
                      </div>
                      <CopyBtn text={aboutSection} label="Copy About Section" variant="secondary" style={{ marginTop: 6, fontSize: 11 }} />
                    </div>
                  )}
                  {/* Skills to add */}
                  {topSkillsToAdd?.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Skills to Add to Your Profile</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {topSkillsToAdd.map((s, i) => (
                          <span key={i} style={{ background: C.purpleLight, border: `1px solid ${C.purple}25`, borderRadius: 20, padding: "4px 12px", fontSize: 11, fontWeight: 600, color: C.purple }}>+ {s}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* Keywords to feature */}
                  {keywordsToFeature?.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Keywords to Feature</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {keywordsToFeature.map((k, i) => (
                          <span key={i} style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 20, padding: "4px 10px", fontSize: 11, color: C.textMid }}>🔑 {k}</span>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* Experience optimizations */}
                  {experienceOptimizations?.length > 0 && (
                    <div style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Experience Bullet Improvements</div>
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
                  {/* Recruiter visibility tips */}
                  {recruiterVisibilityTips?.length > 0 && (
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>Recruiter Visibility Tips</div>
                      {recruiterVisibilityTips.map((tip, i) => (
                        <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", background: C.purpleLight, border: `1px solid ${C.purple}15`, borderRadius: 9, padding: "8px 12px", marginBottom: 6 }}>
                          <span style={{ color: C.purple, fontWeight: 700, flexShrink: 0 }}>💡</span>
                          <span style={{ fontSize: 12, color: C.text, lineHeight: 1.5 }}>{tip}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}
            {/* Refine with LinkedIn profile text — shown after results */}
            {linkedinOptData && (
              <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 12, marginTop: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.textMid, marginBottom: 6 }}>Refine with your LinkedIn profile text:</div>
                <textarea value={linkedinProfile} onChange={e => setLinkedinProfile(e.target.value)} placeholder={"Paste your current About section and experience descriptions for more targeted suggestions."} style={{ width: "100%", minHeight: 70, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 12, lineHeight: 1.6, padding: "8px 12px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box", marginBottom: 10 }} />
                <Btn onClick={runLinkedinOpt} loading={linkedinOptLoading} variant="secondary" style={{ fontSize: 12 }}>↻ Regenerate With Profile</Btn>
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
const JS_COUNTRY_OPTIONS = ["United States","Canada","United Kingdom","Australia","Germany","France","Netherlands","Remote Worldwide"];
const JS_COUNTRY_LABEL_KEY = { "United States": "countryUS", "Canada": "countryCanada", "United Kingdom": "countryUK", "Australia": "countryAustralia", "Germany": "countryGermany", "France": "countryFrance", "Netherlands": "countryNetherlands", "Remote Worldwide": "countryRemoteWorldwide" };
const JS_EMPLOYMENT_OPTIONS = ["Any","Full-time","Part-time","Contract","Internship","Freelance"];
const JS_EMPLOYMENT_LABEL_KEY = { Any: "employmentAny", "Full-time": "employmentFullTime", "Part-time": "employmentPartTime", Contract: "employmentContract", Internship: "employmentInternship", Freelance: "employmentFreelance" };
const JS_EXPERIENCE_OPTIONS = ["Any","Entry Level","Mid Level","Senior","Lead","Executive"];
const JS_EXPERIENCE_LABEL_KEY = { Any: "experienceAny", "Entry Level": "experienceEntry", "Mid Level": "experienceMid", Senior: "experienceSenior", Lead: "experienceLead", Executive: "experienceExecutive" };

function JobSearchPage({ savedJobs, setSavedJobs, setApplications, applications, profile, resumes, onQueueChange, queue, enqueue, markReady, markFailed, purgeQueueByJobId }) {
  const { t } = useI18n();
  const [filters, setFilters] = useSessionState("cp_jobs_filters", { title: profile?.preferred_job_title || "", country: "United States", city: profile?.location || "", remote: profile?.work_type === "Remote", employmentType: "Any", experienceLevel: "Any", salaryMin: "" });
  const [jobs, setJobs] = useSessionState("cp_jobs_results", []); const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [searched, setSearched] = useSessionState("cp_jobs_searched", false); const [page, setPage] = useSessionState("cp_jobs_page", 1); const [hasMore, setHasMore] = useSessionState("cp_jobs_hasmore", false); const [analyzing, setAnalyzing] = useState(null); const [matchResults, setMatchResults] = useSessionState("cp_jobs_match", {}); const [resume, setResume] = useSessionState("cp_jobs_resume", ""); const [showResume, setShowResume] = useState(false); const [sourceCounts, setSourceCounts] = useSessionState("cp_jobs_sourcecounts", null);
  const resumeFileRef = useRef();
  const [uploadingResume, setUploadingResume] = useState(false);
  const [resumeFileName, setResumeFileName] = useSessionState("cp_jobs_resumefilename", "");
  const [dragActive, setDragActive] = useState(false);
  const [smartApplying, setSmartApplying] = useState(null);
  const [selectedResumeId, setSelectedResumeId] = useState(null);
  const [autoApplyingCount, setAutoApplyingCount] = useState(0);
  const userContext = useUserContext({ profile, applications, savedJobs });
  const isSmartApplied = (job) => queue.some(q => q.job_id === job.id && (q.status === "queued" || q.status === "ready"));
  const isTracked = (job) => applications.some(a => a.jobTitle === job.title && a.company === job.company);

  // Auto-load the default saved resume the first time resumes arrive from Supabase.
  // Without this, resume is always empty on first visit and autoSmartApply never fires.
  useEffect(() => {
    if (resume) return; // textarea already has content — don't overwrite
    if (!resumes || resumes.length === 0) return;
    const def = resumes.find(r => r.is_default) || resumes[0];
    if (def?.content) {
      setResume(def.content);
      setResumeFileName(def.name);
      setSelectedResumeId(def.id);
    }
  }, [resumes]);

  // Once per session: when resume becomes available, auto-process any saved jobs
  // that don't already have a queued/ready package. enqueueSmartApply handles dedup
  // so jobs with existing packages are skipped instantly with one DB round-trip.
  const autoApplySavedRef = useRef(null);
  useEffect(() => {
    if (!resume.trim() || !profile?.id) return;
    if (autoApplySavedRef.current === profile.id) return; // already fired this session
    if (!savedJobs.length) return;
    autoApplySavedRef.current = profile.id;
    const unprocessed = savedJobs.filter(j =>
      !queue.some(q => q.job_id === j.job_id && (q.status === "queued" || q.status === "ready"))
    );
    if (unprocessed.length > 0) {
      console.log(`[SmartApply] 🔄 Auto-processing ${unprocessed.length} saved job(s) with no package`);
      autoSmartApply(unprocessed);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resume, profile?.id, savedJobs, queue]); // eslint-disable-line react-hooks/exhaustive-deps

  // Shared extraction core — accepts a File object
  const extractResumeFile = async (file) => {
    if (!file) return;
    const ext = file.name.split(".").pop().toLowerCase();
    if (file.size > 5 * 1024 * 1024) { setError(t("jobSearch.fileTooLarge")); return; }
    setError(""); setUploadingResume(true);
    try {
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
        let text = "";
        for (let i = 1; i <= pdf.numPages; i++) {
          const pageObj = await pdf.getPage(i);
          const content = await pageObj.getTextContent();
          text += content.items.map(it => it.str).join(" ") + "\n";
        }
        if (text.trim()) { setResume(text.trim()); setResumeFileName(file.name); setSelectedResumeId(null); }
        else { setError(t("jobSearch.pdfExtractFailed")); }
      } else if (ext === "docx" || ext === "doc" || ext === "txt") {
        const text = await file.text();
        let clean = text;
        if (ext === "docx" || ext === "doc") {
          clean = String(text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        }
        if (clean && clean.trim()) { setResume(clean.trim()); setResumeFileName(file.name); setSelectedResumeId(null); }
        else { setError(t("jobSearch.fileReadFailed")); }
      } else {
        setError(t("jobSearch.unsupportedFileType"));
      }
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

  const handleResumeDrop = async (e) => {
    e.preventDefault(); e.stopPropagation();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    await extractResumeFile(file);
  };

  // Worker URL — same as Claude proxy, new /api/jobs route
  const WORKER_URL = "https://proxy.dawn-voice-2790.workers.dev";

  const search = async (loadMore = false) => {
    if (!filters.title.trim()) { setError(t("jobSearch.enterTitlePrompt")); return; }
    setError("");
    setLoading(true);
    const nextPage = loadMore ? page + 1 : 1;
    if (!loadMore) { setJobs([]); setSearched(true); setPage(1); setSourceCounts(null); setMatchResults({}); }

    try {
      const res = await fetch(`${WORKER_URL}/api/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: filters.title.trim(),
          country: filters.country,
          city: filters.city.trim(),
          remote: filters.remote,
          employmentType: filters.employmentType,
          experienceLevel: filters.experienceLevel,
          salaryMin: filters.salaryMin,
          page: nextPage,
        }),
      });

      if (!res.ok) throw new Error(`Server error: ${res.status}`);
      const data = await res.json();
      const newJobs = data.jobs || [];

      setJobs(prev => loadMore ? [...prev, ...newJobs] : newJobs);
      setPage(nextPage);
      setHasMore(newJobs.length >= 10); // if we got results, there may be more
      if (data.sources) setSourceCounts(data.sources);

      // Auto AI-match + auto Smart Apply on initial searches when resume is present
      if (!loadMore && resume.trim() && newJobs.length > 0) {
        autoMatchAll(newJobs); // scores job cards (fire and forget)
        autoSmartApply(newJobs); // generates full packages for top 3 (fire and forget)
      }
    } catch (e) {
      setError(t("jobSearch.searchFailed").replace("{message}", e.message));
    } finally {
      setLoading(false);
    }
  };

  // AI match a single job against resume
  const analyzeMatch = async (job) => {
    if (!resume.trim()) { setShowResume(true); return; }
    setAnalyzing(job.id);
    try {
      const ctx = userContext.getContextString({ identity: true });
      const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}Analyze resume-job match. Return ONLY valid JSON, no markdown:
{"matchScore":<0-100>,"atsScore":<0-100>,"interviewProbability":<0-100>,"matchingSkills":["<s1>","<s2>","<s3>"],"missingSkills":["<m1>","<m2>","<m3>"],"summary":"<1 concise sentence about fit>"}

RESUME (first 600 chars):
${resume.slice(0, 600)}

JOB:
Title: ${job.title}
Company: ${job.company}
Description: ${(job.description || "").slice(0, 400)}
Skills required: ${(job.skills || []).join(", ")}`, 600);
      setMatchResults(prev => ({ ...prev, [job.id]: JSON.parse(raw) }));
    } catch (e) {
      console.error("AI match failed:", e);
    } finally {
      setAnalyzing(null);
    }
  };

  // Smart Apply: AI prepares a full application package (tailored resume, cover
  // letter, recruiter/networking messages, fit probabilities, likely application
  // questions) and queues it for review — the user still clicks the real "Apply
  // Now" link themselves, this just does the prep work.
  const smartApply = async (job) => {
    if (!resume.trim()) { setShowResume(true); return; }
    if (!profile?.id) { setError(t("jobSearch.signInForSmartApply")); return; }
    setSmartApplying(job.id);
    let queued;
    try {
      console.log(`[SmartApply] ⏳ [1/6] Enqueueing "${job.title}" at ${job.company} (job_id: ${job.id})`);
      queued = await enqueue(profile.id, job, selectedResumeId);
      if (!queued) {
        console.log(`[SmartApply] ⏭️ [1/6] Skipped "${job.title}" — already queued/ready`);
        return; // existing queued/ready row — no generation needed
      }
      console.log(`[SmartApply] ✅ [1/6] Enqueued: queue_id=${queued.id}, status=${queued.status}`);

      console.log(`[SmartApply] ⏳ [2/6] Building context for "${job.title}"`);
      const ctx = userContext.getContextString({ identity: true, applications: true });
      console.log(`[SmartApply] ✅ [2/6] Context ready: ${ctx.length} chars`);

      console.log(`[SmartApply] ⏳ [3/6] Calling Claude API for "${job.title}" (max 8000 tokens)`);
      const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}You are an expert job application assistant. Given this candidate's resume and job, produce a complete application package. Return ONLY valid JSON, no markdown:
{"tailoredResume":"<resume rewritten and optimized for this specific job, full text>","coverLetter":"<professional 3 paragraph cover letter for this job>","recruiterMessage":"<short personalized LinkedIn message to a recruiter at this company, 2-3 sentences>","networkingMessage":"<short message to a potential referral contact at this company, 2-3 sentences>","missingSkills":["<skill1>","<skill2>","<skill3>"],"interviewProbability":<0-100>,"hiringProbability":<0-100>,"applicationQuestions":["<likely application question 1>","<likely application question 2>","<likely application question 3>"],"salaryInsight":{"marketRange":{"low":<annual USD>,"median":<annual USD>,"high":<annual USD>},"userPositioning":"<1 sentence: how candidate likely compares to market range>","negotiationLeverage":"<1 sentence: strongest leverage point for negotiation>","benchmarks":["<comparable role or location benchmark>"]},"companyInsight":{"culture":"<1-2 sentences on company culture and work environment>","recentNews":"<1-2 sentences on recent company news relevant to a job seeker>","hiringTrend":"<growing|stable|shrinking>","redFlags":["<potential concern about this role or company>"],"greenFlags":["<positive signal about this role or company>"],"talkingPoints":["<specific talking point to use in interviews or outreach>"]}}

RESUME:
${resume}

JOB:
Title: ${job.title}
Company: ${job.company}
Description: ${(job.description || "").slice(0, 1200)}`, 8000);
      console.log(`[SmartApply] ✅ [3/6] Claude responded: ${raw.length} chars`);

      console.log(`[SmartApply] ⏳ [4/6] Parsing JSON for "${job.title}"`);
      const jsonStart = raw.indexOf("{"); const jsonEnd = raw.lastIndexOf("}");
      const cleanRaw = (jsonStart >= 0 && jsonEnd > jsonStart) ? raw.slice(jsonStart, jsonEnd + 1) : raw;
      const result = JSON.parse(cleanRaw);
      console.log(`[SmartApply] ✅ [4/6] JSON parsed. Keys: ${Object.keys(result).join(", ")}`);

      console.log(`[SmartApply] ⏳ [5/6] Validating fields for "${job.title}"`);
      const trLen = (result.tailoredResume || "").trim().length;
      const clLen = (result.coverLetter || "").trim().length;
      console.log(`[SmartApply] ✅ [5/6] tailoredResume=${trLen}c, coverLetter=${clLen}c, interviewProb=${result.interviewProbability}, hiringProb=${result.hiringProbability}`);
      if (trLen < 50 && clLen < 50) throw new Error(`AI returned empty package: tailoredResume=${trLen}c, coverLetter=${clLen}c`);

      console.log(`[SmartApply] ⏳ [6/6] Saving to Supabase (queue_id: ${queued.id})`);
      await markReady(queued.id, result);
      console.log(`[SmartApply] ✅ [6/6] Package saved — status: ready ✓`);
    } catch (e) {
      console.error(`[SmartApply] ❌ MANUAL failed for "${job.title}":`, e?.code, e?.message, e);
      if (queued) await markFailed(queued.id);
      const isRls = e?.code === "42501" || e?.message?.includes("row-level security");
      setError(isRls ? t("jobSearch.signInForSmartApply") : t("jobSearch.smartApplyFailed"));
    } finally {
      setSmartApplying(null);
      onQueueChange?.(); // keep root-level queue and Dashboard in sync
    }
  };

  // Auto-match up to 5 jobs silently when resume is present
  const autoMatchAll = async (newJobs) => {
    const ctx = userContext.getContextString({ identity: true });
    const toMatch = newJobs.slice(0, 5);
    for (const job of toMatch) {
      try {
        const raw = await askClaude(`${ctx ? ctx + "\n" : ""}Match score only. Return ONLY JSON:
{"matchScore":<0-100>,"atsScore":<0-100>,"interviewProbability":<0-100>,"matchingSkills":["<s1>","<s2>"],"missingSkills":["<m1>","<m2>"],"summary":"<1 sentence>"}
RESUME:${resume.slice(0, 300)}
JOB:${job.title} at ${job.company}. ${(job.description || "").slice(0, 200)}`, 400);
        setMatchResults(prev => ({ ...prev, [job.id]: JSON.parse(raw) }));
      } catch { /* silent fail per job */ }
    }
  };

  // Auto-generate full Smart Apply packages for all provided jobs after search or save.
  // Runs in the background — queue cards appear in Saved Jobs as each completes.
  // enqueueSmartApply handles dedup: already-queued/ready jobs are skipped instantly.
  const autoSmartApply = async (newJobs) => {
    if (!profile?.id || !resume.trim()) return;

    console.log(`[SmartApply] 🚀 AUTO — starting for ${newJobs.length} job(s)`);
    setAutoApplyingCount(newJobs.length);
    let succeeded = 0;
    for (const job of newJobs) {
      let queued;
      try {
        console.log(`[SmartApply] ⏳ [1/6] Enqueueing "${job.title}" at ${job.company} (job_id: ${job.id || job.job_id})`);
        queued = await enqueue(profile.id, job, selectedResumeId);
        // Dedup: row already queued/ready — skip AI generation; finally still decrements counter.
        if (!queued) {
          console.log(`[SmartApply] ⏭️ [1/6] Skipped "${job.title}" — already queued/ready`);
          succeeded++;
          continue;
        }
        console.log(`[SmartApply] ✅ [1/6] Enqueued: queue_id=${queued.id}, status=${queued.status}`);

        console.log(`[SmartApply] ⏳ [2/6] Building context for "${job.title}"`);
        const ctx = userContext.getContextString({ identity: true, applications: true });
        console.log(`[SmartApply] ✅ [2/6] Context ready: ${ctx.length} chars`);

        console.log(`[SmartApply] ⏳ [3/6] Calling Claude API for "${job.title}" (max 8000 tokens)`);
        const raw = await askClaude(`${ctx ? ctx + "\n\n" : ""}You are an expert job application assistant. Given this candidate's resume and job, produce a complete application package. Return ONLY valid JSON, no markdown:
{"tailoredResume":"<resume rewritten and optimized for this specific job, full text>","coverLetter":"<professional 3 paragraph cover letter for this job>","recruiterMessage":"<short personalized LinkedIn message to a recruiter at this company, 2-3 sentences>","networkingMessage":"<short message to a potential referral contact at this company, 2-3 sentences>","missingSkills":["<skill1>","<skill2>","<skill3>"],"interviewProbability":<0-100>,"hiringProbability":<0-100>,"applicationQuestions":["<likely application question 1>","<likely application question 2>","<likely application question 3>"],"salaryInsight":{"marketRange":{"low":<annual USD>,"median":<annual USD>,"high":<annual USD>},"userPositioning":"<1 sentence: how candidate likely compares to market range>","negotiationLeverage":"<1 sentence: strongest leverage point for negotiation>","benchmarks":["<comparable role or location benchmark>"]},"companyInsight":{"culture":"<1-2 sentences on company culture and work environment>","recentNews":"<1-2 sentences on recent company news relevant to a job seeker>","hiringTrend":"<growing|stable|shrinking>","redFlags":["<potential concern about this role or company>"],"greenFlags":["<positive signal about this role or company>"],"talkingPoints":["<specific talking point to use in interviews or outreach>"]}}

RESUME:
${resume}

JOB:
Title: ${job.title}
Company: ${job.company}
Description: ${(job.description || "").slice(0, 1200)}`, 8000);
        console.log(`[SmartApply] ✅ [3/6] Claude responded: ${raw.length} chars`);

        console.log(`[SmartApply] ⏳ [4/6] Parsing JSON for "${job.title}"`);
        const jsonStart = raw.indexOf("{"); const jsonEnd = raw.lastIndexOf("}");
        const cleanRaw = (jsonStart >= 0 && jsonEnd > jsonStart) ? raw.slice(jsonStart, jsonEnd + 1) : raw;
        const result = JSON.parse(cleanRaw);
        console.log(`[SmartApply] ✅ [4/6] JSON parsed. Keys: ${Object.keys(result).join(", ")}`);

        console.log(`[SmartApply] ⏳ [5/6] Validating fields for "${job.title}"`);
        const trLen = (result.tailoredResume || "").trim().length;
        const clLen = (result.coverLetter || "").trim().length;
        console.log(`[SmartApply] ✅ [5/6] tailoredResume=${trLen}c, coverLetter=${clLen}c, interviewProb=${result.interviewProbability}, hiringProb=${result.hiringProbability}`);
        if (trLen < 50 && clLen < 50) throw new Error(`AI returned empty package: tailoredResume=${trLen}c, coverLetter=${clLen}c`);

        console.log(`[SmartApply] ⏳ [6/6] Saving to Supabase (queue_id: ${queued.id})`);
        await markReady(queued.id, result);
        console.log(`[SmartApply] ✅ [6/6] Package saved — status: ready ✓`);
        succeeded++;
      } catch (e) {
        console.error(`[SmartApply] ❌ AUTO failed for "${job.title}":`, e?.code, e?.message, e);
        if (queued) await markFailed(queued.id);
      } finally {
        setAutoApplyingCount(c => Math.max(0, c - 1));
        onQueueChange?.(); // refresh Dashboard + SavedJobs after each job completes
      }
    }
    console.log(`[SmartApply] 🏁 AUTO complete: ${succeeded}/${newJobs.length} succeeded`);
    // If every job failed, surface a visible error so the user isn't left confused
    if (succeeded === 0 && newJobs.length > 0) {
      setError(t("jobSearch.smartApplyFailed"));
    }
  };

  const toggleSave = (job) => {
    const s = savedJobs.find(j => j.job_id === job.id);
    if (s) {
      setSavedJobs(p => p.filter(j => j.job_id !== job.id));
      purgeQueueByJobId(job.id); // remove stale queue entry so it doesn't linger in Saved Jobs
    } else {
      setSavedJobs(p => [{ job_id: job.id, ...job, saved_at: new Date().toISOString() }, ...p]);
      if (resume.trim() && profile?.id) autoSmartApply([job]); // generate package immediately (fire and forget)
    }
  };
  const isSaved = (id) => savedJobs.some(j => j.job_id === id);
  const addTracker = async (job) => {
    const newApp = { id: uid(), company: job.company, jobTitle: job.title, status: "Applied", date: new Date().toISOString().split("T")[0], notes: "", url: job.applyUrl };
    try { await insertApplicationRow(profile.id, newApp); } catch (e) { console.error("[JobSearch] addTracker DB insert failed:", e.message); }
    setApplications(p => [newApp, ...p]);
  };
  const fmtSalary = (min, max) => { if (!min && !max) return t("jobSearch.salaryNotListed"); const f = n => `$${Math.round(n/1000)}K`; if (min && max) return `${f(min)} – ${f(max)}`; return min ? `${f(min)}+` : t("jobSearch.upTo").replace("{v}", f(max)); };
  const matchColor = s => s >= 85 ? C.green : s >= 70 ? C.yellow : C.red;

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 6 }}>{t("jobSearch.heading")}</h1>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24 }}>{t("jobSearch.subtitle")}</p>
      <Card style={{ marginBottom: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 14 }} className="three-col">
          <Input label={t("jobSearch.jobTitleLabel")} placeholder={t("jobSearch.jobTitlePlaceholder")} value={filters.title} onChange={e => setFilters(f => ({ ...f, title: e.target.value }))} onKeyDown={e => e.key === "Enter" && search()} />
          <Select label={t("jobSearch.countryLabel")} value={filters.country} onChange={e => setFilters(f => ({ ...f, country: e.target.value }))}>
            {JS_COUNTRY_OPTIONS.map(c => <option key={c} value={c}>{t(`jobSearch.${JS_COUNTRY_LABEL_KEY[c]}`)}</option>)}
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
          {autoApplyingCount > 0 && <span style={{ color: C.purple, fontSize: 13 }}>✨ AI is preparing {autoApplyingCount} application{autoApplyingCount !== 1 ? "s" : ""}…</span>}
          <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
            <Btn variant={resume ? "green" : "secondary"} onClick={() => setShowResume(!showResume)}>📄 {resume ? t("jobSearch.resumeAdded") : t("jobSearch.addResumeForMatch")}</Btn>
            <Btn onClick={() => search(false)} loading={loading} style={{ padding: "12px 28px" }}>{loading ? t("jobSearch.searching") : t("jobSearch.searchJobs")}</Btn>
          </div>
        </div>
        {showResume && <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.textMid, marginBottom: 10 }}>{t("jobSearch.yourResumeForMatch")}</div>

          <input ref={resumeFileRef} type="file" accept=".pdf,.docx,.doc,.txt" style={{ display: "none" }} onChange={handleResumeUpload} />

          {/* Centered drag & drop upload area */}
          <div
            onClick={() => resumeFileRef.current.click()}
            onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setDragActive(true); }}
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setDragActive(true); }}
            onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setDragActive(false); }}
            onDrop={handleResumeDrop}
            style={{
              border: `1.5px solid ${dragActive ? C.purple : C.border}`,
              background: dragActive ? C.purpleLight : (resumeFileName ? C.greenLight : C.bgSoft),
              borderRadius: 9,
              padding: "28px 20px",
              textAlign: "center",
              cursor: "pointer",
              transition: "all 0.15s ease",
              marginBottom: 14,
              boxSizing: "border-box",
            }}
          >
            {uploadingResume ? (
              <div style={{ color: C.purple, fontWeight: 600, fontSize: 15 }}>{t("jobSearch.extractingText")}</div>
            ) : resumeFileName ? (
              <div>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: C.green, color: "#fff", padding: "5px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{t("jobSearch.resumeLoaded")}</div>
                <div style={{ color: C.text, fontWeight: 600, fontSize: 14 }}>📄 {resumeFileName}</div>
                <div style={{ color: C.textMuted, fontSize: 12, marginTop: 4 }}>{t("jobSearch.clickOrDropReplace")}</div>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 26, marginBottom: 6 }}>⬆️</div>
                <div style={{ color: C.purple, fontWeight: 700, fontSize: 16, marginBottom: 4 }}>{t("jobSearch.uploadResume")}</div>
                <div style={{ color: C.textMuted, fontSize: 13 }}>{t("jobSearch.dragDropHint")}</div>
              </div>
            )}
          </div>

          {/* Saved resume picker — select from user_resumes library */}
          {(resumes || []).length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.textMid, marginBottom: 8 }}>Or select a saved resume:</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(resumes || []).map(r => (
                  <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: selectedResumeId === r.id ? C.purpleLight : C.bgSoft, border: `1px solid ${selectedResumeId === r.id ? C.purple : C.border}`, borderRadius: 9, padding: "8px 12px", flexWrap: "wrap" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{r.name}{r.is_default && <span style={{ marginLeft: 6, fontSize: 10, color: C.purple, fontWeight: 700 }}>Default</span>}</div>
                      <div style={{ fontSize: 11, color: C.textMuted }}>{new Date(r.created_at).toLocaleDateString()}</div>
                    </div>
                    <Btn variant={selectedResumeId === r.id ? "secondary" : "ghost"} style={{ padding: "5px 12px", fontSize: 12, flexShrink: 0 }} onClick={() => { setResume(r.content || ""); setResumeFileName(r.name); setSelectedResumeId(r.id); }}>
                      {selectedResumeId === r.id ? "Selected ✓" : "Select"}
                    </Btn>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Resume textarea */}
          <textarea style={{ width: "100%", minHeight: 180, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.7, padding: "14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} placeholder={t("jobSearch.resumeTextareaPlaceholder")} value={resume} onChange={e => { setResume(e.target.value); if (resumeFileName) setResumeFileName(""); if (selectedResumeId) setSelectedResumeId(null); }} />
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>{resume ? t("jobSearch.wordCount").replace("{n}", resume.split(/\s+/).filter(Boolean).length) : t("jobSearch.extractTip")}</div>
          {resume && <Btn variant="green" style={{ marginTop: 10 }} onClick={() => setShowResume(false)}>{t("jobSearch.saveAndClose")}</Btn>}
        </div>}
      </Card>

      {loading && jobs.length === 0 && <Spinner steps={[t("jobSearch.step1"), t("jobSearch.step2"), t("jobSearch.step3")]} currentStep={1} />}
      {searched && !loading && jobs.length === 0 && <Card style={{ textAlign: "center", padding: 48 }}><div style={{ fontSize: 36, marginBottom: 12 }}>🔍</div><div style={{ fontWeight: 700, fontSize: 16 }}>{t("jobSearch.noResultsFound")}</div><div style={{ color: C.textMuted, marginTop: 6 }}>{t("jobSearch.tryDifferentKeywords")}</div></Card>}

      {jobs.length > 0 && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 14, color: C.textMuted, fontWeight: 500 }}>
              {t("jobSearch.jobsFoundFor").replace("{n}", jobs.length)}"<strong style={{ color: C.text }}>{filters.title}</strong>"
              {sourceCounts && <span style={{ marginLeft: 10, fontSize: 12 }}>
                <span style={{ color: C.blue }}>Adzuna: {sourceCounts.adzuna}</span>
                {" · "}
                <span style={{ color: C.purple }}>JSearch: {sourceCounts.rapidapi}</span>
              </span>}
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {jobs.map(job => {
              const mr = matchResults[job.id];
              const displayMatch = mr ? mr.matchScore : job.matchScore;
              return (
                <Card key={job.id} style={{ ...(mr ? { border: `1.5px solid ${matchColor(mr.matchScore)}30` } : {}) }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                    <div style={{ flex: 1, minWidth: 220 }}>
                      <div style={{ display: "flex", gap: 6, marginBottom: 10, flexWrap: "wrap", alignItems: "center" }}>
                        <Badge color={C.blue}>{job.source}</Badge>
                        {job.remote && <Badge color={C.green}>{t("jobSearch.remoteBadge")}</Badge>}
                        <Badge color={C.textMuted}>{job.employmentType}</Badge>
                        {job.experienceLevel && <Badge color={C.purple}>{job.experienceLevel}</Badge>}
                        <span style={{ marginLeft: "auto", background: `${matchColor(displayMatch)}15`, color: matchColor(displayMatch), border: `1px solid ${matchColor(displayMatch)}30`, borderRadius: 20, padding: "3px 12px", fontSize: 12, fontWeight: 800 }}>{t("jobSearch.matchSuffix").replace("{v}", displayMatch)}</span>
                      </div>
                      <div style={{ fontSize: 17, fontWeight: 800, color: C.text, marginBottom: 4 }}>{job.title}</div>
                      <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 6 }}>{job.company} · {job.location}</div>
                      <div style={{ fontSize: 14, color: C.green, fontWeight: 700, marginBottom: 10 }}>{fmtSalary(job.salaryMin, job.salaryMax)}</div>
                      <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.7, marginBottom: 10 }}>{job.description?.slice(0, 200)}…</div>
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>{job.skills?.slice(0, 5).map(s => <span key={s} style={{ background: C.purpleLight, color: C.purple, borderRadius: 6, padding: "3px 9px", fontSize: 12, fontWeight: 600 }}>{s}</span>)}</div>
                      <div style={{ fontSize: 11, color: C.textMuted }}>{t("jobSearch.posted")} {job.datePosted ? new Date(job.datePosted).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : t("jobSearch.recently")}</div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, flexShrink: 0, minWidth: 120 }}>
                      <a href={job.applyUrl} target="_blank" rel="noreferrer" className="btn-link" style={{ background: `linear-gradient(135deg,${C.purple},${C.purpleMid})`, color: "#fff", border: "none", borderRadius: 10, padding: "11px 22px", fontSize: 14, fontWeight: 700, textDecoration: "none", textAlign: "center", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, transition: "all 0.15s" }}>{t("jobSearch.applyNow")}</a>
                      <Btn variant="secondary" style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => analyzeMatch(job)} loading={analyzing === job.id}>{analyzing === job.id ? t("jobSearch.analyzing") : t("jobSearch.aiMatch")}</Btn>
                      <Btn variant={isSaved(job.id) ? "danger" : "secondary"} style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => toggleSave(job)}>{isSaved(job.id) ? t("jobSearch.saved") : t("jobSearch.saveJob")}</Btn>
                      {isTracked(job)
                        ? <Btn variant="ghost" disabled style={{ fontSize: 13, padding: "9px 14px", opacity: 1, color: C.green }}>{t("jobSearch.tracked")}</Btn>
                        : <Btn variant="secondary" style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => addTracker(job)}>{t("jobSearch.track")}</Btn>}
                      {isSmartApplied(job)
                        ? <Btn variant="ghost" disabled style={{ fontSize: 13, padding: "9px 14px", opacity: 1, color: C.green }}>{t("jobSearch.smartApplied")}</Btn>
                        : <Btn variant="secondary" style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => smartApply(job)} loading={smartApplying === job.id}>{smartApplying === job.id ? t("jobSearch.preparing") : t("jobSearch.smartApply")}</Btn>}
                    </div>
                  </div>
                  {mr && (
                    <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
                      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 8 }}>{mr.summary}</div>
                      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                        {[[t("jobSearch.match"), mr.matchScore], [t("jobSearch.ats"), mr.atsScore], [t("jobSearch.interviewPct"), mr.interviewProbability]].map(([l, v]) => (
                          <div key={l} style={{ flex: 1, minWidth: 80 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}><span style={{ color: C.textMuted }}>{l}</span><span style={{ color: matchColor(v), fontWeight: 700 }}>{v}%</span></div>
                            <PBar val={v} color={matchColor(v)} />
                          </div>
                        ))}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }} className="two-col">
                        <div style={{ background: C.greenLight, borderRadius: 8, padding: 10 }}><div style={{ fontSize: 11, color: C.green, fontWeight: 700, marginBottom: 6 }}>{t("jobSearch.youHave")}</div><div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{mr.matchingSkills?.map(s => <Badge key={s} color={C.green}>{s}</Badge>)}</div></div>
                        <div style={{ background: C.redLight, borderRadius: 8, padding: 10 }}><div style={{ fontSize: 11, color: C.red, fontWeight: 700, marginBottom: 6 }}>{t("jobSearch.youNeed")}</div><div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{mr.missingSkills?.map(s => <Badge key={s} color={C.red}>{s}</Badge>)}</div></div>
                      </div>
                    </div>
                  )}
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

// ─── INTERVIEW PAGE ────────────────────────────────────────
function InterviewPage({ profile, applications, savedJobs }) {
  const { t } = useI18n();
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

  const { session, loading: sessionLoading, loadedFor: sessionLoadedFor, save: saveSession, clear: clearSessionRow } = useInterviewSession(profile?.id);
  const [loadApplied, setLoadApplied] = useState(false);
  const appliedForRef = useRef(undefined);
  const saveTimerRef = useRef(null);

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
    if (!loadApplied || !questions.length) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveSession({ questions, jobDesc, resume, resumeFileName, savedFeedback, mockAnswers, mockSummary, mode, mockIdx, mockAnswerDraft, activeQ, showReview }).catch(() => {});
    }, 600);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [loadApplied, questions, jobDesc, resume, resumeFileName, savedFeedback, mockAnswers, mockSummary, mode, mockIdx, mockAnswerDraft, activeQ, showReview, saveSession]);

  const clearSession = () => {
    clearSessionRow().catch(() => {});
    setQuestions([]); setJobDesc(""); setActiveQ(null); setFeedback(null);
    setSavedFeedback({}); setMockAnswers({}); setMockSummary(null); setMode("browse"); setShowReview(false);
    setMockIdx(0); setRestored(false); setError("");
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
${jobDesc.slice(0, 2500)}${resumeBlock}`, 8000);
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
{"score":<1-10>,"strengths":["<s1>","<s2>"],"improvements":["<i1>","<i2>"],"revisedAnswer":"<stronger version using STAR if behavioral>"}
QUESTION:${question.question}${jdBlock}${resumeBlock}
CANDIDATE ANSWER:${ans.slice(0, 800)}`, 1200);
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
    setMockSummary({
      answered: answeredCount,
      skipped: mockQuestions.length - answeredCount,
      total: mockQuestions.length,
      avgScore: avg,
    });
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
        {questions.length > 0 && <Btn variant="secondary" onClick={clearSession}>{t("interview.clearSession")}</Btn>}
      </div>

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
                    <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}><Badge color={C.purple}>{tCat(q.category)}</Badge><Badge color={diffColor[q.difficulty]}>{q.difficulty}</Badge>{q.star && <Badge color={C.blue}>{t("interview.starBadge")}</Badge>}{savedFeedback[q.id] && <Badge color={C.green}>✓ Practiced ({savedFeedback[q.id].feedback?.score}/10)</Badge>}</div>
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
              <div style={{ display: "flex", gap: 10 }}>
                <Btn onClick={submitMockAnswer} disabled={!mockAnswerDraft.trim()} loading={mockLoading}>{mockLoading ? t("interview.scoringBtn") : (mockIdx + 1 < mockQuestions.length ? t("interview.submitNext") : t("interview.submitFinish"))}</Btn>
                <Btn variant="secondary" onClick={skipMock} disabled={mockLoading}>{t("interview.skipBtn")}</Btn>
              </div>
            </Card>
          )}

          {mockSummary && !showReview && (
            <Card style={{ textAlign: "center", padding: 40 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: C.text, marginBottom: 8 }}>{t("interview.mockComplete")}</div>
              <div style={{ fontSize: 48, fontWeight: 800, color: mockSummary.avgScore >= 8 ? C.green : mockSummary.avgScore >= 6 ? C.yellow : C.red, marginBottom: 4 }}>{mockSummary.avgScore}/10</div>
              <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 18 }}>{t("interview.avgScore").replace("{count}", mockSummary.answered)}</div>
              <div style={{ display: "flex", gap: 20, justifyContent: "center", marginBottom: 24 }}>
                <div><div style={{ fontSize: 24, fontWeight: 800, color: C.green }}>{mockSummary.answered}</div><div style={{ fontSize: 12, color: C.textMuted }}>{t("interview.answered")}</div></div>
                <div><div style={{ fontSize: 24, fontWeight: 800, color: C.yellow }}>{mockSummary.skipped}</div><div style={{ fontSize: 12, color: C.textMuted }}>{t("interview.skipped")}</div></div>
                <div><div style={{ fontSize: 24, fontWeight: 800, color: C.text }}>{mockSummary.total}</div><div style={{ fontSize: 12, color: C.textMuted }}>{t("interview.total")}</div></div>
                <div><div style={{ fontSize: 24, fontWeight: 800, color: C.purple }}>{mockSummary.total ? Math.round((mockSummary.answered / mockSummary.total) * 100) : 0}%</div><div style={{ fontSize: 12, color: C.textMuted }}>{t("interview.complete")}</div></div>
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                <Btn onClick={() => setShowReview(true)}>{t("interview.reviewAnswers")}</Btn>
                <Btn variant="secondary" onClick={() => { setMockIdx(0); setMockSummary(null); setMockAnswers({}); setShowReview(false); }}>{t("interview.retryMock")}</Btn>
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
                  return (
                    <Card key={q.id}>
                      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                        <Badge color={C.purple}>{tCat(q.category)}</Badge>
                        <Badge color={diffColor[q.difficulty]}>{q.difficulty}</Badge>
                        {ans ? <Badge color={C.green}>✓ Answered {ans.feedback?.score ? `(${ans.feedback.score}/10)` : ""}</Badge> : <Badge color={C.textMuted}>⊘ {t("interview.skippedBadge")}</Badge>}
                      </div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 10, lineHeight: 1.4 }}>Q{i + 1}. {q.question}</div>
                      {ans ? (
                        <div>
                          <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, marginBottom: 4 }}>{t("interview.yourAnswerLabel")}</div>
                          <div style={{ background: C.bgSoft, borderRadius: 8, padding: "12px 14px", fontSize: 14, lineHeight: 1.7, color: C.text, whiteSpace: "pre-wrap", marginBottom: ans.feedback ? 12 : 0 }}>{ans.answer}</div>
                          {ans.feedback && (
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }} className="two-col">
                              <div style={{ background: C.greenLight, borderRadius: 8, padding: 12 }}><div style={{ fontSize: 11, color: C.green, fontWeight: 700, marginBottom: 6 }}>{t("interview.strengths")}</div>{(ans.feedback.strengths || []).map((s, j) => <div key={j} style={{ fontSize: 12, color: C.text, marginBottom: 4, lineHeight: 1.5 }}>• {s}</div>)}</div>
                              <div style={{ background: C.yellowLight, borderRadius: 8, padding: 12 }}><div style={{ fontSize: 11, color: C.yellow, fontWeight: 700, marginBottom: 6 }}>{t("interview.improve")}</div>{(ans.feedback.improvements || []).map((s, j) => <div key={j} style={{ fontSize: 12, color: C.text, marginBottom: 4, lineHeight: 1.5 }}>• {s}</div>)}</div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div style={{ fontSize: 13, color: C.textMuted, fontStyle: "italic" }}>{t("interview.skippedMsg")}</div>
                      )}
                      {!ans && <div style={{ background: C.bgSoft, borderRadius: 8, padding: "12px 14px", fontSize: 14, lineHeight: 1.7, color: C.text, whiteSpace: "pre-wrap", marginTop: 6 }}>{q.strongAnswer}</div>}
                    </Card>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
                <Btn variant="secondary" onClick={() => { setMode("browse"); setMockSummary(null); setShowReview(false); }}>{t("interview.backToList")}</Btn>
                <Btn onClick={() => { setMockIdx(0); setMockSummary(null); setMockAnswers({}); setShowReview(false); }}>{t("interview.retryMock")}</Btn>
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
              <Btn onClick={getFeedback} disabled={!answer.trim()} loading={fbLoading}>{fbLoading ? t("interview.analyzing") : t("interview.getFeedback")}</Btn>
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
const SCOLOR = { Applied: C.blue, "Phone Screen": C.yellow, Interview: C.purple, "Final Interview": "#7C3AED", Offer: C.green, Rejected: C.red, Withdrawn: "#9333EA", Ghosted: C.textMuted };

const STATUS_LABEL_KEY = { Applied: "statusApplied", "Phone Screen": "statusPhoneScreen", Interview: "statusInterview", "Final Interview": "statusFinalInterview", Offer: "statusOffer", Rejected: "statusRejected", Withdrawn: "statusWithdrawn", Ghosted: "statusGhosted" };

function TrackerPage({ applications, deleteApplication, saveApplication, resumes }) {
  const { t } = useI18n();
  const tStatus = s => t(`tracker.${STATUS_LABEL_KEY[s]}`, s);
  const [showForm, setShowForm] = useState(false); const [editId, setEditId] = useState(null); const [form, setForm] = useState({ company: "", jobTitle: "", status: "Applied", date: new Date().toISOString().split("T")[0], atsScore: "", notes: "", url: "", followUpDate: "", contactName: "", contactEmail: "" }); const [filterStatus, setFilterStatus] = useSessionState("cp_tracker_filter", "All"); const [viewApp, setViewApp] = useState(null);
  const [formErrors, setFormErrors] = useState({});
  const [search, setSearch] = useSessionState("cp_tracker_search", "");
  const [deleteError, setDeleteError] = useState("");
  const [deletingId, setDeletingId] = useState(null);
  const [saveError, setSaveError] = useState("");
  const [saving, setSaving] = useState(false);

  const blankForm = { company: "", jobTitle: "", status: "Applied", date: new Date().toISOString().split("T")[0], atsScore: "", notes: "", url: "", followUpDate: "", contactName: "", contactEmail: "" };

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

    if (Object.keys(errors).length > 0) { setFormErrors(errors); return; }
    setFormErrors({});
    setSaveError("");

    const cleanForm = { ...form, atsScore: atsClean };
    const fullApp = editId
      ? { ...(applications.find(a => a.id === editId) || {}), ...cleanForm }
      : { ...cleanForm, id: uid() };

    setSaving(true);
    try {
      await saveApplication(fullApp); // DB upsert + root setApplications
      setEditId(null);
      setForm(blankForm);
      setShowForm(false);
    } catch {
      setSaveError(t("tracker.saveFailed") || "Save failed. Please try again.");
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
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 10 }}>
        <div><h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 4 }}>{t("tracker.heading")}</h1><p style={{ color: C.textMuted, fontSize: 15 }}>{t("tracker.applicationsTracked").replace("{n}", applications.length)}</p></div>
        <Btn onClick={() => { setShowForm(true); setEditId(null); }} style={{ padding: "12px 24px" }}>{t("tracker.addApplication")}</Btn>
      </div>
      {applications.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 16, overflowX: "auto", paddingBottom: 4 }}>
          <div onClick={() => setFilterStatus("All")} style={{ cursor: "pointer", background: `${C.purple}12`, border: `1.5px solid ${filterStatus === "All" ? C.purple : C.purple + "30"}`, borderRadius: 12, padding: "10px 18px", flexShrink: 0, textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 800, color: C.purple }}>{applications.length}</div><div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{t("tracker.total")}</div></div>
          {STATUSES.filter(s => stats[s] > 0).map(s => <div key={s} onClick={() => setFilterStatus(filterStatus === s ? "All" : s)} style={{ cursor: "pointer", background: `${SCOLOR[s]}12`, border: `1.5px solid ${filterStatus === s ? SCOLOR[s] : SCOLOR[s] + "30"}`, borderRadius: 12, padding: "10px 18px", flexShrink: 0, textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 800, color: SCOLOR[s] }}>{stats[s]}</div><div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{tStatus(s)}</div></div>)}
          {successRate !== null && <div style={{ background: `${C.green}12`, border: `1.5px solid ${C.green}40`, borderRadius: 12, padding: "10px 18px", flexShrink: 0, textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 800, color: C.green }}>{successRate}%</div><div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{t("tracker.successRate")}</div></div>}
        </div>
      )}
      {applications.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder={t("tracker.searchPlaceholder")} style={{ width: "100%", border: `1.5px solid ${C.border}`, borderRadius: 9, padding: "10px 14px", fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit" }} />
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {["All", ...STATUSES].map(s => <Btn key={s} variant="ghost" style={{ padding: "6px 14px", borderRadius: 8, border: `1.5px solid ${filterStatus === s ? SCOLOR[s] || C.purple : C.border}`, background: filterStatus === s ? `${SCOLOR[s] || C.purple}12` : "#fff", color: filterStatus === s ? SCOLOR[s] || C.purple : C.textMuted, fontSize: 12, fontWeight: 600 }} onClick={() => setFilterStatus(s)}>{s === "All" ? t("tracker.all") : tStatus(s)}</Btn>)}
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
            <Select label={t("tracker.statusLabel")} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>{STATUSES.map(s => <option key={s} value={s}>{tStatus(s)}</option>)}</Select>
            <Input label={t("tracker.dateAppliedLabel")} type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
            <div><Input label={t("tracker.followUpDateLabel")} type="date" value={form.followUpDate} onChange={e => setForm(f => ({ ...f, followUpDate: e.target.value }))} style={formErrors.followUpDate ? { borderColor: C.red } : {}} />{formErrors.followUpDate && <div style={{ fontSize: 12, color: C.red, marginTop: 4 }}>{formErrors.followUpDate}</div>}</div>
            <div><Input label={t("tracker.atsScoreLabel")} type="number" min="0" max="100" placeholder={t("tracker.atsScorePlaceholder")} value={form.atsScore} onChange={e => setForm(f => ({ ...f, atsScore: e.target.value }))} style={formErrors.atsScore ? { borderColor: C.red } : {}} />{formErrors.atsScore && <div style={{ fontSize: 12, color: C.red, marginTop: 4 }}>{formErrors.atsScore}</div>}</div>
            <Input label={t("tracker.contactNameLabel")} placeholder={t("tracker.contactNamePlaceholder")} value={form.contactName} onChange={e => setForm(f => ({ ...f, contactName: e.target.value }))} />
            <Input label={t("tracker.contactEmailLabel")} placeholder={t("tracker.contactEmailPlaceholder")} value={form.contactEmail} onChange={e => setForm(f => ({ ...f, contactEmail: e.target.value }))} />
            <div style={{ gridColumn: "1 / -1" }}><Input label={t("tracker.jobUrlLabel")} placeholder={t("tracker.jobUrlPlaceholder")} value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} /></div>
          </div>
          <div style={{ marginBottom: 16 }}><Textarea label={t("tracker.notesLabel")} placeholder={t("tracker.notesPlaceholder")} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ minHeight: 200 }} /></div>
          <div style={{ display: "flex", gap: 10 }}><Btn onClick={save} disabled={saving}>{saving ? "Saving…" : t("tracker.saveApplication")}</Btn><Btn variant="secondary" onClick={closeForm} disabled={saving}>{t("tracker.cancel")}</Btn></div>
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
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {app.atsScore > 0 && <span style={{ fontSize: 12, color: C.blue, fontWeight: 700, background: C.blueLight, padding: "3px 9px", borderRadius: 6 }}>ATS {app.atsScore}</span>}
                <Badge color={SCOLOR[app.status] || C.textMuted}>{app.status ? tStatus(app.status) : t("tracker.statusUnknown")}</Badge>
                {(app.resume || app.coverLetter || app.notes) && <Btn variant="ghost" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => setViewApp(viewApp?.id === app.id ? null : app)}>{t("tracker.view")}</Btn>}
                {app.url && <a href={app.url} target="_blank" rel="noreferrer" className="btn-link" style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, background: "transparent", padding: "5px 12px", border: `1px solid ${C.border}`, borderRadius: 10, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>{t("tracker.job")}</a>}
                <Btn variant="ghost" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => edit(app)}>{t("tracker.edit")}</Btn>
                <Btn variant="danger" style={{ padding: "5px 12px", fontSize: 12 }} loading={deletingId === app.id} onClick={() => del(app.id)}>✕</Btn>
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
${form.jobTitle} in ${form.location}, ${form.experience || "any"} exp, skills: ${form.skills || "general"}${companyBlock}`, 2500);
      const parsed = safeParse(raw);
      if (!parsed || !parsed.salaryRange) {
        setError(t("salary.incompleteData"));
      } else {
        setResults(parsed);
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
              {[[t("salary.totalCompMedian"), fmt(results.totalComp?.median), C.purple], [t("salary.equity"), txt(results.equityRange), C.yellow], [t("salary.bonus"), txt(results.bonusRange), C.green], [t("salary.marketDemand"), txt(results.demandLevel), C.blue]].map(([l, v, c]) => (
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
function NetworkingPage({ profile, applications, savedJobs }) {
  const { t } = useI18n();
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
    const contact = {
      id: uid(),
      name: form.targetName || "",
      company: form.targetCompany || "",
      role: form.targetRole || "",
      email: emailTo || "",
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
    if (!exists) setSavedContacts(p => [contact, ...p]);
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
                <input value={emailTo} onChange={e => setEmailTo(e.target.value)} placeholder="name@company.com" style={{ width: "100%", background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 14, padding: "12px 14px", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
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
                <span style={{ fontSize: 12, color: C.textMuted }}>{t("networking.emailDisclaimer")}</span>
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

                        {/* Generated follow-up for this contact */}
                        {fuContact?.id === c.id && (
                          <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 12, background: "#fff" }}>
                            {fuLoading && <div style={{ color: C.purple, fontSize: 13, fontWeight: 600 }}>{t("networking.generatingFollowup")}</div>}
                            {!fuLoading && fuDraft && (
                              <div>
                                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><Label>{t("networking.followupMessageLabel")}</Label><CopyBtn text={fuDraft} label={t("networking.copyBtn")} /></div>
                                <textarea value={fuDraft} onChange={e => setFuDraft(e.target.value)} style={{ width: "100%", minHeight: 120, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.7, padding: "14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} />
                                {c.email && <div style={{ marginTop: 10 }}><a href={`mailto:${encodeURIComponent(c.email)}?subject=Re: ${encodeURIComponent(c.subject || "")}&body=${encodeURIComponent(fuDraft)}`} style={{ textDecoration: "none" }}><Btn variant="primary" style={{ fontSize: 13 }}>{t("networking.sendFollowupBtn")}</Btn></a></div>}
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
    </div>
  );
}

// ─── SAVED JOBS ────────────────────────────────────────────
function SwipeToApply({ onApply, applying, justApplied }) {
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
    return <div style={{ background: C.green, color: "#fff", borderRadius: 10, padding: "10px 20px", fontWeight: 700, fontSize: 14, textAlign: "center", minWidth: 120 }}>✓ Applied</div>;
  }
  const progress = Math.min(1, offset / THRESHOLD);
  return (
    <div style={{ position: "relative", borderRadius: 10, overflow: "hidden", background: C.green, height: 40, minWidth: 140, userSelect: "none", touchAction: "pan-y", cursor: "pointer" }}
      onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", paddingLeft: 16, color: "#fff", fontSize: 13, fontWeight: 700, opacity: progress }}>✓ Applied</div>
      <div style={{ position: "absolute", left: offset, top: 0, bottom: 0, width: "100%", background: "#fff", display: "flex", alignItems: "center", justifyContent: "center", gap: 6, fontSize: 13, fontWeight: 700, color: C.text, borderRadius: 10, boxShadow: "0 2px 8px rgba(0,0,0,0.12)", transition: swiping ? "none" : "left 0.2s ease" }}>
        {applying ? "Applying…" : "Swipe to Apply →"}
      </div>
    </div>
  );
}

function PackageView({ item, resumes }) {
  const { t } = useI18n();
  const selectedResumeName = resumes && item.resume_id ? (resumes.find(r => r.id === item.resume_id)?.name || null) : null;
  const statusLabel = { ready: t("savedJobs.statusReady"), applied: t("savedJobs.statusApplied") }[item.status] || item.status;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 10, padding: "12px 16px" }}>
        <div style={{ fontSize: 10, fontWeight: 800, color: C.purple, letterSpacing: 1, marginBottom: 8 }}>APPLICATION PACKAGE</div>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 2 }}>{item.job_title} — {item.company}</div>
        {selectedResumeName && <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 6 }}>Resume: {selectedResumeName}</div>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Badge color={C.green}>{statusLabel}</Badge>
          {item.interview_probability != null && <Badge color={C.purple}>{t("savedJobs.interviewLabel").replace("{pct}", item.interview_probability)}</Badge>}
          {item.hiring_probability != null && <Badge color={C.green}>{t("savedJobs.hiringLabel").replace("{pct}", item.hiring_probability)}</Badge>}
        </div>
      </div>
      {item.missing_skills?.length > 0 && (
        <div>
          <div style={{ fontSize: 12, color: C.red, fontWeight: 700, marginBottom: 6 }}>{t("savedJobs.missingSkills")}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{item.missing_skills.map(s => <Badge key={s} color={C.red}>{s}</Badge>)}</div>
        </div>
      )}
      {item.cover_letter && (
        <div>
          <Label>{t("savedJobs.coverLetter")}</Label>
          <ContentDisplay content={item.cover_letter} />
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <CopyBtn text={item.cover_letter} label="Copy" />
            <Btn variant="ghost" style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => downloadPDF(item.cover_letter, "cover-letter")}>Download PDF</Btn>
            <Btn variant="ghost" style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => downloadDOCX(item.cover_letter, "cover-letter")}>Download DOCX</Btn>
          </div>
        </div>
      )}
      {item.tailored_resume && (
        <div>
          <Label>{t("savedJobs.tailoredResume")}</Label>
          <ContentDisplay content={item.tailored_resume} />
          <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
            <CopyBtn text={item.tailored_resume} label="Copy" />
            <Btn variant="ghost" style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => downloadPDF(item.tailored_resume, "tailored-resume")}>Download PDF</Btn>
            <Btn variant="ghost" style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => downloadDOCX(item.tailored_resume, "tailored-resume")}>Download DOCX</Btn>
          </div>
        </div>
      )}
      {item.recruiter_message && <div><Label>{t("savedJobs.recruiterMessage")}</Label><ContentDisplay content={item.recruiter_message} /></div>}
      {item.networking_message && <div><Label>{t("savedJobs.networkingMessage")}</Label><ContentDisplay content={item.networking_message} /></div>}
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
            <Label>💰 Salary Insight</Label>
            <div style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
              {(low || med || high) && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 8, letterSpacing: 0.5 }}>MARKET RANGE</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {[["Low", low, C.yellow], ["Median", med, C.green], ["High", high, C.blue]].filter(([, v]) => v).map(([label, val, color]) => (
                      <div key={label} style={{ flex: 1, background: `${color}12`, border: `1px solid ${color}30`, borderRadius: 8, padding: "8px 6px", textAlign: "center" }}>
                        <div style={{ fontSize: 15, fontWeight: 800, color }}>{val}</div>
                        <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 600, marginTop: 2 }}>{label}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {si.userPositioning && <div><div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 4, letterSpacing: 0.5 }}>YOUR POSITIONING</div><div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>{si.userPositioning}</div></div>}
              {si.negotiationLeverage && <div><div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 4, letterSpacing: 0.5 }}>NEGOTIATION LEVERAGE</div><div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>{si.negotiationLeverage}</div></div>}
              {si.benchmarks?.length > 0 && <div><div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 6, letterSpacing: 0.5 }}>BENCHMARKS</div><div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{si.benchmarks.map((b, i) => <Badge key={i} color={C.textMuted}>{b}</Badge>)}</div></div>}
            </div>
          </div>
        );
      })()}
      {item.company_insight && (() => {
        const ci = item.company_insight;
        const trendColor = ci.hiringTrend === "growing" ? C.green : ci.hiringTrend === "shrinking" ? C.red : C.yellow;
        const trendLabel = ci.hiringTrend === "growing" ? "↑ Growing" : ci.hiringTrend === "shrinking" ? "↓ Shrinking" : "→ Stable";
        return (
          <div>
            <Label>🏢 Company Insight</Label>
            <div style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
              {ci.hiringTrend && <div style={{ display: "flex", alignItems: "center", gap: 8 }}><div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: 0.5 }}>HIRING TREND</div><Badge color={trendColor}>{trendLabel}</Badge></div>}
              {ci.culture && <div><div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 4, letterSpacing: 0.5 }}>CULTURE</div><div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>{ci.culture}</div></div>}
              {ci.recentNews && <div><div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 4, letterSpacing: 0.5 }}>RECENT NEWS</div><div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>{ci.recentNews}</div></div>}
              {ci.greenFlags?.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.green, marginBottom: 6, letterSpacing: 0.5 }}>GREEN FLAGS</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {ci.greenFlags.map((f, i) => <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}><span style={{ color: C.green, fontWeight: 700, flexShrink: 0, fontSize: 13 }}>✓</span><span style={{ fontSize: 13, color: C.textMid, lineHeight: 1.5 }}>{f}</span></div>)}
                  </div>
                </div>
              )}
              {ci.redFlags?.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.red, marginBottom: 6, letterSpacing: 0.5 }}>RED FLAGS</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                    {ci.redFlags.map((f, i) => <div key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}><span style={{ color: C.red, fontWeight: 700, flexShrink: 0, fontSize: 13 }}>✗</span><span style={{ fontSize: 13, color: C.textMid, lineHeight: 1.5 }}>{f}</span></div>)}
                  </div>
                </div>
              )}
              {ci.talkingPoints?.length > 0 && (
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.purple, marginBottom: 6, letterSpacing: 0.5 }}>INTERVIEW TALKING POINTS</div>
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

function MissingSkillsBadges({ skills }) {
  if (!skills?.length) return null;
  const show = skills.slice(0, 3);
  const extra = skills.length - show.length;
  const pill = { background: `${C.red}15`, color: C.red, border: `1px solid ${C.red}30`, borderRadius: 5, padding: "1px 7px", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap", flexShrink: 0 };
  return (
    <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "nowrap", overflow: "hidden", maxWidth: "100%" }}>
      <span style={{ fontSize: 11, color: C.red, fontWeight: 700, whiteSpace: "nowrap", flexShrink: 0 }}>Missing Skills:</span>
      {show.map(s => <span key={s} style={pill}>{s}</span>)}
      {extra > 0 && <span style={pill}>+{extra}</span>}
    </div>
  );
}

function SmartApplyQueueCard({ item, onApply, onRemove, onRetry, applying, retrying, resumes, justApplied }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" ? window.matchMedia("(max-width: 1024px)").matches : false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 1024px)");
    const handler = (e) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  const statusLabel = { ready: t("savedJobs.statusReady"), applied: t("savedJobs.statusApplied"), skipped: t("savedJobs.statusSkipped"), queued: t("savedJobs.statusQueued"), failed: t("savedJobs.statusFailed") }[item.status] || item.status;
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text }}>{item.job_title}</div>
            <Badge color={item.status === "ready" ? C.green : item.status === "applied" ? C.blue : item.status === "skipped" ? C.textMuted : item.status === "failed" ? C.red : C.yellow}>{statusLabel}</Badge>
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
        {(item.status === "ready" || justApplied) && (
          <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap", alignItems: "center" }}>
            {!justApplied && (
              <Btn variant="ghost" style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => setExpanded(e => !e)}>{expanded ? t("savedJobs.hideDetails") : t("savedJobs.viewDetails")}</Btn>
            )}
            {!justApplied && (
              <Btn variant="secondary" style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => onRemove(item)}>Remove</Btn>
            )}
            {isMobile ? (
              <SwipeToApply onApply={() => onApply(item)} applying={applying} justApplied={justApplied} />
            ) : justApplied ? (
              <Btn variant="green" disabled style={{ fontSize: 13, padding: "9px 14px" }}>✓ Applied</Btn>
            ) : (
              <Btn style={{ fontSize: 13, padding: "9px 14px" }} loading={applying} onClick={() => onApply(item)}>
                {applying ? "Applying…" : "Apply"}
              </Btn>
            )}
          </div>
        )}
      </div>
      {item.status === "queued" && <div style={{ fontSize: 13, color: C.textMuted, marginTop: 10 }}>{t("savedJobs.preparingApplication")}</div>}
      {item.status === "failed" && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 13, color: C.red, marginBottom: 8 }}>{t("savedJobs.generationFailed")}</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Btn variant="secondary" style={{ fontSize: 13, padding: "9px 14px" }} loading={retrying} onClick={() => onRetry(item)}>{t("savedJobs.retryGeneration")}</Btn>
            <Btn variant="ghost" style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => onRemove(item)}>Remove</Btn>
          </div>
        </div>
      )}
      {expanded && item.status === "ready" && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
          <PackageView item={item} resumes={resumes} />
        </div>
      )}
    </Card>
  );
}

function SavedJobsPage({ savedJobs, setSavedJobs, setApplications, profile, resumes, onQueueChange, queue, queueLoading, markApplied, markReady, markFailed, resetToQueued, skip, purgeQueueByJobId, enqueue }) {
  const { t } = useI18n();
  const fmtSalary = (min, max) => { if (!min && !max) return t("savedJobs.salaryNotListed"); const f = n => `$${Math.round(n/1000)}K`; if (min && max) return `${f(min)} – ${f(max)}`; return min ? `${f(min)}+` : t("savedJobs.salaryUpTo").replace("{v}", f(max)); };
  const fmtDate = (str) => { if (!str) return ""; try { return new Date(str).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }); } catch { return ""; } };

  const [applyingId, setApplyingId] = useState(null);
  const [appliedId, setAppliedId] = useState(null);
  const [retryingId, setRetryingId] = useState(null);
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

  const visibleQueue = queue.filter(q => (q.status !== "applied" && q.status !== "skipped") || q.id === appliedId);

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
    } catch { setQueueError("Failed to remove. Please try again."); }
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
      const raw = await askClaude(`You are an expert job application assistant. Given this candidate's resume and job, produce a complete application package. Return ONLY valid JSON, no markdown:
{"tailoredResume":"<resume rewritten and optimized for this specific job, full text>","coverLetter":"<professional 3 paragraph cover letter for this job>","recruiterMessage":"<short personalized LinkedIn message to a recruiter at this company, 2-3 sentences>","networkingMessage":"<short message to a potential referral contact at this company, 2-3 sentences>","missingSkills":["<skill1>","<skill2>","<skill3>"],"interviewProbability":<0-100>,"hiringProbability":<0-100>,"applicationQuestions":["<likely application question 1>","<likely application question 2>","<likely application question 3>"],"salaryInsight":{"marketRange":{"low":<annual USD>,"median":<annual USD>,"high":<annual USD>},"userPositioning":"<1 sentence: how candidate likely compares to market range>","negotiationLeverage":"<1 sentence: strongest leverage point for negotiation>","benchmarks":["<comparable role or location benchmark>"]},"companyInsight":{"culture":"<1-2 sentences on company culture and work environment>","recentNews":"<1-2 sentences on recent company news relevant to a job seeker>","hiringTrend":"<growing|stable|shrinking>","redFlags":["<potential concern about this role or company>"],"greenFlags":["<positive signal about this role or company>"],"talkingPoints":["<specific talking point to use in interviews or outreach>"]}}

RESUME:
${resumeText}

JOB:
Title: ${item.job_title}
Company: ${item.company}`, 8000);
      const jsonStart = raw.indexOf("{"); const jsonEnd = raw.lastIndexOf("}");
      const cleanRaw = (jsonStart >= 0 && jsonEnd > jsonStart) ? raw.slice(jsonStart, jsonEnd + 1) : raw;
      const result = JSON.parse(cleanRaw);
      const trLen = (result.tailoredResume || "").trim().length;
      const clLen = (result.coverLetter || "").trim().length;
      if (trLen < 50 && clLen < 50) throw new Error(`AI returned empty package: tailoredResume=${trLen}c, coverLetter=${clLen}c`);
      await markReady(item.id, result);
      console.log(`[SmartApply] ✅ Retry complete — status: ready ✓`);
    } catch (e) {
      console.error(`[SmartApply] ❌ RETRY failed for "${item.job_title}":`, e?.code, e?.message, e);
      await markFailed(item.id);
      setQueueError(t("savedJobs.retryError"));
    } finally {
      setRetryingId(null);
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
        <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 14 }}>Your Saved Jobs</div>
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

            // Status badge
            let statusColor = C.textMuted;
            let statusLabel = "Saved";
            if (isApplied) { statusColor = C.blue; statusLabel = "Applied"; }
            else if (activeEntry?.status === "ready") { statusColor = C.green; statusLabel = "AI Package Ready"; }
            else if (activeEntry?.status === "queued") { statusColor = C.yellow; statusLabel = "In Queue"; }
            else if (activeEntry?.status === "failed") { statusColor = C.red; statusLabel = "Generation Failed"; }

            return (
              <Card key={job.job_id}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
                      <div style={{ fontSize: 17, fontWeight: 700, color: C.text }}>{job.title}</div>
                      <Badge color={statusColor}>{statusLabel}</Badge>
                    </div>
                    <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 6 }}>{job.company}{job.location ? ` · ${job.location}` : ""}</div>
                    <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      {job.matchScore && <Badge color={C.purple}>{job.matchScore}{t("savedJobs.matchSuffix")}</Badge>}
                      {(job.salaryMin || job.salaryMax) && <span style={{ fontSize: 13, color: C.green, fontWeight: 600 }}>{fmtSalary(job.salaryMin, job.salaryMax)}</span>}
                      {job.saved_at && <span style={{ fontSize: 12, color: C.textMuted }}>Saved {fmtDate(job.saved_at)}</span>}
                      <MissingSkillsBadges skills={readyEntry?.missing_skills} />
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    {readyEntry && (
                      <Btn variant="ghost" style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => toggleJobExpanded(job.job_id)}>
                        {isExpanded ? "Hide Details" : "View Details"}
                      </Btn>
                    )}
                    <Btn variant="danger" style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => removeSavedJob(job.job_id)}>{t("savedJobs.remove")}</Btn>
                    {readyEntry && (isMobile ? (
                      <SwipeToApply onApply={() => handleMarkApplied(readyEntry)} applying={applyingId === readyEntry.id} justApplied={appliedId === readyEntry.id} />
                    ) : appliedId === readyEntry.id ? (
                      <Btn variant="green" disabled style={{ fontSize: 13, padding: "9px 14px" }}>✓ Applied</Btn>
                    ) : (
                      <Btn style={{ fontSize: 13, padding: "9px 14px" }} loading={applyingId === readyEntry.id} onClick={() => handleMarkApplied(readyEntry)}>
                        {applyingId === readyEntry.id ? "Applying…" : "Apply"}
                      </Btn>
                    ))}
                  </div>
                </div>
                {isExpanded && readyEntry && (
                  <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${C.border}` }}>
                    <PackageView item={readyEntry} resumes={resumes} />
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </div>

      {/* ── Section 2: Smart Apply Queue ───────────────────────── */}
      {(visibleQueue.length > 0 || queueLoading) && (
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 14 }}>{t("savedJobs.smartApplyQueue")}</div>
          {queueLoading && visibleQueue.length === 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "14px 0" }}>
              <div style={{ width: 14, height: 14, border: `2px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
              <div style={{ fontSize: 13, color: C.textMuted, minWidth: 0 }}>Loading your Smart Apply queue…</div>
            </div>
          )}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {visibleQueue.map(item => (
              <SmartApplyQueueCard key={item.id} item={item} onApply={handleMarkApplied} onRemove={handleRemoveFromQueue} onRetry={handleRetry} applying={applyingId === item.id} retrying={retryingId === item.id} resumes={resumes} justApplied={appliedId === item.id} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── PRICING PAGE ──────────────────────────────────────────
function PricingPage({ profile }) {
  const { t } = useI18n();
  const plans = [
    { id: "free", name: t("pricing.freeName"), price: "$0", sub: t("pricing.freeSub"), color: C.textMuted, features: [t("pricing.freeFeature1"), t("pricing.freeFeature2"), t("pricing.freeFeature3"), t("pricing.freeFeature4"), t("pricing.freeFeature5")], cta: t("pricing.freeCta"), disabled: true },
    { id: "pro", name: t("pricing.proName"), price: "$19", sub: t("pricing.proSub"), color: C.purple, popular: true, features: [t("pricing.proFeature1"), t("pricing.proFeature2"), t("pricing.proFeature3"), t("pricing.proFeature4"), t("pricing.proFeature5"), t("pricing.proFeature6"), t("pricing.proFeature7"), t("pricing.proFeature8")], cta: t("pricing.proCta"), disabled: false },
  ];

  return (
    <div>
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
              <Btn variant={plan.id === "free" ? "secondary" : "primary"} style={{ width: "100%", justifyContent: "center", padding: "13px", opacity: plan.disabled ? 0.5 : 1 }} disabled={plan.disabled} onClick={() => { if (!plan.disabled) alert(`Connect Stripe to enable ${plan.name} payments`); }}>
                {profile?.plan === plan.id ? t("pricing.currentPlan") : plan.cta}
              </Btn>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ─── PROFILE PAGE ──────────────────────────────────────────
function ProfilePage({ profile, updateProfile }) {
  const { t } = useI18n();
  const [form, setForm] = useState({
    full_name: profile?.full_name || "",
    email_address: profile?.email_address || "",
    phone: profile?.phone || "",
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
  const workTypes = [
    { value: "Remote", label: t("profile.workTypeRemote") },
    { value: "Hybrid", label: t("profile.workTypeHybrid") },
    { value: "On-site", label: t("profile.workTypeOnsite") },
  ];

  const save = () => {
    if (!form.full_name.trim()) { setError(t("profile.fullNameRequired")); return; }
    setError("");
    updateProfile(form);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

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
          <Input label={t("profile.fullNameLabel")} value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} placeholder={t("profile.fullNamePlaceholder")} />
          <Input label={t("profile.emailLabel")} value={form.email_address} onChange={e => setForm(f => ({ ...f, email_address: e.target.value }))} placeholder={t("profile.emailPlaceholder")} />
          <Input label={t("profile.phoneLabel")} placeholder={t("profile.phonePlaceholder")} value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
          <Input label={t("profile.locationLabel")} placeholder={t("profile.locationPlaceholder")} value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} />
        </div>
      </Card>

      <Card>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 18 }}>{t("profile.careerInfo")}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 18 }} className="two-col">
          <Input label={t("profile.currentJobTitleLabel")} placeholder={t("profile.currentJobTitlePlaceholder")} value={form.job_title} onChange={e => setForm(f => ({ ...f, job_title: e.target.value }))} />
          <Input label={t("profile.yearsExpLabel")} placeholder={t("profile.yearsExpPlaceholder")} value={form.years_experience} onChange={e => setForm(f => ({ ...f, years_experience: e.target.value }))} />
          <Input label={t("profile.preferredJobTitleLabel")} placeholder={t("profile.preferredJobTitlePlaceholder")} value={form.preferred_job_title} onChange={e => setForm(f => ({ ...f, preferred_job_title: e.target.value }))} />
          <Input label={t("profile.preferredIndustryLabel")} placeholder={t("profile.preferredIndustryPlaceholder")} value={form.preferred_industry} onChange={e => setForm(f => ({ ...f, preferred_industry: e.target.value }))} />
          <div>
            <Label>{t("profile.preferredWorkType")}</Label>
            <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
              {workTypes.map(wt => (
                <Btn key={wt.value} variant="ghost" onClick={() => setForm(f => ({ ...f, work_type: f.work_type === wt.value ? "" : wt.value }))} style={{ padding: "8px 16px", borderRadius: 20, border: `1.5px solid ${form.work_type === wt.value ? C.purple : C.border}`, background: form.work_type === wt.value ? C.purpleLight : "#fff", color: form.work_type === wt.value ? C.purple : C.textMid, fontSize: 13, fontWeight: 600 }}>{wt.label}</Btn>
              ))}
            </div>
          </div>
          <Input label={t("profile.desiredSalaryLabel")} placeholder={t("profile.desiredSalaryPlaceholder")} value={form.desired_salary} onChange={e => setForm(f => ({ ...f, desired_salary: e.target.value }))} />
        </div>
        <Btn onClick={save} style={{ padding: "12px 28px" }}>{saved ? t("profile.saved") : t("profile.saveChanges")}</Btn>
      </Card>
    </div>
  );
}


// ─── OPPORTUNITY INTELLIGENCE PAGE ─────────────────────────
function OpportunityPage({ profile, savedJobs, applications, setPage, watchlist, watchlistAdd, watchlistRemove, watchlistUpdateStatus }) {
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
  const referralJobs = saved.map(j => {
    const contact = contacts.find(c => c.company && j.company && c.company.toLowerCase() === j.company.toLowerCase());
    return contact ? { ...j, referralContact: contact } : null;
  }).filter(Boolean);

  // ── Trending Skills from saved jobs ──────────────────────
  const skillFreq = {};
  saved.forEach(j => (j.skills || []).forEach(s => { skillFreq[s] = (skillFreq[s] || 0) + 1; }));
  const jobTrendingSkills = Object.entries(skillFreq).sort((a, b) => b[1] - a[1]).slice(0, 10);

  // ── Growing Companies from saved jobs ────────────────────
  const coFreq = {};
  saved.forEach(j => { if (j.company) coFreq[j.company] = (coFreq[j.company] || 0) + 1; });
  const frequentCompanies = Object.entries(coFreq).filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1]);

  // ── Watchlist with saved job counts ──────────────────────
  const wl = watchlist || [];
  const watchlistEnriched = wl.map(w => ({
    ...w,
    jobCount: saved.filter(j => j.company && j.company.toLowerCase() === w.company_name.toLowerCase()).length,
    hasContact: contacts.some(c => c.company && c.company.toLowerCase() === w.company_name.toLowerCase()),
  }));

  const userContext = useUserContext({ profile, applications, savedJobs, networkContacts: contacts, companyWatchlist: wl });
  const matchColor = v => !v ? C.textMuted : v >= 80 ? C.green : v >= 60 ? C.yellow : C.red;
  const fmtSal = (min, max) => {
    if (!min && !max) return null;
    const f = n => `$${Math.round(n / 1000)}K`;
    if (min && max) return `${f(min)}–${f(max)}`;
    return min ? `${f(min)}+` : `Up to ${f(max)}`;
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
    } catch {
      setAnalysisError("Analysis failed. Please try again.");
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
      setAddError("Failed to add company. Please try again.");
    } finally {
      setAddingCompany(false);
    }
  };

  const pageTabs = [
    { id: "opportunities", label: "Opportunities" },
    { id: "watchlist", label: `Company Watchlist${wl.length ? ` (${wl.length})` : ""}` },
    { id: "trends", label: "Market Trends" },
  ];

  return (
    <div>
      <button onClick={() => setPage("dashboard")} style={{ border: "none", background: "none", color: C.textMuted, fontSize: 13, cursor: "pointer", padding: "0 0 20px 0", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}>
        ← Back to Dashboard
      </button>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 24, gap: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 48, height: 48, borderRadius: 14, background: C.purple, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, boxShadow: `0 4px 16px ${C.purple}40` }}>
            <span style={{ fontSize: 24 }}>🎯</span>
          </div>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, color: C.text, marginBottom: 4 }}>Opportunity Intelligence</h1>
            <p style={{ fontSize: 13, color: C.textMuted }}>AI-powered career opportunities ranked for your profile.</p>
          </div>
        </div>
        <Btn variant="secondary" style={{ fontSize: 12, padding: "6px 14px", flexShrink: 0 }} onClick={refreshAnalysis} loading={analysisLoading}>
          {analysisLoading ? "Analyzing…" : "↻ Refresh AI Analysis"}
        </Btn>
      </div>

      {analysis?.generatedAt && (
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 20 }}>
          Analysis generated {new Date(analysis.generatedAt).toLocaleString()}
        </div>
      )}

      {analysisError && (
        <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, color: C.red, fontSize: 13, marginBottom: 16 }}>{analysisError}</div>
      )}

      {/* Tab bar */}
      <div style={{ display: "flex", gap: 4, borderBottom: `1px solid ${C.border}`, marginBottom: 24 }}>
        {pageTabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{ border: "none", background: "none", padding: "10px 16px", fontSize: 14, fontWeight: tab === t.id ? 700 : 500, color: tab === t.id ? C.purple : C.textMuted, cursor: "pointer", borderBottom: `2px solid ${tab === t.id ? C.purple : "transparent"}`, marginBottom: -1, fontFamily: "inherit" }}>
            {t.label}
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
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 3 }}>🏆 Better Job Opportunities</div>
                <div style={{ fontSize: 12, color: C.textMuted }}>Your saved jobs ranked by AI match score.</div>
              </div>
              <Btn variant="secondary" style={{ padding: "5px 12px", fontSize: 12, flexShrink: 0 }} onClick={() => setPage("jobs")}>Find More Jobs →</Btn>
            </div>
            {betterJobs.length === 0 ? (
              <div style={{ fontSize: 13, color: C.textMuted, textAlign: "center", padding: "24px 0" }}>
                Save jobs from Job Search to see AI-ranked opportunities here.
                <div style={{ marginTop: 12 }}><Btn variant="secondary" style={{ fontSize: 12, padding: "6px 14px" }} onClick={() => setPage("jobs")}>Go to Job Search</Btn></div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column" }}>
                {betterJobs.map((j, i) => {
                  const sal = fmtSal(j.salaryMin, j.salaryMax);
                  const applied = appliedCompanies.has((j.company || "").toLowerCase());
                  const watched = wl.some(w => w.company_name?.toLowerCase() === (j.company || "").toLowerCase());
                  const refCon = contacts.find(c => c.company && j.company && c.company.toLowerCase() === j.company.toLowerCase());
                  return (
                    <div key={j.job_id || i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "11px 0", borderBottom: i < betterJobs.length - 1 ? `1px solid ${C.border}` : "none", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ flex: 1, minWidth: 200 }}>
                        <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap", marginBottom: 3 }}>
                          <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{j.title}</span>
                          {watched && <span style={{ fontSize: 10, fontWeight: 700, color: C.purple, background: C.purpleLight, borderRadius: 8, padding: "2px 6px" }}>Watched</span>}
                          {refCon && <span style={{ fontSize: 10, fontWeight: 700, color: C.green, background: C.greenLight, borderRadius: 8, padding: "2px 6px" }}>Referral</span>}
                          {applied && <span style={{ fontSize: 10, fontWeight: 700, color: C.blue, background: C.blueLight, borderRadius: 8, padding: "2px 6px" }}>Applied</span>}
                        </div>
                        <div style={{ fontSize: 13, color: C.textMuted }}>{j.company}{j.location ? ` · ${j.location}` : ""}{sal ? ` · ${sal}` : ""}</div>
                        {refCon && <div style={{ fontSize: 11, color: C.green, marginTop: 3 }}>You know {refCon.name} here — ask for a referral</div>}
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
                        {j.matchScore != null && (
                          <div style={{ textAlign: "center" }}>
                            <div style={{ fontSize: 18, fontWeight: 800, color: matchColor(j.matchScore) }}>{j.matchScore}%</div>
                            <div style={{ fontSize: 9, color: C.textMuted, fontWeight: 600 }}>Match</div>
                          </div>
                        )}
                        {j.applyUrl && <a href={j.applyUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: C.purple, fontWeight: 600, textDecoration: "none" }}>Apply →</a>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {saved.length > 0 && (
              <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
                <Btn variant="secondary" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => setPage("saved")}>All Saved Jobs →</Btn>
                <Btn variant="secondary" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => setPage("tracker")}>Job Tracker →</Btn>
              </div>
            )}
          </Card>

          {/* Salary Improvement Opportunities */}
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14, gap: 12, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 3 }}>💰 Salary Improvement Opportunities</div>
                <div style={{ fontSize: 12, color: C.textMuted }}>
                  {desiredNum ? `Jobs exceeding your target of $${Math.round(desiredNum / 1000)}K/yr.` : marketMedian ? `Jobs near or above the $${Math.round(marketMedian / 1000)}K market median.` : "Jobs with competitive salary ranges from your saved list."}
                </div>
              </div>
              <Btn variant="secondary" style={{ padding: "5px 12px", fontSize: 12, flexShrink: 0 }} onClick={() => setPage("salary")}>Salary Research →</Btn>
            </div>
            {salaryData?.results?.marketRange && (
              <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                {[["Low", salaryData.results.marketRange.low, C.textMuted], ["Median", salaryData.results.marketRange.median, C.green], ["High", salaryData.results.marketRange.high, C.purple]].map(([label, val, color]) => val ? (
                  <div key={label} style={{ flex: 1, minWidth: 72, background: C.bgSoft, borderRadius: 8, padding: "8px 10px", textAlign: "center" }}>
                    <div style={{ fontSize: 15, fontWeight: 800, color }}>${Math.round(val / 1000)}K</div>
                    <div style={{ fontSize: 10, color: C.textMuted, fontWeight: 600 }}>Market {label}</div>
                  </div>
                ) : null)}
              </div>
            )}
            {salaryJobs.length === 0 ? (
              <div style={{ fontSize: 13, color: C.textMuted, padding: "12px 0" }}>
                {!desiredNum && !marketMedian
                  ? "Set your desired salary in Profile, or run Salary Intelligence to establish a market baseline — then matching jobs will surface here."
                  : "No saved jobs currently exceed your salary target. Search for more jobs or adjust your target role."}
                <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {!desiredNum && <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("profile")}>Update Profile →</Btn>}
                  <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("salary")}>Research Salaries →</Btn>
                  <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("jobs")}>Find Jobs →</Btn>
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
                        {j.applyUrl && <a href={j.applyUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: C.purple, fontWeight: 600, textDecoration: "none" }}>Apply →</a>}
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
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 3 }}>🤝 Referral Opportunities</div>
                <div style={{ fontSize: 12, color: C.textMuted }}>Jobs where your network contacts can refer you. Referrals increase interview chances by 3–5×.</div>
              </div>
              <Btn variant="secondary" style={{ padding: "5px 12px", fontSize: 12, flexShrink: 0 }} onClick={() => setPage("network")}>Manage Network →</Btn>
            </div>
            {referralJobs.length === 0 ? (
              <div style={{ fontSize: 13, color: C.textMuted, padding: "12px 0" }}>
                {contacts.length === 0 ? "Add contacts in Networking Intelligence and save jobs — when a contact works at a company you saved, it appears here as a referral opportunity." : "None of your contacts currently work at companies in your saved jobs. Save more jobs or expand your network."}
                <div style={{ marginTop: 10, display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("network")}>Add Contacts →</Btn>
                  <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("jobs")}>Save More Jobs →</Btn>
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {referralJobs.slice(0, 5).map((j, i) => (
                  <div key={j.job_id || i} style={{ background: C.greenLight, border: `1px solid ${C.green}20`, borderRadius: 10, padding: "12px 14px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 2 }}>{j.title} — {j.company}</div>
                        <div style={{ fontSize: 12, color: C.green, fontWeight: 600 }}>✓ {j.referralContact.name} works here</div>
                        {j.referralContact.email && <div style={{ fontSize: 11, color: C.textMuted, marginTop: 1 }}>{j.referralContact.email}</div>}
                        {j.matchScore != null && <div style={{ fontSize: 12, color: matchColor(j.matchScore), fontWeight: 600, marginTop: 4 }}>{j.matchScore}% match</div>}
                      </div>
                      <div style={{ display: "flex", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
                        <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("network")}>Draft Message</Btn>
                        {j.applyUrl && <a href={j.applyUrl} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}><Btn style={{ fontSize: 12, padding: "5px 12px" }}>Apply</Btn></a>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Internal Promotion Signals */}
          <Card>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>📈 Internal Promotion Signals</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>What it takes to advance from your current level based on your experience and target role.</div>
            {analysis?.internalPromotionSignals?.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {analysis.internalPromotionSignals.map((sig, i) => (
                  <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span style={{ color: C.purple, fontWeight: 800, flexShrink: 0, fontSize: 14 }}>→</span>
                    <span style={{ fontSize: 13, color: C.textMid, lineHeight: 1.6 }}>{sig}</span>
                  </div>
                ))}
                <div style={{ marginTop: 6, display: "flex", gap: 8 }}>
                  <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("interview")}>Interview Prep →</Btn>
                  <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("resume")}>Update Resume →</Btn>
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: C.textMuted }}>
                {analysisLoading ? "Generating promotion signals…" : "Run AI Analysis to generate personalized internal promotion signals based on your role and experience."}
                {!analysisLoading && <div style={{ marginTop: 10 }}><Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={refreshAnalysis}>Generate Analysis</Btn></div>}
              </div>
            )}
          </Card>

          {/* Career Pivot Opportunities */}
          <Card>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>🔄 Career Pivot Opportunities</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>Adjacent roles your skills transfer to, with salary uplift estimates.</div>
            {analysis?.careerPivotOpportunities?.length > 0 ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }} className="three-col">
                {analysis.careerPivotOpportunities.map((opp, i) => (
                  <div key={i} style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.text, lineHeight: 1.3, flex: 1, marginRight: 8 }}>{opp.role}</div>
                      <div style={{ textAlign: "center", flexShrink: 0 }}>
                        <div style={{ fontSize: 16, fontWeight: 800, color: matchColor(opp.fit) }}>{opp.fit}%</div>
                        <div style={{ fontSize: 9, color: C.textMuted, fontWeight: 600 }}>Fit</div>
                      </div>
                    </div>
                    {opp.salaryUplift && <div style={{ fontSize: 12, color: C.green, fontWeight: 700, marginBottom: 8 }}>{opp.salaryUplift} salary uplift</div>}
                    <div style={{ fontSize: 12, color: C.textMid, lineHeight: 1.5, marginBottom: 10 }}>{opp.reason}</div>
                    {opp.skillsNeeded?.length > 0 && (
                      <div>
                        <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, marginBottom: 5, letterSpacing: 0.5 }}>SKILLS TO ADD</div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 10 }}>
                          {opp.skillsNeeded.map(s => <span key={s} style={{ fontSize: 11, color: C.purple, background: C.purpleLight, borderRadius: 6, padding: "2px 7px", fontWeight: 600 }}>{s}</span>)}
                        </div>
                      </div>
                    )}
                    <Btn variant="secondary" style={{ fontSize: 11, padding: "4px 10px", width: "100%" }} onClick={() => setPage("jobs")}>Search This Role →</Btn>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: C.textMuted }}>
                {analysisLoading ? "Analyzing career pivot opportunities…" : "Run AI Analysis to discover adjacent roles where your existing skills give you a competitive head start."}
                {!analysisLoading && <div style={{ marginTop: 10 }}><Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={refreshAnalysis}>Generate Analysis</Btn></div>}
              </div>
            )}
          </Card>

          {/* Cross-module quick actions */}
          <Card style={{ background: C.bgSoft }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.navText, marginBottom: 12 }}>Continue in CareerPersona AI</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[["Resume Intelligence", "resume"], ["Interview Prep", "interview"], ["Salary Research", "salary"], ["Networking", "network"], ["Smart Apply", "saved"], ["Job Tracker", "tracker"], ["AI Briefing", "briefing"], ["Action Plan", "plan"]].map(([label, pid]) => (
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
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 14 }}>Track a Company</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input
                value={addInput}
                onChange={e => setAddInput(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleAdd("watching")}
                placeholder="Company name (e.g. Stripe, Anthropic, Google…)"
                style={{ flex: 1, minWidth: 200, border: `1.5px solid ${C.border}`, borderRadius: 9, padding: "10px 14px", fontSize: 14, color: C.text, outline: "none", fontFamily: "inherit" }}
              />
              <Btn style={{ padding: "10px 20px" }} onClick={() => handleAdd("watching")} loading={addingCompany}>Watch</Btn>
              <Btn variant="secondary" style={{ padding: "10px 20px" }} onClick={() => handleAdd("dream_company")} loading={addingCompany}>⭐ Dream</Btn>
            </div>
            {addError && <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{addError}</div>}
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 10 }}>Press Enter or click Watch to add. Mark companies as Dream to prioritize them across all AI recommendations.</div>
          </Card>

          {watchlistEnriched.length === 0 ? (
            <Card style={{ textAlign: "center", padding: "40px 24px" }}>
              <div style={{ fontSize: 36, marginBottom: 14 }}>🏢</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>No companies tracked yet</div>
              <div style={{ fontSize: 13, color: C.textMuted, maxWidth: 380, margin: "0 auto" }}>
                Track your target companies. Dream companies get prioritized in your AI briefings, action plans, and opportunity rankings.
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
                            {w.status === "dream_company" ? "⭐ Dream Company" : "👁 Watching"}
                          </span>
                        </div>
                        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                          {w.jobCount > 0 && <div style={{ fontSize: 12, color: C.blue }}>{w.jobCount} saved job{w.jobCount !== 1 ? "s" : ""}</div>}
                          {w.hasContact && <div style={{ fontSize: 12, color: C.green }}>✓ You have a contact here</div>}
                        </div>
                        {w.notes && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6, lineHeight: 1.5 }}>{w.notes}</div>}
                      </div>
                      <div style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap" }}>
                        <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => watchlistUpdateStatus(w.id, w.status === "dream_company" ? "watching" : "dream_company")}>
                          {w.status === "dream_company" ? "→ Watching" : "⭐ Dream"}
                        </Btn>
                        {w.jobCount > 0 && <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("saved")}>View Jobs</Btn>}
                        {w.hasContact && <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("network")}>Contact</Btn>}
                        <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px", color: C.red }} onClick={() => watchlistRemove(w.id)}>✕</Btn>
                      </div>
                    </div>
                  </Card>
                ))}
              </div>

              <Card style={{ background: C.bgSoft }}>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", justifyContent: "space-around" }}>
                  {[["Tracked", wl.length, C.purple], ["Dream Companies", wl.filter(w => w.status === "dream_company").length, "#B45309"], ["Jobs Found", watchlistEnriched.reduce((s, w) => s + w.jobCount, 0), C.blue], ["With Contacts", watchlistEnriched.filter(w => w.hasContact).length, C.green]].map(([label, val, color]) => (
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
                <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 3 }}>🔥 Trending Skills</div>
                <div style={{ fontSize: 12, color: C.textMuted }}>Skills in highest demand across your saved and matched jobs, with AI salary premium data.</div>
              </div>
              <Btn variant="secondary" style={{ padding: "5px 12px", fontSize: 12, flexShrink: 0 }} onClick={() => setPage("resume")}>Update Resume →</Btn>
            </div>
            {analysis?.trendingSkills?.length > 0 ? (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }} className="two-col">
                {analysis.trendingSkills.map((s, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: C.bgSoft, borderRadius: 9, padding: "10px 14px" }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{s.skill}</div>
                      <div style={{ fontSize: 11, fontWeight: 700, marginTop: 2, color: s.demand === "Exploding" ? C.red : s.demand === "High" ? C.orange : C.yellow }}>
                        {s.demand === "Exploding" ? "🔥" : s.demand === "High" ? "📈" : "↗"} {s.demand}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 14, fontWeight: 800, color: C.green }}>{s.salaryPremium}</div>
                      <div style={{ fontSize: 10, color: C.textMuted }}>salary premium</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : jobTrendingSkills.length > 0 ? (
              <div>
                <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 10 }}>From your {saved.length} saved jobs — run AI Analysis to add demand and salary premium data:</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 12 }}>
                  {jobTrendingSkills.map(([skill, count]) => (
                    <div key={skill} style={{ display: "flex", alignItems: "center", gap: 5, background: C.purpleLight, borderRadius: 20, padding: "6px 12px" }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: C.purple }}>{skill}</span>
                      <span style={{ fontSize: 11, color: C.textMuted }}>×{count}</span>
                    </div>
                  ))}
                </div>
                <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={refreshAnalysis} loading={analysisLoading}>{analysisLoading ? "Analyzing…" : "↻ Get AI Demand Insights"}</Btn>
              </div>
            ) : (
              <div style={{ fontSize: 13, color: C.textMuted }}>
                Save jobs with skills tags to see trending skills, or run AI Analysis to get market demand insights for your target role.
                <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                  <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("jobs")}>Find Jobs →</Btn>
                  <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={refreshAnalysis} loading={analysisLoading}>AI Analysis</Btn>
                </div>
              </div>
            )}
          </Card>

          {/* Emerging Industries */}
          <Card>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>🌱 Emerging Industries</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>Fast-growing sectors where your skills are in demand, with average compensation data.</div>
            {analysis?.emergingIndustries?.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {analysis.emergingIndustries.map((ind, i) => (
                  <div key={i} style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 16px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{ind.industry}</div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <span style={{ fontSize: 12, fontWeight: 800, color: C.green, background: C.greenLight, borderRadius: 8, padding: "3px 9px" }}>↑ {ind.growth}</span>
                        {ind.avgSalary && <span style={{ fontSize: 12, fontWeight: 700, color: C.purple, background: C.purpleLight, borderRadius: 8, padding: "3px 9px" }}>{ind.avgSalary} avg</span>}
                      </div>
                    </div>
                    {ind.roles?.length > 0 && (
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
                        {ind.roles.map(r => <span key={r} style={{ fontSize: 11, color: C.textMid, background: "#fff", border: `1px solid ${C.border}`, borderRadius: 6, padding: "2px 8px" }}>{r}</span>)}
                      </div>
                    )}
                    <Btn variant="secondary" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => setPage("jobs")}>Explore Jobs →</Btn>
                  </div>
                ))}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: C.textMuted }}>
                {analysisLoading ? "Identifying emerging industries…" : "Run AI Analysis to discover fast-growing industries aligned with your skills and career trajectory."}
                {!analysisLoading && <div style={{ marginTop: 10 }}><Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={refreshAnalysis}>Generate Analysis</Btn></div>}
              </div>
            )}
          </Card>

          {/* Growing Companies */}
          <Card>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>🚀 Growing Companies</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>Companies actively expanding in your target field, with hiring signals and your match score.</div>
            {frequentCompanies.length > 0 && (
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 8 }}>ACTIVE IN YOUR SAVED JOBS</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {frequentCompanies.map(([company, count]) => (
                    <div key={company} style={{ display: "flex", alignItems: "center", gap: 5, background: C.purpleLight, borderRadius: 20, padding: "6px 12px" }}>
                      <span style={{ fontSize: 13, fontWeight: 700, color: C.purple }}>{company}</span>
                      <span style={{ fontSize: 11, color: C.textMuted }}>{count} roles</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {analysis?.growingCompanies?.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {frequentCompanies.length > 0 && <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 2 }}>AI MARKET INTELLIGENCE</div>}
                {analysis.growingCompanies.map((c, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "12px 14px", background: C.bgSoft, borderRadius: 9, flexWrap: "wrap", alignItems: "flex-start" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{c.company}</span>
                        {c.category && <Badge color={C.purple}>{c.category}</Badge>}
                      </div>
                      <div style={{ fontSize: 12, color: C.textMid, lineHeight: 1.5, marginBottom: 4 }}>{c.signal}</div>
                      {c.openRoles > 0 && <div style={{ fontSize: 11, color: C.blue }}>{c.openRoles} open roles</div>}
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
                      {c.yourMatch != null && (
                        <div style={{ textAlign: "center" }}>
                          <div style={{ fontSize: 15, fontWeight: 800, color: matchColor(c.yourMatch) }}>{c.yourMatch}%</div>
                          <div style={{ fontSize: 9, color: C.textMuted }}>Match</div>
                        </div>
                      )}
                      <Btn variant="secondary" style={{ fontSize: 11, padding: "4px 10px" }} onClick={() => setPage("jobs")}>Search →</Btn>
                    </div>
                  </div>
                ))}
              </div>
            ) : frequentCompanies.length === 0 ? (
              <div style={{ fontSize: 13, color: C.textMuted }}>
                {analysisLoading ? "Identifying growing companies…" : "Run AI Analysis to discover which companies in your field are expanding rapidly and hiring."}
                {!analysisLoading && <div style={{ marginTop: 10 }}><Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={refreshAnalysis}>Generate Analysis</Btn></div>}
              </div>
            ) : null}
          </Card>

          {/* Market Intelligence from Salary Research */}
          {salaryData?.results ? (
            <Card>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>📊 Market Intelligence</div>
              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 14 }}>
                From your salary research for {salaryData.results.jobTitle || profile?.preferred_job_title || "your role"}{salaryData.results.location ? ` in ${salaryData.results.location}` : ""}.
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
                {[["Demand", salaryData.results.demandLevel, salaryData.results.demandLevel === "High" ? C.green : C.yellow], ["Trend", salaryData.results.trend, salaryData.results.trendDirection === "up" ? C.green : C.textMuted]].map(([label, val, color]) => val ? (
                  <div key={label} style={{ background: C.bgSoft, borderRadius: 9, padding: "8px 14px" }}>
                    <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600 }}>{label}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, color }}>{val}</div>
                  </div>
                ) : null)}
                {(salaryData.results.skills || []).length > 0 && (
                  <div style={{ flex: 1, background: C.bgSoft, borderRadius: 9, padding: "8px 14px" }}>
                    <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 600, marginBottom: 4 }}>Top Skills</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {salaryData.results.skills.slice(0, 4).map(s => <Badge key={s} color={C.purple}>{s}</Badge>)}
                    </div>
                  </div>
                )}
              </div>
              {salaryData.results.topPayingCompanies?.length > 0 && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, marginBottom: 8 }}>TOP PAYING COMPANIES</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {salaryData.results.topPayingCompanies.map(co => <span key={co} style={{ fontSize: 12, color: C.textMid, background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 8, padding: "4px 10px" }}>{co}</span>)}
                  </div>
                </div>
              )}
              <Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("salary")}>Full Salary Report →</Btn>
            </Card>
          ) : (
            <Card style={{ background: C.bgSoft }}>
              <div style={{ fontSize: 13, color: C.textMuted }}>
                <strong style={{ color: C.text }}>Unlock Market Intelligence:</strong> Run Salary Intelligence to add market demand data, top-paying companies, and in-demand skills to this page.
                <div style={{ marginTop: 10 }}><Btn variant="secondary" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setPage("salary")}>Research Salaries →</Btn></div>
              </div>
            </Card>
          )}
        </div>
      )}

      <div style={{ textAlign: "center", paddingTop: 32 }}>
        <button onClick={() => setPage("dashboard")} style={{ border: "none", background: "none", color: C.purple, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>← Back to Dashboard</button>
      </div>
    </div>
  );
}

// ─── SETTINGS PAGE ─────────────────────────────────────────
function SettingsPage({ profile, updateProfile, logout, setPage }) {
  const { t } = useI18n();
  const [notifyEmail, setNotifyEmail] = useStorage("cp_notify_email", true);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteText, setDeleteText] = useState("");

  const planName = (profile?.plan || "free").toUpperCase();
  const isPro = planName === "PRO";
  const deleteConfirmPhrase = t("settings.deleteConfirmPhrase");

  const handleDelete = () => {
    if (deleteText.toLowerCase() === deleteConfirmPhrase.toLowerCase()) {
      localStorage.clear();
      logout();
    }
  };

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 24 }}>{t("settings.heading")}</h1>

      {/* SUBSCRIPTION */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}><span style={{ fontSize: 20 }}>💳</span><span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{t("settings.subscription")}</span></div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }} className="two-col">
          <div style={{ background: C.bgSoft, borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4 }}>{t("settings.currentPlan")}</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: isPro ? C.purple : C.text }}>{planName}</div>
          </div>
          <div style={{ background: C.bgSoft, borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4 }}>{t("settings.status")}</div>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.green }}>{t("settings.active")}</div>
          </div>
          {isPro && <div style={{ background: C.bgSoft, borderRadius: 10, padding: 14 }}>
            <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4 }}>{t("settings.nextRenewal")}</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>—</div>
          </div>}
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {!isPro && <Btn onClick={() => setPage("pricing")}>{t("settings.upgradeToPro")}</Btn>}
          {isPro && <Btn variant="secondary" onClick={() => alert(t("settings.stripeManageSoon"))}>{t("settings.cancelSubscription")}</Btn>}
        </div>
      </Card>

      {/* BILLING */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}><span style={{ fontSize: 20 }}>💰</span><span style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{t("settings.billing")}</span></div>
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 8 }}>{t("settings.paymentMethod")}</div>
          <div style={{ background: C.bgSoft, borderRadius: 10, padding: 16, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ color: C.textMuted, fontSize: 14 }}>{t("settings.noPaymentMethod")}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <Btn variant="secondary" style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => alert(t("settings.stripeIntegrationSoon"))}>{t("settings.addCard")}</Btn>
              <Btn variant="secondary" style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => alert(t("settings.stripeIntegrationSoon"))}>{t("settings.changeCard")}</Btn>
            </div>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 8 }}>{t("settings.billingHistory")}</div>
          <div style={{ background: C.bgSoft, borderRadius: 10, padding: 16 }}>
            <div style={{ color: C.textMuted, fontSize: 14, textAlign: "center", padding: "20px 0" }}>{t("settings.noBillingHistory")}</div>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            <Btn variant="secondary" style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => alert(t("settings.noInvoicesYet"))}>{t("settings.viewInvoice")}</Btn>
            <Btn variant="secondary" style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => alert(t("settings.noInvoicesYet"))}>{t("settings.downloadPdf")}</Btn>
            <Btn variant="secondary" style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => alert(t("settings.noInvoicesYet"))}>{t("settings.printInvoice")}</Btn>
          </div>
          <div style={{ fontSize: 12, color: C.textMuted, marginTop: 8 }}>{t("settings.invoicesWillAppear")}</div>
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
  const validPages = new Set(["dashboard","briefing","plan","resume","jobs","saved","interview","tracker","salary","network","pricing","profile","settings","opportunity"]);

  // Read initial page from URL hash, then localStorage fallback
  const getInitialPage = () => {
    const hash = window.location.hash.replace("#", "");
    if (hash && validPages.has(hash)) return hash;
    try { const stored = localStorage.getItem("cp_active_page"); if (stored) { const p = JSON.parse(stored); if (validPages.has(p)) return p; } } catch {}
    return "dashboard";
  };

  const [page, setPageRaw] = useState(getInitialPage);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

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
    ["cp_resume_text","cp_resume_jobdesc","cp_resume_results","cp_resume_tab","cp_resume_loaded_id","cp_resume_source","cp_resume_selected_kws","cp_resume_improve_stats","cp_resume_master_kws","cp_resume_optimized","cp_resume_insights","cp_resume_lib_saved","cp_resume_manual_reset","cp_resume_benchmark","cp_resume_jobfit","cp_resume_linkedin_opt","cp_resume_linkedin_profile","cp_resume_cover_versions","cp_resume_cover_active","cp_resume_deep_insights","cp_jobs_filters","cp_jobs_results","cp_jobs_page","cp_jobs_hasmore","cp_jobs_searched","cp_jobs_match","cp_jobs_resume","cp_jobs_resumefilename","cp_jobs_sourcecounts","cp_tracker_filter","cp_tracker_search","cp_interview_filter","cp_net_tab","cp_briefing_dash","cp_plan_dash"].forEach(k => { try { sessionStorage.removeItem(k); } catch {} });
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
  const handleSaveApp = (app) => setApplications(p => [app, ...p]);
  const goHome = () => { setPage("dashboard"); window.scrollTo(0, 0); document.documentElement.scrollTop = 0; document.body.scrollTop = 0; };

  const { language, setLanguage, t } = useLanguagePreference(profile?.preferred_language, (code) => updateProfile({ preferred_language: code }));

  const nav = [
    { id: "dashboard", icon: "📊", label: t("nav.dashboard") },
    { id: "resume", icon: "⚡", label: t("nav.resume") },
    { id: "jobs", icon: "🔍", label: t("nav.jobSearch") },
    { id: "saved", icon: "♥", label: `${t("nav.saved")}${savedJobs.length > 0 ? ` (${savedJobs.length})` : ""}` },
    { id: "interview", icon: "🎤", label: t("nav.interview") },
    { id: "tracker", icon: "📋", label: `${t("nav.tracker")}${applications.length > 0 ? ` (${applications.length})` : ""}` },
    { id: "salary", icon: "💰", label: t("nav.salary") },
    { id: "network", icon: "🤝", label: t("nav.network") },
    { id: "opportunity", icon: "🎯", label: "Opportunities" },
    { id: "pricing", icon: "💎", label: t("nav.pricing") },
  ];
  const planName = (profile?.plan || "free").toUpperCase();
  const { notifications, refresh: refreshNotifications, markAllRead } = useNotifications(profile?.id);

  // Data lifted to App level so UserContext can aggregate them as the single
  // source of truth. Page-level hook instances keep their full mutation APIs.
  const { resumes, loading: resumesLoading, saveResume: rootSaveResume, deleteResume: rootDeleteResume, downloadResume: rootDownloadResume, setDefaultResume: rootSetDefaultResume, refresh: refreshResumes, saveAnalysis: rootSaveAnalysis, updateVersionLabel: rootUpdateVersionLabel } = useResumes(profile?.id);
  const [activeResumeId, setActiveResumeId] = useState(null);
  const { entries: analysisHistory, saveEntry: saveHistoryToDb } = useResumeHistory(profile?.id);

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
  const { queue: smartApplyQueue, loading: smartApplyQueueLoading, refresh: refreshSmartApplyQueue, enqueue: rootEnqueue, markApplied: rootMarkApplied, markReady: rootMarkReady, markFailed: rootMarkFailed, resetToQueued: rootResetToQueued, skip: rootSkip, purgeByJobId: rootPurgeByJobId } = useSmartApplyQueue(profile?.id);
  // Lifted to App root so Dashboard always sees current values without remounting.
  // InterviewPage, SalaryPage, NetworkingPage keep their own hook instances for mutations.
  const { session: rootInterviewSession } = useInterviewSession(profile?.id);
  const { data: rootSalaryData } = useSalaryResearch(profile?.id);
  const [rootNetworkContacts] = useNetworkingContacts(profile?.id);
  const networkingSessionCtx = useNetworkingSession(profile?.id);
  const { watchlist: companyWatchlist, add: watchlistAdd, remove: watchlistRemove, updateStatus: watchlistUpdateStatus } = useCompanyWatchlist(profile?.id);

  if (recoveryMode) return <ResetPasswordPage onDone={() => { clearRecovery(); window.history.replaceState({}, "", window.location.pathname); }} />;
  // Show a branded loading screen while Supabase exchanges the auth callback
  // token (email verification, magic link, OAuth). This replaces the confusing
  // login-form flash that users would otherwise see before the session resolves.
  if (authResolving) return (
    <div style={{ minHeight: "100vh", background: C.bgSoft, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 20 }}>
      <Logo size={52} />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
        <div style={{ width: 28, height: 28, border: `3px solid ${C.purple}30`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
        <div style={{ fontSize: 15, fontWeight: 600, color: C.textMid }}>Completing sign-in…</div>
        <div style={{ fontSize: 12, color: C.textMuted }}>This only takes a moment</div>
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
        .nav-pill:hover { color: ${C.navHover} !important; opacity: 1 !important; }
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
  .mobile-logo-row { gap: 2px !important; padding: 10px 4px 0 !important; }
  .hamburger-btn { display: block !important; width: 50px !important; height: 50px !important; font-size: 35px !important; line-height: 34px !important; }
  .subscription-badge { display: block !important; border: none !important; padding: 4px 4px !important; }
  .brand-logo { width: 43px !important; height: 43px !important; border-radius: 9px !important; }
  .brand-logo-glyph { font-size: 18px !important; }
  .brand-name { font-size: 24px !important; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; display: inline-block; max-width: 100%; }
  .brand-name-badge { font-size: 15px !important; margin-left: 0 !important; }
  .logo-block { gap: 5px !important; }
}
@media (min-width: 1025px) {
  /* 3-column grid: logo pinned left (auto), nav centered (1fr), utility pinned right (auto).
     justify-self:center on nav-pills keeps the gray pill background snug around buttons
     instead of expanding to fill the full 1fr column. grid-column:1 overrides the inline
     gridColumn:2 that mobile-logo-row sets on logo-block for its own mobile grid. */
  .hamburger-btn { display: none !important; }
  .subscription-badge { display: none !important; }
  header { display: grid !important; grid-template-columns: auto 1fr auto !important; align-items: center !important; padding: 8px 14px !important; column-gap: 8px !important; }
  .mobile-logo-row { display: contents !important; }
  .logo-block { grid-column: 1 !important; grid-row: 1 !important; justify-self: start !important; justify-content: flex-start !important; white-space: nowrap !important; gap: 7px !important; }
  .brand-logo { width: 38px !important; height: 38px !important; }
  .brand-logo-glyph { font-size: 17px !important; }
  .brand-name { font-size: 20px !important; }
  .brand-name-badge { font-size: 13px !important; margin-left: 0 !important; }
  .desktop-nav { display: contents !important; }
  .nav-pills { grid-column: 2 !important; grid-row: 1 !important; justify-self: center !important; gap: 4px !important; padding: 3px !important; }
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
          <div className="logo-block" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 14, minWidth: 0, cursor: "pointer", gridColumn: 2 }} onClick={goHome}>
            <Logo size={32} className="brand-logo" /><AppName size={17} className="brand-name" />
          </div>
          <button className="subscription-badge" onClick={() => setPage(planName === "FREE" ? "pricing" : "settings")} style={{ display: "none", gridColumn: 3, justifySelf: "end", background: planName === "FREE" ? "#fff" : C.purpleLight, border: `1.5px solid ${C.purple}`, borderRadius: 10, padding: "4px 9px", cursor: "pointer", textAlign: "center", lineHeight: 1.15 }}>
            <div style={{ fontSize: 11, fontWeight: 800, color: C.purple, whiteSpace: "nowrap", display: "flex", alignItems: "center", justifyContent: "center", gap: 1.5 }}>
              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style={{ flexShrink: 0 }} aria-hidden="true"><path d="M2 11v2h12v-2l1-5-3.5 2.2L8 4 4.5 8.2 1 6z" /><circle cx="3" cy="5.3" r="1" /><circle cx="8" cy="3.2" r="1.2" /><circle cx="13" cy="5.3" r="1" /></svg>
              <span style={{ lineHeight: 1 }}>{planName}</span>
            </div>
            {planName === "FREE" && (
              <div style={{ display: "flex", justifyContent: "center", marginTop: 1 }}>
                <span style={{ fontSize: 9, fontWeight: 600, lineHeight: 1.2, color: C.text, fontFamily: "'Inter','Segoe UI',system-ui,sans-serif", letterSpacing: "normal", whiteSpace: "nowrap" }}>Upgrade</span>
              </div>
            )}
          </button>
        </div>
        {/* Row 2: Nav + Utility */}
        <div className="desktop-nav" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "6px 16px 8px", gap: 4 }}>
          <NavPills nav={nav} page={page} setPage={setPage} />
          <div className="nav-utility" style={{ display: "flex", alignItems: "center", gap: 2, marginLeft: 6 }}>
            <LanguageMenu variant="icon" />
            <NotificationsMenu variant="icon" notifications={notifications} refresh={refreshNotifications} markAllRead={markAllRead} />
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
          <NotificationsMenu variant="row" notifications={notifications} refresh={refreshNotifications} markAllRead={markAllRead} />
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
        {page === "dashboard" && <DashboardPage profile={profile} applications={applications} savedJobs={savedJobs} setPage={setPage} resumes={resumes} smartApplyQueue={smartApplyQueue} smartApplyQueueLoading={smartApplyQueueLoading} networkingSession={networkingSessionCtx} notifications={notifications} interviewSession={rootInterviewSession} salaryData={rootSalaryData} networkContacts={rootNetworkContacts} activeResumeId={activeResumeId} companyWatchlist={companyWatchlist} />}
        {page === "briefing" && <BriefingPage profile={profile} applications={applications} savedJobs={savedJobs} setPage={setPage} />}
        {page === "plan" && <PlanPage profile={profile} applications={applications} savedJobs={savedJobs} setPage={setPage} />}
        {page === "resume" && <ResumePage onSave={handleSaveApp} onNavigate={setPage} profile={profile} applications={applications} savedJobs={savedJobs} resumes={resumes} resumesLoading={resumesLoading} saveResume={rootSaveResume} deleteResume={rootDeleteResume} downloadResume={rootDownloadResume} saveAnalysis={rootSaveAnalysis} updateVersionLabel={rootUpdateVersionLabel} analysisHistory={analysisHistory} saveHistoryToDb={saveHistoryToDb} onResumeLoad={setActiveResumeId} />}
        {page === "jobs" && <JobSearchPage savedJobs={savedJobs} setSavedJobs={setSavedJobs} setApplications={setApplications} applications={applications} profile={profile} resumes={resumes} onQueueChange={refreshSmartApplyQueue} queue={smartApplyQueue} enqueue={rootEnqueue} markReady={rootMarkReady} markFailed={rootMarkFailed} purgeQueueByJobId={rootPurgeByJobId} />}
        {page === "saved" && <SavedJobsPage savedJobs={savedJobs} setSavedJobs={setSavedJobs} setApplications={setApplications} profile={profile} resumes={resumes} onQueueChange={refreshSmartApplyQueue} queue={smartApplyQueue} queueLoading={smartApplyQueueLoading} markApplied={rootMarkApplied} markReady={rootMarkReady} markFailed={rootMarkFailed} resetToQueued={rootResetToQueued} skip={rootSkip} purgeQueueByJobId={rootPurgeByJobId} enqueue={rootEnqueue} />}
        {page === "interview" && <InterviewPage profile={profile} applications={applications} savedJobs={savedJobs} />}
        {page === "tracker" && <TrackerPage applications={applications} deleteApplication={handleDeleteApplication} saveApplication={handleSaveApplication} resumes={resumes} />}
        {page === "salary" && <SalaryPage profile={profile} applications={applications} savedJobs={savedJobs} />}
        {page === "network" && <NetworkingPage profile={profile} applications={applications} savedJobs={savedJobs} />}
        {page === "pricing" && <PricingPage profile={profile} />}
        {page === "opportunity" && <OpportunityPage profile={profile} savedJobs={savedJobs} applications={applications} setPage={setPage} watchlist={companyWatchlist} watchlistAdd={watchlistAdd} watchlistRemove={watchlistRemove} watchlistUpdateStatus={watchlistUpdateStatus} />}
        {page === "settings" && <SettingsPage profile={profile} updateProfile={updateProfile} logout={handleLogout} setPage={setPage} />}
        {page === "profile" && <ProfilePage profile={profile} updateProfile={updateProfile} />}
      </main>
    </div>
    </I18nContext.Provider>
  );
}

// v4.1 - fast prompts update

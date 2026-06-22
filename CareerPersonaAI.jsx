import { useState, useEffect, useCallback } from "react";

const ACCENT = "#7C3AED";
const ACCENT2 = "#06B6D4";
const ACCENT3 = "#10B981";
const DARK = "#0A0A0F";
const CARD = "#111118";
const CARD2 = "#18181F";
const BORDER = "#252530";
const TEXT = "#F1F1F5";
const MUTED = "#7878A0";
const DANGER = "#EF4444";
const WARNING = "#F59E0B";

const useAuth = () => {
  const [user, setUser] = useState(() => { try { return JSON.parse(localStorage.getItem("cp_user") || "null"); } catch { return null; } });
  const [profile, setProfile] = useState(() => { try { return JSON.parse(localStorage.getItem("cp_profile") || "null"); } catch { return null; } });
  const login = (userData) => { setUser(userData); const prof = { ...userData, plan: "free", analyses_used: 0, searches_used: 0 }; setProfile(prof); localStorage.setItem("cp_user", JSON.stringify(userData)); localStorage.setItem("cp_profile", JSON.stringify(prof)); };
  const logout = () => { setUser(null); setProfile(null); localStorage.removeItem("cp_user"); localStorage.removeItem("cp_profile"); };
  const updateProfile = (updates) => { const updated = { ...profile, ...updates }; setProfile(updated); localStorage.setItem("cp_profile", JSON.stringify(updated)); };
  return { user, profile, login, logout, updateProfile };
};

const useStorage = (key, initial) => {
  const [val, setVal] = useState(() => { try { const d = localStorage.getItem(key); return d ? JSON.parse(d) : initial; } catch { return initial; } });
  const set = useCallback((v) => { const next = typeof v === "function" ? v(val) : v; setVal(next); localStorage.setItem(key, JSON.stringify(next)); }, [key, val]);
  return [val, set];
};

async function callClaude(prompt, maxTokens = 2000) {
  const res = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }) });
  const data = await res.json();
  return (data.content?.map(b => b.text || "").join("") || "").replace(/```json|```/g, "").trim();
}

const S = {
  app: { minHeight: "100vh", background: DARK, color: TEXT, fontFamily: "'Inter','Segoe UI',sans-serif" },
  header: { background: `linear-gradient(135deg,${DARK} 0%,#0d0d18 100%)`, borderBottom: `1px solid ${BORDER}`, padding: "14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100 },
  logo: { display: "flex", alignItems: "center", gap: "10px" },
  logoIcon: { width: "32px", height: "32px", background: `linear-gradient(135deg,${ACCENT},${ACCENT2})`, borderRadius: "8px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "16px" },
  logoText: { fontSize: "17px", fontWeight: "800", background: `linear-gradient(135deg,${ACCENT},${ACCENT2})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", letterSpacing: "-0.5px" },
  nav: { display: "flex", gap: "2px", background: CARD2, borderRadius: "10px", padding: "3px", overflowX: "auto" },
  navBtn: { padding: "6px 12px", borderRadius: "7px", border: "none", background: "transparent", color: MUTED, fontSize: "12px", fontWeight: "600", cursor: "pointer", display: "flex", alignItems: "center", gap: "5px", whiteSpace: "nowrap" },
  navActive: { background: CARD, color: TEXT, boxShadow: "0 1px 4px rgba(0,0,0,0.4)" },
  main: { maxWidth: "1100px", margin: "0 auto", padding: "28px 18px 80px" },
  card: { background: CARD, border: `1px solid ${BORDER}`, borderRadius: "16px", padding: "22px" },
  card2: { background: CARD2, border: `1px solid ${BORDER}`, borderRadius: "12px", padding: "16px" },
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px" },
  grid3: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "14px" },
  label: { fontSize: "11px", fontWeight: "700", letterSpacing: "1.5px", textTransform: "uppercase", color: MUTED, marginBottom: "8px" },
  textarea: { width: "100%", minHeight: "180px", background: CARD2, border: `1px solid ${BORDER}`, borderRadius: "10px", color: TEXT, fontSize: "13px", lineHeight: "1.7", padding: "12px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" },
  input: { width: "100%", background: CARD2, border: `1px solid ${BORDER}`, borderRadius: "9px", color: TEXT, fontSize: "13px", padding: "10px 13px", outline: "none", fontFamily: "inherit", boxSizing: "border-box" },
  select: { width: "100%", background: CARD2, border: `1px solid ${BORDER}`, borderRadius: "9px", color: TEXT, fontSize: "13px", padding: "10px 13px", outline: "none", fontFamily: "inherit", boxSizing: "border-box", cursor: "pointer" },
  btnPrimary: { background: `linear-gradient(135deg,${ACCENT},#9333EA)`, color: "#fff", border: "none", borderRadius: "10px", padding: "12px 24px", fontSize: "14px", fontWeight: "700", cursor: "pointer", display: "flex", alignItems: "center", gap: "6px" },
  btnSecondary: { background: "transparent", color: MUTED, border: `1px solid ${BORDER}`, borderRadius: "10px", padding: "10px 18px", fontSize: "13px", fontWeight: "600", cursor: "pointer" },
  btnGreen: { background: `linear-gradient(135deg,${ACCENT3},#059669)`, color: "#fff", border: "none", borderRadius: "10px", padding: "10px 18px", fontSize: "13px", fontWeight: "700", cursor: "pointer" },
  btnCyan: { background: `linear-gradient(135deg,${ACCENT2},#0891B2)`, color: "#fff", border: "none", borderRadius: "10px", padding: "10px 18px", fontSize: "13px", fontWeight: "700", cursor: "pointer" },
  btnSmall: { background: "transparent", color: MUTED, border: `1px solid ${BORDER}`, borderRadius: "7px", padding: "5px 10px", fontSize: "11px", fontWeight: "600", cursor: "pointer" },
  btnDanger: { background: "transparent", color: DANGER, border: `1px solid ${DANGER}44`, borderRadius: "7px", padding: "5px 10px", fontSize: "11px", fontWeight: "600", cursor: "pointer" },
  tabRow: { display: "flex", gap: "3px", background: CARD2, borderRadius: "9px", padding: "3px", marginBottom: "18px" },
  tab: { flex: 1, padding: "7px 8px", borderRadius: "6px", border: "none", background: "transparent", color: MUTED, fontSize: "12px", fontWeight: "600", cursor: "pointer" },
  tabActive: { background: CARD, color: TEXT, boxShadow: "0 1px 3px rgba(0,0,0,0.3)" },
  textBox: { background: CARD2, border: `1px solid ${BORDER}`, borderRadius: "10px", padding: "16px", fontSize: "13px", lineHeight: "1.75", color: TEXT, whiteSpace: "pre-wrap", maxHeight: "320px", overflowY: "auto" },
  spinner: { width: "40px", height: "40px", border: `3px solid ${BORDER}`, borderTop: `3px solid ${ACCENT}`, borderRadius: "50%", animation: "spin 0.8s linear infinite" },
  errorBox: { background: `${DANGER}11`, border: `1px solid ${DANGER}33`, borderRadius: "10px", padding: "14px", color: DANGER, fontSize: "13px" },
  successBox: { background: `${ACCENT3}11`, border: `1px solid ${ACCENT3}33`, borderRadius: "10px", padding: "14px", color: ACCENT3, fontSize: "13px" },
  pageTitle: { fontSize: "24px", fontWeight: "800", letterSpacing: "-0.5px", marginBottom: "4px" },
  pageSub: { fontSize: "14px", color: MUTED, marginBottom: "24px" },
  progressBar: { height: "5px", background: BORDER, borderRadius: "3px", overflow: "hidden", marginTop: "5px" },
};

const badge = (c) => ({ background: `${c}18`, border: `1px solid ${c}44`, color: c, borderRadius: "5px", padding: "2px 8px", fontSize: "11px", fontWeight: "700" });

function Spinner({ text = "Working on it...", step = "" }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "50px 20px", gap: "16px" }}>
      <div style={S.spinner} />
      <div style={{ color: MUTED, fontSize: "14px" }}>{text}</div>
      {step && <div style={{ color: ACCENT2, fontSize: "12px", fontWeight: "600" }}>{step}</div>}
    </div>
  );
}

function CopyBtn({ text }) {
  const [c, setC] = useState(false);
  return <button style={S.btnSmall} onClick={() => { navigator.clipboard.writeText(text); setC(true); setTimeout(() => setC(false), 2000); }}>{c ? "✓" : "Copy"}</button>;
}

function ScoreRing({ score, size = 80 }) {
  const color = score >= 80 ? ACCENT3 : score >= 60 ? WARNING : DANGER;
  const r = size / 2 - 6; const circ = 2 * Math.PI * r; const dash = (score / 100) * circ;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={BORDER} strokeWidth="6" />
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth="6" strokeDasharray={`${dash} ${circ}`} strokeLinecap="round" style={{ transition: "stroke-dasharray 1s ease" }} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <span style={{ fontSize: size * 0.27, fontWeight: "800", color, lineHeight: 1 }}>{score}</span>
        <span style={{ fontSize: size * 0.12, color: MUTED, marginTop: "2px" }}>/ 100</span>
      </div>
    </div>
  );
}

function PBar({ val, color }) {
  const c = color || (val >= 80 ? ACCENT3 : val >= 60 ? WARNING : DANGER);
  return <div style={S.progressBar}><div style={{ height: "100%", width: `${val}%`, background: c, borderRadius: "3px", transition: "width 1s ease" }} /></div>;
}

function AuthPage({ onLogin }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ email: "", password: "", name: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const handle = async () => {
    if (!form.email) { setError("Email is required"); return; }
    if (mode === "signup" && !form.name) { setError("Name is required"); return; }
    setLoading(true); setError("");
    await new Promise(r => setTimeout(r, 800));
    if (mode === "reset") { setSuccess("Password reset email sent!"); setLoading(false); return; }
    onLogin({ id: Date.now().toString(), email: form.email, full_name: form.name || form.email.split("@")[0] });
    setLoading(false);
  };
  return (
    <div style={{ minHeight: "100vh", background: DARK, display: "flex", alignItems: "center", justifyContent: "center", padding: "20px" }}>
      <div style={{ width: "100%", maxWidth: "400px" }}>
        <div style={{ textAlign: "center", marginBottom: "28px" }}>
          <div style={{ width: "52px", height: "52px", background: `linear-gradient(135deg,${ACCENT},${ACCENT2})`, borderRadius: "14px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "26px", margin: "0 auto 14px" }}>🚀</div>
          <div style={{ fontSize: "22px", fontWeight: "800", background: `linear-gradient(135deg,${ACCENT},${ACCENT2})`, WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" }}>CareerPersona AI</div>
          <div style={{ fontSize: "13px", color: MUTED, marginTop: "5px" }}>Your AI-powered career platform</div>
        </div>
        <div style={S.card}>
          <div style={S.tabRow}>
            {["login","signup"].map(m => <button key={m} style={{ ...S.tab, ...(mode === m ? S.tabActive : {}) }} onClick={() => { setMode(m); setError(""); setSuccess(""); }}>{m === "login" ? "Sign In" : "Sign Up"}</button>)}
          </div>
          {mode === "signup" && <div style={{ marginBottom: "12px" }}><div style={S.label}>Full Name</div><input style={S.input} placeholder="John Smith" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>}
          <div style={{ marginBottom: "12px" }}><div style={S.label}>Email</div><input style={S.input} type="email" placeholder="you@email.com" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></div>
          {mode !== "reset" && <div style={{ marginBottom: "16px" }}><div style={S.label}>Password</div><input style={S.input} type="password" placeholder="••••••••" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} /></div>}
          {error && <div style={{ ...S.errorBox, marginBottom: "12px" }}>{error}</div>}
          {success && <div style={{ ...S.successBox, marginBottom: "12px" }}>{success}</div>}
          <button style={{ ...S.btnPrimary, width: "100%", justifyContent: "center", marginBottom: "10px" }} onClick={handle} disabled={loading}>{loading ? "Please wait..." : mode === "login" ? "Sign In" : mode === "signup" ? "Create Account" : "Send Reset Email"}</button>
          <button style={{ ...S.btnSecondary, width: "100%", justifyContent: "center", marginBottom: "14px", display: "flex", alignItems: "center", gap: "8px" }} onClick={() => onLogin({ id: "g_" + Date.now(), email: "user@gmail.com", full_name: "Google User" })}>
            <span style={{ fontWeight: "700" }}>G</span> Continue with Google
          </button>
          {mode === "login" && <div style={{ textAlign: "center" }}><button style={{ background: "none", border: "none", color: ACCENT2, cursor: "pointer", fontSize: "12px" }} onClick={() => setMode("reset")}>Forgot password?</button></div>}
        </div>
      </div>
    </div>
  );
}

const COUNTRIES = ["United States","Canada","United Kingdom","Australia","Germany","France","Remote Worldwide"];
const EMP_TYPES = ["Any","Full-time","Part-time","Contract","Internship"];
const EXP_LEVELS = ["Any","Entry Level","Mid Level","Senior","Executive"];

function JobSearchPage({ savedJobs, setSavedJobs, setApplications }) {
  const [filters, setFilters] = useState({ title: "", keywords: "", country: "United States", city: "", remote: false, salaryMin: "", salaryMax: "", employmentType: "Any", experienceLevel: "Any" });
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [analyzing, setAnalyzing] = useState(null);
  const [matchResult, setMatchResult] = useState(null);
  const [matchJobId, setMatchJobId] = useState(null);
  const [resume, setResume] = useState("");
  const [showResume, setShowResume] = useState(false);
  const [searched, setSearched] = useState(false);

  const search = async () => {
    if (!filters.title) { setError("Enter a job title"); return; }
    setError(""); setLoading(true); setJobs([]); setSearched(true);
    try {
      const raw = await callClaude(`Generate 12 realistic job listings for "${filters.title}" in ${filters.country}${filters.city ? ", " + filters.city : ""}${filters.remote ? " (remote)" : ""}. Return ONLY JSON array (no markdown):
[{"id":"job_<n>","title":"<title>","company":"<real company>","location":"<city, state>","salaryMin":<n>,"salaryMax":<n>,"currency":"USD","employmentType":"<Full-time|Part-time|Contract>","remote":<bool>,"description":"<3-4 sentences with requirements>","applyUrl":"https://linkedin.com/jobs","datePosted":"<recent date>","source":"<LinkedIn|Indeed|Glassdoor>","experienceLevel":"<Entry|Mid|Senior>","skills":["<s1>","<s2>","<s3>","<s4>"]}]
${filters.employmentType !== "Any" ? "Employment: " + filters.employmentType : ""} ${filters.experienceLevel !== "Any" ? "Experience: " + filters.experienceLevel : ""} ${filters.salaryMin ? "Min: $" + filters.salaryMin : ""}`, 3000);
      setJobs(JSON.parse(raw));
    } catch { setError("Search failed. Try again."); } finally { setLoading(false); }
  };

  const analyzeMatch = async (job) => {
    if (!resume) { setShowResume(true); return; }
    setAnalyzing(job.id); setMatchResult(null); setMatchJobId(job.id);
    try {
      const raw = await callClaude(`Analyze match. Return ONLY JSON (no markdown):
{"matchScore":<0-100>,"atsScore":<0-100>,"interviewProbability":<0-100>,"salaryFitScore":<0-100>,"matchingSkills":[<list>],"missingSkills":[<list>],"suggestions":["<s1>","<s2>","<s3>"],"summary":"<2 sentences>"}
RESUME: ${resume}
JOB: ${job.title} at ${job.company} - ${job.description}`, 1500);
      setMatchResult(JSON.parse(raw));
    } catch {} finally { setAnalyzing(null); }
  };

  const toggleSave = (job) => {
    const saved = savedJobs.find(j => j.job_id === job.id);
    if (saved) { setSavedJobs(prev => prev.filter(j => j.job_id !== job.id)); return; }
    setSavedJobs(prev => [{ job_id: job.id, ...job, saved_at: new Date().toISOString() }, ...prev]);
  };

  const isSaved = (jobId) => savedJobs.some(j => j.job_id === jobId);
  const addToTracker = (job) => setApplications(prev => [{ id: Date.now(), company: job.company, jobTitle: job.title, status: "Applied", date: new Date().toISOString().split("T")[0], atsScore: matchResult?.atsScore || 0, notes: "", url: job.applyUrl }, ...prev]);
  const fmtSalary = (min, max) => { if (!min && !max) return "Salary not listed"; const f = n => n >= 1000 ? `$${Math.round(n/1000)}K` : `$${n}`; if (min && max) return `${f(min)} – ${f(max)}`; return min ? `${f(min)}+` : `Up to ${f(max)}`; };

  return (
    <div>
      <div style={S.pageTitle}>🔍 Job Search</div>
      <div style={S.pageSub}>AI-powered job search across multiple sources with instant match scoring</div>
      <div style={{ ...S.card, marginBottom: "18px" }}>
        <div style={{ ...S.grid2, gap: "12px", marginBottom: "12px" }} className="two-col">
          <div><div style={S.label}>Job Title *</div><input style={S.input} placeholder="Software Engineer" value={filters.title} onChange={e => setFilters(f => ({ ...f, title: e.target.value }))} onKeyDown={e => e.key === "Enter" && search()} /></div>
          <div><div style={S.label}>Keywords</div><input style={S.input} placeholder="React, Python, remote" value={filters.keywords} onChange={e => setFilters(f => ({ ...f, keywords: e.target.value }))} /></div>
          <div><div style={S.label}>Country</div><select style={S.select} value={filters.country} onChange={e => setFilters(f => ({ ...f, country: e.target.value }))}>{COUNTRIES.map(c => <option key={c}>{c}</option>)}</select></div>
          <div><div style={S.label}>City</div><input style={S.input} placeholder="New York, London" value={filters.city} onChange={e => setFilters(f => ({ ...f, city: e.target.value }))} /></div>
          <div><div style={S.label}>Employment Type</div><select style={S.select} value={filters.employmentType} onChange={e => setFilters(f => ({ ...f, employmentType: e.target.value }))}>{EMP_TYPES.map(t => <option key={t}>{t}</option>)}</select></div>
          <div><div style={S.label}>Experience</div><select style={S.select} value={filters.experienceLevel} onChange={e => setFilters(f => ({ ...f, experienceLevel: e.target.value }))}>{EXP_LEVELS.map(l => <option key={l}>{l}</option>)}</select></div>
          <div><div style={S.label}>Min Salary ($)</div><input style={S.input} type="number" placeholder="80000" value={filters.salaryMin} onChange={e => setFilters(f => ({ ...f, salaryMin: e.target.value }))} /></div>
          <div><div style={S.label}>Max Salary ($)</div><input style={S.input} type="number" placeholder="150000" value={filters.salaryMax} onChange={e => setFilters(f => ({ ...f, salaryMax: e.target.value }))} /></div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "14px", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", cursor: "pointer", fontSize: "13px" }}><input type="checkbox" checked={filters.remote} onChange={e => setFilters(f => ({ ...f, remote: e.target.checked }))} />Remote Only</label>
          {error && <div style={{ color: DANGER, fontSize: "13px" }}>{error}</div>}
          <div style={{ marginLeft: "auto", display: "flex", gap: "10px" }}>
            <button style={{ ...S.btnSecondary, color: resume ? ACCENT3 : MUTED }} onClick={() => setShowResume(!showResume)}>📄 {resume ? "Resume ✓" : "Add Resume"}</button>
            <button style={S.btnPrimary} onClick={search}>🔍 Search Jobs</button>
          </div>
        </div>
        {showResume && (
          <div style={{ marginTop: "14px" }}>
            <div style={S.label}>Resume (for AI match scoring)</div>
            <textarea style={{ ...S.textarea, minHeight: "110px" }} placeholder="Paste your resume for instant match scores…" value={resume} onChange={e => setResume(e.target.value)} />
            {resume && <button style={{ ...S.btnGreen, marginTop: "8px" }} onClick={() => setShowResume(false)}>✓ Resume Saved</button>}
          </div>
        )}
      </div>

      {matchResult && matchJobId && (
        <div style={{ ...S.card, marginBottom: "18px", border: `1px solid ${ACCENT}44` }} className="fade-in">
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "16px" }}>
            <div><div style={{ fontSize: "15px", fontWeight: "700" }}>AI Match Analysis</div><div style={{ fontSize: "12px", color: MUTED, marginTop: "3px" }}>{matchResult.summary}</div></div>
            <button style={S.btnSmall} onClick={() => { setMatchResult(null); setMatchJobId(null); }}>✕</button>
          </div>
          <div style={{ display: "flex", gap: "16px", flexWrap: "wrap", marginBottom: "16px" }}>
            {[["Match", matchResult.matchScore], ["ATS", matchResult.atsScore], ["Interview %", matchResult.interviewProbability], ["Salary Fit", matchResult.salaryFitScore]].map(([l, v]) => (
              <div key={l} style={{ textAlign: "center" }}><ScoreRing score={v} size={65} /><div style={{ fontSize: "10px", color: MUTED, marginTop: "5px" }}>{l}</div></div>
            ))}
          </div>
          <div style={{ ...S.grid2, gap: "10px" }} className="two-col">
            <div style={S.card2}><div style={{ fontSize: "10px", color: ACCENT3, fontWeight: "700", marginBottom: "7px" }}>✓ MATCHING</div><div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>{matchResult.matchingSkills?.map(s => <span key={s} style={badge(ACCENT3)}>{s}</span>)}</div></div>
            <div style={S.card2}><div style={{ fontSize: "10px", color: DANGER, fontWeight: "700", marginBottom: "7px" }}>✗ MISSING</div><div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>{matchResult.missingSkills?.map(s => <span key={s} style={badge(DANGER)}>{s}</span>)}</div></div>
          </div>
        </div>
      )}

      {loading && <Spinner text="Searching jobs…" step="Finding best matches for you…" />}
      {searched && !loading && jobs.length === 0 && <div style={{ ...S.card, textAlign: "center", padding: "48px" }}><div style={{ fontSize: "32px", marginBottom: "12px" }}>🔍</div><div>No results — try different keywords</div></div>}

      {jobs.length > 0 && (
        <div>
          <div style={{ fontSize: "13px", color: MUTED, marginBottom: "12px" }}>{jobs.length} jobs found for "{filters.title}"</div>
          <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
            {jobs.map(job => (
              <div key={job.id} style={{ ...S.card, ...(matchJobId === job.id ? { border: `1px solid ${ACCENT}44` } : {}) }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
                  <div style={{ flex: 1, minWidth: "200px" }}>
                    <div style={{ display: "flex", gap: "6px", marginBottom: "7px", flexWrap: "wrap" }}>
                      <span style={badge(ACCENT2)}>{job.source}</span>
                      {job.remote && <span style={badge(ACCENT3)}>Remote</span>}
                      <span style={badge(MUTED)}>{job.employmentType}</span>
                      {job.experienceLevel && <span style={badge(WARNING)}>{job.experienceLevel}</span>}
                    </div>
                    <div style={{ fontSize: "15px", fontWeight: "700", marginBottom: "3px" }}>{job.title}</div>
                    <div style={{ fontSize: "12px", color: MUTED, marginBottom: "5px" }}>{job.company} · {job.location}</div>
                    <div style={{ fontSize: "13px", color: ACCENT3, fontWeight: "600", marginBottom: "7px" }}>{fmtSalary(job.salaryMin, job.salaryMax)}</div>
                    <div style={{ fontSize: "12px", color: MUTED, lineHeight: 1.6, marginBottom: "8px" }}>{job.description?.slice(0, 180)}…</div>
                    {job.skills && <div style={{ display: "flex", flexWrap: "wrap", gap: "4px" }}>{job.skills.slice(0, 4).map(s => <span key={s} style={{ background: `${ACCENT}18`, color: ACCENT, borderRadius: "4px", padding: "2px 7px", fontSize: "11px" }}>{s}</span>)}</div>}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px", flexShrink: 0 }}>
                    <a href={job.applyUrl} target="_blank" rel="noreferrer" style={{ ...S.btnPrimary, textDecoration: "none", fontSize: "12px", padding: "8px 14px" }}>Apply →</a>
                    <button style={{ ...S.btnSecondary, fontSize: "12px", padding: "7px 12px" }} onClick={() => analyzeMatch(job)} disabled={analyzing === job.id}>{analyzing === job.id ? "…" : "🤖 AI Match"}</button>
                    <button style={{ ...S.btnSmall, color: isSaved(job.id) ? ACCENT3 : MUTED }} onClick={() => toggleSave(job)}>{isSaved(job.id) ? "♥ Saved" : "♡ Save"}</button>
                    <button style={S.btnSmall} onClick={() => addToTracker(job)}>+ Track</button>
                  </div>
                </div>
                {matchJobId === job.id && matchResult && (
                  <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: `1px solid ${BORDER}`, display: "flex", gap: "12px", flexWrap: "wrap" }}>
                    {[["Match", matchResult.matchScore, ACCENT], ["ATS", matchResult.atsScore, ACCENT2], ["Interview", matchResult.interviewProbability, ACCENT3]].map(([l, v, c]) => (
                      <div key={l} style={{ flex: 1, minWidth: "80px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: "3px" }}><span style={{ color: MUTED }}>{l}</span><span style={{ color: c, fontWeight: "700" }}>{v}%</span></div>
                        <PBar val={v} color={c} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SavedJobsPage({ savedJobs, setSavedJobs, setApplications }) {
  const remove = id => setSavedJobs(prev => prev.filter(j => j.job_id !== id));
  const addToTracker = job => setApplications(prev => [{ id: Date.now(), company: job.company, jobTitle: job.title, status: "Applied", date: new Date().toISOString().split("T")[0], notes: "", url: job.applyUrl }, ...prev]);
  return (
    <div>
      <div style={S.pageTitle}>♥ Saved Jobs</div>
      <div style={S.pageSub}>{savedJobs.length} saved job{savedJobs.length !== 1 ? "s" : ""} — apply when you're ready</div>
      {savedJobs.length === 0 && <div style={{ ...S.card, textAlign: "center", padding: "60px" }}><div style={{ fontSize: "40px", marginBottom: "14px" }}>♡</div><div style={{ fontSize: "15px", fontWeight: "600" }}>No saved jobs yet</div><div style={{ fontSize: "13px", color: MUTED, marginTop: "6px" }}>Heart any job in Job Search to save it here</div></div>}
      <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        {savedJobs.map(job => (
          <div key={job.job_id} style={S.card}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: "15px", fontWeight: "700", marginBottom: "3px" }}>{job.title}</div>
                <div style={{ fontSize: "12px", color: MUTED, marginBottom: "6px" }}>{job.company} · {job.location}</div>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  {job.remote && <span style={badge(ACCENT3)}>Remote</span>}
                  {job.employmentType && <span style={badge(MUTED)}>{job.employmentType}</span>}
                </div>
              </div>
              <div style={{ display: "flex", gap: "6px", flexWrap: "wrap", alignItems: "flex-start" }}>
                <a href={job.applyUrl} target="_blank" rel="noreferrer" style={{ ...S.btnPrimary, textDecoration: "none", fontSize: "12px", padding: "8px 14px" }}>Apply →</a>
                <button style={S.btnGreen} onClick={() => addToTracker(job)}>+ Track</button>
                <button style={S.btnDanger} onClick={() => remove(job.job_id)}>✕</button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const SAMPLE_RESUME = `John Smith | john@email.com | San Francisco, CA
SUMMARY: Software engineer with 4 years experience in React, Node.js, Python.
EXPERIENCE: Software Engineer — Acme Corp (2021–Present) • Built dashboards 50K+ users • Reduced API time 40%
EDUCATION: B.S. Computer Science — UC Berkeley, 2020
SKILLS: JavaScript, React, Node.js, Python, SQL, Git`;
const SAMPLE_JOB = `Senior Frontend Engineer — TechCorp
Requirements: 4+ years React, TypeScript, GraphQL, Redux, Next.js, CI/CD. Salary: $140K–$180K, remote, equity.`;

function ResumePage({ onSaveApplication }) {
  const [resume, setResume] = useState(""); const [jobDesc, setJobDesc] = useState(""); const [loading, setLoading] = useState(false); const [step, setStep] = useState(""); const [results, setResults] = useState(null); const [error, setError] = useState(""); const [tab, setTab] = useState("resume"); const [saved, setSaved] = useState(false);
  const analyze = async () => {
    if (!resume.trim() || !jobDesc.trim()) { setError("Add both resume and job description."); return; }
    setError(""); setLoading(true); setResults(null);
    const steps = ["Reading resume…","Analyzing job…","Scoring ATS…","Tailoring…","Cover letter…"]; let i = 0; setStep(steps[0]);
    const iv = setInterval(() => { i = (i+1)%steps.length; setStep(steps[i]); }, 1800);
    try {
      const raw = await callClaude(`ATS resume coach. Return ONLY JSON (no markdown):
{"atsScore":<0-100>,"scoreBreakdown":{"keywordMatch":<0-100>,"formatting":<0-100>,"relevance":<0-100>},"keywordsFound":[<6-10>],"keywordsMissing":[<6-10>],"tailoredResume":"<full optimized resume>","suggestions":["<t1>","<t2>","<t3>","<t4>","<t5>"],"coverLetter":"<3 para cover letter>","jobTitle":"<title>","company":"<company>"}
RESUME: ${resume}\nJOB: ${jobDesc}`, 3000);
      setResults(JSON.parse(raw)); setTab("resume");
    } catch { setError("Analysis failed. Try again."); } finally { clearInterval(iv); setLoading(false); }
  };
  const handleSave = () => { if (!results) return; onSaveApplication({ id: Date.now(), company: results.company || "Company", jobTitle: results.jobTitle || "Role", status: "Applied", atsScore: results.atsScore, date: new Date().toISOString().split("T")[0], notes: "", resume: results.tailoredResume, coverLetter: results.coverLetter }); setSaved(true); setTimeout(() => setSaved(false), 3000); };
  return (
    <div>
      <div style={{ textAlign: "center", maxWidth: "580px", margin: "0 auto 24px" }}>
        <div style={{ fontSize: "11px", color: ACCENT2, fontWeight: "700", letterSpacing: "2px", textTransform: "uppercase", marginBottom: "8px" }}>AI Resume Intelligence</div>
        <h1 style={{ fontSize: "clamp(22px,4vw,36px)", fontWeight: "800", letterSpacing: "-1px", marginBottom: "8px" }}>Beat the ATS. Land the Interview.</h1>
        <p style={{ fontSize: "13px", color: MUTED, lineHeight: 1.6 }}>AI tailors your resume, scores it against ATS filters, and writes your cover letter instantly.</p>
      </div>
      {!results && <div style={{ ...S.grid2, marginBottom: "14px" }} className="two-col">
        <div style={S.card}><div style={S.label}>Your Resume</div><textarea style={S.textarea} placeholder="Paste your resume…" value={resume} onChange={e => setResume(e.target.value)} /></div>
        <div style={S.card}><div style={S.label}>Job Description</div><textarea style={S.textarea} placeholder="Paste the job description…" value={jobDesc} onChange={e => setJobDesc(e.target.value)} /></div>
      </div>}
      {error && <div style={{ ...S.errorBox, marginBottom: "12px" }}>{error}</div>}
      {!results && !loading && <div style={{ display: "flex", gap: "10px", justifyContent: "center", marginBottom: "22px" }}><button style={S.btnPrimary} onClick={analyze}>⚡ Analyze & Tailor</button><button style={S.btnSecondary} onClick={() => { setResume(SAMPLE_RESUME); setJobDesc(SAMPLE_JOB); }}>Try Sample</button></div>}
      {loading && <Spinner text="Analyzing your resume…" step={step} />}
      {results && (
        <div style={S.card} className="fade-in">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "20px", flexWrap: "wrap", gap: "12px" }}>
            <div><div style={{ fontSize: "16px", fontWeight: "700" }}>Analysis Complete</div>{results.company && <div style={{ fontSize: "12px", color: MUTED, marginTop: "3px" }}>{results.jobTitle} at {results.company}</div>}<div style={{ fontSize: "13px", fontWeight: "600", color: results.atsScore >= 80 ? ACCENT3 : results.atsScore >= 60 ? WARNING : DANGER, marginTop: "4px" }}>{results.atsScore >= 80 ? "🎉 Strong match!" : results.atsScore >= 60 ? "👍 Good — refine a bit" : "⚠️ Needs improvement"}</div></div>
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}><ScoreRing score={results.atsScore} /><div style={{ display: "flex", flexDirection: "column", gap: "7px" }}><button style={S.btnGreen} onClick={handleSave}>{saved ? "✓ Saved!" : "💾 Save to Tracker"}</button><button style={S.btnSecondary} onClick={() => { setResults(null); setResume(""); setJobDesc(""); }}>← New</button></div></div>
          </div>
          <div style={{ marginBottom: "18px" }}>
            {[["Keyword Match", results.scoreBreakdown?.keywordMatch], ["Formatting", results.scoreBreakdown?.formatting], ["Relevance", results.scoreBreakdown?.relevance]].map(([l, v]) => (
              <div key={l} style={{ marginBottom: "9px" }}><div style={{ display: "flex", justifyContent: "space-between", fontSize: "12px", marginBottom: "3px" }}><span>{l}</span><span style={{ fontWeight: "700", color: v >= 80 ? ACCENT3 : v >= 60 ? WARNING : DANGER }}>{v}%</span></div><PBar val={v} /></div>
            ))}
          </div>
          <div style={{ marginBottom: "18px" }}>
            <div style={{ fontSize: "10px", color: ACCENT3, fontWeight: "700", marginBottom: "6px" }}>✓ KEYWORDS FOUND</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "5px", marginBottom: "10px" }}>{results.keywordsFound?.map(k => <span key={k} style={badge(ACCENT3)}>{k}</span>)}</div>
            <div style={{ fontSize: "10px", color: DANGER, fontWeight: "700", marginBottom: "6px" }}>✗ MISSING KEYWORDS</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "5px" }}>{results.keywordsMissing?.map(k => <span key={k} style={badge(DANGER)}>{k}</span>)}</div>
          </div>
          <div style={S.tabRow}>{[["resume","✨ Tailored Resume"],["suggestions","💡 Tips"],["cover","📄 Cover Letter"]].map(([id, lbl]) => <button key={id} style={{ ...S.tab, ...(tab === id ? S.tabActive : {}) }} onClick={() => setTab(id)}>{lbl}</button>)}</div>
          {tab === "resume" && <div><div style={{ display: "flex", justifyContent: "space-between", marginBottom: "7px" }}><span style={{ fontSize: "11px", color: MUTED }}>AI-optimized for this role</span><CopyBtn text={results.tailoredResume} /></div><div style={S.textBox}>{results.tailoredResume}</div></div>}
          {tab === "suggestions" && <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>{results.suggestions?.map((s, i) => <div key={i} style={{ ...S.card2, display: "flex", gap: "10px" }}><span>{"🎯📝💼🔧⚡"[i]}</span><span style={{ fontSize: "13px", lineHeight: 1.6 }}>{s}</span></div>)}</div>}
          {tab === "cover" && <div><div style={{ display: "flex", justifyContent: "space-between", marginBottom: "7px" }}><span style={{ fontSize: "11px", color: MUTED }}>Personalized cover letter</span><CopyBtn text={results.coverLetter} /></div><div style={S.textBox}>{results.coverLetter}</div></div>}
        </div>
      )}
    </div>
  );
}

function InterviewPage() {
  const [jobDesc, setJobDesc] = useState(""); const [resume, setResume] = useState(""); const [loading, setLoading] = useState(false); const [questions, setQuestions] = useState([]); const [activeQ, setActiveQ] = useState(null); const [answer, setAnswer] = useState(""); const [feedback, setFeedback] = useState(null); const [fbLoading, setFbLoading] = useState(false); const [filterCat, setFilterCat] = useState("All");
  const diffColor = { Easy: ACCENT3, Medium: WARNING, Hard: DANGER };
  const generate = async () => { if (!jobDesc.trim()) return; setLoading(true); setQuestions([]); try { const raw = await callClaude(`Generate 12 interview questions. Return ONLY JSON array (no markdown):\n[{"id":1,"category":"<Behavioral|Technical|Situational|Culture Fit>","difficulty":"<Easy|Medium|Hard>","question":"<q>","whyAsked":"<why>","tipToAnswer":"<tip>","sampleAnswer":"<answer>"}]\nJOB: ${jobDesc}${resume ? "\nRESUME: " + resume : ""}`, 3000); setQuestions(JSON.parse(raw)); } catch {} finally { setLoading(false); } };
  const getFeedback = async () => { if (!answer.trim()) return; setFbLoading(true); setFeedback(null); try { const raw = await callClaude(`Rate answer. Return ONLY JSON:\n{"score":<1-10>,"strengths":["<s1>","<s2>"],"improvements":["<i1>","<i2>"],"revisedAnswer":"<better>"}\nQ: ${activeQ.question}\nA: ${answer}`, 1500); setFeedback(JSON.parse(raw)); } catch {} finally { setFbLoading(false); } };
  const cats = ["All","Behavioral","Technical","Situational","Culture Fit"];
  const filtered = questions.filter(q => filterCat === "All" || q.category === filterCat);
  return (
    <div>
      <div style={S.pageTitle}>🎤 Interview Prep</div>
      <div style={S.pageSub}>AI generates tailored questions and coaches you on your answers.</div>
      {!questions.length && <div style={{ display: "flex", flexDirection: "column", gap: "12px", marginBottom: "16px" }}>
        <div style={S.card}><div style={S.label}>Job Description *</div><textarea style={{ ...S.textarea, minHeight: "130px" }} placeholder="Paste job description…" value={jobDesc} onChange={e => setJobDesc(e.target.value)} /></div>
        <div style={S.card}><div style={S.label}>Resume (optional)</div><textarea style={{ ...S.textarea, minHeight: "90px" }} placeholder="Paste resume for personalized questions…" value={resume} onChange={e => setResume(e.target.value)} /></div>
        <div style={{ display: "flex", gap: "10px" }}><button style={S.btnPrimary} onClick={generate} disabled={!jobDesc.trim()}>🎤 Generate Questions</button><button style={S.btnSecondary} onClick={() => { setJobDesc(SAMPLE_JOB); setResume(SAMPLE_RESUME); }}>Try Sample</button></div>
      </div>}
      {loading && <Spinner text="Generating interview questions…" />}
      {questions.length > 0 && !activeQ && (
        <div className="fade-in">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
            <div style={{ fontSize: "13px", fontWeight: "600" }}>{questions.length} questions</div>
            <div style={{ display: "flex", gap: "5px", flexWrap: "wrap" }}>{cats.map(c => <button key={c} style={{ ...S.btnSmall, ...(filterCat === c ? { background: ACCENT, color: "#fff", borderColor: ACCENT } : {}) }} onClick={() => setFilterCat(c)}>{c}</button>)}</div>
            <button style={S.btnSecondary} onClick={() => { setQuestions([]); setJobDesc(""); setResume(""); }}>← New</button>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {filtered.map((q, i) => <div key={q.id} style={{ ...S.card2, cursor: "pointer" }} onClick={() => { setActiveQ(q); setAnswer(""); setFeedback(null); }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <div><div style={{ display: "flex", gap: "6px", marginBottom: "6px" }}><span style={badge(ACCENT)}>{q.category}</span><span style={badge(diffColor[q.difficulty])}>{q.difficulty}</span></div><div style={{ fontSize: "13px", lineHeight: 1.5 }}>Q{i+1}. {q.question}</div></div>
                <span style={{ color: MUTED, fontSize: "18px" }}>›</span>
              </div>
            </div>)}
          </div>
        </div>
      )}
      {activeQ && (
        <div className="fade-in">
          <button style={{ ...S.btnSecondary, marginBottom: "14px" }} onClick={() => { setActiveQ(null); setFeedback(null); }}>← Back</button>
          <div style={S.card}>
            <div style={{ display: "flex", gap: "6px", marginBottom: "10px" }}><span style={badge(ACCENT)}>{activeQ.category}</span><span style={badge(diffColor[activeQ.difficulty])}>{activeQ.difficulty}</span></div>
            <div style={{ fontSize: "16px", fontWeight: "700", lineHeight: 1.4, marginBottom: "12px" }}>{activeQ.question}</div>
            <div style={{ ...S.card2, marginBottom: "12px" }}><div style={{ fontSize: "10px", color: ACCENT2, fontWeight: "700", marginBottom: "5px" }}>WHY THEY ASK</div><div style={{ fontSize: "13px", lineHeight: 1.6 }}>{activeQ.whyAsked}</div></div>
            <div style={{ ...S.card2, marginBottom: "16px" }}><div style={{ fontSize: "10px", color: WARNING, fontWeight: "700", marginBottom: "5px" }}>💡 HOW TO ANSWER</div><div style={{ fontSize: "13px", lineHeight: 1.6 }}>{activeQ.tipToAnswer}</div></div>
            <div style={S.label}>Your Practice Answer</div>
            <textarea style={{ ...S.textarea, minHeight: "120px", marginBottom: "10px" }} placeholder="Type your answer to get AI coaching…" value={answer} onChange={e => setAnswer(e.target.value)} />
            <button style={{ ...S.btnPrimary, marginBottom: "16px" }} onClick={getFeedback} disabled={!answer.trim() || fbLoading}>{fbLoading ? "Analyzing…" : "🧠 Get AI Feedback"}</button>
            {fbLoading && <Spinner text="Analyzing your answer…" />}
            {feedback && !fbLoading && <div className="fade-in">
              <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "14px" }}><span style={{ fontSize: "12px", color: MUTED }}>Score</span><span style={{ fontSize: "26px", fontWeight: "800", color: feedback.score >= 8 ? ACCENT3 : feedback.score >= 6 ? WARNING : DANGER }}>{feedback.score}/10</span></div>
              <div style={{ ...S.grid2, gap: "10px", marginBottom: "12px" }} className="two-col">
                <div style={S.card2}><div style={{ fontSize: "10px", color: ACCENT3, fontWeight: "700", marginBottom: "6px" }}>✓ STRENGTHS</div>{feedback.strengths?.map((s, i) => <div key={i} style={{ fontSize: "12px", marginBottom: "5px" }}>• {s}</div>)}</div>
                <div style={S.card2}><div style={{ fontSize: "10px", color: WARNING, fontWeight: "700", marginBottom: "6px" }}>↑ IMPROVE</div>{feedback.improvements?.map((s, i) => <div key={i} style={{ fontSize: "12px", marginBottom: "5px" }}>• {s}</div>)}</div>
              </div>
              {feedback.revisedAnswer && <div><div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}><div style={{ fontSize: "10px", color: ACCENT, fontWeight: "700" }}>✨ STRONGER VERSION</div><CopyBtn text={feedback.revisedAnswer} /></div><div style={S.textBox}>{feedback.revisedAnswer}</div></div>}
            </div>}
            <div style={{ marginTop: "18px", borderTop: `1px solid ${BORDER}`, paddingTop: "16px" }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: "7px" }}><div style={{ fontSize: "10px", color: MUTED, fontWeight: "700" }}>📖 SAMPLE ANSWER</div><CopyBtn text={activeQ.sampleAnswer} /></div><div style={S.textBox}>{activeQ.sampleAnswer}</div></div>
          </div>
        </div>
      )}
    </div>
  );
}

const STATUSES = ["Saved","Applied","Phone Screen","Interview","Final Interview","Offer","Rejected","Ghosted"];
const STATUS_COLOR = { Saved: MUTED, Applied: ACCENT, "Phone Screen": WARNING, Interview: ACCENT2, "Final Interview": "#8B5CF6", Offer: ACCENT3, Rejected: DANGER, Ghosted: MUTED };

function TrackerPage({ applications, setApplications }) {
  const [showForm, setShowForm] = useState(false); const [editId, setEditId] = useState(null); const [form, setForm] = useState({ company: "", jobTitle: "", status: "Applied", date: new Date().toISOString().split("T")[0], atsScore: "", notes: "", url: "", contactName: "", contactEmail: "", followUpDate: "" }); const [filterStatus, setFilterStatus] = useState("All"); const [viewApp, setViewApp] = useState(null);
  const save = () => { if (!form.company || !form.jobTitle) return; if (editId) { setApplications(prev => prev.map(a => a.id === editId ? { ...a, ...form } : a)); setEditId(null); } else { setApplications(prev => [{ ...form, id: Date.now() }, ...prev]); } setForm({ company: "", jobTitle: "", status: "Applied", date: new Date().toISOString().split("T")[0], atsScore: "", notes: "", url: "", contactName: "", contactEmail: "", followUpDate: "" }); setShowForm(false); };
  const del = id => setApplications(prev => prev.filter(a => a.id !== id));
  const edit = app => { setForm({ ...app }); setEditId(app.id); setShowForm(true); setViewApp(null); };
  const filtered = applications.filter(a => filterStatus === "All" || a.status === filterStatus);
  const stats = STATUSES.reduce((acc, s) => { acc[s] = applications.filter(a => a.status === s).length; return acc; }, {});
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "18px", flexWrap: "wrap", gap: "10px" }}>
        <div><div style={S.pageTitle}>📋 Application Tracker</div><div style={{ fontSize: "13px", color: MUTED }}>{applications.length} applications</div></div>
        <button style={S.btnPrimary} onClick={() => { setShowForm(true); setEditId(null); }}>+ Add</button>
      </div>
      {applications.length > 0 && <div style={{ display: "flex", gap: "7px", marginBottom: "14px", overflowX: "auto", paddingBottom: "4px" }}>
        {STATUSES.filter(s => stats[s] > 0).map(s => <div key={s} style={{ background: `${STATUS_COLOR[s]}18`, border: `1px solid ${STATUS_COLOR[s]}44`, borderRadius: "9px", padding: "7px 12px", flexShrink: 0, textAlign: "center" }}><div style={{ fontSize: "17px", fontWeight: "800", color: STATUS_COLOR[s] }}>{stats[s]}</div><div style={{ fontSize: "10px", color: MUTED, marginTop: "2px" }}>{s}</div></div>)}
      </div>}
      <div style={{ display: "flex", gap: "5px", marginBottom: "12px", flexWrap: "wrap" }}>
        {["All", ...STATUSES].map(s => <button key={s} style={{ ...S.btnSmall, ...(filterStatus === s ? { background: STATUS_COLOR[s] || ACCENT, color: "#fff", borderColor: STATUS_COLOR[s] || ACCENT } : {}) }} onClick={() => setFilterStatus(s)}>{s}</button>)}
      </div>
      {showForm && <div style={{ ...S.card, marginBottom: "16px", border: `1px solid ${ACCENT}44` }}>
        <div style={{ fontSize: "14px", fontWeight: "700", marginBottom: "14px" }}>{editId ? "Edit" : "Add"} Application</div>
        <div style={{ ...S.grid2, gap: "11px", marginBottom: "11px" }} className="two-col">
          <div><div style={S.label}>Company *</div><input style={S.input} placeholder="Google" value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value }))} /></div>
          <div><div style={S.label}>Job Title *</div><input style={S.input} placeholder="Engineer" value={form.jobTitle} onChange={e => setForm(f => ({ ...f, jobTitle: e.target.value }))} /></div>
          <div><div style={S.label}>Status</div><select style={S.select} value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>{STATUSES.map(s => <option key={s}>{s}</option>)}</select></div>
          <div><div style={S.label}>Date Applied</div><input type="date" style={S.input} value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} /></div>
          <div><div style={S.label}>Follow-up Date</div><input type="date" style={S.input} value={form.followUpDate} onChange={e => setForm(f => ({ ...f, followUpDate: e.target.value }))} /></div>
          <div><div style={S.label}>ATS Score</div><input style={S.input} type="number" placeholder="82" value={form.atsScore} onChange={e => setForm(f => ({ ...f, atsScore: e.target.value }))} /></div>
          <div><div style={S.label}>Contact Name</div><input style={S.input} placeholder="Recruiter" value={form.contactName} onChange={e => setForm(f => ({ ...f, contactName: e.target.value }))} /></div>
          <div><div style={S.label}>Contact Email</div><input style={S.input} placeholder="hr@company.com" value={form.contactEmail} onChange={e => setForm(f => ({ ...f, contactEmail: e.target.value }))} /></div>
          <div style={{ gridColumn: "1 / -1" }}><div style={S.label}>Job URL</div><input style={S.input} placeholder="https://…" value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} /></div>
        </div>
        <div style={{ marginBottom: "12px" }}><div style={S.label}>Notes</div><textarea style={{ ...S.textarea, minHeight: "70px" }} placeholder="Interview notes, tasks…" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></div>
        <div style={{ display: "flex", gap: "8px" }}><button style={S.btnPrimary} onClick={save}>💾 Save</button><button style={S.btnSecondary} onClick={() => { setShowForm(false); setEditId(null); }}>Cancel</button></div>
      </div>}
      {viewApp && <div style={{ ...S.card, marginBottom: "14px", border: `1px solid ${STATUS_COLOR[viewApp.status]}44` }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "12px" }}><div><div style={{ fontSize: "15px", fontWeight: "700" }}>{viewApp.jobTitle}</div><div style={{ fontSize: "12px", color: MUTED }}>{viewApp.company} · {viewApp.date}</div></div><button style={S.btnSmall} onClick={() => setViewApp(null)}>✕</button></div>
        {viewApp.resume && <div style={{ marginBottom: "12px" }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}><div style={S.label}>Resume</div><CopyBtn text={viewApp.resume} /></div><div style={{ ...S.textBox, maxHeight: "160px" }}>{viewApp.resume}</div></div>}
        {viewApp.coverLetter && <div style={{ marginBottom: "12px" }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: "6px" }}><div style={S.label}>Cover Letter</div><CopyBtn text={viewApp.coverLetter} /></div><div style={{ ...S.textBox, maxHeight: "160px" }}>{viewApp.coverLetter}</div></div>}
        {viewApp.notes && <div style={S.card2}><div style={S.label}>Notes</div><div style={{ fontSize: "13px" }}>{viewApp.notes}</div></div>}
      </div>}
      {filtered.length === 0 && !showForm && <div style={{ ...S.card, textAlign: "center", padding: "48px" }}><div style={{ fontSize: "36px", marginBottom: "10px" }}>📋</div><div style={{ fontSize: "14px", fontWeight: "600" }}>No applications yet</div><div style={{ fontSize: "12px", color: MUTED, marginTop: "6px" }}>Add one or save from Resume Tailor</div></div>}
      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        {filtered.map(app => <div key={app.id} style={{ ...S.card2, display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: "150px" }}>
            <div style={{ fontSize: "13px", fontWeight: "700" }}>{app.jobTitle}</div>
            <div style={{ fontSize: "11px", color: MUTED, marginTop: "2px" }}>{app.company} · {app.date}</div>
            {app.followUpDate && <div style={{ fontSize: "10px", color: WARNING, marginTop: "2px" }}>⏰ {app.followUpDate}</div>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "6px", flexWrap: "wrap" }}>
            {app.atsScore > 0 && <span style={{ fontSize: "11px", color: ACCENT2, fontWeight: "700" }}>ATS {app.atsScore}</span>}
            <span style={badge(STATUS_COLOR[app.status])}>{app.status}</span>
            {(app.resume || app.coverLetter || app.notes) && <button style={S.btnSmall} onClick={() => setViewApp(viewApp?.id === app.id ? null : app)}>View</button>}
            {app.url && <a href={app.url} target="_blank" rel="noreferrer" style={{ ...S.btnSmall, textDecoration: "none" }}>🔗</a>}
            <button style={S.btnSmall} onClick={() => edit(app)}>Edit</button>
            <button style={S.btnDanger} onClick={() => del(app.id)}>✕</button>
          </div>
        </div>)}
      </div>
    </div>
  );
}

function SalaryPage() {
  const [form, setForm] = useState({ jobTitle: "", location: "", experience: "", skills: "", company: "" }); const [loading, setLoading] = useState(false); const [results, setResults] = useState(null); const [error, setError] = useState("");
  const fmt = n => n ? `$${Number(n).toLocaleString()}` : "—";
  const analyze = async () => { if (!form.jobTitle || !form.location) { setError("Job title and location required."); return; } setError(""); setLoading(true); setResults(null); try { const raw = await callClaude(`Salary intelligence 2026. Return ONLY JSON:\n{"salaryRange":{"low":<n>,"median":<n>,"high":<n>},"totalComp":{"median":<n>},"equityRange":"<r>","bonusRange":"<r>","topPayingCompanies":[{"name":"<n>","avgComp":"<c>"}],"salaryByExperience":[{"level":"<l>","salary":<n>}],"negotiationTips":["<t1>","<t2>","<t3>","<t4>"],"marketOutlook":"<outlook>","skillPremiums":[{"skill":"<s>","premium":"<p>"}],"benchmarkInsight":"<insight>"}\n${JSON.stringify(form)}`, 2000); setResults(JSON.parse(raw)); } catch { setError("Failed. Try again."); } finally { setLoading(false); } };
  return (
    <div>
      <div style={S.pageTitle}>💰 Salary Insights</div>
      <div style={S.pageSub}>AI-powered compensation data for 2026 — know your worth before you negotiate.</div>
      <div style={{ ...S.card, marginBottom: "18px" }}>
        <div style={{ ...S.grid2, gap: "12px", marginBottom: "12px" }} className="two-col">
          <div><div style={S.label}>Job Title *</div><input style={S.input} placeholder="Senior Frontend Engineer" value={form.jobTitle} onChange={e => setForm(f => ({ ...f, jobTitle: e.target.value }))} /></div>
          <div><div style={S.label}>Location *</div><input style={S.input} placeholder="San Francisco, CA" value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} /></div>
          <div><div style={S.label}>Experience</div><input style={S.input} placeholder="4 years" value={form.experience} onChange={e => setForm(f => ({ ...f, experience: e.target.value }))} /></div>
          <div><div style={S.label}>Company</div><input style={S.input} placeholder="Google, startup…" value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value }))} /></div>
          <div style={{ gridColumn: "1 / -1" }}><div style={S.label}>Skills</div><input style={S.input} placeholder="React, TypeScript, AWS" value={form.skills} onChange={e => setForm(f => ({ ...f, skills: e.target.value }))} /></div>
        </div>
        {error && <div style={{ ...S.errorBox, marginBottom: "12px" }}>{error}</div>}
        <button style={S.btnPrimary} onClick={analyze}>💰 Get Salary Data</button>
      </div>
      {loading && <Spinner text="Researching 2026 compensation data…" />}
      {results && <div className="fade-in">
        <div style={{ ...S.card, marginBottom: "14px", border: `1px solid ${ACCENT}33` }}>
          <div style={{ fontSize: "12px", color: ACCENT2, fontWeight: "600", marginBottom: "12px" }}>{results.benchmarkInsight}</div>
          <div style={{ display: "flex", marginBottom: "16px" }}>
            {[["Low", results.salaryRange?.low, MUTED], ["Median", results.salaryRange?.median, ACCENT], ["High", results.salaryRange?.high, ACCENT3]].map(([l, v, c]) => <div key={l} style={{ flex: 1, textAlign: "center", padding: "12px 6px", borderRight: l !== "High" ? `1px solid ${BORDER}` : "none" }}><div style={{ fontSize: "19px", fontWeight: "800", color: c }}>{fmt(v)}</div><div style={{ fontSize: "10px", color: MUTED, textTransform: "uppercase", letterSpacing: "1px", marginTop: "3px" }}>{l}</div></div>)}
          </div>
          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
            {[["Total Comp", fmt(results.totalComp?.median), ACCENT], ["Equity", results.equityRange, WARNING], ["Bonus", results.bonusRange, ACCENT3]].map(([l, v, c]) => <div key={l} style={{ background: `${c}18`, border: `1px solid ${c}33`, borderRadius: "8px", padding: "8px 12px" }}><div style={{ fontSize: "12px", fontWeight: "700", color: c }}>{v}</div><div style={{ fontSize: "10px", color: MUTED, marginTop: "2px" }}>{l}</div></div>)}
          </div>
        </div>
        <div style={{ ...S.grid2, gap: "12px", marginBottom: "12px" }} className="two-col">
          <div style={S.card}><div style={{ fontSize: "11px", fontWeight: "700", color: MUTED, textTransform: "uppercase", letterSpacing: "1px", marginBottom: "10px" }}>📈 By Experience</div>{results.salaryByExperience?.map(({ level, salary }) => { const max = Math.max(...results.salaryByExperience.map(x => x.salary)); return <div key={level} style={{ marginBottom: "9px" }}><div style={{ display: "flex", justifyContent: "space-between", fontSize: "11px", marginBottom: "3px" }}><span>{level}</span><span style={{ color: ACCENT, fontWeight: "700" }}>{fmt(salary)}</span></div><PBar val={Math.round((salary/max)*100)} color={ACCENT} /></div>; })}</div>
          <div style={S.card}><div style={{ fontSize: "11px", fontWeight: "700", color: MUTED, textTransform: "uppercase", letterSpacing: "1px", marginBottom: "10px" }}>⚡ Skill Premiums</div>{results.skillPremiums?.map(({ skill, premium }) => <div key={skill} style={{ ...S.card2, display: "flex", justifyContent: "space-between", marginBottom: "6px" }}><span style={{ fontSize: "12px" }}>{skill}</span><span style={{ fontSize: "12px", fontWeight: "700", color: ACCENT3 }}>{premium}</span></div>)}</div>
        </div>
        <div style={{ ...S.grid2, gap: "12px" }} className="two-col">
          <div style={S.card}><div style={{ fontSize: "11px", fontWeight: "700", color: MUTED, textTransform: "uppercase", letterSpacing: "1px", marginBottom: "10px" }}>🏆 Top Companies</div>{results.topPayingCompanies?.map(({ name, avgComp }, i) => <div key={name} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: i < results.topPayingCompanies.length-1 ? `1px solid ${BORDER}` : "none" }}><div style={{ display: "flex", gap: "7px", alignItems: "center" }}><span style={{ width: "18px", height: "18px", background: `${ACCENT}22`, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "9px", fontWeight: "700", color: ACCENT }}>{i+1}</span><span style={{ fontSize: "12px" }}>{name}</span></div><span style={{ fontSize: "12px", fontWeight: "700", color: ACCENT3 }}>{avgComp}</span></div>)}</div>
          <div style={S.card}><div style={{ fontSize: "11px", fontWeight: "700", color: MUTED, textTransform: "uppercase", letterSpacing: "1px", marginBottom: "10px" }}>🤝 Negotiation Tips</div>{results.negotiationTips?.map((tip, i) => <div key={i} style={{ display: "flex", gap: "7px", marginBottom: "9px" }}><span style={{ width: "16px", height: "16px", background: `${ACCENT2}22`, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "8px", fontWeight: "700", color: ACCENT2, flexShrink: 0 }}>{i+1}</span><span style={{ fontSize: "11px", lineHeight: 1.6 }}>{tip}</span></div>)}</div>
        </div>
        {results.marketOutlook && <div style={{ ...S.card, marginTop: "12px", border: `1px solid ${ACCENT3}33` }}><div style={{ fontSize: "11px", color: ACCENT3, fontWeight: "700", marginBottom: "7px" }}>🔮 MARKET OUTLOOK</div><div style={{ fontSize: "13px", lineHeight: 1.7 }}>{results.marketOutlook}</div></div>}
      </div>}
    </div>
  );
}

function NetworkingPage() {
  const [form, setForm] = useState({ targetName: "", targetRole: "", targetCompany: "", yourBackground: "", purpose: "coffee-chat", jobDesc: "" }); const [loading, setLoading] = useState(false); const [results, setResults] = useState(null); const [error, setError] = useState(""); const [tab, setTab] = useState("linkedin");
  const purposes = [{ value: "coffee-chat", label: "☕ Coffee Chat" }, { value: "referral", label: "🤝 Referral" }, { value: "informational", label: "🎓 Informational" }, { value: "reconnect", label: "👋 Reconnect" }, { value: "cold-outreach", label: "📨 Cold Outreach" }];
  const generate = async () => { if (!form.targetCompany || !form.yourBackground) { setError("Fill in background and company."); return; } setError(""); setLoading(true); setResults(null); try { const raw = await callClaude(`Personalized networking outreach. Return ONLY JSON:\n{"linkedinMessage":"<280 chars>","linkedinNote":"<full InMail>","email":{"subject":"<s>","body":"<b>"},"followUp":"<follow up>","icebreakers":["<i1>","<i2>","<i3>"],"doList":["<d1>","<d2>","<d3>"],"dontList":["<dont1>","<dont2>","<dont3>"],"callToAction":"<ask>"}\nTarget: ${form.targetName} (${form.targetRole} at ${form.targetCompany}), Background: ${form.yourBackground}, Purpose: ${form.purpose}${form.jobDesc ? ", Job: " + form.jobDesc : ""}`, 2000); setResults(JSON.parse(raw)); setTab("linkedin"); } catch { setError("Failed. Try again."); } finally { setLoading(false); } };
  return (
    <div>
      <div style={S.pageTitle}>🤝 Networking Assistant</div>
      <div style={S.pageSub}>AI writes personalized outreach that actually gets replies — not generic templates.</div>
      <div style={{ ...S.card, marginBottom: "16px" }}>
        <div style={{ ...S.grid2, gap: "12px", marginBottom: "12px" }} className="two-col">
          <div><div style={S.label}>Their Name</div><input style={S.input} placeholder="Sarah Chen" value={form.targetName} onChange={e => setForm(f => ({ ...f, targetName: e.target.value }))} /></div>
          <div><div style={S.label}>Their Role</div><input style={S.input} placeholder="Engineering Manager" value={form.targetRole} onChange={e => setForm(f => ({ ...f, targetRole: e.target.value }))} /></div>
          <div><div style={S.label}>Company *</div><input style={S.input} placeholder="Stripe, Google…" value={form.targetCompany} onChange={e => setForm(f => ({ ...f, targetCompany: e.target.value }))} /></div>
          <div><div style={S.label}>Purpose</div><select style={S.select} value={form.purpose} onChange={e => setForm(f => ({ ...f, purpose: e.target.value }))}>{purposes.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</select></div>
          <div style={{ gridColumn: "1 / -1" }}><div style={S.label}>Your Background *</div><textarea style={{ ...S.textarea, minHeight: "75px" }} placeholder="4-year software engineer looking to transition into fintech…" value={form.yourBackground} onChange={e => setForm(f => ({ ...f, yourBackground: e.target.value }))} /></div>
          {form.purpose === "referral" && <div style={{ gridColumn: "1 / -1" }}><div style={S.label}>Job Description</div><textarea style={{ ...S.textarea, minHeight: "75px" }} placeholder="Job you want a referral for…" value={form.jobDesc} onChange={e => setForm(f => ({ ...f, jobDesc: e.target.value }))} /></div>}
        </div>
        {error && <div style={{ ...S.errorBox, marginBottom: "12px" }}>{error}</div>}
        <button style={S.btnPrimary} onClick={generate}>✍️ Generate Messages</button>
      </div>
      {loading && <Spinner text="Crafting personalized messages…" step="Making it feel human, not spammy…" />}
      {results && <div className="fade-in">
        <div style={S.tabRow}>{[["linkedin","💼 LinkedIn"],["email","📧 Email"],["followup","🔁 Follow-up"],["tips","💡 Tips"]].map(([id, lbl]) => <button key={id} style={{ ...S.tab, ...(tab === id ? S.tabActive : {}) }} onClick={() => setTab(id)}>{lbl}</button>)}</div>
        {tab === "linkedin" && <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <div style={S.card}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: "7px" }}><div style={S.label}>Connection Request (max 280)</div><CopyBtn text={results.linkedinMessage} /></div><div style={S.textBox}>{results.linkedinMessage}</div><div style={{ fontSize: "10px", color: results.linkedinMessage?.length > 280 ? DANGER : MUTED, marginTop: "4px" }}>{results.linkedinMessage?.length}/280</div></div>
          <div style={S.card}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: "7px" }}><div style={S.label}>InMail</div><CopyBtn text={results.linkedinNote} /></div><div style={S.textBox}>{results.linkedinNote}</div></div>
          <div style={{ ...S.card2, border: `1px solid ${ACCENT3}33` }}><div style={S.label}>🎯 Your Ask</div><div style={{ fontSize: "13px", lineHeight: 1.6 }}>{results.callToAction}</div></div>
        </div>}
        {tab === "email" && results.email && <div style={S.card}>
          <div style={{ marginBottom: "12px" }}><div style={S.label}>Subject</div><div style={{ ...S.card2, display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: "13px", fontWeight: "600" }}>{results.email.subject}</span><CopyBtn text={results.email.subject} /></div></div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "7px" }}><div style={S.label}>Body</div><CopyBtn text={results.email.body} /></div><div style={S.textBox}>{results.email.body}</div>
        </div>}
        {tab === "followup" && <div style={S.card}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "7px" }}><div><div style={S.label}>Follow-up</div><div style={{ fontSize: "10px", color: MUTED }}>Send after 7 days</div></div><CopyBtn text={results.followUp} /></div>
          <div style={{ ...S.textBox, marginBottom: "16px" }}>{results.followUp}</div>
          <div style={S.label}>💬 Icebreakers</div>
          {results.icebreakers?.map((ic, i) => <div key={i} style={{ ...S.card2, display: "flex", gap: "8px", marginBottom: "6px" }}><span style={{ color: ACCENT2, fontWeight: "700" }}>{i+1}.</span><span style={{ fontSize: "12px", lineHeight: 1.6 }}>{ic}</span></div>)}
        </div>}
        {tab === "tips" && <div style={{ ...S.grid2, gap: "12px" }} className="two-col">
          <div style={S.card}><div style={{ fontSize: "10px", color: ACCENT3, fontWeight: "700", marginBottom: "10px" }}>✓ DO THIS</div>{results.doList?.map((t, i) => <div key={i} style={{ display: "flex", gap: "7px", marginBottom: "9px" }}><span style={{ color: ACCENT3 }}>✓</span><span style={{ fontSize: "12px", lineHeight: 1.6 }}>{t}</span></div>)}</div>
          <div style={S.card}><div style={{ fontSize: "10px", color: DANGER, fontWeight: "700", marginBottom: "10px" }}>✗ AVOID</div>{results.dontList?.map((t, i) => <div key={i} style={{ display: "flex", gap: "7px", marginBottom: "9px" }}><span style={{ color: DANGER }}>✗</span><span style={{ fontSize: "12px", lineHeight: 1.6 }}>{t}</span></div>)}</div>
        </div>}
      </div>}
    </div>
  );
}

function PricingPage({ profile }) {
  const plans = [
    { id: "free", name: "Free", price: "$0", color: MUTED, features: ["3 resume analyses/month","10 job searches/day","Basic tracker","3 interview sessions/month"], cta: "Current Plan", disabled: true },
    { id: "pro", name: "Pro", price: "$19/mo", color: ACCENT, popular: true, features: ["Unlimited analyses","Unlimited job searches","Full interview prep","Salary insights","Networking assistant","AI job matching","Priority processing"], cta: "Upgrade to Pro", disabled: false },
    { id: "premium", name: "Premium", price: "$49/mo", color: ACCENT2, features: ["Everything in Pro","Advanced AI matching","Auto-apply (soon)","Chrome extension (soon)","LinkedIn integration (soon)","Email follow-ups (soon)","AI career coach (soon)"], cta: "Upgrade to Premium", disabled: false },
  ];
  return (
    <div>
      <div style={{ textAlign: "center", marginBottom: "28px" }}><div style={S.pageTitle}>💎 Choose Your Plan</div><div style={{ fontSize: "13px", color: MUTED, marginTop: "6px" }}>Unlock the full power of CareerPersona AI</div></div>
      <div style={{ ...S.grid3, maxWidth: "860px", margin: "0 auto" }} className="three-col">
        {plans.map(plan => <div key={plan.id} style={{ ...S.card, border: plan.popular ? `2px solid ${ACCENT}` : `1px solid ${BORDER}`, position: "relative" }}>
          {plan.popular && <div style={{ position: "absolute", top: "-11px", left: "50%", transform: "translateX(-50%)", background: `linear-gradient(135deg,${ACCENT},#9333EA)`, color: "#fff", fontSize: "10px", fontWeight: "700", padding: "2px 10px", borderRadius: "20px" }}>POPULAR</div>}
          <div style={{ fontSize: "15px", fontWeight: "700", color: plan.color, marginBottom: "5px" }}>{plan.name}</div>
          <div style={{ fontSize: "26px", fontWeight: "800", marginBottom: "16px" }}>{plan.price}</div>
          <div style={{ marginBottom: "18px", paddingBottom: "18px", borderBottom: `1px solid ${BORDER}` }}>{plan.features.map((f, i) => <div key={i} style={{ display: "flex", gap: "7px", marginBottom: "7px", fontSize: "12px" }}><span style={{ color: plan.color }}>✓</span>{f}</div>)}</div>
          <button style={{ ...(plan.id === "free" ? S.btnSecondary : plan.id === "pro" ? S.btnPrimary : S.btnCyan), width: "100%", justifyContent: "center", display: "flex", opacity: plan.disabled ? 0.5 : 1 }} disabled={plan.disabled} onClick={() => { if (!plan.disabled) alert(`Connect Stripe to enable ${plan.name} payments`); }}>{profile?.plan === plan.id ? "Current Plan" : plan.cta}</button>
        </div>)}
      </div>
    </div>
  );
}

function ProfilePage({ profile, updateProfile, logout }) {
  const [form, setForm] = useState({ full_name: profile?.full_name || "", phone: profile?.phone || "", location: profile?.location || "", linkedin_url: profile?.linkedin_url || "", job_title: profile?.job_title || "", years_experience: profile?.years_experience || "" });
  const [saved, setSaved] = useState(false);
  const save = () => { updateProfile(form); setSaved(true); setTimeout(() => setSaved(false), 2000); };
  const planColor = profile?.plan === "pro" ? ACCENT : profile?.plan === "premium" ? ACCENT2 : MUTED;
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "22px" }}>
        <div><div style={S.pageTitle}>👤 Profile</div><div style={{ fontSize: "12px", color: MUTED, marginTop: "3px" }}>{profile?.email}</div></div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}><span style={badge(planColor)}>{(profile?.plan || "FREE").toUpperCase()}</span><button style={S.btnDanger} onClick={logout}>Sign Out</button></div>
      </div>
      <div style={{ ...S.card, marginBottom: "14px" }}>
        <div style={{ fontSize: "13px", fontWeight: "700", marginBottom: "14px" }}>Personal Info</div>
        <div style={{ ...S.grid2, gap: "12px", marginBottom: "14px" }} className="two-col">
          <div><div style={S.label}>Full Name</div><input style={S.input} value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} /></div>
          <div><div style={S.label}>Phone</div><input style={S.input} value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} /></div>
          <div><div style={S.label}>Location</div><input style={S.input} placeholder="San Francisco, CA" value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} /></div>
          <div><div style={S.label}>LinkedIn</div><input style={S.input} placeholder="linkedin.com/in/you" value={form.linkedin_url} onChange={e => setForm(f => ({ ...f, linkedin_url: e.target.value }))} /></div>
          <div><div style={S.label}>Current Title</div><input style={S.input} placeholder="Software Engineer" value={form.job_title} onChange={e => setForm(f => ({ ...f, job_title: e.target.value }))} /></div>
          <div><div style={S.label}>Experience</div><input style={S.input} placeholder="4 years" value={form.years_experience} onChange={e => setForm(f => ({ ...f, years_experience: e.target.value }))} /></div>
        </div>
        <button style={S.btnPrimary} onClick={save}>{saved ? "✓ Saved!" : "Save Profile"}</button>
      </div>
      <div style={S.card}>
        <div style={{ fontSize: "13px", fontWeight: "700", marginBottom: "14px" }}>Monthly Usage</div>
        <div style={{ ...S.grid2, gap: "10px" }} className="two-col">
          {[["Resume Analyses", profile?.analyses_used || 0, profile?.plan === "free" ? 3 : "∞"], ["Job Searches Today", profile?.searches_used || 0, profile?.plan === "free" ? 10 : "∞"]].map(([l, used, limit]) => <div key={l} style={S.card2}><div style={{ fontSize: "11px", color: MUTED, marginBottom: "5px" }}>{l}</div><div style={{ fontSize: "20px", fontWeight: "800", color: ACCENT }}>{used}<span style={{ fontSize: "12px", color: MUTED }}>/{limit}</span></div>{typeof limit === "number" && <PBar val={Math.min(100, Math.round((used/limit)*100))} color={ACCENT} />}</div>)}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { user, profile, login, logout, updateProfile } = useAuth();
  const [applications, setApplications] = useStorage("cp_applications", []);
  const [savedJobs, setSavedJobs] = useStorage("cp_saved_jobs", []);
  const [page, setPage] = useState("resume");
  const handleSaveApplication = app => setApplications(prev => [app, ...prev]);

  const navItems = [
    { id: "resume", icon: "⚡", label: "Resume" },
    { id: "jobs", icon: "🔍", label: "Job Search" },
    { id: "saved", icon: "♥", label: `Saved${savedJobs.length > 0 ? ` (${savedJobs.length})` : ""}` },
    { id: "interview", icon: "🎤", label: "Interview" },
    { id: "tracker", icon: "📋", label: `Tracker${applications.length > 0 ? ` (${applications.length})` : ""}` },
    { id: "salary", icon: "💰", label: "Salary" },
    { id: "network", icon: "🤝", label: "Network" },
    { id: "pricing", icon: "💎", label: "Pricing" },
    { id: "profile", icon: "👤", label: profile?.full_name?.split(" ")[0] || "Profile" },
  ];

  if (!user) return <AuthPage onLogin={login} />;

  return (
    <div style={S.app}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        textarea:focus, input:focus, select:focus { border-color: ${ACCENT} !important; }
        textarea::placeholder, input::placeholder { color: ${MUTED}; opacity: 0.5; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .fade-in { animation: fadeIn 0.3s ease forwards; }
        button:hover { opacity: 0.85; } button:disabled { opacity: 0.4; cursor: not-allowed; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-thumb { background: ${BORDER}; border-radius: 2px; }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.5); }
        @media (max-width: 700px) { .two-col, .three-col { grid-template-columns: 1fr !important; } .nav-label { display: none; } }
        a { color: inherit; }
      `}</style>
      <header style={S.header}>
        <div style={S.logo}>
          <div style={S.logoIcon}>🚀</div>
          <span style={S.logoText}>CareerPersona AI</span>
        </div>
        <nav style={S.nav}>
          {navItems.map(n => <button key={n.id} style={{ ...S.navBtn, ...(page === n.id ? S.navActive : {}) }} onClick={() => setPage(n.id)}><span>{n.icon}</span><span className="nav-label">{n.label}</span></button>)}
        </nav>
        <div style={badge(profile?.plan === "pro" ? ACCENT : profile?.plan === "premium" ? ACCENT2 : MUTED)}>{(profile?.plan || "FREE").toUpperCase()}</div>
      </header>
      <main style={S.main}>
        {page === "resume" && <ResumePage onSaveApplication={handleSaveApplication} />}
        {page === "jobs" && <JobSearchPage savedJobs={savedJobs} setSavedJobs={setSavedJobs} setApplications={setApplications} />}
        {page === "saved" && <SavedJobsPage savedJobs={savedJobs} setSavedJobs={setSavedJobs} setApplications={setApplications} />}
        {page === "interview" && <InterviewPage />}
        {page === "tracker" && <TrackerPage applications={applications} setApplications={setApplications} />}
        {page === "salary" && <SalaryPage />}
        {page === "network" && <NetworkingPage />}
        {page === "pricing" && <PricingPage profile={profile} />}
        {page === "profile" && <ProfilePage profile={profile} updateProfile={updateProfile} logout={logout} />}
      </main>
    </div>
  );
}

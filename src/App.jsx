import { useState, useCallback } from "react";

// ─── DESIGN TOKENS ─────────────────────────────────────────
const C = {
  bg: "#FFFFFF",
  bgSoft: "#F7F8FC",
  bgCard: "#FFFFFF",
  border: "#E8EAF0",
  borderStrong: "#D0D4E4",
  purple: "#6B21E8",
  purpleLight: "#EEE8FD",
  purpleMid: "#9B59F5",
  text: "#111827",
  textMid: "#374151",
  textMuted: "#6B7280",
  green: "#059669",
  greenLight: "#ECFDF5",
  red: "#DC2626",
  redLight: "#FEF2F2",
  yellow: "#D97706",
  yellowLight: "#FFFBEB",
  blue: "#2563EB",
  blueLight: "#EFF6FF",
};

// ─── STORAGE ───────────────────────────────────────────────
const useStorage = (key, initial) => {
  const [val, setVal] = useState(() => {
    try { const d = localStorage.getItem(key); return d ? JSON.parse(d) : initial; } catch { return initial; }
  });
  const set = useCallback((v) => {
    const next = typeof v === "function" ? v(val) : v;
    setVal(next);
    localStorage.setItem(key, JSON.stringify(next));
  }, [key, val]);
  return [val, set];
};

// ─── AUTH ──────────────────────────────────────────────────
const useAuth = () => {
  const [user, setUser] = useState(() => { try { return JSON.parse(localStorage.getItem("cp_user") || "null"); } catch { return null; } });
  const login = (u) => { setUser(u); localStorage.setItem("cp_user", JSON.stringify(u)); };
  const logout = () => { setUser(null); localStorage.removeItem("cp_user"); };
  return { user, login, logout };
};

// ─── CLAUDE API ────────────────────────────────────────────
async function askClaude(prompt, maxTokens = 2500) {
  const key = import.meta.env.VITE_ANTHROPIC_API_KEY;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
  });
  const data = await res.json();
  return (data.content?.[0]?.text || "{}").replace(/```json|```/g, "").trim();
}

// ─── SHARED UI ─────────────────────────────────────────────
function Logo({ size = 36 }) {
  return (
    <div style={{ width: size, height: size, background: `linear-gradient(135deg, ${C.purple}, ${C.purpleMid})`, borderRadius: size * 0.25, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
      <span style={{ color: "#fff", fontWeight: 900, fontSize: size * 0.44, letterSpacing: "-1px" }}>CP</span>
    </div>
  );
}

function AppName({ size = 18 }) {
  return (
    <span style={{ fontSize: size, fontWeight: 800, letterSpacing: "-0.5px" }}>
      <span style={{ color: C.text }}>Career</span><span style={{ color: C.purple }}>Persona</span><span style={{ background: `linear-gradient(135deg,${C.purple},${C.purpleMid})`, color: "#fff", fontSize: size * 0.65, fontWeight: 700, padding: "1px 6px", borderRadius: 5, marginLeft: 5, verticalAlign: "middle" }}>AI</span>
    </span>
  );
}

function Btn({ children, onClick, variant = "primary", disabled, style = {} }) {
  const base = { border: "none", borderRadius: 10, padding: "11px 22px", fontSize: 14, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, display: "inline-flex", alignItems: "center", gap: 7, transition: "all 0.15s", ...style };
  const variants = {
    primary: { background: `linear-gradient(135deg,${C.purple},${C.purpleMid})`, color: "#fff" },
    secondary: { background: C.bgSoft, color: C.textMid, border: `1px solid ${C.border}` },
    green: { background: C.green, color: "#fff" },
    ghost: { background: "transparent", color: C.textMuted, border: `1px solid ${C.border}` },
    danger: { background: "transparent", color: C.red, border: `1px solid ${C.red}40` },
  };
  return <button style={{ ...base, ...variants[variant] }} onClick={onClick} disabled={disabled}>{children}</button>;
}

function Card({ children, style = {} }) {
  return <div style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 16, padding: 24, ...style }}>{children}</div>;
}

function Input({ label, ...props }) {
  return (
    <div>
      {label && <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "1.2px", marginBottom: 7 }}>{label}</div>}
      <input style={{ width: "100%", background: C.bgSoft, border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 13, padding: "10px 13px", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} {...props} />
    </div>
  );
}

function Textarea({ label, ...props }) {
  return (
    <div>
      {label && <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "1.2px", marginBottom: 7 }}>{label}</div>}
      <textarea style={{ width: "100%", minHeight: 160, background: C.bgSoft, border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 13, lineHeight: 1.7, padding: 12, resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} {...props} />
    </div>
  );
}

function Select({ label, children, ...props }) {
  return (
    <div>
      {label && <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "1.2px", marginBottom: 7 }}>{label}</div>}
      <select style={{ width: "100%", background: C.bgSoft, border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 13, padding: "10px 13px", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} {...props}>{children}</select>
    </div>
  );
}

function Badge({ children, color = C.purple }) {
  return <span style={{ background: `${color}15`, color, border: `1px solid ${color}30`, borderRadius: 6, padding: "2px 9px", fontSize: 11, fontWeight: 700 }}>{children}</span>;
}

function ScoreRing({ score, size = 80 }) {
  const color = score >= 80 ? C.green : score >= 60 ? C.yellow : C.red;
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

function Spinner({ text = "Working on it..." }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "48px 20px", gap: 16 }}>
      <div style={{ width: 40, height: 40, border: `3px solid ${C.border}`, borderTop: `3px solid ${C.purple}`, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
      <div style={{ color: C.textMuted, fontSize: 14 }}>{text}</div>
    </div>
  );
}

function CopyBtn({ text }) {
  const [c, setC] = useState(false);
  return <Btn variant="ghost" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => { navigator.clipboard.writeText(text); setC(true); setTimeout(() => setC(false), 2000); }}>{c ? "✓ Copied" : "Copy"}</Btn>;
}

function TextBox({ children }) {
  return <div style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, fontSize: 13, lineHeight: 1.75, color: C.text, whiteSpace: "pre-wrap", maxHeight: 320, overflowY: "auto" }}>{children}</div>;
}

// ─── AUTH PAGE ─────────────────────────────────────────────
function AuthPage({ onLogin }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ email: "", password: "", name: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handle = async () => {
    if (!form.email) { setError("Email is required"); return; }
    if (mode === "signup" && !form.name) { setError("Name is required"); return; }
    setLoading(true); setError("");
    await new Promise(r => setTimeout(r, 600));
    onLogin({ id: Date.now().toString(), email: form.email, full_name: form.name || form.email.split("@")[0], plan: "free" });
    setLoading(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bgSoft, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}><Logo size={52} /></div>
          <AppName size={24} />
          <div style={{ fontSize: 13, color: C.textMuted, marginTop: 8 }}>Your AI-powered career platform</div>
        </div>
        <Card>
          <div style={{ display: "flex", gap: 3, background: C.bgSoft, borderRadius: 10, padding: 3, marginBottom: 20 }}>
            {["login", "signup"].map(m => (
              <button key={m} style={{ flex: 1, padding: "8px", borderRadius: 7, border: "none", background: mode === m ? "#fff" : "transparent", color: mode === m ? C.text : C.textMuted, fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: mode === m ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }} onClick={() => { setMode(m); setError(""); }}>
                {m === "login" ? "Sign In" : "Sign Up"}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {mode === "signup" && <Input label="Full Name" placeholder="John Smith" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />}
            <Input label="Email" type="email" placeholder="you@email.com" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
            <Input label="Password" type="password" placeholder="••••••••" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
          </div>
          {error && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, color: C.red, fontSize: 13, marginTop: 14 }}>{error}</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 18 }}>
            <Btn onClick={handle} disabled={loading} style={{ width: "100%", justifyContent: "center" }}>
              {loading ? "Please wait..." : mode === "login" ? "Sign In" : "Create Account"}
            </Btn>
            <button style={{ width: "100%", padding: "11px", border: `1.5px solid ${C.border}`, borderRadius: 10, background: "#fff", color: C.textMid, fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }} onClick={() => onLogin({ id: "g_" + Date.now(), email: "user@gmail.com", full_name: "Google User", plan: "free" })}>
              <span style={{ fontWeight: 800, color: C.blue }}>G</span> Continue with Google
            </button>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ─── RESUME PAGE ───────────────────────────────────────────
const SAMPLE_RESUME = `John Smith | john@email.com | San Francisco, CA
SUMMARY: Software engineer, 4 years experience in React, Node.js, Python.
EXPERIENCE: Software Engineer — Acme Corp (2021–Present) • Built dashboards 50K+ users • Reduced API time 40%
EDUCATION: B.S. Computer Science — UC Berkeley, 2020
SKILLS: JavaScript, React, Node.js, Python, SQL, Git`;
const SAMPLE_JOB = `Senior Frontend Engineer — TechCorp
Requirements: 4+ years React, TypeScript, GraphQL, Redux, Next.js, CI/CD. Salary: $140K–$180K, remote, equity.`;

function ResumePage({ onSave }) {
  const [resume, setResume] = useState(""); const [jobDesc, setJobDesc] = useState(""); const [loading, setLoading] = useState(false); const [results, setResults] = useState(null); const [error, setError] = useState(""); const [tab, setTab] = useState("resume"); const [saved, setSaved] = useState(false);

  const analyze = async () => {
    if (!resume.trim() || !jobDesc.trim()) { setError("Please add both resume and job description."); return; }
    setError(""); setLoading(true); setResults(null);
    try {
      const raw = await askClaude(`You are an expert ATS resume coach. Return ONLY a JSON object, no markdown, no explanation:
{"atsScore":<0-100>,"scoreBreakdown":{"keywordMatch":<0-100>,"formatting":<0-100>,"relevance":<0-100>},"keywordsFound":["<k1>","<k2>","<k3>","<k4>","<k5>","<k6>"],"keywordsMissing":["<m1>","<m2>","<m3>","<m4>","<m5>","<m6>"],"tailoredResume":"<full optimized resume text>","suggestions":["<tip1>","<tip2>","<tip3>","<tip4>","<tip5>"],"coverLetter":"<professional 3 paragraph cover letter>","jobTitle":"<extracted job title>","company":"<company name>"}
RESUME: ${resume}
JOB DESCRIPTION: ${jobDesc}`, 3000);
      setResults(JSON.parse(raw)); setTab("resume");
    } catch { setError("Analysis failed. Please try again."); } finally { setLoading(false); }
  };

  const handleSave = () => { if (!results) return; onSave({ id: Date.now(), company: results.company || "Company", jobTitle: results.jobTitle || "Role", status: "Applied", atsScore: results.atsScore, date: new Date().toISOString().split("T")[0], resume: results.tailoredResume, coverLetter: results.coverLetter }); setSaved(true); setTimeout(() => setSaved(false), 3000); };

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 26, fontWeight: 800, color: C.text, letterSpacing: "-0.5px", marginBottom: 6 }}>Resume Tailor</h1>
        <p style={{ color: C.textMuted, fontSize: 14 }}>Paste your resume and job description — AI optimizes your resume and writes your cover letter.</p>
      </div>
      {!results && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }} className="two-col">
            <Card><Textarea label="Your Resume" placeholder="Paste your resume here…" value={resume} onChange={e => setResume(e.target.value)} style={{ minHeight: 220 }} /></Card>
            <Card><Textarea label="Job Description" placeholder="Paste the job posting here…" value={jobDesc} onChange={e => setJobDesc(e.target.value)} style={{ minHeight: 220 }} /></Card>
          </div>
          {error && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, color: C.red, fontSize: 13, marginBottom: 14 }}>{error}</div>}
          <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
            <Btn onClick={analyze}>⚡ Analyze & Tailor Resume</Btn>
            <Btn variant="secondary" onClick={() => { setResume(SAMPLE_RESUME); setJobDesc(SAMPLE_JOB); }}>Try Sample</Btn>
          </div>
        </>
      )}
      {loading && <Spinner text="Analyzing your resume against the job description…" />}
      {results && (
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
            <div>
              <div style={{ fontSize: 18, fontWeight: 800, color: C.text, marginBottom: 4 }}>Analysis Complete</div>
              {results.company && <div style={{ fontSize: 13, color: C.textMuted }}>{results.jobTitle} at {results.company}</div>}
              <div style={{ marginTop: 8 }}><Badge color={results.atsScore >= 80 ? C.green : results.atsScore >= 60 ? C.yellow : C.red}>{results.atsScore >= 80 ? "🎉 Strong Match" : results.atsScore >= 60 ? "👍 Good Match" : "⚠️ Needs Work"}</Badge></div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <ScoreRing score={results.atsScore} />
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <Btn variant="green" onClick={handleSave}>{saved ? "✓ Saved!" : "💾 Save to Tracker"}</Btn>
                <Btn variant="secondary" onClick={() => { setResults(null); setResume(""); setJobDesc(""); }}>← New Analysis</Btn>
              </div>
            </div>
          </div>
          <div style={{ marginBottom: 20 }}>
            {[["Keyword Match", results.scoreBreakdown?.keywordMatch], ["Formatting", results.scoreBreakdown?.formatting], ["Relevance", results.scoreBreakdown?.relevance]].map(([l, v]) => (
              <div key={l} style={{ marginBottom: 10 }}><div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}><span style={{ color: C.textMid }}>{l}</span><span style={{ fontWeight: 700, color: v >= 80 ? C.green : v >= 60 ? C.yellow : C.red }}>{v}%</span></div><PBar val={v} /></div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 20 }} className="two-col">
            <div style={{ background: C.greenLight, borderRadius: 10, padding: 14 }}><div style={{ fontSize: 11, color: C.green, fontWeight: 700, marginBottom: 8 }}>✓ KEYWORDS FOUND</div><div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>{results.keywordsFound?.map(k => <Badge key={k} color={C.green}>{k}</Badge>)}</div></div>
            <div style={{ background: C.redLight, borderRadius: 10, padding: 14 }}><div style={{ fontSize: 11, color: C.red, fontWeight: 700, marginBottom: 8 }}>✗ KEYWORDS MISSING</div><div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>{results.keywordsMissing?.map(k => <Badge key={k} color={C.red}>{k}</Badge>)}</div></div>
          </div>
          <div style={{ display: "flex", gap: 3, background: C.bgSoft, borderRadius: 10, padding: 3, marginBottom: 16 }}>
            {[["resume","✨ Tailored Resume"],["suggestions","💡 Tips"],["cover","📄 Cover Letter"]].map(([id, lbl]) => (
              <button key={id} style={{ flex: 1, padding: "8px", borderRadius: 7, border: "none", background: tab === id ? "#fff" : "transparent", color: tab === id ? C.text : C.textMuted, fontSize: 13, fontWeight: 600, cursor: "pointer" }} onClick={() => setTab(id)}>{lbl}</button>
            ))}
          </div>
          {tab === "resume" && <div><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><span style={{ fontSize: 12, color: C.textMuted }}>AI-optimized for this role</span><CopyBtn text={results.tailoredResume} /></div><TextBox>{results.tailoredResume}</TextBox></div>}
          {tab === "suggestions" && <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>{results.suggestions?.map((s, i) => <div key={i} style={{ background: C.blueLight, border: `1px solid ${C.blue}20`, borderRadius: 10, padding: "12px 14px", display: "flex", gap: 10 }}><span>{"🎯📝💼🔧⚡"[i]}</span><span style={{ fontSize: 13, lineHeight: 1.6, color: C.text }}>{s}</span></div>)}</div>}
          {tab === "cover" && <div><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><span style={{ fontSize: 12, color: C.textMuted }}>Personalized cover letter</span><CopyBtn text={results.coverLetter} /></div><TextBox>{results.coverLetter}</TextBox></div>}
        </Card>
      )}
    </div>
  );
}

// ─── JOB SEARCH ────────────────────────────────────────────
function JobSearchPage({ savedJobs, setSavedJobs, setApplications }) {
  const [filters, setFilters] = useState({ title: "", country: "United States", city: "", remote: false, employmentType: "Any", experienceLevel: "Any" });
  const [jobs, setJobs] = useState([]); const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [searched, setSearched] = useState(false); const [analyzing, setAnalyzing] = useState(null); const [matchResult, setMatchResult] = useState(null); const [matchJobId, setMatchJobId] = useState(null); const [resume, setResume] = useState(""); const [showResume, setShowResume] = useState(false);

  const search = async () => {
    if (!filters.title) { setError("Enter a job title to search"); return; }
    setError(""); setLoading(true); setJobs([]); setSearched(true);
    try {
      const raw = await askClaude(`Generate 12 realistic job listings for "${filters.title}" in ${filters.country}${filters.city ? ", " + filters.city : ""}${filters.remote ? " (remote only)" : ""}. Return ONLY a JSON array, no markdown:
[{"id":"job_<unique>","title":"<title>","company":"<real company name>","location":"<city, state>","salaryMin":<number>,"salaryMax":<number>,"currency":"USD","employmentType":"<Full-time|Part-time|Contract>","remote":<true|false>,"description":"<3 sentence description with key requirements>","applyUrl":"https://linkedin.com/jobs","datePosted":"<recent date 2026>","source":"<LinkedIn|Indeed|Glassdoor|Company>","experienceLevel":"<Entry|Mid|Senior>","skills":["<skill1>","<skill2>","<skill3>","<skill4>"]}]
${filters.employmentType !== "Any" ? "Employment type: " + filters.employmentType : ""} ${filters.experienceLevel !== "Any" ? "Experience: " + filters.experienceLevel : ""}`, 3000);
      setJobs(JSON.parse(raw));
    } catch { setError("Search failed. Please try again."); } finally { setLoading(false); }
  };

  const analyzeMatch = async (job) => {
    if (!resume) { setShowResume(true); return; }
    setAnalyzing(job.id); setMatchResult(null); setMatchJobId(job.id);
    try {
      const raw = await askClaude(`Analyze how well this resume matches this job. Return ONLY JSON:
{"matchScore":<0-100>,"atsScore":<0-100>,"interviewProbability":<0-100>,"matchingSkills":["<s1>","<s2>","<s3>"],"missingSkills":["<m1>","<m2>","<m3>"],"summary":"<2 sentence assessment>"}
RESUME: ${resume}
JOB: ${job.title} at ${job.company} - ${job.description}`, 1200);
      setMatchResult(JSON.parse(raw));
    } catch {} finally { setAnalyzing(null); }
  };

  const toggleSave = (job) => { const s = savedJobs.find(j => j.job_id === job.id); if (s) { setSavedJobs(p => p.filter(j => j.job_id !== job.id)); } else { setSavedJobs(p => [{ job_id: job.id, ...job, saved_at: new Date().toISOString() }, ...p]); } };
  const isSaved = (id) => savedJobs.some(j => j.job_id === id);
  const addTracker = (job) => setApplications(p => [{ id: Date.now(), company: job.company, jobTitle: job.title, status: "Applied", date: new Date().toISOString().split("T")[0], notes: "", url: job.applyUrl }, ...p]);
  const fmtSalary = (min, max) => { if (!min && !max) return "Salary not listed"; const f = n => `$${Math.round(n/1000)}K`; if (min && max) return `${f(min)} – ${f(max)}`; return min ? `${f(min)}+` : `Up to ${f(max)}`; };

  return (
    <div>
      <h1 style={{ fontSize: 26, fontWeight: 800, color: C.text, marginBottom: 6 }}>Job Search</h1>
      <p style={{ color: C.textMuted, fontSize: 14, marginBottom: 24 }}>Search thousands of jobs with AI-powered match scoring.</p>
      <Card style={{ marginBottom: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }} className="two-col">
          <Input label="Job Title *" placeholder="e.g. Software Engineer" value={filters.title} onChange={e => setFilters(f => ({ ...f, title: e.target.value }))} onKeyDown={e => e.key === "Enter" && search()} />
          <Select label="Country" value={filters.country} onChange={e => setFilters(f => ({ ...f, country: e.target.value }))}>
            {["United States","Canada","United Kingdom","Australia","Germany","France","Remote Worldwide"].map(c => <option key={c}>{c}</option>)}
          </Select>
          <Input label="City" placeholder="e.g. New York" value={filters.city} onChange={e => setFilters(f => ({ ...f, city: e.target.value }))} />
          <Select label="Employment Type" value={filters.employmentType} onChange={e => setFilters(f => ({ ...f, employmentType: e.target.value }))}>
            {["Any","Full-time","Part-time","Contract","Internship"].map(t => <option key={t}>{t}</option>)}
          </Select>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: C.textMid }}><input type="checkbox" checked={filters.remote} onChange={e => setFilters(f => ({ ...f, remote: e.target.checked }))} /> Remote Only</label>
          {error && <span style={{ color: C.red, fontSize: 13 }}>{error}</span>}
          <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
            <Btn variant={resume ? "green" : "secondary"} onClick={() => setShowResume(!showResume)}>📄 {resume ? "Resume Added ✓" : "Add Resume for AI Match"}</Btn>
            <Btn onClick={search}>🔍 Search Jobs</Btn>
          </div>
        </div>
        {showResume && <div style={{ marginTop: 14 }}><Textarea label="Your Resume (for AI match scoring)" placeholder="Paste your resume…" value={resume} onChange={e => setResume(e.target.value)} style={{ minHeight: 100 }} /></div>}
      </Card>

      {matchResult && <Card style={{ marginBottom: 18, border: `1.5px solid ${C.purple}30`, background: C.purpleLight }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 16 }}><div style={{ fontSize: 15, fontWeight: 700 }}>AI Match Result</div><Btn variant="ghost" style={{ padding: "4px 10px", fontSize: 12 }} onClick={() => { setMatchResult(null); setMatchJobId(null); }}>✕</Btn></div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 14 }}>
          {[["Match", matchResult.matchScore], ["ATS Score", matchResult.atsScore], ["Interview %", matchResult.interviewProbability]].map(([l, v]) => <div key={l} style={{ textAlign: "center" }}><ScoreRing score={v} size={65} /><div style={{ fontSize: 11, color: C.textMuted, marginTop: 5 }}>{l}</div></div>)}
        </div>
        <div style={{ fontSize: 13, color: C.textMid, marginBottom: 10 }}>{matchResult.summary}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }} className="two-col">
          <div style={{ background: C.greenLight, borderRadius: 9, padding: 12 }}><div style={{ fontSize: 11, color: C.green, fontWeight: 700, marginBottom: 6 }}>✓ MATCHING</div><div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>{matchResult.matchingSkills?.map(s => <Badge key={s} color={C.green}>{s}</Badge>)}</div></div>
          <div style={{ background: C.redLight, borderRadius: 9, padding: 12 }}><div style={{ fontSize: 11, color: C.red, fontWeight: 700, marginBottom: 6 }}>✗ MISSING</div><div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>{matchResult.missingSkills?.map(s => <Badge key={s} color={C.red}>{s}</Badge>)}</div></div>
        </div>
      </Card>}

      {loading && <Spinner text="Searching jobs…" />}
      {searched && !loading && jobs.length === 0 && <Card style={{ textAlign: "center", padding: 48 }}><div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div><div style={{ fontWeight: 600 }}>No results — try different keywords</div></Card>}
      {jobs.length > 0 && <div>
        <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 14 }}>{jobs.length} jobs found for "{filters.title}"</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {jobs.map(job => (
            <Card key={job.id} style={{ ...(matchJobId === job.id ? { border: `1.5px solid ${C.purple}40` } : {}) }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}><Badge color={C.blue}>{job.source}</Badge>{job.remote && <Badge color={C.green}>Remote</Badge>}<Badge color={C.textMuted}>{job.employmentType}</Badge></div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 3 }}>{job.title}</div>
                  <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 5 }}>{job.company} · {job.location}</div>
                  <div style={{ fontSize: 13, color: C.green, fontWeight: 600, marginBottom: 8 }}>{fmtSalary(job.salaryMin, job.salaryMax)}</div>
                  <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.6, marginBottom: 8 }}>{job.description?.slice(0, 180)}…</div>
                  {job.skills && <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{job.skills.slice(0, 4).map(s => <span key={s} style={{ background: C.purpleLight, color: C.purple, borderRadius: 5, padding: "2px 8px", fontSize: 11, fontWeight: 600 }}>{s}</span>)}</div>}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 7, flexShrink: 0 }}>
                  <a href={job.applyUrl} target="_blank" rel="noreferrer" style={{ background: `linear-gradient(135deg,${C.purple},${C.purpleMid})`, color: "#fff", borderRadius: 9, padding: "9px 16px", fontSize: 13, fontWeight: 700, textDecoration: "none", textAlign: "center" }}>Apply →</a>
                  <Btn variant="secondary" style={{ fontSize: 12, padding: "7px 12px" }} onClick={() => analyzeMatch(job)} disabled={analyzing === job.id}>{analyzing === job.id ? "…" : "🤖 AI Match"}</Btn>
                  <button style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 7, padding: "5px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer", color: isSaved(job.id) ? C.red : C.textMuted }} onClick={() => toggleSave(job)}>{isSaved(job.id) ? "♥ Saved" : "♡ Save"}</button>
                  <button style={{ background: "none", border: `1px solid ${C.border}`, borderRadius: 7, padding: "5px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer", color: C.textMuted }} onClick={() => addTracker(job)}>+ Track</button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      </div>}
    </div>
  );
}

// ─── INTERVIEW PAGE ────────────────────────────────────────
function InterviewPage() {
  const [jobDesc, setJobDesc] = useState(""); const [loading, setLoading] = useState(false); const [questions, setQuestions] = useState([]); const [activeQ, setActiveQ] = useState(null); const [answer, setAnswer] = useState(""); const [feedback, setFeedback] = useState(null); const [fbLoading, setFbLoading] = useState(false); const [filterCat, setFilterCat] = useState("All");
  const diffColor = { Easy: C.green, Medium: C.yellow, Hard: C.red };

  const generate = async () => { if (!jobDesc.trim()) return; setLoading(true); setQuestions([]); try { const raw = await askClaude(`Generate 12 interview questions for this job. Return ONLY a JSON array:\n[{"id":1,"category":"<Behavioral|Technical|Situational|Culture Fit>","difficulty":"<Easy|Medium|Hard>","question":"<question>","whyAsked":"<reason>","tipToAnswer":"<how to answer tip>","sampleAnswer":"<strong sample answer>"}]\nJOB: ${jobDesc}`, 3000); setQuestions(JSON.parse(raw)); } catch {} finally { setLoading(false); } };
  const getFeedback = async () => { if (!answer.trim()) return; setFbLoading(true); setFeedback(null); try { const raw = await askClaude(`Rate this interview answer. Return ONLY JSON:\n{"score":<1-10>,"strengths":["<s1>","<s2>"],"improvements":["<i1>","<i2>"],"revisedAnswer":"<stronger version>"}\nQ: ${activeQ.question}\nA: ${answer}`, 1500); setFeedback(JSON.parse(raw)); } catch {} finally { setFbLoading(false); } };

  const cats = ["All", "Behavioral", "Technical", "Situational", "Culture Fit"];
  const filtered = questions.filter(q => filterCat === "All" || q.category === filterCat);

  return (
    <div>
      <h1 style={{ fontSize: 26, fontWeight: 800, color: C.text, marginBottom: 6 }}>Interview Prep</h1>
      <p style={{ color: C.textMuted, fontSize: 14, marginBottom: 24 }}>AI generates tailored questions and coaches your answers in real time.</p>
      {!questions.length && <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 16 }}>
        <Card><Textarea label="Job Description *" placeholder="Paste job description to generate tailored questions…" value={jobDesc} onChange={e => setJobDesc(e.target.value)} style={{ minHeight: 140 }} /></Card>
        <div style={{ display: "flex", gap: 10 }}><Btn onClick={generate} disabled={!jobDesc.trim()}>🎤 Generate 12 Questions</Btn><Btn variant="secondary" onClick={() => setJobDesc(SAMPLE_JOB)}>Try Sample</Btn></div>
      </div>}
      {loading && <Spinner text="Generating tailored interview questions…" />}
      {questions.length > 0 && !activeQ && <div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontWeight: 700, color: C.text }}>{questions.length} questions generated</div>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>{cats.map(c => <button key={c} style={{ padding: "5px 12px", borderRadius: 7, border: `1px solid ${filterCat === c ? C.purple : C.border}`, background: filterCat === c ? C.purpleLight : "#fff", color: filterCat === c ? C.purple : C.textMuted, fontSize: 12, fontWeight: 600, cursor: "pointer" }} onClick={() => setFilterCat(c)}>{c}</button>)}</div>
          <Btn variant="secondary" onClick={() => { setQuestions([]); setJobDesc(""); }}>← New Session</Btn>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((q, i) => <Card key={q.id} style={{ cursor: "pointer" }} onClick={() => { setActiveQ(q); setAnswer(""); setFeedback(null); }}>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <div><div style={{ display: "flex", gap: 6, marginBottom: 7 }}><Badge color={C.purple}>{q.category}</Badge><Badge color={diffColor[q.difficulty]}>{q.difficulty}</Badge></div><div style={{ fontSize: 13.5, color: C.text, lineHeight: 1.5 }}>Q{i+1}. {q.question}</div></div>
              <span style={{ color: C.textMuted, fontSize: 20 }}>›</span>
            </div>
          </Card>)}
        </div>
      </div>}
      {activeQ && <div>
        <Btn variant="secondary" style={{ marginBottom: 16 }} onClick={() => { setActiveQ(null); setFeedback(null); }}>← Back to Questions</Btn>
        <Card>
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}><Badge color={C.purple}>{activeQ.category}</Badge><Badge color={diffColor[activeQ.difficulty]}>{activeQ.difficulty}</Badge></div>
          <div style={{ fontSize: 18, fontWeight: 700, color: C.text, lineHeight: 1.4, marginBottom: 16 }}>{activeQ.question}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 18 }} className="two-col">
            <div style={{ background: C.blueLight, borderRadius: 10, padding: 14 }}><div style={{ fontSize: 11, color: C.blue, fontWeight: 700, marginBottom: 6 }}>WHY THEY ASK THIS</div><div style={{ fontSize: 13, lineHeight: 1.6, color: C.text }}>{activeQ.whyAsked}</div></div>
            <div style={{ background: C.yellowLight, borderRadius: 10, padding: 14 }}><div style={{ fontSize: 11, color: C.yellow, fontWeight: 700, marginBottom: 6 }}>💡 HOW TO ANSWER</div><div style={{ fontSize: 13, lineHeight: 1.6, color: C.text }}>{activeQ.tipToAnswer}</div></div>
          </div>
          <Textarea label="Your Practice Answer" placeholder="Type your answer here to get AI coaching…" value={answer} onChange={e => setAnswer(e.target.value)} style={{ minHeight: 120, marginBottom: 12 }} />
          <Btn onClick={getFeedback} disabled={!answer.trim() || fbLoading} style={{ marginBottom: 18 }}>{fbLoading ? "Analyzing…" : "🧠 Get AI Feedback"}</Btn>
          {fbLoading && <Spinner text="Analyzing your answer…" />}
          {feedback && !fbLoading && <div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}><span style={{ fontSize: 13, color: C.textMuted }}>Your Score</span><span style={{ fontSize: 30, fontWeight: 800, color: feedback.score >= 8 ? C.green : feedback.score >= 6 ? C.yellow : C.red }}>{feedback.score}/10</span></div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14 }} className="two-col">
              <div style={{ background: C.greenLight, borderRadius: 10, padding: 14 }}><div style={{ fontSize: 11, color: C.green, fontWeight: 700, marginBottom: 7 }}>✓ STRENGTHS</div>{feedback.strengths?.map((s, i) => <div key={i} style={{ fontSize: 12, marginBottom: 5, color: C.text }}>• {s}</div>)}</div>
              <div style={{ background: C.yellowLight, borderRadius: 10, padding: 14 }}><div style={{ fontSize: 11, color: C.yellow, fontWeight: 700, marginBottom: 7 }}>↑ IMPROVE</div>{feedback.improvements?.map((s, i) => <div key={i} style={{ fontSize: 12, marginBottom: 5, color: C.text }}>• {s}</div>)}</div>
            </div>
            {feedback.revisedAnswer && <div><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><div style={{ fontSize: 11, color: C.purple, fontWeight: 700 }}>✨ STRONGER VERSION</div><CopyBtn text={feedback.revisedAnswer} /></div><TextBox>{feedback.revisedAnswer}</TextBox></div>}
          </div>}
          <div style={{ marginTop: 20, borderTop: `1px solid ${C.border}`, paddingTop: 18 }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700 }}>📖 SAMPLE STRONG ANSWER</div><CopyBtn text={activeQ.sampleAnswer} /></div><TextBox>{activeQ.sampleAnswer}</TextBox></div>
        </Card>
      </div>}
    </div>
  );
}

// ─── TRACKER PAGE ──────────────────────────────────────────
const STATUSES = ["Saved","Applied","Phone Screen","Interview","Final Interview","Offer","Rejected","Ghosted"];
const SCOLOR = { Saved: C.textMuted, Applied: C.blue, "Phone Screen": C.yellow, Interview: C.purple, "Final Interview": "#7C3AED", Offer: C.green, Rejected: C.red, Ghosted: C.textMuted };

function TrackerPage({ applications, setApplications }) {
  const [showForm, setShowForm] = useState(false); const [editId, setEditId] = useState(null); const [form, setForm] = useState({ company: "", jobTitle: "", status: "Applied", date: new Date().toISOString().split("T")[0], atsScore: "", notes: "", url: "", followUpDate: "" }); const [filterStatus, setFilterStatus] = useState("All"); const [viewApp, setViewApp] = useState(null);
  const save = () => { if (!form.company || !form.jobTitle) return; if (editId) { setApplications(p => p.map(a => a.id === editId ? { ...a, ...form } : a)); setEditId(null); } else { setApplications(p => [{ ...form, id: Date.now() }, ...p]); } setForm({ company: "", jobTitle: "", status: "Applied", date: new Date().toISOString().split("T")[0], atsScore: "", notes: "", url: "", followUpDate: "" }); setShowForm(false); };
  const del = id => setApplications(p => p.filter(a => a.id !== id));
  const edit = app => { setForm({ ...app }); setEditId(app.id); setShowForm(true); setViewApp(null); };
  const filtered = applications.filter(a => filterStatus === "All" || a.status === filterStatus);
  const stats = STATUSES.reduce((acc, s) => { acc[s] = applications.filter(a => a.status === s).length; return acc; }, {});

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 10 }}>
        <div><h1 style={{ fontSize: 26, fontWeight: 800, color: C.text, marginBottom: 4 }}>Application Tracker</h1><p style={{ color: C.textMuted, fontSize: 14 }}>{applications.length} applications tracked</p></div>
        <Btn onClick={() => { setShowForm(true); setEditId(null); }}>+ Add Application</Btn>
      </div>
      {applications.length > 0 && <div style={{ display: "flex", gap: 8, marginBottom: 18, overflowX: "auto", paddingBottom: 4 }}>
        {STATUSES.filter(s => stats[s] > 0).map(s => <div key={s} style={{ background: `${SCOLOR[s]}12`, border: `1px solid ${SCOLOR[s]}30`, borderRadius: 10, padding: "8px 14px", flexShrink: 0, textAlign: "center" }}><div style={{ fontSize: 20, fontWeight: 800, color: SCOLOR[s] }}>{stats[s]}</div><div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>{s}</div></div>)}
      </div>}
      <div style={{ display: "flex", gap: 5, marginBottom: 14, flexWrap: "wrap" }}>
        {["All", ...STATUSES].map(s => <button key={s} style={{ padding: "5px 12px", borderRadius: 7, border: `1px solid ${filterStatus === s ? SCOLOR[s] || C.purple : C.border}`, background: filterStatus === s ? `${SCOLOR[s] || C.purple}12` : "#fff", color: filterStatus === s ? SCOLOR[s] || C.purple : C.textMuted, fontSize: 12, fontWeight: 600, cursor: "pointer" }} onClick={() => setFilterStatus(s)}>{s}</button>)}
      </div>
      {showForm && <Card style={{ marginBottom: 18, border: `1.5px solid ${C.purple}30` }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 16 }}>{editId ? "Edit" : "Add"} Application</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }} className="two-col">
          <Input label="Company *" placeholder="Google" value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value }))} />
          <Input label="Job Title *" placeholder="Software Engineer" value={form.jobTitle} onChange={e => setForm(f => ({ ...f, jobTitle: e.target.value }))} />
          <Select label="Status" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>{STATUSES.map(s => <option key={s}>{s}</option>)}</Select>
          <Input label="Date Applied" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
          <Input label="Follow-up Date" type="date" value={form.followUpDate} onChange={e => setForm(f => ({ ...f, followUpDate: e.target.value }))} />
          <Input label="ATS Score" type="number" placeholder="82" value={form.atsScore} onChange={e => setForm(f => ({ ...f, atsScore: e.target.value }))} />
          <div style={{ gridColumn: "1 / -1" }}><Input label="Job URL" placeholder="https://…" value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} /></div>
        </div>
        <div style={{ marginBottom: 14 }}><Textarea label="Notes" placeholder="Interview notes, follow-up tasks…" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ minHeight: 70 }} /></div>
        <div style={{ display: "flex", gap: 8 }}><Btn onClick={save}>💾 Save</Btn><Btn variant="secondary" onClick={() => { setShowForm(false); setEditId(null); }}>Cancel</Btn></div>
      </Card>}
      {filtered.length === 0 && !showForm && <Card style={{ textAlign: "center", padding: 48 }}><div style={{ fontSize: 36, marginBottom: 12 }}>📋</div><div style={{ fontWeight: 600, color: C.text, marginBottom: 6 }}>No applications yet</div><div style={{ fontSize: 13, color: C.textMuted }}>Add one manually or save from Resume Tailor</div></Card>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {filtered.map(app => <div key={app.id} style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 12, padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 150 }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{app.jobTitle}</div>
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{app.company} · {app.date}</div>
            {app.followUpDate && <div style={{ fontSize: 11, color: C.yellow, marginTop: 3 }}>⏰ Follow up: {app.followUpDate}</div>}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            {app.atsScore > 0 && <span style={{ fontSize: 11, color: C.blue, fontWeight: 700 }}>ATS {app.atsScore}</span>}
            <Badge color={SCOLOR[app.status]}>{app.status}</Badge>
            {(app.resume || app.coverLetter || app.notes) && <Btn variant="ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => setViewApp(viewApp?.id === app.id ? null : app)}>View</Btn>}
            {app.url && <a href={app.url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: C.blue }}>🔗</a>}
            <Btn variant="ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => edit(app)}>Edit</Btn>
            <Btn variant="danger" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => del(app.id)}>✕</Btn>
          </div>
        </div>)}
      </div>
      {viewApp && <Card style={{ marginTop: 14, border: `1.5px solid ${SCOLOR[viewApp.status]}30` }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 14 }}><div><div style={{ fontSize: 15, fontWeight: 700 }}>{viewApp.jobTitle} — {viewApp.company}</div></div><Btn variant="ghost" style={{ padding: "4px 10px" }} onClick={() => setViewApp(null)}>✕</Btn></div>
        {viewApp.resume && <div style={{ marginBottom: 14 }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}><div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted }}>RESUME</div><CopyBtn text={viewApp.resume} /></div><TextBox>{viewApp.resume}</TextBox></div>}
        {viewApp.coverLetter && <div style={{ marginBottom: 14 }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 7 }}><div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted }}>COVER LETTER</div><CopyBtn text={viewApp.coverLetter} /></div><TextBox>{viewApp.coverLetter}</TextBox></div>}
        {viewApp.notes && <div style={{ background: C.bgSoft, borderRadius: 9, padding: 14 }}><div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 6 }}>NOTES</div><div style={{ fontSize: 13, lineHeight: 1.6 }}>{viewApp.notes}</div></div>}
      </Card>}
    </div>
  );
}

// ─── SALARY PAGE ───────────────────────────────────────────
function SalaryPage() {
  const [form, setForm] = useState({ jobTitle: "", location: "", experience: "", skills: "" }); const [loading, setLoading] = useState(false); const [results, setResults] = useState(null); const [error, setError] = useState("");
  const fmt = n => n ? `$${Number(n).toLocaleString()}` : "—";
  const analyze = async () => { if (!form.jobTitle || !form.location) { setError("Job title and location are required."); return; } setError(""); setLoading(true); setResults(null); try { const raw = await askClaude(`Provide accurate 2026 salary data. Return ONLY JSON:\n{"salaryRange":{"low":<n>,"median":<n>,"high":<n>},"totalComp":{"median":<n>},"equityRange":"<range>","bonusRange":"<range>","topPayingCompanies":[{"name":"<n>","avgComp":"<c>"}],"salaryByExperience":[{"level":"<l>","salary":<n>}],"negotiationTips":["<t1>","<t2>","<t3>","<t4>"],"marketOutlook":"<outlook paragraph>","skillPremiums":[{"skill":"<s>","premium":"<p>"}],"benchmarkInsight":"<1 sentence insight>"}\nRole: ${form.jobTitle}, Location: ${form.location}, Experience: ${form.experience}, Skills: ${form.skills}`, 2000); setResults(JSON.parse(raw)); } catch { setError("Failed to get data. Please try again."); } finally { setLoading(false); } };

  return (
    <div>
      <h1 style={{ fontSize: 26, fontWeight: 800, color: C.text, marginBottom: 6 }}>Salary Insights</h1>
      <p style={{ color: C.textMuted, fontSize: 14, marginBottom: 24 }}>Know your market value before you negotiate — powered by 2026 compensation data.</p>
      <Card style={{ marginBottom: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 14 }} className="two-col">
          <Input label="Job Title *" placeholder="Senior Frontend Engineer" value={form.jobTitle} onChange={e => setForm(f => ({ ...f, jobTitle: e.target.value }))} />
          <Input label="Location *" placeholder="San Francisco, CA" value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} />
          <Input label="Years of Experience" placeholder="4 years" value={form.experience} onChange={e => setForm(f => ({ ...f, experience: e.target.value }))} />
          <Input label="Key Skills" placeholder="React, TypeScript, AWS" value={form.skills} onChange={e => setForm(f => ({ ...f, skills: e.target.value }))} />
        </div>
        {error && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, color: C.red, fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <Btn onClick={analyze}>💰 Get Salary Data</Btn>
      </Card>
      {loading && <Spinner text="Researching 2026 compensation data…" />}
      {results && <div>
        <Card style={{ marginBottom: 16, background: `linear-gradient(135deg, ${C.purpleLight}, #fff)`, border: `1.5px solid ${C.purple}20` }}>
          <div style={{ fontSize: 13, color: C.purple, fontWeight: 600, marginBottom: 14 }}>{results.benchmarkInsight}</div>
          <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, marginBottom: 16, paddingBottom: 16 }}>
            {[["Low", results.salaryRange?.low, C.textMuted], ["Median", results.salaryRange?.median, C.purple], ["High", results.salaryRange?.high, C.green]].map(([l, v, c]) => <div key={l} style={{ flex: 1, textAlign: "center", borderRight: l !== "High" ? `1px solid ${C.border}` : "none" }}><div style={{ fontSize: 22, fontWeight: 800, color: c }}>{fmt(v)}</div><div style={{ fontSize: 10, color: C.textMuted, textTransform: "uppercase", letterSpacing: "1px", marginTop: 3 }}>{l}</div></div>)}
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {[["Total Comp", fmt(results.totalComp?.median), C.purple], ["Equity", results.equityRange, C.yellow], ["Bonus", results.bonusRange, C.green]].map(([l, v, c]) => <div key={l} style={{ background: `${c}15`, border: `1px solid ${c}25`, borderRadius: 9, padding: "10px 16px" }}><div style={{ fontSize: 13, fontWeight: 700, color: c }}>{v}</div><div style={{ fontSize: 10, color: C.textMuted, marginTop: 2 }}>{l}</div></div>)}
          </div>
        </Card>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }} className="two-col">
          <Card><div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "1px", marginBottom: 12 }}>📈 By Experience</div>{results.salaryByExperience?.map(({ level, salary }) => { const max = Math.max(...results.salaryByExperience.map(x => x.salary)); return <div key={level} style={{ marginBottom: 10 }}><div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}><span style={{ color: C.textMid }}>{level}</span><span style={{ color: C.purple, fontWeight: 700 }}>{fmt(salary)}</span></div><PBar val={Math.round((salary/max)*100)} color={C.purple} /></div>; })}</Card>
          <Card><div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "1px", marginBottom: 12 }}>⚡ Skill Premiums</div>{results.skillPremiums?.map(({ skill, premium }) => <div key={skill} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.border}` }}><span style={{ fontSize: 13, color: C.text }}>{skill}</span><span style={{ fontSize: 12, fontWeight: 700, color: C.green }}>{premium}</span></div>)}</Card>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }} className="two-col">
          <Card><div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "1px", marginBottom: 12 }}>🏆 Top Companies</div>{results.topPayingCompanies?.map(({ name, avgComp }, i) => <div key={name} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: `1px solid ${C.border}` }}><div style={{ display: "flex", gap: 8, alignItems: "center" }}><span style={{ width: 20, height: 20, background: C.purpleLight, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: C.purple }}>{i+1}</span><span style={{ fontSize: 13 }}>{name}</span></div><span style={{ fontSize: 12, fontWeight: 700, color: C.green }}>{avgComp}</span></div>)}</Card>
          <Card><div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "1px", marginBottom: 12 }}>🤝 Negotiation Tips</div>{results.negotiationTips?.map((tip, i) => <div key={i} style={{ display: "flex", gap: 8, marginBottom: 10 }}><span style={{ width: 18, height: 18, background: C.blueLight, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: C.blue, flexShrink: 0 }}>{i+1}</span><span style={{ fontSize: 12, lineHeight: 1.6, color: C.text }}>{tip}</span></div>)}</Card>
        </div>
        {results.marketOutlook && <Card style={{ marginTop: 14, border: `1px solid ${C.green}25` }}><div style={{ fontSize: 11, color: C.green, fontWeight: 700, marginBottom: 8 }}>🔮 MARKET OUTLOOK</div><div style={{ fontSize: 13, lineHeight: 1.7, color: C.text }}>{results.marketOutlook}</div></Card>}
      </div>}
    </div>
  );
}

// ─── NETWORKING PAGE ───────────────────────────────────────
function NetworkingPage() {
  const [form, setForm] = useState({ targetName: "", targetRole: "", targetCompany: "", yourBackground: "", purpose: "coffee-chat", jobDesc: "" }); const [loading, setLoading] = useState(false); const [results, setResults] = useState(null); const [error, setError] = useState(""); const [tab, setTab] = useState("linkedin");
  const purposes = [{ value: "coffee-chat", label: "☕ Coffee Chat" }, { value: "referral", label: "🤝 Referral" }, { value: "informational", label: "🎓 Informational Interview" }, { value: "reconnect", label: "👋 Reconnect" }, { value: "cold-outreach", label: "📨 Cold Outreach" }];
  const generate = async () => { if (!form.targetCompany || !form.yourBackground) { setError("Please fill in your background and target company."); return; } setError(""); setLoading(true); setResults(null); try { const raw = await askClaude(`Write personalized networking outreach. Return ONLY JSON:\n{"linkedinMessage":"<max 280 chars, friendly and specific>","linkedinNote":"<3 paragraph InMail, professional>","email":{"subject":"<compelling subject>","body":"<150-200 word email>"},"followUp":"<7-day follow up message>","icebreakers":["<topic1>","<topic2>","<topic3>"],"doList":["<do1>","<do2>","<do3>"],"dontList":["<dont1>","<dont2>","<dont3>"],"callToAction":"<specific ask>"}\nTarget: ${form.targetName} (${form.targetRole} at ${form.targetCompany}), My background: ${form.yourBackground}, Purpose: ${form.purpose}${form.jobDesc ? ", Job: " + form.jobDesc : ""}`, 2000); setResults(JSON.parse(raw)); setTab("linkedin"); } catch { setError("Failed. Please try again."); } finally { setLoading(false); } };

  return (
    <div>
      <h1 style={{ fontSize: 26, fontWeight: 800, color: C.text, marginBottom: 6 }}>Networking Assistant</h1>
      <p style={{ color: C.textMuted, fontSize: 14, marginBottom: 24 }}>AI writes personalized outreach that feels human — not generic templates.</p>
      <Card style={{ marginBottom: 18 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }} className="two-col">
          <Input label="Their Name" placeholder="Sarah Chen" value={form.targetName} onChange={e => setForm(f => ({ ...f, targetName: e.target.value }))} />
          <Input label="Their Role" placeholder="Engineering Manager" value={form.targetRole} onChange={e => setForm(f => ({ ...f, targetRole: e.target.value }))} />
          <Input label="Company *" placeholder="Stripe, Google…" value={form.targetCompany} onChange={e => setForm(f => ({ ...f, targetCompany: e.target.value }))} />
          <Select label="Purpose" value={form.purpose} onChange={e => setForm(f => ({ ...f, purpose: e.target.value }))}>{purposes.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</Select>
          <div style={{ gridColumn: "1 / -1" }}><Textarea label="Your Background *" placeholder="4-year software engineer with React experience, looking to transition into fintech…" value={form.yourBackground} onChange={e => setForm(f => ({ ...f, yourBackground: e.target.value }))} style={{ minHeight: 80 }} /></div>
          {form.purpose === "referral" && <div style={{ gridColumn: "1 / -1" }}><Textarea label="Job You Want Referral For" placeholder="Paste job description…" value={form.jobDesc} onChange={e => setForm(f => ({ ...f, jobDesc: e.target.value }))} style={{ minHeight: 80 }} /></div>}
        </div>
        {error && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, color: C.red, fontSize: 13, marginBottom: 12 }}>{error}</div>}
        <Btn onClick={generate}>✍️ Generate Messages</Btn>
      </Card>
      {loading && <Spinner text="Crafting personalized messages…" />}
      {results && <div>
        <div style={{ display: "flex", gap: 3, background: C.bgSoft, borderRadius: 10, padding: 3, marginBottom: 16 }}>
          {[["linkedin","💼 LinkedIn"],["email","📧 Email"],["followup","🔁 Follow-up"],["tips","💡 Tips"]].map(([id, lbl]) => <button key={id} style={{ flex: 1, padding: "8px", borderRadius: 7, border: "none", background: tab === id ? "#fff" : "transparent", color: tab === id ? C.text : C.textMuted, fontSize: 13, fontWeight: 600, cursor: "pointer" }} onClick={() => setTab(id)}>{lbl}</button>)}
        </div>
        {tab === "linkedin" && <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Card><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted }}>CONNECTION REQUEST (MAX 280 CHARS)</div><CopyBtn text={results.linkedinMessage} /></div><TextBox>{results.linkedinMessage}</TextBox><div style={{ fontSize: 11, color: results.linkedinMessage?.length > 280 ? C.red : C.textMuted, marginTop: 5 }}>{results.linkedinMessage?.length}/280</div></Card>
          <Card><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted }}>INMAIL / FULL MESSAGE</div><CopyBtn text={results.linkedinNote} /></div><TextBox>{results.linkedinNote}</TextBox></Card>
          <div style={{ background: C.greenLight, border: `1px solid ${C.green}25`, borderRadius: 10, padding: 14 }}><div style={{ fontSize: 11, color: C.green, fontWeight: 700, marginBottom: 6 }}>🎯 YOUR ASK</div><div style={{ fontSize: 13, lineHeight: 1.6 }}>{results.callToAction}</div></div>
        </div>}
        {tab === "email" && results.email && <Card>
          <div style={{ marginBottom: 14 }}><div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 8 }}>SUBJECT LINE</div><div style={{ background: C.bgSoft, borderRadius: 9, padding: "10px 14px", display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: 13, fontWeight: 600 }}>{results.email.subject}</span><CopyBtn text={results.email.subject} /></div></div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted }}>EMAIL BODY</div><CopyBtn text={results.email.body} /></div><TextBox>{results.email.body}</TextBox>
        </Card>}
        {tab === "followup" && <Card>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><div><div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted }}>FOLLOW-UP MESSAGE</div><div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>Send after 7 days of no reply</div></div><CopyBtn text={results.followUp} /></div>
          <TextBox style={{ marginBottom: 18 }}>{results.followUp}</TextBox>
          <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, marginBottom: 10 }}>💬 CONVERSATION ICEBREAKERS</div>
          {results.icebreakers?.map((ic, i) => <div key={i} style={{ background: C.bgSoft, borderRadius: 9, padding: "10px 14px", marginBottom: 7, display: "flex", gap: 8 }}><span style={{ color: C.blue, fontWeight: 700 }}>{i+1}.</span><span style={{ fontSize: 13, lineHeight: 1.6 }}>{ic}</span></div>)}
        </Card>}
        {tab === "tips" && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }} className="two-col">
          <Card><div style={{ fontSize: 11, color: C.green, fontWeight: 700, marginBottom: 12 }}>✓ DO THIS</div>{results.doList?.map((t, i) => <div key={i} style={{ display: "flex", gap: 8, marginBottom: 10 }}><span style={{ color: C.green, flexShrink: 0 }}>✓</span><span style={{ fontSize: 12, lineHeight: 1.6, color: C.text }}>{t}</span></div>)}</Card>
          <Card><div style={{ fontSize: 11, color: C.red, fontWeight: 700, marginBottom: 12 }}>✗ AVOID THIS</div>{results.dontList?.map((t, i) => <div key={i} style={{ display: "flex", gap: 8, marginBottom: 10 }}><span style={{ color: C.red, flexShrink: 0 }}>✗</span><span style={{ fontSize: 12, lineHeight: 1.6, color: C.text }}>{t}</span></div>)}</Card>
        </div>}
      </div>}
    </div>
  );
}

// ─── SAVED JOBS ────────────────────────────────────────────
function SavedJobsPage({ savedJobs, setSavedJobs, setApplications }) {
  const remove = id => setSavedJobs(p => p.filter(j => j.job_id !== id));
  const addTracker = job => setApplications(p => [{ id: Date.now(), company: job.company, jobTitle: job.title, status: "Applied", date: new Date().toISOString().split("T")[0], notes: "", url: job.applyUrl }, ...p]);
  return (
    <div>
      <h1 style={{ fontSize: 26, fontWeight: 800, color: C.text, marginBottom: 6 }}>Saved Jobs</h1>
      <p style={{ color: C.textMuted, fontSize: 14, marginBottom: 24 }}>{savedJobs.length} saved job{savedJobs.length !== 1 ? "s" : ""} — apply when you're ready.</p>
      {savedJobs.length === 0 && <Card style={{ textAlign: "center", padding: 60 }}><div style={{ fontSize: 40, marginBottom: 14 }}>♡</div><div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginBottom: 6 }}>No saved jobs yet</div><div style={{ fontSize: 13, color: C.textMuted }}>Heart any job in Job Search to save it here</div></Card>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {savedJobs.map(job => <Card key={job.job_id}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 3 }}>{job.title}</div>
              <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 6 }}>{job.company} · {job.location}</div>
              <div style={{ display: "flex", gap: 6 }}>{job.remote && <Badge color={C.green}>Remote</Badge>}{job.employmentType && <Badge color={C.textMuted}>{job.employmentType}</Badge>}</div>
            </div>
            <div style={{ display: "flex", gap: 7, alignItems: "flex-start", flexWrap: "wrap" }}>
              <a href={job.applyUrl} target="_blank" rel="noreferrer" style={{ background: `linear-gradient(135deg,${C.purple},${C.purpleMid})`, color: "#fff", borderRadius: 9, padding: "9px 16px", fontSize: 13, fontWeight: 700, textDecoration: "none" }}>Apply →</a>
              <Btn variant="green" onClick={() => addTracker(job)}>+ Track</Btn>
              <Btn variant="danger" onClick={() => remove(job.job_id)}>✕ Remove</Btn>
            </div>
          </div>
        </Card>)}
      </div>
    </div>
  );
}

// ─── PRICING PAGE ──────────────────────────────────────────
function PricingPage({ profile }) {
  const plans = [
    { id: "free", name: "Free", price: "$0", color: C.textMuted, features: ["3 resume analyses/month","10 job searches/day","Basic application tracker","3 interview sessions/month"], cta: "Current Plan", disabled: true },
    { id: "pro", name: "Pro", price: "$19/mo", color: C.purple, popular: true, features: ["Unlimited resume analyses","Unlimited job searches","Full interview prep coaching","Salary insights & benchmarks","Networking message generator","AI job match scoring","Priority AI processing"], cta: "Start Pro Trial", disabled: false },
    { id: "premium", name: "Premium", price: "$49/mo", color: C.blue, features: ["Everything in Pro","Advanced AI job matching","Auto-apply (coming soon)","Chrome extension (coming soon)","LinkedIn integration (coming soon)","Email follow-up automation (soon)","Dedicated AI career coach"], cta: "Start Premium Trial", disabled: false },
  ];
  return (
    <div>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, letterSpacing: "-0.5px", marginBottom: 8 }}>Simple, Transparent Pricing</h1>
        <p style={{ color: C.textMuted, fontSize: 14 }}>Start free. Upgrade when you're ready to accelerate your search.</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, maxWidth: 900, margin: "0 auto" }} className="three-col">
        {plans.map(plan => <Card key={plan.id} style={{ position: "relative", border: plan.popular ? `2px solid ${C.purple}` : `1px solid ${C.border}` }}>
          {plan.popular && <div style={{ position: "absolute", top: -12, left: "50%", transform: "translateX(-50%)", background: `linear-gradient(135deg,${C.purple},${C.purpleMid})`, color: "#fff", fontSize: 11, fontWeight: 700, padding: "3px 14px", borderRadius: 20 }}>MOST POPULAR</div>}
          <div style={{ fontSize: 16, fontWeight: 700, color: plan.color, marginBottom: 6 }}>{plan.name}</div>
          <div style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 18 }}>{plan.price}</div>
          <div style={{ marginBottom: 20, paddingBottom: 20, borderBottom: `1px solid ${C.border}` }}>
            {plan.features.map((f, i) => <div key={i} style={{ display: "flex", gap: 8, marginBottom: 8, fontSize: 13, color: C.textMid }}><span style={{ color: plan.color, flexShrink: 0 }}>✓</span>{f}</div>)}
          </div>
          <Btn variant={plan.id === "free" ? "secondary" : plan.id === "pro" ? "primary" : "ghost"} style={{ width: "100%", justifyContent: "center", opacity: plan.disabled ? 0.5 : 1, ...(plan.id === "premium" ? { background: C.blue, color: "#fff" } : {}) }} disabled={plan.disabled} onClick={() => { if (!plan.disabled) alert(`Connect Stripe to enable ${plan.name} payments`); }}>
            {profile?.plan === plan.id ? "Current Plan" : plan.cta}
          </Btn>
        </Card>)}
      </div>
    </div>
  );
}

// ─── PROFILE PAGE ──────────────────────────────────────────
function ProfilePage({ profile, updateProfile, logout }) {
  const [form, setForm] = useState({ full_name: profile?.full_name || "", phone: "", location: "", linkedin_url: "", job_title: "", years_experience: "" });
  const [saved, setSaved] = useState(false);
  const save = () => { updateProfile(form); setSaved(true); setTimeout(() => setSaved(false), 2000); };
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24 }}>
        <div><h1 style={{ fontSize: 26, fontWeight: 800, color: C.text, marginBottom: 4 }}>Profile</h1><p style={{ color: C.textMuted, fontSize: 13 }}>{profile?.email}</p></div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}><Badge color={C.purple}>{(profile?.plan || "FREE").toUpperCase()}</Badge><Btn variant="danger" onClick={logout}>Sign Out</Btn></div>
      </div>
      <Card style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 16 }}>Personal Information</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }} className="two-col">
          <Input label="Full Name" value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} />
          <Input label="Phone" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
          <Input label="Location" placeholder="San Francisco, CA" value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} />
          <Input label="LinkedIn URL" placeholder="linkedin.com/in/yourname" value={form.linkedin_url} onChange={e => setForm(f => ({ ...f, linkedin_url: e.target.value }))} />
          <Input label="Current Job Title" placeholder="Software Engineer" value={form.job_title} onChange={e => setForm(f => ({ ...f, job_title: e.target.value }))} />
          <Input label="Years of Experience" placeholder="4 years" value={form.years_experience} onChange={e => setForm(f => ({ ...f, years_experience: e.target.value }))} />
        </div>
        <Btn onClick={save}>{saved ? "✓ Saved!" : "Save Profile"}</Btn>
      </Card>
    </div>
  );
}

// ─── MAIN APP ──────────────────────────────────────────────
export default function App() {
  const { user, login, logout } = useAuth();
  const [profile, setProfile] = useState(() => { try { return JSON.parse(localStorage.getItem("cp_user") || "null"); } catch { return null; } });
  const [applications, setApplications] = useStorage("cp_apps", []);
  const [savedJobs, setSavedJobs] = useStorage("cp_saved", []);
  const [page, setPage] = useState("resume");

  const handleLogin = (u) => { login(u); setProfile(u); };
  const handleLogout = () => { logout(); setProfile(null); };
  const updateProfile = (updates) => { const updated = { ...profile, ...updates }; setProfile(updated); localStorage.setItem("cp_user", JSON.stringify(updated)); };
  const handleSaveApp = (app) => setApplications(p => [app, ...p]);

  const nav = [
    { id: "resume", icon: "⚡", label: "Resume" },
    { id: "jobs", icon: "🔍", label: "Jobs" },
    { id: "saved", icon: "♥", label: `Saved${savedJobs.length > 0 ? ` (${savedJobs.length})` : ""}` },
    { id: "interview", icon: "🎤", label: "Interview" },
    { id: "tracker", icon: "📋", label: `Tracker${applications.length > 0 ? ` (${applications.length})` : ""}` },
    { id: "salary", icon: "💰", label: "Salary" },
    { id: "network", icon: "🤝", label: "Network" },
    { id: "pricing", icon: "💎", label: "Pricing" },
    { id: "profile", icon: "👤", label: profile?.full_name?.split(" ")[0] || "Profile" },
  ];

  if (!user) return <AuthPage onLogin={handleLogin} />;

  return (
    <div style={{ minHeight: "100vh", background: C.bgSoft, fontFamily: "'Inter','Segoe UI',system-ui,sans-serif", color: C.text }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input:focus, textarea:focus, select:focus { border-color: ${C.purple} !important; box-shadow: 0 0 0 3px ${C.purple}15; }
        ::placeholder { color: ${C.textMuted}; opacity: 0.6; }
        @keyframes spin { to { transform: rotate(360deg); } }
        button:hover:not(:disabled) { opacity: 0.88; }
        ::-webkit-scrollbar { width: 5px; } ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
        @media (max-width: 680px) { .two-col, .three-col { grid-template-columns: 1fr !important; } .nav-label { display: none; } }
        a { color: inherit; }
      `}</style>
      <header style={{ background: "#fff", borderBottom: `1px solid ${C.border}`, padding: "12px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100, boxShadow: "0 1px 4px rgba(0,0,0,0.06)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Logo size={34} />
          <AppName size={17} />
        </div>
        <nav style={{ display: "flex", gap: 2, background: C.bgSoft, borderRadius: 10, padding: 3, overflowX: "auto" }}>
          {nav.map(n => (
            <button key={n.id} style={{ padding: "7px 13px", borderRadius: 7, border: "none", background: page === n.id ? "#fff" : "transparent", color: page === n.id ? C.text : C.textMuted, fontSize: 12, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", boxShadow: page === n.id ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }} onClick={() => setPage(n.id)}>
              <span>{n.icon}</span><span className="nav-label">{n.label}</span>
            </button>
          ))}
        </nav>
        <Badge color={C.purple}>{(profile?.plan || "FREE").toUpperCase()}</Badge>
      </header>
      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 18px 80px" }}>
        {page === "resume" && <ResumePage onSave={handleSaveApp} />}
        {page === "jobs" && <JobSearchPage savedJobs={savedJobs} setSavedJobs={setSavedJobs} setApplications={setApplications} />}
        {page === "saved" && <SavedJobsPage savedJobs={savedJobs} setSavedJobs={setSavedJobs} setApplications={setApplications} />}
        {page === "interview" && <InterviewPage />}
        {page === "tracker" && <TrackerPage applications={applications} setApplications={setApplications} />}
        {page === "salary" && <SalaryPage />}
        {page === "network" && <NetworkingPage />}
        {page === "pricing" && <PricingPage profile={profile} />}
        {page === "profile" && <ProfilePage profile={profile} updateProfile={updateProfile} logout={handleLogout} />}
      </main>
    </div>
  );
}

import { useState, useCallback, useRef, useEffect } from "react";

const C = {
  bg: "#FFFFFF", bgSoft: "#F7F8FC", bgCard: "#FFFFFF", border: "#E2E8F0", borderStrong: "#CBD5E1",
  purple: "#6B21E8", purpleLight: "#F3EEFF", purpleMid: "#9B59F5", text: "#0F172A", textMid: "#334155",
  textMuted: "#64748B", green: "#059669", greenLight: "#ECFDF5", red: "#DC2626", redLight: "#FEF2F2",
  yellow: "#D97706", yellowLight: "#FFFBEB", blue: "#2563EB", blueLight: "#EFF6FF",
};

const useStorage = (key, initial) => {
  const [val, setVal] = useState(() => { try { const d = localStorage.getItem(key); return d ? JSON.parse(d) : initial; } catch { return initial; } });
  const set = useCallback((v) => { const next = typeof v === "function" ? v(val) : v; setVal(next); localStorage.setItem(key, JSON.stringify(next)); }, [key, val]);
  return [val, set];
};

// Unique ID generator — crypto.randomUUID with a safe fallback
const uid = () => {
  try { if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID(); } catch {}
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

const useAuth = () => {
  const [user, setUser] = useState(() => { try { return JSON.parse(localStorage.getItem("cp_user") || "null"); } catch { return null; } });
  const login = (u) => { setUser(u); localStorage.setItem("cp_user", JSON.stringify(u)); };
  const logout = () => { setUser(null); localStorage.removeItem("cp_user"); };
  return { user, login, logout };
};

async function askClaude(prompt, maxTokens = 2500) {
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

function downloadPDF(content, filename) {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;max-width:800px;margin:40px auto;padding:20px;line-height:1.6;color:#333;white-space:pre-wrap;}</style></head><body>${content.replace(/\n/g, '<br>')}</body></html>`;
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename + '.html'; a.click();
  URL.revokeObjectURL(url);
}

function downloadDOCX(content, filename) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename + '.txt'; a.click();
  URL.revokeObjectURL(url);
}

function Logo({ size = 36, onClick }) {
  return (
    <div onClick={onClick} style={{ width: size, height: size, background: `linear-gradient(135deg, ${C.purple}, ${C.purpleMid})`, borderRadius: size * 0.25, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, cursor: onClick ? "pointer" : "default" }}>
      <span style={{ color: "#fff", fontWeight: 900, fontSize: size * 0.44, letterSpacing: "-1px" }}>CP</span>
    </div>
  );
}

function AppName({ size = 18, onClick }) {
  return (
    <span onClick={onClick} style={{ fontSize: size, fontWeight: 800, letterSpacing: "-0.5px", cursor: onClick ? "pointer" : "default" }}>
      <span style={{ color: C.text }}>Career</span><span style={{ color: C.purple }}>Persona</span>
      <span style={{ background: `linear-gradient(135deg,${C.purple},${C.purpleMid})`, color: "#fff", fontSize: size * 0.65, fontWeight: 700, padding: "1px 6px", borderRadius: 5, marginLeft: 5, verticalAlign: "middle" }}>AI</span>
    </span>
  );
}

function Btn({ children, onClick, variant = "primary", disabled, style = {} }) {
  const base = { border: "none", borderRadius: 10, padding: "11px 22px", fontSize: 14, fontWeight: 700, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, display: "inline-flex", alignItems: "center", gap: 7, transition: "all 0.15s", ...style };
  const variants = { primary: { background: `linear-gradient(135deg,${C.purple},${C.purpleMid})`, color: "#fff" }, secondary: { background: C.bgSoft, color: C.textMid, border: `1px solid ${C.border}` }, green: { background: C.green, color: "#fff" }, ghost: { background: "transparent", color: C.textMuted, border: `1px solid ${C.border}` }, danger: { background: "transparent", color: C.red, border: `1px solid ${C.red}40` }, blue: { background: C.blue, color: "#fff" } };
  return <button style={{ ...base, ...variants[variant] }} onClick={onClick} disabled={disabled}>{children}</button>;
}

function Card({ children, style = {}, onClick, ...rest }) {
  return <div onClick={onClick} style={{ background: C.bgCard, border: `1px solid ${C.border}`, borderRadius: 16, padding: 24, boxShadow: "0 1px 4px rgba(0,0,0,0.04)", ...style }} {...rest}>{children}</div>;
}

function Label({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "1.2px", marginBottom: 7 }}>{children}</div>;
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

function CopyBtn({ text, label = "Copy" }) {
  const [c, setC] = useState(false);
  return <Btn variant="ghost" style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => { navigator.clipboard.writeText(text); setC(true); setTimeout(() => setC(false), 2000); }}>{c ? "✓ Copied!" : label}</Btn>;
}

function ContentDisplay({ content }) {
  return (
    <div style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px", fontSize: 14, lineHeight: 1.85, color: C.text, whiteSpace: "pre-wrap", maxHeight: 420, overflowY: "auto", fontFamily: "inherit" }}>
      {content}
    </div>
  );
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
    onLogin({ id: uid(), email: form.email, full_name: form.name || form.email.split("@")[0], plan: "free" });
    setLoading(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bgSoft, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div style={{ width: "100%", maxWidth: 420 }}>
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <div style={{ display: "flex", justifyContent: "center", marginBottom: 14 }}><Logo size={56} /></div>
          <AppName size={26} />
          <div style={{ fontSize: 14, color: C.textMuted, marginTop: 10 }}>Your AI-powered career platform</div>
        </div>
        <Card>
          <div style={{ display: "flex", gap: 3, background: C.bgSoft, borderRadius: 10, padding: 3, marginBottom: 22 }}>
            {["login","signup"].map(m => <button key={m} style={{ flex: 1, padding: "9px", borderRadius: 7, border: "none", background: mode === m ? "#fff" : "transparent", color: mode === m ? C.text : C.textMuted, fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: mode === m ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }} onClick={() => { setMode(m); setError(""); }}>{m === "login" ? "Sign In" : "Sign Up"}</button>)}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
            {mode === "signup" && <Input label="Full Name" placeholder="John Smith" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />}
            <Input label="Email" type="email" placeholder="you@email.com" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} onKeyDown={e => e.key === "Enter" && handle()} />
            <Input label="Password" type="password" placeholder="••••••••" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} onKeyDown={e => e.key === "Enter" && handle()} />
          </div>
          {error && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, color: C.red, fontSize: 13, marginTop: 14 }}>{error}</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 20 }}>
            <Btn onClick={handle} disabled={loading} style={{ width: "100%", justifyContent: "center", padding: "13px 22px" }}>
              {loading ? "Please wait..." : mode === "login" ? "Sign In" : "Create Account"}
            </Btn>
            <button style={{ width: "100%", padding: "13px", border: `1.5px solid ${C.border}`, borderRadius: 10, background: "#fff", color: C.textMid, fontSize: 13, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }} onClick={() => onLogin({ id: "g_" + Date.now(), email: "user@gmail.com", full_name: "Google User", plan: "free" })}>
              <span style={{ fontWeight: 800, color: C.blue, fontSize: 15 }}>G</span> Continue with Google
            </button>
          </div>
        </Card>
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

const RESUME_STEPS = ["Analyzing Resume…", "Calculating ATS Score…", "Generating Tailored Resume…", "Creating Cover Letter…"];

function ResumePage({ onSave, onNavigate }) {
  const [resume, setResume] = useState("");
  const [jobDesc, setJobDesc] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadStep, setLoadStep] = useState(0);
  const [results, setResults] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("resume");
  const [saved, setSaved] = useState(false);
  const fileRef = useRef();

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    
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
          else setError("Could not extract text from image.");
        } catch { setError("Could not extract text from image. Please paste your resume instead."); }
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
          text += content.items.map(it => it.str).join(" ") + "\n";
        }
        if (text.trim()) {
          setResume(text.trim());
        } else {
          setError("Could not extract text from this PDF. It may be scanned/image-based — please paste your resume instead.");
        }
      } catch {
        setError("Could not read this PDF. Please paste your resume text instead.");
      }
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
          setError("Could not read this DOCX file. Please copy and paste your resume text directly into the box.");
        }
      };
      reader.readAsText(file);
    } else {
      // TXT and other text files
      const reader = new FileReader();
      reader.onload = (ev) => { setResume(ev.target.result); };
      reader.readAsText(file);
    }
  };

  const analyze = async () => {
    if (!resume.trim() || !jobDesc.trim()) { setError("Please add both resume and job description."); return; }
    setError(""); setLoading(true); setResults(null); setLoadStep(0);
    const iv = setInterval(() => setLoadStep(s => Math.min(s + 1, 3)), 2000);
    try {
      const raw = await askClaude(`You are an expert ATS resume coach. Analyze the resume against the job description and return ONLY a JSON object, no markdown, no explanation:
{"atsScore":<0-100>,"potentialAtsScore":<estimated score after improvements 0-100>,"scoreBreakdown":{"keywordMatch":<0-100>,"formatting":<0-100>,"relevance":<0-100>},"keywordsFound":["<k1>","<k2>","<k3>","<k4>","<k5>","<k6>"],"keywordsMissing":["<m1>","<m2>","<m3>","<m4>","<m5>","<m6>"],"tailoredResume":"<full optimized resume maintaining original structure>","suggestions":["<specific tip 1>","<specific tip 2>","<specific tip 3>","<specific tip 4>","<specific tip 5>"],"coverLetter":"<professional 3 paragraph cover letter>","jobTitle":"<extracted job title>","company":"<company name>"}
RESUME:${resume}
JOB DESCRIPTION:${jobDesc}`, 4000);
      setResults(JSON.parse(raw)); setTab("resume");
    } catch { setError("Analysis failed. Please try again."); } 
    finally { clearInterval(iv); setLoading(false); }
  };

  const handleSave = () => { if (!results) return; onSave({ id: uid(), company: results.company || "Company", jobTitle: results.jobTitle || "Role", status: "Applied", atsScore: results.atsScore, date: new Date().toISOString().split("T")[0], resume: results.tailoredResume, coverLetter: results.coverLetter }); setSaved(true); setTimeout(() => setSaved(false), 3000); };

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, letterSpacing: "-0.5px", marginBottom: 6 }}>Resume Tailor</h1>
        <p style={{ color: C.textMuted, fontSize: 15 }}>Paste or upload your resume and job description — AI optimizes your resume for ATS and writes your cover letter.</p>
      </div>
      {!results && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }} className="two-col">
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <Label>Your Resume</Label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg" style={{ display: "none" }} onChange={handleFile} />
                  <Btn variant="ghost" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => fileRef.current.click()}>📎 Upload File</Btn>
                </div>
              </div>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>Supports: PDF, DOCX, DOC, PNG, JPG, or paste text</div>
              <textarea style={{ width: "100%", minHeight: 260, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.8, padding: "14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} placeholder="Paste your resume here, or upload a file above…" value={resume} onChange={e => setResume(e.target.value)} />
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>{resume ? `${resume.split(/\s+/).filter(Boolean).length} words` : "Plain text works best for ATS scoring"}</div>
            </Card>
            <Card>
              <Label>Job Description</Label>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>Copy from LinkedIn, Indeed, or company website</div>
              <textarea style={{ width: "100%", minHeight: 260, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.8, padding: "14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} placeholder="Paste the job description here…" value={jobDesc} onChange={e => setJobDesc(e.target.value)} />
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>{jobDesc ? `${jobDesc.split(/\s+/).filter(Boolean).length} words` : "Include requirements and responsibilities for best results"}</div>
            </Card>
          </div>
          {error && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 14, color: C.red, fontSize: 13, marginBottom: 16 }}>{error}</div>}
          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <Btn onClick={analyze} style={{ padding: "13px 32px", fontSize: 15 }}>⚡ Analyze & Tailor Resume</Btn>
            <Btn variant="secondary" onClick={() => { setResume(SAMPLE_RESUME); setJobDesc(SAMPLE_JOB); }}>Try Sample</Btn>
          </div>
        </>
      )}
      {loading && <Spinner steps={RESUME_STEPS} currentStep={loadStep} />}
      {results && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.text, marginBottom: 4 }}>Analysis Complete</div>
              {results.company && <div style={{ fontSize: 14, color: C.textMuted }}>{results.jobTitle} at {results.company}</div>}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <Btn variant="green" onClick={handleSave}>{saved ? "✓ Saved!" : "💾 Save to Tracker"}</Btn>
              <Btn variant="secondary" onClick={() => { setResults(null); setResume(""); setJobDesc(""); }}>← New Analysis</Btn>
            </div>
          </div>

          {/* ATS Score Section */}
          <Card style={{ marginBottom: 20, background: `linear-gradient(135deg, ${C.purpleLight}, #fff)` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 32, flexWrap: "wrap" }}>
              <div style={{ textAlign: "center" }}>
                <ScoreRing score={results.atsScore} size={90} />
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6, fontWeight: 600 }}>Current ATS Score</div>
              </div>
              <div style={{ fontSize: 28, color: C.textMuted }}>→</div>
              <div style={{ textAlign: "center" }}>
                <div style={{ width: 90, height: 90, border: `7px solid ${C.green}`, borderRadius: "50%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                  <span style={{ fontSize: 24, fontWeight: 800, color: C.green }}>{results.potentialAtsScore || Math.min(results.atsScore + 20, 98)}+</span>
                  <span style={{ fontSize: 11, color: C.textMuted }}>/100</span>
                </div>
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6, fontWeight: 600 }}>Potential ATS Score</div>
              </div>
              <div style={{ flex: 1, minWidth: 200 }}>
                {[["Keyword Match", results.scoreBreakdown?.keywordMatch], ["Formatting", results.scoreBreakdown?.formatting], ["Relevance", results.scoreBreakdown?.relevance]].map(([l, v]) => (
                  <div key={l} style={{ marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}><span style={{ color: C.textMid, fontWeight: 500 }}>{l}</span><span style={{ fontWeight: 700, color: v >= 80 ? C.green : v >= 60 ? C.yellow : C.red }}>{v}%</span></div>
                    <PBar val={v} />
                  </div>
                ))}
              </div>
            </div>
          </Card>

          {/* Keywords */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }} className="two-col">
            <div style={{ background: C.greenLight, border: `1px solid ${C.green}25`, borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 12, color: C.green, fontWeight: 700, marginBottom: 10 }}>✓ KEYWORDS FOUND IN YOUR RESUME</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{results.keywordsFound?.map(k => <Badge key={k} color={C.green}>{k}</Badge>)}</div>
            </div>
            <div style={{ background: C.redLight, border: `1px solid ${C.red}25`, borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 12, color: C.red, fontWeight: 700, marginBottom: 10 }}>✗ MISSING KEYWORDS (ADD THESE)</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{results.keywordsMissing?.map(k => <Badge key={k} color={C.red}>{k}</Badge>)}</div>
            </div>
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", gap: 3, background: C.bgSoft, borderRadius: 10, padding: 3, marginBottom: 20 }}>
            {[["resume","✨ Tailored Resume"],["suggestions","💡 Improvement Tips"],["cover","📄 Cover Letter"]].map(([id, lbl]) => (
              <button key={id} style={{ flex: 1, padding: "10px", borderRadius: 7, border: "none", background: tab === id ? "#fff" : "transparent", color: tab === id ? C.text : C.textMuted, fontSize: 13, fontWeight: 600, cursor: "pointer", boxShadow: tab === id ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }} onClick={() => setTab(id)}>{lbl}</button>
            ))}
          </div>

          {tab === "resume" && (
            <div>
              <ContentDisplay content={results.tailoredResume} />
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <Btn variant="secondary" onClick={() => downloadPDF(results.tailoredResume, "tailored-resume")}>📄 Download PDF</Btn>
                <Btn variant="secondary" onClick={() => downloadDOCX(results.tailoredResume, "tailored-resume")}>📝 Download DOCX</Btn>
                <CopyBtn text={results.tailoredResume} label="📋 Copy Resume" />
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
          {tab === "cover" && (
            <div>
              <ContentDisplay content={results.coverLetter} />
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <Btn variant="secondary" onClick={() => downloadPDF(results.coverLetter, "cover-letter")}>📄 Download PDF</Btn>
                <Btn variant="secondary" onClick={() => downloadDOCX(results.coverLetter, "cover-letter")}>📝 Download DOCX</Btn>
                <CopyBtn text={results.coverLetter} label="📋 Copy Cover Letter" />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── JOB SEARCH ────────────────────────────────────────────
function JobSearchPage({ savedJobs, setSavedJobs, setApplications }) {
  const [filters, setFilters] = useState({ title: "", country: "United States", city: "", remote: false, employmentType: "Any", experienceLevel: "Any", salaryMin: "" });
  const [jobs, setJobs] = useState([]); const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [searched, setSearched] = useState(false); const [page, setPage] = useState(1); const [hasMore, setHasMore] = useState(false); const [analyzing, setAnalyzing] = useState(null); const [matchResults, setMatchResults] = useState({}); const [resume, setResume] = useState(""); const [showResume, setShowResume] = useState(false); const [sourceCounts, setSourceCounts] = useState(null);
  const resumeFileRef = useRef();
  const [uploadingResume, setUploadingResume] = useState(false);
  const [resumeFileName, setResumeFileName] = useState("");
  const [dragActive, setDragActive] = useState(false);

  // Shared extraction core — accepts a File object
  const extractResumeFile = async (file) => {
    if (!file) return;
    const ext = file.name.split(".").pop().toLowerCase();
    if (file.size > 5 * 1024 * 1024) { setError("File too large. Maximum size is 5MB."); return; }
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
        if (text.trim()) { setResume(text.trim()); setResumeFileName(file.name); }
        else { setError("Could not extract text from this PDF. It may be scanned/image-based — please paste your resume instead."); }
      } else if (ext === "docx" || ext === "doc" || ext === "txt") {
        const text = await file.text();
        let clean = text;
        if (ext === "docx" || ext === "doc") {
          clean = String(text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        }
        if (clean && clean.trim()) { setResume(clean.trim()); setResumeFileName(file.name); }
        else { setError("Could not read this file. Please paste your resume text instead."); }
      } else {
        setError("Unsupported file type. Please upload PDF, DOCX, or TXT.");
      }
    } catch (err) {
      setError("Could not read the file. Please paste your resume text instead.");
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
    if (!filters.title.trim()) { setError("Enter a job title to search"); return; }
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

      // Auto AI-match all jobs if resume is provided
      if (resume.trim() && newJobs.length > 0) {
        autoMatchAll(newJobs);
      }
    } catch (e) {
      setError(`Search failed: ${e.message}. Please try again.`);
    } finally {
      setLoading(false);
    }
  };

  // AI match a single job against resume
  const analyzeMatch = async (job) => {
    if (!resume.trim()) { setShowResume(true); return; }
    setAnalyzing(job.id);
    try {
      const raw = await askClaude(`Analyze resume-job match. Return ONLY valid JSON, no markdown:
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

  // Auto-match up to 5 jobs silently when resume is present
  const autoMatchAll = async (newJobs) => {
    const toMatch = newJobs.slice(0, 5);
    for (const job of toMatch) {
      try {
        const raw = await askClaude(`Match score only. Return ONLY JSON:
{"matchScore":<0-100>,"atsScore":<0-100>,"interviewProbability":<0-100>,"matchingSkills":["<s1>","<s2>"],"missingSkills":["<m1>","<m2>"],"summary":"<1 sentence>"}
RESUME:${resume.slice(0, 300)}
JOB:${job.title} at ${job.company}. ${(job.description || "").slice(0, 200)}`, 400);
        setMatchResults(prev => ({ ...prev, [job.id]: JSON.parse(raw) }));
      } catch { /* silent fail per job */ }
    }
  };

  const toggleSave = (job) => { const s = savedJobs.find(j => j.job_id === job.id); if (s) { setSavedJobs(p => p.filter(j => j.job_id !== job.id)); } else { setSavedJobs(p => [{ job_id: job.id, ...job, saved_at: new Date().toISOString() }, ...p]); } };
  const isSaved = (id) => savedJobs.some(j => j.job_id === id);
  const addTracker = (job) => setApplications(p => [{ id: uid(), company: job.company, jobTitle: job.title, status: "Applied", date: new Date().toISOString().split("T")[0], notes: "", url: job.applyUrl }, ...p]);
  const fmtSalary = (min, max) => { if (!min && !max) return "Salary not listed"; const f = n => `$${Math.round(n/1000)}K`; if (min && max) return `${f(min)} – ${f(max)}`; return min ? `${f(min)}+` : `Up to ${f(max)}`; };
  const matchColor = s => s >= 85 ? C.green : s >= 70 ? C.yellow : C.red;

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 6 }}>Job Search</h1>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24 }}>Search real jobs from multiple sources with AI-powered match scoring.</p>
      <Card style={{ marginBottom: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginBottom: 14 }} className="three-col">
          <Input label="Job Title *" placeholder="e.g. Software Engineer" value={filters.title} onChange={e => setFilters(f => ({ ...f, title: e.target.value }))} onKeyDown={e => e.key === "Enter" && search()} />
          <Select label="Country" value={filters.country} onChange={e => setFilters(f => ({ ...f, country: e.target.value }))}>
            {["United States","Canada","United Kingdom","Australia","Germany","France","Netherlands","Remote Worldwide"].map(c => <option key={c}>{c}</option>)}
          </Select>
          <Input label="City" placeholder="e.g. New York, London" value={filters.city} onChange={e => setFilters(f => ({ ...f, city: e.target.value }))} />
          <Select label="Employment Type" value={filters.employmentType} onChange={e => setFilters(f => ({ ...f, employmentType: e.target.value }))}>
            {["Any","Full-time","Part-time","Contract","Internship","Freelance"].map(t => <option key={t}>{t}</option>)}
          </Select>
          <Select label="Experience Level" value={filters.experienceLevel} onChange={e => setFilters(f => ({ ...f, experienceLevel: e.target.value }))}>
            {["Any","Entry Level","Mid Level","Senior","Lead","Executive"].map(l => <option key={l}>{l}</option>)}
          </Select>
          <Input label="Min Salary ($)" type="number" placeholder="e.g. 80000" value={filters.salaryMin} onChange={e => setFilters(f => ({ ...f, salaryMin: e.target.value }))} />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 14, color: C.textMid, fontWeight: 500 }}><input type="checkbox" checked={filters.remote} onChange={e => setFilters(f => ({ ...f, remote: e.target.checked }))} /> Remote Only</label>
          {error && <span style={{ color: C.red, fontSize: 13 }}>{error}</span>}
          <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
            <Btn variant={resume ? "green" : "secondary"} onClick={() => setShowResume(!showResume)}>📄 {resume ? "Resume Added ✓" : "Add Resume for AI Match"}</Btn>
            <Btn onClick={() => search(false)} style={{ padding: "12px 28px" }}>🔍 Search Jobs</Btn>
          </div>
        </div>
        {showResume && <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.textMid, marginBottom: 10 }}>Your Resume (for AI match scoring)</div>

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
              <div style={{ color: C.purple, fontWeight: 600, fontSize: 15 }}>⏳ Extracting text…</div>
            ) : resumeFileName ? (
              <div>
                <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: C.green, color: "#fff", padding: "5px 14px", borderRadius: 20, fontSize: 13, fontWeight: 600, marginBottom: 8 }}>✓ Resume Loaded</div>
                <div style={{ color: C.text, fontWeight: 600, fontSize: 14 }}>📄 {resumeFileName}</div>
                <div style={{ color: C.textMuted, fontSize: 12, marginTop: 4 }}>Click or drop to replace</div>
              </div>
            ) : (
              <div>
                <div style={{ fontSize: 26, marginBottom: 6 }}>⬆️</div>
                <div style={{ color: C.purple, fontWeight: 700, fontSize: 16, marginBottom: 4 }}>Upload Resume</div>
                <div style={{ color: C.textMuted, fontSize: 13 }}>Drag & drop or click to browse · PDF / DOCX / TXT (Max 5MB)</div>
              </div>
            )}
          </div>

          {/* Resume textarea */}
          <textarea style={{ width: "100%", minHeight: 180, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.7, padding: "14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} placeholder="Paste your resume, or upload a file above, to see how well you match each job…" value={resume} onChange={e => { setResume(e.target.value); if (resumeFileName) setResumeFileName(""); }} />
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>{resume ? `${resume.split(/\s+/).filter(Boolean).length} words` : "PDF and TXT extract best. For DOCX, paste text if extraction looks off."}</div>
          {resume && <Btn variant="green" style={{ marginTop: 10 }} onClick={() => setShowResume(false)}>✓ Save & Close</Btn>}
        </div>}
      </Card>

      {loading && jobs.length === 0 && <Spinner steps={["Searching Adzuna & JSearch…", "Merging and deduplicating results…", "Ranking by relevance…"]} currentStep={1} />}
      {searched && !loading && jobs.length === 0 && <Card style={{ textAlign: "center", padding: 48 }}><div style={{ fontSize: 36, marginBottom: 12 }}>🔍</div><div style={{ fontWeight: 700, fontSize: 16 }}>No results found</div><div style={{ color: C.textMuted, marginTop: 6 }}>Try different keywords or broaden your filters</div></Card>}

      {jobs.length > 0 && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 14, color: C.textMuted, fontWeight: 500 }}>
              {jobs.length} jobs found for "<strong style={{ color: C.text }}>{filters.title}</strong>"
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
                        {job.remote && <Badge color={C.green}>🌐 Remote</Badge>}
                        <Badge color={C.textMuted}>{job.employmentType}</Badge>
                        {job.experienceLevel && <Badge color={C.purple}>{job.experienceLevel}</Badge>}
                        <span style={{ marginLeft: "auto", background: `${matchColor(displayMatch)}15`, color: matchColor(displayMatch), border: `1px solid ${matchColor(displayMatch)}30`, borderRadius: 20, padding: "3px 12px", fontSize: 12, fontWeight: 800 }}>{displayMatch}% Match</span>
                      </div>
                      <div style={{ fontSize: 17, fontWeight: 800, color: C.text, marginBottom: 4 }}>{job.title}</div>
                      <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 6 }}>{job.company} · {job.location}</div>
                      <div style={{ fontSize: 14, color: C.green, fontWeight: 700, marginBottom: 10 }}>{fmtSalary(job.salaryMin, job.salaryMax)}</div>
                      <div style={{ fontSize: 13, color: C.textMid, lineHeight: 1.7, marginBottom: 10 }}>{job.description?.slice(0, 200)}…</div>
                      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 8 }}>{job.skills?.slice(0, 5).map(s => <span key={s} style={{ background: C.purpleLight, color: C.purple, borderRadius: 6, padding: "3px 9px", fontSize: 12, fontWeight: 600 }}>{s}</span>)}</div>
                      <div style={{ fontSize: 11, color: C.textMuted }}>Posted: {job.datePosted ? new Date(job.datePosted).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : "Recently"}</div>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, flexShrink: 0, minWidth: 120 }}>
                      <a href={job.applyUrl} target="_blank" rel="noreferrer" style={{ background: `linear-gradient(135deg,${C.purple},${C.purpleMid})`, color: "#fff", borderRadius: 9, padding: "10px 18px", fontSize: 14, fontWeight: 700, textDecoration: "none", textAlign: "center" }}>Apply Now →</a>
                      <Btn variant="secondary" style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => analyzeMatch(job)} disabled={analyzing === job.id}>{analyzing === job.id ? "Analyzing…" : "🤖 AI Match"}</Btn>
                      <button style={{ background: "none", border: `1.5px solid ${isSaved(job.id) ? C.red : C.border}`, borderRadius: 9, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: isSaved(job.id) ? C.red : C.textMuted }} onClick={() => toggleSave(job)}>{isSaved(job.id) ? "♥ Saved" : "♡ Save Job"}</button>
                      <button style={{ background: "none", border: `1.5px solid ${C.border}`, borderRadius: 9, padding: "8px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", color: C.textMuted }} onClick={() => addTracker(job)}>+ Track</button>
                    </div>
                  </div>
                  {mr && (
                    <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
                      <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 8 }}>{mr.summary}</div>
                      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                        {[["Match", mr.matchScore], ["ATS", mr.atsScore], ["Interview %", mr.interviewProbability]].map(([l, v]) => (
                          <div key={l} style={{ flex: 1, minWidth: 80 }}>
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}><span style={{ color: C.textMuted }}>{l}</span><span style={{ color: matchColor(v), fontWeight: 700 }}>{v}%</span></div>
                            <PBar val={v} color={matchColor(v)} />
                          </div>
                        ))}
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 10 }} className="two-col">
                        <div style={{ background: C.greenLight, borderRadius: 8, padding: 10 }}><div style={{ fontSize: 11, color: C.green, fontWeight: 700, marginBottom: 6 }}>✓ YOU HAVE</div><div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{mr.matchingSkills?.map(s => <Badge key={s} color={C.green}>{s}</Badge>)}</div></div>
                        <div style={{ background: C.redLight, borderRadius: 8, padding: 10 }}><div style={{ fontSize: 11, color: C.red, fontWeight: 700, marginBottom: 6 }}>✗ YOU NEED</div><div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{mr.missingSkills?.map(s => <Badge key={s} color={C.red}>{s}</Badge>)}</div></div>
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
                {loading ? "Loading more…" : "Load More Jobs →"}
              </Btn>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── INTERVIEW PAGE ────────────────────────────────────────
const INTERVIEW_STORAGE_KEY = "cp_interview_session_v1";

function InterviewPage() {
  const [jobDesc, setJobDesc] = useState(""); const [loading, setLoading] = useState(false); const [questions, setQuestions] = useState([]); const [activeQ, setActiveQ] = useState(null); const [answer, setAnswer] = useState(""); const [feedback, setFeedback] = useState(null); const [fbLoading, setFbLoading] = useState(false); const [filterCat, setFilterCat] = useState("All");
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

  // ── Session persistence: load on mount ──
  useEffect(() => {
    try {
      const raw = localStorage.getItem(INTERVIEW_STORAGE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s.questions?.length) {
          setQuestions(s.questions);
          setJobDesc(s.jobDesc || "");
          setResume(s.resume || "");
          setResumeFileName(s.resumeFileName || "");
          setSavedFeedback(s.savedFeedback || {});
          setMockAnswers(s.mockAnswers || {});
          setMockSummary(s.mockSummary || null);
          setMode(s.mode || "browse");
          setMockIdx(s.mockIdx || 0);
          setMockAnswerDraft(s.mockAnswerDraft || "");
          setActiveQ(s.activeQ || null);
          setShowReview(s.showReview || false);
          setRestored(true);
        }
      }
    } catch { /* ignore corrupt storage */ }
  }, []);

  // ── Session persistence: save on change ──
  useEffect(() => {
    if (!questions.length) return;
    try {
      localStorage.setItem(INTERVIEW_STORAGE_KEY, JSON.stringify({
        questions, jobDesc, resume, resumeFileName, savedFeedback, mockAnswers, mockSummary,
        mode, mockIdx, mockAnswerDraft, activeQ, showReview,
      }));
    } catch { /* quota or disabled — non-fatal */ }
  }, [questions, jobDesc, resume, resumeFileName, savedFeedback, mockAnswers, mockSummary, mode, mockIdx, mockAnswerDraft, activeQ, showReview]);

  const clearSession = () => {
    try { localStorage.removeItem(INTERVIEW_STORAGE_KEY); } catch {}
    setQuestions([]); setJobDesc(""); setActiveQ(null); setFeedback(null);
    setSavedFeedback({}); setMockAnswers({}); setMockSummary(null); setMode("browse"); setShowReview(false);
    setMockIdx(0); setRestored(false); setError("");
  };

  // ── Resume upload (PDF/DOCX/TXT) — local to Interview page ──
  const extractResumeFile = async (file) => {
    if (!file) return;
    const ext = file.name.split(".").pop().toLowerCase();
    if (file.size > 5 * 1024 * 1024) { setError("File too large. Maximum size is 5MB."); return; }
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
        else setError("Could not extract text from this PDF. It may be scanned — please paste instead.");
      } else if (["docx","doc","txt"].includes(ext)) {
        const text = await file.text();
        let clean = (ext === "txt") ? text : String(text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        if (clean && clean.trim()) { setResume(clean.trim()); setResumeFileName(file.name); }
        else setError("Could not read this file. Please paste your resume text instead.");
      } else setError("Unsupported file type. Please upload PDF, DOCX, or TXT.");
    } catch { setError("Could not read the file. Please paste your resume text instead."); }
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
    if (!jobDesc.trim()) { setError("Please paste a job description first."); return; }
    setLoading(true); setQuestions([]); setError("");
    try {
      const resumeBlock = resume.trim() ? `\nCANDIDATE RESUME (tailor questions to this background):\n${resume.slice(0, 1000)}` : "";
      const raw = await askClaude(`You are an expert interview coach. Generate 8 interview questions for the job below. Mix Behavioral, Technical, Situational, and Culture Fit. For Behavioral, tipToAnswer must reference STAR (Situation, Task, Action, Result). Keep every answer field to 2-3 sentences MAX to stay concise. Return ONLY a JSON array, no markdown:
[{"id":1,"category":"Behavioral|Technical|Situational|Culture Fit","difficulty":"Easy|Medium|Hard","question":"<question>","whyAsked":"<1 sentence>","tipToAnswer":"<1-2 sentences; STAR for behavioral>","strongAnswer":"<2-3 sentences>","weakAnswer":"<1-2 sentences>","aiRecommendedAnswer":"<2-3 sentences>","star":true}]
JOB:
${jobDesc.slice(0, 2500)}${resumeBlock}`, 8000);
      const parsed = safeParse(raw);
      if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
        setError("Could not generate questions (the AI response was invalid). Please try again.");
      } else {
        setQuestions(parsed);
        setRestored(false);
      }
    } catch (e) {
      setError(`Generation failed: ${e.message || "please try again."}`);
    } finally { setLoading(false); }
  };

  // ── Feedback for a single answer (now includes JD + resume context) ──
  const getFeedbackFor = async (question, ans) => {
    const resumeBlock = resume.trim() ? `\nCANDIDATE BACKGROUND:${resume.slice(0, 600)}` : "";
    const jdBlock = jobDesc.trim() ? `\nJOB CONTEXT:${jobDesc.slice(0, 600)}` : "";
    const raw = await askClaude(`You are an interview coach. Rate this practice answer for the given question and role. Return ONLY JSON:
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
      setError("Could not analyze your answer. Please try again.");
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
      setError("Could not score that answer. Please try again.");
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
      <div style={{ fontSize: 12, color: C.purple, fontWeight: 700, marginBottom: 10 }}>⭐ STAR FRAMEWORK — use this structure for your answer</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }} className="two-col">
        {[["S — Situation","Describe the context and circumstances."],["T — Task","Explain your responsibility or goal."],["A — Action","Describe the specific steps you took."],["R — Result","Explain the outcome and impact."]].map(([h, d]) => (
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
          <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 6 }}>Interview Prep <span style={{ fontSize: 11, color: C.green, fontWeight: 600 }}>v11</span></h1>
          <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24 }}>AI generates tailored questions with strong, weak, and AI-recommended answers.</p>
        </div>
        {questions.length > 0 && <Btn variant="secondary" onClick={clearSession}>🗑 Clear Session</Btn>}
      </div>

      {restored && questions.length > 0 && (
        <div style={{ background: C.purpleLight, border: `1px solid ${C.purple}30`, borderRadius: 9, padding: "10px 14px", color: C.purple, fontSize: 13, marginBottom: 16 }}>
          ↻ Restored your previous session ({questions.length} questions). <span style={{ textDecoration: "underline", cursor: "pointer" }} onClick={clearSession}>Start fresh</span>
        </div>
      )}

      {error && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 14, color: C.red, fontSize: 13, marginBottom: 16 }}>{error}</div>}

      {/* SETUP */}
      {!questions.length && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, marginBottom: 20 }}>
          <Card style={{ width: "100%" }}>
            <Textarea label="Job Description *" placeholder="Paste the full job description here to generate tailored interview questions…" value={jobDesc} onChange={e => setJobDesc(e.target.value)} style={{ minHeight: 220, width: "100%" }} />
            <div style={{ marginTop: 14 }}>
              <Btn variant={resume ? "green" : "secondary"} onClick={() => setShowResume(!showResume)}>📄 {resume ? "Resume Added ✓" : "Add Resume (optional, personalizes questions)"}</Btn>
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
                  {uploadingResume ? <span style={{ color: C.purple, fontWeight: 600 }}>⏳ Extracting…</span>
                    : resumeFileName ? <span><span style={{ background: C.green, color: "#fff", padding: "4px 12px", borderRadius: 20, fontSize: 13, fontWeight: 600 }}>✓ Resume Loaded</span> <span style={{ display: "block", marginTop: 8, color: C.text, fontWeight: 600 }}>📄 {resumeFileName}</span></span>
                    : <span><span style={{ color: C.purple, fontWeight: 700, fontSize: 15 }}>⬆️ Upload Resume</span><br/><span style={{ color: C.textMuted, fontSize: 13 }}>Drag & drop or click · PDF / DOCX / TXT</span></span>}
                </div>
                <textarea style={{ width: "100%", minHeight: 120, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.7, padding: "14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} placeholder="…or paste your resume here" value={resume} onChange={e => { setResume(e.target.value); if (resumeFileName) setResumeFileName(""); }} />
              </div>
            )}
          </Card>
          <div style={{ display: "flex", gap: 10 }}>
            <Btn onClick={generate} disabled={!jobDesc.trim() || loading} style={{ padding: "13px 28px" }}>🎤 Generate 8 Questions</Btn>
            <Btn variant="secondary" onClick={() => setJobDesc(SAMPLE_JOB)}>Try Sample</Btn>
          </div>
        </div>
      )}

      {loading && <Spinner steps={["Analyzing job requirements…","Generating behavioral questions…","Creating technical questions…","Adding sample answers…"]} currentStep={1} />}

      {/* MODE SWITCH */}
      {questions.length > 0 && !activeQ && mode === "browse" && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 10 }}>
            <div style={{ fontWeight: 700, color: C.text, fontSize: 16 }}>{questions.length} Questions Generated</div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>{cats.map(c => <button key={c} style={{ padding: "6px 14px", borderRadius: 8, border: `1.5px solid ${filterCat === c ? C.purple : C.border}`, background: filterCat === c ? C.purpleLight : "#fff", color: filterCat === c ? C.purple : C.textMuted, fontSize: 13, fontWeight: 600, cursor: "pointer" }} onClick={() => setFilterCat(c)}>{c}</button>)}</div>
            <Btn onClick={startMock} style={{ padding: "8px 18px" }}>▶ Start Mock Interview</Btn>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {filtered.map((q, i) => (
              <Card key={q.id} style={{ cursor: "pointer", userSelect: "none" }} onClick={() => { setActiveQ(q); const sv = savedFeedback[q.id]; setAnswer(sv?.answer || ""); setFeedback(sv?.feedback || null); setAnswerTab("strong"); }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}><Badge color={C.purple}>{q.category}</Badge><Badge color={diffColor[q.difficulty]}>{q.difficulty}</Badge>{q.star && <Badge color={C.blue}>STAR</Badge>}{savedFeedback[q.id] && <Badge color={C.green}>✓ Practiced ({savedFeedback[q.id].feedback?.score}/10)</Badge>}</div>
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
            <Btn variant="secondary" onClick={() => { setMode("browse"); setMockSummary(null); setShowReview(false); }}>← Exit Mock</Btn>
            {!mockSummary && <div style={{ fontWeight: 700, color: C.text }}>Question {mockIdx + 1} of {mockQuestions.length}</div>}
          </div>

          {!mockSummary && (
            <Card>
              <div style={{ display: "flex", gap: 6, marginBottom: 14 }}><Badge color={C.purple}>{mockQuestions[mockIdx].category}</Badge><Badge color={diffColor[mockQuestions[mockIdx].difficulty]}>{mockQuestions[mockIdx].difficulty}</Badge></div>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.text, lineHeight: 1.4, marginBottom: 8 }}>{mockQuestions[mockIdx].question}</div>
              <div style={{ height: 6, background: C.bgSoft, borderRadius: 4, marginBottom: 20, overflow: "hidden" }}><div style={{ width: `${((mockIdx) / mockQuestions.length) * 100}%`, height: "100%", background: C.purple }} /></div>
              {isBehavioral(mockQuestions[mockIdx]) && <StarCard />}
              <Textarea label="Your answer" placeholder="Answer as if you're in a real interview…" value={mockAnswerDraft} onChange={e => setMockAnswerDraft(e.target.value)} style={{ minHeight: 160, width: "100%", marginBottom: 14 }} />
              <div style={{ display: "flex", gap: 10 }}>
                <Btn onClick={submitMockAnswer} disabled={!mockAnswerDraft.trim() || mockLoading}>{mockLoading ? "Scoring…" : (mockIdx + 1 < mockQuestions.length ? "Submit & Next →" : "Submit & Finish")}</Btn>
                <Btn variant="secondary" onClick={skipMock} disabled={mockLoading}>Skip</Btn>
              </div>
            </Card>
          )}

          {mockSummary && !showReview && (
            <Card style={{ textAlign: "center", padding: 40 }}>
              <div style={{ fontSize: 22, fontWeight: 800, color: C.text, marginBottom: 8 }}>Mock Interview Complete 🎉</div>
              <div style={{ fontSize: 48, fontWeight: 800, color: mockSummary.avgScore >= 8 ? C.green : mockSummary.avgScore >= 6 ? C.yellow : C.red, marginBottom: 4 }}>{mockSummary.avgScore}/10</div>
              <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 18 }}>Average score across {mockSummary.answered} answered question{mockSummary.answered !== 1 ? "s" : ""}</div>
              <div style={{ display: "flex", gap: 20, justifyContent: "center", marginBottom: 24 }}>
                <div><div style={{ fontSize: 24, fontWeight: 800, color: C.green }}>{mockSummary.answered}</div><div style={{ fontSize: 12, color: C.textMuted }}>Answered</div></div>
                <div><div style={{ fontSize: 24, fontWeight: 800, color: C.yellow }}>{mockSummary.skipped}</div><div style={{ fontSize: 12, color: C.textMuted }}>Skipped</div></div>
                <div><div style={{ fontSize: 24, fontWeight: 800, color: C.text }}>{mockSummary.total}</div><div style={{ fontSize: 12, color: C.textMuted }}>Total</div></div>
                <div><div style={{ fontSize: 24, fontWeight: 800, color: C.purple }}>{mockSummary.total ? Math.round((mockSummary.answered / mockSummary.total) * 100) : 0}%</div><div style={{ fontSize: 12, color: C.textMuted }}>Complete</div></div>
              </div>
              <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
                <Btn onClick={() => setShowReview(true)}>📋 Review Your Answers</Btn>
                <Btn variant="secondary" onClick={() => { setMockIdx(0); setMockSummary(null); setMockAnswers({}); setShowReview(false); }}>Retry Mock</Btn>
              </div>
            </Card>
          )}

          {mockSummary && showReview && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <div style={{ fontSize: 20, fontWeight: 800, color: C.text }}>Interview Review</div>
                <Btn variant="secondary" onClick={() => setShowReview(false)}>← Back to Summary</Btn>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {mockQuestions.map((q, i) => {
                  const ans = mockAnswers[q.id];
                  return (
                    <Card key={q.id}>
                      <div style={{ display: "flex", gap: 6, marginBottom: 8, flexWrap: "wrap" }}>
                        <Badge color={C.purple}>{q.category}</Badge>
                        <Badge color={diffColor[q.difficulty]}>{q.difficulty}</Badge>
                        {ans ? <Badge color={C.green}>✓ Answered {ans.feedback?.score ? `(${ans.feedback.score}/10)` : ""}</Badge> : <Badge color={C.textMuted}>⊘ Skipped</Badge>}
                      </div>
                      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 10, lineHeight: 1.4 }}>Q{i + 1}. {q.question}</div>
                      {ans ? (
                        <div>
                          <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, marginBottom: 4 }}>YOUR ANSWER</div>
                          <div style={{ background: C.bgSoft, borderRadius: 8, padding: "12px 14px", fontSize: 14, lineHeight: 1.7, color: C.text, whiteSpace: "pre-wrap", marginBottom: ans.feedback ? 12 : 0 }}>{ans.answer}</div>
                          {ans.feedback && (
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }} className="two-col">
                              <div style={{ background: C.greenLight, borderRadius: 8, padding: 12 }}><div style={{ fontSize: 11, color: C.green, fontWeight: 700, marginBottom: 6 }}>✓ STRENGTHS</div>{(ans.feedback.strengths || []).map((s, j) => <div key={j} style={{ fontSize: 12, color: C.text, marginBottom: 4, lineHeight: 1.5 }}>• {s}</div>)}</div>
                              <div style={{ background: C.yellowLight, borderRadius: 8, padding: 12 }}><div style={{ fontSize: 11, color: C.yellow, fontWeight: 700, marginBottom: 6 }}>↑ IMPROVE</div>{(ans.feedback.improvements || []).map((s, j) => <div key={j} style={{ fontSize: 12, color: C.text, marginBottom: 4, lineHeight: 1.5 }}>• {s}</div>)}</div>
                            </div>
                          )}
                        </div>
                      ) : (
                        <div style={{ fontSize: 13, color: C.textMuted, fontStyle: "italic" }}>You skipped this question. The strong answer was: </div>
                      )}
                      {!ans && <div style={{ background: C.bgSoft, borderRadius: 8, padding: "12px 14px", fontSize: 14, lineHeight: 1.7, color: C.text, whiteSpace: "pre-wrap", marginTop: 6 }}>{q.strongAnswer}</div>}
                    </Card>
                  );
                })}
              </div>
              <div style={{ display: "flex", gap: 10, marginTop: 18 }}>
                <Btn variant="secondary" onClick={() => { setMode("browse"); setMockSummary(null); setShowReview(false); }}>← Back to Question List</Btn>
                <Btn onClick={() => { setMockIdx(0); setMockSummary(null); setMockAnswers({}); setShowReview(false); }}>Retry Mock</Btn>
              </div>
            </div>
          )}
        </div>
      )}

      {/* SINGLE QUESTION DETAIL */}
      {activeQ && (
        <div>
          <Btn variant="secondary" style={{ marginBottom: 18 }} onClick={() => { setActiveQ(null); setFeedback(null); }}>← Back to Questions</Btn>
          <Card>
            <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}><Badge color={C.purple}>{activeQ.category}</Badge><Badge color={diffColor[activeQ.difficulty]}>{activeQ.difficulty}</Badge>{activeQ.star && <Badge color={C.blue}>STAR</Badge>}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.text, lineHeight: 1.4, marginBottom: 20 }}>{activeQ.question}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }} className="two-col">
              <div style={{ background: C.blueLight, borderRadius: 12, padding: 16 }}><div style={{ fontSize: 11, color: C.blue, fontWeight: 700, marginBottom: 8 }}>WHY THEY ASK THIS</div><div style={{ fontSize: 14, lineHeight: 1.7, color: C.text }}>{activeQ.whyAsked}</div></div>
              <div style={{ background: C.yellowLight, borderRadius: 12, padding: 16 }}><div style={{ fontSize: 11, color: C.yellow, fontWeight: 700, marginBottom: 8 }}>💡 HOW TO ANSWER {activeQ.star ? "(STAR)" : ""}</div><div style={{ fontSize: 14, lineHeight: 1.7, color: C.text }}>{activeQ.tipToAnswer}</div></div>
            </div>

            {isBehavioral(activeQ) && <StarCard />}

            <div style={{ marginBottom: 24 }}>
              <div style={{ display: "flex", gap: 3, background: C.bgSoft, borderRadius: 10, padding: 3, marginBottom: 14 }}>
                {[["strong","💪 Strong Answer"],["weak","❌ Weak Answer"],["ai","✨ AI Recommended"]].map(([id, lbl]) => (
                  <button key={id} style={{ flex: 1, padding: "9px", borderRadius: 7, border: "none", background: answerTab === id ? "#fff" : "transparent", color: answerTab === id ? C.text : C.textMuted, fontSize: 13, fontWeight: 600, cursor: "pointer" }} onClick={() => setAnswerTab(id)}>{lbl}</button>
                ))}
              </div>
              {answerTab === "strong" && <div><ContentDisplay content={activeQ.strongAnswer} /><div style={{ marginTop: 8 }}><CopyBtn text={activeQ.strongAnswer} label="📋 Copy Strong Answer" /></div></div>}
              {answerTab === "weak" && <div style={{ background: C.redLight, border: `1px solid ${C.red}25`, borderRadius: 12, padding: "16px 20px" }}><div style={{ fontSize: 12, color: C.red, fontWeight: 700, marginBottom: 10 }}>⚠️ COMMON WEAK ANSWER — AVOID THIS</div><div style={{ fontSize: 14, lineHeight: 1.8, color: C.text, whiteSpace: "pre-wrap" }}>{activeQ.weakAnswer}</div></div>}
              {answerTab === "ai" && <div><div style={{ background: `linear-gradient(135deg, ${C.purpleLight}, #fff)`, border: `1px solid ${C.purple}25`, borderRadius: 12, padding: "16px 20px" }}><div style={{ fontSize: 12, color: C.purple, fontWeight: 700, marginBottom: 10 }}>✨ AI-OPTIMIZED ANSWER THAT STANDS OUT</div><div style={{ fontSize: 14, lineHeight: 1.8, color: C.text, whiteSpace: "pre-wrap" }}>{activeQ.aiRecommendedAnswer}</div></div><div style={{ marginTop: 8 }}><CopyBtn text={activeQ.aiRecommendedAnswer} label="📋 Copy AI Answer" /></div></div>}
            </div>

            <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 20 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: C.text, marginBottom: 12 }}>🎯 Practice Your Answer</div>
              <Textarea label="Type your answer here" placeholder="Write your answer and get instant AI coaching…" value={answer} onChange={e => setAnswer(e.target.value)} style={{ minHeight: 180, marginBottom: 16, width: "100%" }} />
              <Btn onClick={getFeedback} disabled={!answer.trim() || fbLoading}>{fbLoading ? "Analyzing…" : "🧠 Get AI Feedback"}</Btn>
            </div>

            {fbLoading && <Spinner steps={["Reading your answer…","Identifying strengths…","Generating improvements…"]} currentStep={1} />}
            {feedback && !fbLoading && (
              <div style={{ marginTop: 20 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
                  <span style={{ fontSize: 14, color: C.textMuted }}>Your Answer Score</span>
                  <span style={{ fontSize: 36, fontWeight: 800, color: feedback.score >= 8 ? C.green : feedback.score >= 6 ? C.yellow : C.red }}>{feedback.score}/10</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }} className="two-col">
                  <div style={{ background: C.greenLight, borderRadius: 12, padding: 16 }}><div style={{ fontSize: 11, color: C.green, fontWeight: 700, marginBottom: 8 }}>✓ STRENGTHS</div>{feedback.strengths?.map((s, i) => <div key={i} style={{ fontSize: 13, marginBottom: 6, color: C.text, lineHeight: 1.5 }}>• {s}</div>)}</div>
                  <div style={{ background: C.yellowLight, borderRadius: 12, padding: 16 }}><div style={{ fontSize: 11, color: C.yellow, fontWeight: 700, marginBottom: 8 }}>↑ IMPROVE</div>{feedback.improvements?.map((s, i) => <div key={i} style={{ fontSize: 13, marginBottom: 6, color: C.text, lineHeight: 1.5 }}>• {s}</div>)}</div>
                </div>
                {feedback.revisedAnswer && <div><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}><div style={{ fontSize: 12, color: C.purple, fontWeight: 700 }}>✨ STRONGER VERSION OF YOUR ANSWER</div><CopyBtn text={feedback.revisedAnswer} /></div><ContentDisplay content={feedback.revisedAnswer} /></div>}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

// ─── TRACKER PAGE ──────────────────────────────────────────
const STATUSES = ["Saved","Applied","Phone Screen","Interview","Final Interview","Offer","Rejected","Withdrawn","Ghosted"];
const SCOLOR = { Saved: C.textMuted, Applied: C.blue, "Phone Screen": C.yellow, Interview: C.purple, "Final Interview": "#7C3AED", Offer: C.green, Rejected: C.red, Withdrawn: "#9333EA", Ghosted: C.textMuted };

function TrackerPage({ applications, setApplications }) {
  const [showForm, setShowForm] = useState(false); const [editId, setEditId] = useState(null); const [form, setForm] = useState({ company: "", jobTitle: "", status: "Applied", date: new Date().toISOString().split("T")[0], atsScore: "", notes: "", url: "", followUpDate: "", contactName: "", contactEmail: "" }); const [filterStatus, setFilterStatus] = useState("All"); const [viewApp, setViewApp] = useState(null);
  const [formErrors, setFormErrors] = useState({});
  const [search, setSearch] = useState("");

  const blankForm = { company: "", jobTitle: "", status: "Applied", date: new Date().toISOString().split("T")[0], atsScore: "", notes: "", url: "", followUpDate: "", contactName: "", contactEmail: "" };

  const save = () => {
    const errors = {};
    if (!form.company.trim()) errors.company = "Company is required.";
    if (!form.jobTitle.trim()) errors.jobTitle = "Job title is required.";
    let atsClean = form.atsScore;
    if (form.atsScore !== "" && form.atsScore !== null) {
      const n = Number(form.atsScore);
      if (isNaN(n)) errors.atsScore = "ATS score must be a number.";
      else if (n < 0 || n > 100) errors.atsScore = "ATS score must be between 0 and 100.";
      else atsClean = String(Math.round(n));
    }
    if (form.date && form.followUpDate && form.followUpDate < form.date) {
      errors.followUpDate = "Follow-up date can't be before the application date.";
    }
    const dupe = applications.find(a =>
      a.id !== editId &&
      (a.company || "").trim().toLowerCase() === form.company.trim().toLowerCase() &&
      (a.jobTitle || "").trim().toLowerCase() === form.jobTitle.trim().toLowerCase()
    );
    if (dupe) errors.company = `You already have an application for "${form.jobTitle}" at "${form.company}".`;

    if (Object.keys(errors).length > 0) { setFormErrors(errors); return; }
    setFormErrors({});

    const cleanForm = { ...form, atsScore: atsClean };
    if (editId) {
      setApplications(p => p.map(a => a.id === editId ? { ...a, ...cleanForm } : a));
      setEditId(null);
    } else {
      setApplications(p => [{ ...cleanForm, id: uid() }, ...p]);
    }
    setForm(blankForm);
    setShowForm(false);
  };

  const del = id => { setApplications(p => p.filter(a => a.id !== id)); if (viewApp?.id === id) setViewApp(null); };
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

  const today = new Date().toISOString().split("T")[0];
  const loadSampleData = () => {
    const samples = [
      { company: "Google", jobTitle: "Software Engineer", status: "Applied", atsScore: "88" },
      { company: "Microsoft", jobTitle: "Frontend Engineer", status: "Interview", atsScore: "82" },
      { company: "Amazon", jobTitle: "SDE II", status: "Final Interview", atsScore: "79" },
      { company: "Apple", jobTitle: "iOS Engineer", status: "Offer", atsScore: "91" },
      { company: "Meta", jobTitle: "Product Engineer", status: "Rejected", atsScore: "74" },
    ].map(s => ({ ...s, id: uid(), date: today, notes: "Sample application for testing.", url: "", followUpDate: "", contactName: "", contactEmail: "", _sample: true }));
    // Avoid adding duplicates of the sample set
    setApplications(p => {
      const existing = new Set(p.map(a => `${(a.company||"").toLowerCase()}|${(a.jobTitle||"").toLowerCase()}`));
      const toAdd = samples.filter(s => !existing.has(`${s.company.toLowerCase()}|${s.jobTitle.toLowerCase()}`));
      return [...toAdd, ...p];
    });
  };
  const clearSamples = () => setApplications(p => p.filter(a => !a._sample));

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 10 }}>
        <div><h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 4 }}>Application Tracker</h1><p style={{ color: C.textMuted, fontSize: 15 }}>{applications.length} applications tracked</p></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {applications.some(a => a._sample) && <Btn variant="secondary" onClick={clearSamples} style={{ padding: "12px 18px" }}>🗑 Clear Samples</Btn>}
          <Btn variant="secondary" onClick={loadSampleData} style={{ padding: "12px 18px" }}>🧪 Load Sample Data</Btn>
          <Btn onClick={() => { setShowForm(true); setEditId(null); }} style={{ padding: "12px 24px" }}>+ Add Application</Btn>
        </div>
      </div>
      {applications.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 16, overflowX: "auto", paddingBottom: 4 }}>
          <div style={{ background: `${C.purple}12`, border: `1.5px solid ${C.purple}30`, borderRadius: 12, padding: "10px 18px", flexShrink: 0, textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 800, color: C.purple }}>{applications.length}</div><div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>Total</div></div>
          {STATUSES.filter(s => stats[s] > 0).map(s => <div key={s} style={{ background: `${SCOLOR[s]}12`, border: `1.5px solid ${SCOLOR[s]}30`, borderRadius: 12, padding: "10px 18px", flexShrink: 0, textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 800, color: SCOLOR[s] }}>{stats[s]}</div><div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{s}</div></div>)}
          {successRate !== null && <div style={{ background: `${C.green}12`, border: `1.5px solid ${C.green}40`, borderRadius: 12, padding: "10px 18px", flexShrink: 0, textAlign: "center" }}><div style={{ fontSize: 22, fontWeight: 800, color: C.green }}>{successRate}%</div><div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>Success Rate</div></div>}
        </div>
      )}
      {applications.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Search by company or job title…" style={{ width: "100%", border: `1.5px solid ${C.border}`, borderRadius: 9, padding: "10px 14px", fontSize: 14, outline: "none", boxSizing: "border-box", fontFamily: "inherit" }} />
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}>
        {["All", ...STATUSES].map(s => <button key={s} style={{ padding: "6px 14px", borderRadius: 8, border: `1.5px solid ${filterStatus === s ? SCOLOR[s] || C.purple : C.border}`, background: filterStatus === s ? `${SCOLOR[s] || C.purple}12` : "#fff", color: filterStatus === s ? SCOLOR[s] || C.purple : C.textMuted, fontSize: 12, fontWeight: 600, cursor: "pointer" }} onClick={() => setFilterStatus(s)}>{s}</button>)}
      </div>
      {showForm && (
        <Card style={{ marginBottom: 20, border: `1.5px solid ${C.purple}30` }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 18 }}>{editId ? "Edit" : "Add"} Application</div>
          {Object.keys(formErrors).length > 0 && (
            <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: "10px 14px", marginBottom: 14, color: C.red, fontSize: 13 }}>
              {Object.values(formErrors).map((e, i) => <div key={i}>• {e}</div>)}
            </div>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }} className="two-col">
            <div><Input label="Company *" placeholder="Google, Meta, Stripe…" value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value }))} style={formErrors.company ? { borderColor: C.red } : {}} />{formErrors.company && <div style={{ fontSize: 12, color: C.red, marginTop: 4 }}>{formErrors.company}</div>}</div>
            <div><Input label="Job Title *" placeholder="Senior Engineer" value={form.jobTitle} onChange={e => setForm(f => ({ ...f, jobTitle: e.target.value }))} style={formErrors.jobTitle ? { borderColor: C.red } : {}} />{formErrors.jobTitle && <div style={{ fontSize: 12, color: C.red, marginTop: 4 }}>{formErrors.jobTitle}</div>}</div>
            <Select label="Status" value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>{STATUSES.map(s => <option key={s}>{s}</option>)}</Select>
            <Input label="Date Applied" type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
            <div><Input label="Follow-up Date" type="date" value={form.followUpDate} onChange={e => setForm(f => ({ ...f, followUpDate: e.target.value }))} style={formErrors.followUpDate ? { borderColor: C.red } : {}} />{formErrors.followUpDate && <div style={{ fontSize: 12, color: C.red, marginTop: 4 }}>{formErrors.followUpDate}</div>}</div>
            <div><Input label="ATS Score (0-100)" type="number" min="0" max="100" placeholder="82" value={form.atsScore} onChange={e => setForm(f => ({ ...f, atsScore: e.target.value }))} style={formErrors.atsScore ? { borderColor: C.red } : {}} />{formErrors.atsScore && <div style={{ fontSize: 12, color: C.red, marginTop: 4 }}>{formErrors.atsScore}</div>}</div>
            <Input label="Contact Name" placeholder="Recruiter name" value={form.contactName} onChange={e => setForm(f => ({ ...f, contactName: e.target.value }))} />
            <Input label="Contact Email" placeholder="recruiter@company.com" value={form.contactEmail} onChange={e => setForm(f => ({ ...f, contactEmail: e.target.value }))} />
            <div style={{ gridColumn: "1 / -1" }}><Input label="Job URL" placeholder="https://linkedin.com/jobs/…" value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} /></div>
          </div>
          <div style={{ marginBottom: 16 }}><Textarea label="Notes" placeholder="Interview notes, follow-up tasks, salary discussed…" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} style={{ minHeight: 200 }} /></div>
          <div style={{ display: "flex", gap: 10 }}><Btn onClick={save}>💾 Save Application</Btn><Btn variant="secondary" onClick={closeForm}>Cancel</Btn></div>
        </Card>
      )}
      {filtered.length === 0 && !showForm && <Card style={{ textAlign: "center", padding: 56 }}><div style={{ fontSize: 40, marginBottom: 14 }}>📋</div><div style={{ fontWeight: 700, fontSize: 16, color: C.text, marginBottom: 6 }}>{applications.length === 0 ? "No applications yet" : "No matches found"}</div><div style={{ fontSize: 14, color: C.textMuted }}>{applications.length === 0 ? "Add one manually or save from Resume Tailor" : "Try a different search or filter"}</div></Card>}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {filtered.map(app => (
          <div key={app.id} style={{ background: "#fff", border: `1px solid ${C.border}`, borderRadius: 14, padding: "16px 20px", boxShadow: "0 1px 4px rgba(0,0,0,0.04)" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{app.jobTitle || "Untitled Role"}</div>
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>{app.company || "Unknown Company"}{app.date ? ` · Applied ${app.date}` : ""}</div>
                {app.followUpDate && <div style={{ fontSize: 12, color: C.yellow, marginTop: 3, fontWeight: 500 }}>⏰ Follow up: {app.followUpDate}</div>}
                {app.contactName && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>👤 {app.contactName}{app.contactEmail ? ` · ${app.contactEmail}` : ""}</div>}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {app.atsScore > 0 && <span style={{ fontSize: 12, color: C.blue, fontWeight: 700, background: C.blueLight, padding: "3px 9px", borderRadius: 6 }}>ATS {app.atsScore}</span>}
                <Badge color={SCOLOR[app.status] || C.textMuted}>{app.status || "Unknown"}</Badge>
                {(app.resume || app.coverLetter || app.notes) && <Btn variant="ghost" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => setViewApp(viewApp?.id === app.id ? null : app)}>📄 View</Btn>}
                {app.url && <a href={app.url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: C.blue, padding: "5px 10px", border: `1px solid ${C.border}`, borderRadius: 7, textDecoration: "none" }}>🔗 Job</a>}
                <Btn variant="ghost" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => edit(app)}>Edit</Btn>
                <Btn variant="danger" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => del(app.id)}>✕</Btn>
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
          {viewApp.resume && <div style={{ marginBottom: 16 }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><Label>Tailored Resume</Label><div style={{ display: "flex", gap: 6 }}><Btn variant="ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => downloadPDF(viewApp.resume, "resume")}>📄 PDF</Btn><CopyBtn text={viewApp.resume} label="📋 Copy" /></div></div><ContentDisplay content={viewApp.resume} /></div>}
          {viewApp.coverLetter && <div style={{ marginBottom: 16 }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><Label>Cover Letter</Label><div style={{ display: "flex", gap: 6 }}><Btn variant="ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => downloadPDF(viewApp.coverLetter, "cover-letter")}>📄 PDF</Btn><CopyBtn text={viewApp.coverLetter} label="📋 Copy" /></div></div><ContentDisplay content={viewApp.coverLetter} /></div>}
          {viewApp.notes && <div><Label>Notes</Label><div style={{ fontSize: 14, lineHeight: 1.7, color: C.text, padding: "12px 0" }}>{viewApp.notes}</div></div>}
        </Card>
      )}
    </div>
  );
}

// ─── SALARY PAGE ───────────────────────────────────────────
function SalaryPage() {
  const [form, setForm] = useState({ jobTitle: "", location: "", experience: "", skills: "", company: "" });
  const [loading, setLoading] = useState(false); const [results, setResults] = useState(null); const [error, setError] = useState("");
  const fmt = n => n ? `$${Number(n).toLocaleString()}` : "—";

  const analyze = async () => {
    if (!form.jobTitle || !form.location) { setError("Job title and location are required."); return; }
    setError(""); setLoading(true); setResults(null);
    try {
      const raw = await askClaude(`2026 salary data. Return ONLY JSON:
{"salaryRange":{"low":<n>,"median":<n>,"high":<n>},"totalComp":{"median":<n>},"equityRange":"<range>","bonusRange":"<range>","topPayingCompanies":[{"name":"<co>","avgComp":"<c>"},{"name":"<co>","avgComp":"<c>"},{"name":"<co>","avgComp":"<c>"}],"salaryByExperience":[{"level":"Entry","salary":<n>},{"level":"Mid","salary":<n>},{"level":"Senior","salary":<n>}],"negotiationTips":["<t1>","<t2>","<t3>"],"marketOutlook":"<2 sentence outlook>","skillPremiums":[{"skill":"<s>","premium":"<p>"},{"skill":"<s>","premium":"<p>"}],"benchmarkInsight":"<1 sentence>","demandLevel":"<High|Medium|Low>","jobOpenings":"<estimate>"}
${form.jobTitle} in ${form.location}, ${form.experience} exp, skills: ${form.skills}`, 1500);
      setResults(JSON.parse(raw));
    } catch { setError("Failed to get salary data. Please try again."); } finally { setLoading(false); }
  };

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 6 }}>Salary Insights</h1>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24 }}>Know your market value before you negotiate — powered by 2026 compensation data.</p>
      <Card style={{ marginBottom: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }} className="two-col">
          <Input label="Job Title *" placeholder="Senior Frontend Engineer" value={form.jobTitle} onChange={e => setForm(f => ({ ...f, jobTitle: e.target.value }))} />
          <Input label="Location *" placeholder="San Francisco, CA" value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} />
          <Input label="Years of Experience" placeholder="4 years" value={form.experience} onChange={e => setForm(f => ({ ...f, experience: e.target.value }))} />
          <Input label="Key Skills" placeholder="React, TypeScript, AWS" value={form.skills} onChange={e => setForm(f => ({ ...f, skills: e.target.value }))} />
          <div style={{ gridColumn: "1 / -1" }}><Input label="Company Type (optional)" placeholder="FAANG, startup, mid-size company…" value={form.company} onChange={e => setForm(f => ({ ...f, company: e.target.value }))} /></div>
        </div>
        {error && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, color: C.red, fontSize: 13, marginBottom: 14 }}>{error}</div>}
        <Btn onClick={analyze} style={{ padding: "13px 28px" }}>💰 Get Salary Data</Btn>
      </Card>
      {loading && <Spinner steps={["Researching market rates…","Analyzing compensation data…","Calculating skill premiums…"]} currentStep={1} />}
      {results && (
        <div>
          <Card style={{ marginBottom: 16, background: `linear-gradient(135deg, ${C.purpleLight}, #fff)`, border: `1.5px solid ${C.purple}20` }}>
            <div style={{ fontSize: 14, color: C.purple, fontWeight: 600, marginBottom: 16 }}>{results.benchmarkInsight}</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 0, borderBottom: `1px solid ${C.border}`, marginBottom: 18, paddingBottom: 18 }} className="three-col">
              {[["Low", results.salaryRange?.low, C.textMuted], ["Median", results.salaryRange?.median, C.purple], ["High", results.salaryRange?.high, C.green]].map(([l, v, c]) => (
                <div key={l} style={{ textAlign: "center", borderRight: l !== "High" ? `1px solid ${C.border}` : "none", padding: "8px 0" }}>
                  <div style={{ fontSize: 28, fontWeight: 800, color: c }}>{fmt(v)}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: "1px", marginTop: 4 }}>{l} Salary</div>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              {[["Total Comp (Median)", fmt(results.totalComp?.median), C.purple], ["Equity", results.equityRange, C.yellow], ["Bonus", results.bonusRange, C.green], ["Market Demand", results.demandLevel, C.blue]].map(([l, v, c]) => (
                <div key={l} style={{ background: `${c}12`, border: `1px solid ${c}25`, borderRadius: 10, padding: "10px 16px" }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: c }}>{v}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>{l}</div>
                </div>
              ))}
            </div>
          </Card>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }} className="two-col">
            <Card>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "1px", marginBottom: 14 }}>📈 Salary by Experience</div>
              {results.salaryByExperience?.map(({ level, salary }) => {
                const max = Math.max(...results.salaryByExperience.map(x => x.salary));
                return <div key={level} style={{ marginBottom: 12 }}><div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}><span style={{ color: C.textMid }}>{level}</span><span style={{ color: C.purple, fontWeight: 700 }}>{fmt(salary)}</span></div><PBar val={Math.round((salary/max)*100)} color={C.purple} /></div>;
              })}
            </Card>
            <Card>
              <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "1px", marginBottom: 14 }}>⚡ Skill Premiums</div>
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
              <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "1px", marginBottom: 14 }}>🏆 Top Paying Companies</div>
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
              <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: "uppercase", letterSpacing: "1px", marginBottom: 14 }}>🤝 Negotiation Tips</div>
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
              <div style={{ fontSize: 12, color: C.green, fontWeight: 700, marginBottom: 10 }}>🔮 2026 MARKET OUTLOOK</div>
              <div style={{ fontSize: 14, lineHeight: 1.8, color: C.text }}>{results.marketOutlook}</div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// ─── NETWORKING PAGE ───────────────────────────────────────
function NetworkingPage() {
  const [form, setForm] = useState({ targetName: "", targetRole: "", targetCompany: "", yourBackground: "", purpose: "coffee-chat", jobDesc: "" });
  const [loading, setLoading] = useState(false); const [results, setResults] = useState(null); const [error, setError] = useState(""); const [tab, setTab] = useState("linkedin");
  const purposes = [{ value: "coffee-chat", label: "☕ Coffee Chat" }, { value: "referral", label: "🤝 Referral Request" }, { value: "informational", label: "🎓 Informational Interview" }, { value: "reconnect", label: "👋 Reconnect" }, { value: "cold-outreach", label: "📨 Cold Outreach" }];

  const generate = async () => {
    if (!form.targetCompany || !form.yourBackground) { setError("Please fill in your background and the target company."); return; }
    setError(""); setLoading(true); setResults(null);
    try {
      const raw = await askClaude(`Networking outreach. Return ONLY JSON:
{"linkedinMessage":"<280 chars max>","linkedinNote":"<2 para InMail>","email":{"subject":"<subject>","body":"<100 word email>"},"followUp":"<follow up>","icebreakers":["<i1>","<i2>"],"doList":["<d1>","<d2>"],"dontList":["<dont1>","<dont2>"],"callToAction":"<ask>"}
To: ${form.targetName||"contact"} (${form.targetRole||"role"} at ${form.targetCompany}), From: ${form.yourBackground.slice(0,200)}, Purpose: ${form.purpose}`, 1500);
      setResults(JSON.parse(raw)); setTab("linkedin");
    } catch { setError("Failed. Please try again."); } finally { setLoading(false); }
  };

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 6 }}>Networking Assistant</h1>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24 }}>AI writes personalized outreach that feels human — not generic copy-paste templates.</p>
      <Card style={{ marginBottom: 20 }}>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 14 }} className="two-col">
          <Input label="Their Name" placeholder="Sarah Chen" value={form.targetName} onChange={e => setForm(f => ({ ...f, targetName: e.target.value }))} />
          <Input label="Their Role" placeholder="Engineering Manager" value={form.targetRole} onChange={e => setForm(f => ({ ...f, targetRole: e.target.value }))} />
          <Input label="Company *" placeholder="Stripe, Google, Amazon…" value={form.targetCompany} onChange={e => setForm(f => ({ ...f, targetCompany: e.target.value }))} />
          <Select label="Purpose" value={form.purpose} onChange={e => setForm(f => ({ ...f, purpose: e.target.value }))}>{purposes.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}</Select>
          <div style={{ gridColumn: "1 / -1" }}><Textarea label="Your Background *" placeholder="e.g. 4-year software engineer with React experience at a fintech startup, currently exploring senior roles at larger companies…" value={form.yourBackground} onChange={e => setForm(f => ({ ...f, yourBackground: e.target.value }))} style={{ minHeight: 160, width: "100%" }} /></div>
          {form.purpose === "referral" && <div style={{ gridColumn: "1 / -1" }}><Textarea label="Job You Want a Referral For" placeholder="Paste the job title and key requirements…" value={form.jobDesc} onChange={e => setForm(f => ({ ...f, jobDesc: e.target.value }))} style={{ minHeight: 160, width: "100%" }} /></div>}
        </div>
        {error && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, color: C.red, fontSize: 13, marginBottom: 14 }}>{error}</div>}
        <Btn onClick={generate} style={{ padding: "13px 28px" }}>✍️ Generate Outreach Messages</Btn>
      </Card>
      {loading && <Spinner steps={["Personalizing messages…","Writing LinkedIn outreach…","Crafting email…","Adding icebreakers…"]} currentStep={1} />}
      {results && (
        <div>
          <div style={{ display: "flex", gap: 3, background: C.bgSoft, borderRadius: 10, padding: 3, marginBottom: 20 }}>
            {[["linkedin","💼 LinkedIn"],["email","📧 Email"],["followup","🔁 Follow-up"],["tips","💡 Tips"]].map(([id, lbl]) => (
              <button key={id} style={{ flex: 1, padding: "10px", borderRadius: 7, border: "none", background: tab === id ? "#fff" : "transparent", color: tab === id ? C.text : C.textMuted, fontSize: 13, fontWeight: 600, cursor: "pointer", boxShadow: tab === id ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }} onClick={() => setTab(id)}>{lbl}</button>
            ))}
          </div>
          {tab === "linkedin" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <Card>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}><Label>CONNECTION REQUEST (MAX 280 CHARS)</Label><CopyBtn text={results.linkedinMessage} label="📋 Copy" /></div>
                <ContentDisplay content={results.linkedinMessage} />
                <div style={{ fontSize: 12, color: results.linkedinMessage?.length > 280 ? C.red : C.textMuted, marginTop: 8 }}>{results.linkedinMessage?.length}/280 characters</div>
              </Card>
              <Card>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}><Label>INMAIL / FULL MESSAGE</Label><CopyBtn text={results.linkedinNote} label="📋 Copy" /></div>
                <ContentDisplay content={results.linkedinNote} />
              </Card>
              <div style={{ background: C.greenLight, border: `1px solid ${C.green}25`, borderRadius: 12, padding: 16 }}>
                <Label>🎯 YOUR SPECIFIC ASK</Label>
                <div style={{ fontSize: 14, lineHeight: 1.7, color: C.text }}>{results.callToAction}</div>
              </div>
            </div>
          )}
          {tab === "email" && results.email && (
            <Card>
              <div style={{ marginBottom: 16 }}>
                <Label>SUBJECT LINE</Label>
                <div style={{ background: C.bgSoft, borderRadius: 9, padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{results.email.subject}</span>
                  <CopyBtn text={results.email.subject} label="Copy" />
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}><Label>EMAIL BODY</Label><CopyBtn text={results.email.body} label="📋 Copy Email" /></div>
              <ContentDisplay content={results.email.body} />
            </Card>
          )}
          {tab === "followup" && (
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                <div><Label>FOLLOW-UP MESSAGE</Label><div style={{ fontSize: 12, color: C.textMuted, marginTop: 3 }}>Send after 7 days of no reply</div></div>
                <CopyBtn text={results.followUp} label="📋 Copy" />
              </div>
              <ContentDisplay content={results.followUp} />
              <div style={{ marginTop: 20 }}>
                <Label>💬 CONVERSATION ICEBREAKERS</Label>
                {results.icebreakers?.map((ic, i) => (
                  <div key={i} style={{ background: C.bgSoft, borderRadius: 10, padding: "12px 16px", marginBottom: 8, display: "flex", gap: 10, alignItems: "flex-start" }}>
                    <span style={{ color: C.blue, fontWeight: 700, flexShrink: 0 }}>{i+1}.</span>
                    <span style={{ fontSize: 14, lineHeight: 1.6, color: C.text }}>{ic}</span>
                  </div>
                ))}
              </div>
            </Card>
          )}
          {tab === "tips" && (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }} className="two-col">
              <Card>
                <div style={{ fontSize: 12, color: C.green, fontWeight: 700, marginBottom: 14 }}>✓ DO THIS</div>
                {results.doList?.map((t, i) => <div key={i} style={{ display: "flex", gap: 10, marginBottom: 12 }}><span style={{ color: C.green, flexShrink: 0, fontWeight: 700 }}>✓</span><span style={{ fontSize: 14, lineHeight: 1.7, color: C.text }}>{t}</span></div>)}
              </Card>
              <Card>
                <div style={{ fontSize: 12, color: C.red, fontWeight: 700, marginBottom: 14 }}>✗ AVOID THIS</div>
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
function SavedJobsPage({ savedJobs, setSavedJobs, setApplications }) {
  const remove = id => setSavedJobs(p => p.filter(j => j.job_id !== id));
  const addTracker = job => setApplications(p => [{ id: uid(), company: job.company, jobTitle: job.title, status: "Applied", date: new Date().toISOString().split("T")[0], notes: "", url: job.applyUrl }, ...p]);
  const fmtSalary = (min, max) => { if (!min && !max) return "Salary not listed"; const f = n => `$${Math.round(n/1000)}K`; if (min && max) return `${f(min)} – ${f(max)}`; return min ? `${f(min)}+` : `Up to ${f(max)}`; };

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 6 }}>Saved Jobs</h1>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24 }}>{savedJobs.length} saved job{savedJobs.length !== 1 ? "s" : ""} — apply when you're ready.</p>
      {savedJobs.length === 0 && <Card style={{ textAlign: "center", padding: 64 }}><div style={{ fontSize: 48, marginBottom: 16 }}>♡</div><div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>No saved jobs yet</div><div style={{ fontSize: 14, color: C.textMuted }}>Heart any job in Job Search to bookmark it here</div></Card>}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {savedJobs.map(job => (
          <Card key={job.job_id}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 4 }}>{job.title}</div>
                <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 8 }}>{job.company} · {job.location}</div>
                <div style={{ fontSize: 14, color: C.green, fontWeight: 600, marginBottom: 8 }}>{fmtSalary(job.salaryMin, job.salaryMax)}</div>
                <div style={{ display: "flex", gap: 6 }}>{job.remote && <Badge color={C.green}>🌐 Remote</Badge>}{job.employmentType && <Badge color={C.textMuted}>{job.employmentType}</Badge>}{job.matchScore && <Badge color={C.purple}>{job.matchScore}% Match</Badge>}</div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
                <a href={job.applyUrl} target="_blank" rel="noreferrer" style={{ background: `linear-gradient(135deg,${C.purple},${C.purpleMid})`, color: "#fff", borderRadius: 10, padding: "10px 20px", fontSize: 14, fontWeight: 700, textDecoration: "none" }}>Apply Now →</a>
                <Btn variant="green" onClick={() => addTracker(job)}>+ Track</Btn>
                <Btn variant="danger" onClick={() => remove(job.job_id)}>✕ Remove</Btn>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ─── PRICING PAGE ──────────────────────────────────────────
function PricingPage({ profile }) {
  const plans = [
    { id: "free", name: "Free", price: "$0", sub: "Forever free", color: C.textMuted, features: ["3 resume analyses/month","10 job searches/day","Basic application tracker","3 interview sessions/month","Basic salary insights"], cta: "Current Plan", disabled: true },
    { id: "pro", name: "Pro", price: "$19", sub: "per month", color: C.purple, popular: true, features: ["Unlimited resume analyses","Unlimited job searches","Full interview prep + AI coaching","Advanced salary benchmarks","Networking assistant","AI job match scoring","PDF & DOCX downloads","Priority AI processing"], cta: "Start Pro Free Trial", disabled: false },
    { id: "premium", name: "Premium", price: "$49", sub: "per month", color: C.blue, features: ["Everything in Pro","Auto-apply to jobs (coming soon)","Chrome extension (coming soon)","LinkedIn integration (coming soon)","Email follow-up automation (soon)","Resume version management","White-label reports"], cta: "Start Premium Trial", disabled: false },
  ];

  return (
    <div>
      <div style={{ textAlign: "center", marginBottom: 36 }}>
        <h1 style={{ fontSize: 30, fontWeight: 800, color: C.text, letterSpacing: "-0.5px", marginBottom: 10 }}>Simple, Transparent Pricing</h1>
        <p style={{ color: C.textMuted, fontSize: 15 }}>Start free. Upgrade when you're ready to land your dream job faster.</p>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 18, maxWidth: 960, margin: "0 auto" }} className="three-col">
        {plans.map(plan => (
          <Card key={plan.id} style={{ position: "relative", border: plan.popular ? `2px solid ${C.purple}` : `1px solid ${C.border}` }}>
            {plan.popular && <div style={{ position: "absolute", top: -13, left: "50%", transform: "translateX(-50%)", background: `linear-gradient(135deg,${C.purple},${C.purpleMid})`, color: "#fff", fontSize: 11, fontWeight: 700, padding: "3px 16px", borderRadius: 20, whiteSpace: "nowrap" }}>MOST POPULAR</div>}
            <div style={{ fontSize: 17, fontWeight: 800, color: plan.color, marginBottom: 4 }}>{plan.name}</div>
            <div style={{ marginBottom: 6 }}><span style={{ fontSize: 32, fontWeight: 900, color: C.text }}>{plan.price}</span><span style={{ fontSize: 14, color: C.textMuted, marginLeft: 4 }}>{plan.sub}</span></div>
            <div style={{ height: 1, background: C.border, margin: "16px 0 18px" }} />
            {plan.features.map((f, i) => <div key={i} style={{ display: "flex", gap: 10, marginBottom: 10, fontSize: 14, color: C.textMid, lineHeight: 1.5 }}><span style={{ color: plan.color, flexShrink: 0, fontWeight: 700 }}>✓</span>{f}</div>)}
            <div style={{ marginTop: 20 }}>
              <Btn variant={plan.id === "free" ? "secondary" : "primary"} style={{ width: "100%", justifyContent: "center", padding: "13px", opacity: plan.disabled ? 0.5 : 1, ...(plan.id === "premium" ? { background: C.blue } : {}) }} disabled={plan.disabled} onClick={() => { if (!plan.disabled) alert(`Connect Stripe to enable ${plan.name} payments`); }}>
                {profile?.plan === plan.id ? "✓ Current Plan" : plan.cta}
              </Btn>
            </div>
          </Card>
        ))}
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
        <div><h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 4 }}>Profile</h1><p style={{ color: C.textMuted, fontSize: 14 }}>{profile?.email}</p></div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}><Badge color={C.purple}>{(profile?.plan || "FREE").toUpperCase()}</Badge><Btn variant="danger" onClick={logout}>Sign Out</Btn></div>
      </div>
      <Card>
        <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 18 }}>Personal Information</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 18 }} className="two-col">
          <Input label="Full Name" value={form.full_name} onChange={e => setForm(f => ({ ...f, full_name: e.target.value }))} />
          <Input label="Phone" placeholder="+1 (415) 555-0123" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
          <Input label="Location" placeholder="San Francisco, CA" value={form.location} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} />
          <Input label="LinkedIn URL" placeholder="linkedin.com/in/yourname" value={form.linkedin_url} onChange={e => setForm(f => ({ ...f, linkedin_url: e.target.value }))} />
          <Input label="Current Job Title" placeholder="Software Engineer" value={form.job_title} onChange={e => setForm(f => ({ ...f, job_title: e.target.value }))} />
          <Input label="Years of Experience" placeholder="4 years" value={form.years_experience} onChange={e => setForm(f => ({ ...f, years_experience: e.target.value }))} />
        </div>
        <Btn onClick={save} style={{ padding: "12px 28px" }}>{saved ? "✓ Saved!" : "Save Profile"}</Btn>
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
  const [page, setPage] = useStorage("cp_active_page", "resume");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleLogin = (u) => { login(u); setProfile(u); };
  const handleLogout = () => { logout(); setProfile(null); };
  const updateProfile = (updates) => { const updated = { ...profile, ...updates }; setProfile(updated); localStorage.setItem("cp_user", JSON.stringify(updated)); };
  const handleSaveApp = (app) => setApplications(p => [app, ...p]);
  const goHome = () => setPage("resume");

  const nav = [
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

  if (!user) return <AuthPage onLogin={handleLogin} />;

  return (
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
        button:hover:not(:disabled) { opacity: 0.88; transform: translateY(-1px); }
        button:active:not(:disabled) { transform: translateY(0); }
        ::-webkit-scrollbar { width: 5px; } ::-webkit-scrollbar-thumb { background: ${C.border}; border-radius: 3px; }
        @media (max-width: 700px) { 
  .two-col, .three-col { grid-template-columns: 1fr !important; } 
  .nav-label { display: none; }
  .desktop-nav { display: none !important; }
  .hamburger-btn { display: block !important; }
}
@media (min-width: 701px) {
  .hamburger-btn { display: none !important; }
  .desktop-nav { display: flex !important; }
}
        a { color: inherit; }
        input[type="date"] { color: ${C.text}; }
      `}</style>
      <header style={{ background: "#fff", borderBottom: `1px solid ${C.border}`, padding: "0 24px", display: "flex", alignItems: "center", justifyContent: "space-between", position: "sticky", top: 0, zIndex: 100, boxShadow: "0 1px 6px rgba(0,0,0,0.06)", height: 62 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }} onClick={goHome}>
          <Logo size={36} />
          <AppName size={18} />
        </div>
        <nav className="desktop-nav" style={{ display: "flex", gap: 2, background: C.bgSoft, borderRadius: 11, padding: "3px" }}>
          {nav.map(n => (
            <button key={n.id} style={{ padding: "7px 13px", borderRadius: 8, border: "none", background: page === n.id ? "#fff" : "transparent", color: page === n.id ? C.purple : C.textMuted, fontSize: 12, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 5, whiteSpace: "nowrap", boxShadow: page === n.id ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }} onClick={() => setPage(n.id)}>
              <span>{n.icon}</span><span className="nav-label">{n.label}</span>
            </button>
          ))}
        </nav>
        <button className="hamburger-btn" onClick={() => setMobileMenuOpen(m => !m)} style={{ display: "none", background: "none", border: "none", cursor: "pointer", padding: "8px", fontSize: 22 }}>☰</button>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Badge color={C.purple}>{(profile?.plan || "FREE").toUpperCase()}</Badge>
        </div>
      </header>
      {mobileMenuOpen && (
        <div style={{ position: "fixed", top: 62, left: 0, right: 0, bottom: 0, background: "#fff", zIndex: 99, overflowY: "auto", padding: "16px" }}>
          {nav.map(n => (
            <button key={n.id} style={{ width: "100%", padding: "16px 20px", borderRadius: 10, border: "none", background: page === n.id ? C.purpleLight : "#fff", color: page === n.id ? C.purple : C.text, fontSize: 15, fontWeight: 700, cursor: "pointer", display: "flex", alignItems: "center", gap: 12, marginBottom: 6, textAlign: "left" }} onClick={() => { setPage(n.id); setMobileMenuOpen(false); }}>
              <span style={{ fontSize: 20 }}>{n.icon}</span>{n.label}
            </button>
          ))}
        </div>
      )}
      <main style={{ maxWidth: 1200, margin: "0 auto", padding: "32px 24px 80px" }}>
        {page === "resume" && <ResumePage onSave={handleSaveApp} onNavigate={setPage} />}
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

// v4.1 - fast prompts update

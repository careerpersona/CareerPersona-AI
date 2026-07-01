import { useState, useCallback, useRef, useEffect } from "react";
import { supabase, initialLocationHash } from "./lib/supabaseClient";
import { fetchProfile, upsertProfile } from "./data/profile";
import { useApplications, insertApplicationRow } from "./data/applications";
import { useSavedJobs } from "./data/savedJobs";
import { useResumes } from "./data/resumes";
import { useSmartApplyQueue } from "./data/smartApply";
import { useInterviewSession } from "./data/interviewSession";
import { useSalaryResearch } from "./data/salaryResearch";
import { useNetworkingContacts } from "./data/networkingContacts";
import { useAssistantChat } from "./data/assistantChat";
import { useActivityLog } from "./data/activityLog";
import { useNotifications, insertNotification } from "./data/notifications";
import { useAiBriefing } from "./data/aiBriefing";
import { useAiActionPlan } from "./data/aiActionPlan";
import { I18nContext, useLanguagePreference, useI18n } from "./i18n/I18nContext";
import { LANGUAGES } from "./i18n/languages";

const C = {
  bg: "#FFFFFF", bgSoft: "#F7F8FC", bgCard: "#FFFFFF", border: "#E2E8F0", borderStrong: "#CBD5E1",
  purple: "#6B21E8", purpleLight: "#F3EEFF", purpleMid: "#9B59F5", text: "#0F172A", textMid: "#334155",
  textMuted: "#64748B", green: "#059669", greenLight: "#ECFDF5", red: "#DC2626", redLight: "#FEF2F2",
  yellow: "#D97706", yellowLight: "#FFFBEB", blue: "#2563EB", blueLight: "#EFF6FF",
  navText: "#3B2A1F", navHover: "#6B21E8",
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

// Persistent account store, separate from "who is currently logged in" —
// so logging out doesn't erase a saved profile (cp_accounts is keyed by email).
const getAccounts = () => { try { return JSON.parse(localStorage.getItem("cp_accounts") || "{}"); } catch { return {}; } };
const saveAccount = (profile) => {
  if (!profile?.email) return;
  const accounts = getAccounts();
  accounts[profile.email.toLowerCase()] = profile;
  localStorage.setItem("cp_accounts", JSON.stringify(accounts));
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
  // Sync ref so async callbacks read the latest value without stale closures.
  const recoveryRef = useRef(isRecoveryUrl);

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
    // Don't auto-login if we're already in recovery mode when getSession resolves.
    supabase.auth.getSession().then(({ data }) => {
      if (!recoveryRef.current) syncFromSession(data.session);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") {
        // Hold the Supabase internal session (needed for updateUser) but don't
        // treat this as a normal login — show the reset form instead.
        recoveryRef.current = true;
        setRecoveryMode(true);
        setUser(null);
        localStorage.removeItem("cp_user");
        return;
      }
      // Ignore all other events while the user is going through the reset flow
      // (USER_UPDATED fires after updateUser succeeds; we don't want auto-login).
      if (recoveryRef.current) return;
      if (session?.user) syncFromSession(session);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const clearRecovery = () => {
    recoveryRef.current = false;
    setRecoveryMode(false);
  };

  return { user, login, logout, recoveryMode, clearRecovery };
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

function NavPills({ nav, page, setPage }) {
  return (
    <nav className="nav-pills" style={{ display: "flex", gap: 2, background: C.bgSoft, borderRadius: 11, padding: "3px" }}>
      {nav.map(n => (
        <button key={n.id} title={n.label} className="nav-pill" style={{ padding: "6px 11px", borderRadius: 8, border: "none", background: page === n.id ? "#fff" : "transparent", color: page === n.id ? C.purple : C.navText, opacity: 1, fontSize: 11.5, fontWeight: page === n.id ? 700 : 600, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, whiteSpace: "nowrap", boxShadow: page === n.id ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }} onClick={() => setPage(n.id)}>
          <span style={{ fontSize: 13 }}>{n.icon}</span><span className="nav-label">{n.label}</span>
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
  return <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 7 }}>{children}</div>;
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

function CopyBtn({ text, label = "Copy", variant = "ghost" }) {
  const [c, setC] = useState(false);
  return <Btn variant={variant} style={{ padding: "6px 14px", fontSize: 12 }} onClick={() => { navigator.clipboard.writeText(text); setC(true); setTimeout(() => setC(false), 2000); }}>{c ? "✓ Copied!" : label}</Btn>;
}

function ContentDisplay({ content }) {
  return (
    <div style={{ background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px", fontSize: 14, lineHeight: 1.85, color: C.text, whiteSpace: "pre-wrap", maxHeight: 420, overflowY: "auto", fontFamily: "inherit" }}>
      {content}
    </div>
  );
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
        : await supabase.auth.signUp({ email: form.email, password: form.password, options: { data: { full_name: form.name } } });
    setLoading(false);
    if (authError) { setError(authError.message); return; }
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
                <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>Check your email</div>
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

// ─── DASHBOARD PAGE ─────────────────────────────────────────
function DashboardPage({ profile, applications, savedJobs, setPage }) {
  const { t } = useI18n();
  const [briefing, setBriefing] = useState(null);
  const [briefingLoading, setBriefingLoading] = useState(false);
  const [dailyPlan, setDailyPlan] = useState(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef();

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
    if (savedBriefing) setBriefing(savedBriefing);
  }, [savedBriefing, briefingHistoryLoading, briefingLoadedFor, profile?.id]);

  const { plan: savedPlan, loading: planHistoryLoading, loadedFor: planLoadedFor, save: savePlan } = useAiActionPlan(profile?.id);
  const planAppliedForRef = useRef(undefined);

  // ── Load the most recent action plan once the Supabase fetch resolves ──
  useEffect(() => {
    if (planHistoryLoading || planLoadedFor !== profile?.id) return;
    if (planAppliedForRef.current === profile?.id) return;
    planAppliedForRef.current = profile?.id;
    if (savedPlan) setDailyPlan(savedPlan);
  }, [savedPlan, planHistoryLoading, planLoadedFor, profile?.id]);

  // Read additional data from localStorage
  const readLS = (key, fallback) => { try { const d = localStorage.getItem(key); return d ? JSON.parse(d) : fallback; } catch { return fallback; } };
  const interviewSession = readLS("cp_interview_session_v1", null);
  const salaryResults = readLS("cp_salary_results", null);
  const networkContacts = readLS("cp_network_contacts", []);
  const apps = applications || [];
  const saved = savedJobs || [];

  // Computed stats
  const totalApps = apps.length;
  const interviews = apps.filter(a => ["Interview","Final Interview","Phone Screen"].includes(a.status)).length;
  const offers = apps.filter(a => a.status === "Offer").length;
  const profileFields = ["full_name","email_address","phone","location","job_title","years_experience","preferred_job_title","work_type"];
  const profileComplete = profile ? Math.round((profileFields.filter(f => profile[f]).length / profileFields.length) * 100) : 0;
  const questionsCount = interviewSession?.questions?.length || 0;

  // AI Activity log
  const { activity: aiActivity, logActivity } = useActivityLog(profile?.id);

  // Generate AI Briefing
  const generateBriefing = async () => {
    setBriefingLoading(true);
    try {
      const context = `User: ${profile?.full_name || "New user"}. Job title: ${profile?.job_title || "Not set"}. Target: ${profile?.preferred_job_title || "Not set"}. Applications: ${totalApps}. Interviews: ${interviews}. Offers: ${offers}. Saved jobs: ${saved.length}. Interview questions practiced: ${questionsCount}. Network contacts: ${networkContacts.length}. Profile completion: ${profileComplete}%.`;
      const raw = await askClaude(`You are CareerPersona AI. Generate a brief daily career briefing (4-5 bullet points, each 1 sentence). Be specific and actionable based on this data. If user is new with little data, give encouraging onboarding guidance. Return ONLY a JSON array of strings, no markdown: ["point1","point2","point3","point4"]
${context}`, 600);
      let result;
      try {
        const start = raw.indexOf("["); const end = raw.lastIndexOf("]");
        result = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : ["Welcome to CareerPersona AI! Start by completing your profile, uploading a resume, and searching for jobs."];
      } catch { result = ["Your AI briefing is ready. Complete your profile to get personalized insights."]; }
      setBriefing(result);
      saveBriefing(result).catch(err => console.error("briefing save failed", err));
      logActivity("Daily briefing generated");
      insertNotification(profile?.id, { type: "ai_recommendation", title: "Daily briefing ready", body: "Your personalized career briefing has been generated.", linkPage: "dashboard" });
    } catch { setBriefing(["Could not generate briefing. Please try again."]); }
    finally { setBriefingLoading(false); }
  };

  // Generate Daily Plan
  const generatePlan = async () => {
    setPlanLoading(true);
    try {
      const context = `Profile complete: ${profileComplete}%. Apps: ${totalApps}. Saved: ${saved.length}. Interviews: ${interviews}. Questions practiced: ${questionsCount}. Target role: ${profile?.preferred_job_title || "not set"}.`;
      const raw = await askClaude(`You are CareerPersona AI career coach. Generate today's 4-5 action items for this job seeker. Each should be specific and achievable today. Return ONLY JSON array: [{"task":"<task>","priority":"high|medium|low"}]
${context}`, 600);
      let result;
      try {
        const start = raw.indexOf("["); const end = raw.lastIndexOf("]");
        result = start >= 0 && end > start ? JSON.parse(raw.slice(start, end + 1)) : [{task:"Complete your career profile",priority:"high"}];
      } catch { result = [{task:"Set up your profile to get started",priority:"high"}]; }
      setDailyPlan(result);
      savePlan(result).catch(err => console.error("action plan save failed", err));
      logActivity("Daily plan generated");
      insertNotification(profile?.id, { type: "ai_recommendation", title: "Action plan ready", body: "Today's action plan has been generated.", linkPage: "dashboard" });
    } catch { setDailyPlan([{task:"Could not generate plan. Try again.",priority:"medium"}]); }
    finally { setPlanLoading(false); }
  };

  // Chat
  const sendChat = async () => {
    if (!chatInput.trim() || chatLoading) return;
    const userMsg = chatInput.trim();
    setChatInput("");
    setChatMessages(prev => [...prev, { role: "user", text: userMsg }]);
    addChatMessage("user", userMsg).catch(err => console.error("assistant chat save failed", err));
    setChatLoading(true);
    try {
      const context = `You are CareerPersona AI career assistant. User: ${profile?.full_name || "User"}. Role: ${profile?.job_title || "N/A"}. Target: ${profile?.preferred_job_title || "N/A"}. Apps: ${totalApps}. Interviews: ${interviews}. Offers: ${offers}. Saved: ${saved.length}. Profile: ${profileComplete}% complete. Answer concisely (2-3 sentences) using this context.`;
      const raw = await askClaude(`${context}\nUser question: ${userMsg}`, 400);
      setChatMessages(prev => [...prev, { role: "ai", text: raw }]);
      addChatMessage("ai", raw).catch(err => console.error("assistant chat save failed", err));
      logActivity("Chat: " + userMsg.slice(0, 30));
    } catch {
      setChatMessages(prev => [...prev, { role: "ai", text: "Sorry, I couldn't process that. Please try again." }]);
    } finally { setChatLoading(false); }
  };

  useEffect(() => { if (chatMessages.length === 0) return; chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages]);

  const priorityColor = { high: C.red, medium: C.yellow, low: C.green };

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
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ fontSize: 20 }}>🤖</span><span style={{ fontSize: 11, fontWeight: 700, color: C.navText, textTransform: "uppercase", letterSpacing: "0.6px" }}>{t("dashboard.briefingTitle")}</span></div>
          </div>
          {!briefing && (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 14 }}>{t("dashboard.briefingEmpty")}</div>
              <Btn onClick={generateBriefing} loading={briefingLoading}>{briefingLoading ? t("dashboard.briefingAnalyzing") : t("dashboard.briefingGenerate")}</Btn>
            </div>
          )}
          {briefing && (
            <div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
                {briefing.map((b, i) => <div key={i} style={{ fontSize: 13, color: C.text, lineHeight: 1.6, padding: "6px 0", borderBottom: i < briefing.length - 1 ? `1px solid ${C.border}` : "none" }}>• {b}</div>)}
              </div>
              <Btn variant="secondary" style={{ fontSize: 12, padding: "6px 14px" }} onClick={generateBriefing} loading={briefingLoading}>{briefingLoading ? t("dashboard.briefingAnalyzing") : t("dashboard.regenerate")}</Btn>
            </div>
          )}
        </Card>

        {/* Daily Plan */}
        <Card>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, textTransform: "uppercase", letterSpacing: "0.6px" }}>{t("dashboard.planTitle")}</div>
          </div>
          {!dailyPlan && (
            <div style={{ textAlign: "center", padding: "20px 0" }}>
              <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 14 }}>{t("dashboard.planEmpty")}</div>
              <Btn onClick={generatePlan} loading={planLoading}>{planLoading ? t("dashboard.planCreating") : t("dashboard.planGenerate")}</Btn>
            </div>
          )}
          {dailyPlan && (
            <div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
                {dailyPlan.map((t, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "8px 0", borderBottom: i < dailyPlan.length - 1 ? `1px solid ${C.border}` : "none" }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: priorityColor[t.priority] || C.textMuted, background: (priorityColor[t.priority] || C.textMuted) + "18", padding: "2px 8px", borderRadius: 6, flexShrink: 0, marginTop: 2 }}>{(t.priority || "").toUpperCase()}</span>
                    <span style={{ fontSize: 13, color: C.text, lineHeight: 1.5 }}>{t.task}</span>
                  </div>
                ))}
              </div>
              <Btn variant="secondary" style={{ fontSize: 12, padding: "6px 14px" }} onClick={generatePlan} loading={planLoading}>{planLoading ? t("dashboard.planCreating") : t("dashboard.regenerate")}</Btn>
            </div>
          )}
        </Card>
      </div>

      {/* SECOND ROW: Resume + Job + Market Intelligence */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 16 }} className="three-col">
        {/* Resume Intelligence */}
        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 12 }}>{t("dashboard.resumeIntelTitle")}</div>
          {totalApps > 0 || profileComplete > 50 ? (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: C.textMid, marginBottom: 6 }}><span>{t("dashboard.profileStrength")}</span><span style={{ fontWeight: 700, color: C.purple }}>{profileComplete}%</span></div>
              <PBar val={profileComplete} color={C.purple} />
              <div style={{ marginTop: 12, fontSize: 13, color: C.textMuted }}>{t("dashboard.resumeIntelHint")}</div>
            </div>
          ) : (
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>{t("dashboard.resumeIntelEmpty")}</div>
          )}
          <Btn variant="secondary" style={{ marginTop: 12, padding: "6px 14px", fontSize: 12 }} onClick={() => setPage("resume")}>{t("dashboard.goToResume")}</Btn>
        </Card>

        {/* Job Intelligence */}
        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 12 }}>{t("dashboard.jobIntelTitle")}</div>
          {saved.length > 0 ? (
            <div>
              <div style={{ fontSize: 24, fontWeight: 800, color: C.purple }}>{saved.length}</div>
              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 8 }}>{t("dashboard.savedJobs")}</div>
              {saved.slice(0, 3).map((j, i) => (
                <div key={j.id || i} style={{ fontSize: 12, color: C.text, padding: "4px 0", borderBottom: `1px solid ${C.border}` }}>{j.title || j.jobTitle} — {j.company}</div>
              ))}
              {saved.length > 3 && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>{t("dashboard.moreCount").replace("{n}", saved.length - 3)}</div>}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>{t("dashboard.jobIntelEmpty")}</div>
          )}
          <Btn variant="secondary" style={{ marginTop: 12, padding: "6px 14px", fontSize: 12 }} onClick={() => setPage("jobs")}>{t("dashboard.goToJobSearch")}</Btn>
        </Card>

        {/* Market Intelligence */}
        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 12 }}>{t("dashboard.marketIntelTitle")}</div>
          {salaryResults ? (
            <div>
              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4 }}>{t("dashboard.medianSalary")}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: C.green }}>${salaryResults.salaryRange?.median?.toLocaleString() || "—"}</div>
              <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6 }}>{t("dashboard.demandLabel")} <strong>{salaryResults.demandLevel || "—"}</strong></div>
              {salaryResults.marketOutlook && <div style={{ fontSize: 12, color: C.textMid, marginTop: 6, lineHeight: 1.5 }}>{salaryResults.marketOutlook.slice(0, 120)}...</div>}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>{t("dashboard.marketIntelEmpty")}</div>
          )}
          <Btn variant="secondary" style={{ marginTop: 12, padding: "6px 14px", fontSize: 12 }} onClick={() => setPage("salary")}>{t("dashboard.goToSalary")}</Btn>
        </Card>
      </div>

      {/* THIRD ROW: Recommendations + Progress + Activity */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 16 }} className="three-col">
        {/* AI Recommendations */}
        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 12 }}>{t("dashboard.recommendationsTitle")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {profileComplete < 100 && <div style={{ fontSize: 13, color: C.text, padding: "6px 10px", background: C.purpleLight, borderRadius: 8 }}>{t("dashboard.recCompleteProfile").replace("{pct}", profileComplete)}</div>}
            {saved.length === 0 && <div style={{ fontSize: 13, color: C.text, padding: "6px 10px", background: C.blueLight, borderRadius: 8 }}>{t("dashboard.recSaveJobs")}</div>}
            {totalApps === 0 && <div style={{ fontSize: 13, color: C.text, padding: "6px 10px", background: C.greenLight, borderRadius: 8 }}>{t("dashboard.recFirstApp")}</div>}
            {questionsCount === 0 && <div style={{ fontSize: 13, color: C.text, padding: "6px 10px", background: C.yellowLight, borderRadius: 8 }}>{t("dashboard.recPracticeInterview")}</div>}
            {networkContacts.length === 0 && <div style={{ fontSize: 13, color: C.text, padding: "6px 10px", background: C.redLight, borderRadius: 8 }}>{t("dashboard.recBuildNetwork")}</div>}
            {profileComplete === 100 && saved.length > 0 && totalApps > 0 && questionsCount > 0 && networkContacts.length > 0 && (
              <div style={{ fontSize: 13, color: C.green, fontWeight: 600 }}>{t("dashboard.recGreatProgress")}</div>
            )}
          </div>
        </Card>

        {/* Career Progress */}
        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 12 }}>{t("dashboard.progressTitle")}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {[
              [t("dashboard.progressProfile"), `${profileComplete}%`, profileComplete, C.purple],
              [t("dashboard.progressSavedJobs"), saved.length, Math.min(saved.length * 10, 100), C.blue],
              [t("dashboard.progressApplications"), totalApps, Math.min(totalApps * 10, 100), C.green],
              [t("dashboard.progressInterviews"), interviews, Math.min(interviews * 20, 100), C.yellow],
              [t("dashboard.progressOffers"), offers, Math.min(offers * 50, 100), C.green],
            ].map(([label, value, pct, color]) => (
              <div key={label}>
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 3 }}>
                  <span style={{ color: C.textMid }}>{label}</span>
                  <span style={{ fontWeight: 700, color }}>{value}</span>
                </div>
                <PBar val={pct} color={color} />
              </div>
            ))}
          </div>
        </Card>

        {/* AI Activity */}
        <Card>
          <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 12 }}>{t("dashboard.activityTitle")}</div>
          {aiActivity.length > 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 220, overflowY: "auto" }}>
              {aiActivity.map(a => (
                <div key={a.id} style={{ fontSize: 12, color: C.text, padding: "6px 0", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", gap: 8 }}>
                  <span>{a.action}</span>
                  <span style={{ color: C.textMuted, flexShrink: 0, fontSize: 11 }}>{a.time}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.6 }}>{t("dashboard.activityEmpty")}</div>
          )}
        </Card>
      </div>

      {/* BOTTOM: AI Chat Assistant */}
      <Card>
        <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>🤖 {t("dashboard.assistantTitle")}</div>
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

function ResumePage({ onSave, onNavigate, profile }) {
  const { t } = useI18n();
  const [resume, setResume] = useState("");
  const [jobDesc, setJobDesc] = useState(profile?.preferred_job_title ? t("resume.lookingForPosition").replace("{title}", profile.preferred_job_title) : "");
  const [loading, setLoading] = useState(false);
  const [loadStep, setLoadStep] = useState(0);
  const [results, setResults] = useState(null);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("resume");
  const [saved, setSaved] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [savingResume, setSavingResume] = useState(false);
  const [resumeSaved, setResumeSaved] = useState(false);
  const [resumeError, setResumeError] = useState("");
  const [deletingId, setDeletingId] = useState(null);
  const fileRef = useRef();
  const { resumes, loading: resumesLoading, saveResume, deleteResume, downloadResume } = useResumes(profile?.id);

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
          text += content.items.map(it => it.str).join(" ") + "\n";
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

  const analyze = async () => {
    if (!resume.trim() || !jobDesc.trim()) { setError(t("resume.bothRequired")); return; }
    setError(""); setLoading(true); setResults(null); setLoadStep(0);
    const iv = setInterval(() => setLoadStep(s => Math.min(s + 1, 3)), 2000);
    try {
      const raw = await askClaude(`You are an expert ATS resume coach. Analyze the resume against the job description and return ONLY a JSON object, no markdown, no explanation:
{"atsScore":<0-100>,"potentialAtsScore":<estimated score after improvements 0-100>,"scoreBreakdown":{"keywordMatch":<0-100>,"formatting":<0-100>,"relevance":<0-100>},"keywordsFound":["<k1>","<k2>","<k3>","<k4>","<k5>","<k6>"],"keywordsMissing":["<m1>","<m2>","<m3>","<m4>","<m5>","<m6>"],"tailoredResume":"<full optimized resume maintaining original structure>","suggestions":["<specific tip 1>","<specific tip 2>","<specific tip 3>","<specific tip 4>","<specific tip 5>"],"coverLetter":"<professional 3 paragraph cover letter>","jobTitle":"<extracted job title>","company":"<company name>"}
RESUME:${resume}
JOB DESCRIPTION:${jobDesc}`, 4000);
      setResults(JSON.parse(raw)); setTab("resume");
    } catch { setError(t("resume.analysisFailed")); }
    finally { clearInterval(iv); setLoading(false); }
  };

  const handleSave = () => { if (!results) return; onSave({ id: uid(), company: results.company || t("resume.companyFallback"), jobTitle: results.jobTitle || t("resume.roleFallback"), status: "Applied", atsScore: results.atsScore, date: new Date().toISOString().split("T")[0], resume: results.tailoredResume, coverLetter: results.coverLetter }); setSaved(true); setTimeout(() => setSaved(false), 3000); };

  const handleSaveResume = async () => {
    if (!resume.trim()) return;
    setResumeError(""); setSavingResume(true);
    try {
      await saveResume(uploadedFile?.name || t("resume.myResumeFallback"), resume, uploadedFile);
      setResumeSaved(true);
      setTimeout(() => setResumeSaved(false), 3000);
    } catch {
      setResumeError(t("resume.saveResumeFailed"));
    } finally {
      setSavingResume(false);
    }
  };

  const handleLoadResume = (r) => { setResume(r.content || ""); setUploadedFile(null); };

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

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 6 }}>{t("resume.heading")}</h1>
        <p style={{ color: C.textMuted, fontSize: 15 }}>{t("resume.subtitle")}</p>
      </div>
      {!results && (
        <>
          {resumes.length > 0 && (
            <Card style={{ marginBottom: 20 }}>
              <Label>{t("resume.myResumes")}</Label>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                {resumes.map(r => (
                  <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, background: C.bgSoft, border: `1px solid ${C.border}`, borderRadius: 9, padding: "10px 14px", flexWrap: "wrap" }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{r.name}{r.is_default && <span style={{ marginLeft: 8, fontSize: 10, color: C.purple, fontWeight: 700 }}>{t("resume.default")}</span>}</div>
                      <div style={{ fontSize: 11, color: C.textMuted }}>{new Date(r.created_at).toLocaleDateString()}{r.file_type ? ` · ${r.file_type.toUpperCase()}` : ""}</div>
                    </div>
                    <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                      <Btn variant="ghost" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => handleLoadResume(r)}>{t("resume.load")}</Btn>
                      <Btn variant="ghost" style={{ padding: "5px 10px", fontSize: 12 }} onClick={() => handleDownloadResume(r)}>{t("resume.download")}</Btn>
                      <Btn variant="danger" style={{ padding: "5px 10px", fontSize: 12 }} loading={deletingId === r.id} onClick={() => handleDeleteResume(r)}>✕</Btn>
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }} className="two-col">
            <Card>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <Label>{t("resume.yourResume")}</Label>
                <div style={{ display: "flex", gap: 6 }}>
                  <input ref={fileRef} type="file" accept=".pdf,.doc,.docx,.txt,.png,.jpg,.jpeg" style={{ display: "none" }} onChange={handleFile} />
                  <Btn variant="ghost" style={{ padding: "5px 12px", fontSize: 12 }} loading={extracting} onClick={() => fileRef.current.click()}>{extracting ? t("resume.extracting") : t("resume.uploadFile")}</Btn>
                  <Btn variant="ghost" style={{ padding: "5px 12px", fontSize: 12 }} loading={savingResume} disabled={!resume.trim() || !profile?.id} onClick={handleSaveResume}>{resumeSaved ? t("resume.savedShort") : savingResume ? t("resume.saving") : t("resume.saveResume")}</Btn>
                </div>
              </div>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>{t("resume.supportsHint")}</div>
              <textarea style={{ width: "100%", minHeight: 260, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.8, padding: "14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} placeholder={t("resume.resumePlaceholder")} value={resume} onChange={e => setResume(e.target.value)} />
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>{resume ? t("resume.wordCount").replace("{n}", resume.split(/\s+/).filter(Boolean).length) : t("resume.plainTextHint")}</div>
              {resumeError && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 10, color: C.red, fontSize: 12, marginTop: 8 }}>{resumeError}</div>}
            </Card>
            <Card>
              <Label>{t("resume.jobDescription")}</Label>
              <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 8 }}>{t("resume.jobDescHint")}</div>
              <textarea style={{ width: "100%", minHeight: 260, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.8, padding: "14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} placeholder={t("resume.jobDescPlaceholder")} value={jobDesc} onChange={e => setJobDesc(e.target.value)} />
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>{jobDesc ? t("resume.wordCount").replace("{n}", jobDesc.split(/\s+/).filter(Boolean).length) : t("resume.jobDescTip")}</div>
            </Card>
          </div>
          {error && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 14, color: C.red, fontSize: 13, marginBottom: 16 }}>{error}</div>}
          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <Btn onClick={analyze} loading={loading} style={{ padding: "13px 32px", fontSize: 15 }}>{loading ? t("resume.analyzing") : t("resume.analyzeAndTailor")}</Btn>
            <Btn variant="secondary" disabled={loading} onClick={() => { setResume(SAMPLE_RESUME); setJobDesc(SAMPLE_JOB); }}>{t("resume.trySample")}</Btn>
          </div>
        </>
      )}
      {loading && <Spinner steps={RESUME_STEPS} currentStep={loadStep} />}
      {results && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 24, flexWrap: "wrap", gap: 12 }}>
            <div>
              <div style={{ fontSize: 20, fontWeight: 800, color: C.text, marginBottom: 4 }}>{t("resume.analysisComplete")}</div>
              {results.company && <div style={{ fontSize: 14, color: C.textMuted }}>{t("resume.roleAtCompany").replace("{role}", results.jobTitle).replace("{company}", results.company)}</div>}
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <Btn onClick={handleSave}>{saved ? t("resume.savedToTrackerDone") : t("resume.saveToTracker")}</Btn>
              <Btn variant="secondary" onClick={() => { setResults(null); setResume(""); setJobDesc(""); }}>{t("resume.newAnalysis")}</Btn>
            </div>
          </div>

          {/* ATS Score Section */}
          <Card style={{ marginBottom: 20, background: `linear-gradient(135deg, ${C.purpleLight}, #fff)` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 32, flexWrap: "wrap" }}>
              <div style={{ textAlign: "center" }}>
                <ScoreRing score={results.atsScore} size={90} />
                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 6, fontWeight: 600 }}>{t("resume.currentAtsScore")}</div>
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
                {[[t("resume.keywordMatch"), results.scoreBreakdown?.keywordMatch], [t("resume.formatting"), results.scoreBreakdown?.formatting], [t("resume.relevance"), results.scoreBreakdown?.relevance]].map(([l, v]) => (
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
              <div style={{ fontSize: 12, color: C.green, fontWeight: 700, marginBottom: 10 }}>{t("resume.keywordsFound")}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{results.keywordsFound?.map(k => <Badge key={k} color={C.green}>{k}</Badge>)}</div>
            </div>
            <div style={{ background: C.redLight, border: `1px solid ${C.red}25`, borderRadius: 12, padding: 16 }}>
              <div style={{ fontSize: 12, color: C.red, fontWeight: 700, marginBottom: 10 }}>{t("resume.keywordsMissing")}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{results.keywordsMissing?.map(k => <Badge key={k} color={C.red}>{k}</Badge>)}</div>
            </div>
          </div>

          {/* Tabs */}
          <div style={{ display: "flex", gap: 3, background: C.bgSoft, borderRadius: 10, padding: 3, marginBottom: 20 }}>
            {[["resume", t("resume.tabResume")],["suggestions", t("resume.tabSuggestions")],["cover", t("resume.tabCover")]].map(([id, lbl]) => (
              <Btn key={id} variant="ghost" style={{ flex: 1, padding: "10px", borderRadius: 7, border: "none", background: tab === id ? "#fff" : "transparent", color: tab === id ? C.text : C.textMuted, fontSize: 13, fontWeight: 600, boxShadow: tab === id ? "0 1px 4px rgba(0,0,0,0.08)" : "none" }} onClick={() => setTab(id)}>{lbl}</Btn>
            ))}
          </div>

          {tab === "resume" && (
            <div>
              <ContentDisplay content={results.tailoredResume} />
              <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
                <Btn variant="secondary" onClick={() => downloadPDF(results.tailoredResume, "tailored-resume")}>{t("resume.downloadPdf")}</Btn>
                <Btn variant="secondary" onClick={() => downloadDOCX(results.tailoredResume, "tailored-resume")}>{t("resume.downloadDocx")}</Btn>
                <CopyBtn text={results.tailoredResume} label={t("resume.copyResume")} variant="secondary" />
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
                <Btn variant="secondary" onClick={() => downloadPDF(results.coverLetter, "cover-letter")}>{t("resume.downloadPdf")}</Btn>
                <Btn variant="secondary" onClick={() => downloadDOCX(results.coverLetter, "cover-letter")}>{t("resume.downloadDocx")}</Btn>
                <CopyBtn text={results.coverLetter} label={t("resume.copyCoverLetter")} variant="secondary" />
              </div>
            </div>
          )}
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

function JobSearchPage({ savedJobs, setSavedJobs, setApplications, profile }) {
  const { t } = useI18n();
  const [filters, setFilters] = useState({ title: profile?.preferred_job_title || "", country: "United States", city: profile?.location || "", remote: profile?.work_type === "Remote", employmentType: "Any", experienceLevel: "Any", salaryMin: "" });
  const [jobs, setJobs] = useState([]); const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [searched, setSearched] = useState(false); const [page, setPage] = useState(1); const [hasMore, setHasMore] = useState(false); const [analyzing, setAnalyzing] = useState(null); const [matchResults, setMatchResults] = useState({}); const [resume, setResume] = useState(""); const [showResume, setShowResume] = useState(false); const [sourceCounts, setSourceCounts] = useState(null);
  const resumeFileRef = useRef();
  const [uploadingResume, setUploadingResume] = useState(false);
  const [resumeFileName, setResumeFileName] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [smartApplying, setSmartApplying] = useState(null);
  const { enqueue: enqueueSmartApply, markReady: markSmartApplyReady, markFailed: markSmartApplyFailed } = useSmartApplyQueue(profile?.id);

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
        if (text.trim()) { setResume(text.trim()); setResumeFileName(file.name); }
        else { setError(t("jobSearch.pdfExtractFailed")); }
      } else if (ext === "docx" || ext === "doc" || ext === "txt") {
        const text = await file.text();
        let clean = text;
        if (ext === "docx" || ext === "doc") {
          clean = String(text).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        }
        if (clean && clean.trim()) { setResume(clean.trim()); setResumeFileName(file.name); }
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

      // Auto AI-match all jobs if resume is provided
      if (resume.trim() && newJobs.length > 0) {
        autoMatchAll(newJobs);
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
      queued = await enqueueSmartApply(profile.id, job, null);
      const raw = await askClaude(`You are an expert job application assistant. Given this candidate's resume and job, produce a complete application package. Return ONLY valid JSON, no markdown:
{"tailoredResume":"<resume rewritten and optimized for this specific job, full text>","coverLetter":"<professional 3 paragraph cover letter for this job>","recruiterMessage":"<short personalized LinkedIn message to a recruiter at this company, 2-3 sentences>","networkingMessage":"<short message to a potential referral contact at this company, 2-3 sentences>","missingSkills":["<skill1>","<skill2>","<skill3>"],"interviewProbability":<0-100>,"hiringProbability":<0-100>,"applicationQuestions":["<likely application question 1>","<likely application question 2>","<likely application question 3>"]}

RESUME:
${resume}

JOB:
Title: ${job.title}
Company: ${job.company}
Description: ${(job.description || "").slice(0, 1200)}`, 4000);
      const result = JSON.parse(raw);
      await markSmartApplyReady(queued.id, result);
    } catch (e) {
      console.error("Smart Apply failed:", e);
      if (queued) await markSmartApplyFailed(queued.id);
      setError(t("jobSearch.smartApplyFailed"));
    } finally {
      setSmartApplying(null);
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

          {/* Resume textarea */}
          <textarea style={{ width: "100%", minHeight: 180, background: "#fff", border: `1.5px solid ${C.border}`, borderRadius: 9, color: C.text, fontSize: 14, lineHeight: 1.7, padding: "14px", resize: "vertical", outline: "none", fontFamily: "inherit", boxSizing: "border-box" }} placeholder={t("jobSearch.resumeTextareaPlaceholder")} value={resume} onChange={e => { setResume(e.target.value); if (resumeFileName) setResumeFileName(""); }} />
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
                      <Btn variant="secondary" style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => addTracker(job)}>{t("jobSearch.track")}</Btn>
                      <Btn variant="secondary" style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => smartApply(job)} loading={smartApplying === job.id}>{smartApplying === job.id ? t("jobSearch.preparing") : t("jobSearch.smartApply")}</Btn>
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
function InterviewPage({ profile }) {
  const { t } = useI18n();
  const INTERVIEW_CAT_LABEL_KEY = { "All": "interview.catAll", "Behavioral": "interview.catBehavioral", "Technical": "interview.catTechnical", "Situational": "interview.catSituational", "Culture Fit": "interview.catCultureFit" };
  const tCat = (c) => t(INTERVIEW_CAT_LABEL_KEY[c] || c);
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
      const resumeBlock = resume.trim() ? `\nCANDIDATE RESUME (tailor questions to this background):\n${resume.slice(0, 1000)}` : "";
      const raw = await askClaude(`You are an expert interview coach. Generate 8 interview questions for the job below. Mix Behavioral, Technical, Situational, and Culture Fit. For Behavioral, tipToAnswer must reference STAR (Situation, Task, Action, Result). Keep every answer field to 2-3 sentences MAX to stay concise. Return ONLY a JSON array, no markdown:
[{"id":1,"category":"Behavioral|Technical|Situational|Culture Fit","difficulty":"Easy|Medium|Hard","question":"<question>","whyAsked":"<1 sentence>","tipToAnswer":"<1-2 sentences; STAR for behavioral>","strongAnswer":"<2-3 sentences>","weakAnswer":"<1-2 sentences>","aiRecommendedAnswer":"<2-3 sentences>","star":true}]
JOB:
${jobDesc.slice(0, 2500)}${resumeBlock}`, 8000);
      const parsed = safeParse(raw);
      if (!parsed || !Array.isArray(parsed) || parsed.length === 0) {
        setError(t("interview.parseError"));
      } else {
        setQuestions(parsed);
        setRestored(false);
      }
    } catch (e) {
      setError(t("interview.generationFailed").replace("{msg}", e.message || "please try again."));
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
              <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 12 }}>{t("interview.practiceLabel")}</div>
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
const STATUSES = ["Saved","Applied","Phone Screen","Interview","Final Interview","Offer","Rejected","Withdrawn","Ghosted"];
const SCOLOR = { Saved: C.textMuted, Applied: C.blue, "Phone Screen": C.yellow, Interview: C.purple, "Final Interview": "#7C3AED", Offer: C.green, Rejected: C.red, Withdrawn: "#9333EA", Ghosted: C.textMuted };

const STATUS_LABEL_KEY = { Saved: "statusSaved", Applied: "statusApplied", "Phone Screen": "statusPhoneScreen", Interview: "statusInterview", "Final Interview": "statusFinalInterview", Offer: "statusOffer", Rejected: "statusRejected", Withdrawn: "statusWithdrawn", Ghosted: "statusGhosted" };

function TrackerPage({ applications, setApplications }) {
  const { t } = useI18n();
  const tStatus = s => t(`tracker.${STATUS_LABEL_KEY[s]}`, s);
  const [showForm, setShowForm] = useState(false); const [editId, setEditId] = useState(null); const [form, setForm] = useState({ company: "", jobTitle: "", status: "Applied", date: new Date().toISOString().split("T")[0], atsScore: "", notes: "", url: "", followUpDate: "", contactName: "", contactEmail: "" }); const [filterStatus, setFilterStatus] = useState("All"); const [viewApp, setViewApp] = useState(null);
  const [formErrors, setFormErrors] = useState({});
  const [search, setSearch] = useState("");

  const blankForm = { company: "", jobTitle: "", status: "Applied", date: new Date().toISOString().split("T")[0], atsScore: "", notes: "", url: "", followUpDate: "", contactName: "", contactEmail: "" };

  const save = () => {
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

  return (
    <div>
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
          <div style={{ display: "flex", gap: 10 }}><Btn onClick={save}>{t("tracker.saveApplication")}</Btn><Btn variant="secondary" onClick={closeForm}>{t("tracker.cancel")}</Btn></div>
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
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                {app.atsScore > 0 && <span style={{ fontSize: 12, color: C.blue, fontWeight: 700, background: C.blueLight, padding: "3px 9px", borderRadius: 6 }}>ATS {app.atsScore}</span>}
                <Badge color={SCOLOR[app.status] || C.textMuted}>{app.status ? tStatus(app.status) : t("tracker.statusUnknown")}</Badge>
                {(app.resume || app.coverLetter || app.notes) && <Btn variant="ghost" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => setViewApp(viewApp?.id === app.id ? null : app)}>{t("tracker.view")}</Btn>}
                {app.url && <a href={app.url} target="_blank" rel="noreferrer" className="btn-link" style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, background: "transparent", padding: "5px 12px", border: `1px solid ${C.border}`, borderRadius: 10, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>{t("tracker.job")}</a>}
                <Btn variant="ghost" style={{ padding: "5px 12px", fontSize: 12 }} onClick={() => edit(app)}>{t("tracker.edit")}</Btn>
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
          {viewApp.resume && <div style={{ marginBottom: 16 }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><Label>{t("tracker.tailoredResume")}</Label><div style={{ display: "flex", gap: 6 }}><Btn variant="ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => downloadPDF(viewApp.resume, "resume")}>{t("tracker.pdf")}</Btn><CopyBtn text={viewApp.resume} label={t("tracker.copy")} /></div></div><ContentDisplay content={viewApp.resume} /></div>}
          {viewApp.coverLetter && <div style={{ marginBottom: 16 }}><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><Label>{t("tracker.coverLetter")}</Label><div style={{ display: "flex", gap: 6 }}><Btn variant="ghost" style={{ padding: "4px 10px", fontSize: 11 }} onClick={() => downloadPDF(viewApp.coverLetter, "cover-letter")}>{t("tracker.pdf")}</Btn><CopyBtn text={viewApp.coverLetter} label={t("tracker.copy")} /></div></div><ContentDisplay content={viewApp.coverLetter} /></div>}
          {viewApp.notes && <div><Label>{t("tracker.notes")}</Label><div style={{ fontSize: 14, lineHeight: 1.7, color: C.text, padding: "12px 0" }}>{viewApp.notes}</div></div>}
        </Card>
      )}
    </div>
  );
}

// ─── SALARY PAGE ───────────────────────────────────────────
function SalaryPage({ profile }) {
  const { t } = useI18n();
  const [form, setForm] = useState({ jobTitle: profile?.preferred_job_title || "", location: profile?.location || "", experience: profile?.years_experience || "", skills: "", company: "" });
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false); const [error, setError] = useState("");

  const { data: savedSearch, loading: searchLoading, loadedFor: searchLoadedFor, save: saveSearch } = useSalaryResearch(profile?.id);
  const [loadApplied, setLoadApplied] = useState(false);
  const appliedForRef = useRef(undefined);
  const saveTimerRef = useRef(null);

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
      const companyBlock = form.company ? `, company type: ${form.company}` : "";
      const raw = await askClaude(`2026 salary data. Return ONLY JSON, no markdown:
{"salaryRange":{"low":<n>,"median":<n>,"high":<n>},"totalComp":{"median":<n>},"equityRange":"<range>","bonusRange":"<range>","topPayingCompanies":[{"name":"<co>","avgComp":"<c>"},{"name":"<co>","avgComp":"<c>"},{"name":"<co>","avgComp":"<c>"}],"salaryByExperience":[{"level":"Entry","salary":<n>},{"level":"Mid","salary":<n>},{"level":"Senior","salary":<n>}],"negotiationTips":["<t1>","<t2>","<t3>"],"marketOutlook":"<2 sentence outlook>","skillPremiums":[{"skill":"<s>","premium":"<p>"},{"skill":"<s>","premium":"<p>"}],"benchmarkInsight":"<1 sentence>","demandLevel":"<High|Medium|Low>","jobOpenings":"<estimate>"}
${form.jobTitle} in ${form.location}, ${form.experience || "any"} exp, skills: ${form.skills || "general"}${companyBlock}`, 2500);
      const parsed = safeParse(raw);
      if (!parsed || !parsed.salaryRange) {
        setError(t("salary.incompleteData"));
      } else {
        setResults(parsed);
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
                  <div style={{ fontSize: 11, color: C.textMuted, textTransform: "uppercase", letterSpacing: "1px", marginTop: 4 }}>{t("salary.salarySuffix").replace("{level}", l)}</div>
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
              <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 14 }}>{t("salary.salaryByExperience")}</div>
              {results.salaryByExperience?.map(({ level, salary }) => {
                const vals = results.salaryByExperience.map(x => Number(x.salary) || 0);
                const max = Math.max(...vals, 1);
                return <div key={level} style={{ marginBottom: 12 }}><div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, marginBottom: 4 }}><span style={{ color: C.textMid }}>{level}</span><span style={{ color: C.purple, fontWeight: 700 }}>{fmt(salary)}</span></div><PBar val={Math.round(((Number(salary) || 0)/max)*100)} color={C.purple} /></div>;
              })}
            </Card>
            <Card>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 14 }}>{t("salary.skillPremiums")}</div>
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
              <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 14 }}>{t("salary.topPayingCompanies")}</div>
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
              <div style={{ fontSize: 11, fontWeight: 700, color: C.navText, textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 14 }}>{t("salary.negotiationTips")}</div>
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
function NetworkingPage({ profile }) {
  const { t } = useI18n();
  const [form, setForm] = useStorage("cp_network_form", { targetName: "", targetRole: "", targetCompany: "", yourBackground: profile?.job_title ? (profile.full_name ? profile.full_name + ", " : "") + profile.job_title + (profile.years_experience ? " with " + profile.years_experience + " years experience" : "") : "", purpose: "coffee-chat", jobDesc: "" });
  const [results, setResults] = useStorage("cp_network_results", null);
  const [loading, setLoading] = useState(false); const [error, setError] = useState(""); const [tab, setTab] = useState("linkedin");
  const [emailTo, setEmailTo] = useStorage("cp_network_emailto", "");
  const [emailSent, setEmailSent] = useStorage("cp_network_emailsent", false);
  const [draft, setDraft] = useStorage("cp_network_draft", null);
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
      const raw = await askClaude(`Write a professional follow-up message. Context:
Original outreach to ${contact.name || "contact"}${contact.company ? " at " + contact.company : ""}.
Original subject: ${contact.subject || "N/A"}
Original message: ${(contact.originalMessage || contact.linkedinMessage || "").slice(0, 400)}
Method: ${contact.method}
It has been about 7 days since the original outreach.
Return ONLY the follow-up message text, no JSON, no markdown fences. Keep it brief, professional, and warm. 2-3 paragraphs max.`, 800);
      setFuDraft(cleanPlaceholders(raw) || t("networking.followupError"));
    } catch { setFuDraft(t("networking.followupError")); }
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
      const raw = await askClaude(`Networking outreach. Return ONLY JSON, no markdown:
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
function SmartApplyQueueCard({ item, onApply, onSkip, applying }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const statusLabel = { ready: t("savedJobs.statusReady"), applied: t("savedJobs.statusApplied"), skipped: t("savedJobs.statusSkipped"), queued: t("savedJobs.statusQueued") }[item.status] || item.status;
  return (
    <Card>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: C.text }}>{item.job_title}</div>
            <Badge color={item.status === "ready" ? C.green : item.status === "applied" ? C.blue : item.status === "skipped" ? C.textMuted : C.yellow}>{statusLabel}</Badge>
          </div>
          <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 8 }}>{item.company}</div>
          {item.status === "ready" && (
            <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
              {item.interview_probability != null && <Badge color={C.purple}>{t("savedJobs.interviewLabel").replace("{pct}", item.interview_probability)}</Badge>}
              {item.hiring_probability != null && <Badge color={C.green}>{t("savedJobs.hiringLabel").replace("{pct}", item.hiring_probability)}</Badge>}
            </div>
          )}
        </div>
        {item.status === "ready" && (
          <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
            <Btn variant="ghost" style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => setExpanded(e => !e)}>{expanded ? t("savedJobs.hideDetails") : t("savedJobs.viewDetails")}</Btn>
            <Btn variant="secondary" style={{ fontSize: 13, padding: "9px 14px" }} onClick={() => onSkip(item)}>{t("savedJobs.skip")}</Btn>
            <Btn style={{ fontSize: 13, padding: "9px 14px" }} loading={applying} onClick={() => onApply(item)}>{t("savedJobs.markApplied")}</Btn>
          </div>
        )}
      </div>
      {item.status === "queued" && <div style={{ fontSize: 13, color: C.textMuted, marginTop: 10 }}>{t("savedJobs.preparingApplication")}</div>}
      {expanded && item.status === "ready" && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${C.border}`, display: "flex", flexDirection: "column", gap: 14 }}>
          {item.missing_skills?.length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: C.red, fontWeight: 700, marginBottom: 6 }}>{t("savedJobs.missingSkills")}</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{item.missing_skills.map(s => <Badge key={s} color={C.red}>{s}</Badge>)}</div>
            </div>
          )}
          {item.cover_letter && <div><Label>{t("savedJobs.coverLetter")}</Label><ContentDisplay content={item.cover_letter} /></div>}
          {item.tailored_resume && <div><Label>{t("savedJobs.tailoredResume")}</Label><ContentDisplay content={item.tailored_resume} /></div>}
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
        </div>
      )}
    </Card>
  );
}

function SavedJobsPage({ savedJobs, setSavedJobs, setApplications, profile }) {
  const { t } = useI18n();
  const remove = id => setSavedJobs(p => p.filter(j => j.job_id !== id));
  const addTracker = job => setApplications(p => [{ id: uid(), company: job.company, jobTitle: job.title, status: "Applied", date: new Date().toISOString().split("T")[0], notes: "", url: job.applyUrl }, ...p]);
  const fmtSalary = (min, max) => { if (!min && !max) return t("savedJobs.salaryNotListed"); const f = n => `$${Math.round(n/1000)}K`; if (min && max) return `${f(min)} – ${f(max)}`; return min ? `${f(min)}+` : t("savedJobs.salaryUpTo").replace("{v}", f(max)); };
  const { queue, markApplied, skip } = useSmartApplyQueue(profile?.id);
  const [applyingId, setApplyingId] = useState(null);
  const [queueError, setQueueError] = useState("");
  const visibleQueue = queue.filter(q => q.status !== "applied" && q.status !== "skipped");

  const handleMarkApplied = async (item) => {
    setApplyingId(item.id);
    setQueueError("");
    try {
      const appId = uid();
      const newApp = { id: appId, company: item.company, jobTitle: item.job_title, status: "Applied", date: new Date().toISOString().split("T")[0], notes: "", resume: item.tailored_resume || "", coverLetter: item.cover_letter || "" };
      // Insert directly and wait for it to land before pointing smart_apply_queue's
      // FK at it — setApplications alone would sync in the background and could
      // lose the race, causing a foreign-key violation on the next update.
      await insertApplicationRow(profile.id, newApp);
      setApplications(p => [newApp, ...p]);
      await markApplied(item.id, appId);
    } catch {
      setQueueError(t("savedJobs.markAppliedError"));
    } finally {
      setApplyingId(null);
    }
  };

  const handleSkip = async (item) => {
    setQueueError("");
    try { await skip(item.id); }
    catch { setQueueError(t("savedJobs.skipError")); }
  };

  return (
    <div>
      <h1 style={{ fontSize: 28, fontWeight: 800, color: C.text, marginBottom: 6 }}>{t("savedJobs.heading")}</h1>
      <p style={{ color: C.textMuted, fontSize: 15, marginBottom: 24 }}>{t("savedJobs.subtitleCount").replace("{n}", savedJobs.length)}</p>

      {visibleQueue.length > 0 && (
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 12 }}>{t("savedJobs.smartApplyQueue")}</div>
          {queueError && <div style={{ background: C.redLight, border: `1px solid ${C.red}30`, borderRadius: 9, padding: 12, color: C.red, fontSize: 13, marginBottom: 12 }}>{queueError}</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {visibleQueue.map(item => (
              <SmartApplyQueueCard key={item.id} item={item} onApply={handleMarkApplied} onSkip={handleSkip} applying={applyingId === item.id} />
            ))}
          </div>
        </div>
      )}

      {savedJobs.length === 0 && <Card style={{ textAlign: "center", padding: 64 }}><div style={{ fontSize: 48, marginBottom: 16 }}>♡</div><div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t("savedJobs.emptyTitle")}</div><div style={{ fontSize: 14, color: C.textMuted }}>{t("savedJobs.emptyBody")}</div></Card>}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {savedJobs.map(job => (
          <Card key={job.job_id}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 4 }}>{job.title}</div>
                <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 8 }}>{job.company} · {job.location}</div>
                <div style={{ fontSize: 14, color: C.green, fontWeight: 600, marginBottom: 8 }}>{fmtSalary(job.salaryMin, job.salaryMax)}</div>
                <div style={{ display: "flex", gap: 6 }}>{job.remote && <Badge color={C.green}>🌐 {t("savedJobs.remote")}</Badge>}{job.employmentType && <Badge color={C.textMuted}>{job.employmentType}</Badge>}{job.matchScore && <Badge color={C.purple}>{job.matchScore}{t("savedJobs.matchSuffix")}</Badge>}</div>
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
                <a href={job.applyUrl} target="_blank" rel="noreferrer" className="btn-link" style={{ background: `linear-gradient(135deg,${C.purple},${C.purpleMid})`, color: "#fff", border: "none", borderRadius: 10, padding: "11px 22px", fontSize: 14, fontWeight: 700, textDecoration: "none", textAlign: "center", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 7, transition: "all 0.15s" }}>{t("savedJobs.applyNow")}</a>
                <Btn variant="secondary" onClick={() => addTracker(job)}>{t("savedJobs.track")}</Btn>
                <Btn variant="danger" onClick={() => remove(job.job_id)}>{t("savedJobs.remove")}</Btn>
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
  const { user, logout, recoveryMode, clearRecovery } = useAuth();
  const [profile, setProfile] = useState(() => { try { return JSON.parse(localStorage.getItem("cp_user") || "null"); } catch { return null; } });
  const [applications, setApplications] = useApplications(user?.id);
  const [savedJobs, setSavedJobs] = useSavedJobs(user?.id);
  const validPages = new Set(["dashboard","resume","jobs","saved","interview","tracker","salary","network","pricing","profile","settings"]);

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
    window.scrollTo(0, 0);
    // Beat browser scroll restoration on refresh
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
    const t = setTimeout(() => window.scrollTo(0, 0), 50);
    return () => clearTimeout(t);
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

  const handleLogout = async () => { await logout(); setProfile(null); };
  const updateProfile = (updates) => {
    const updated = { ...profile, ...updates };
    setProfile(updated);
    localStorage.setItem("cp_user", JSON.stringify(updated));
    saveAccount(updated);
    if (updated.id) upsertProfile(updated.id, updates).catch(() => {});
  };
  const handleSaveApp = (app) => setApplications(p => [app, ...p]);
  const goHome = () => setPage("dashboard");

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
    { id: "pricing", icon: "💎", label: t("nav.pricing") },
  ];
  const planName = (profile?.plan || "free").toUpperCase();
  const { notifications, refresh: refreshNotifications, markAllRead } = useNotifications(profile?.id);

  if (recoveryMode) return <ResetPasswordPage onDone={() => { clearRecovery(); window.history.replaceState({}, "", window.location.pathname); }} />;
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
        @media (max-width: 700px) {
  .two-col, .three-col { grid-template-columns: 1fr !important; }
  .hero-section { margin-bottom: 10px !important; }
  .hero-greeting { font-size: 22px !important; margin-bottom: 2px !important; }
  .hero-subtitle { font-size: 12px !important; }
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
  .hamburger-btn { display: none !important; }
  .subscription-badge { display: none !important; }
  .desktop-nav { display: flex !important; }
}
@media (min-width: 1025px) {
  header { display: grid !important; grid-template-columns: auto 1fr auto !important; align-items: center !important; padding: 8px 14px !important; column-gap: 8px !important; }
  .mobile-logo-row { display: contents !important; }
  .logo-block { grid-column: 1 !important; flex: 0 0 auto !important; justify-content: flex-start !important; white-space: nowrap !important; gap: 7px !important; }
  .brand-logo { width: 38px !important; height: 38px !important; }
  .brand-logo-glyph { font-size: 17px !important; }
  .brand-name { font-size: 20px !important; }
  .brand-name-badge { font-size: 13px !important; margin-left: 0 !important; }
  .desktop-nav { display: contents !important; }
  .nav-pills { justify-self: center !important; max-width: 100% !important; min-width: 0 !important; justify-content: center !important; gap: 2px !important; padding: 3px !important; overflow-x: auto !important; overflow-y: hidden !important; scrollbar-width: none !important; -ms-overflow-style: none !important; }
  .nav-pills::-webkit-scrollbar { display: none !important; }
  .nav-pills button { padding: 6px 10px !important; font-size: 11.5px !important; gap: 4px !important; flex: 0 0 auto !important; }
  .nav-pills button span:first-child { font-size: 13px !important; }
  .nav-utility { gap: 0 !important; }
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
      <main style={{ maxWidth: 1160, margin: "0 auto", padding: "32px 24px 80px" }}>
        {page === "dashboard" && <DashboardPage profile={profile} applications={applications} savedJobs={savedJobs} setPage={setPage} />}
        {page === "resume" && <ResumePage onSave={handleSaveApp} onNavigate={setPage} profile={profile} />}
        {page === "jobs" && <JobSearchPage savedJobs={savedJobs} setSavedJobs={setSavedJobs} setApplications={setApplications} profile={profile} />}
        {page === "saved" && <SavedJobsPage savedJobs={savedJobs} setSavedJobs={setSavedJobs} setApplications={setApplications} profile={profile} />}
        {page === "interview" && <InterviewPage profile={profile} />}
        {page === "tracker" && <TrackerPage applications={applications} setApplications={setApplications} />}
        {page === "salary" && <SalaryPage profile={profile} />}
        {page === "network" && <NetworkingPage profile={profile} />}
        {page === "pricing" && <PricingPage profile={profile} />}
        {page === "settings" && <SettingsPage profile={profile} updateProfile={updateProfile} logout={handleLogout} setPage={setPage} />}
        {page === "profile" && <ProfilePage profile={profile} updateProfile={updateProfile} />}
      </main>
    </div>
    </I18nContext.Provider>
  );
}

// v4.1 - fast prompts update

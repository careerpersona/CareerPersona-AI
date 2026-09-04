import { useState } from "react";
import { useAdminAuth } from "./useAdminAuth.js";
import { ACCENT, BG, SURFACE as CARD, BORDER, TEXT, MUTED, DANGER } from "./lib/theme.js";

export default function LoginPage() {
  const { login } = useAdminAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) { setError("Email and password are required."); return; }
    setLoading(true);
    setError("");
    const result = await login(email, password);
    setLoading(false);
    if (!result.ok) setError(result.message);
    // On success, AdminAuthProvider's onAuthStateChange listener takes over
    // (checking_admin -> authorized/unauthorized) -- nothing else to do here.
  };

  return (
    <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>
      <form onSubmit={handleSubmit} style={{ width: "100%", maxWidth: 380, background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: "36px 32px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: ACCENT, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, color: "#fff", flexShrink: 0 }}>CP</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: TEXT }}>CareerPersona AI</div>
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: MUTED, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 28 }}>Back Office</div>

        <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: MUTED, marginBottom: 6 }}>Email</label>
        <input
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          disabled={loading}
          style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", marginBottom: 16, borderRadius: 8, border: `1px solid ${BORDER}`, background: "#15131E", color: TEXT, fontSize: 14, outline: "none" }}
        />

        <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: MUTED, marginBottom: 6 }}>Password</label>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={loading}
          style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", marginBottom: error ? 12 : 22, borderRadius: 8, border: `1px solid ${BORDER}`, background: "#15131E", color: TEXT, fontSize: 14, outline: "none" }}
        />

        {error && (
          <div style={{ fontSize: 12.5, color: DANGER, background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.25)", borderRadius: 8, padding: "8px 10px", marginBottom: 16 }}>
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          style={{ width: "100%", padding: "11px", borderRadius: 8, border: "none", background: loading ? "#5B3FA0" : ACCENT, color: "#fff", fontSize: 14, fontWeight: 700, cursor: loading ? "default" : "pointer" }}
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>

        <div style={{ fontSize: 11.5, color: MUTED, marginTop: 20, lineHeight: 1.6 }}>
          Staff sign-in only. This uses the same account as careerpersonaai.com — being a customer does not grant Back Office access.
        </div>
      </form>
    </div>
  );
}

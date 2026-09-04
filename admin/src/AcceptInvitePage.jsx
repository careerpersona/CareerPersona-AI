import { useState, useEffect } from "react";
import { supabase } from "./lib/supabaseClient.js";
import { ACCENT, BG, SURFACE as CARD, BORDER, TEXT, MUTED, DANGER, SUCCESS } from "./lib/theme.js";

const WORKER_URL = "https://proxy.dawn-voice-2790.workers.dev";

// Staff Invitation & Onboarding: rendered BEFORE the normal AdminAuthProvider
// gate (see App.jsx) -- an invitee has no staff row yet, so the normal gate
// would show AccessDeniedPage even after they set a password. This page
// owns its own short-lived flow instead: redeem the one-time token
// (verifyOtp, the same redirect-free pattern already proven for True
// Customer Impersonation and confirmed live for invite-type tokens), let
// them set their own real password, then call the Worker's accept-invite
// endpoint to create their staff row. Only once that succeeds does the app
// reload into the normal, now-actually-authorized Back Office.
export default function AcceptInvitePage({ tokenHash }) {
  const [step, setStep] = useState("redeeming"); // redeeming | set-password | finishing | done | error
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [role, setRole] = useState(null);

  useEffect(() => {
    if (!tokenHash) { setStep("error"); setError("This invitation link is missing its token."); return; }
    supabase.auth.verifyOtp({ token_hash: tokenHash, type: "invite" }).then(({ error: err }) => {
      if (err) {
        setStep("error");
        setError("This invitation link is invalid or has expired. Ask a superadmin to send a new one.");
        return;
      }
      setStep("set-password");
    });
  }, [tokenHash]);

  const handleSetPassword = async (e) => {
    e.preventDefault();
    if (!password || password.length < 6) { setError("Choose a password with at least 6 characters."); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }
    setStep("finishing");
    setError("");

    const { error: updateErr } = await supabase.auth.updateUser({ password });
    if (updateErr) {
      setStep("set-password");
      setError("Couldn't set your password. Try again.");
      return;
    }

    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData?.session?.access_token;
    if (!accessToken) {
      setStep("error");
      setError("Your session expired partway through. Ask a superadmin to send a new invitation.");
      return;
    }

    try {
      const res = await fetch(`${WORKER_URL}/api/admin/staff/accept-invite`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await res.json();
      if (!res.ok) {
        setStep("error");
        setError(
          body?.error === "no_pending_invitation"
            ? "This invitation is no longer valid. Ask a superadmin to send a new one."
            : body?.error === "already_staff"
              ? "This account already has Back Office access — you can just sign in."
              : "Couldn't finish setting up your account. Try again or ask a superadmin for help."
        );
        return;
      }
      setRole(body.role);
      setStep("done");
    } catch {
      setStep("error");
      setError("Couldn't reach the Back Office. Check your connection and try again.");
    }
  };

  const goToSignIn = () => {
    window.location.hash = "";
    window.location.search = "";
    window.location.reload();
  };

  return (
    <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>
      <div style={{ width: "100%", maxWidth: 380, background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: "36px 32px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
          <div style={{ width: 30, height: 30, borderRadius: 8, background: ACCENT, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14, fontWeight: 800, color: "#fff", flexShrink: 0 }}>CP</div>
          <div style={{ fontSize: 15, fontWeight: 700, color: TEXT }}>CareerPersona AI</div>
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: MUTED, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 28 }}>Back Office invitation</div>

        {step === "redeeming" && <div style={{ color: MUTED, fontSize: 13.5 }}>Verifying your invitation…</div>}

        {(step === "set-password" || step === "finishing") && (
          <form onSubmit={handleSetPassword}>
            <div style={{ fontSize: 13.5, color: TEXT, marginBottom: 18 }}>Set a password to finish setting up your Back Office account.</div>
            <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: MUTED, marginBottom: 6 }}>Password</label>
            <input
              type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}
              disabled={step === "finishing"}
              style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", marginBottom: 16, borderRadius: 8, border: `1px solid ${BORDER}`, background: "#15131E", color: TEXT, fontSize: 14, outline: "none" }}
            />
            <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: MUTED, marginBottom: 6 }}>Confirm password</label>
            <input
              type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              disabled={step === "finishing"}
              style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px", marginBottom: error ? 12 : 22, borderRadius: 8, border: `1px solid ${BORDER}`, background: "#15131E", color: TEXT, fontSize: 14, outline: "none" }}
            />
            {error && (
              <div style={{ fontSize: 12.5, color: DANGER, background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.25)", borderRadius: 8, padding: "8px 10px", marginBottom: 16 }}>{error}</div>
            )}
            <button
              type="submit" disabled={step === "finishing"}
              style={{ width: "100%", padding: "11px", borderRadius: 8, border: "none", background: step === "finishing" ? "#5B3FA0" : ACCENT, color: "#fff", fontSize: 14, fontWeight: 700, cursor: step === "finishing" ? "default" : "pointer" }}
            >
              {step === "finishing" ? "Setting up your account…" : "Set password and continue"}
            </button>
          </form>
        )}

        {step === "done" && (
          <div>
            <div style={{ fontSize: 13.5, color: SUCCESS, marginBottom: 8, fontWeight: 700 }}>You're all set!</div>
            <div style={{ fontSize: 13, color: MUTED, marginBottom: 20 }}>Your Back Office account is ready with the {role} role.</div>
            <button onClick={goToSignIn} style={{ width: "100%", padding: "11px", borderRadius: 8, border: "none", background: ACCENT, color: "#fff", fontSize: 14, fontWeight: 700, cursor: "pointer" }}>
              Continue to the Back Office
            </button>
          </div>
        )}

        {step === "error" && (
          <div>
            <div style={{ fontSize: 12.5, color: DANGER, background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.25)", borderRadius: 8, padding: "8px 10px", marginBottom: 18 }}>{error}</div>
            <button onClick={goToSignIn} style={{ width: "100%", padding: "11px", borderRadius: 8, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              Go to sign in
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

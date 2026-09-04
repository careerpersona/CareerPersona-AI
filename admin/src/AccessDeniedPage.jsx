import { useAdminAuth } from "./useAdminAuth.js";
import { BG, SURFACE as CARD, BORDER, TEXT, MUTED } from "./lib/theme.js";

// Shown when the caller has a valid, authenticated Supabase session but the
// Worker's /api/admin/session returned 403 (no active `staff` row). This is
// deliberately distinct from the login page -- the person IS who they say
// they are, they just aren't staff. Conflating this with a login failure
// would be misleading (retyping a password fixes nothing here).
export default function AccessDeniedPage() {
  const { email, logout } = useAdminAuth();

  return (
    <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>
      <div style={{ width: "100%", maxWidth: 400, background: CARD, border: `1px solid ${BORDER}`, borderRadius: 14, padding: "36px 32px", textAlign: "center" }}>
        <div style={{ width: 44, height: 44, borderRadius: "50%", background: "rgba(139,92,246,0.12)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px", fontSize: 20 }}>🔒</div>
        <div style={{ fontSize: 17, fontWeight: 700, color: TEXT, marginBottom: 8 }}>Access denied</div>
        <div style={{ fontSize: 13.5, color: MUTED, lineHeight: 1.6, marginBottom: 22 }}>
          {email ? <><b style={{ color: TEXT }}>{email}</b> is signed in, but has</> : "This account has"} no Back Office access. If you believe this is a mistake, contact a Back Office superadmin.
        </div>
        <button
          onClick={logout}
          style={{ width: "100%", padding: "11px", borderRadius: 8, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 14, fontWeight: 600, cursor: "pointer" }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

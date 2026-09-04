import { ACCENT, BG, TEXT, MUTED, BORDER } from "./lib/theme.js";

// Shared centered-message screen for the two transient, non-final states:
// "loading" (checking for an existing session / verifying staff status) and
// "error" (the staff check itself failed -- network/server issue, not a
// denial, so it offers Retry rather than routing to LoginPage/AccessDenied).
export default function StatusScreen({ message, retry }) {
  return (
    <div style={{ minHeight: "100vh", background: BG, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" }}>
      <div style={{ textAlign: "center", maxWidth: 340 }}>
        {!retry && (
          <div style={{ width: 22, height: 22, margin: "0 auto 16px", border: `2.5px solid ${BORDER}`, borderTopColor: ACCENT, borderRadius: "50%", animation: "admin-spin 0.7s linear infinite" }} />
        )}
        <div style={{ fontSize: 13.5, color: MUTED, lineHeight: 1.6 }}>{message}</div>
        {retry && (
          <button
            onClick={retry}
            style={{ marginTop: 18, padding: "9px 20px", borderRadius: 8, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 13.5, fontWeight: 600, cursor: "pointer" }}
          >
            Try again
          </button>
        )}
      </div>
      <style>{"@keyframes admin-spin{to{transform:rotate(360deg)}}"}</style>
    </div>
  );
}

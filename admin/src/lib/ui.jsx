import { BORDER, TEXT, MUTED, SURFACE } from "./theme.js";

// Shared presentational primitives -- extracted once CustomerBillingPage
// (Work Order 4) needed the same card/field layout CustomerDetailPage
// (Work Order 3) already used, rather than duplicating them a second time.

export function Card({ title, children }) {
  return (
    <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "18px 20px", marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: MUTED, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 14 }}>{title}</div>
      {children}
    </div>
  );
}

export function Field({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11.5, color: MUTED, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13.5, color: TEXT }}>{value || "—"}</div>
    </div>
  );
}

export function FieldGrid({ children }) {
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 16 }}>{children}</div>;
}

export function StatusBreakdown({ byStatus }) {
  const entries = Object.entries(byStatus);
  if (entries.length === 0) return <div style={{ fontSize: 12.5, color: MUTED }}>None yet.</div>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {entries.map(([status, count]) => (
        <span key={status} style={{ fontSize: 12, color: TEXT, background: "#221E30", border: `1px solid ${BORDER}`, borderRadius: 999, padding: "4px 10px" }}>
          {status}: <b>{count}</b>
        </span>
      ))}
    </div>
  );
}

import { useState, useEffect, useCallback, useRef } from "react";
import { useAdminAuth, hasRole } from "./useAdminAuth.js";
import { fetchCustomers } from "./lib/adminApi.js";
import { formatDate } from "./lib/format.js";
import { BORDER, TEXT, MUTED, SURFACE, ACCENT, DANGER, WARNING } from "./lib/theme.js";

const PAGE_SIZE = 25;

const PLAN_COLOR = { Free: MUTED, Pro: ACCENT, Premium: "#F0ABFC", Admin: "#38BDF8" };

function PlanBadge({ plan }) {
  const color = PLAN_COLOR[plan] || MUTED;
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color, background: `${color}20`, borderRadius: 999, padding: "3px 9px" }}>
      {plan}
    </span>
  );
}

function StatusCell({ billingState, deletionStatus }) {
  const cancelling = billingState.includes("CANCELING");
  const pastDue = billingState.includes("PAST_DUE");
  const expired = billingState.includes("EXPIRED");
  let color = MUTED;
  if (deletionStatus === "scheduled" || deletionStatus === "in_progress") color = DANGER;
  else if (pastDue || expired) color = DANGER;
  else if (cancelling) color = WARNING;
  else if (billingState !== "FREE") color = "#4ADE80";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 12.5, color, fontWeight: 600 }}>{billingState.replace(/_/g, " ")}</span>
      {(deletionStatus === "scheduled" || deletionStatus === "in_progress") && (
        <span style={{ fontSize: 11, color: DANGER }}>Deletion {deletionStatus.replace("_", " ")}</span>
      )}
    </div>
  );
}

// Customer directory: search + pagination + a clickable list. This is the
// only entry point into a customer's data -- View/search/open-detail are
// the sole actions this Work Order builds (no edit, no mutation of any kind).
export default function CustomerListPage({ onOpenCustomer }) {
  const { accessToken, role } = useAdminAuth();
  // billing_ops gets a trimmed row shape server-side (id/name/email/plan/
  // status only, no deletionStatus/createdAt/profileUpdatedAt -- see
  // handleAdminCustomerList's isLookupOnly branch) -- show fewer columns
  // rather than rendering blank/dashed ones for data this role never
  // receives.
  const hasFullLookup = hasRole(role, ["support"]);
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ status: "loading", customers: [], total: 0, totalPages: 1 });
  const requestId = useRef(0);

  useEffect(() => {
    const id = setTimeout(() => { setDebouncedQ(q); setPage(1); }, 350);
    return () => clearTimeout(id);
  }, [q]);

  const load = useCallback(async () => {
    const myRequest = ++requestId.current;
    setState((s) => ({ ...s, status: "loading" }));
    const result = await fetchCustomers(accessToken, { q: debouncedQ, page, pageSize: PAGE_SIZE });
    if (requestId.current !== myRequest) return; // superseded by a newer search/page change

    if (!result.ok) {
      setState((s) => ({ ...s, status: "error" }));
      return;
    }
    const { customers, total, totalPages } = result.data;
    setState({ status: customers.length === 0 ? "empty" : "ready", customers, total, totalPages });
  }, [accessToken, debouncedQ, page]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 700, color: TEXT, marginBottom: 4 }}>Customers</div>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 20 }}>
        {state.status === "ready" || state.status === "empty" ? `${state.total} total` : " "}
      </div>

      <input
        type="text"
        placeholder="Search by name or email…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ width: "100%", maxWidth: 380, boxSizing: "border-box", padding: "9px 12px", marginBottom: 20, borderRadius: 8, border: `1px solid ${BORDER}`, background: "#15131E", color: TEXT, fontSize: 14, outline: "none" }}
      />

      {state.status === "loading" && (
        <div style={{ padding: "48px 0", textAlign: "center", color: MUTED, fontSize: 13.5 }}>Loading customers…</div>
      )}

      {state.status === "error" && (
        <div style={{ padding: "48px 0", textAlign: "center" }}>
          <div style={{ color: DANGER, fontSize: 13.5, marginBottom: 12 }}>Couldn't load customers. Check your connection and try again.</div>
          <button onClick={load} style={{ padding: "8px 18px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            Try again
          </button>
        </div>
      )}

      {state.status === "empty" && (
        <div style={{ padding: "48px 0", textAlign: "center", color: MUTED, fontSize: 13.5 }}>
          {debouncedQ ? `No customers match "${debouncedQ}".` : "No customers yet."}
        </div>
      )}

      {state.status === "ready" && (
        <>
          <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
              <thead>
                <tr style={{ background: SURFACE }}>
                  {(hasFullLookup ? ["Customer", "Plan", "Status", "Signed up", "Profile updated", ""] : ["Customer", "Plan", "Status", ""]).map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "10px 14px", fontSize: 11, fontWeight: 700, color: MUTED, letterSpacing: "0.04em", textTransform: "uppercase", borderBottom: `1px solid ${BORDER}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.customers.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => onOpenCustomer(c.id)}
                    style={{ cursor: "pointer", borderBottom: `1px solid ${BORDER}` }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = SURFACE)}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <td style={{ padding: "12px 14px" }}>
                      <div style={{ color: TEXT, fontWeight: 600 }}>{c.fullName || "(no name)"}</div>
                      <div style={{ color: MUTED, fontSize: 12.5 }}>{c.email}</div>
                    </td>
                    <td style={{ padding: "12px 14px" }}><PlanBadge plan={c.plan} /></td>
                    <td style={{ padding: "12px 14px" }}><StatusCell billingState={c.billingState} deletionStatus={c.deletionStatus} /></td>
                    {hasFullLookup && <td style={{ padding: "12px 14px", color: MUTED }}>{formatDate(c.createdAt)}</td>}
                    {hasFullLookup && <td style={{ padding: "12px 14px", color: MUTED }}>{formatDate(c.profileUpdatedAt)}</td>}
                    <td style={{ padding: "12px 14px", textAlign: "right", color: ACCENT, fontSize: 12.5, fontWeight: 600 }}>View →</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16 }}>
            <div style={{ fontSize: 12.5, color: MUTED }}>Page {page} of {state.totalPages}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                style={{ padding: "6px 14px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: page <= 1 ? MUTED : TEXT, fontSize: 12.5, fontWeight: 600, cursor: page <= 1 ? "default" : "pointer" }}
              >
                Previous
              </button>
              <button
                onClick={() => setPage((p) => Math.min(state.totalPages, p + 1))}
                disabled={page >= state.totalPages}
                style={{ padding: "6px 14px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: page >= state.totalPages ? MUTED : TEXT, fontSize: 12.5, fontWeight: 600, cursor: page >= state.totalPages ? "default" : "pointer" }}
              >
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

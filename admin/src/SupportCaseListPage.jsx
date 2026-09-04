import { useState, useEffect, useCallback, useRef } from "react";
import { useAdminAuth } from "./useAdminAuth.js";
import { fetchSupportCases } from "./lib/adminApi.js";
import { formatDate } from "./lib/format.js";
import { BORDER, TEXT, MUTED, SURFACE, ACCENT, DANGER } from "./lib/theme.js";
import { StatusBadge, PriorityBadge } from "./lib/supportCaseBadges.jsx";

const PAGE_SIZE = 25;

// Case directory: search + status/priority filter + pagination. Mirrors
// CustomerListPage's shape (Work Order 3) rather than inventing a new list
// pattern.
export default function SupportCaseListPage({ onOpenCase, onNewCase }) {
  const { accessToken } = useAdminAuth();
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [status, setStatus] = useState("");
  const [priority, setPriority] = useState("");
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ status: "loading", cases: [], total: 0, totalPages: 1 });
  const requestId = useRef(0);

  useEffect(() => {
    const id = setTimeout(() => { setDebouncedQ(q); setPage(1); }, 350);
    return () => clearTimeout(id);
  }, [q]);
  useEffect(() => { setPage(1); }, [status, priority]);

  const load = useCallback(async () => {
    const myRequest = ++requestId.current;
    setState((s) => ({ ...s, status: "loading" }));
    const result = await fetchSupportCases(accessToken, { q: debouncedQ, status, priority, page, pageSize: PAGE_SIZE });
    if (requestId.current !== myRequest) return;
    if (!result.ok) { setState((s) => ({ ...s, status: "error" })); return; }
    const { cases, total, totalPages } = result.data;
    setState({ status: cases.length === 0 ? "empty" : "ready", cases, total, totalPages });
  }, [accessToken, debouncedQ, status, priority, page]);

  useEffect(() => { load(); }, [load]);

  const selectStyle = { padding: "8px 10px", borderRadius: 8, border: `1px solid ${BORDER}`, background: "#15131E", color: TEXT, fontSize: 13, outline: "none" };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 4, gap: 16 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: TEXT }}>Support Cases</div>
          <div style={{ fontSize: 13, color: MUTED }}>{state.status === "ready" || state.status === "empty" ? `${state.total} total` : " "}</div>
        </div>
        <button
          onClick={onNewCase}
          style={{ flexShrink: 0, padding: "8px 16px", borderRadius: 8, border: "none", background: ACCENT, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
        >
          + New case
        </button>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "16px 0 20px" }}>
        <input
          type="text"
          placeholder="Search by subject…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ flex: "1 1 220px", boxSizing: "border-box", padding: "9px 12px", borderRadius: 8, border: `1px solid ${BORDER}`, background: "#15131E", color: TEXT, fontSize: 14, outline: "none" }}
        />
        <select value={status} onChange={(e) => setStatus(e.target.value)} style={selectStyle}>
          <option value="">All statuses</option>
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="resolved">Resolved</option>
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} style={selectStyle}>
          <option value="">All priorities</option>
          <option value="low">Low</option>
          <option value="normal">Normal</option>
          <option value="high">High</option>
          <option value="urgent">Urgent</option>
        </select>
      </div>

      {state.status === "loading" && (
        <div style={{ padding: "48px 0", textAlign: "center", color: MUTED, fontSize: 13.5 }}>Loading cases…</div>
      )}

      {state.status === "error" && (
        <div style={{ padding: "48px 0", textAlign: "center" }}>
          <div style={{ color: DANGER, fontSize: 13.5, marginBottom: 12 }}>Couldn't load cases. Check your connection and try again.</div>
          <button onClick={load} style={{ padding: "8px 18px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            Try again
          </button>
        </div>
      )}

      {state.status === "empty" && (
        <div style={{ padding: "48px 0", textAlign: "center", color: MUTED, fontSize: 13.5 }}>
          {debouncedQ || status || priority ? "No cases match these filters." : "No support cases yet."}
        </div>
      )}

      {state.status === "ready" && (
        <>
          <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
              <thead>
                <tr style={{ background: SURFACE }}>
                  {["Subject", "Customer", "Status", "Priority", "Assigned to", "Created", ""].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "10px 14px", fontSize: 11, fontWeight: 700, color: MUTED, letterSpacing: "0.04em", textTransform: "uppercase", borderBottom: `1px solid ${BORDER}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {state.cases.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() => onOpenCase(c.id)}
                    style={{ cursor: "pointer", borderBottom: `1px solid ${BORDER}` }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = SURFACE)}
                    onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                  >
                    <td style={{ padding: "12px 14px", color: TEXT, fontWeight: 600 }}>{c.subject}</td>
                    <td style={{ padding: "12px 14px" }}>
                      <div style={{ color: TEXT }}>{c.customer?.fullName || "(no name)"}</div>
                      <div style={{ color: MUTED, fontSize: 12.5 }}>{c.customer?.email}</div>
                    </td>
                    <td style={{ padding: "12px 14px" }}><StatusBadge status={c.status} /></td>
                    <td style={{ padding: "12px 14px" }}><PriorityBadge priority={c.priority} /></td>
                    <td style={{ padding: "12px 14px", color: MUTED }}>{c.assignedToName || "Unassigned"}</td>
                    <td style={{ padding: "12px 14px", color: MUTED }}>{formatDate(c.createdAt)}</td>
                    <td style={{ padding: "12px 14px", textAlign: "right", color: ACCENT, fontSize: 12.5, fontWeight: 600 }}>View →</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 16 }}>
            <div style={{ fontSize: 12.5, color: MUTED }}>Page {page} of {state.totalPages}</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
                style={{ padding: "6px 14px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: page <= 1 ? MUTED : TEXT, fontSize: 12.5, fontWeight: 600, cursor: page <= 1 ? "default" : "pointer" }}>
                Previous
              </button>
              <button onClick={() => setPage((p) => Math.min(state.totalPages, p + 1))} disabled={page >= state.totalPages}
                style={{ padding: "6px 14px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: page >= state.totalPages ? MUTED : TEXT, fontSize: 12.5, fontWeight: 600, cursor: page >= state.totalPages ? "default" : "pointer" }}>
                Next
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

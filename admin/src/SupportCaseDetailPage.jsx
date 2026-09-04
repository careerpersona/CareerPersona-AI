import { useState, useEffect, useCallback } from "react";
import { useAdminAuth } from "./useAdminAuth.js";
import { fetchSupportCaseDetail, updateSupportCase, addSupportCaseNote, fetchStaffRoster } from "./lib/adminApi.js";
import { formatDateTime } from "./lib/format.js";
import { BORDER, TEXT, MUTED, ACCENT, DANGER } from "./lib/theme.js";
import { Card, Field, FieldGrid } from "./lib/ui.jsx";
import { StatusBadge, PriorityBadge } from "./lib/supportCaseBadges.jsx";

const selectStyle = { padding: "8px 10px", borderRadius: 8, border: `1px solid ${BORDER}`, background: "#15131E", color: TEXT, fontSize: 13, outline: "none" };

export default function SupportCaseDetailPage({ caseId, onBack, onOpenCustomer }) {
  const { accessToken, userId: myUserId } = useAdminAuth();
  const [state, setState] = useState({ status: "loading", data: null });
  const [staff, setStaff] = useState([]);
  const [savingField, setSavingField] = useState(null);
  const [saveError, setSaveError] = useState("");
  const [noteText, setNoteText] = useState("");
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState("");

  const load = useCallback(async () => {
    setState({ status: "loading", data: null });
    const result = await fetchSupportCaseDetail(accessToken, caseId);
    if (!result.ok) { setState({ status: result.reason === "not_found" ? "not_found" : "error", data: null }); return; }
    setState({ status: "ready", data: result.data });
  }, [accessToken, caseId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetchStaffRoster(accessToken).then((r) => { if (r.ok) setStaff(r.data.staff); });
  }, [accessToken]);

  const applyUpdate = async (patch, fieldKey) => {
    setSavingField(fieldKey);
    setSaveError("");
    const result = await updateSupportCase(accessToken, { id: caseId, ...patch });
    setSavingField(null);
    if (!result.ok) { setSaveError("Couldn't save that change. Try again."); return; }
    setState((s) => ({ ...s, data: { ...s.data, ...result.data } }));
  };

  const handleAddNote = async (e) => {
    e.preventDefault();
    if (!noteText.trim()) return;
    setNoteSaving(true);
    setNoteError("");
    const result = await addSupportCaseNote(accessToken, { caseId, note: noteText.trim() });
    setNoteSaving(false);
    if (!result.ok) { setNoteError("Couldn't save the note. Try again."); return; }
    setNoteText("");
    setState((s) => ({ ...s, data: { ...s.data, notes: [...s.data.notes, result.data] } }));
  };

  return (
    <div>
      <button onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 18, padding: 0, border: "none", background: "transparent", color: MUTED, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
        ← Back to cases
      </button>

      {state.status === "loading" && <div style={{ padding: "48px 0", textAlign: "center", color: MUTED, fontSize: 13.5 }}>Loading case…</div>}
      {state.status === "not_found" && <div style={{ padding: "48px 0", textAlign: "center", color: MUTED, fontSize: 13.5 }}>This case couldn't be found.</div>}
      {state.status === "error" && (
        <div style={{ padding: "48px 0", textAlign: "center" }}>
          <div style={{ color: DANGER, fontSize: 13.5, marginBottom: 12 }}>Couldn't load this case. Check your connection and try again.</div>
          <button onClick={load} style={{ padding: "8px 18px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Try again</button>
        </div>
      )}

      {state.status === "ready" && (() => {
        const c = state.data;
        return (
          <>
            <div style={{ marginBottom: 20 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: TEXT }}>{c.subject}</div>
                <StatusBadge status={c.status} />
                <PriorityBadge priority={c.priority} />
              </div>
              <button
                onClick={() => onOpenCustomer(c.userId)}
                style={{ padding: 0, border: "none", background: "transparent", color: ACCENT, fontSize: 13, cursor: "pointer" }}
              >
                {c.customer?.fullName || c.customer?.email || c.userId} →
              </button>
            </div>

            <Card title="Status & assignment">
              <FieldGrid>
                <div>
                  <div style={{ fontSize: 11.5, color: MUTED, marginBottom: 4 }}>Status</div>
                  <select value={c.status} disabled={savingField === "status"} onChange={(e) => applyUpdate({ status: e.target.value }, "status")} style={selectStyle}>
                    <option value="open">Open</option>
                    <option value="in_progress">In progress</option>
                    <option value="resolved">Resolved</option>
                  </select>
                </div>
                <div>
                  <div style={{ fontSize: 11.5, color: MUTED, marginBottom: 4 }}>Priority</div>
                  <select value={c.priority} disabled={savingField === "priority"} onChange={(e) => applyUpdate({ priority: e.target.value }, "priority")} style={selectStyle}>
                    <option value="low">Low</option>
                    <option value="normal">Normal</option>
                    <option value="high">High</option>
                    <option value="urgent">Urgent</option>
                  </select>
                </div>
                <div>
                  <div style={{ fontSize: 11.5, color: MUTED, marginBottom: 4 }}>Assigned to</div>
                  <select
                    value={c.assignedTo || ""}
                    disabled={savingField === "assignedTo"}
                    onChange={(e) => applyUpdate({ assignedTo: e.target.value || null }, "assignedTo")}
                    style={selectStyle}
                  >
                    <option value="">Unassigned</option>
                    {staff.map((s) => (
                      <option key={s.userId} value={s.userId}>{s.fullName || s.email}{s.userId === myUserId ? " (me)" : ""}</option>
                    ))}
                  </select>
                </div>
              </FieldGrid>
              {saveError && <div style={{ fontSize: 12, color: DANGER, marginTop: 12 }}>{saveError}</div>}
            </Card>

            <Card title="Details">
              <FieldGrid>
                <Field label="Created by" value={c.createdByName || c.createdBy} />
                <Field label="Created" value={formatDateTime(c.createdAt)} />
                <Field label="Last updated" value={formatDateTime(c.updatedAt)} />
                <Field label="Resolved" value={c.resolvedAt ? formatDateTime(c.resolvedAt) : "Not resolved"} />
              </FieldGrid>
              {c.description && (
                <div style={{ marginTop: 16, fontSize: 13.5, color: TEXT, whiteSpace: "pre-wrap", borderTop: `1px solid ${BORDER}`, paddingTop: 12 }}>{c.description}</div>
              )}
            </Card>

            <Card title={`Internal notes (${c.notes.length})`}>
              <div style={{ fontSize: 11.5, color: MUTED, marginBottom: 14 }}>Staff-only — never visible to the customer.</div>
              {c.notes.length === 0 && <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 14 }}>No notes yet.</div>}
              <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
                {c.notes.map((n) => (
                  <div key={n.id} style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 10 }}>
                    <div style={{ fontSize: 11.5, color: MUTED, marginBottom: 4 }}>{n.authorName || n.authorId} · {formatDateTime(n.createdAt)}</div>
                    <div style={{ fontSize: 13.5, color: TEXT, whiteSpace: "pre-wrap" }}>{n.note}</div>
                  </div>
                ))}
              </div>
              <form onSubmit={handleAddNote}>
                <textarea
                  value={noteText}
                  onChange={(e) => setNoteText(e.target.value)}
                  disabled={noteSaving}
                  placeholder="Add an internal note…"
                  rows={3}
                  style={{ width: "100%", boxSizing: "border-box", padding: "9px 12px", borderRadius: 8, border: `1px solid ${BORDER}`, background: "#15131E", color: TEXT, fontSize: 14, outline: "none", resize: "vertical", fontFamily: "inherit" }}
                />
                {noteError && <div style={{ fontSize: 12, color: DANGER, marginTop: 8 }}>{noteError}</div>}
                <button
                  type="submit"
                  disabled={noteSaving || !noteText.trim()}
                  style={{ marginTop: 10, padding: "8px 18px", borderRadius: 8, border: "none", background: noteSaving || !noteText.trim() ? "#5B3FA0" : ACCENT, color: "#fff", fontSize: 13, fontWeight: 700, cursor: noteSaving || !noteText.trim() ? "default" : "pointer" }}
                >
                  {noteSaving ? "Adding…" : "Add note"}
                </button>
              </form>
            </Card>
          </>
        );
      })()}
    </div>
  );
}

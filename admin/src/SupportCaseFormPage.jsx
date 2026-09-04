import { useState } from "react";
import { useAdminAuth } from "./useAdminAuth.js";
import { createSupportCase } from "./lib/adminApi.js";
import { BORDER, TEXT, MUTED, ACCENT, DANGER } from "./lib/theme.js";
import { Card } from "./lib/ui.jsx";

const inputStyle = { width: "100%", boxSizing: "border-box", padding: "9px 12px", borderRadius: 8, border: `1px solid ${BORDER}`, background: "#15131E", color: TEXT, fontSize: 14, outline: "none", fontFamily: "inherit" };

// New-case form. Reached two ways: from a customer's detail page (userId
// pre-filled and locked -- the common path) or from the Support Cases list
// directly ("+ New case", userId typed in -- for when staff already has a
// customer id handy). No customer search/picker here; that's a bigger
// component this Work Order doesn't need to build.
export default function SupportCaseFormPage({ presetUserId, presetCustomerLabel, onCreated, onCancel }) {
  const { accessToken } = useAdminAuth();
  const [userId, setUserId] = useState(presetUserId || "");
  const [subject, setSubject] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("normal");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!userId.trim()) { setError("Customer ID is required."); return; }
    if (!subject.trim()) { setError("Subject is required."); return; }
    setLoading(true);
    setError("");
    const result = await createSupportCase(accessToken, { userId: userId.trim(), subject: subject.trim(), description: description.trim() || null, priority });
    setLoading(false);
    if (!result.ok) {
      setError(result.reason === "not_found" ? "No customer found with that ID." : "Couldn't create the case. Check your connection and try again.");
      return;
    }
    onCreated(result.data.id);
  };

  return (
    <div>
      <button onClick={onCancel} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 18, padding: 0, border: "none", background: "transparent", color: MUTED, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
        ← Cancel
      </button>
      <div style={{ fontSize: 20, fontWeight: 700, color: TEXT, marginBottom: 20 }}>New support case</div>

      <Card title="Case details">
        <form onSubmit={handleSubmit}>
          <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: MUTED, marginBottom: 6 }}>Customer ID</label>
          {presetUserId ? (
            <div style={{ ...inputStyle, marginBottom: 16, color: TEXT, display: "flex", justifyContent: "space-between" }}>
              <span>{presetCustomerLabel || presetUserId}</span>
            </div>
          ) : (
            <input type="text" value={userId} onChange={(e) => setUserId(e.target.value)} placeholder="Customer's user ID" disabled={loading} style={{ ...inputStyle, marginBottom: 16 }} />
          )}

          <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: MUTED, marginBottom: 6 }}>Subject</label>
          <input type="text" value={subject} onChange={(e) => setSubject(e.target.value)} disabled={loading} style={{ ...inputStyle, marginBottom: 16 }} />

          <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: MUTED, marginBottom: 6 }}>Description</label>
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} disabled={loading} rows={4} style={{ ...inputStyle, marginBottom: 16, resize: "vertical" }} />

          <label style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: MUTED, marginBottom: 6 }}>Priority</label>
          <select value={priority} onChange={(e) => setPriority(e.target.value)} disabled={loading} style={{ ...inputStyle, marginBottom: error ? 12 : 20, width: "auto" }}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
            <option value="urgent">Urgent</option>
          </select>

          {error && (
            <div style={{ fontSize: 12.5, color: DANGER, background: "rgba(248,113,113,0.1)", border: "1px solid rgba(248,113,113,0.25)", borderRadius: 8, padding: "8px 10px", marginBottom: 16 }}>
              {error}
            </div>
          )}

          <button type="submit" disabled={loading} style={{ padding: "10px 20px", borderRadius: 8, border: "none", background: loading ? "#5B3FA0" : ACCENT, color: "#fff", fontSize: 14, fontWeight: 700, cursor: loading ? "default" : "pointer" }}>
            {loading ? "Creating…" : "Create case"}
          </button>
        </form>
      </Card>
    </div>
  );
}

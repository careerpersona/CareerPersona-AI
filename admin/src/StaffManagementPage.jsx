import { useState, useEffect, useCallback, Fragment } from "react";
import { useAdminAuth, ROLE_LABELS } from "./useAdminAuth.js";
import { fetchStaffDirectory, updateStaff, inviteStaff, fetchStaffInvitations, revokeStaffInvitation } from "./lib/adminApi.js";
import { formatDate, formatDateTime } from "./lib/format.js";
import { BORDER, TEXT, MUTED, SURFACE, ACCENT, DANGER, SUCCESS } from "./lib/theme.js";

const STAFF_ROLES = ["support", "billing_ops", "superadmin"];

const ERROR_MESSAGES = {
  cannot_modify_own_access: "You can't change your own role or access. Ask another superadmin to make this change.",
  cannot_remove_last_superadmin: "This is the last active superadmin — role and access can't be removed until another superadmin exists.",
  invalid_role: "That's not a valid role.",
  invalid_active: "That's not a valid status.",
  not_found: "This staff member could no longer be found.",
};

const INVITE_ERROR_MESSAGES = {
  invalid_email: "Enter a valid email address.",
  invalid_role: "That's not a valid role.",
  email_already_registered: "That email already has an account. Inviting an existing account isn't supported yet.",
  invitation_failed: "Couldn't send the invitation. Try again.",
};

function errorMessageFor(result) {
  return ERROR_MESSAGES[result.errorCode] || "Couldn't save that change. Check your connection and try again.";
}

function inviteErrorMessageFor(result) {
  return INVITE_ERROR_MESSAGES[result.errorCode] || "Couldn't send the invitation. Check your connection and try again.";
}

function selectStyleFor() {
  return { padding: "7px 10px", borderRadius: 8, border: `1px solid ${BORDER}`, background: "#15131E", color: TEXT, fontSize: 13, outline: "none" };
}

function StatusPill({ active }) {
  const color = active ? SUCCESS : MUTED;
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color, background: `${color}20`, borderRadius: 999, padding: "3px 9px" }}>
      {active ? "Active" : "Inactive"}
    </span>
  );
}

// Staff Management (Work Order 9) -- superadmin only. One list, expandable
// per-row management panel (role change + activate/deactivate), each
// requiring an explicit second click before it fires. No detail page: a
// staff roster is small and operational, not the kind of record that needs
// its own page the way a customer or support case does.
export default function StaffManagementPage() {
  const { accessToken, userId: myUserId } = useAdminAuth();
  const [state, setState] = useState({ status: "loading", staff: [] });
  const [manage, setManage] = useState(null); // { userId, selectedRole, confirming: null|"role"|"active", loading, error }

  const [invites, setInvites] = useState({ status: "loading", invitations: [] });
  const [inviteForm, setInviteForm] = useState({ email: "", role: "support", loading: false, error: "" });
  const [revoking, setRevoking] = useState(null); // { userId, confirming, loading }

  const load = useCallback(async () => {
    setState((s) => ({ ...s, status: "loading" }));
    const result = await fetchStaffDirectory(accessToken);
    if (!result.ok) { setState({ status: "error", staff: [] }); return; }
    setState({ status: "ready", staff: result.data.staff });
  }, [accessToken]);

  const loadInvites = useCallback(async () => {
    setInvites((s) => ({ ...s, status: "loading" }));
    const result = await fetchStaffInvitations(accessToken);
    if (!result.ok) { setInvites({ status: "error", invitations: [] }); return; }
    setInvites({ status: "ready", invitations: result.data.invitations });
  }, [accessToken]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadInvites(); }, [loadInvites]);

  const submitInvite = async (e) => {
    e.preventDefault();
    setInviteForm((f) => ({ ...f, loading: true, error: "" }));
    const result = await inviteStaff(accessToken, inviteForm.email.trim(), inviteForm.role);
    if (!result.ok) {
      setInviteForm((f) => ({ ...f, loading: false, error: inviteErrorMessageFor(result) }));
      return;
    }
    setInviteForm({ email: "", role: "support", loading: false, error: "" });
    loadInvites();
  };

  const confirmRevoke = async (userId) => {
    setRevoking((r) => ({ ...r, loading: true }));
    const result = await revokeStaffInvitation(accessToken, userId);
    if (!result.ok) {
      setRevoking((r) => ({ ...r, loading: false }));
      return;
    }
    setInvites((s) => ({ ...s, invitations: s.invitations.filter((i) => i.userId !== userId) }));
    setRevoking(null);
  };

  const openManage = (row) => setManage({ userId: row.userId, selectedRole: row.role, confirming: null, loading: false, error: "" });
  const closeManage = () => setManage(null);

  const applyChange = async (patch) => {
    setManage((m) => ({ ...m, loading: true, error: "" }));
    const result = await updateStaff(accessToken, { staffUserId: manage.userId, ...patch });
    if (!result.ok) {
      setManage((m) => ({ ...m, loading: false, confirming: null, error: errorMessageFor(result) }));
      return;
    }
    setState((s) => ({
      ...s,
      staff: s.staff.map((row) => (row.userId === result.data.userId ? { ...row, role: result.data.role, active: result.data.active } : row)),
    }));
    closeManage();
  };

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color: TEXT }}>Staff</div>
        <div style={{ fontSize: 13, color: MUTED }}>{state.status === "ready" ? `${state.staff.length} total` : " "}</div>
      </div>

      <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, padding: "16px 18px", marginBottom: 24 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: TEXT, marginBottom: 12 }}>Invite staff</div>
        <form onSubmit={submitInvite} style={{ display: "flex", alignItems: "flex-start", gap: 10, flexWrap: "wrap" }}>
          <input
            type="email"
            required
            placeholder="name@company.com"
            value={inviteForm.email}
            disabled={inviteForm.loading}
            onChange={(e) => setInviteForm((f) => ({ ...f, email: e.target.value, error: "" }))}
            style={{ flex: "1 1 220px", padding: "7px 10px", borderRadius: 8, border: `1px solid ${BORDER}`, background: "#15131E", color: TEXT, fontSize: 13, outline: "none" }}
          />
          <select
            value={inviteForm.role}
            disabled={inviteForm.loading}
            onChange={(e) => setInviteForm((f) => ({ ...f, role: e.target.value, error: "" }))}
            style={selectStyleFor()}
          >
            {STAFF_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
          </select>
          <button
            type="submit"
            disabled={inviteForm.loading || !inviteForm.email.trim()}
            style={{ padding: "7px 16px", borderRadius: 8, border: "none", background: ACCENT, color: "#fff", fontSize: 13, fontWeight: 700, cursor: inviteForm.loading ? "default" : "pointer" }}
          >
            {inviteForm.loading ? "Sending…" : "Send invitation"}
          </button>
        </form>
        {inviteForm.error && <div style={{ fontSize: 12.5, color: DANGER, marginTop: 10 }}>{inviteForm.error}</div>}
      </div>

      {invites.status !== "error" && invites.invitations.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: TEXT, marginBottom: 10 }}>Pending invitations</div>
          <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
              <thead>
                <tr style={{ background: SURFACE }}>
                  {["Email", "Role", "Invited by", "Expires", ""].map((h) => (
                    <th key={h} style={{ textAlign: "left", padding: "10px 14px", fontSize: 11, fontWeight: 700, color: MUTED, letterSpacing: "0.04em", textTransform: "uppercase", borderBottom: `1px solid ${BORDER}` }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {invites.invitations.map((inv) => {
                  const isRevoking = revoking?.userId === inv.userId;
                  return (
                    <tr key={inv.userId} style={{ borderBottom: `1px solid ${BORDER}` }}>
                      <td style={{ padding: "12px 14px", color: TEXT }}>{inv.email}</td>
                      <td style={{ padding: "12px 14px", color: TEXT }}>{ROLE_LABELS[inv.role] || inv.role}</td>
                      <td style={{ padding: "12px 14px", color: MUTED }}>{inv.invitedByName || "—"}</td>
                      <td style={{ padding: "12px 14px", color: MUTED }}>{formatDate(inv.expiresAt)}</td>
                      <td style={{ padding: "12px 14px", textAlign: "right" }}>
                        {!isRevoking && (
                          <button
                            onClick={() => setRevoking({ userId: inv.userId, confirming: true, loading: false })}
                            style={{ padding: "6px 14px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: DANGER, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
                          >
                            Revoke
                          </button>
                        )}
                        {isRevoking && (
                          <span style={{ display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
                            <span style={{ fontSize: 12, color: TEXT }}>Revoke this invitation?</span>
                            <button
                              disabled={revoking.loading}
                              onClick={() => confirmRevoke(inv.userId)}
                              style={{ padding: "6px 12px", borderRadius: 7, border: "none", background: DANGER, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                            >
                              {revoking.loading ? "Revoking…" : "Confirm"}
                            </button>
                            <button
                              disabled={revoking.loading}
                              onClick={() => setRevoking(null)}
                              style={{ padding: "6px 12px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                            >
                              Cancel
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {state.status === "loading" && (
        <div style={{ padding: "48px 0", textAlign: "center", color: MUTED, fontSize: 13.5 }}>Loading staff…</div>
      )}

      {state.status === "error" && (
        <div style={{ padding: "48px 0", textAlign: "center" }}>
          <div style={{ color: DANGER, fontSize: 13.5, marginBottom: 12 }}>Couldn't load staff. Check your connection and try again.</div>
          <button onClick={load} style={{ padding: "8px 18px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            Try again
          </button>
        </div>
      )}

      {state.status === "ready" && (
        <div style={{ border: `1px solid ${BORDER}`, borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13.5 }}>
            <thead>
              <tr style={{ background: SURFACE }}>
                {["Staff member", "Role", "Status", "Granted", "Last sign-in", ""].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "10px 14px", fontSize: 11, fontWeight: 700, color: MUTED, letterSpacing: "0.04em", textTransform: "uppercase", borderBottom: `1px solid ${BORDER}` }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {state.staff.map((row) => {
                const isSelf = row.userId === myUserId;
                const isManaging = manage?.userId === row.userId;
                return (
                  <Fragment key={row.userId}>
                    <tr style={{ borderBottom: `1px solid ${BORDER}` }}>
                      <td style={{ padding: "12px 14px" }}>
                        <div style={{ color: TEXT, fontWeight: 600 }}>{row.fullName || "(no name)"}{isSelf ? " (you)" : ""}</div>
                        <div style={{ color: MUTED, fontSize: 12.5 }}>{row.email}</div>
                      </td>
                      <td style={{ padding: "12px 14px", color: TEXT }}>{ROLE_LABELS[row.role] || row.role}</td>
                      <td style={{ padding: "12px 14px" }}><StatusPill active={row.active} /></td>
                      <td style={{ padding: "12px 14px", color: MUTED }}>{formatDate(row.grantedAt)}</td>
                      <td style={{ padding: "12px 14px", color: MUTED }}>{row.lastSignInAt ? formatDateTime(row.lastSignInAt) : "Never"}</td>
                      <td style={{ padding: "12px 14px", textAlign: "right" }}>
                        <button
                          onClick={() => (isManaging ? closeManage() : openManage(row))}
                          style={{ padding: "6px 14px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: ACCENT, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
                        >
                          {isManaging ? "Close" : "Manage"}
                        </button>
                      </td>
                    </tr>
                    {isManaging && (
                      <tr style={{ borderBottom: `1px solid ${BORDER}`, background: "rgba(139,92,246,0.05)" }}>
                        <td colSpan={6} style={{ padding: "14px" }}>
                          {isSelf ? (
                            <div style={{ fontSize: 12.5, color: MUTED }}>
                              This is your own account — role and access changes must be made by another superadmin.
                            </div>
                          ) : (
                            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                                <span style={{ fontSize: 12.5, color: MUTED }}>Role:</span>
                                <select
                                  value={manage.selectedRole}
                                  disabled={manage.loading}
                                  onChange={(e) => setManage((m) => ({ ...m, selectedRole: e.target.value, confirming: null, error: "" }))}
                                  style={selectStyleFor()}
                                >
                                  {STAFF_ROLES.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                                </select>
                                {manage.selectedRole !== row.role && manage.confirming !== "role" && (
                                  <button
                                    onClick={() => setManage((m) => ({ ...m, confirming: "role" }))}
                                    style={{ padding: "6px 14px", borderRadius: 7, border: "none", background: ACCENT, color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}
                                  >
                                    Change role
                                  </button>
                                )}
                                {manage.confirming === "role" && (
                                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <span style={{ fontSize: 12.5, color: TEXT }}>Change role to {ROLE_LABELS[manage.selectedRole]}?</span>
                                    <button
                                      disabled={manage.loading}
                                      onClick={() => applyChange({ role: manage.selectedRole })}
                                      style={{ padding: "6px 12px", borderRadius: 7, border: "none", background: ACCENT, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                                    >
                                      {manage.loading ? "Saving…" : "Confirm"}
                                    </button>
                                    <button
                                      disabled={manage.loading}
                                      onClick={() => setManage((m) => ({ ...m, confirming: null, selectedRole: row.role }))}
                                      style={{ padding: "6px 12px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                                    >
                                      Cancel
                                    </button>
                                  </span>
                                )}
                              </div>

                              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", borderTop: `1px solid ${BORDER}`, paddingTop: 12 }}>
                                <span style={{ fontSize: 12.5, color: MUTED }}>Access:</span>
                                {manage.confirming !== "active" && (
                                  <button
                                    onClick={() => setManage((m) => ({ ...m, confirming: "active" }))}
                                    style={{ padding: "6px 14px", borderRadius: 7, border: `1px solid ${row.active ? DANGER : BORDER}`, background: "transparent", color: row.active ? DANGER : ACCENT, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
                                  >
                                    {row.active ? "Deactivate" : "Reactivate"}
                                  </button>
                                )}
                                {manage.confirming === "active" && (
                                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                    <span style={{ fontSize: 12.5, color: TEXT }}>
                                      {row.active ? "Deactivate this staff member? They'll immediately lose Back Office access." : "Reactivate this staff member?"}
                                    </span>
                                    <button
                                      disabled={manage.loading}
                                      onClick={() => applyChange({ active: !row.active })}
                                      style={{ padding: "6px 12px", borderRadius: 7, border: "none", background: row.active ? DANGER : ACCENT, color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
                                    >
                                      {manage.loading ? "Saving…" : "Confirm"}
                                    </button>
                                    <button
                                      disabled={manage.loading}
                                      onClick={() => setManage((m) => ({ ...m, confirming: null }))}
                                      style={{ padding: "6px 12px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 12, fontWeight: 600, cursor: "pointer" }}
                                    >
                                      Cancel
                                    </button>
                                  </span>
                                )}
                              </div>

                              {manage.error && <div style={{ fontSize: 12, color: DANGER }}>{manage.error}</div>}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

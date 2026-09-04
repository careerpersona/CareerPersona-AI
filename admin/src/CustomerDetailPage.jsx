import { useState, useEffect, useCallback } from "react";
import { useAdminAuth, hasRole } from "./useAdminAuth.js";
import {
  fetchCustomerDetail, cancelCustomerDeletion, scheduleCustomerDeletion,
  triggerPasswordReset, revokeCustomerSessions, updateCustomerProfile,
} from "./lib/adminApi.js";
import { formatDate, formatDateTime } from "./lib/format.js";
import { BORDER, TEXT, MUTED, ACCENT, DANGER, WARNING } from "./lib/theme.js";
import { Card, Field, FieldGrid, StatusBreakdown } from "./lib/ui.jsx";

// Deferred Fix #3: display labels for lastActivitySource, one per genuine
// event the Worker's lastActivity computation can select (sign_in,
// application, smart_apply -- see handleAdminCustomerDetail).
const ACTIVITY_SOURCE_LABEL = { sign_in: "sign-in", application: "application", smart_apply: "Smart Apply" };

// Work Order 5, item 3: "a clear way to identify account problems" -- built
// entirely from fields this endpoint already returns (deletion status,
// billing state). No new data, no new endpoint; just surfacing what's
// already there plainly instead of requiring a support agent to notice a
// worrying value buried in the Billing card.
function computeAccountIssues(profile, billing) {
  const issues = [];
  if (profile.deletionStatus === "scheduled" || profile.deletionStatus === "in_progress") {
    issues.push({
      severity: "critical",
      label: `Deletion ${profile.deletionStatus.replace("_", " ")}`,
      detail: `Scheduled purge ${formatDate(profile.deletionScheduledPurgeAt)}`,
    });
  }
  if (billing.billingState.includes("PAST_DUE")) {
    issues.push({ severity: "critical", label: "Payment past due", detail: "Subscription is in a past-due grace period." });
  } else if (billing.billingState.includes("EXPIRED")) {
    issues.push({ severity: "critical", label: "Subscription expired", detail: "Billing lapsed and access has reverted." });
  } else if (billing.billingState.includes("CANCELING")) {
    issues.push({ severity: "warning", label: "Cancellation scheduled", detail: `Access ends ${formatDate(billing.periodEnd)}.` });
  }
  return issues;
}

function IssueBanner({ issue }) {
  const color = issue.severity === "critical" ? DANGER : WARNING;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, fontSize: 12.5, color, background: `${color}18`, border: `1px solid ${color}50`, borderRadius: 8, padding: "8px 12px" }}>
      <span style={{ fontWeight: 700 }}>{issue.label}</span>
      <span style={{ opacity: 0.85 }}>{issue.detail}</span>
    </div>
  );
}

// Work Order 8: the one safe, reversible customer account action currently
// implemented -- see worker.js's handleAdminCancelCustomerDeletion for why
// this is the only one. Only rendered when there's actually a scheduled
// deletion to cancel; nothing to show otherwise. Requires an explicit
// second click (idle -> confirming -> loading) before the mutation fires.
// Work Order 6: one reusable inline-confirm row, shared by every action in
// AccountActionsCard below (cancel/schedule deletion, password reset,
// revoke sessions) -- same idle -> confirming -> loading -> error state
// machine WO8's original single-purpose card already established, just
// extracted so it isn't rewritten four times.
function ActionRow({ id, label, description, buttonLabel, confirmText, confirmLabel, danger, active, onOpen, onClose, onConfirm }) {
  const [loading, setLoading] = useState(false);
  const [localError, setLocalError] = useState("");

  const handleConfirm = async () => {
    setLoading(true);
    setLocalError("");
    const result = await onConfirm();
    setLoading(false);
    if (result && result.error) { setLocalError(result.error); return; }
    onClose();
  };

  return (
    <div style={{ borderTop: id === "cancelDeletion" ? "none" : `1px solid ${BORDER}`, paddingTop: id === "cancelDeletion" ? 0 : 14, marginTop: id === "cancelDeletion" ? 0 : 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
        <div>
          <div style={{ fontSize: 13.5, color: TEXT, fontWeight: 600, marginBottom: 2 }}>{label}</div>
          <div style={{ fontSize: 12.5, color: MUTED }}>{description}</div>
        </div>
        {!active && (
          <button
            onClick={onOpen}
            style={{ flexShrink: 0, padding: "8px 16px", borderRadius: 8, border: `1px solid ${danger ? DANGER : BORDER}`, background: "transparent", color: danger ? DANGER : ACCENT, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >
            {buttonLabel}
          </button>
        )}
      </div>

      {active && (
        <div style={{ marginTop: 14, padding: "12px 14px", borderRadius: 8, background: "rgba(139,92,246,0.08)", border: `1px solid ${BORDER}` }}>
          <div style={{ fontSize: 13, color: TEXT, marginBottom: 10 }}>{confirmText}</div>
          {localError && <div style={{ fontSize: 12, color: DANGER, marginBottom: 10 }}>{localError}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={handleConfirm}
              disabled={loading}
              style={{ padding: "7px 14px", borderRadius: 7, border: "none", background: danger ? DANGER : ACCENT, color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: loading ? "default" : "pointer" }}
            >
              {loading ? "Working…" : confirmLabel}
            </button>
            <button
              onClick={onClose}
              disabled={loading}
              style={{ padding: "7px 14px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
            >
              Never mind
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function AccountActionsCard({ profile, customerId, accessToken, isSuperadmin, onCancelled, onScheduled }) {
  const [activeId, setActiveId] = useState(null);

  const hasScheduledDeletion = profile.deletionStatus === "scheduled";
  const deletionLocked = profile.deletionStatus === "scheduled" || profile.deletionStatus === "in_progress";

  const genericError = (result, badRequestMessage) => {
    if (!result.ok) {
      return { error: result.reason === "bad_request" && badRequestMessage ? badRequestMessage : "Couldn't complete that action. Check your connection and try again." };
    }
    return null;
  };

  return (
    <Card title="Account actions">
      {hasScheduledDeletion && (
        <ActionRow
          id="cancelDeletion"
          label="Cancel scheduled deletion"
          description="Reverses the customer's own deletion request. Nothing has been deleted yet — their account, billing, and data are unaffected."
          buttonLabel="Cancel deletion"
          confirmText="Cancel this customer's scheduled account deletion? They'll keep full access and will no longer be scheduled for deletion."
          confirmLabel="Yes, cancel deletion"
          active={activeId === "cancelDeletion"}
          onOpen={() => setActiveId("cancelDeletion")}
          onClose={() => setActiveId(null)}
          onConfirm={async () => {
            const result = await cancelCustomerDeletion(accessToken, customerId);
            const err = genericError(result, "This deletion can no longer be cancelled here — it may have already started or been resolved.");
            if (!err) onCancelled();
            return err;
          }}
        />
      )}

      {!deletionLocked && isSuperadmin && (
        <ActionRow
          id="scheduleDeletion"
          label="Schedule account deletion"
          description="Starts the same 30-day deletion window a customer can trigger themselves — cancels active billing immediately, then permanently erases the account after 30 days. Reversible any time before then from this same panel."
          buttonLabel="Schedule deletion"
          danger
          confirmText="Schedule this account for deletion in 30 days? Their subscription will be cancelled immediately. This can be cancelled at any point before the 30 days are up, but the account will be permanently erased if it isn't."
          confirmLabel="Yes, schedule deletion"
          active={activeId === "scheduleDeletion"}
          onOpen={() => setActiveId("scheduleDeletion")}
          onClose={() => setActiveId(null)}
          onConfirm={async () => {
            const result = await scheduleCustomerDeletion(accessToken, customerId);
            const err = genericError(result);
            if (!err) onScheduled();
            return err;
          }}
        />
      )}

      {isSuperadmin && (
        <ActionRow
          id="resetPassword"
          label="Send password reset email"
          description="Sends the customer Supabase's standard password-reset email. Staff never sees or sets a password."
          buttonLabel="Send reset email"
          confirmText="Send a password-reset email to this customer's address on file?"
          confirmLabel="Yes, send it"
          active={activeId === "resetPassword"}
          onOpen={() => setActiveId("resetPassword")}
          onClose={() => setActiveId(null)}
          onConfirm={async () => genericError(await triggerPasswordReset(accessToken, customerId))}
        />
      )}

      {isSuperadmin && (
        <ActionRow
          id="revokeSessions"
          label="Revoke active sessions"
          description="Signs the customer out everywhere and emails them a password-reset link. Useful if an account may be compromised."
          buttonLabel="Revoke sessions"
          danger
          confirmText="Sign this customer out of every active session? Their current password will stop working immediately, and they'll be emailed a link to set a new one."
          confirmLabel="Yes, revoke sessions"
          active={activeId === "revokeSessions"}
          onOpen={() => setActiveId("revokeSessions")}
          onClose={() => setActiveId(null)}
          onConfirm={async () => genericError(await revokeCustomerSessions(accessToken, customerId))}
        />
      )}
    </Card>
  );
}

// Work Order 6: scoped profile editing -- exactly the fields
// worker.js's CUSTOMER_PROFILE_EDITABLE_FIELDS allowlists, nothing else.
// Edit mode shows a before -> after diff and requires an explicit confirm
// before saving, per "financial/destructive/account-security actions
// require explicit confirmation" -- this isn't financial or destructive,
// but silently overwriting a customer's own data warrants the same care.
const PROFILE_EDIT_FIELDS = [
  { key: "fullName", label: "Full name", type: "text" },
  { key: "phone", label: "Phone", type: "text" },
  { key: "country", label: "Country", type: "text" },
  { key: "location", label: "Location", type: "text" },
  { key: "jobTitle", label: "Job title", type: "text" },
  { key: "yearsExperience", label: "Years experience", type: "number" },
];

const editInputStyle = { width: "100%", boxSizing: "border-box", padding: "6px 9px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "#15131E", color: TEXT, fontSize: 13, outline: "none" };

function EditableAccountCard({ profile, customerId, accessToken, isSuperadmin, extraFields, onSaved }) {
  const [mode, setMode] = useState("view"); // view | edit | confirm | saving | error
  const [draft, setDraft] = useState(() => Object.fromEntries(PROFILE_EDIT_FIELDS.map((f) => [f.key, profile[f.key] ?? ""])));
  const [error, setError] = useState("");

  const startEdit = () => {
    setDraft(Object.fromEntries(PROFILE_EDIT_FIELDS.map((f) => [f.key, profile[f.key] ?? ""])));
    setMode("edit");
  };

  const changedFields = PROFILE_EDIT_FIELDS.filter((f) => {
    const original = profile[f.key] ?? (f.type === "number" ? null : "");
    const draftValue = f.type === "number" ? (draft[f.key] === "" ? null : Number(draft[f.key])) : draft[f.key];
    return draftValue !== original;
  });

  const handleSave = async () => {
    setMode("saving");
    setError("");
    const fields = {};
    for (const f of changedFields) {
      fields[f.key] = f.type === "number" ? (draft[f.key] === "" ? null : Number(draft[f.key])) : draft[f.key];
    }
    const result = await updateCustomerProfile(accessToken, customerId, fields);
    if (!result.ok) {
      setMode("confirm");
      setError("Couldn't save these changes. Check your connection and try again.");
      return;
    }
    setMode("view");
    onSaved(fields);
  };

  return (
    <Card title="Account">
      {mode === "view" && (
        <>
          <FieldGrid>
            {PROFILE_EDIT_FIELDS.map((f) => <Field key={f.key} label={f.label} value={profile[f.key]} />)}
            {extraFields}
          </FieldGrid>
          {isSuperadmin && (
            <button
              onClick={startEdit}
              style={{ marginTop: 14, padding: "6px 14px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: ACCENT, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
            >
              Edit profile
            </button>
          )}
        </>
      )}

      {mode === "edit" && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 16, marginBottom: 14 }}>
            {PROFILE_EDIT_FIELDS.map((f) => (
              <div key={f.key}>
                <div style={{ fontSize: 11.5, color: MUTED, marginBottom: 4 }}>{f.label}</div>
                <input
                  type={f.type}
                  value={draft[f.key]}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                  style={editInputStyle}
                />
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={() => (changedFields.length > 0 ? setMode("confirm") : setMode("view"))}
              style={{ padding: "7px 14px", borderRadius: 7, border: "none", background: ACCENT, color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}
            >
              Review changes
            </button>
            <button onClick={() => setMode("view")} style={{ padding: "7px 14px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
              Cancel
            </button>
          </div>
        </>
      )}

      {(mode === "confirm" || mode === "saving") && (
        <div style={{ padding: "12px 14px", borderRadius: 8, background: "rgba(139,92,246,0.08)", border: `1px solid ${BORDER}` }}>
          <div style={{ fontSize: 13, color: TEXT, marginBottom: 10, fontWeight: 600 }}>Confirm changes</div>
          {changedFields.length === 0 && <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 10 }}>No fields changed.</div>}
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
            {changedFields.map((f) => (
              <div key={f.key} style={{ fontSize: 12.5, color: TEXT }}>
                <b>{f.label}:</b> {profile[f.key] || "(empty)"} → {draft[f.key] || "(empty)"}
              </div>
            ))}
          </div>
          {error && <div style={{ fontSize: 12, color: DANGER, marginBottom: 10 }}>{error}</div>}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              onClick={handleSave}
              disabled={mode === "saving"}
              style={{ padding: "7px 14px", borderRadius: 7, border: "none", background: ACCENT, color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: mode === "saving" ? "default" : "pointer" }}
            >
              {mode === "saving" ? "Saving…" : "Confirm and save"}
            </button>
            <button onClick={() => setMode("edit")} disabled={mode === "saving"} style={{ padding: "7px 14px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
              Back
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}

function QuotaTable({ quotas }) {
  const rows = Object.entries(quotas);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", rowGap: 8, columnGap: 20, fontSize: 12.5 }}>
      <div style={{ color: MUTED, fontWeight: 700 }}>Feature</div>
      <div style={{ color: MUTED, fontWeight: 700 }}>Used</div>
      <div style={{ color: MUTED, fontWeight: 700 }}>Limit</div>
      {rows.map(([feature, q]) => (
        <div key={feature} style={{ display: "contents" }}>
          <div style={{ color: TEXT }}>{feature.replace(/_/g, " ")}</div>
          <div style={{ color: TEXT }}>{q.used}</div>
          <div style={{ color: q.unlimited ? ACCENT : TEXT }}>{q.unlimited ? "Unlimited" : q.limit}</div>
        </div>
      ))}
    </div>
  );
}

export default function CustomerDetailPage({ customerId, onBack, onOpenBilling, onOpenNewCase, onStartImpersonation }) {
  const { accessToken, role } = useAdminAuth();
  const canViewBilling = hasRole(role, ["billing_ops"]);
  const isSuperadmin = hasRole(role, []); // matches HIGH_RISK_ROLES server-side
  const [state, setState] = useState({ status: "loading", data: null });

  const load = useCallback(async () => {
    setState({ status: "loading", data: null });
    const result = await fetchCustomerDetail(accessToken, customerId);
    if (!result.ok) {
      setState({ status: result.reason === "not_found" ? "not_found" : "error", data: null });
      return;
    }
    setState({ status: "ready", data: result.data });
  }, [accessToken, customerId]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <button
        onClick={onBack}
        style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 18, padding: 0, border: "none", background: "transparent", color: MUTED, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
      >
        ← Back to customers
      </button>

      {state.status === "loading" && (
        <div style={{ padding: "48px 0", textAlign: "center", color: MUTED, fontSize: 13.5 }}>Loading customer…</div>
      )}

      {state.status === "not_found" && (
        <div style={{ padding: "48px 0", textAlign: "center", color: MUTED, fontSize: 13.5 }}>This customer couldn't be found.</div>
      )}

      {state.status === "error" && (
        <div style={{ padding: "48px 0", textAlign: "center" }}>
          <div style={{ color: DANGER, fontSize: 13.5, marginBottom: 12 }}>Couldn't load this customer. Check your connection and try again.</div>
          <button onClick={load} style={{ padding: "8px 18px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            Try again
          </button>
        </div>
      )}

      {state.status === "ready" && (() => {
        const { profile, lastSignInAt, lastActivityAt, lastActivitySource, billing, applications, smartApply } = state.data;
        const issues = computeAccountIssues(profile, billing);
        return (
          <>
            <div style={{ marginBottom: issues.length ? 12 : 20, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: TEXT }}>{profile.fullName || "(no name)"}</div>
                <div style={{ fontSize: 13.5, color: MUTED }}>{profile.email}</div>
              </div>
              <div style={{ display: "flex", gap: 10, flexShrink: 0 }}>
                {onOpenNewCase && (
                  <button
                    onClick={() => onOpenNewCase(customerId, profile.fullName || profile.email)}
                    style={{ padding: "8px 16px", borderRadius: 8, border: "none", background: ACCENT, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}
                  >
                    + New support case
                  </button>
                )}
                {canViewBilling && (
                  <button
                    onClick={() => onOpenBilling(customerId)}
                    style={{ padding: "8px 16px", borderRadius: 8, border: `1px solid ${BORDER}`, background: "transparent", color: ACCENT, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                  >
                    View billing →
                  </button>
                )}
                {isSuperadmin && onStartImpersonation && (
                  <button
                    onClick={() => onStartImpersonation(customerId)}
                    style={{ padding: "8px 16px", borderRadius: 8, border: `1px solid ${BORDER}`, background: "transparent", color: ACCENT, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
                  >
                    View as customer
                  </button>
                )}
              </div>
            </div>
            {issues.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 20 }}>
                {issues.map((issue) => <IssueBanner key={issue.label} issue={issue} />)}
              </div>
            )}

            <AccountActionsCard
              profile={profile}
              customerId={customerId}
              accessToken={accessToken}
              isSuperadmin={isSuperadmin}
              onCancelled={() => setState((s) => ({
                ...s,
                data: { ...s.data, profile: { ...s.data.profile, deletionStatus: null, deletionRequestedAt: null, deletionScheduledPurgeAt: null } },
              }))}
              onScheduled={load}
            />

            <EditableAccountCard
              profile={profile}
              customerId={customerId}
              accessToken={accessToken}
              isSuperadmin={isSuperadmin}
              onSaved={(changedFields) => setState((s) => ({ ...s, data: { ...s.data, profile: { ...s.data.profile, ...changedFields } } }))}
              extraFields={
                <>
                  <Field label="Signed up" value={formatDate(profile.createdAt)} />
                  <Field label="Last sign-in" value={lastSignInAt ? formatDateTime(lastSignInAt) : "Never"} />
                  <Field
                    label="Last activity"
                    value={lastActivityAt ? `${formatDateTime(lastActivityAt)} (${ACTIVITY_SOURCE_LABEL[lastActivitySource] || lastActivitySource})` : "No activity yet"}
                  />
                  <Field label="Profile last updated" value={formatDate(profile.updatedAt)} />
                </>
              }
            />

            <Card title="Billing">
              <FieldGrid>
                <Field label="Plan" value={billing.planDisplayName} />
                <Field label="Status" value={billing.billingState.replace(/_/g, " ")} />
                <Field label="Current period ends" value={formatDate(billing.periodEnd)} />
                <Field label="Cancels at period end" value={billing.cancelAtPeriodEnd ? "Yes" : "No"} />
                <Field label="Payment method on file" value={billing.paymentMethodOnFile ? "Yes" : "No"} />
                <Field label="Stripe customer" value={billing.stripeCustomerId} />
              </FieldGrid>
              <div style={{ marginTop: 16, fontSize: 11, fontWeight: 700, color: MUTED, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 10 }}>AI usage this period</div>
              <QuotaTable quotas={billing.quotas} />
            </Card>

            <Card title={`Applications (${applications.total}${applications.truncated ? "+" : ""})`}>
              <div style={{ marginBottom: 14 }}><StatusBreakdown byStatus={applications.byStatus} /></div>
              {applications.recent.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {applications.recent.map((a) => (
                    <div key={a.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, borderTop: `1px solid ${BORDER}`, paddingTop: 8 }}>
                      <span style={{ color: TEXT }}>{a.jobTitle} — {a.company}</span>
                      <span style={{ color: MUTED }}>{a.status} · {formatDate(a.dateApplied)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            <Card title={`Smart Apply (${smartApply.total}${smartApply.truncated ? "+" : ""})`}>
              <div style={{ marginBottom: 14 }}><StatusBreakdown byStatus={smartApply.byStatus} /></div>
              {smartApply.recent.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {smartApply.recent.map((s) => (
                    <div key={s.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, borderTop: `1px solid ${BORDER}`, paddingTop: 8 }}>
                      <span style={{ color: TEXT }}>{s.jobTitle} — {s.company}</span>
                      <span style={{ color: MUTED }}>{s.status}{s.retryCount > 0 ? ` · ${s.retryCount} retries` : ""} · {s.generationSource}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </>
        );
      })()}
    </div>
  );
}

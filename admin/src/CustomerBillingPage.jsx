import { useState, useEffect, useCallback } from "react";
import { useAdminAuth, hasRole } from "./useAdminAuth.js";
import {
  fetchCustomerBilling, refundCharge, cancelCustomerSubscription, resumeCustomerSubscription,
  changeCustomerPlan, generateBillingPortalLink,
} from "./lib/adminApi.js";
import { formatDate, formatMoney } from "./lib/format.js";
import { BORDER, TEXT, MUTED, ACCENT, DANGER, WARNING, SUCCESS } from "./lib/theme.js";
import { Card, Field, FieldGrid } from "./lib/ui.jsx";

const inputStyle = { padding: "7px 10px", borderRadius: 8, border: `1px solid ${BORDER}`, background: "#15131E", color: TEXT, fontSize: 12.5, outline: "none" };

const SUBSCRIPTION_STATUS_COLOR = {
  active: SUCCESS, trialing: SUCCESS,
  past_due: WARNING, unpaid: WARNING, incomplete: WARNING,
  canceled: MUTED, incomplete_expired: MUTED, paused: MUTED,
};

function EmptyRow({ children }) {
  return <div style={{ fontSize: 12.5, color: MUTED, padding: "6px 0" }}>{children}</div>;
}

function Row({ left, right, tone }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, borderTop: `1px solid ${BORDER}`, padding: "8px 0", gap: 12 }}>
      <span style={{ color: TEXT }}>{left}</span>
      <span style={{ color: tone || MUTED, textAlign: "right", flexShrink: 0 }}>{right}</span>
    </div>
  );
}

// Work Order 6: inline refund control per payment row. Only shown for a
// succeeded, not-yet-fully-refunded charge. Defaults the amount to what's
// actually still refundable (amount - amountRefunded), not the original
// charge amount, so a partial-refund-then-full-refund doesn't over-request.
function RefundButton({ customerId, charge, accessToken, onRefunded }) {
  const refundable = charge.amount - (charge.amountRefunded || 0);
  const [step, setStep] = useState("idle"); // idle | form | loading
  const [amount, setAmount] = useState(String(refundable / 100));
  const [reason, setReason] = useState("requested_by_customer");
  const [error, setError] = useState("");

  if (charge.status !== "succeeded" || charge.refunded || refundable <= 0) return null;

  const handleConfirm = async () => {
    const cents = Math.round(parseFloat(amount) * 100);
    if (!Number.isFinite(cents) || cents <= 0) { setError("Enter a valid amount."); return; }
    setStep("loading");
    setError("");
    const result = await refundCharge(accessToken, { userId: customerId, chargeId: charge.id, amount: cents === refundable ? undefined : cents, reason });
    if (!result.ok) {
      setStep("form");
      setError("Couldn't issue the refund. Check the amount and try again.");
      return;
    }
    onRefunded();
  };

  if (step === "idle") {
    return (
      <button onClick={() => setStep("form")} style={{ padding: "3px 10px", borderRadius: 6, border: `1px solid ${BORDER}`, background: "transparent", color: ACCENT, fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>
        Refund
      </button>
    );
  }

  return (
    <div style={{ marginTop: 8, padding: "10px 12px", borderRadius: 8, background: "rgba(139,92,246,0.06)", border: `1px solid ${BORDER}` }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 8 }}>
        <span style={{ fontSize: 12, color: MUTED }}>Amount ({charge.currency.toUpperCase()})</span>
        <input type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={step === "loading"} style={{ ...inputStyle, width: 90 }} />
        <select value={reason} onChange={(e) => setReason(e.target.value)} disabled={step === "loading"} style={inputStyle}>
          <option value="requested_by_customer">Requested by customer</option>
          <option value="duplicate">Duplicate</option>
          <option value="fraudulent">Fraudulent</option>
        </select>
      </div>
      {error && <div style={{ fontSize: 11.5, color: DANGER, marginBottom: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={handleConfirm}
          disabled={step === "loading"}
          style={{ padding: "5px 12px", borderRadius: 6, border: "none", background: DANGER, color: "#fff", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}
        >
          {step === "loading" ? "Refunding…" : `Confirm refund`}
        </button>
        <button onClick={() => setStep("idle")} disabled={step === "loading"} style={{ padding: "5px 12px", borderRadius: 6, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// Work Order 6: subscription-level actions (cancel/resume/change plan) on
// the customer's behalf, plus generating a Billing Portal link. Subscription
// mutations are superadmin-only server-side (HIGH_RISK_ROLES); the portal
// link is billing_ops/superadmin (BILLING_MGMT_ROLES, same as this whole
// page) -- `canMutateSubscription` mirrors that split so billing_ops sees
// only the lower-risk action.
function BillingActionsCard({ customerId, subscription, accessToken, canMutateSubscription, onChanged }) {
  const [subAction, setSubAction] = useState(null); // { type: 'cancel'|'resume'|'plan', plan? }
  const [subLoading, setSubLoading] = useState(false);
  const [subError, setSubError] = useState("");
  const [selectedPlan, setSelectedPlan] = useState("premium");

  const [portalState, setPortalState] = useState({ status: "idle", url: null, error: "" });

  const isCanceling = !!subscription?.cancelAtPeriodEnd;

  const applySubAction = async (type) => {
    setSubLoading(true);
    setSubError("");
    let result;
    if (type === "cancel") result = await cancelCustomerSubscription(accessToken, customerId);
    else if (type === "resume") result = await resumeCustomerSubscription(accessToken, customerId);
    else result = await changeCustomerPlan(accessToken, customerId, selectedPlan);
    setSubLoading(false);
    if (!result.ok) {
      setSubError("Couldn't complete that change. Check your connection and try again.");
      return;
    }
    setSubAction(null);
    onChanged();
  };

  const handleGeneratePortalLink = async () => {
    setPortalState({ status: "loading", url: null, error: "" });
    const result = await generateBillingPortalLink(accessToken, customerId);
    if (!result.ok) {
      setPortalState({ status: "error", url: null, error: "Couldn't generate a portal link. Check your connection and try again." });
      return;
    }
    setPortalState({ status: "ready", url: result.data.url, error: "" });
  };

  return (
    <Card title="Billing actions">
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 6 }}>Stripe Billing Portal — customer manages their own payment method there; this app never handles card data directly.</div>
          {portalState.status !== "ready" && (
            <button
              onClick={handleGeneratePortalLink}
              disabled={portalState.status === "loading"}
              style={{ padding: "7px 14px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: ACCENT, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
            >
              {portalState.status === "loading" ? "Generating…" : "Generate portal link"}
            </button>
          )}
          {portalState.status === "ready" && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <a href={portalState.url} target="_blank" rel="noreferrer" style={{ color: ACCENT, fontSize: 12.5, wordBreak: "break-all" }}>{portalState.url}</a>
              <button onClick={() => navigator.clipboard?.writeText(portalState.url)} style={{ padding: "4px 10px", borderRadius: 6, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>Copy</button>
            </div>
          )}
          {portalState.status === "error" && <div style={{ fontSize: 11.5, color: DANGER, marginTop: 6 }}>{portalState.error}</div>}
        </div>

        {canMutateSubscription && subscription && (
          <div style={{ borderTop: `1px solid ${BORDER}`, paddingTop: 14 }}>
            <div style={{ fontSize: 12.5, color: MUTED, marginBottom: 8 }}>Subscription changes take effect immediately and may charge or credit the customer's card on file.</div>
            {!subAction && (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {isCanceling ? (
                  <button onClick={() => setSubAction({ type: "resume" })} style={{ padding: "7px 14px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: ACCENT, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>Resume subscription</button>
                ) : (
                  <button onClick={() => setSubAction({ type: "cancel" })} style={{ padding: "7px 14px", borderRadius: 7, border: `1px solid ${DANGER}`, background: "transparent", color: DANGER, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>Cancel subscription</button>
                )}
                <button onClick={() => setSubAction({ type: "plan" })} style={{ padding: "7px 14px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: ACCENT, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>Change plan</button>
              </div>
            )}

            {subAction?.type === "plan" && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
                <select value={selectedPlan} onChange={(e) => setSelectedPlan(e.target.value)} disabled={subLoading} style={inputStyle}>
                  <option value="pro">Pro</option>
                  <option value="premium">Premium</option>
                </select>
              </div>
            )}

            {subAction && (
              <div style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(139,92,246,0.06)", border: `1px solid ${BORDER}` }}>
                <div style={{ fontSize: 12.5, color: TEXT, marginBottom: 10 }}>
                  {subAction.type === "cancel" && "Cancel this subscription at the end of the current billing period?"}
                  {subAction.type === "resume" && "Resume this subscription (undo the scheduled cancellation)?"}
                  {subAction.type === "plan" && `Change this customer's plan to ${selectedPlan === "premium" ? "Premium" : "Pro"}? A Pro→Premium change charges the prorated difference immediately.`}
                </div>
                {subError && <div style={{ fontSize: 11.5, color: DANGER, marginBottom: 8 }}>{subError}</div>}
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => applySubAction(subAction.type)}
                    disabled={subLoading}
                    style={{ padding: "6px 14px", borderRadius: 7, border: "none", background: subAction.type === "cancel" ? DANGER : ACCENT, color: "#fff", fontSize: 12.5, fontWeight: 700, cursor: "pointer" }}
                  >
                    {subLoading ? "Saving…" : "Confirm"}
                  </button>
                  <button onClick={() => { setSubAction(null); setSubError(""); }} disabled={subLoading} style={{ padding: "6px 14px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

// Read-only Stripe billing view (Work Order 4). Every Stripe-sourced field
// below comes directly from the Worker's live Stripe calls -- nothing here
// is inferred or reconstructed from Supabase. See handleAdminCustomerBilling
// in worker.js for the actual Stripe API calls this page's data comes from.
export default function CustomerBillingPage({ customerId, onBack }) {
  const { accessToken, role } = useAdminAuth();
  const canMutateSubscription = hasRole(role, []); // superadmin only, matches HIGH_RISK_ROLES
  const [state, setState] = useState({ status: "loading", data: null, errorCode: null });

  const load = useCallback(async () => {
    setState({ status: "loading", data: null, errorCode: null });
    const result = await fetchCustomerBilling(accessToken, customerId);
    if (!result.ok) {
      setState({ status: result.reason === "not_found" ? "not_found" : "error", data: null, errorCode: result.errorCode || null });
      return;
    }
    setState({ status: "ready", data: result.data, errorCode: null });
  }, [accessToken, customerId]);

  useEffect(() => { load(); }, [load]);

  let errorMessage = "Couldn't load billing information. Check your connection and try again.";
  if (state.errorCode === "stripe_api_error") errorMessage = "Stripe data is currently unavailable. This is a live Stripe API issue, not a data problem -- try again shortly.";
  if (state.errorCode === "stripe_not_configured") errorMessage = "Stripe isn't configured for this environment.";

  return (
    <div>
      <button
        onClick={onBack}
        style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 18, padding: 0, border: "none", background: "transparent", color: MUTED, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
      >
        ← Back to customer
      </button>

      {state.status === "loading" && (
        <div style={{ padding: "48px 0", textAlign: "center", color: MUTED, fontSize: 13.5 }}>Loading billing information…</div>
      )}

      {state.status === "not_found" && (
        <div style={{ padding: "48px 0", textAlign: "center", color: MUTED, fontSize: 13.5 }}>This customer couldn't be found.</div>
      )}

      {state.status === "error" && (
        <div style={{ padding: "48px 0", textAlign: "center" }}>
          <div style={{ color: DANGER, fontSize: 13.5, marginBottom: 12, maxWidth: 420, margin: "0 auto 12px" }}>{errorMessage}</div>
          <button onClick={load} style={{ padding: "8px 18px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            Try again
          </button>
        </div>
      )}

      {state.status === "ready" && (() => {
        const d = state.data;
        return (
          <>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 20, fontWeight: 700, color: TEXT }}>Billing</div>
              <div style={{ fontSize: 13.5, color: MUTED }}>
                CareerPersona plan: <b style={{ color: TEXT }}>{d.careerPersonaPlan}</b> ({d.careerPersonaBillingState.replace(/_/g, " ")})
              </div>
            </div>

            {!d.hasStripeCustomer && (
              <Card title="Stripe">
                <EmptyRow>This customer has no Stripe customer record yet -- they're on the Free plan and have never completed checkout, or Stripe details haven't synced.</EmptyRow>
              </Card>
            )}

            {d.hasStripeCustomer && (
              <>
                <BillingActionsCard
                  customerId={customerId}
                  subscription={d.subscriptions[0]}
                  accessToken={accessToken}
                  canMutateSubscription={canMutateSubscription}
                  onChanged={load}
                />

                <Card title="Subscription">
                  {d.subscriptions.length === 0 && <EmptyRow>No subscriptions on this Stripe customer.</EmptyRow>}
                  {d.subscriptions.map((s) => (
                    <div key={s.id} style={{ marginBottom: 14 }}>
                      <FieldGrid>
                        <Field label="Status" value={<span style={{ color: SUBSCRIPTION_STATUS_COLOR[s.status] || TEXT, fontWeight: 700 }}>{s.status.replace(/_/g, " ")}</span>} />
                        <Field label="Amount" value={s.amount != null ? `${formatMoney(s.amount, s.currency)} / ${s.interval}` : "—"} />
                        <Field label="Current period" value={s.currentPeriodEnd ? `Until ${formatDate(s.currentPeriodEnd)}` : "—"} />
                        <Field label="Cancels at period end" value={s.cancelAtPeriodEnd ? "Yes" : "No"} />
                        {s.canceledAt && <Field label="Canceled" value={formatDate(s.canceledAt)} />}
                      </FieldGrid>
                    </div>
                  ))}
                  <div style={{ marginTop: 4, paddingTop: 12, borderTop: `1px solid ${BORDER}` }}>
                    <FieldGrid>
                      <Field label="Stripe customer" value={d.stripeCustomerId} />
                      <Field
                        label="Payment method"
                        value={d.paymentMethod ? `${d.paymentMethod.brand} •••• ${d.paymentMethod.last4} (exp ${d.paymentMethod.expMonth}/${d.paymentMethod.expYear})` : "None on file"}
                      />
                    </FieldGrid>
                  </div>
                </Card>

                <Card title={`Recent payments (${d.payments.length})`}>
                  {d.payments.length === 0 && <EmptyRow>No payments yet.</EmptyRow>}
                  {d.payments.map((p) => (
                    <div key={p.id} style={{ borderTop: `1px solid ${BORDER}`, padding: "8px 0" }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, fontSize: 12.5 }}>
                        <span style={{ color: TEXT }}>{formatMoney(p.amount, p.currency)}</span>
                        <span style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <span style={{ color: p.status === "failed" ? DANGER : p.status === "succeeded" ? SUCCESS : WARNING, textAlign: "right" }}>
                            {p.status === "failed" ? `Failed — ${p.failureMessage || p.failureCode || "unknown reason"}` : `${p.status} · ${formatDate(p.createdAt)}${p.refunded ? " · refunded" : ""}${p.disputed ? " · disputed" : ""}`}
                          </span>
                        </span>
                      </div>
                      {canMutateSubscription && <RefundButton customerId={customerId} charge={p} accessToken={accessToken} onRefunded={load} />}
                    </div>
                  ))}
                </Card>

                <Card title={`Refunds (${d.refunds.length})`}>
                  {d.refunds.length === 0 && <EmptyRow>No refunds.</EmptyRow>}
                  {d.refunds.map((r) => (
                    <Row key={r.id} left={formatMoney(r.amount, r.currency)} right={`${r.status}${r.reason ? ` · ${r.reason.replace(/_/g, " ")}` : ""} · ${formatDate(r.createdAt)}`} />
                  ))}
                </Card>

                <Card title={`Disputes (${d.disputes.length})`}>
                  {d.disputes.length === 0 && <EmptyRow>No disputes.</EmptyRow>}
                  {d.disputes.map((disp) => (
                    <Row key={disp.id} left={formatMoney(disp.amount, disp.currency)} tone={DANGER} right={`${disp.status.replace(/_/g, " ")}${disp.reason ? ` · ${disp.reason.replace(/_/g, " ")}` : ""} · ${formatDate(disp.createdAt)}`} />
                  ))}
                </Card>

                <Card title={`Recent invoices (${d.invoices.length})`}>
                  {d.invoices.length === 0 && <EmptyRow>No invoices.</EmptyRow>}
                  {d.invoices.map((inv) => (
                    <Row
                      key={inv.id}
                      left={formatMoney(inv.amountDue, inv.currency)}
                      right={
                        <>
                          {inv.status} · {formatDate(inv.createdAt)}
                          {inv.hostedInvoiceUrl && <> · <a href={inv.hostedInvoiceUrl} target="_blank" rel="noreferrer" style={{ color: ACCENT }}>View on Stripe ↗</a></>}
                        </>
                      }
                    />
                  ))}
                </Card>
              </>
            )}
          </>
        );
      })()}
    </div>
  );
}

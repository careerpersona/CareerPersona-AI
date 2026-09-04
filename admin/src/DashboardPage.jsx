import { useState, useEffect, useCallback } from "react";
import { useAdminAuth } from "./useAdminAuth.js";
import { fetchDashboard } from "./lib/adminApi.js";
import { formatDate, formatMoney } from "./lib/format.js";
import { BORDER, TEXT, MUTED, DANGER, WARNING, SUCCESS } from "./lib/theme.js";
import { Card } from "./lib/ui.jsx";

function StatGrid({ children }) {
  return <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 14, marginBottom: 6 }}>{children}</div>;
}

function Stat({ label, value, tone }) {
  return (
    <div style={{ background: "#15131E", border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px" }}>
      <div style={{ fontSize: 11, color: MUTED, marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.04em" }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color: tone || TEXT }}>{value}</div>
    </div>
  );
}

function SystemHealthBadge({ health }) {
  const ok = health.db === "ok" && health.kv === "ok";
  const color = ok ? SUCCESS : health.db === "unconfigured" ? MUTED : DANGER;
  const label = ok ? "All systems normal" : health.db === "unconfigured" ? "Not configured" : "Degraded";
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, color, background: `${color}18`, border: `1px solid ${color}50`, borderRadius: 999, padding: "4px 10px" }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: color }} />
      {label} <span style={{ color: MUTED }}>(db: {health.db}, kv: {health.kv})</span>
    </div>
  );
}

// Operations overview -- the Back Office landing page for every staff role.
// The Worker decides which sections exist in the response based on role
// (see handleAdminDashboard); this component only ever renders sections
// that are actually present, never assumes one exists.
export default function DashboardPage() {
  const { accessToken } = useAdminAuth();
  const [state, setState] = useState({ status: "loading", data: null });

  const load = useCallback(async () => {
    setState({ status: "loading", data: null });
    const result = await fetchDashboard(accessToken);
    if (!result.ok) { setState({ status: "error", data: null }); return; }
    setState({ status: "ready", data: result.data });
  }, [accessToken]);

  useEffect(() => { load(); }, [load]);

  if (state.status === "loading") {
    return <div style={{ padding: "48px 0", textAlign: "center", color: MUTED, fontSize: 13.5 }}>Loading dashboard…</div>;
  }
  if (state.status === "error") {
    return (
      <div style={{ padding: "48px 0", textAlign: "center" }}>
        <div style={{ color: DANGER, fontSize: 13.5, marginBottom: 12 }}>Couldn't load the dashboard. Check your connection and try again.</div>
        <button onClick={load} style={{ padding: "8px 18px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
          Try again
        </button>
      </div>
    );
  }

  const { period, systemHealth, customerOverview, productActivity, accountAlerts, billingHealth } = state.data;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: TEXT }}>Dashboard</div>
          <div style={{ fontSize: 13, color: MUTED }}>{period.label}</div>
        </div>
        <SystemHealthBadge health={systemHealth} />
      </div>

      {customerOverview && (
        <Card title="Customer overview">
          <StatGrid>
            <Stat label="Total customers" value={customerOverview.totalCustomers} />
            <Stat label={`New (${period.label.toLowerCase()})`} value={customerOverview.newCustomers} />
            <Stat label="Active subscriptions" value={customerOverview.activeSubscriptions} tone={SUCCESS} />
          </StatGrid>
          <div style={{ marginTop: 14, fontSize: 11, fontWeight: 700, color: MUTED, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>Plan breakdown</div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {Object.entries(customerOverview.planBreakdown).map(([plan, count]) => (
              <span key={plan} style={{ fontSize: 12, color: TEXT, background: "#221E30", border: `1px solid ${BORDER}`, borderRadius: 999, padding: "4px 10px", textTransform: "capitalize" }}>
                {plan}: <b>{count}</b>
              </span>
            ))}
          </div>
        </Card>
      )}

      {productActivity && (
        <Card title={`Product activity (${period.label.toLowerCase()})`}>
          <StatGrid>
            <Stat label="Applications" value={productActivity.applicationsInPeriod} />
            <Stat label="Smart Apply" value={productActivity.smartApplyInPeriod} />
            <Stat label="Smart Apply applied" value={productActivity.smartApplyAppliedInPeriod} tone={SUCCESS} />
          </StatGrid>
        </Card>
      )}

      {accountAlerts && (accountAlerts.deletionScheduledCount > 0 ? (
        <Card title="Account alerts">
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: WARNING }}>
            <b>{accountAlerts.deletionScheduledCount}</b> account{accountAlerts.deletionScheduledCount === 1 ? "" : "s"} with deletion scheduled or in progress.
          </div>
        </Card>
      ) : null)}

      {billingHealth && (
        <Card title="Billing health">
          <StatGrid>
            <Stat label="Past due" value={billingHealth.pastDueCount} tone={billingHealth.pastDueCount > 0 ? DANGER : TEXT} />
            <Stat label="Canceling" value={billingHealth.cancelingCount} tone={billingHealth.cancelingCount > 0 ? WARNING : TEXT} />
            <Stat
              label="Failed payments"
              value={billingHealth.failedPayments ? billingHealth.failedPayments.count : "—"}
              tone={billingHealth.failedPayments?.count > 0 ? DANGER : TEXT}
            />
          </StatGrid>

          <div style={{ marginTop: 16, fontSize: 11, fontWeight: 700, color: MUTED, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>
            Revenue — {period.label} (from Stripe)
          </div>
          {billingHealth.stripeError === "stripe_not_configured" && (
            <div style={{ fontSize: 12.5, color: MUTED }}>Stripe isn't configured for this environment.</div>
          )}
          {billingHealth.stripeError === "stripe_api_error" && (
            <div style={{ fontSize: 12.5, color: DANGER }}>Stripe data is currently unavailable — revenue not shown rather than estimated.</div>
          )}
          {billingHealth.revenue && (
            <>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {billingHealth.revenue.byCurrency.length === 0 && <div style={{ fontSize: 12.5, color: MUTED }}>No payments in this period.</div>}
                {billingHealth.revenue.byCurrency.map((c) => (
                  <div key={c.currency} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, borderTop: `1px solid ${BORDER}`, paddingTop: 8 }}>
                    <span style={{ color: TEXT, textTransform: "uppercase" }}>{c.currency}</span>
                    <span style={{ color: MUTED }}>
                      Gross <b style={{ color: TEXT }}>{formatMoney(c.grossCents, c.currency)}</b>
                      {" · "}Refunded <b style={{ color: DANGER }}>{formatMoney(c.refundedCents, c.currency)}</b>
                      {" · "}Net <b style={{ color: SUCCESS }}>{formatMoney(c.netCents, c.currency)}</b>
                    </span>
                  </div>
                ))}
              </div>
              {billingHealth.revenue.truncated && (
                <div style={{ fontSize: 11.5, color: WARNING, marginTop: 8 }}>More than 100 payments or refunds occurred in this period — totals reflect only the first 100 of each, not the full period.</div>
              )}
            </>
          )}

          {billingHealth.failedPayments?.count > 0 && (
            <>
              <div style={{ marginTop: 16, fontSize: 11, fontWeight: 700, color: MUTED, letterSpacing: "0.05em", textTransform: "uppercase", marginBottom: 8 }}>Recent failed payments</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {billingHealth.failedPayments.recent.map((p) => (
                  <div key={p.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, borderTop: `1px solid ${BORDER}`, paddingTop: 8 }}>
                    <span style={{ color: TEXT }}>{formatMoney(p.amount, p.currency)}</span>
                    <span style={{ color: DANGER }}>{p.failureMessage || "Unknown reason"} · {formatDate(p.createdAt)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      )}
    </div>
  );
}

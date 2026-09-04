import { useState, useEffect, useCallback } from "react";
import { useAdminAuth } from "./useAdminAuth.js";
import { fetchSystemHealth } from "./lib/adminApi.js";
import { formatDateTime } from "./lib/format.js";
import { BORDER, TEXT, MUTED, SURFACE, DANGER, SUCCESS, WARNING } from "./lib/theme.js";
import { Card } from "./lib/ui.jsx";

const STATUS_COLOR = { healthy: SUCCESS, degraded: WARNING, unavailable: DANGER };
const STATUS_LABEL = { healthy: "Healthy", degraded: "Degraded", unavailable: "Unavailable" };

const CHECK_LABELS = {
  worker: "Worker / API",
  database: "Supabase / Database",
  kv: "KV",
  stripe: "Stripe",
};

const DETAIL_LABELS = {
  not_configured: "Not configured for this environment.",
  connectivity_error: "Couldn't connect.",
};

function detailText(detail) {
  if (!detail) return null;
  return DETAIL_LABELS[detail] || `Error code: ${detail}`;
}

function StatusPill({ status }) {
  const color = STATUS_COLOR[status] || MUTED;
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color, background: `${color}20`, borderRadius: 999, padding: "3px 10px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function CheckCard({ name, check }) {
  const color = STATUS_COLOR[check.status] || MUTED;
  return (
    <div style={{ background: SURFACE, border: `1px solid ${BORDER}`, borderLeft: `3px solid ${color}`, borderRadius: 10, padding: "14px 16px", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 600, color: TEXT, marginBottom: 4 }}>{CHECK_LABELS[name] || name}</div>
        {check.status !== "healthy" && detailText(check.detail) && (
          <div style={{ fontSize: 12, color: MUTED }}>{detailText(check.detail)}</div>
        )}
      </div>
      <StatusPill status={check.status} />
    </div>
  );
}

// System Health (Work Order 10) -- every active staff role can view this
// (support/billing_ops/superadmin), matching the Worker's own lack of a
// role restriction on GET /api/admin/system-health. Manual refresh only --
// no polling interval, per WO10 section 3 ("do not create continuous
// polling or unnecessary API calls").
export default function SystemHealthPage() {
  const { accessToken } = useAdminAuth();
  const [state, setState] = useState({ status: "loading", data: null });
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (isRefresh) => {
    if (isRefresh) setRefreshing(true); else setState({ status: "loading", data: null });
    const result = await fetchSystemHealth(accessToken);
    setRefreshing(false);
    if (!result.ok) { setState({ status: "error", data: null }); return; }
    setState({ status: "ready", data: result.data });
  }, [accessToken]);

  useEffect(() => { load(false); }, [load]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, gap: 16 }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: TEXT }}>System Health</div>
          <div style={{ fontSize: 13, color: MUTED }}>
            {state.status === "ready" ? `Last checked ${formatDateTime(state.data.checkedAt)}` : " "}
          </div>
        </div>
        {state.status === "ready" && (
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            style={{ flexShrink: 0, padding: "8px 16px", borderRadius: 8, border: `1px solid ${BORDER}`, background: "transparent", color: refreshing ? MUTED : TEXT, fontSize: 13, fontWeight: 600, cursor: refreshing ? "default" : "pointer" }}
          >
            {refreshing ? "Checking…" : "Check again"}
          </button>
        )}
      </div>

      {state.status === "loading" && (
        <div style={{ padding: "48px 0", textAlign: "center", color: MUTED, fontSize: 13.5 }}>Checking system health…</div>
      )}

      {state.status === "error" && (
        <div style={{ padding: "48px 0", textAlign: "center" }}>
          <div style={{ color: DANGER, fontSize: 13.5, marginBottom: 12 }}>Couldn't load system health. Check your connection and try again.</div>
          <button onClick={() => load(false)} style={{ padding: "8px 18px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            Try again
          </button>
        </div>
      )}

      {state.status === "ready" && (() => {
        const d = state.data;
        return (
          <>
            <Card title="Overall status">
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <StatusPill status={d.status} />
                <span style={{ fontSize: 13, color: MUTED }}>
                  {d.status === "healthy" && "All systems operating normally."}
                  {d.status === "degraded" && "Core systems are up; a non-critical dependency needs attention."}
                  {d.status === "unavailable" && "A critical dependency is down."}
                </span>
              </div>
            </Card>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12 }}>
              {Object.entries(d.checks).map(([name, check]) => (
                <CheckCard key={name} name={name} check={check} />
              ))}
            </div>
          </>
        );
      })()}
    </div>
  );
}

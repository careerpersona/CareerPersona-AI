import { useState, useEffect, useCallback, Fragment } from "react";
import { useAdminAuth } from "./useAdminAuth.js";
import { fetchAIUsage } from "./lib/adminApi.js";
import { formatUsd } from "./lib/format.js";
import { BORDER, TEXT, MUTED, SURFACE, ACCENT, DANGER, WARNING } from "./lib/theme.js";
import { Card } from "./lib/ui.jsx";

const PERIODS = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "90d", label: "90 days" },
];

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

function formatTokens(n) {
  if (n == null) return "—";
  return n.toLocaleString();
}

function formatMs(ms) {
  if (ms == null) return "—";
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

// Reads the Worker's byGroup response (11 product-level groups, each with
// its own feature-tag children -- see AI_FEATURE_TAG_TO_GROUP in worker.js).
// A dedicated component rather than a generic Table variant: expand/collapse
// with nested child rows is a genuinely different shape than the flat
// row-per-column tables elsewhere on this page, same reasoning
// StaffManagementPage's expandable "Manage" row already established for
// this codebase (Fragment + a conditional detail block right under the row
// that opened it, not a separate table).
function GroupTable({ groups }) {
  const [expanded, setExpanded] = useState(() => new Set());
  const toggle = (groupId) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
    return next;
  });

  if (groups.length === 0) return <div style={{ fontSize: 12.5, color: MUTED }}>No AI requests in this period.</div>;

  const thStyle = { textAlign: "left", padding: "8px 12px", fontSize: 11, fontWeight: 700, color: MUTED, letterSpacing: "0.04em", textTransform: "uppercase", borderBottom: `1px solid ${BORDER}` };

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: SURFACE }}>
            <th style={thStyle}>Group</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Requests</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Tokens (in/out)</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Cost</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((g) => {
            const isOpen = expanded.has(g.groupId);
            return (
              <Fragment key={g.groupId}>
                <tr
                  onClick={() => toggle(g.groupId)}
                  style={{ borderBottom: `1px solid ${BORDER}`, cursor: "pointer" }}
                >
                  <td style={{ padding: "8px 12px", color: TEXT, fontWeight: 600 }}>
                    <span
                      aria-hidden="true"
                      style={{ display: "inline-block", width: 14, color: MUTED, transform: isOpen ? "rotate(90deg)" : "none", transition: "transform 0.12s" }}
                    >
                      ▶
                    </span>{" "}
                    {g.groupLabel}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right", color: TEXT }}>{g.requests.toLocaleString()}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", color: TEXT }}>{formatTokens(g.tokensIn)} / {formatTokens(g.tokensOut)}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", color: TEXT, fontWeight: 600 }}>{formatUsd(g.costUsd)}</td>
                </tr>
                {isOpen && g.children.map((c) => (
                  <tr key={c.callSiteId || c.feature} style={{ borderBottom: `1px solid ${BORDER}`, background: "#15131E" }}>
                    <td style={{ padding: "6px 12px 6px 34px", color: MUTED, fontSize: 12.5 }}>{c.label || c.feature}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right", color: MUTED, fontSize: 12.5 }}>{c.requests.toLocaleString()}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right", color: MUTED, fontSize: 12.5 }}>{formatTokens(c.tokensIn)} / {formatTokens(c.tokensOut)}</td>
                    <td style={{ padding: "6px 12px", textAlign: "right", color: MUTED, fontSize: 12.5 }}>{formatUsd(c.costUsd)}</td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Table({ columns, rows, emptyText }) {
  if (rows.length === 0) return <div style={{ fontSize: 12.5, color: MUTED }}>{emptyText}</div>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ background: SURFACE }}>
            {columns.map((c) => (
              <th key={c.key} style={{ textAlign: c.align || "left", padding: "8px 12px", fontSize: 11, fontWeight: 700, color: MUTED, letterSpacing: "0.04em", textTransform: "uppercase", borderBottom: `1px solid ${BORDER}` }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${BORDER}` }}>
              {columns.map((c) => (
                <td key={c.key} style={{ padding: "8px 12px", textAlign: c.align || "left", color: TEXT }}>{c.render ? c.render(row) : row[c.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// AI Usage & Cost -- billing_ops/superadmin only (see canManageAiUsage in
// AdminShell.jsx, mirroring the Worker's own BILLING_MGMT_ROLES gate on GET
// /api/admin/ai-usage). Manual period selection only, matching System
// Health's own "no continuous polling" precedent -- this isn't an
// operational alert surface, it's a spend/usage report someone opens to
// look at, not a screen meant to stay open and refresh itself.
export default function AIUsagePage() {
  const { accessToken } = useAdminAuth();
  const [period, setPeriod] = useState("30d");
  const [state, setState] = useState({ status: "loading", data: null });

  const load = useCallback(async (p) => {
    setState({ status: "loading", data: null });
    const result = await fetchAIUsage(accessToken, p);
    if (!result.ok) { setState({ status: "error", data: null }); return; }
    setState({ status: "ready", data: result.data });
  }, [accessToken]);

  useEffect(() => { load(period); }, [load, period]);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20, gap: 16, flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 20, fontWeight: 700, color: TEXT }}>AI Usage & Cost</div>
          <div style={{ fontSize: 13, color: MUTED }}>Anthropic requests, tokens, and spend across the product.</div>
        </div>
        <div style={{ display: "flex", gap: 4, background: SURFACE, border: `1px solid ${BORDER}`, borderRadius: 8, padding: 3 }}>
          {PERIODS.map((p) => (
            <button
              key={p.key}
              onClick={() => setPeriod(p.key)}
              style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: period === p.key ? ACCENT : "transparent", color: period === p.key ? "#fff" : MUTED, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {state.status === "loading" && (
        <div style={{ padding: "48px 0", textAlign: "center", color: MUTED, fontSize: 13.5 }}>Loading AI usage…</div>
      )}

      {state.status === "error" && (
        <div style={{ padding: "48px 0", textAlign: "center" }}>
          <div style={{ color: DANGER, fontSize: 13.5, marginBottom: 12 }}>Couldn't load AI usage. Check your connection and try again.</div>
          <button onClick={() => load(period)} style={{ padding: "8px 18px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            Try again
          </button>
        </div>
      )}

      {state.status === "ready" && (() => {
        const d = state.data;
        const t = d.totals;
        const errorTone = t.errorRate > 0.05 ? DANGER : t.errorRate > 0 ? WARNING : TEXT;
        return (
          <>
            <Card title="Totals">
              <StatGrid>
                <Stat label="Requests" value={t.requests.toLocaleString()} />
                <Stat label="Tokens in" value={formatTokens(t.tokensIn)} />
                <Stat label="Tokens out" value={formatTokens(t.tokensOut)} />
                <Stat label="Total tokens" value={formatTokens(t.tokensTotal)} />
                <Stat label="Cost" value={formatUsd(t.costUsd)} tone={ACCENT} />
                <Stat label="Errors" value={`${t.errorCount} (${(t.errorRate * 100).toFixed(1)}%)`} tone={errorTone} />
                <Stat label="Avg latency" value={formatMs(t.avgLatencyMs)} />
                <Stat label="P95 latency" value={formatMs(t.p95LatencyMs)} />
              </StatGrid>
              {d.truncated && (
                <div style={{ fontSize: 11.5, color: WARNING, marginTop: 8 }}>More than 5,000 requests occurred in this period — totals reflect only the most recent 5,000, not the full period.</div>
              )}
              {d.source === "usage_daily_summary" && (
                <div style={{ fontSize: 11.5, color: MUTED, marginTop: 8 }}>90-day view reads from the permanent daily-aggregate table (survives the 90-day detail-log cleanup) — P95 latency isn't available at this granularity, and today's still-in-progress activity isn't included yet.</div>
              )}
            </Card>

            <Card title="Usage & cost by group">
              <GroupTable groups={d.byGroup} />
              <div style={{ fontSize: 11.5, color: MUTED, marginTop: 10 }}>
                Always shows all 11 groups and their 38 known call sites, including ones with no usage yet ($0.00 / 0). Where several call sites share one underlying log tag (e.g. Proactive Job Alerts' three cadences), each shows that tag's real combined total rather than a fabricated split — sum by group, not by adding every row.
              </div>
            </Card>

            <Card title="Usage & cost by customer (top 20 by cost)">
              <Table
                emptyText="No AI requests in this period."
                columns={[
                  { key: "customer", label: "Customer", render: (r) => r.fullName || r.email || r.userId },
                  { key: "requests", label: "Requests", align: "right" },
                  { key: "tokens", label: "Tokens (in/out)", align: "right", render: (r) => `${formatTokens(r.tokensIn)} / ${formatTokens(r.tokensOut)}` },
                  { key: "costUsd", label: "Cost", align: "right", render: (r) => formatUsd(r.costUsd) },
                ]}
                rows={d.byCustomer}
              />
            </Card>

            <Card title="Usage by plan">
              <Table
                emptyText="No AI requests in this period."
                columns={[
                  { key: "plan", label: "Plan" },
                  { key: "requests", label: "Requests", align: "right" },
                  { key: "tokens", label: "Tokens (in/out)", align: "right", render: (r) => `${formatTokens(r.tokensIn)} / ${formatTokens(r.tokensOut)}` },
                  { key: "costUsd", label: "Cost", align: "right", render: (r) => formatUsd(r.costUsd) },
                ]}
                rows={d.byPlan}
              />
            </Card>
          </>
        );
      })()}
    </div>
  );
}

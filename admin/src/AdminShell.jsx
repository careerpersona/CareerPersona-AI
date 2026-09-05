import { useState, useEffect, useCallback } from "react";
import { useAdminAuth, ROLE_LABELS, hasRole } from "./useAdminAuth.js";
import { fetchImpersonationStatus, startImpersonation as apiStartImpersonation, endImpersonation as apiEndImpersonation } from "./lib/adminApi.js";
import DashboardPage from "./DashboardPage.jsx";
import CustomerListPage from "./CustomerListPage.jsx";
import CustomerDetailPage from "./CustomerDetailPage.jsx";
import CustomerBillingPage from "./CustomerBillingPage.jsx";
import SupportCaseListPage from "./SupportCaseListPage.jsx";
import SupportCaseDetailPage from "./SupportCaseDetailPage.jsx";
import SupportCaseFormPage from "./SupportCaseFormPage.jsx";
import StaffManagementPage from "./StaffManagementPage.jsx";
import SystemHealthPage from "./SystemHealthPage.jsx";
import AIUsagePage from "./AIUsagePage.jsx";
import { ACCENT, BG, SURFACE, BORDER, TEXT, MUTED, WARNING } from "./lib/theme.js";

// Hash routing, not a router library -- same convention the customer app
// itself uses. Kept local to this one file; if routes keep growing, this is
// the place to promote it into something less ad hoc, not before.
function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, "");
  if (h.startsWith("customers/")) {
    const rest = decodeURIComponent(h.slice("customers/".length));
    if (rest.endsWith("/billing")) return { view: "customerBilling", id: rest.slice(0, -"/billing".length) };
    return { view: "customerDetail", id: rest };
  }
  if (h === "customers") return { view: "customers" };
  if (h.startsWith("support-cases/new/")) {
    // Deferred Fix #2: the customer's display name/email travels alongside
    // the id as a `?label=` suffix on this same hash segment -- no new
    // endpoint or duplicated data, just carrying through the name
    // CustomerDetailPage already has in memory at the moment of the click.
    // The hash fragment never reaches the server (browsers don't send it
    // in requests), so this is no more exposed than the id already was.
    const rest = h.slice("support-cases/new/".length);
    const [idPart, queryPart] = rest.split("?");
    const presetCustomerLabel = queryPart ? new URLSearchParams(queryPart).get("label") : null;
    return { view: "supportCaseNew", presetUserId: decodeURIComponent(idPart), presetCustomerLabel };
  }
  if (h === "support-cases/new") return { view: "supportCaseNew", presetUserId: null, presetCustomerLabel: null };
  if (h.startsWith("support-cases/")) return { view: "supportCaseDetail", id: decodeURIComponent(h.slice("support-cases/".length)) };
  if (h === "support-cases") return { view: "supportCases" };
  if (h === "staff") return { view: "staff" };
  if (h === "system-health") return { view: "systemHealth" };
  if (h === "ai-usage") return { view: "aiUsage" };
  return { view: "home" };
}

// Customer Management is support-visibility scope -- mirrors the Worker's
// own CUSTOMER_MGMT_ROLES allowlist (support, superadmin; billing_ops
// excluded). This is a UI convenience only: the real enforcement is
// server-side in requireAdmin(), so a role check failing here just means a
// clean "you don't have access" message instead of a 403 the UI didn't
// expect -- it is not what makes this safe.
function canManageCustomers(role) {
  return hasRole(role, ["support"]);
}

// Billing/Stripe visibility (Work Order 4) is a narrower grant than general
// customer support visibility -- mirrors the Worker's own
// BILLING_MGMT_ROLES allowlist (billing_ops, superadmin; support excluded).
// Same "UX only" caveat as canManageCustomers above.
function canManageBilling(role) {
  return hasRole(role, ["billing_ops"]);
}

// Support Cases (Work Order 7) -- mirrors the Worker's own
// SUPPORT_CASE_ROLES allowlist (support, superadmin; billing_ops
// excluded). Currently identical to canManageCustomers, kept as a separate
// function (matching the Worker's separate constant) so the two can
// diverge later without one accidentally constraining the other.
function canManageSupportCases(role) {
  return hasRole(role, ["support"]);
}

// Staff Management (Work Order 9) -- superadmin only, matching the Worker's
// own STAFF_MGMT_ROLES exactly. Unlike every other module gate above, this
// one takes no other roles at all -- support and billing_ops have zero
// staff-management access, by design (WO9 section 2), not because they're
// simply excluded from a broader set the way billing_ops is excluded from
// CUSTOMER_MGMT_ROLES elsewhere.
function canManageStaff(role) {
  return hasRole(role, []);
}

// AI Usage & Cost -- mirrors the Worker's own BILLING_MGMT_ROLES allowlist
// (billing_ops, superadmin; support excluded), same gate as canManageBilling.
// This is company AI spend, not customer billing data, but the sensitivity
// class (financial, internal-only) is the same, so it reuses the same role
// boundary rather than inventing a separate one.
function canManageAiUsage(role) {
  return hasRole(role, ["billing_ops"]);
}

function NavLink({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      style={{ padding: "6px 12px", borderRadius: 7, border: "none", background: active ? "rgba(139,92,246,0.14)" : "transparent", color: active ? ACCENT : MUTED, fontSize: 13, fontWeight: 600, cursor: "pointer" }}
    >
      {children}
    </button>
  );
}

// True Customer Impersonation: the actual session, banner, and "Exit
// impersonation" control now live in the customer app's own tab (it holds
// the real session; this admin tab never does). This banner is a
// secondary reminder for the admin's own awareness -- "End" here just
// closes out the audit grant early from this side; it cannot reach into
// the other tab to force it closed (no channel exists between two
// separate browser tabs on different origins for that, by design -- see
// the Work Order report).
function ImpersonationBanner({ grant, onEnd }) {
  // Date.now() is impure to call directly during render (React flags it) --
  // seeded to null and set for real inside the effect below instead, same
  // as any other "read the current time" side effect.
  const [now, setNow] = useState(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (now == null) return null;

  const remainingMs = Math.max(0, new Date(grant.expiresAt).getTime() - now);
  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);

  return (
    <div style={{ background: WARNING, color: "#1a1400", padding: "8px 24px", display: "flex", alignItems: "center", justifyContent: "center", gap: 14, fontSize: 13, fontWeight: 700 }}>
      <span>🔒 Active impersonation session open in another tab: {grant.targetName || grant.targetUserId} — window closes in {minutes}:{String(seconds).padStart(2, "0")}</span>
      <button
        onClick={onEnd}
        style={{ padding: "3px 12px", borderRadius: 6, border: "1px solid #1a1400", background: "transparent", color: "#1a1400", fontSize: 12, fontWeight: 700, cursor: "pointer" }}
      >
        Close out grant
      </button>
    </div>
  );
}

function ModuleAccessDenied({ requiredRoleLabel }) {
  return (
    <div style={{ padding: "60px 0", textAlign: "center" }}>
      <div style={{ fontSize: 15, fontWeight: 700, color: TEXT, marginBottom: 8 }}>You don't have access to this module</div>
      <div style={{ fontSize: 13.5, color: MUTED }}>{requiredRoleLabel}</div>
    </div>
  );
}

export default function AdminShell() {
  const { email, role, accessToken, logout } = useAdminAuth();
  const [route, setRoute] = useState(parseHash);
  const hasCustomerAccess = canManageCustomers(role); // full detail view: support/superadmin
  const hasBillingAccess = canManageBilling(role); // billing page: billing_ops/superadmin
  const hasSupportCaseAccess = canManageSupportCases(role); // support/superadmin
  const hasStaffAccess = canManageStaff(role); // superadmin only
  const hasAiUsageAccess = canManageAiUsage(role); // billing_ops/superadmin
  const isSuperadmin = hasRole(role, []); // matches HIGH_RISK_ROLES server-side
  // List access: anyone who can reach either full detail or billing --
  // mirrors the Worker's CUSTOMER_LOOKUP_ROLES exactly (support ∪
  // billing_ops ∪ superadmin), not a new independent check.
  const hasLookupAccess = hasCustomerAccess || hasBillingAccess;

  useEffect(() => {
    const onHashChange = () => setRoute(parseHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  // Work Order 6: impersonation grant polling. Checked once on mount and
  // every 30s thereafter -- frequent enough that the banner reliably
  // reflects server-side expiry/end without being the kind of aggressive
  // polling System Health (Work Order 10) was explicitly told to avoid; a
  // 15-minute-TTL security-relevant grant genuinely warrants a livelier
  // check than an operational status page. Only superadmins can ever have
  // a grant (HIGH_RISK_ROLES), so this doesn't run for other roles.
  const [impersonation, setImpersonation] = useState(null);
  const checkImpersonation = useCallback(async () => {
    if (!isSuperadmin) return;
    const result = await fetchImpersonationStatus(accessToken);
    setImpersonation(result.ok && result.data.active ? result.data : null);
  }, [accessToken, isSuperadmin]);

  useEffect(() => {
    checkImpersonation();
    if (!isSuperadmin) return;
    const id = setInterval(checkImpersonation, 30000);
    return () => clearInterval(id);
  }, [checkImpersonation, isSuperadmin]);

  // True Customer Impersonation: the Worker returns a single-use
  // hashed_token (see handleAdminImpersonateStart) that the CUSTOMER app
  // itself redeems client-side -- this admin tab never holds a live
  // customer session at any point. Opened via window.open (not a
  // navigation), so the Back Office is never left; "returns the admin to
  // the Back Office" is trivially true because they never departed it.
  const handleStartImpersonation = async (customerId) => {
    const result = await apiStartImpersonation(accessToken, customerId);
    if (!result.ok) return;
    setImpersonation(result.data);
    const params = new URLSearchParams({ impersonate_token: result.data.hashedToken, impersonate_exp: Math.floor(new Date(result.data.expiresAt).getTime() / 1000) });
    window.open(`https://careerpersonaai.com/?${params}`, "_blank", "noopener");
  };
  const handleEndImpersonation = async () => {
    await apiEndImpersonation(accessToken);
    setImpersonation(null);
  };

  const goToDashboard = () => { window.location.hash = ""; };
  const goToCustomers = () => { window.location.hash = "#customers"; };
  const openCustomerDetail = (id) => { window.location.hash = `#customers/${id}`; };
  const openCustomerBilling = (id) => { window.location.hash = `#customers/${id}/billing`; };
  // billing_ops has no detail access -- a directory row click goes straight
  // to billing for that role, rather than through a detail page it can't see.
  const openCustomerFromList = hasCustomerAccess ? openCustomerDetail : openCustomerBilling;

  const goToSupportCases = () => { window.location.hash = "#support-cases"; };
  const openSupportCase = (id) => { window.location.hash = `#support-cases/${id}`; };
  const openNewSupportCase = (presetUserId, presetCustomerLabel) => {
    if (!presetUserId) { window.location.hash = "#support-cases/new"; return; }
    const labelSuffix = presetCustomerLabel ? `?label=${encodeURIComponent(presetCustomerLabel)}` : "";
    window.location.hash = `#support-cases/new/${presetUserId}${labelSuffix}`;
  };

  const goToStaff = () => { window.location.hash = "#staff"; };
  const goToSystemHealth = () => { window.location.hash = "#system-health"; };
  const goToAiUsage = () => { window.location.hash = "#ai-usage"; };

  let main;
  if (route.view === "customers" || route.view === "customerDetail" || route.view === "customerBilling") {
    if (route.view === "customerBilling") {
      main = hasBillingAccess
        ? <CustomerBillingPage customerId={route.id} onBack={hasCustomerAccess ? () => openCustomerDetail(route.id) : goToCustomers} />
        : <ModuleAccessDenied requiredRoleLabel="Billing requires the Billing Ops or Superadmin role." />;
    } else if (route.view === "customerDetail") {
      main = hasCustomerAccess
        ? <CustomerDetailPage
            customerId={route.id}
            onBack={goToCustomers}
            onOpenBilling={openCustomerBilling}
            onOpenNewCase={hasSupportCaseAccess ? openNewSupportCase : null}
            onStartImpersonation={isSuperadmin ? handleStartImpersonation : null}
          />
        : <ModuleAccessDenied requiredRoleLabel="Customer detail requires the Support or Superadmin role." />;
    } else if (hasLookupAccess) {
      main = <CustomerListPage onOpenCustomer={openCustomerFromList} />;
    } else {
      main = <ModuleAccessDenied requiredRoleLabel="Customer lookup requires the Support, Billing Ops, or Superadmin role." />;
    }
  } else if (route.view === "supportCases" || route.view === "supportCaseDetail" || route.view === "supportCaseNew") {
    if (!hasSupportCaseAccess) {
      main = <ModuleAccessDenied requiredRoleLabel="Support Cases requires the Support or Superadmin role." />;
    } else if (route.view === "supportCases") {
      main = <SupportCaseListPage onOpenCase={openSupportCase} onNewCase={() => openNewSupportCase(null)} />;
    } else if (route.view === "supportCaseNew") {
      main = <SupportCaseFormPage presetUserId={route.presetUserId} presetCustomerLabel={route.presetCustomerLabel} onCreated={openSupportCase} onCancel={route.presetUserId ? () => openCustomerDetail(route.presetUserId) : goToSupportCases} />;
    } else {
      main = <SupportCaseDetailPage caseId={route.id} onBack={goToSupportCases} onOpenCustomer={openCustomerDetail} />;
    }
  } else if (route.view === "staff") {
    main = hasStaffAccess
      ? <StaffManagementPage />
      : <ModuleAccessDenied requiredRoleLabel="Staff Management requires the Superadmin role." />;
  } else if (route.view === "systemHealth") {
    // Every active staff role can view System Health -- no ModuleAccessDenied
    // branch needed here, since reaching AdminShell at all already proves
    // the caller is support/billing_ops/superadmin (AdminAuthProvider only
    // renders AdminShell once status === "authorized").
    main = <SystemHealthPage />;
  } else if (route.view === "aiUsage") {
    main = hasAiUsageAccess
      ? <AIUsagePage />
      : <ModuleAccessDenied requiredRoleLabel="AI Usage & Cost requires the Billing Ops or Superadmin role." />;
  } else {
    // Every active staff role can load the dashboard (handleAdminDashboard
    // has no role restriction at the auth layer) -- which sections it
    // actually contains is decided server-side by role.
    main = <DashboardPage />;
  }

  return (
    <div style={{ minHeight: "100vh", background: BG, fontFamily: "-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", color: TEXT }}>
      {impersonation && <ImpersonationBanner grant={impersonation} onEnd={handleEndImpersonation} />}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 24px", borderBottom: `1px solid ${BORDER}`, background: SURFACE }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 26, height: 26, borderRadius: 7, background: ACCENT, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, color: "#fff", flexShrink: 0 }}>CP</div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Back Office</div>
          </div>
          <nav style={{ display: "flex", gap: 4 }}>
            <NavLink active={route.view === "home"} onClick={goToDashboard}>Dashboard</NavLink>
            {hasLookupAccess && (
              <NavLink active={route.view === "customers" || route.view === "customerDetail" || route.view === "customerBilling"} onClick={goToCustomers}>Customers</NavLink>
            )}
            {hasSupportCaseAccess && (
              <NavLink active={route.view === "supportCases" || route.view === "supportCaseDetail" || route.view === "supportCaseNew"} onClick={goToSupportCases}>Support Cases</NavLink>
            )}
            {hasStaffAccess && (
              <NavLink active={route.view === "staff"} onClick={goToStaff}>Staff</NavLink>
            )}
            {hasAiUsageAccess && (
              <NavLink active={route.view === "aiUsage"} onClick={goToAiUsage}>AI Usage</NavLink>
            )}
            <NavLink active={route.view === "systemHealth"} onClick={goToSystemHealth}>System Health</NavLink>
          </nav>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 13, color: MUTED }}>{email}</span>
            <span style={{ fontSize: 11, fontWeight: 700, color: ACCENT, background: "rgba(139,92,246,0.14)", borderRadius: 999, padding: "3px 9px", textTransform: "uppercase", letterSpacing: "0.04em" }}>
              {ROLE_LABELS[role] || role}
            </span>
          </div>
          <button
            onClick={logout}
            style={{ padding: "6px 14px", borderRadius: 7, border: `1px solid ${BORDER}`, background: "transparent", color: TEXT, fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main style={{ maxWidth: 900, margin: "0 auto", padding: "28px 24px" }}>
        {main}
      </main>
    </div>
  );
}

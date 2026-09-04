// Same Worker as the customer app (worker.js, project "proxy") -- the Back
// Office is a new set of routes on the existing Worker, not a new backend.
const WORKER_URL = "https://proxy.dawn-voice-2790.workers.dev";

// Calls GET /api/admin/session (Work Order 1). This is the ONLY source of
// truth for "is this person allowed in the Back Office, and at what role" --
// never inferred client-side from the Supabase session alone. Being
// authenticated is necessary but not sufficient; the Worker independently
// checks for an active row in the `staff` table via service_role.
//
// Returns a discriminated result rather than throwing, so callers can render
// a specific state (signed out vs. access denied vs. transient error)
// instead of a single generic failure.
export async function fetchAdminSession(accessToken) {
  let res;
  try {
    res = await fetch(`${WORKER_URL}/api/admin/session`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    return { ok: false, reason: "network_error" };
  }

  if (res.status === 401) return { ok: false, reason: "unauthenticated" };
  if (res.status === 403) return { ok: false, reason: "not_staff" };
  if (!res.ok) return { ok: false, reason: "server_error" };

  const body = await res.json();
  return { ok: true, userId: body.userId, role: body.role };
}

// Shared response handling for the Customer Management endpoints (Work
// Order 3+) -- same discriminated-result shape as fetchAdminSession above,
// so every caller can render a specific state instead of a generic failure.
// `errorCode` passes through the Worker's own {error: "..."} body (e.g.
// "stripe_api_error", "stripe_not_configured") for callers that need to
// distinguish more states than the HTTP status alone implies -- see
// fetchCustomerBilling, which has several such states (Work Order 4 item 6).
async function readAdminApiResponse(res) {
  if (res.status === 401) return { ok: false, reason: "unauthenticated" };
  if (res.status === 403) return { ok: false, reason: "forbidden" };
  if (res.status === 404) return { ok: false, reason: "not_found" };
  if (res.status === 400) {
    // errorCode added (Work Order 9) so a 400 can carry a specific reason
    // (e.g. cannot_modify_own_access, cannot_remove_last_superadmin)
    // instead of only the generic "bad_request" every existing caller
    // already handles -- reason stays "bad_request" unchanged, so no
    // existing caller's behavior changes; only StaffManagementPage reads
    // the new errorCode field.
    const errorCode = await res.json().then((b) => b?.error).catch(() => null);
    return { ok: false, reason: "bad_request", errorCode };
  }
  if (!res.ok) {
    const errorCode = await res.json().then((b) => b?.error).catch(() => null);
    return { ok: false, reason: "server_error", errorCode };
  }
  return { ok: true, data: await res.json() };
}

// GET /api/admin/customers -- searchable, paginated customer directory.
export async function fetchCustomers(accessToken, { q = "", page = 1, pageSize = 25 } = {}) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (q) params.set("q", q);
  try {
    const res = await fetch(`${WORKER_URL}/api/admin/customers?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return await readAdminApiResponse(res);
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

// GET /api/admin/customers/detail?id= -- single customer's support view.
export async function fetchCustomerDetail(accessToken, id) {
  try {
    const res = await fetch(`${WORKER_URL}/api/admin/customers/detail?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return await readAdminApiResponse(res);
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

// GET /api/admin/customers/billing?id= -- Stripe-authoritative billing view
// (Work Order 4). billing_ops/superadmin only -- the Worker enforces this;
// see AdminShell's canManageBilling for the (UX-only) frontend mirror.
export async function fetchCustomerBilling(accessToken, id) {
  try {
    const res = await fetch(`${WORKER_URL}/api/admin/customers/billing?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return await readAdminApiResponse(res);
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

// GET /api/admin/dashboard -- operations overview (Work Order 6). Every
// staff role can call this; which fields the response actually contains is
// decided server-side by role (see handleAdminDashboard) -- the frontend
// just renders whatever sections are present, never assumes a section
// exists.
export async function fetchDashboard(accessToken) {
  try {
    const res = await fetch(`${WORKER_URL}/api/admin/dashboard`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return await readAdminApiResponse(res);
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

// Shared POST helper for the mutating support-case endpoints (Work Order 7)
// -- same discriminated-result shape as every GET helper above.
async function postAdminApi(accessToken, path, body) {
  try {
    const res = await fetch(`${WORKER_URL}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return await readAdminApiResponse(res);
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

// GET /api/admin/support-cases -- searchable, paginated case list.
export async function fetchSupportCases(accessToken, { q = "", status = "", priority = "", userId = "", page = 1, pageSize = 25 } = {}) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (q) params.set("q", q);
  if (status) params.set("status", status);
  if (priority) params.set("priority", priority);
  if (userId) params.set("userId", userId);
  try {
    const res = await fetch(`${WORKER_URL}/api/admin/support-cases?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return await readAdminApiResponse(res);
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

// GET /api/admin/support-cases/detail?id= -- a case plus its internal notes.
export async function fetchSupportCaseDetail(accessToken, id) {
  try {
    const res = await fetch(`${WORKER_URL}/api/admin/support-cases/detail?id=${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return await readAdminApiResponse(res);
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

export async function createSupportCase(accessToken, { userId, subject, description, priority }) {
  return postAdminApi(accessToken, "/api/admin/support-cases", { userId, subject, description, priority });
}

// Partial update -- only include the keys actually being changed. Pass
// assignedTo: null explicitly to unassign (vs. omitting it to leave as-is).
export async function updateSupportCase(accessToken, patch) {
  return postAdminApi(accessToken, "/api/admin/support-cases/update", patch);
}

export async function addSupportCaseNote(accessToken, { caseId, note }) {
  return postAdminApi(accessToken, "/api/admin/support-cases/notes", { caseId, note });
}

// POST /api/admin/customers/cancel-deletion -- the one customer account
// action Work Order 8 implements (see worker.js's own comment on
// handleAdminCancelCustomerDeletion for why this is the only one).
export async function cancelCustomerDeletion(accessToken, userId) {
  return postAdminApi(accessToken, "/api/admin/customers/cancel-deletion", { userId });
}

// GET /api/admin/staff -- active staff roster, for the case-assignment
// picker only (Work Order 7).
export async function fetchStaffRoster(accessToken) {
  try {
    const res = await fetch(`${WORKER_URL}/api/admin/staff`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return await readAdminApiResponse(res);
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

// GET /api/admin/staff-directory -- full staff roster for Staff Management
// (Work Order 9), superadmin only. Distinct from fetchStaffRoster above --
// see worker.js's handleAdminStaffDirectory for why these stay two separate
// endpoints rather than one shared shape.
export async function fetchStaffDirectory(accessToken) {
  try {
    const res = await fetch(`${WORKER_URL}/api/admin/staff-directory`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return await readAdminApiResponse(res);
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

// Partial update -- pass staffUserId plus role and/or active. Same
// discriminated-result shape as every other admin mutation; the caller
// inspects `errorCode` (cannot_modify_own_access, cannot_remove_last_superadmin,
// invalid_role, etc.) to show a specific message rather than a generic one.
export async function updateStaff(accessToken, patch) {
  return postAdminApi(accessToken, "/api/admin/staff/update", patch);
}

// GET /api/admin/system-health -- Work Order 10. Every active staff role
// can call this (no role restriction, unlike every other module).
export async function fetchSystemHealth(accessToken) {
  try {
    const res = await fetch(`${WORKER_URL}/api/admin/system-health`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return await readAdminApiResponse(res);
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

// ─── High-risk customer operations (Work Order 6) ──────────────────────────
// All superadmin-only server-side except billingPortalLink (billing_ops too,
// see worker.js's handleAdminBillingPortalLink for why). Every mutation here
// follows the same discriminated-result + errorCode pattern as the rest of
// this file; the caller shows a specific confirmation-and-error UI per
// action rather than a generic "something went wrong."

export async function refundCharge(accessToken, { userId, chargeId, amount, reason, caseId }) {
  return postAdminApi(accessToken, "/api/admin/customers/refund", { userId, chargeId, amount, reason, caseId });
}

export async function cancelCustomerSubscription(accessToken, userId) {
  return postAdminApi(accessToken, "/api/admin/customers/subscription/cancel", { userId });
}

export async function resumeCustomerSubscription(accessToken, userId) {
  return postAdminApi(accessToken, "/api/admin/customers/subscription/resume", { userId });
}

export async function changeCustomerPlan(accessToken, userId, plan) {
  return postAdminApi(accessToken, "/api/admin/customers/subscription/change-plan", { userId, plan });
}

export async function generateBillingPortalLink(accessToken, userId) {
  return postAdminApi(accessToken, "/api/admin/customers/billing-portal-link", { userId });
}

export async function scheduleCustomerDeletion(accessToken, userId) {
  return postAdminApi(accessToken, "/api/admin/customers/schedule-deletion", { userId });
}

export async function triggerPasswordReset(accessToken, userId) {
  return postAdminApi(accessToken, "/api/admin/customers/reset-password", { userId });
}

export async function revokeCustomerSessions(accessToken, userId) {
  return postAdminApi(accessToken, "/api/admin/customers/revoke-sessions", { userId });
}

export async function startImpersonation(accessToken, userId) {
  return postAdminApi(accessToken, "/api/admin/customers/impersonate/start", { userId });
}

export async function endImpersonation(accessToken) {
  return postAdminApi(accessToken, "/api/admin/customers/impersonate/end", {});
}

// Polled by AdminShell to render/refresh the impersonation banner -- not
// audited server-side (see handleAdminImpersonateStatus), so safe to call
// on a light interval without generating audit noise.
export async function fetchImpersonationStatus(accessToken) {
  try {
    const res = await fetch(`${WORKER_URL}/api/admin/customers/impersonate/status`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return await readAdminApiResponse(res);
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

export async function updateCustomerProfile(accessToken, userId, fields) {
  return postAdminApi(accessToken, "/api/admin/customers/profile/update", { userId, fields });
}

// ─── Staff Invitation & Onboarding ──────────────────────────────────────────
export async function inviteStaff(accessToken, email, role) {
  return postAdminApi(accessToken, "/api/admin/staff/invite", { email, role });
}

export async function fetchStaffInvitations(accessToken) {
  try {
    const res = await fetch(`${WORKER_URL}/api/admin/staff/invitations`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return await readAdminApiResponse(res);
  } catch {
    return { ok: false, reason: "network_error" };
  }
}

export async function revokeStaffInvitation(accessToken, userId) {
  return postAdminApi(accessToken, "/api/admin/staff/invite/revoke", { userId });
}

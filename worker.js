// ─── CareerPersona AI — Cloudflare Worker ────────────────────────────────────
// Blueprint #1 auth chain: JWT verify → KV lookup → Supabase fallback
//   → Layer 1 getCapabilities() → Layer 2 check_and_consume_quota → execute
//
// Routes (no auth):
//   GET  /health                       → health + connectivity check
//   POST /api/jobs                     → job search (Adzuna + JSearch, unchanged)
//
// Routes (JWT auth required):
//   POST /                             → Claude AI proxy + entitlement + quota
//   POST /api/billing/checkout-session → create Stripe Checkout session
//   POST /api/billing/confirm-session  → optimistic upgrade after checkout
//   POST /api/billing/cancel           → set cancel_at_period_end (FTC)
//   POST /api/billing/resume           → clear cancel_at_period_end
//   POST /api/billing/portal-session   → Stripe Customer Portal session
//   POST /api/account/request-deletion → schedule 30-day account deletion, cancel Stripe immediately
//   POST /api/account/cancel-deletion  → revert a scheduled (not yet started) deletion
//
// Routes (Stripe HMAC — no JWT):
//   POST /webhooks/stripe              → process billing events, invalidate KV
//
// Routes (JWT auth + staff record required — Back Office, admin.careerpersonaai.com):
//   GET  /api/admin/session             → verify caller is active staff, return their role
//   GET  /api/admin/customers           → searchable, paginated customer directory (support/billing_ops/superadmin;
//                                          billing_ops gets a trimmed id/name/email/plan/status-only row shape)
//   GET  /api/admin/customers/detail    → single customer's full account/usage/activity (support/superadmin)
//   GET  /api/admin/customers/billing   → Stripe-authoritative billing/payments/refunds/disputes (billing_ops/superadmin)
//   GET  /api/admin/dashboard           → operations overview, sections conditional on role (any staff role;
//                                          customer/product sections for support/superadmin, billing/revenue for billing_ops/superadmin)
//   GET  /api/admin/support-cases           → searchable, paginated support case list (support/superadmin)
//   GET  /api/admin/support-cases/detail    → single case + its internal notes (support/superadmin)
//   POST /api/admin/support-cases           → create a case (support/superadmin)
//   POST /api/admin/support-cases/update    → update status/priority/assignment/subject/description (support/superadmin)
//   POST /api/admin/support-cases/notes     → add an internal note (support/superadmin)
//   GET  /api/admin/staff                   → active staff roster, for the case-assignment picker only (support/superadmin)
//   POST /api/admin/customers/cancel-deletion → cancel an already-scheduled account deletion on a customer's
//                                          behalf (support/superadmin); reuses cancelScheduledDeletion(), the same
//                                          logic /api/account/cancel-deletion runs for a customer acting on their own account
//   GET  /api/admin/staff-directory          → full staff roster, active + inactive, with role/active/granted/last-sign-in (superadmin only)
//   POST /api/admin/staff/update             → change a staff member's role and/or active status (superadmin only);
//                                          blocks self-lockout and demoting/deactivating the last active superadmin
//   GET  /api/admin/system-health            → worker/database/KV/Stripe status + overall (any active staff role;
//                                          no audit logging, same as the dashboard -- an aggregate operational read)
//   GET  /api/admin/ai-usage                 → AI requests/tokens/cost/errors/latency, by feature/customer/plan
//                                          (billing_ops/superadmin -- company AI spend, same sensitivity as
//                                          Stripe revenue; no audit logging, aggregate read like the dashboard
//                                          and System Health). period=today/7d/30d reads ai_request_log
//                                          (90-day ledger, precise incl. p95 latency); period=90d reads the
//                                          permanent usage_daily_summary aggregate instead (no p95 -- a daily
//                                          sum has no per-request distribution)
//   High-risk customer operations (Work Order 6), all superadmin-only unless noted:
//   POST /api/admin/customers/refund                    → refund a specific charge (full or partial)
//   POST /api/admin/customers/subscription/cancel        → cancel a customer's subscription on their behalf
//   POST /api/admin/customers/subscription/resume        → resume a customer's subscription on their behalf
//   POST /api/admin/customers/subscription/change-plan   → change a customer's plan (pro/premium) on their behalf
//   POST /api/admin/customers/billing-portal-link        → generate a Stripe Billing Portal link for a customer
//                                          (billing_ops/superadmin -- never touches card data, matches the billing-view tier)
//   POST /api/admin/customers/schedule-deletion          → schedule the existing 30-day account deletion on a
//                                          customer's behalf (reversible via the existing cancel-deletion action;
//                                          there is no immediate/permanent purge exposed anywhere)
//   POST /api/admin/customers/reset-password              → trigger Supabase's own password-reset email (staff
//                                          never sees or sets a password; the customer is always notified)
//   POST /api/admin/customers/revoke-sessions             → revoke a customer's active sessions
//   POST /api/admin/customers/impersonate/start           → start a time-limited (15 min), audited real customer
//                                          session via generate_link (redeemed client-side by the customer app)
//   POST /api/admin/customers/impersonate/end             → end it early
//   GET  /api/admin/customers/impersonate/status          → poll the caller's own active impersonation grant, if any
//   POST /api/admin/customers/profile/update              → edit a fixed allowlist of customer profile fields
//   Staff invitation (superadmin only unless noted):
//   POST /api/admin/staff/invite                          → invite a new staff member by email + role via
//                                          Supabase's generate_link (type: invite) -- no password ever created here
//   GET  /api/admin/staff/invitations                      → list pending (not yet accepted) invitations
//   POST /api/admin/staff/invite/revoke                    → revoke a pending invitation
//   POST /api/admin/staff/accept-invite                     → called by the invitee (any authenticated session with
//                                          a matching pending invitation, not yet staff) to accept and create their
//                                          own staff row
//   Every /api/admin/* path not listed here 404s explicitly rather than falling through to the Claude proxy catch-all.
//   See requireAdmin() for the auth chain: verified JWT (same as
//   requireAuth()) → active row in `staff` table via service_role,
//   optionally restricted to specific roles. subscription_status is never
//   consulted for this check.)

import { extractSkillKeywords } from "./src/lib/compatibility/skills.js";
// Shared platform infrastructure (2026-08-06) -- extracted from this file's
// own former private helpers, which already served two consumers
// (handleJobSearch + Proactive Job Alerts) before the extraction. Smart
// Apply Auto Prep is the third consumer. See the module's own header for the
// pre-extraction verification performed before moving this code.
import { fetchAdzuna, fetchRapid, fetchFreshPostings, deduplicate } from "./src/lib/platform/jobDiscoveryService.js";
// Smart Apply Auto Prep (2026-08-06) -- reuses three existing pure engines
// unchanged: the Career Compatibility Engine (qualification), its own
// Qualification/Selection module (ranking), and the same generation/
// validation functions manual Smart Apply uses (relocated from App.jsx
// today so both callers share one implementation, per the locked
// blueprint's §7). getDailyPeriodKey/getMonthlyPeriodKey/combineBudgetResults
// are the pure halves of the AI Budget Manager -- the atomic RPC-calling half
// (checkAndConsumeAutomationBudget) must live in this file; see aiBudget.js's
// own header comment for why.
import { buildCompatibilityRecord } from "./src/lib/compatibility/index.js";
import { selectJobsForAutoPrep } from "./src/lib/smartApplyAutoPrep/selection.js";
import { buildSmartApplyPrompt, validateSmartApplyPackage } from "./src/lib/smartApply/generation.js";
import { getDailyPeriodKey, getMonthlyPeriodKey, combineBudgetResults } from "./src/lib/platform/aiBudget.js";
// Proactive Job Alerts -- Discovery Engine + AI Layer are pure src/lib/
// modules, imported directly, same pattern already proven above by
// extractSkillKeywords. Never reimplemented here -- see the "PROACTIVE JOB
// ALERTS" section below for the Scheduler/Delivery Pipeline code that calls
// these.
import {
  deduplicateOpportunities, filterAlreadyApplied, evaluateOpportunity,
  applyDiversityConstraint, applyBalanceConstraint, enforceDeliveryCaps,
} from "./src/lib/proactiveJobAlerts/discoveryEngine.js";
import {
  computeVolumeTrend, detectHiringFreeze, computeSalarySignal, computeSpeedOfFill,
  computeApplicationWindowStats, computePersonalOutcomeTiming, computeSeasonalPattern,
} from "./src/lib/proactiveJobAlerts/marketSignals.js";
import {
  computeAlertTrustScore, findMissedOpportunities, computeOpportunityEngagementTrends, computeDiscoveryCoverage,
} from "./src/lib/proactiveJobAlerts/effectivenessMetrics.js";
import {
  buildCriticalOpportunityPrompt, parseCriticalOpportunityResponse,
  buildWatchlistActivityPrompt, parseWatchlistActivityResponse,
  computeWeeklyAvailability, buildWeeklyAnalysesPrompt, parseWeeklyAnalysesResponse,
} from "./src/lib/proactiveJobAlerts/aiPrompts.js";
import { groupCandidatesByCompany, computeWatchlistActivityStates } from "./src/lib/proactiveJobAlerts/watchlistActivity.js";

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  "http://localhost:5173",
  "http://localhost:5180",
  "https://careerpersonaai.com",
  "https://admin.careerpersonaai.com", // Back Office — separate app, same Worker
  "https://careerpersona-admin.pages.dev", // Back Office — temporary production origin until admin.careerpersonaai.com custom domain is wired up
];

// KV TTL in seconds, keyed by subscription_status.
// More volatile states get shorter TTLs to pick up changes faster.
const KV_TTL = {
  pro_active:      1800,  // 30 min
  pro_past_due:    300,   // 5 min  — needs fast resolution
  pro_cancelled:   3600,  // 1 hr  — wait for current_period_end
  premium_active:  1800,  // 30 min
  admin:           3600,  // 1 hr  — rarely changes
  no_subscription: 3600,  // 1 hr  — stable until checkout
};
const CONFIG_KV_TTL = 3600; // platform_config values change rarely

// ─── CORS ─────────────────────────────────────────────────────────────────────

function getCorsHeaders(request) {
  const origin = request.headers.get("Origin") || "";
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
  const isLanDev = /^http:\/\/(\d{1,3}\.){3}\d{1,3}:\d+$/.test(origin);
  if (ALLOWED_ORIGINS.includes(origin) || isLanDev) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

function corsResponse(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...getCorsHeaders(request) },
  });
}

// ─── JWKS CACHE ───────────────────────────────────────────────────────────────
// Supabase user JWTs use ES256 (ECDSA P-256 asymmetric). The JWKS endpoint
// provides the EC public key needed for verification. Cached in KV 1 hour —
// Supabase rotates keys rarely and announces rotation in advance.

const JWKS_KV_KEY = "supabase_jwks";
const JWKS_TTL = 3600;

async function getJWKS(env) {
  try {
    const cached = await env.SUBSCRIPTION_CACHE.get(JWKS_KV_KEY, "json");
    if (cached) return cached;
  } catch (_) { /* KV unavailable — fall through */ }

  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`);
  if (!r.ok) throw new Error("jwks_fetch_failed");
  const jwks = await r.json();

  try {
    await env.SUBSCRIPTION_CACHE.put(JWKS_KV_KEY, JSON.stringify(jwks), {
      expirationTtl: JWKS_TTL,
    });
  } catch (_) { /* non-fatal */ }

  return jwks;
}

// ─── JWT VERIFICATION ─────────────────────────────────────────────────────────
// Supports ES256 (Supabase user tokens, verified via JWKS) and HS256 (legacy,
// verified via SUPABASE_JWT_SECRET). Header alg field determines the path.
// JWT ECDSA signatures are P1363 format (r||s, 64 bytes) — matches crypto.subtle directly.

function b64urlToBuffer(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
  return buf.buffer;
}

async function verifyJWT(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid_token_format");
  const [hdr, pay, sig] = parts;
  const dec = new TextDecoder();

  const header  = JSON.parse(dec.decode(b64urlToBuffer(hdr)));
  const payload = JSON.parse(dec.decode(b64urlToBuffer(pay)));
  const signedData = new TextEncoder().encode(`${hdr}.${pay}`);
  const { alg, kid } = header;

  if (alg === "ES256") {
    const jwks = await getJWKS(env);
    const jwk = jwks.keys?.find(k => !kid || k.kid === kid);
    if (!jwk) throw new Error("jwk_not_found");
    const key = await crypto.subtle.importKey(
      "jwk", jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false, ["verify"]
    );
    const valid = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" }, key, b64urlToBuffer(sig), signedData
    );
    if (!valid) throw new Error("invalid_signature");
  } else if (alg === "HS256") {
    if (!env.SUPABASE_JWT_SECRET) throw new Error("hs256_secret_not_configured");
    const key = await crypto.subtle.importKey(
      "raw", new TextEncoder().encode(env.SUPABASE_JWT_SECRET),
      { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const valid = await crypto.subtle.verify("HMAC", key, b64urlToBuffer(sig), signedData);
    if (!valid) throw new Error("invalid_signature");
  } else {
    throw new Error("unsupported_algorithm");
  }

  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    throw new Error("token_expired");
  }

  // Phase 8, C6 — explicit claim hardening, additive to the signature/expiry
  // checks above. Every caller of requireAuth() is invoked by the browser
  // with the user's own Supabase session access_token (never the
  // service_role key, which this Worker only ever uses server-side as a
  // REST API header via sbHeaders() -- it's never presented back to this
  // Worker as a Bearer token), and a real Supabase user session token always
  // carries aud="authenticated" and role="authenticated". Rejecting anything
  // else is a safe, exact-match check against the actual shape of every
  // legitimate token this function receives, not a guessed value.
  if (payload.aud !== "authenticated" || payload.role !== "authenticated") {
    throw new Error("invalid_claims");
  }

  return payload;
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────

// Phase 8, Finding C3 — server-side account-deletion lockout. Every caller of
// requireAuth() is protected by default: once profiles.deletion_status is
// 'scheduled' or 'in_progress', the request is rejected here, before the
// handler's own logic runs, so a new endpoint added later inherits the lock
// automatically instead of requiring every developer to remember to add a
// check. The two legitimate exceptions (request-deletion, cancel-deletion)
// opt out explicitly via { allowDeletionLocked: true } -- opt-out, not
// opt-in, so the safe behavior is the default one.
//
// The deletion_status read here is deliberately uncached (unlike
// getSubscription()'s KV-backed billing read) -- this is a security boundary,
// and a stale cached value could let a locked account slip through for the
// length of a cache TTL. If the read itself fails, the request is denied
// (fail closed), matching the same "both failing must deny, never grant"
// principle getSubscription() already documents for billing state.
async function requireAuth(request, env, options = {}) {
  const { allowDeletionLocked = false, isAdminCall = false } = options;
  const bearer = request.headers.get("Authorization") || "";
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : null;
  if (!token) return { ok: false, error: "unauthorized", status: 401 };
  let userId, isImpersonated;
  try {
    const payload = await verifyJWT(token, env);
    userId = payload.sub;
    if (!userId) return { ok: false, error: "unauthorized", status: 401 };
    // True Customer Impersonation (Work Order) -- a session established via
    // handleAdminImpersonateStart's generate_link + the customer app's own
    // client-side verifyOtp() carries amr = [{method:"otp",...}]. Verified
    // directly against the live Supabase project that this signature is
    // otherwise unreachable for a real customer session: the existing
    // password-recovery flow also produces an otp-derived session, but it
    // never reaches this Worker at all (ResetPasswordPage calls
    // supabase.auth.updateUser() directly against Supabase, then
    // immediately signs out -- see its own comment), and the customer app
    // offers no other magiclink/OTP sign-in path. Every real customer
    // login is password-based, so amr = [{method:"password",...}].
    isImpersonated = Array.isArray(payload.amr) && payload.amr.some((m) => m?.method === "otp");
  } catch (_) {
    return { ok: false, error: "unauthorized", status: 401 };
  }
  // Default-deny mutation lockout while impersonating: every customer-
  // facing caller of requireAuth() gets this for free, present and future,
  // without needing to remember to add it individually -- only a plain GET
  // is allowed, which is the entire point of impersonation (see what the
  // customer sees). Every actual mutation staff might need stays available
  // through the separately-audited, purpose-built Back Office actions
  // instead, never through acting as the customer directly. Exempted only
  // for the admin/staff auth chain itself (requireAdmin's own call below,
  // the one call site that passes isAdminCall: true) -- staff sessions
  // never carry this signature in practice, but this makes that exemption
  // explicit rather than incidental.
  if (isImpersonated && !isAdminCall && request.method !== "GET") {
    return { ok: false, error: "blocked_during_impersonation", status: 403 };
  }
  if (!allowDeletionLocked) {
    try {
      const rows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "deletion_status" }, env);
      const status = rows?.[0]?.deletion_status;
      if (status === "scheduled" || status === "in_progress") {
        return { ok: false, error: "account_scheduled_for_deletion", status: 423 };
      }
    } catch (_) {
      return { ok: false, error: "unauthorized", status: 401 };
    }
  }
  return { ok: true, userId, isImpersonated };
}

// ─── BACK OFFICE: ADMIN AUTH ──────────────────────────────────────────────────
// Authorization for admin.careerpersonaai.com. Deliberately independent of
// customer billing state: profiles.subscription_status ('admin' included) is
// a quota-exemption label, never an access-control decision, and is never
// read here. A caller must present a session JWT that passes the exact same
// verification every customer request passes (requireAuth() → verifyJWT()),
// AND have an `active = true` row in the `staff` table, looked up fresh on
// every call via service_role (never cached, never trusted from a JWT claim
// — the token has no admin/role claim to trust in the first place). Being
// authenticated is necessary but never sufficient; a customer with no staff
// row is rejected with 403, not 401.
//
// requireAuth() itself is reused for the JWT chain (identical verification),
// with the account-deletion lockout bypassed via allowDeletionLocked: true —
// that lockout protects a user's own customer data from writes while their
// account is scheduled for deletion, which has no bearing on whether they
// may act as staff on OTHER users' data.
//
// Pass { roles: ["superadmin"] } (etc.) to additionally require one of a
// specific set of roles; omit to allow any active staff row through.
async function requireAdmin(request, env, options = {}) {
  const auth = await requireAuth(request, env, { allowDeletionLocked: true, isAdminCall: true });
  if (!auth.ok) return auth;

  let staffRows;
  try {
    staffRows = await supabaseGet("staff", {
      user_id: `eq.${auth.userId}`,
      active: "eq.true",
      select: "role",
    }, env);
  } catch (_) {
    return { ok: false, error: "unauthorized", status: 401 };
  }

  const staff = staffRows?.[0];
  if (!staff) return { ok: false, error: "not_staff", status: 403 };

  const { roles } = options;
  if (roles && roles.length > 0 && !roles.includes(staff.role)) {
    return { ok: false, error: "insufficient_role", status: 403 };
  }

  return { ok: true, userId: auth.userId, role: staff.role };
}

// ─── BACK OFFICE: AUDIT LOG ───────────────────────────────────────────────────
// Every privileged action taken through /api/admin/* must call this before
// returning success. Unlike stripe_events' fire-and-forget audit write, this
// is awaited and any failure is treated as fatal to the calling request —
// an admin action whose audit record silently failed to write would defeat
// the entire point of having one. Callers should catch a thrown error here
// and respond with a failure, not swallow it.
// Deferred Fix #1 -- batched variant so a handler that needs to record
// several distinct events for ONE request (e.g. a support-case update that
// changes both status and priority) can write them as a single PostgREST
// INSERT with an array body, which Postgres executes as one atomic
// statement: either every row in the batch is written, or none are. This
// closes the "some events logged, others silently missing" gap a loop of
// individual POSTs would leave, on top of the audit-before-mutation
// reordering this fix applies at each call site (see logAdminAction below
// and each handler's own comment for why order matters here).
async function logAdminActions(events, env) {
  if (events.length === 0) return;
  await supabasePost("admin_audit_log", events.map(({ actorUserId, actorRole, action, targetUserId = null, before = null, after = null, metadata = null }) => ({
    actor_user_id: actorUserId,
    actor_role: actorRole,
    action,
    target_user_id: targetUserId,
    before,
    after,
    metadata,
  })), env);
}

async function logAdminAction(event, env) {
  await logAdminActions([event], env);
}

// ─── SUPABASE REST HELPERS ────────────────────────────────────────────────────
// All calls use service_role — bypasses RLS for billing writes.

function sbHeaders(env) {
  return {
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
  };
}

async function supabaseGet(table, params, env) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!r.ok) throw new Error(`supabase_get_${r.status}`);
  return r.json();
}

// Like supabaseGet, but also returns the total row count matching the filter
// (ignoring limit/offset) via PostgREST's exact-count Prefer header -- used
// for paginated admin listings, where the UI needs a total/page count
// without transferring every row. Cheap: PostgREST computes this as part of
// the same query plan, not a second round-trip.
async function supabaseGetWithCount(table, params, env) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), { headers: { ...sbHeaders(env), "Prefer": "count=exact" } });
  if (!r.ok) throw new Error(`supabase_get_${r.status}`);
  const rows = await r.json();
  const range = r.headers.get("content-range"); // e.g. "0-24/137"
  const total = range?.includes("/") ? parseInt(range.split("/")[1], 10) : rows.length;
  return { rows, total: Number.isFinite(total) ? total : rows.length };
}

async function supabasePatch(table, match, data, env) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(match)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), {
    method: "PATCH",
    headers: { ...sbHeaders(env), "Prefer": "return=representation" },
    body: JSON.stringify(data),
  });
  if (!r.ok) throw new Error(`supabase_patch_${r.status}`);
  return r.json();
}

async function supabasePost(table, data, env) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: { ...sbHeaders(env), "Prefer": "return=representation" },
    body: JSON.stringify(data),
  });
  const body = await r.text();
  if (!r.ok) {
    const err = Object.assign(new Error(`supabase_post_${r.status}`), { status: r.status, body });
    throw err;
  }
  return JSON.parse(body);
}

async function supabaseDelete(table, match, env) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
  for (const [k, v] of Object.entries(match)) url.searchParams.set(k, v);
  const r = await fetch(url.toString(), { method: "DELETE", headers: sbHeaders(env) });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw Object.assign(new Error(`supabase_delete_${r.status}`), { status: r.status, body });
  }
}

async function supabaseRPC(fn, args, env) {
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: sbHeaders(env),
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`supabase_rpc_${r.status}`);
  return r.json();
}

// Real last-sign-in, from Supabase Auth itself (Admin Users API) -- extracted
// (Work Order 9) so handleAdminCustomerDetail and the staff directory share
// one implementation instead of two copies of the same fetch. Non-fatal on
// failure: this is always a supplementary field, never the primary record,
// so the caller's response is still useful without it.
async function fetchLastSignInAt(userId, env) {
  try {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, { headers: sbHeaders(env) });
    if (r.ok) { const u = await r.json(); return u.last_sign_in_at ?? null; }
  } catch (_) { /* non-fatal */ }
  return null;
}

// ─── KV SUBSCRIPTION CACHE ────────────────────────────────────────────────────
// Blueprint #1: try KV first, fall back to Supabase, cache result.
// Key pattern: sub:{userId}

async function getSubscription(userId, env) {
  // KV read wrapped in try-catch: if KV is unavailable, fall through to Supabase.
  // Blueprint #1: KV → Supabase fallback; both failing must deny authorization safely.
  try {
    const cached = await env.SUBSCRIPTION_CACHE.get(`sub:${userId}`, "json");
    if (cached) return cached;
  } catch (_) { /* KV unavailable — fall through */ }

  const rows = await supabaseGet("profiles", {
    id: `eq.${userId}`,
    select: "subscription_status,trial_started_at,trial_ends_at,stripe_customer_id,stripe_subscription_id,current_period_start,current_period_end,cancel_at_period_end,grace_period_ends_at",
  }, env);
  // If supabaseGet throws here, the error propagates to the top-level catch → 500,
  // which denies authorization safely (no entitlements granted without verification).
  const sub = rows?.[0] ?? { subscription_status: "no_subscription" };

  // KV write is best-effort: failure is non-fatal (next request will re-query Supabase).
  try {
    const ttl = KV_TTL[sub.subscription_status] ?? 900;
    await env.SUBSCRIPTION_CACHE.put(`sub:${userId}`, JSON.stringify(sub), { expirationTtl: ttl });
  } catch (_) { /* non-fatal */ }

  return sub;
}

async function invalidateSubscription(userId, env) {
  // Non-fatal: if KV is unavailable, the stale entry will expire via TTL.
  try {
    await env.SUBSCRIPTION_CACHE.delete(`sub:${userId}`);
  } catch (_) { /* non-fatal */ }
}

// ─── PLATFORM CONFIG CACHE ────────────────────────────────────────────────────

async function getConfig(env) {
  try {
    const cached = await env.SUBSCRIPTION_CACHE.get("platform_config", "json");
    if (cached) return cached;
  } catch (_) { /* KV unavailable — fall through */ }

  const rows = await supabaseGet("platform_config", { select: "key,value" }, env);
  const config = Object.fromEntries((rows ?? []).map(r => [r.key, r.value]));

  try {
    await env.SUBSCRIPTION_CACHE.put("platform_config", JSON.stringify(config), { expirationTtl: CONFIG_KV_TTL });
  } catch (_) { /* non-fatal */ }

  return config;
}

// ─── ENTITLEMENT — LAYER 1 ───────────────────────────────────────────────────
// Pure function — no I/O. Computes capabilities from subscription state + config.
// Blueprint #1: getCapabilities(subscription, config) → capabilities object.

function getCapabilities(sub, config) {
  const status = sub.subscription_status ?? "no_subscription";
  const now = Date.now();
  // Launch V1 frozen quota ceilings (Unit Economics decision, locked -- not derived
  // or re-proposed here). Each of these four features tracks its own independent
  // feature_usage row (user_id+feature+period_key), so none can consume another's
  // budget. aiRequestLimit is unrelated and untouched -- still config-driven, still
  // shared identically between Pro and Premium as before.
  // interviewSessionLimit is a RAW AI-call count, not a session count -- one
  // interview_prep session fires multiple calls (question gen, feedback scoring,
  // mock summary), so 100/120 raw calls corresponds to ~10/~12 sessions.
  const proFeatureLimits = {
    resumeAnalysisLimit: 10, interviewSessionLimit: 100, salaryAnalysisLimit: 10, linkedinIntelligenceLimit: 10, networkingOutreachLimit: 20, smartApplyLimit: 20, jobIntelligenceLimit: 20, opportunityIntelligenceLimit: 20,
  };
  const premiumFeatureLimits = {
    resumeAnalysisLimit: 10, interviewSessionLimit: 120, salaryAnalysisLimit: 10, linkedinIntelligenceLimit: 10, networkingOutreachLimit: 20, smartApplyLimit: 30, jobIntelligenceLimit: 30, opportunityIntelligenceLimit: 30,
  };
  const adminFeatureLimits = {
    resumeAnalysisLimit: 2000, interviewSessionLimit: 2000, salaryAnalysisLimit: 2000, linkedinIntelligenceLimit: 2000, networkingOutreachLimit: 2000, smartApplyLimit: 2000, jobIntelligenceLimit: 2000, opportunityIntelligenceLimit: 2000,
  };
  const aiRequestLimit = parseInt(config.pro_ai_requests_monthly ?? "500");
  switch (status) {
    case "pro_active":
      return { plan: "pro", canUseAI: true, canUseJobs: true, aiRequestLimit, ...proFeatureLimits };
    case "premium_active":
      return { plan: "premium", canUseAI: true, canUseJobs: true, aiRequestLimit, ...premiumFeatureLimits };
    case "pro_past_due": {
      const grace = sub.grace_period_ends_at ? new Date(sub.grace_period_ends_at).getTime() : 0;
      const inGrace = grace > now;
      return {
        plan: "pro_past_due", canUseAI: inGrace, canUseJobs: true,
        aiRequestLimit:            inGrace ? aiRequestLimit : 0,
        resumeAnalysisLimit:       inGrace ? proFeatureLimits.resumeAnalysisLimit : 0,
        interviewSessionLimit:     inGrace ? proFeatureLimits.interviewSessionLimit : 0,
        salaryAnalysisLimit:       inGrace ? proFeatureLimits.salaryAnalysisLimit : 0,
        linkedinIntelligenceLimit: inGrace ? proFeatureLimits.linkedinIntelligenceLimit : 0,
        networkingOutreachLimit:   inGrace ? proFeatureLimits.networkingOutreachLimit : 0,
        smartApplyLimit:           inGrace ? proFeatureLimits.smartApplyLimit : 0,
        jobIntelligenceLimit:      inGrace ? proFeatureLimits.jobIntelligenceLimit : 0,
        opportunityIntelligenceLimit: inGrace ? proFeatureLimits.opportunityIntelligenceLimit : 0,
      };
    }
    case "pro_cancelled": {
      const end = sub.current_period_end ? new Date(sub.current_period_end).getTime() : 0;
      const active = end > now;
      return {
        plan: "pro_cancelled", canUseAI: active, canUseJobs: true,
        aiRequestLimit:            active ? aiRequestLimit : 0,
        resumeAnalysisLimit:       active ? proFeatureLimits.resumeAnalysisLimit : 0,
        interviewSessionLimit:     active ? proFeatureLimits.interviewSessionLimit : 0,
        salaryAnalysisLimit:       active ? proFeatureLimits.salaryAnalysisLimit : 0,
        linkedinIntelligenceLimit: active ? proFeatureLimits.linkedinIntelligenceLimit : 0,
        networkingOutreachLimit:   active ? proFeatureLimits.networkingOutreachLimit : 0,
        smartApplyLimit:           active ? proFeatureLimits.smartApplyLimit : 0,
        jobIntelligenceLimit:      active ? proFeatureLimits.jobIntelligenceLimit : 0,
        opportunityIntelligenceLimit: active ? proFeatureLimits.opportunityIntelligenceLimit : 0,
      };
    }
    case "premium_past_due": {
      const grace = sub.grace_period_ends_at ? new Date(sub.grace_period_ends_at).getTime() : 0;
      const inGrace = grace > now;
      return {
        plan: "premium_past_due", canUseAI: inGrace, canUseJobs: true,
        aiRequestLimit:            inGrace ? aiRequestLimit : 0,
        resumeAnalysisLimit:       inGrace ? premiumFeatureLimits.resumeAnalysisLimit : 0,
        interviewSessionLimit:     inGrace ? premiumFeatureLimits.interviewSessionLimit : 0,
        salaryAnalysisLimit:       inGrace ? premiumFeatureLimits.salaryAnalysisLimit : 0,
        linkedinIntelligenceLimit: inGrace ? premiumFeatureLimits.linkedinIntelligenceLimit : 0,
        networkingOutreachLimit:   inGrace ? premiumFeatureLimits.networkingOutreachLimit : 0,
        smartApplyLimit:           inGrace ? premiumFeatureLimits.smartApplyLimit : 0,
        jobIntelligenceLimit:      inGrace ? premiumFeatureLimits.jobIntelligenceLimit : 0,
        opportunityIntelligenceLimit: inGrace ? premiumFeatureLimits.opportunityIntelligenceLimit : 0,
      };
    }
    case "premium_cancelled": {
      const end = sub.current_period_end ? new Date(sub.current_period_end).getTime() : 0;
      const active = end > now;
      return {
        plan: "premium_cancelled", canUseAI: active, canUseJobs: true,
        aiRequestLimit:            active ? aiRequestLimit : 0,
        resumeAnalysisLimit:       active ? premiumFeatureLimits.resumeAnalysisLimit : 0,
        interviewSessionLimit:     active ? premiumFeatureLimits.interviewSessionLimit : 0,
        salaryAnalysisLimit:       active ? premiumFeatureLimits.salaryAnalysisLimit : 0,
        linkedinIntelligenceLimit: active ? premiumFeatureLimits.linkedinIntelligenceLimit : 0,
        networkingOutreachLimit:   active ? premiumFeatureLimits.networkingOutreachLimit : 0,
        smartApplyLimit:           active ? premiumFeatureLimits.smartApplyLimit : 0,
        jobIntelligenceLimit:      active ? premiumFeatureLimits.jobIntelligenceLimit : 0,
        opportunityIntelligenceLimit: active ? premiumFeatureLimits.opportunityIntelligenceLimit : 0,
      };
    }
    case "admin":
      return {
        plan: "admin", canUseAI: true, canUseJobs: true,
        aiRequestLimit: Infinity, ...adminFeatureLimits,
      };
    default: // no_subscription
      return { plan: "none", canUseAI: false, canUseJobs: true,
        aiRequestLimit: 0, resumeAnalysisLimit: 0, interviewSessionLimit: 0, salaryAnalysisLimit: 0, linkedinIntelligenceLimit: 0, networkingOutreachLimit: 0, smartApplyLimit: 0, jobIntelligenceLimit: 0, opportunityIntelligenceLimit: 0 };
  }
}

function getPeriodKey(sub) {
  const s = sub.subscription_status ?? "no_subscription";
  if (s === "no_subscription") return "free";
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function getFeatureLimit(feature, caps) {
  switch (feature) {
    case "resume_analysis":  return caps.resumeAnalysisLimit;
    case "interview_prep":   return caps.interviewSessionLimit;
    case "salary_analysis":  return caps.salaryAnalysisLimit;
    // Own explicit Launch V1 ceiling (no longer inherits Resume Analysis's limit) --
    // still a distinct feature tracked under its own feature_usage key.
    case "linkedin_intelligence": return caps.linkedinIntelligenceLimit;
    // 20/month Pro and Premium, per the confirmed Network Outreach pricing decision --
    // own dedicated ceiling, previously fell through to the generic aiRequestLimit.
    case "networking_outreach": return caps.networkingOutreachLimit;
    // 20/month Pro, 30/month Premium, per the locked Smart Apply quota decision --
    // own dedicated ceiling, previously fell through to the generic aiRequestLimit.
    // Manual generation only -- Smart Apply Auto Prep is a separate automation
    // budget (checkAndConsumeAutomationBudget / automation_preferences), untouched.
    case "smart_apply": return caps.smartApplyLimit;
    // 20/month Pro, 30/month Premium, per the locked Job Intelligence / Opportunity
    // Intelligence quota decision -- own dedicated ceilings, previously fell through
    // to the generic aiRequestLimit.
    case "job_intelligence": return caps.jobIntelligenceLimit;
    case "opportunity_intelligence": return caps.opportunityIntelligenceLimit;
    // Automatic continuations of an already-authorized primary action (a parallel
    // insights call, a post-improve re-score, a cover-letter refresh, a mock
    // interview's closing summary) -- never an independent customer request, so
    // never separately capped. Blocking these would leave a paid-for action
    // half-completed.
    case "resume_analysis_followup":
    case "interview_prep_followup":
      return Infinity;
    default:                 return caps.aiRequestLimit;
  }
}

// ─── CANONICAL BILLING STATE ─────────────────────────────────────────────────
// Single source of truth. Frontend renders billing UI exclusively from this
// enum + the accompanying billing state object — no scattered sub-field checks.

function computeBillingState(sub) {
  const status = sub.subscription_status ?? "no_subscription";
  const cancelAtPeriodEnd = sub.cancel_at_period_end ?? false;
  const now = Date.now();
  const periodEnd = sub.current_period_end   ? new Date(sub.current_period_end).getTime()   : 0;
  const graceEnd  = sub.grace_period_ends_at ? new Date(sub.grace_period_ends_at).getTime() : 0;
  switch (status) {
    case "pro_active":     return cancelAtPeriodEnd ? "PRO_CANCELING" : "PRO_ACTIVE";
    case "pro_past_due":   return graceEnd > now ? "PRO_PAST_DUE" : "PRO_EXPIRED";
    case "pro_cancelled":  return periodEnd > now ? "PRO_CANCELING" : "PRO_EXPIRED";
    case "premium_active": return cancelAtPeriodEnd ? "PREMIUM_CANCELING" : "PREMIUM_ACTIVE";
    case "premium_past_due":  return graceEnd > now ? "PREMIUM_PAST_DUE" : "PREMIUM_EXPIRED";
    case "premium_cancelled": return periodEnd > now ? "PREMIUM_CANCELING" : "PREMIUM_EXPIRED";
    case "admin":          return "ADMIN";
    default:               return "FREE";
  }
}

async function getUsage(userId, periodKey, env) {
  try {
    const rows = await supabaseGet("feature_usage", {
      user_id: `eq.${userId}`,
      period_key: `eq.${periodKey}`,
      select: "feature,usage_count",
    }, env);
    const map = {};
    for (const row of rows ?? []) map[row.feature] = row.usage_count;
    return map;
  } catch {
    return {};
  }
}

function computeQuotas(caps, usage) {
  const features = [
    { key: "ai_request",      limit: caps.aiRequestLimit },
    { key: "resume_analysis", limit: caps.resumeAnalysisLimit },
    { key: "interview_prep",  limit: caps.interviewSessionLimit },
    { key: "salary_analysis", limit: caps.salaryAnalysisLimit },
    { key: "linkedin_intelligence", limit: caps.linkedinIntelligenceLimit },
    { key: "networking_outreach", limit: caps.networkingOutreachLimit },
    { key: "smart_apply",     limit: caps.smartApplyLimit },
    { key: "job_intelligence", limit: caps.jobIntelligenceLimit },
    { key: "opportunity_intelligence", limit: caps.opportunityIntelligenceLimit },
  ];
  const quotas = {};
  for (const { key, limit } of features) {
    const used = usage[key] ?? 0;
    const unlimited = limit === Infinity;
    quotas[key] = { used, limit: unlimited ? null : limit, remaining: unlimited ? null : Math.max(0, limit - used), unlimited };
  }
  return quotas;
}

const BILLING_STATE_PLAN = {
  FREE: "Free",
  PRO_ACTIVE: "Pro", PRO_CANCELING: "Pro", PRO_PAST_DUE: "Pro", PRO_EXPIRED: "Pro",
  PREMIUM_ACTIVE: "Premium", PREMIUM_CANCELING: "Premium", PREMIUM_PAST_DUE: "Premium", PREMIUM_EXPIRED: "Premium",
  ADMIN: "Admin",
};

// ─── STRIPE REST HELPERS ──────────────────────────────────────────────────────
// No SDK — native fetch() only. Stripe REST uses form-encoded bodies.

async function stripeRequest(method, path, body, env) {
  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
  };
  if (body && method !== "GET") opts.body = new URLSearchParams(body).toString();
  const r = await fetch(`https://api.stripe.com/v1${path}`, opts);
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.error?.message ?? "stripe_error"), { stripeCode: data.error?.code });
  return data;
}

// Stripe moved current_period_start/current_period_end off the top-level
// Subscription object onto each SubscriptionItem (API change supporting
// multiple/flexible-billed items per subscription) -- confirmed directly
// against a live GET /subscriptions/{id} response during Phase 7 testing,
// where both fields were absent at the top level and present under
// items.data[0] instead. Every subscription this app creates has exactly
// one item (one price per subscription -- see handleCheckoutSession/
// handleChangePlan, both single-price), so item[0]'s period is simply the
// subscription's period. Applies uniformly everywhere a Subscription object
// is read, regardless of source (a direct GET/POST response or a webhook
// event's embedded data.object) -- it's the resource's current schema, not
// an endpoint-specific quirk.
function getSubscriptionPeriod(stripeSub) {
  const item = stripeSub.items?.data?.[0];
  return { start: item?.current_period_start ?? null, end: item?.current_period_end ?? null };
}

// Blueprint #4: HMAC-SHA256 Stripe webhook signature verification.
// Rejects events older than 5 minutes to prevent replay attacks.
async function verifyStripeSignature(rawBody, sigHeader, secret) {
  const parts = {};
  for (const seg of sigHeader.split(",")) {
    const eq = seg.indexOf("=");
    if (eq > 0) parts[seg.slice(0, eq)] = seg.slice(eq + 1);
  }
  if (!parts.t || !parts.v1) throw new Error("missing_sig_components");
  if (Math.abs(Date.now() / 1000 - parseInt(parts.t, 10)) > 300) throw new Error("timestamp_too_old");
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${parts.t}.${rawBody}`));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
  if (computed !== parts.v1) throw new Error("invalid_webhook_signature");
}

// ─── LOGGING ──────────────────────────────────────────────────────────────────
// Fire-and-forget via ctx.waitUntil — does not block the AI response.

// AI Usage & Cost metering -- $/1M-token rate per model, matching Anthropic's
// published pricing at the time this was written. Only one model is ever
// used today; this stays a map (not a bare constant) so a future model
// change doesn't silently go uncosted -- an unknown model computes a null
// cost rather than throwing, so metering can never block a real AI call.
const AI_MODEL_PRICING = {
  "claude-sonnet-4-6": { inputPerMTok: 3.00, outputPerMTok: 15.00 },
};

function computeAiCostUsd(model, tokensIn, tokensOut) {
  const pricing = AI_MODEL_PRICING[model];
  if (!pricing || tokensIn == null || tokensOut == null) return null;
  return (tokensIn / 1_000_000) * pricing.inputPerMTok + (tokensOut / 1_000_000) * pricing.outputPerMTok;
}

// `options` covers what the Fix KV Health Reporting/Staff Invitation work
// orders didn't need to touch: success/errorCode/latencyMs/model are all new
// (AI Usage & Cost work order) -- every existing call site is updated below
// to pass them, logging failures for the first time as well as successes.
async function logAIRequest(userId, feature, period, tokensIn, tokensOut, env, options = {}) {
  const { success = true, errorCode = null, latencyMs = null, model = "claude-sonnet-4-6" } = options;
  await supabasePost("ai_request_log", {
    user_id: userId, feature, model,
    tokens_in: tokensIn ?? null,
    tokens_out: tokensOut ?? null,
    period_key: period,
    success, error_code: errorCode, latency_ms: latencyMs,
    cost_usd: computeAiCostUsd(model, tokensIn, tokensOut),
  }, env);
}

// ─── JOB SEARCH ──────────────────────────────────────────────────────────────
// POST /api/jobs — no auth. EMP_TYPE_MAP/normalizeAdzuna/normalizeRapid/
// deduplicate/fetchAdzuna/fetchRapid relocated (2026-08-06) to the shared
// src/lib/platform/jobDiscoveryService.js -- imported above -- since they
// already served this endpoint AND Proactive Job Alerts before the
// extraction; Smart Apply Auto Prep is the third consumer. Behavior-preserving
// relocation, verified by direct diff against the pre-extraction source.

async function handleJobSearch(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);

  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 200_000) return corsResponse(request, { error: "Request too large" }, 413);
  const params = await request.json();
  if (!params.title || typeof params.title !== "string" || !params.title.trim()) {
    return corsResponse(request, { error: "title is required" }, 400);
  }
  const safeParams = {
    ...params,
    title: params.title.slice(0, 200),
    keywords: typeof params.keywords === "string" ? params.keywords.slice(0, 200) : "",
    city: typeof params.city === "string" ? params.city.slice(0, 200) : "",
    page: Math.min(Math.max(parseInt(params.page, 10) || 1, 1), 20),
  };
  const page = safeParams.page;
  const [adzunaResult, rapidResult] = await Promise.all([
    fetchAdzuna(safeParams, env, page),
    fetchRapid(safeParams, env, page),
  ]);
  const merged = deduplicate([...(adzunaResult.jobs || []), ...(rapidResult.jobs || [])]);
  const sorted = merged.sort((a, b) => {
    if (params.remote && a.remote !== b.remote) return a.remote ? -1 : 1;
    const da = a.datePosted ? new Date(a.datePosted) : new Date(0);
    const db = b.datePosted ? new Date(b.datePosted) : new Date(0);
    return db - da;
  });
  return corsResponse(request, {
    jobs: sorted, total: sorted.length, page,
    sources: { adzuna: (adzunaResult.jobs || []).length, rapidapi: (rapidResult.jobs || []).length },
    _debug: { adzuna: adzunaResult.debug, rapidapi: rapidResult.debug },
  });
}

// ─── ROUTE HANDLERS ───────────────────────────────────────────────────────────

// Neutral Supabase connectivity probe (Work Order 10) -- extracted so
// handleHealth, the dashboard's systemHealth section, and the admin System
// Health page all share one implementation of "can we reach Supabase"
// instead of three copies of the same platform_config select. Returns
// plain booleans, not a vocabulary string, so each caller can keep mapping
// to its own existing response shape (handleHealth's "ok"/"error"/
// "unconfigured", the dashboard's identical shape, or System Health's
// "healthy"/"unavailable") without changing what any of them already emit.
async function checkSupabaseHealth(env) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return { ok: false, configured: false };
  try {
    const rows = await supabaseGet("platform_config", { select: "key", limit: "1" }, env);
    return { ok: Array.isArray(rows), configured: true };
  } catch (_) {
    return { ok: false, configured: true };
  }
}

// KV connectivity probe (Work Order 10, now also used by handleHealth and
// the dashboard's systemHealth section -- Fix KV Health Reporting work
// order). A genuine round-trip check: writes and reads back a small,
// short-TTL, non-sensitive probe value -- nothing about a real customer or
// session is touched, and nothing about the probe is returned to callers
// beyond a plain ok/error status.
async function checkKvHealth(env) {
  const probeKey = "__health_probe__";
  const probeValue = String(Date.now());
  try {
    await env.SUBSCRIPTION_CACHE.put(probeKey, probeValue, { expirationTtl: 60 });
    const readBack = await env.SUBSCRIPTION_CACHE.get(probeKey);
    return { ok: readBack === probeValue };
  } catch (_) {
    return { ok: false };
  }
}

// Stripe connectivity + credential probe (Work Order 10) -- GET /v1/balance
// is Stripe's own recommended lightweight ping: it authenticates the API
// key and confirms reachability with no side effects and no business data
// of interest. The balance itself is discarded; only success/failure and
// Stripe's own (non-sensitive, Stripe-defined) error code are reported --
// never the raw error message, which in rare misconfigurations can echo
// part of the request back.
async function checkStripeHealth(env) {
  if (!env.STRIPE_SECRET_KEY) return { ok: false, configured: false };
  try {
    await stripeRequest("GET", "/balance", null, env);
    return { ok: true, configured: true };
  } catch (e) {
    return { ok: false, configured: true, code: e.stripeCode || "connectivity_error" };
  }
}

async function handleHealth(request, env) {
  const [db, kv] = await Promise.all([checkSupabaseHealth(env), checkKvHealth(env)]);
  return corsResponse(request, {
    status: "ok",
    ts: new Date().toISOString(),
    db: !db.configured ? "unconfigured" : db.ok ? "ok" : "error",
    kv: kv.ok ? "ok" : "error",
  }, 200);
}

// Blueprint #1 + #3: JWT auth → KV → Supabase → Layer 1 → Layer 2 → execute.
// `feature` field in body routes to the correct quota bucket; stripped before
// forwarding so Claude never sees it.
async function handleClaude(request, env, ctx) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 200_000) return corsResponse(request, { error: { message: "Request too large" } }, 413);

  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  const { userId } = auth;

  const b = await request.json();
  const { feature = "ai_request", ...claudeBody } = b;

  const [sub, config] = await Promise.all([getSubscription(userId, env), getConfig(env)]);
  const caps = getCapabilities(sub, config);

  // Layer 1: entitlement check
  if (!caps.canUseAI) {
    return corsResponse(request, { error: "not_entitled", upgradeRequired: true }, 403);
  }

  // Layer 1b: Application Outcome Intelligence is Premium/Admin only, per its
  // locked blueprint -- canUseAI alone is too broad (also true for Pro). Reuses
  // caps.plan, already computed by getCapabilities() above; no second
  // entitlement system, no new config, no quota/pricing change.
  if (feature === "outcome_intelligence" && caps.plan !== "premium" && caps.plan !== "admin") {
    return corsResponse(request, { error: "not_entitled", upgradeRequired: true }, 403);
  }

  // Layer 1c: Referral Intelligence is Premium/Admin only, per its locked ADR and
  // client-side isPremium gate -- canUseAI alone is too broad (also true for Pro),
  // and getFeatureLimit has no dedicated case for this feature so quota alone
  // wouldn't block it either (falls through to the generic aiRequestLimit, which
  // Pro also has). Same pattern as the outcome_intelligence check above -- reuses
  // caps.plan, no second entitlement system, no config or quota/pricing change.
  if (feature === "referral_intelligence" && caps.plan !== "premium" && caps.plan !== "admin") {
    return corsResponse(request, { error: "not_entitled", upgradeRequired: true }, 403);
  }

  // Layer 1d: LinkedIn Intelligence's Premium interpretive layer (Profile Strategy
  // Analysis, Recruiter Visibility Intelligence, Profile Evolution Tracking) is
  // Premium/Admin only -- the base content generation stays on the plain
  // "linkedin_intelligence" feature key, Pro-allowed, unaffected by this check.
  // Same pattern as Layer 1b/1c -- reuses caps.plan, no second entitlement system,
  // no config or quota/pricing change.
  if (feature === "linkedin_intelligence_premium" && caps.plan !== "premium" && caps.plan !== "admin") {
    return corsResponse(request, { error: "not_entitled", upgradeRequired: true }, 403);
  }

  // Layer 2: quota check (skip for unlimited capabilities like admin)
  const limit = getFeatureLimit(feature, caps);
  const period = getPeriodKey(sub);
  if (limit !== Infinity) {
    const quota = await supabaseRPC("check_and_consume_quota", {
      p_user_id: userId,
      p_feature: feature,
      p_limit: limit,
      p_period: period,
    }, env);
    if (!quota.allowed) {
      return corsResponse(request, { error: "quota_exhausted", upgradeRequired: true }, 429);
    }
  }

  const model = "claude-sonnet-4-6";
  const max_tokens = Math.min(Number(claudeBody.max_tokens) || 1000, 8000);
  const startedAt = Date.now();
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ ...claudeBody, model, max_tokens }),
  });
  const latencyMs = Date.now() - startedAt;
  const d = await r.json();

  if (!r.ok) {
    console.error('[handleClaude] Anthropic error', r.status, JSON.stringify(d));
  }

  // AI Usage & Cost work order: logged on every call now, not only success --
  // a failed call still needs to show up in the Back Office's error-rate and
  // latency figures. tokens_in/out are absent on failure (Anthropic didn't
  // return usage), so cost_usd computes to null for that row, same as before.
  if (ctx?.waitUntil) {
    ctx.waitUntil(logAIRequest(userId, feature, period, d.usage?.input_tokens, d.usage?.output_tokens, env, {
      success: r.ok, errorCode: r.ok ? null : String(r.status), latencyMs, model,
    }));
  }

  return corsResponse(request, d, r.status);
}

// Authoritative server-side tier detection -- the ONLY thing that decides
// pro_active vs premium_active (and their past_due/cancelled equivalents) is
// the actual Stripe Price ID attached to the actual Stripe Subscription
// object, compared against the two configured Price IDs. Never reads a
// client-supplied plan; a Checkout Session's requested `plan` only picks
// which price to charge, it never bypasses this check. Defaults to "pro" for
// any subscription whose price doesn't match the configured Premium Price ID
// (including when Premium isn't configured yet) -- matches today's existing
// behavior exactly and never silently grants Premium entitlement.
function determineTierFromStripeSubscription(stripeSub, config) {
  const priceId = stripeSub?.items?.data?.[0]?.price?.id;
  if (priceId && config.stripe_price_id_premium && priceId === config.stripe_price_id_premium) {
    return "premium";
  }
  return "pro";
}

// Blueprint #3: create Stripe Checkout session. Get-or-create Stripe customer,
// then create a subscription checkout. Returns { url } for frontend redirect.
// `plan` ("pro" | "premium", body param, defaults to "pro" so the existing
// no-body Pro call keeps working unchanged) only selects which Price ID this
// Checkout Session is created for -- it never establishes entitlement itself.
// The actual tier a user is granted is always re-derived server-side from the
// real Stripe subscription object once payment completes (see
// determineTierFromStripeSubscription), never trusted from this request.
async function handleCheckoutSession(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  if (!env.STRIPE_SECRET_KEY) return corsResponse(request, { error: "stripe_not_configured" }, 503);
  const { userId } = auth;
  let plan = "pro";
  try {
    const body = await request.json();
    if (body?.plan === "premium") plan = "premium";
  } catch (_) { /* no body / not JSON — default to "pro", preserves the existing call shape */ }
  const config = await getConfig(env);
  const priceId = plan === "premium" ? config.stripe_price_id_premium : config.stripe_price_id_pro;
  // Fails safely rather than attempting checkout with a placeholder: until a
  // real Premium Price ID is set in platform_config, Premium checkout is
  // simply unavailable, same 503 shape Pro already uses when unconfigured.
  if (!priceId) return corsResponse(request, { error: plan === "premium" ? "premium_price_not_configured" : "stripe_price_not_configured" }, 503);
  const rows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "stripe_customer_id" }, env);
  const profile = rows?.[0];
  if (!profile) return corsResponse(request, { error: "user_not_found" }, 404);
  let customerId = profile.stripe_customer_id;
  if (!customerId) {
    const userR = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      headers: {
        "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    const user = await userR.json();
    const customer = await stripeRequest("POST", "/customers", {
      email: user.email ?? "",
      "metadata[supabase_user_id]": userId,
    }, env);
    customerId = customer.id;
    await supabasePatch("profiles", { id: `eq.${userId}` }, { stripe_customer_id: customerId }, env);
    await invalidateSubscription(userId, env);
  }
  const appUrl = "https://careerpersonaai.com";
  // International currency: Stripe's own Adaptive Pricing, not a currency
  // system of our own. The Price stays USD (the $29.99/$39.99 reference
  // price, untouched) -- Stripe detects the customer's location, presents
  // and charges an equivalent local-currency amount using a Stripe-guaranteed
  // exchange rate, and reports the real charged amount back via
  // presentment_details on the Checkout Session / PaymentIntent events. We
  // never compute, store, or branch on a currency or exchange rate anywhere
  // in this codebase. `adaptive_pricing[enabled]: true` is passed explicitly
  // per-session (rather than relying silently on the Dashboard default) so
  // this stays correct even if that account-level default is ever changed --
  // it still requires Adaptive Pricing to be enabled for the account (see
  // the Dashboard action noted at this function's top).
  //
  // This is a Checkout Session-only parameter -- once a subscription is
  // created this way, Stripe continues billing every subsequent invoice for
  // that subscription (renewals, and the proration/next-cycle invoices from
  // handleChangePlan's upgrade/downgrade below) in the same established
  // presentment currency automatically. Neither the Subscription Update API
  // nor the Subscription Schedule API used by handleChangePlan has an
  // adaptive-pricing parameter of its own -- none is needed, since currency
  // presentment is a property of the subscription's off-session payment
  // setup from checkout time, not of each individual price change.
  const session = await stripeRequest("POST", "/checkout/sessions", {
    customer: customerId,
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    "adaptive_pricing[enabled]": "true",
    success_url: `${appUrl}/#pricing?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/#pricing`,
    "subscription_data[metadata][supabase_user_id]": userId,
  }, env);
  return corsResponse(request, { url: session.url });
}

// Blueprint #3: optimistic upgrade — called by frontend after Stripe success redirect.
// Updates profiles immediately without waiting for the webhook, so UI feels instant.
async function handleConfirmSession(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  if (!env.STRIPE_SECRET_KEY) return corsResponse(request, { error: "stripe_not_configured" }, 503);
  const { userId } = auth;
  const { session_id } = await request.json();
  if (!session_id) return corsResponse(request, { error: "missing_session_id" }, 400);
  const session = await stripeRequest("GET", `/checkout/sessions/${session_id}`, null, env);
  const rows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "stripe_customer_id" }, env);
  if (session.customer !== rows?.[0]?.stripe_customer_id) {
    return corsResponse(request, { error: "session_not_owned" }, 403);
  }
  if (session.payment_status !== "paid") {
    return corsResponse(request, { success: false, status: session.status, payment_status: session.payment_status });
  }
  const stripeSub = await stripeRequest("GET", `/subscriptions/${session.subscription}`, null, env);
  const config = await getConfig(env);
  const tier = determineTierFromStripeSubscription(stripeSub, config);
  const newStatus = tier === "premium" ? "premium_active" : "pro_active";
  const period = getSubscriptionPeriod(stripeSub);
  await supabasePatch("profiles", { id: `eq.${userId}` }, {
    subscription_status: newStatus,
    stripe_subscription_id: stripeSub.id,
    current_period_start: new Date(period.start * 1000).toISOString(),
    current_period_end: new Date(period.end * 1000).toISOString(),
    cancel_at_period_end: stripeSub.cancel_at_period_end,
  }, env);
  await invalidateSubscription(userId, env);
  return corsResponse(request, { success: true, subscription_status: newStatus });
}

// Blueprint #3 + FTC compliance: cancel at period end — never immediate.
// Extracted (Work Order 6 / high-risk admin operations) so both the
// customer's own self-service endpoint and the Back Office's admin-on-
// behalf-of-customer endpoint run the exact same Stripe logic -- one
// implementation of "what does cancelling a subscription actually do,"
// not two. Behavior unchanged from before the extraction.
async function cancelSubscriptionForUser(userId, env) {
  if (!env.STRIPE_SECRET_KEY) return { ok: false, error: "stripe_not_configured", status: 503 };
  const rows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "stripe_subscription_id" }, env);
  const subId = rows?.[0]?.stripe_subscription_id;
  if (!subId) return { ok: false, error: "no_active_subscription", status: 400 };

  // A pending Premium -> Pro downgrade (handleChangePlan) attaches a Subscription
  // Schedule to this subscription. Stripe's own docs warn that modifying a
  // schedule-managed subscription directly via the plain Subscriptions API "can
  // produce unexpected behavior" -- so release the schedule first (its documented
  // detach operation) before ever touching cancel_at_period_end. Releasing leaves
  // the subscription in place on its current (Premium) price/phase and simply
  // drops the pending downgrade -- cancellation is a later, stronger intent that
  // correctly supersedes an earlier scheduled downgrade.
  const stripeSub = await stripeRequest("GET", `/subscriptions/${subId}`, null, env);
  if (stripeSub.schedule) {
    await stripeRequest("POST", `/subscription_schedules/${stripeSub.schedule}/release`, null, env);
  }

  await stripeRequest("POST", `/subscriptions/${subId}`, { cancel_at_period_end: "true" }, env);
  await supabasePatch("profiles", { id: `eq.${userId}` }, { cancel_at_period_end: true }, env);
  await invalidateSubscription(userId, env);
  return { ok: true, data: { cancel_at_period_end: true } };
}

async function resumeSubscriptionForUser(userId, env) {
  if (!env.STRIPE_SECRET_KEY) return { ok: false, error: "stripe_not_configured", status: 503 };
  const rows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "stripe_subscription_id" }, env);
  const subId = rows?.[0]?.stripe_subscription_id;
  if (!subId) return { ok: false, error: "no_active_subscription", status: 400 };
  await stripeRequest("POST", `/subscriptions/${subId}`, { cancel_at_period_end: "false" }, env);
  await supabasePatch("profiles", { id: `eq.${userId}` }, { cancel_at_period_end: false }, env);
  await invalidateSubscription(userId, env);
  return { ok: true, data: { cancel_at_period_end: false } };
}

async function handleCancelSubscription(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  const result = await cancelSubscriptionForUser(auth.userId, env);
  if (!result.ok) return corsResponse(request, { error: result.error }, result.status);
  return corsResponse(request, { success: true, ...result.data });
}

async function handleResumeSubscription(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  const result = await resumeSubscriptionForUser(auth.userId, env);
  if (!result.ok) return corsResponse(request, { error: result.error }, result.status);
  return corsResponse(request, { success: true, ...result.data });
}

// Account Deletion (Phase 7, Part A). Two-step lifecycle: request sets a
// 30-day grace period and cancels billing immediately; the purge cron
// (runAccountDeletionPurge, below) does the actual data erasure once
// deletion_scheduled_purge_at arrives. Only "scheduled" data lives on
// profiles until then -- no other table is touched by this endpoint.
//
// Immediate cancellation (DELETE, not cancel_at_period_end) is used here
// deliberately, unlike handleCancelSubscription above: that endpoint is for
// a user who cancels but keeps using the app, so billing them through the
// period they already paid for is fair. Here the whole account -- including
// the subscription's own record -- is being erased within 30 days regardless,
// so continuing to bill (or leave a subscription active) through a period
// the account won't survive to finish makes no sense; stopping billing right
// away is the correct behavior for this specific flow.
// Extracted (Work Order 6 / high-risk admin operations) so the Back
// Office's admin-scheduled-deletion action reuses the exact same 30-day
// scheduling logic the customer's own self-service endpoint runs --
// including cancelling live billing first. Behavior unchanged from before
// the extraction. There is deliberately no equivalent "purge now" helper --
// immediate/permanent purge is never exposed to staff, only this same
// 30-day window, which Work Order 8's cancel-scheduled-deletion action can
// already reverse.
async function requestAccountDeletionForUser(userId, env) {
  const rows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "stripe_subscription_id,deletion_status" }, env);
  const profileRow = rows?.[0];
  if (!profileRow) return { ok: false, error: "profile_not_found", status: 404 };
  if (profileRow.deletion_status === "scheduled" || profileRow.deletion_status === "in_progress") {
    return { ok: false, error: "deletion_already_scheduled", status: 400 };
  }

  // Cancel billing first -- if this throws, the account is never marked for
  // deletion with an active subscription still running.
  if (profileRow.stripe_subscription_id && env.STRIPE_SECRET_KEY) {
    try {
      await stripeRequest("DELETE", `/subscriptions/${profileRow.stripe_subscription_id}`, null, env);
    } catch (e) {
      // Already-canceled/missing subscription on Stripe's side is not fatal --
      // the account should still be able to schedule deletion.
      if (e.stripeCode !== "resource_missing") {
        return { ok: false, error: "stripe_cancel_failed", status: 502 };
      }
    }
  }

  const now = new Date();
  const purgeAt = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  // account_deletion_log first: it's the durable record the purge scheduler
  // actually drives off (see runAccountDeletionPurgeSchedule below) and the
  // only thing that survives profiles being deleted mid-purge -- if this
  // insert fails, nothing has been marked locked yet, so the request simply
  // fails and the client can retry cleanly. profiles is patched second,
  // purely for the client-facing lock (App.jsx reads this via fetchProfile).
  await supabasePost("account_deletion_log", {
    user_id: userId,
    requested_at: now.toISOString(),
    scheduled_purge_at: purgeAt.toISOString(),
    status: "scheduled",
  }, env);
  await supabasePatch("profiles", { id: `eq.${userId}` }, {
    deletion_status: "scheduled",
    deletion_requested_at: now.toISOString(),
    deletion_scheduled_purge_at: purgeAt.toISOString(),
    subscription_status: "no_subscription",
    cancel_at_period_end: false,
  }, env);
  await invalidateSubscription(userId, env);

  return { ok: true, data: { deletion_scheduled_purge_at: purgeAt.toISOString() } };
}

async function handleRequestAccountDeletion(request, env) {
  const auth = await requireAuth(request, env, { allowDeletionLocked: true });
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  const result = await requestAccountDeletionForUser(auth.userId, env);
  if (!result.ok) return corsResponse(request, { error: result.error }, result.status);
  return corsResponse(request, { success: true, ...result.data });
}

// Extracted (Work Order 8) so the Back Office's admin cancel-deletion action
// can reuse the exact same eligibility check and writes, rather than a
// second copy of this logic. Behavior is unchanged from before the
// extraction -- same reads, same writes, same error codes.
async function cancelScheduledDeletion(userId, env) {
  const rows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "deletion_status" }, env);
  const status = rows?.[0]?.deletion_status;
  if (status !== "scheduled") {
    // Nothing to cancel (null), or the purge has already started ("in_progress"/
    // "completed") -- once the purge cron has picked it up, cancellation is no
    // longer safe to honor here.
    return { ok: false, error: status ? "deletion_already_in_progress" : "no_deletion_scheduled" };
  }

  await supabasePatch("profiles", { id: `eq.${userId}` }, {
    deletion_status: null,
    deletion_requested_at: null,
    deletion_scheduled_purge_at: null,
  }, env);
  // Remove the tracking row too -- "no residual deletion flags" applies to
  // account_deletion_log as much as to profiles. Nothing depends on this row
  // existing once the scheduled deletion itself no longer does.
  await supabaseDelete("account_deletion_log", { user_id: `eq.${userId}` }, env);

  return { ok: true };
}

async function handleCancelAccountDeletion(request, env) {
  const auth = await requireAuth(request, env, { allowDeletionLocked: true });
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);

  const result = await cancelScheduledDeletion(auth.userId, env);
  if (!result.ok) return corsResponse(request, { error: result.error }, 400);
  return corsResponse(request, { success: true });
}

// App-controlled plan changes (Pro <-> Premium) -- replaces reliance on
// Customer Portal's native "update subscription" feature, which only offers
// one portal-wide proration policy and can't express this app's asymmetric
// per-direction rules (immediate+prorated upgrade, deferred+unprorated
// downgrade). Portal plan-switching must be disabled in the Stripe Dashboard
// (one-time account configuration, not code) so this endpoint is the only
// path that changes a paid tier once a subscription exists.
//
// Ownership: identical pattern to handleCancelSubscription/
// handleResumeSubscription above -- stripe_subscription_id is always looked
// up from the authenticated user's own profiles row, never accepted from the
// client, so a user can never target another user's subscription by
// supplying a different customer/subscription ID.
//
// Tier authority: determineTierFromStripeSubscription() is consulted both
// before (to validate the requested transition) and after (to confirm what
// was actually granted) every change -- the client's requested `plan` only
// selects which Stripe operation to perform, it never itself grants
// entitlement.
// Extracted (Work Order 6 / high-risk admin operations), same reasoning as
// cancelSubscriptionForUser/resumeSubscriptionForUser above -- one
// implementation of the proration/schedule logic, shared by the customer's
// own endpoint and the admin-on-behalf-of-customer endpoint. Behavior
// unchanged from before the extraction.
async function changePlanForUser(userId, plan, env) {
  if (!env.STRIPE_SECRET_KEY) return { ok: false, error: "stripe_not_configured", status: 503 };
  if (plan !== "pro" && plan !== "premium") return { ok: false, error: "invalid_plan", status: 400 };

  const rows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "stripe_subscription_id" }, env);
  const subId = rows?.[0]?.stripe_subscription_id;
  if (!subId) return { ok: false, error: "no_active_subscription", status: 400 };

  const [stripeSub, config] = await Promise.all([
    stripeRequest("GET", `/subscriptions/${subId}`, null, env),
    getConfig(env),
  ]);
  // Only a currently-active Stripe subscription is eligible -- past_due,
  // canceled, or any other status resolves through the existing
  // grace-period/checkout paths, not this endpoint.
  if (stripeSub.status !== "active") return { ok: false, error: "subscription_not_active", status: 400 };
  const currentTier = determineTierFromStripeSubscription(stripeSub, config);
  if (currentTier === plan) return { ok: false, error: "already_on_plan", status: 400 };

  if (plan === "premium") {
    // Pro -> Premium: immediate upgrade. Stripe computes the exact prorated
    // amount from the actual time remaining in the billing period -- no
    // day-based math here, no assumed fixed amount. always_invoice charges
    // that proration right away rather than silently deferring it to the
    // next cycle, matching the locked "immediate upgrade" rule.
    const premiumPriceId = config.stripe_price_id_premium;
    if (!premiumPriceId) return { ok: false, error: "premium_price_not_configured", status: 503 };
    const itemId = stripeSub.items?.data?.[0]?.id;
    const updated = await stripeRequest("POST", `/subscriptions/${subId}`, {
      "items[0][id]": itemId,
      "items[0][price]": premiumPriceId,
      proration_behavior: "always_invoice",
    }, env);
    const newTier = determineTierFromStripeSubscription(updated, config);
    const newStatus = newTier === "premium" ? "premium_active" : "pro_active";
    const updatedPeriod = getSubscriptionPeriod(updated);
    await supabasePatch("profiles", { id: `eq.${userId}` }, {
      subscription_status: newStatus,
      current_period_start: new Date(updatedPeriod.start * 1000).toISOString(),
      current_period_end: new Date(updatedPeriod.end * 1000).toISOString(),
      cancel_at_period_end: updated.cancel_at_period_end,
    }, env);
    await invalidateSubscription(userId, env);
    return { ok: true, data: { subscription_status: newStatus } };
  }

  // Premium -> Pro: schedule the downgrade for the end of the current
  // billing period via a native Stripe Subscription Schedule -- no custom
  // day-based calculation, no cron job. Nothing changes in our own DB now;
  // the account keeps premium_active and Premium-tier quotas until the
  // scheduled phase actually transitions. When it does, Stripe applies the
  // new price to the subscription and fires customer.subscription.updated,
  // which re-derives and writes the new tier (see processStripeEvent) --
  // that's the single sync point, not this endpoint.
  const proPriceId = config.stripe_price_id_pro;
  if (!proPriceId) return { ok: false, error: "stripe_price_not_configured", status: 503 };
  const schedule = await stripeRequest("POST", "/subscription_schedules", { from_subscription: subId }, env);
  const currentPhase = schedule.phases?.[0];
  const currentPhaseItem = currentPhase?.items?.[0];
  const currentPhasePriceId = typeof currentPhaseItem?.price === "string" ? currentPhaseItem.price : currentPhaseItem?.price?.id;
  await stripeRequest("POST", `/subscription_schedules/${schedule.id}`, {
    "phases[0][items][0][price]": currentPhasePriceId,
    "phases[0][items][0][quantity]": String(currentPhaseItem?.quantity ?? 1),
    "phases[0][start_date]": String(currentPhase.start_date),
    "phases[0][end_date]": String(currentPhase.end_date),
    "phases[1][items][0][price]": proPriceId,
    "phases[1][items][0][quantity]": "1",
    "phases[1][proration_behavior]": "none",
  }, env);
  return {
    ok: true,
    data: {
      subscription_status: "premium_active",
      scheduled_downgrade_to: "pro",
      effective_at: new Date(currentPhase.end_date * 1000).toISOString(),
    },
  };
}

async function handleChangePlan(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  const { userId } = auth;

  let plan;
  try {
    const body = await request.json();
    plan = body?.plan;
  } catch (_) { /* falls through to changePlanForUser's own validation */ }

  const result = await changePlanForUser(userId, plan, env);
  if (!result.ok) return corsResponse(request, { error: result.error }, result.status);
  return corsResponse(request, { success: true, ...result.data });
}

async function handlePortalSession(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  if (!env.STRIPE_SECRET_KEY) return corsResponse(request, { error: "stripe_not_configured" }, 503);
  const { userId } = auth;
  const rows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "stripe_customer_id" }, env);
  const customerId = rows?.[0]?.stripe_customer_id;
  if (!customerId) return corsResponse(request, { error: "no_stripe_customer" }, 400);
  const session = await stripeRequest("POST", "/billing_portal/sessions", {
    customer: customerId,
    return_url: "https://careerpersonaai.com/#settings",
  }, env);
  return corsResponse(request, { url: session.url });
}

// Blueprint #3 extension: single billing state endpoint — Worker is the sole
// source of truth for billing data. Returns canonical state + quotas so the
// frontend never queries billing-related Supabase tables directly.
async function handleBillingState(request, env) {
  const auth = await requireAuth(request, env);
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);
  const { userId } = auth;
  // Always invalidate the per-user KV cache before reading so any DB change
  // (e.g. admin promotion, checkout completion) is visible immediately rather
  // than after the KV TTL expires.
  await invalidateSubscription(userId, env);
  const [sub, config] = await Promise.all([getSubscription(userId, env), getConfig(env)]);
  const caps = getCapabilities(sub, config);
  const periodKey = getPeriodKey(sub);
  const usage = await getUsage(userId, periodKey, env);
  const billingState = computeBillingState(sub);
  return corsResponse(request, {
    billingState,
    subscriptionStatus: sub.subscription_status ?? "no_subscription",
    planDisplayName: BILLING_STATE_PLAN[billingState] ?? "Free",
    canUseAI: caps.canUseAI,
    canUseJobs: caps.canUseJobs,
    periodEnd: sub.current_period_end ?? null,
    cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
    paymentMethodOnFile: !!sub.stripe_customer_id,
    quotas: computeQuotas(caps, usage),
  });
}

// ─── STRIPE WEBHOOK ───────────────────────────────────────────────────────────
// Blueprint #4: HMAC verify → idempotency dedup → process → invalidate KV.
// Returns 200 to Stripe in all cases (after dedup) to prevent re-delivery.

async function processStripeEvent(event, env) {
  const { type, data } = event;
  const obj = data.object;
  const customerId = obj.customer;
  if (!customerId) return;
  const rows = await supabaseGet("profiles", { stripe_customer_id: `eq.${customerId}`, select: "id" }, env);
  const userId = rows?.[0]?.id;
  if (userId) {
    supabasePost("stripe_events", {
      stripe_event_id: event.id,
      event_type: type,
      user_id: userId,
      amount_cents: obj.amount_paid ?? obj.amount ?? null,
      currency: obj.currency ?? null,
      payload: event,
    }, env).catch(() => {});
  }
  if (!userId) return;
  switch (type) {
    case "invoice.paid": {
      const sub = await stripeRequest("GET", `/subscriptions/${obj.subscription}`, null, env);
      const config = await getConfig(env);
      const tier = determineTierFromStripeSubscription(sub, config);
      const period = getSubscriptionPeriod(sub);
      await supabasePatch("profiles", { id: `eq.${userId}` }, {
        subscription_status: tier === "premium" ? "premium_active" : "pro_active",
        stripe_subscription_id: sub.id,
        current_period_start: new Date(period.start * 1000).toISOString(),
        current_period_end: new Date(period.end * 1000).toISOString(),
        cancel_at_period_end: sub.cancel_at_period_end,
        grace_period_ends_at: null,
      }, env);
      break;
    }
    case "invoice.payment_failed": {
      const config = await getConfig(env);
      const graceDays = parseInt(config.grace_period_days ?? "14");
      const graceEnds = new Date(Date.now() + graceDays * 86400 * 1000).toISOString();
      // Same tier-detection as invoice.paid -- a failed invoice still carries
      // a subscription reference, so the actual Price/Product on that
      // subscription (not the previously-stored status) decides which
      // past_due variant this account returns to at the end of its grace
      // period.
      const sub = await stripeRequest("GET", `/subscriptions/${obj.subscription}`, null, env);
      const tier = determineTierFromStripeSubscription(sub, config);
      await supabasePatch("profiles", { id: `eq.${userId}` }, {
        subscription_status: tier === "premium" ? "premium_past_due" : "pro_past_due",
        grace_period_ends_at: graceEnds,
      }, env);
      break;
    }
    case "customer.subscription.deleted": {
      // event.data.object for a subscription.* event IS the Subscription
      // itself -- items/price already embedded, no extra fetch needed.
      const config = await getConfig(env);
      const tier = determineTierFromStripeSubscription(obj, config);
      await supabasePatch("profiles", { id: `eq.${userId}` }, {
        subscription_status: tier === "premium" ? "premium_cancelled" : "pro_cancelled",
        stripe_subscription_id: null,
      }, env);
      supabasePatch("subscriptions", { stripe_subscription_id: `eq.${obj.id}` }, {
        status: "canceled",
        canceled_at: obj.canceled_at ? new Date(obj.canceled_at * 1000).toISOString() : new Date().toISOString(),
        ended_at: obj.ended_at ? new Date(obj.ended_at * 1000).toISOString() : new Date().toISOString(),
      }, env).catch(() => {});
      break;
    }
    case "customer.subscription.updated": {
      // `obj` (event.data.object) is a snapshot from the moment this specific
      // event was generated. Stripe explicitly does not guarantee webhook
      // delivery order (see "Event ordering" in Stripe's webhook docs) -- when
      // a single action performs multiple Stripe mutations in sequence (e.g.
      // handleCancelSubscription releasing a Subscription Schedule, then
      // setting cancel_at_period_end), each mutation fires its own
      // customer.subscription.updated event, and an older event's stale
      // snapshot can be processed after a newer one already landed, clobbering
      // correct state. Always re-fetch the CURRENT subscription instead of
      // trusting the embedded snapshot -- the same pattern invoice.paid and
      // invoice.payment_failed already use above -- so processing is
      // idempotent and immune to delivery order regardless of which event
      // triggered it.
      const currentSub = await stripeRequest("GET", `/subscriptions/${obj.id}`, null, env);
      const updatedPeriod = getSubscriptionPeriod(currentSub);
      const patch = {
        cancel_at_period_end: currentSub.cancel_at_period_end,
        current_period_start: new Date(updatedPeriod.start * 1000).toISOString(),
        current_period_end: new Date(updatedPeriod.end * 1000).toISOString(),
      };
      // Sync entitlement to whatever tier the subscription's actual price now
      // reflects -- covers both an immediate handleChangePlan upgrade's own
      // confirming webhook (already-correct, idempotent) and, critically, a
      // scheduled Premium->Pro downgrade's phase transition actually landing
      // (the only place that transition gets written -- handleChangePlan
      // itself never touches subscription_status for a scheduled downgrade).
      // Scoped to accounts currently pro_active/premium_active only: a
      // past_due or cancelled account's status is owned exclusively by
      // invoice.payment_failed / customer.subscription.deleted, so an
      // unrelated subscription.updated event (e.g. Stripe's own retry
      // bookkeeping) must never bounce it back to *_active on its own.
      const profileRows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "subscription_status" }, env);
      const currentStatus = profileRows?.[0]?.subscription_status;
      if (currentStatus === "pro_active" || currentStatus === "premium_active") {
        const config = await getConfig(env);
        const tier = determineTierFromStripeSubscription(currentSub, config);
        patch.subscription_status = tier === "premium" ? "premium_active" : "pro_active";
      }
      await supabasePatch("profiles", { id: `eq.${userId}` }, patch, env);
      supabasePatch("subscriptions", { stripe_subscription_id: `eq.${obj.id}` }, {
        cancel_at_period_end: currentSub.cancel_at_period_end,
        current_period_start: new Date(updatedPeriod.start * 1000).toISOString(),
        current_period_end: new Date(updatedPeriod.end * 1000).toISOString(),
        status: currentSub.status,
      }, env).catch(() => {});
      break;
    }
  }
  await invalidateSubscription(userId, env);
}

async function handleStripeWebhook(request, env) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    return new Response(JSON.stringify({ error: "webhook_not_configured" }), { status: 503 });
  }
  const rawBody = await request.text();
  const sigHeader = request.headers.get("stripe-signature") ?? "";
  try {
    await verifyStripeSignature(rawBody, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const event = JSON.parse(rawBody);
  // Idempotency: INSERT to webhook_dedup; 409 = already processed
  const dedupR = await fetch(`${env.SUPABASE_URL}/rest/v1/webhook_dedup`, {
    method: "POST",
    headers: sbHeaders(env),
    body: JSON.stringify({ stripe_event_id: event.id }),
  });
  if (dedupR.status === 409) {
    return new Response(JSON.stringify({ received: true, duplicate: true }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }
  try {
    await processStripeEvent(event, env);
  } catch (e) {
    console.error("webhook_processing_error", event.type, e.message);
  }
  return new Response(JSON.stringify({ received: true }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PROACTIVE JOB ALERTS — SCHEDULED PIPELINE
// Locked blueprint: https://claude.ai/code/artifact/779890b3-2265-42d7-b86f-94e78d2d56db
//
// Four strict responsibility boundaries for this section:
//  - Scheduler (runProactiveJobAlertsSchedule + the per-cadence run* functions'
//    top-level loop): timing, triggering, per-user orchestration only. Never
//    computes a tier, score, or narrative itself.
//  - Discovery Engine (imported above from src/lib/proactiveJobAlerts/ --
//    the SAME pure functions the frontend will use in Phase 5/6, not
//    reimplemented): candidate generation, deterministic discovery.
//  - AI Layer (imported prompt-builders/parsers above + callClaudeServerSide
//    below, which mirrors handleClaude's exact Anthropic-call mechanics):
//    interpretation, guidance, narrative generation only. Never decides a
//    tier or which candidates are delivered.
//  - Delivery Pipeline (the persist*/fetchUserAlertContext functions below):
//    persistence, notification preparation (i.e. writing alert rows the
//    Phase 5 UI will read as a digest -- this app has no push/email channel
//    to reuse or build here), and lifecycle_status/tier-change tracking.
//
// Cron schedule (see wrangler.toml):
//   "0 */6 * * *"  -> Analysis 01, Critical Opportunity Engine (every 6h)
//   "0 */12 * * *" -> Analysis 04, Watchlist Activity Monitor (every 12h)
//   "0 6 * * 1"    -> Analyses 02+03+05+06, weekly (Monday 06:00 UTC)
//
// Known v1 limitations (flagged, not silently hidden):
//  - No source supplies a real posting close date, so "closing_soon" urgency
//    factors will not fire against live data until a source with deadline
//    data is added -- pre-existing gap in the job APIs, not introduced here.
//  - Market Intelligence's volume trend is derived from this platform's own
//    alert_candidates history, which is empty at launch and thin for the
//    first several weeks ("cold start") -- computeVolumeTrend already
//    returns trend:null gracefully until enough history exists.
// ═══════════════════════════════════════════════════════════════════════════

const CLAUDE_MODEL = "claude-sonnet-4-6";
const PROACTIVE_ALERTS_TIME_BUDGET_MS = 20_000; // leaves headroom under Workers' CPU limit; remaining users roll to the next scheduled run
const PROACTIVE_ALERTS_SEARCH_RESULTS_PAGE = 1;

// AI Layer's execution primitive -- mirrors handleClaude's exact Anthropic
// call (same model, same message shape), minus the request-specific
// auth/quota wrapper (the scheduler checks quota itself, per-user, before
// calling this -- see checkAndConsumeAIQuota).
async function callClaudeServerSide(prompt, maxTokens, env) {
  const startedAt = Date.now();
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: Math.min(maxTokens, 8000), messages: [{ role: "user", content: prompt }] }),
  });
  const latencyMs = Date.now() - startedAt;
  const d = await r.json();
  if (!r.ok) {
    console.error("[proactiveAlerts] Claude error", r.status, JSON.stringify(d));
    return { text: null, usage: null, latencyMs, ok: false, errorCode: String(r.status) };
  }
  const text = (d.content?.[0]?.text || "").replace(/```json|```/g, "").trim();
  return { text, usage: d.usage, latencyMs, ok: true, errorCode: null };
}

// Delivery Pipeline needs upsert semantics (alert_candidates is re-evaluated
// across cadences via unique(user_id, job_id)) -- supabasePost alone is
// insert-only. Mirrors the REST-level shape of the upsert the frontend's
// Supabase client already performs elsewhere (e.g. company_watchlist), just
// expressed as a raw fetch call since worker.js talks to PostgREST directly.
async function supabaseUpsert(table, data, onConflict, env) {
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/${table}`);
  url.searchParams.set("on_conflict", onConflict);
  const r = await fetch(url.toString(), {
    method: "POST",
    headers: { ...sbHeaders(env), "Prefer": "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(data),
  });
  const body = await r.text();
  if (!r.ok) throw Object.assign(new Error(`supabase_upsert_${r.status}`), { status: r.status, body });
  return JSON.parse(body);
}

// ── Scheduler: eligible users ────────────────────────────────────────────────
// Proactive Job Alerts is Premium Feature #4 -- same premium-only gate
// already established for Referral Intelligence (isPremium = premium_active
// or admin), not the broader "canUseAI" set that also includes pro.
async function getPremiumUserIds(env) {
  const rows = await supabaseGet("profiles", { select: "id", subscription_status: "in.(premium_active,admin)" }, env);
  return rows.map(r => r.id);
}

// Reuses the exact Layer 1 + Layer 2 entitlement/quota chain handleClaude
// already uses for interactive requests, applied per-user in the background
// loop instead of per-HTTP-request. Deterministic discovery work always
// proceeds regardless (it costs no AI budget); only the AI narrative call is
// gated here.
async function checkAndConsumeAIQuota(userId, feature, env) {
  const [sub, config] = await Promise.all([getSubscription(userId, env), getConfig(env)]);
  const caps = getCapabilities(sub, config);
  if (!caps.canUseAI) return false;
  const limit = getFeatureLimit(feature, caps);
  if (limit === Infinity) return true;
  const period = getPeriodKey(sub);
  const quota = await supabaseRPC("check_and_consume_quota", { p_user_id: userId, p_feature: feature, p_limit: limit, p_period: period }, env);
  return !!quota.allowed;
}

// ── Delivery Pipeline: per-user context ──────────────────────────────────────
async function fetchUserAlertContext(userId, env) {
  const [profileRows, detailRows, contacts, watchlist, savedJobRows, outcomePatterns, existingCandidates, recentAlerts, applicationRows] = await Promise.all([
    supabaseGet("profiles", { select: "*", id: `eq.${userId}` }, env),
    supabaseGet("profile_details", { select: "*", user_id: `eq.${userId}` }, env),
    supabaseGet("networking_contacts", { select: "*", user_id: `eq.${userId}` }, env),
    supabaseGet("company_watchlist", { select: "*", user_id: `eq.${userId}` }, env),
    supabaseGet("saved_jobs", { select: "*", user_id: `eq.${userId}` }, env),
    supabaseGet("outcome_patterns", { select: "*", user_id: `eq.${userId}` }, env),
    supabaseGet("alert_candidates", { select: "*", user_id: `eq.${userId}` }, env),
    supabaseGet("alerts", { select: "*", user_id: `eq.${userId}`, order: "delivered_at.desc", limit: "200" }, env),
    // Cross-Feature Integration (Phase 6): Application Outcome Intelligence
    // owns this data (applications table + its own patternEngine.js) --
    // Proactive Job Alerts only READS it, via marketSignals.js's
    // computeApplicationWindowStats/computePersonalOutcomeTiming (Analysis
    // 06, Timing Intelligence). Never recomputes an outcome pattern itself.
    supabaseGet("applications", { select: "response_status,days_since_posted", user_id: `eq.${userId}` }, env),
  ]);
  const base = profileRows[0] || {};
  const details = detailRows[0] || {};
  return {
    profile: {
      preferred_job_title: details.preferred_job_title || base.job_title || "",
      location: base.location || "",
      work_type: details.work_type || "",
      desired_salary: details.desired_salary || "",
    },
    contacts, watchlist,
    // Only saved_jobs.job_id maps to an external posting ID -- applications
    // are logged as free-text company/title with no comparable ID, so they
    // are not a valid input to filterAlreadyApplied's exact-ID matching.
    appliedJobIds: savedJobRows.map(j => j.job_id).filter(Boolean),
    outcomePatterns, existingCandidates, recentAlerts,
    applications: applicationRows.map(a => ({ status: a.status, daysSincePosted: a.days_since_posted })),
  };
}

// fetchFreshPostings relocated (2026-08-06) to the shared
// src/lib/platform/jobDiscoveryService.js -- imported above. Proactive Job
// Alerts keeps its own named PROACTIVE_ALERTS_SEARCH_RESULTS_PAGE constant
// for readability and passes it explicitly below, rather than relying on the
// now-generic function's default parameter value.

// Persists Discovery Engine's evaluated output. Tracks tier CHANGES
// (previous_tier/tier_change_reason) as plain persistence-layer bookkeeping
// -- comparing an old field to a new field on write, not a business
// decision -- powering §18's "Explain Why Priority Changed" in a later phase.
async function persistAlertCandidates(userId, evaluatedResults, env) {
  // Each item already carries its own matching `existing` row (looked up by
  // the caller -- see runCriticalOpportunityCadence's existingByJobId map).
  const rows = evaluatedResults.map(({ result, existing }) => {
    const tierChanged = existing && existing.alert_tier !== result.tier;
    return {
      user_id: userId,
      job_id: result.job.id,
      job_title: result.job.title,
      company: result.job.company,
      source: result.job.source || "unknown",
      match_score: result.matchScore,
      alert_tier: result.tier,
      confidence_tier: result.confidenceTier,
      lifecycle_status: existing?.lifecycle_status && existing.lifecycle_status !== "discovered" ? existing.lifecycle_status : "evaluated",
      discard_reason: result.tier === "discarded" ? result.tierReason : null,
      urgency_factors: result.urgencyFactors,
      signal_enrichments: { hasNetworkContact: result.signals.hasNetworkContact, isWatchlisted: result.signals.isWatchlisted, isDreamCompany: result.signals.isDreamCompany, outcomePatternPositive: result.signals.outcomePatternPositive },
      previous_tier: tierChanged ? existing.alert_tier : (existing?.previous_tier ?? null),
      tier_change_reason: tierChanged ? `Re-evaluated: ${existing.alert_tier} -> ${result.tier} (${result.tierReason})` : (existing?.tier_change_reason ?? null),
      estimated_close_date: result.job.estimatedCloseDate || null,
      posted_at: result.job.datePosted || null,
    };
  });
  if (!rows.length) return [];
  return supabaseUpsert("alert_candidates", rows, "user_id,job_id", env);
}

// explanationsByJobId (optional) carries the AI Layer's own narrative,
// keyed by the candidate's job.id -- stored verbatim, exactly as the AI Layer
// produced it (aiPrompts.js), never edited, summarized, or regenerated here.
// The Delivery Pipeline's only job is writing it down against the right row.
async function markAlertsDelivered(userId, deliverCandidates, persistedRows, digestType, env, explanationsByJobId = new Map()) {
  if (!deliverCandidates.length) return;
  const byJobId = new Map(persistedRows.map(r => [r.job_id, r]));
  const alertRows = deliverCandidates
    .map(c => ({ row: byJobId.get(c.job.id), jobId: c.job.id }))
    .filter(x => x.row)
    .map(({ row, jobId }) => ({ user_id: userId, candidate_id: row.id, digest_type: digestType, explanation: explanationsByJobId.get(jobId) || null }));
  if (alertRows.length) await supabasePost("alerts", alertRows, env);
  const alertedIds = deliverCandidates.map(c => byJobId.get(c.job.id)?.id).filter(Boolean);
  if (alertedIds.length) {
    await Promise.all(alertedIds.map(id => supabasePatch("alert_candidates", { id: `eq.${id}` }, { lifecycle_status: "alerted" }, env)));
  }
}

// ── Cadence 1: Critical Opportunity Engine (every 6h) ────────────────────────
async function runCriticalOpportunityCadence(userId, env) {
  const ctxData = await fetchUserAlertContext(userId, env);
  const rawPostings = await fetchFreshPostings(ctxData.profile, env, PROACTIVE_ALERTS_SEARCH_RESULTS_PAGE);
  const deduped = deduplicateOpportunities(rawPostings);
  const unapplied = filterAlreadyApplied(deduped, ctxData.appliedJobIds);

  const existingByJobId = new Map(ctxData.existingCandidates.map(c => [c.job_id, c]));
  const evaluated = unapplied.map(job => ({
    result: evaluateOpportunity({ job, profile: ctxData.profile, contacts: ctxData.contacts, watchlist: ctxData.watchlist, outcomePatterns: ctxData.outcomePatterns }),
    existing: existingByJobId.get(job.id) || null,
  }));

  const persisted = await persistAlertCandidates(userId, evaluated, env);

  const alreadyToday = ctxData.recentAlerts.filter(a => a.delivered_at && (Date.now() - new Date(a.delivered_at).getTime()) < 86400000);
  const tieredForCaps = evaluated.map(e => e.result);
  const capResult = enforceDeliveryCaps(tieredForCaps, {
    alreadyDeliveredToday: {
      critical: alreadyToday.filter(a => persisted.find(p => p.id === a.candidate_id)?.alert_tier === "critical").length,
      high: alreadyToday.filter(a => persisted.find(p => p.id === a.candidate_id)?.alert_tier === "high").length,
    },
  });

  if (!capResult.deliver.length) return { userId, delivered: 0, aiCalled: false };

  const allowed = await checkAndConsumeAIQuota(userId, "proactive_job_alerts", env);
  const explanationsByJobId = new Map();
  if (allowed) {
    const built = buildCriticalOpportunityPrompt(capResult.deliver);
    if (built) {
      const { text, usage, latencyMs, ok, errorCode } = await callClaudeServerSide(built.prompt, 900, env);
      // Logged unconditionally now (AI Usage & Cost work order) -- a failed
      // call still needs to show up in the Back Office's error-rate figures,
      // not just successes.
      await logAIRequest(userId, "proactive_job_alerts", getPeriodKey(await getSubscription(userId, env)), usage?.input_tokens, usage?.output_tokens, env, { success: ok, errorCode, latencyMs, model: CLAUDE_MODEL });
      if (text) {
        const parsed = parseCriticalOpportunityResponse(text, capResult.deliver);
        if (parsed) {
          for (const p of parsed) {
            // Deterministic facts (urgencyFactors/matchScore/confidenceTier/tier)
            // are stored alongside the AI's own text so the UI can render them
            // side by side -- the evidence pairing, not just the narrative alone.
            explanationsByJobId.set(p.candidate.job.id, {
              whyUrgent: p.whyUrgent,
              displayRank: p.displayRank,
              basedOn: { tier: p.candidate.tier, tierReason: p.candidate.tierReason, urgencyFactors: p.candidate.urgencyFactors, matchScore: p.candidate.matchScore, confidenceTier: p.candidate.confidenceTier },
            });
          }
        }
      }
    }
  }

  await markAlertsDelivered(userId, capResult.deliver, persisted, "daily_critical", env, explanationsByJobId);
  return { userId, delivered: capResult.deliver.length, aiCalled: allowed };
}

// ── Cadence 2: Watchlist Activity Monitor (every 12h) ────────────────────────
// Deliberately reads already-persisted alert_candidates (populated by the 6h
// Critical cadence) rather than re-fetching from Adzuna/RapidAPI a second
// time -- avoids a redundant third ingestion pipeline for the same job
// sources; this cadence's job is monitoring + narrative, not discovery.
async function runWatchlistActivityCadence(userId, env) {
  const ctxData = await fetchUserAlertContext(userId, env);
  if (!ctxData.watchlist.length) return { userId, ranAnalysis: false };

  const byCompany = groupCandidatesByCompany(ctxData.existingCandidates);
  const states = computeWatchlistActivityStates({ watchlist: ctxData.watchlist, alertCandidatesByCompany: byCompany });

  const allowed = await checkAndConsumeAIQuota(userId, "proactive_job_alerts", env);
  if (!allowed) return { userId, ranAnalysis: false, reason: "quota_exhausted" };

  const built = buildWatchlistActivityPrompt(states);
  if (!built) return { userId, ranAnalysis: false, reason: "nothing_active" };

  const { text, usage, latencyMs, ok, errorCode } = await callClaudeServerSide(built.prompt, 500, env);
  const summary = text ? parseWatchlistActivityResponse(text) : null;
  await logAIRequest(userId, "proactive_job_alerts", getPeriodKey(await getSubscription(userId, env)), usage?.input_tokens, usage?.output_tokens, env, { success: ok, errorCode, latencyMs, model: CLAUDE_MODEL });
  if (summary) {
    // The exact deterministic states given to the AI travel with its output --
    // the UI renders them side by side, so "which companies/signals produced
    // this text" is never left to trust the narrative alone.
    await supabasePost("market_signals", [{ user_id: userId, signal_type: "watchlist_summary", scope: "user_specific", value: { ...summary, basedOn: states.filter(s => s.signal !== "quiet") } }], env);
  }
  return { userId, ranAnalysis: !!summary };
}

// ── Cadence 3: Weekly (Analyses 02 + 03 + 05 + 06) ───────────────────────────
async function runWeeklyCadence(userId, env) {
  const ctxData = await fetchUserAlertContext(userId, env);
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const fourWeeksAgo = new Date(now.getTime() - 28 * 86400000);

  const curatedCandidates = ctxData.existingCandidates
    .filter(c => c.alert_tier === "curated" && c.lifecycle_status !== "alerted")
    .map(c => ({ job: { id: c.job_id, title: c.job_title, company: c.company }, tier: c.alert_tier, matchScore: c.match_score, industry: null, isStretch: false }));
  const balanceResult = applyBalanceConstraint(curatedCandidates);
  const diversityResult = applyDiversityConstraint(balanceResult.candidates.map(c => ({ ...c, tier: "curated" })));

  // Cold-start-aware: volume trend is derived from this platform's own
  // ingestion history (posted_at timestamps already recorded in
  // alert_candidates), which is thin for the first several weeks after
  // launch -- computeVolumeTrend degrades to trend:null gracefully, it is
  // never fabricated from too little history.
  const thisWeekCount = ctxData.existingCandidates.filter(c => c.posted_at && new Date(c.posted_at) >= weekAgo).length;
  const priorPeriodCandidates = ctxData.existingCandidates.filter(c => c.posted_at && new Date(c.posted_at) >= fourWeeksAgo && new Date(c.posted_at) < weekAgo);
  const priorPeriodAvg = priorPeriodCandidates.length / 3;
  const volumeTrend = computeVolumeTrend({ currentPeriodCount: thisWeekCount, priorPeriodAvg: priorPeriodCandidates.length ? priorPeriodAvg : null });
  const hiringFreeze = detectHiringFreeze({ overall: volumeTrend });
  const salarySignal = computeSalarySignal({ currentAvgSalary: null, priorAvgSalary: null });
  const speedOfFill = computeSpeedOfFill([]);

  const trustScore = computeAlertTrustScore(ctxData.recentAlerts, { now });
  const missedOpportunities = findMissedOpportunities(ctxData.existingCandidates, ctxData.recentAlerts)
    .map(c => ({ job_title: c.job_title, company: c.company }));
  const engagementTrends = computeOpportunityEngagementTrends(ctxData.existingCandidates.map(c => ({ industry: null, companySizeEstimate: null, tier: c.alert_tier, lifecycle_status: c.lifecycle_status })));
  const discoveryCoverage = computeDiscoveryCoverage(ctxData.existingCandidates.map(c => ({ lifecycle_status: c.lifecycle_status, alert_tier: c.alert_tier })));

  // Application Outcome Intelligence owns `applications` and the concept of
  // a "positive outcome" (patternEngine.js's own isPositiveOutcome/
  // hasResponse) -- Timing Intelligence reuses that same eligibility
  // definition inside marketSignals.js's computeApplicationWindowStats,
  // never redefining what counts as a response independently.
  const applicationWindowStats = computeApplicationWindowStats(ctxData.applications);
  const personalOutcomeTiming = computePersonalOutcomeTiming(ctxData.applications);
  const seasonalPattern = computeSeasonalPattern({});

  const allowed = await checkAndConsumeAIQuota(userId, "proactive_job_alerts", env);
  if (!allowed) return { userId, ranAnalysis: false, reason: "quota_exhausted" };

  const built = buildWeeklyAnalysesPrompt({
    curatedCandidates: diversityResult.included, balanceResult, volumeTrend, salarySignal, hiringFreeze, speedOfFill,
    trustScore, missedOpportunities, engagementTrends, discoveryCoverage,
    applicationWindowStats, personalOutcomeTiming, seasonalPattern,
    availability: computeWeeklyAvailability({ curatedCandidates: diversityResult.included, volumeTrend, discoveryCoverage, personalOutcomeTiming }),
  });
  if (!built) return { userId, ranAnalysis: false, reason: "nothing_available" };

  const { text, usage, latencyMs, ok, errorCode } = await callClaudeServerSide(built.prompt, 2200, env);
  const analyses = text ? parseWeeklyAnalysesResponse(text, built) : null;
  await logAIRequest(userId, "proactive_job_alerts", getPeriodKey(await getSubscription(userId, env)), usage?.input_tokens, usage?.output_tokens, env, { success: ok, errorCode, latencyMs, model: CLAUDE_MODEL });
  if (analyses) {
    // Same evidence-pairing discipline as the other two cadences: each
    // section's own deterministic input travels alongside its AI text, keyed
    // to match the section it explains, so the UI never has to trust an AI
    // finding without its cited facts alongside it.
    const basedOn = {
      marketIntelligence: analyses.marketIntelligence ? { volumeTrend, salarySignal, hiringFreeze, speedOfFill } : undefined,
      alertEffectiveness: analyses.alertEffectiveness ? { trustScore, discoveryCoverage, missedOpportunities, engagementTrends } : undefined,
      timingIntelligence: analyses.timingIntelligence ? { applicationWindowStats, personalOutcomeTiming, seasonalPattern } : undefined,
    };
    await supabasePost("market_signals", [{ user_id: userId, signal_type: "weekly_analysis", scope: "user_specific", value: { ...analyses, basedOn } }], env);
  }
  // Curated pipeline candidates already exist as alert_candidates rows (from
  // an earlier Critical-cadence run) -- only their alerts row + lifecycle
  // transition needs writing here, using the AI's own narrated subset as the
  // source of truth for what was actually delivered (never the full
  // pre-narrative set, in case parsing returned a partial result).
  if (analyses?.curatedPipeline?.length) {
    const deliverCandidates = analyses.curatedPipeline.map(p => p.candidate);
    const explanationsByJobId = new Map(
      analyses.curatedPipeline.map(p => [p.candidate.job.id, { whyThisWeek: p.whyThisWeek, basedOn: { tier: p.candidate.tier, matchScore: p.candidate.matchScore, isStretch: p.candidate.isStretch, industry: p.candidate.industry } }])
    );
    await markAlertsDelivered(userId, deliverCandidates, ctxData.existingCandidates, "weekly_curated", env, explanationsByJobId);
  }
  if (trustScore.needsSelfCorrection) {
    await supabaseUpsert("alert_learning_weights", [{ user_id: userId, weight_type: "confidence_floor", category: "global", weight_value: 1, data_points: trustScore.totalAlerts }], "user_id,weight_type,category", env);
  }
  return { userId, ranAnalysis: !!analyses };
}

// ── Scheduler: dispatch + time-budget-guarded user loop ─────────────────────
// The only thing this function decides is timing/ordering across users --
// zero business logic. A user is skipped only for eligibility (premium) or
// wall-clock budget, never for a Discovery Engine or AI Layer reason (those
// decisions happen inside the cadence functions above, called unchanged).
async function runProactiveJobAlertsSchedule(cronExpr, env) {
  const startedAt = Date.now();
  const userIds = await getPremiumUserIds(env);
  const runner =
    cronExpr === "0 */6 * * *" ? runCriticalOpportunityCadence :
    cronExpr === "0 */12 * * *" ? runWatchlistActivityCadence :
    cronExpr === "0 6 * * 1" ? runWeeklyCadence : null;
  if (!runner) {
    console.error("[proactiveAlerts] Unrecognized cron expression", cronExpr);
    return;
  }
  let processed = 0;
  for (const userId of userIds) {
    if (Date.now() - startedAt > PROACTIVE_ALERTS_TIME_BUDGET_MS) {
      console.log(`[proactiveAlerts] Time budget reached after ${processed}/${userIds.length} users; remainder rolls to the next scheduled run.`);
      break;
    }
    try {
      await runner(userId, env);
      processed++;
    } catch (e) {
      console.error("[proactiveAlerts] user_processing_error", cronExpr, userId, e.message);
    }
  }
  console.log(`[proactiveAlerts] Cadence "${cronExpr}" processed ${processed}/${userIds.length} eligible users.`);
}

// ═══════════════════════════════════════════════════════════════════════════
// SMART APPLY AUTO PREP -- Premium Feature #5. Cron schedule (see
// wrangler.toml): "0 13 * * *" (once daily).
//
// Per the locked blueprint's §2 Ownership table, this section owns exactly
// one thing: automatic selection, budget enforcement, and queue placement.
// Everything else is reused, unmodified, from an existing single-owner
// module:
//   - Job discovery            -> src/lib/platform/jobDiscoveryService.js
//     (fetchFreshPostings, already imported above)
//   - Qualification/scoring    -> Career Compatibility Engine
//     (buildCompatibilityRecord, already imported above)
//   - Ranking/qualification    -> src/lib/smartApplyAutoPrep/selection.js
//     (isJobQualifiedForAutoPrep is applied internally by selectJobsForAutoPrep)
//   - Package generation/validation -> src/lib/smartApply/generation.js,
//     the exact same functions manual Smart Apply calls (App.jsx)
//   - Claude execution         -> callClaudeServerSide, already defined above
//     for Proactive Job Alerts' AI Layer -- reused as-is, its second caller
// ═══════════════════════════════════════════════════════════════════════════

const SMART_APPLY_AUTO_PREP_RESULTS_PAGE = 1;
const SMART_APPLY_AUTO_PREP_MONTHLY_CAP = 20; // §6: fixed, never scaled by the daily setting
const SMART_APPLY_AUTO_PREP_FEATURE_KEY = "smart_apply_auto_prep";
const SMART_APPLY_AUTO_PREP_TIME_BUDGET_MS = 20_000; // same headroom rationale as PROACTIVE_ALERTS_TIME_BUDGET_MS

// Mirrors src/data/profile.js's fetchProfile merge exactly (same field
// names, same base/details precedence, only the subset buildSmartApplyPrompt/
// buildCompatibilityRecord/validateSmartApplyPackage actually read). Not a
// shared import -- that module uses the browser's RLS-scoped Supabase client,
// which has no server-cron equivalent; this reimplements the same flat shape
// service-role, same discipline as the persistence functions below.
async function fetchProfileForAutoPrep(userId, env) {
  const [baseRows, detailRows] = await Promise.all([
    supabaseGet("profiles", { select: "*", id: `eq.${userId}` }, env),
    supabaseGet("profile_details", { select: "*", user_id: `eq.${userId}` }, env),
  ]);
  const base = baseRows[0] || {};
  const details = detailRows[0] || {};
  return {
    full_name: base.full_name || "",
    email_address: details.email_address || "",
    phone: base.phone || "",
    country: base.country || "",
    location: base.location || "",
    preferred_job_title: details.preferred_job_title || base.job_title || "",
    work_type: details.work_type || "",
    desired_salary: details.desired_salary || "",
  };
}

// Locked decision: skip users with no explicit default resume set -- no
// most-recently-analyzed fallback. Automatic preparation only ever acts on a
// resume the user explicitly chose, since there is no browser-side
// activeResumeId for a server cron to read (that value is pure client React
// state, never persisted -- confirmed by reading App.jsx directly).
async function fetchDefaultResumeForUser(userId, env) {
  const rows = await supabaseGet("user_resumes", { select: "id,content", user_id: `eq.${userId}`, is_default: "eq.true", limit: "1" }, env);
  return rows[0] || null;
}

// Mirrors src/data/skillSynonyms.js's loadSkillSynonyms shape exactly (same
// { alias: canonical } object) -- service-role instead of RLS, fetched once
// per cadence run (not per user), since it's small, read-only reference data.
async function fetchSkillDictionary(env) {
  const rows = await supabaseGet("skill_synonyms", { select: "alias,canonical" }, env);
  return Object.fromEntries((rows || []).map(r => [r.alias, r.canonical]));
}

// Atomic dual-cap budget check: daily leg (the user's stored Daily
// Preparation Setting) and monthly leg (§6's fixed 20). Each leg is its own
// independent check_and_consume_quota counter (keyed by user_id+feature+
// period -- see that RPC's own definition), combined by aiBudget.js's pure
// combineBudgetResults.
//
// Known, accepted limitation: the two legs are not one atomic transaction.
// If one leg allows but the other then denies, the allowed leg's counter is
// still incremented for a job that won't be prepared. Only possible on the
// exact day/month a user sits at the boundary of one cap while exhausting
// the other -- self-corrects at the next period rollover, not a correctness
// problem for the fixed, small caps this feature uses (§6). Not worth a
// two-phase commit for a 1-2/day cap.
async function checkAndConsumeAutomationBudget({ userId, featureKey, dailyCap, monthlyCap, env }) {
  const [dailyResult, monthlyResult] = await Promise.all([
    supabaseRPC("check_and_consume_quota", { p_user_id: userId, p_feature: `${featureKey}_daily`, p_limit: dailyCap, p_period: getDailyPeriodKey() }, env),
    supabaseRPC("check_and_consume_quota", { p_user_id: userId, p_feature: `${featureKey}_monthly`, p_limit: monthlyCap, p_period: getMonthlyPeriodKey() }, env),
  ]);
  return combineBudgetResults(dailyResult, monthlyResult);
}

// Persistence -- mirrors src/data/smartApply.js's enqueue/markReady/
// markNeedsReview/markFailed status semantics exactly (same non-terminal-row
// dedup rule in enqueueAutoPrepRow, same status vocabulary), necessarily
// reimplemented service-role since that module is a React hook bound to a
// browser session and a client-local orphan-recovery Set with no server-cron
// equivalent (a cron invocation either finishes a row or marks it failed in
// the same pass -- there is no "orphaned by a closed tab" case to recover
// from).
async function enqueueAutoPrepRow(userId, job, resumeId, env) {
  const rows = await supabaseGet("smart_apply_queue", { select: "*", user_id: `eq.${userId}`, job_id: `eq.${job.id}`, order: "created_at.desc" }, env);
  const existing = (rows || []).find(r => !["applied", "skipped"].includes(r.status));
  if (existing) return null; // §8: existing dedup rule, unchanged -- any non-terminal row skips automatic preparation for this job
  try {
    const inserted = await supabasePost("smart_apply_queue", {
      user_id: userId, job_id: job.id, job_title: job.title, company: job.company,
      job_description: (job.description || "").slice(0, 1200), resume_id: resumeId || null,
      status: "queued", generation_source: "automatic",
    }, env);
    return inserted[0];
  } catch (e) {
    // smart_apply_queue_active_job_uidx (2026-08-06) makes the dedup rule a DB-level
    // invariant -- closes the read-then-write race this SELECT-then-INSERT pair would
    // otherwise have under a redelivered/duplicate cron invocation. A 409 here means a
    // concurrent caller (this same race, or a manual Smart Apply click) won it first --
    // treat exactly like the existing-row case above, not a real failure.
    if (e.status === 409) return null;
    throw e;
  }
}

async function markAutoPrepResult(id, aiResult, ok, env) {
  await supabasePatch("smart_apply_queue", { id: `eq.${id}` }, {
    tailored_resume: aiResult.tailoredResume || null,
    cover_letter: aiResult.coverLetter || null,
    recruiter_message: aiResult.recruiterMessage || null,
    networking_message: aiResult.networkingMessage || null,
    missing_skills: aiResult.missingSkills || null,
    interview_probability: aiResult.interviewProbability ?? null,
    hiring_probability: aiResult.hiringProbability ?? null,
    application_questions: aiResult.applicationQuestions || null,
    salary_insight: aiResult.salaryInsight || null,
    company_insight: aiResult.companyInsight || null,
    status: ok ? "ready" : "needs_review",
  }, env);
}

// §9: technical generation failure -> "Ready for Manual Preparation",
// generalizing the existing markFailed path manual generation already uses
// -- same "failed" status, no second failure vocabulary. retry_count starts
// at 1 unconditionally since this row was created moments earlier in this
// same cadence run (never a pre-existing row with prior failures).
async function markAutoPrepFailed(id, env) {
  await supabasePatch("smart_apply_queue", { id: `eq.${id}` }, { status: "failed", retry_count: 1 }, env);
}

// ── Per-user orchestration ───────────────────────────────────────────────
async function runSmartApplyAutoPrepForUser(userId, skillDictionary, env) {
  const preferenceRows = await supabaseGet("automation_preferences", { select: "value", user_id: `eq.${userId}`, feature_key: `eq.${SMART_APPLY_AUTO_PREP_FEATURE_KEY}` }, env);
  const dailyCap = preferenceRows[0]?.value || 0;
  if (dailyCap <= 0) return { userId, prepared: 0, reason: "automation_off" };

  const resume = await fetchDefaultResumeForUser(userId, env);
  if (!resume?.content?.trim()) return { userId, prepared: 0, reason: "no_default_resume" };

  const profile = await fetchProfileForAutoPrep(userId, env);
  if (!profile.preferred_job_title) return { userId, prepared: 0, reason: "no_preferred_job_title" };

  const rawPostings = await fetchFreshPostings(profile, env, SMART_APPLY_AUTO_PREP_RESULTS_PAGE);
  const postings = deduplicate(rawPostings);
  const resumeSkills = extractSkillKeywords(resume.content);

  const entries = postings.map(job => ({ job, compatibility: buildCompatibilityRecord({ job, profile, resumeSkills, skillDictionary }) }));
  // §4: an unbounded budget here on purpose -- this only establishes
  // qualification + rank order. The real budget gate is enforced per-job
  // below via checkAndConsumeAutomationBudget, atomically, immediately
  // before each preparation.
  const ranked = selectJobsForAutoPrep(entries, entries.length);

  let prepared = 0;
  for (const entry of ranked) {
    const budget = await checkAndConsumeAutomationBudget({
      userId, featureKey: SMART_APPLY_AUTO_PREP_FEATURE_KEY, dailyCap, monthlyCap: SMART_APPLY_AUTO_PREP_MONTHLY_CAP, env,
    });
    if (!budget.allowed) break; // §9: Cost Boundary reached -- remaining qualifying jobs stay untouched, available for manual Smart Apply

    const queued = await enqueueAutoPrepRow(userId, entry.job, resume.id, env);
    if (!queued) continue; // §8: already has a non-terminal row -- skip without spending generation

    try {
      // No browser UserContext session exists to build a ctx block from --
      // buildSmartApplyPrompt already degrades gracefully with an empty one.
      const prompt = buildSmartApplyPrompt("", resume.content, entry.job, profile);
      const { text, usage, latencyMs, ok, errorCode } = await callClaudeServerSide(prompt, 8000, env);
      // AI Usage & Cost work order -- this was the one AI call site that
      // never logged to ai_request_log at all (usage was silently
      // discarded). Logged immediately after the call, before the
      // text/JSON checks below, so real Anthropic spend is captured even
      // when what comes back afterward fails to parse.
      await logAIRequest(userId, "smart_apply_auto_prep", getPeriodKey(await getSubscription(userId, env)), usage?.input_tokens, usage?.output_tokens, env, { success: ok, errorCode, latencyMs, model: CLAUDE_MODEL });
      if (!text) throw new Error("empty_claude_response");
      const braceStart = text.indexOf("{"), braceEnd = text.lastIndexOf("}");
      const clean = (braceStart >= 0 && braceEnd > braceStart) ? text.slice(braceStart, braceEnd + 1) : text;
      const result = JSON.parse(clean);
      const integrity = validateSmartApplyPackage(result, profile.country || undefined);
      await markAutoPrepResult(queued.id, result, integrity.ok, env);
      prepared++;
    } catch (e) {
      console.error("[smartApplyAutoPrep] generation_error", userId, entry.job.id, e.message);
      await markAutoPrepFailed(queued.id, env);
    }
  }
  return { userId, prepared };
}

// ── Scheduler: same premium-eligibility gate + time-budget-guarded loop
// pattern already established by runProactiveJobAlertsSchedule above ───────
async function runSmartApplyAutoPrepSchedule(env) {
  const startedAt = Date.now();
  const userIds = await getPremiumUserIds(env);
  const skillDictionary = await fetchSkillDictionary(env);
  let processed = 0, totalPrepared = 0;
  for (const userId of userIds) {
    if (Date.now() - startedAt > SMART_APPLY_AUTO_PREP_TIME_BUDGET_MS) {
      console.log(`[smartApplyAutoPrep] Time budget reached after ${processed}/${userIds.length} users; remainder rolls to tomorrow's run.`);
      break;
    }
    try {
      const result = await runSmartApplyAutoPrepForUser(userId, skillDictionary, env);
      totalPrepared += result.prepared || 0;
      processed++;
    } catch (e) {
      console.error("[smartApplyAutoPrep] user_processing_error", userId, e.message);
    }
  }
  console.log(`[smartApplyAutoPrep] Processed ${processed}/${userIds.length} eligible users, prepared ${totalPrepared} packages.`);
}

// ── Account Deletion Purge (Phase 7, Part A) ──────────────────────────────────
// Every table found to hold personal data in the Phase 7 schema cross-check,
// keyed by its own `user_id` column. `assistant_messages` is deliberately
// omitted: it has no user_id column of its own and is guaranteed to cascade
// (a real DB-level ON DELETE CASCADE FK) when its parent
// assistant_conversations row is deleted below -- the one table in this list
// that's safe to rely on a cascade for. `profiles` itself is handled
// separately, last, since every other table's user_id references it.
const ACCOUNT_DELETION_TABLES = [
  "activity_log", "ai_action_plans", "ai_briefings", "ai_request_log",
  "alert_candidates", "alert_learning_weights", "alerts", "applications",
  "assistant_conversations", "automation_preferences", "career_progress_analysis",
  "company_watchlist", "feature_usage", "interview_sessions", "job_intelligence_analysis",
  "job_matches", "job_watchlist", "linkedin_profile_analyses", "market_signals",
  "networking_contacts", "networking_sessions", "notifications", "opportunity_snapshots",
  "outcome_analyses", "outcome_patterns", "profile_details", "recommendation_evaluations",
  "referral_analyses", "resume_analysis_history", "salary_offers", "salary_research",
  "saved_jobs", "smart_apply_queue", "stripe_events", "subscriptions",
  "subscriptions_legacy", "usage_daily_summary", "user_resumes",
  // Work Order 7 (Back Office): support_case_notes is NOT listed separately
  // -- it cascades automatically when its parent support_cases row is
  // deleted (support_case_notes.case_id ON DELETE CASCADE).
  "support_cases",
];

// Deletes every Storage object for this user's uploaded resume files (not
// just the DB rows referencing them). Uploaded resume files are required
// user data like any table row -- a failure here must throw (not just log)
// so deletion_status is never marked "completed" while a file is still
// sitting in Storage. Safe to resume: re-querying user_resumes for file_url
// paths and re-issuing the same bulk delete is a no-op for anything already
// removed (Supabase Storage's bulk delete does not error on missing paths).
async function purgeResumeFiles(userId, env) {
  const rows = await supabaseGet("user_resumes", { user_id: `eq.${userId}`, select: "file_url" }, env);
  const paths = (rows || []).map(r => r.file_url).filter(Boolean);
  if (!paths.length) return;
  const r = await fetch(`${env.SUPABASE_URL}/storage/v1/object/resumes`, {
    method: "DELETE",
    headers: sbHeaders(env),
    body: JSON.stringify({ prefixes: paths }),
  });
  if (!r.ok) throw new Error(`storage_purge_failed_${r.status}`);
}

// Deletes the Supabase Auth user via the Admin API. Treats "already gone"
// (404) as success -- makes this step idempotent across resumed runs.
async function purgeAuthUser(userId, env) {
  const r = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: sbHeaders(env),
  });
  if (!r.ok && r.status !== 404) {
    throw new Error(`auth_user_delete_${r.status}`);
  }
}

// Strict variant of invalidateSubscription (defined earlier, near the KV
// cache helpers) for the purge only: that function is deliberately
// best-effort/non-fatal for its other callers (handleCancelSubscription,
// handleChangePlan, etc.) where a stale KV entry just self-heals via TTL.
// The purge needs the opposite guarantee -- KV invalidation is one of the
// five required stages, so a failure here must throw, not log and move on.
async function purgeSubscriptionCache(userId, env) {
  await env.SUBSCRIPTION_CACHE.delete(`sub:${userId}`);
}

// Full purge for one user, in the required order: Storage -> 38 tables ->
// Auth user -> profiles -> KV. "completed" is written to account_deletion_log
// -- never to profiles, which is already gone by the time every stage has
// succeeded -- and only as the very last statement, after all five stages
// have each individually succeeded (every helper here throws on real
// failure; nothing swallows an error that should block completion). Every
// step is independently idempotent (deleting zero matching rows twice, an
// already-gone Auth user, or an already-deleted profiles row, is a no-op),
// so a crash anywhere is always safe to resume on the next cron run.
async function purgeUserAccount(userId, env) {
  await purgeResumeFiles(userId, env);
  for (const table of ACCOUNT_DELETION_TABLES) {
    await supabaseDelete(table, { user_id: `eq.${userId}` }, env);
  }
  await purgeAuthUser(userId, env);
  await supabaseDelete("profiles", { id: `eq.${userId}` }, env);
  await purgeSubscriptionCache(userId, env);
  // Single atomic UPDATE -- not a DELETE+INSERT -- so the record is never
  // absent between "identifiable" and "anonymized". crypto.randomUUID() is
  // freshly generated here with no mathematical or deterministic
  // relationship to userId (not a hash of it, not derived from it in any
  // way); user_id is nulled in the same statement that sets it, so a reader
  // (including a crashed-and-resumed run of this same function) only ever
  // sees either the pre-anonymization row (user_id present, status
  // in_progress) or the fully anonymized one (user_id null, status
  // completed) -- never a state in between.
  await supabasePatch("account_deletion_log", { user_id: `eq.${userId}` }, {
    user_id: null,
    deletion_event_id: crypto.randomUUID(),
    status: "completed",
    completed_at: new Date().toISOString(),
  }, env);
}

// 12-month retention cleanup for anonymized deletion records. Runs inside
// the same daily purge schedule (0 3 * * *) rather than a separate cron --
// reusing the existing scheduled infrastructure instead of standing up a
// second scheduler for what is, functionally, another cleanup pass over the
// same table. Targets only status='completed' rows (anonymized, no user_id
// left to look up) past the retention window; naturally idempotent/resumable
// since a row not reached this run is simply picked up by the next one --
// the qualifying condition (completed_at older than 12 months) only becomes
// more true over time, never less.
//
// The 12-month window is an operational product decision for now, not a
// legal conclusion -- it requires legal review before being reflected in any
// published Privacy Policy / retention policy.
async function cleanupExpiredDeletionLogs(env) {
  const cutoff = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const expired = await supabaseGet("account_deletion_log", {
    select: "id",
    status: "eq.completed",
    completed_at: `lte.${cutoff}`,
  }, env);
  let removed = 0;
  for (const row of expired || []) {
    try {
      await supabaseDelete("account_deletion_log", { id: `eq.${row.id}` }, env);
      removed++;
    } catch (e) {
      console.error("[accountDeletion] retention_cleanup_error", row.id, e.message);
    }
  }
  console.log(`[accountDeletion] Removed ${removed}/${(expired || []).length} expired anonymized deletion records.`);
}

// Scheduler: drives entirely off account_deletion_log, not profiles --
// profiles is deleted partway through purgeUserAccount, so it cannot be what
// determines whether a purge is still outstanding. Finds every account whose
// grace period has arrived (or whose purge was already started and needs
// resuming after a prior partial failure) and purges each independently --
// one user's failure never blocks another's, matching the per-user
// try/catch pattern already established by
// runSmartApplyAutoPrepSchedule/runProactiveJobAlertsSchedule above.
async function runAccountDeletionPurgeSchedule(env) {
  const candidates = await supabaseGet("account_deletion_log", {
    select: "user_id,status,scheduled_purge_at",
    status: "in.(scheduled,in_progress)",
  }, env);
  const now = Date.now();
  const due = (candidates || []).filter(c =>
    c.status === "in_progress" || new Date(c.scheduled_purge_at).getTime() <= now
  );
  let purged = 0;
  for (const c of due) {
    try {
      if (c.status === "scheduled") {
        await supabasePatch("account_deletion_log", { user_id: `eq.${c.user_id}` }, { status: "in_progress" }, env);
        await supabasePatch("profiles", { id: `eq.${c.user_id}` }, { deletion_status: "in_progress" }, env);
      }
      await purgeUserAccount(c.user_id, env);
      purged++;
    } catch (e) {
      console.error("[accountDeletion] purge_error", c.user_id, e.message);
    }
  }
  console.log(`[accountDeletion] Purged ${purged}/${due.length} due accounts.`);

  // Same daily run also sweeps expired anonymized records -- see
  // cleanupExpiredDeletionLogs' own header for why this isn't a separate cron.
  await cleanupExpiredDeletionLogs(env);
}

// ─── BACK OFFICE: ROUTES ───────────────────────────────────────────────────────
// Work Order 1: session/auth foundation. Work Order 3: Customer Management
// (read-only). Still no mutation of any kind (refunds, plan changes,
// deletes, impersonation, edits) -- every route here is a GET.

async function handleAdminSession(request, env) {
  const admin = await requireAdmin(request, env);
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);

  try {
    await logAdminAction({
      actorUserId: admin.userId,
      actorRole: admin.role,
      action: "admin_session_check",
    }, env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  return corsResponse(request, { userId: admin.userId, role: admin.role }, 200);
}

// Customer Management is support-visibility scope, not billing-operations
// scope -- billing_ops is deliberately excluded here (per Work Order 3:
// "billing_ops should not automatically receive customer-management
// privileges"). Applies to the DETAIL endpoint (full account/application/
// Smart Apply view). The LIST endpoint below uses the wider
// CUSTOMER_LOOKUP_ROLES instead -- see that constant for why.
const CUSTOMER_MGMT_ROLES = ["support", "superadmin"];

// Work Order 5: billing_ops needs to find a customer to reach the billing
// page (Work Order 4's BILLING_MGMT_ROLES), but has no access to full
// customer detail. This grants billing_ops the LIST endpoint only, with a
// deliberately trimmed response (see handleAdminCustomerList) -- name,
// email, plan, subscription status, and id, nothing else. The DETAIL
// endpoint stays on the narrower CUSTOMER_MGMT_ROLES above.
const CUSTOMER_LOOKUP_ROLES = ["support", "billing_ops", "superadmin"];

// PostgREST's or=(...) filter syntax treats a bare comma or parenthesis as a
// structural delimiter even when URL-encoded (it parses the decoded query
// string) -- backslash-escaping is PostgREST's own convention for a literal
// occurrence of either inside a filter value. Without this, a search term
// like "Smith (Acme)" would silently corrupt the filter grouping rather than
// searching for that literal text.
function escapePostgrestFilterValue(s) {
  return String(s).replace(/[,()]/g, (c) => `\\${c}`);
}

// GET /api/admin/customers?q=&page=&pageSize= -- searchable, paginated
// customer directory. Reuses computeBillingState() (already pure/parameterized)
// for the same Plan/Status the customer-facing billing UI shows -- no
// separate "admin's idea of the customer's plan" is computed.
async function handleAdminCustomerList(request, env) {
  const admin = await requireAdmin(request, env, { roles: CUSTOMER_LOOKUP_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "25", 10) || 25));

  const params = {
    select: "id,email,full_name,subscription_status,cancel_at_period_end,current_period_end,grace_period_ends_at,deletion_status,created_at,updated_at",
    order: "created_at.desc",
    limit: String(pageSize),
    offset: String((page - 1) * pageSize),
  };
  if (q) {
    const esc = escapePostgrestFilterValue(q);
    params.or = `(email.ilike.*${esc}*,full_name.ilike.*${esc}*)`;
  }

  let result;
  try {
    result = await supabaseGetWithCount("profiles", params, env);
  } catch (e) {
    console.error("admin_customer_list_failed", e.message);
    return corsResponse(request, { error: "query_failed" }, 500);
  }

  // billing_ops gets a deliberately minimal row shape -- just enough to
  // find the right customer and jump to their billing page (id, name,
  // email, plan, subscription status). No deletion status, no dates beyond
  // what's needed: those belong to the support-scoped detail view this role
  // cannot reach.
  const isLookupOnly = admin.role === "billing_ops";

  const customers = result.rows.map((p) => {
    const billingState = computeBillingState({
      subscription_status: p.subscription_status,
      cancel_at_period_end: p.cancel_at_period_end,
      current_period_end: p.current_period_end,
      grace_period_ends_at: p.grace_period_ends_at,
    });
    const base = {
      id: p.id,
      email: p.email,
      fullName: p.full_name,
      plan: BILLING_STATE_PLAN[billingState] ?? "Free",
      billingState,
    };
    if (isLookupOnly) return base;
    return {
      ...base,
      deletionStatus: p.deletion_status,
      createdAt: p.created_at,
      // Cheap, always-available proxy for last profile-row activity on a
      // bulk list -- any change to this row (webhook update, a Settings
      // save, an admin action later). Deliberately NOT labeled "last
      // activity" anywhere in the UI (Work Order 5, item 7) -- a real
      // activity/event system is a separate, later, dedicated design.
      profileUpdatedAt: p.updated_at,
    };
  });

  return corsResponse(request, {
    customers,
    page,
    pageSize,
    total: result.total,
    totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
  });
}

// GET /api/admin/customers/detail?id=<uuid> -- single-customer support view.
// Every field is read verbatim from data the customer's own app already
// exposes to them (profile, billing state, quotas, application/Smart Apply
// history) -- nothing new is computed or inferred, and nothing from
// auth.users beyond last_sign_in_at is read (never the password hash or any
// provider token). See CUSTOMER_MGMT_ROLES for why billing_ops is excluded.
async function handleAdminCustomerDetail(request, env) {
  const admin = await requireAdmin(request, env, { roles: CUSTOMER_MGMT_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);

  const url = new URL(request.url);
  const targetId = url.searchParams.get("id");
  if (!targetId) return corsResponse(request, { error: "missing_id" }, 400);

  const profileRows = await supabaseGet("profiles", {
    id: `eq.${targetId}`,
    select: "id,email,full_name,phone,country,location,job_title,years_experience,created_at,updated_at,deletion_status,deletion_requested_at,deletion_scheduled_purge_at",
  }, env).catch(() => null);
  const profile = profileRows?.[0];
  if (!profile) return corsResponse(request, { error: "not_found" }, 404);

  const lastSignInAt = await fetchLastSignInAt(targetId, env);

  const [sub, config] = await Promise.all([getSubscription(targetId, env), getConfig(env)]);
  const caps = getCapabilities(sub, config);
  const usage = await getUsage(targetId, getPeriodKey(sub), env);
  const billingState = computeBillingState(sub);

  // One bounded query per table (not one query per status) -- a support
  // account's history is realistically a few hundred rows at most; capping
  // at 1000 and flagging `truncated` keeps this a single round-trip per
  // table with no new SQL views/RPCs, while still being exact for the
  // overwhelming majority of real accounts.
  const [appRows, saRows] = await Promise.all([
    supabaseGet("applications", {
      user_id: `eq.${targetId}`,
      select: "id,company,job_title,status,date_applied,response_status,smart_apply_used,created_at",
      order: "created_at.desc",
      limit: "1000",
    }, env).catch(() => []),
    supabaseGet("smart_apply_queue", {
      user_id: `eq.${targetId}`,
      select: "id,job_title,company,status,retry_count,generation_source,created_at",
      order: "created_at.desc",
      limit: "1000",
    }, env).catch(() => []),
  ]);

  // Deliberately excludes freeform user-authored/AI-generated content
  // (application notes, cover letters, tailored resumes, recruiter/
  // networking messages) from every summary below -- status/metadata is
  // what's needed to troubleshoot "is this feature working for this
  // account", not the customer's private generated documents.
  const summarize = (rows) => {
    const byStatus = {};
    for (const r of rows) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    return { total: rows.length, truncated: rows.length >= 1000, byStatus, recent: rows.slice(0, 10) };
  };

  // Deferred Fix #3: "true customer activity" -- the most recent of three
  // genuine, customer-initiated events already fetched above for this
  // handler's own existing purposes (nothing new queried, no new schema):
  // a real Supabase Auth sign-in, adding/tracking a job application, or
  // running Smart Apply. All three come from `created_at` (when the row was
  // actually written), never `date_applied` (a user-editable, potentially
  // back-dated field) and never profiles.updated_at (which the Work Order 5
  // report already flagged as unreliable -- it moves on webhook-driven
  // billing writes and other server-side touches that have nothing to do
  // with the customer actually doing anything). appRows/saRows are both
  // already ordered created_at.desc, so their most recent row's timestamp
  // is simply the first element -- no extra sorting or querying needed.
  const activityCandidates = [
    lastSignInAt && { at: lastSignInAt, source: "sign_in" },
    appRows[0] && { at: appRows[0].created_at, source: "application" },
    saRows[0] && { at: saRows[0].created_at, source: "smart_apply" },
  ].filter(Boolean);
  const lastActivity = activityCandidates.length
    ? activityCandidates.reduce((latest, c) => (new Date(c.at) > new Date(latest.at) ? c : latest))
    : null;

  try {
    await logAdminAction({
      actorUserId: admin.userId,
      actorRole: admin.role,
      action: "customer_view",
      targetUserId: targetId,
    }, env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  return corsResponse(request, {
    lastActivityAt: lastActivity?.at ?? null,
    lastActivitySource: lastActivity?.source ?? null,
    profile: {
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      phone: profile.phone,
      country: profile.country,
      location: profile.location,
      jobTitle: profile.job_title,
      yearsExperience: profile.years_experience,
      createdAt: profile.created_at,
      updatedAt: profile.updated_at,
      deletionStatus: profile.deletion_status,
      deletionRequestedAt: profile.deletion_requested_at,
      deletionScheduledPurgeAt: profile.deletion_scheduled_purge_at,
    },
    lastSignInAt,
    billing: {
      billingState,
      subscriptionStatus: sub.subscription_status ?? "no_subscription",
      planDisplayName: BILLING_STATE_PLAN[billingState] ?? "Free",
      canUseAI: caps.canUseAI,
      canUseJobs: caps.canUseJobs,
      periodEnd: sub.current_period_end ?? null,
      cancelAtPeriodEnd: sub.cancel_at_period_end ?? false,
      // Stripe customer ID only -- a cross-reference for looking the
      // customer up in the Stripe dashboard, not a card/payment credential.
      stripeCustomerId: sub.stripe_customer_id ?? null,
      paymentMethodOnFile: !!sub.stripe_customer_id,
      quotas: computeQuotas(caps, usage),
    },
    applications: summarize(appRows.map((r) => ({
      id: r.id, company: r.company, jobTitle: r.job_title, status: r.status,
      dateApplied: r.date_applied, responseStatus: r.response_status,
      smartApplyUsed: r.smart_apply_used, createdAt: r.created_at,
    }))),
    smartApply: summarize(saRows.map((r) => ({
      id: r.id, jobTitle: r.job_title, company: r.company, status: r.status,
      retryCount: r.retry_count, generationSource: r.generation_source, createdAt: r.created_at,
    }))),
  });
}

// ─── BACK OFFICE: CUSTOMER ACCOUNT ACTIONS (Work Order 8) ──────────────────
// Deliberately narrow: after inspecting the schema and every existing
// customer-facing account operation, the only action that is (a) already
// fully implemented and schema-backed as a customer self-service flow
// (POST /api/account/cancel-deletion), (b) genuinely reversible -- it
// restores the account to its pre-deletion-request state, nothing is
// destroyed or re-derived -- and (c) carries no new security or business
// policy decision, is cancelling an already-scheduled account deletion.
// Staff triggering it on behalf of a customer (e.g. one who called in still
// locked out by their own pending deletion) is the same operation the
// customer would run themselves, just initiated from the Back Office.
// Reuses cancelScheduledDeletion() verbatim -- see that function's own
// comment. Every other candidate considered (resend verification, force
// sign-out, notification/language preference edits) was rejected: none of
// them has an existing self-service equivalent or an already-decided policy
// behind it, so implementing them here would mean inventing a new
// capability rather than exposing one that already exists -- exactly what
// this Work Order was told to stop and report instead of doing.
async function handleAdminCancelCustomerDeletion(request, env) {
  const admin = await requireAdmin(request, env, { roles: CUSTOMER_MGMT_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);

  let body;
  try { body = await request.json(); } catch { return corsResponse(request, { error: "invalid_body" }, 400); }
  const targetId = body?.userId;
  if (!targetId) return corsResponse(request, { error: "missing_user_id" }, 400);

  const existing = await supabaseGet("profiles", { id: `eq.${targetId}`, select: "id,deletion_status" }, env).catch(() => []);
  const profile = existing?.[0];
  if (!profile) return corsResponse(request, { error: "not_found" }, 404);

  // Deferred Fix #1: a cheap, read-only mirror of cancelScheduledDeletion's
  // own eligibility check (same two error codes it already returns), done
  // here so the audit row can be written BEFORE the actual mutation runs --
  // if there's nothing eligible to cancel, we say so now and never touch
  // the audit log or the profiles row. The state-changing logic itself
  // stays solely in cancelScheduledDeletion; this only decides whether
  // it's worth attempting.
  if (profile.deletion_status !== "scheduled") {
    return corsResponse(request, { error: profile.deletion_status ? "deletion_already_in_progress" : "no_deletion_scheduled" }, 400);
  }

  // Audit-before-mutation (Deferred Fix #1): if this write fails, the 500
  // below is now always accurate -- no profiles/account_deletion_log write
  // has happened yet. No before/after payload -- the action is binary (a
  // deletion was pending, now it isn't) and the target/action name already
  // say that; no need to carry deletion_scheduled_purge_at or any other
  // customer data into the audit row.
  try {
    await logAdminAction({
      actorUserId: admin.userId,
      actorRole: admin.role,
      action: "customer_deletion_cancelled",
      targetUserId: targetId,
    }, env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  // Extremely unlikely race: eligibility could theoretically change between
  // the pre-check above and this call (e.g. the purge cron picks the
  // account up in that window). If so, the audit row above ends up
  // describing an attempt that didn't take effect -- a documented residual
  // gap, and strictly preferable to the alternative (a real mutation with
  // no audit record at all).
  const result = await cancelScheduledDeletion(targetId, env);
  if (!result.ok) return corsResponse(request, { error: result.error }, 400);

  return corsResponse(request, { success: true });
}

// Billing/Stripe visibility is a narrower grant than general customer
// support visibility -- support is excluded per Work Order 4 ("no billing
// module access unless explicitly approved"). Deliberately a separate
// constant from CUSTOMER_MGMT_ROLES, not a subset check, so the two can
// diverge further without one accidentally constraining the other.
const BILLING_MGMT_ROLES = ["billing_ops", "superadmin"];

// Maps a Stripe Charge to only the fields this module needs -- never the
// raw Stripe object (which includes billing_details.address, receipt_email,
// and other fields beyond what a support view needs). Refunds and disputes
// are read from the SAME charge object (via expand=data.dispute on the list
// call) rather than separate API calls -- Stripe already embeds a bounded
// `refunds` list on every charge, and `dispute` when expanded, so one
// /charges list call covers payments + failures + refunds + disputes.
function mapStripeCharge(c) {
  return {
    id: c.id,
    amount: c.amount,
    currency: c.currency,
    status: c.status, // 'succeeded' | 'pending' | 'failed'
    createdAt: c.created ? new Date(c.created * 1000).toISOString() : null,
    failureCode: c.failure_code ?? null,
    failureMessage: c.failure_message ?? null,
    refunded: !!c.refunded,
    amountRefunded: c.amount_refunded ?? 0,
    disputed: !!c.disputed,
  };
}

// GET /api/admin/customers/billing?id=<uuid> -- read-only Stripe billing
// view. Stripe is the sole source for every Stripe-side fact here (amount,
// interval, period, payment method, payments, refunds, disputes, invoices)
// -- none of it is inferred or approximated from Supabase. The only
// Supabase-derived fields are careerPersonaPlan/careerPersonaBillingState,
// which are OUR OWN state (what tier/quotas we've granted), reusing the
// exact same getSubscription()/computeBillingState() the customer-facing
// billing endpoint and the Work Order 3 customer detail view already use --
// not a second implementation of that logic.
async function handleAdminCustomerBilling(request, env) {
  const admin = await requireAdmin(request, env, { roles: BILLING_MGMT_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);

  const url = new URL(request.url);
  const targetId = url.searchParams.get("id");
  if (!targetId) return corsResponse(request, { error: "missing_id" }, 400);

  const profileRows = await supabaseGet("profiles", {
    id: `eq.${targetId}`, select: "id,stripe_customer_id",
  }, env).catch(() => null);
  const profile = profileRows?.[0];
  if (!profile) return corsResponse(request, { error: "not_found" }, 404);

  const sub = await getSubscription(targetId, env);
  const careerPersonaBillingState = computeBillingState(sub);
  const base = {
    careerPersonaPlan: BILLING_STATE_PLAN[careerPersonaBillingState] ?? "Free",
    careerPersonaBillingState,
  };

  const stripeCustomerId = profile.stripe_customer_id;
  if (!stripeCustomerId) {
    // Legitimate, clean state -- not an error. A Free customer, or one who
    // never completed checkout, simply has no Stripe customer yet.
    return corsResponse(request, { ...base, hasStripeCustomer: false, stripeCustomerId: null });
  }

  if (!env.STRIPE_SECRET_KEY) return corsResponse(request, { error: "stripe_not_configured" }, 503);

  let customer, subscriptions, charges, invoices;
  try {
    [customer, subscriptions, charges, invoices] = await Promise.all([
      stripeRequest("GET", `/customers/${stripeCustomerId}?expand[]=invoice_settings.default_payment_method`, null, env),
      stripeRequest("GET", `/subscriptions?customer=${stripeCustomerId}&status=all&limit=5`, null, env),
      stripeRequest("GET", `/charges?customer=${stripeCustomerId}&limit=20&expand[]=data.dispute`, null, env),
      stripeRequest("GET", `/invoices?customer=${stripeCustomerId}&limit=10`, null, env),
    ]);
  } catch (e) {
    // Any failure here means we genuinely could not read Stripe -- fail
    // closed with a clear "Stripe data unavailable" signal rather than
    // returning partial financial data that could look complete but isn't.
    console.error("admin_billing_stripe_error", e.message);
    return corsResponse(request, { error: "stripe_api_error" }, 502);
  }

  const dpm = customer.invoice_settings?.default_payment_method;
  const paymentMethod = dpm && typeof dpm === "object" && dpm.card
    ? { brand: dpm.card.brand, last4: dpm.card.last4, expMonth: dpm.card.exp_month, expYear: dpm.card.exp_year }
    : null;

  const chargeRows = charges.data ?? [];
  const payments = chargeRows.map(mapStripeCharge);
  const refunds = chargeRows.flatMap((c) =>
    (c.refunds?.data ?? []).map((r) => ({
      id: r.id, chargeId: c.id, amount: r.amount, currency: r.currency,
      status: r.status, reason: r.reason ?? null,
      createdAt: r.created ? new Date(r.created * 1000).toISOString() : null,
    }))
  );
  const disputes = chargeRows.filter((c) => c.dispute && typeof c.dispute === "object").map((c) => ({
    id: c.dispute.id, chargeId: c.id, amount: c.dispute.amount, currency: c.dispute.currency,
    status: c.dispute.status, reason: c.dispute.reason ?? null,
    createdAt: c.dispute.created ? new Date(c.dispute.created * 1000).toISOString() : null,
  }));

  const subscriptionRows = (subscriptions.data ?? []).map((s) => {
    const item = s.items?.data?.[0];
    const period = getSubscriptionPeriod(s);
    return {
      id: s.id,
      status: s.status,
      amount: item?.price?.unit_amount ?? null,
      currency: item?.price?.currency ?? null,
      interval: item?.price?.recurring?.interval ?? null,
      intervalCount: item?.price?.recurring?.interval_count ?? null,
      currentPeriodStart: period.start ? new Date(period.start * 1000).toISOString() : null,
      currentPeriodEnd: period.end ? new Date(period.end * 1000).toISOString() : null,
      cancelAtPeriodEnd: !!s.cancel_at_period_end,
      canceledAt: s.canceled_at ? new Date(s.canceled_at * 1000).toISOString() : null,
      createdAt: s.created ? new Date(s.created * 1000).toISOString() : null,
    };
  });

  const invoiceRows = (invoices.data ?? []).map((inv) => ({
    id: inv.id,
    status: inv.status, // 'draft' | 'open' | 'paid' | 'uncollectible' | 'void'
    amountDue: inv.amount_due,
    amountPaid: inv.amount_paid,
    currency: inv.currency,
    createdAt: inv.created ? new Date(inv.created * 1000).toISOString() : null,
    // Stripe-hosted invoice page -- a shareable link, not a credential.
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
  }));

  // Read-only view, but still access to one identifiable customer's
  // financial data -- auditable per Work Order 4. No payment data itself
  // goes into the log (no amounts, no card/payment-method details).
  try {
    await logAdminAction({
      actorUserId: admin.userId, actorRole: admin.role,
      action: "customer_billing_view", targetUserId: targetId,
    }, env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  return corsResponse(request, {
    ...base,
    hasStripeCustomer: true,
    stripeCustomerId,
    paymentMethod,
    subscriptions: subscriptionRows,
    payments,
    refunds,
    disputes,
    invoices: invoiceRows,
  });
}

// Fixed, clearly-labeled reporting window for the whole dashboard (customer
// growth, product activity, AND Stripe revenue) -- one period, one label,
// used everywhere so nothing on the page can be silently comparing two
// different windows. Not user-configurable in this Work Order; a period
// selector is a frontend-only addition if wanted later, not a reason to
// complicate this endpoint yet.
const DASHBOARD_PERIOD_DAYS = 30;

// Count-only helper for `profiles` -- select:"id", limit:"1" (a single row
// of data is transferred, not zero, but PostgREST's count=exact header
// still returns the true total via Content-Range regardless of limit; this
// keeps every dashboard count to one cheap request, never a bulk row fetch).
async function countProfiles(filterParams, env) {
  const result = await supabaseGetWithCount("profiles", { select: "id", limit: "1", ...filterParams }, env);
  return result.total;
}

// GET /api/admin/dashboard -- operations overview. Every role (support,
// billing_ops, superadmin) passes the auth gate; which SECTIONS of the
// response get populated is conditional on admin.role below, mirroring the
// same section-level RBAC split already established: support sees customer/
// product-activity/account data (never Stripe/financial), billing_ops sees
// billing/revenue data (never the customer roster or application content),
// superadmin sees both. A role that doesn't need a section triggers NONE of
// that section's queries -- support loads make zero Stripe calls.
async function handleAdminDashboard(request, env) {
  const admin = await requireAdmin(request, env); // any active staff role
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);

  const now = new Date();
  const periodStart = new Date(now.getTime() - DASHBOARD_PERIOD_DAYS * 86400000);
  const period = { label: `Last ${DASHBOARD_PERIOD_DAYS} days`, startAt: periodStart.toISOString(), endAt: now.toISOString() };
  const periodStartFilter = `gte.${period.startAt}`;

  const wantsSupportData = admin.role === "support" || admin.role === "superadmin";
  const wantsBillingData = admin.role === "billing_ops" || admin.role === "superadmin";

  const response = { period };
  const tasks = [];

  // System health -- reuses checkSupabaseHealth() and checkKvHealth(), the
  // same connectivity probes handleHealth() runs (Fix KV Health Reporting
  // work order made kv a real check here too, matching db; previously kv
  // was hardcoded "ok" and never actually verified). Harmless to every
  // role: no secrets, just db/kv connectivity booleans.
  tasks.push((async () => {
    const [db, kv] = await Promise.all([checkSupabaseHealth(env), checkKvHealth(env)]);
    response.systemHealth = {
      db: !db.configured ? "unconfigured" : db.ok ? "ok" : "error",
      kv: kv.ok ? "ok" : "error",
    };
  })());

  if (wantsSupportData) {
    tasks.push((async () => {
      const [
        totalCustomers, newCustomers, activeSubscriptions,
        freeCount, proCount, premiumCount, adminCount,
        applicationsInPeriod, smartApplyInPeriod, smartApplyAppliedInPeriod,
        deletionScheduledCount,
      ] = await Promise.all([
        countProfiles({}, env),
        countProfiles({ created_at: periodStartFilter }, env),
        countProfiles({ subscription_status: "in.(pro_active,premium_active)" }, env),
        // Plan breakdown buckets every valid subscription_status value
        // (profiles_subscription_status_check) into exactly one plan tier --
        // matches BILLING_STATE_PLAN's own grouping, computed via exact
        // per-bucket counts (4 cheap queries) rather than fetching every
        // row's status and reducing client-side.
        countProfiles({ subscription_status: "eq.no_subscription" }, env),
        countProfiles({ subscription_status: "in.(pro_active,pro_past_due,pro_cancelled)" }, env),
        countProfiles({ subscription_status: "in.(premium_active,premium_past_due,premium_cancelled)" }, env),
        countProfiles({ subscription_status: "eq.admin" }, env),
        supabaseGetWithCount("applications", { select: "id", limit: "1", created_at: periodStartFilter }, env).then((r) => r.total),
        supabaseGetWithCount("smart_apply_queue", { select: "id", limit: "1", created_at: periodStartFilter }, env).then((r) => r.total),
        supabaseGetWithCount("smart_apply_queue", { select: "id", limit: "1", created_at: periodStartFilter, status: "eq.applied" }, env).then((r) => r.total),
        countProfiles({ deletion_status: "in.(scheduled,in_progress)" }, env),
      ]);
      response.customerOverview = {
        totalCustomers, newCustomers, activeSubscriptions,
        planBreakdown: { free: freeCount, pro: proCount, premium: premiumCount, admin: adminCount },
      };
      response.productActivity = { applicationsInPeriod, smartApplyInPeriod, smartApplyAppliedInPeriod };
      response.accountAlerts = { deletionScheduledCount };
    })());
  }

  if (wantsBillingData) {
    tasks.push((async () => {
      const [pastDueCount, cancelingCount] = await Promise.all([
        countProfiles({ subscription_status: "in.(pro_past_due,premium_past_due)" }, env),
        countProfiles({ cancel_at_period_end: "eq.true" }, env),
      ]);

      if (!env.STRIPE_SECRET_KEY) {
        response.billingHealth = { pastDueCount, cancelingCount, revenue: null, failedPayments: null, stripeError: "stripe_not_configured" };
        return;
      }

      // Revenue MUST come from Stripe, never estimated from Supabase plan
      // counts -- these two calls are the sole source for every dollar
      // figure below. Bounded: one page each (limit=100), filtered to the
      // same period as the rest of the dashboard, never paginated further --
      // `truncated` tells the UI honestly if more than 100 existed rather
      // than silently under-counting. The charges call also serves failed-
      // payment detection, so revenue + failures share one Stripe request.
      const periodStartUnix = Math.floor(periodStart.getTime() / 1000);
      try {
        const [charges, refunds] = await Promise.all([
          stripeRequest("GET", `/charges?created[gte]=${periodStartUnix}&limit=100`, null, env),
          stripeRequest("GET", `/refunds?created[gte]=${periodStartUnix}&limit=100`, null, env),
        ]);

        // Grouped by currency, never summed together -- Adaptive Pricing
        // (handleCheckoutSession) means charges for the same USD-reference
        // price can settle in different customer-local currencies, and
        // adding raw minor-unit amounts across currencies would produce a
        // meaningless total.
        const byCurrency = {};
        const bucket = (cur) => (byCurrency[cur] ??= { currency: cur, grossCents: 0, refundedCents: 0, chargeCount: 0, refundCount: 0 });
        const failedList = [];
        for (const c of charges.data ?? []) {
          if (c.status === "succeeded") { const b = bucket(c.currency); b.grossCents += c.amount; b.chargeCount++; }
          if (c.status === "failed") {
            failedList.push({ id: c.id, amount: c.amount, currency: c.currency, createdAt: new Date(c.created * 1000).toISOString(), failureMessage: c.failure_message ?? c.failure_code ?? null });
          }
        }
        for (const r of refunds.data ?? []) { const b = bucket(r.currency); b.refundedCents += r.amount; b.refundCount++; }
        const revenueByCurrency = Object.values(byCurrency).map((b) => ({ ...b, netCents: b.grossCents - b.refundedCents }));

        response.billingHealth = {
          pastDueCount, cancelingCount,
          revenue: { periodLabel: period.label, byCurrency: revenueByCurrency, truncated: !!charges.has_more || !!refunds.has_more },
          failedPayments: { count: failedList.length, recent: failedList.slice(0, 10) },
        };
      } catch (e) {
        console.error("admin_dashboard_stripe_error", e.message);
        response.billingHealth = { pastDueCount, cancelingCount, revenue: null, failedPayments: null, stripeError: "stripe_api_error" };
      }
    })());
  }

  await Promise.all(tasks);
  return corsResponse(request, response);
}

// ─── BACK OFFICE: SUPPORT CASES (Work Order 7) ────────────────────────────────
// Support-case visibility mirrors CUSTOMER_MGMT_ROLES exactly (support,
// superadmin) -- billing_ops is explicitly excluded here, same as it is from
// full customer detail. A distinct constant rather than reusing
// CUSTOMER_MGMT_ROLES directly so the two can diverge later without one
// accidentally constraining the other (same reasoning as BILLING_MGMT_ROLES
// vs CUSTOMER_MGMT_ROLES in Work Order 4).
const SUPPORT_CASE_ROLES = ["support", "superadmin"];
const SUPPORT_CASE_STATUSES = ["open", "in_progress", "resolved"];
const SUPPORT_CASE_PRIORITIES = ["low", "normal", "high", "urgent"];

// Batched identity lookup for enriching case rows -- every person a case can
// reference (the customer, who created it, who it's assigned to) has a
// `profiles` row, staff included (handle_new_user() creates one for every
// signup, and staff are just regular users who additionally have a `staff`
// row). One query resolves all of them regardless of how many distinct
// people are involved, bounded by the page/case size, not a query per id.
async function fetchProfilesById(ids, env) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return {};
  const rows = await supabaseGet("profiles", { id: `in.(${unique.join(",")})`, select: "id,email,full_name" }, env).catch(() => []);
  return Object.fromEntries(rows.map((r) => [r.id, { email: r.email, fullName: r.full_name }]));
}

function mapCaseRow(c, people) {
  return {
    id: c.id,
    userId: c.user_id,
    customer: people[c.user_id] ?? null,
    status: c.status,
    priority: c.priority,
    subject: c.subject,
    description: c.description,
    createdBy: c.created_by,
    createdByName: people[c.created_by]?.email ?? null,
    assignedTo: c.assigned_to,
    assignedToName: people[c.assigned_to]?.email ?? null,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    resolvedAt: c.resolved_at,
  };
}

// GET /api/admin/support-cases?q=&status=&priority=&assignedTo=&userId=&page=&pageSize=
async function handleAdminSupportCaseList(request, env) {
  const admin = await requireAdmin(request, env, { roles: SUPPORT_CASE_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);

  const url = new URL(request.url);
  const q = (url.searchParams.get("q") || "").trim();
  const status = url.searchParams.get("status") || "";
  const priority = url.searchParams.get("priority") || "";
  const assignedTo = url.searchParams.get("assignedTo") || "";
  const userId = url.searchParams.get("userId") || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "25", 10) || 25));

  const params = {
    select: "id,user_id,status,priority,subject,description,created_by,assigned_to,created_at,updated_at,resolved_at",
    order: "created_at.desc",
    limit: String(pageSize),
    offset: String((page - 1) * pageSize),
  };
  if (q) params.subject = `ilike.*${escapePostgrestFilterValue(q)}*`;
  if (status && SUPPORT_CASE_STATUSES.includes(status)) params.status = `eq.${status}`;
  if (priority && SUPPORT_CASE_PRIORITIES.includes(priority)) params.priority = `eq.${priority}`;
  if (assignedTo === "unassigned") params.assigned_to = "is.null";
  else if (assignedTo) params.assigned_to = `eq.${assignedTo}`;
  if (userId) params.user_id = `eq.${userId}`;

  let result;
  try {
    result = await supabaseGetWithCount("support_cases", params, env);
  } catch (e) {
    console.error("admin_support_case_list_failed", e.message);
    return corsResponse(request, { error: "query_failed" }, 500);
  }

  const ids = result.rows.flatMap((c) => [c.user_id, c.created_by, c.assigned_to]);
  const people = await fetchProfilesById(ids, env);

  return corsResponse(request, {
    cases: result.rows.map((c) => mapCaseRow(c, people)),
    page, pageSize, total: result.total, totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
  });
}

// GET /api/admin/support-cases/detail?id= -- case + its internal notes.
async function handleAdminSupportCaseDetail(request, env) {
  const admin = await requireAdmin(request, env, { roles: SUPPORT_CASE_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);

  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return corsResponse(request, { error: "missing_id" }, 400);

  const caseRows = await supabaseGet("support_cases", { id: `eq.${id}` }, env).catch(() => null);
  const caseRow = caseRows?.[0];
  if (!caseRow) return corsResponse(request, { error: "not_found" }, 404);

  const noteRows = await supabaseGet("support_case_notes", {
    case_id: `eq.${id}`, select: "id,author_id,note,created_at", order: "created_at.asc", limit: "200",
  }, env).catch(() => []);

  const people = await fetchProfilesById([caseRow.user_id, caseRow.created_by, caseRow.assigned_to, ...noteRows.map((n) => n.author_id)], env);

  return corsResponse(request, {
    ...mapCaseRow(caseRow, people),
    notes: noteRows.map((n) => ({ id: n.id, authorId: n.author_id, authorName: people[n.author_id]?.email ?? null, note: n.note, createdAt: n.created_at })),
  });
}

// POST /api/admin/support-cases -- create. Body: {userId, subject, description?, priority?}
async function handleAdminSupportCaseCreate(request, env) {
  const admin = await requireAdmin(request, env, { roles: SUPPORT_CASE_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);

  let body;
  try { body = await request.json(); } catch { return corsResponse(request, { error: "invalid_body" }, 400); }
  const { userId, subject } = body || {};
  const description = body?.description ?? null;
  const priority = SUPPORT_CASE_PRIORITIES.includes(body?.priority) ? body.priority : "normal";
  if (!userId || !subject || !String(subject).trim()) return corsResponse(request, { error: "missing_fields" }, 400);

  const profileRows = await supabaseGet("profiles", { id: `eq.${userId}`, select: "id" }, env).catch(() => []);
  if (!profileRows?.[0]) return corsResponse(request, { error: "customer_not_found" }, 404);

  // Deferred Fix #1: the case id is generated here, in the Worker, instead
  // of leaving it to support_cases.id's DEFAULT gen_random_uuid() -- that's
  // what lets the audit row be written BEFORE the insert (it needs a caseId
  // to put in its metadata). Passing an explicit id in the INSERT body is
  // equivalent to letting Postgres generate one; nothing about the column's
  // own default or the row's shape changes.
  const caseId = crypto.randomUUID();

  // Audit-before-mutation: if this write fails, the 500 below is now always
  // accurate -- no support_cases row has been created yet.
  try {
    await logAdminAction({
      actorUserId: admin.userId, actorRole: admin.role,
      action: "support_case_created", targetUserId: userId,
      metadata: { caseId, priority },
    }, env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  let created;
  try {
    const rows = await supabasePost("support_cases", {
      id: caseId, user_id: userId, subject: String(subject).trim(), description, priority,
      status: "open", created_by: admin.userId,
    }, env);
    created = rows[0];
  } catch (e) {
    // Residual gap: the audit row above now describes a case that was
    // never actually created. Documented, and strictly preferable to a
    // created case with no audit record at all -- see the report for
    // Deferred Fix #1.
    console.error("admin_support_case_create_failed", e.message);
    return corsResponse(request, { error: "create_failed" }, 500);
  }

  const people = await fetchProfilesById([created.user_id, created.created_by, created.assigned_to], env);
  return corsResponse(request, mapCaseRow(created, people), 201);
}

// POST /api/admin/support-cases/update -- partial update.
// Body: {id, status?, priority?, assignedTo?, subject?, description?}
// assignedTo may be explicitly null to unassign -- distinguished from
// "not provided" via `"assignedTo" in body`, not truthiness.
async function handleAdminSupportCaseUpdate(request, env) {
  const admin = await requireAdmin(request, env, { roles: SUPPORT_CASE_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);

  let body;
  try { body = await request.json(); } catch { return corsResponse(request, { error: "invalid_body" }, 400); }
  const { id } = body || {};
  if (!id) return corsResponse(request, { error: "missing_id" }, 400);

  const existingRows = await supabaseGet("support_cases", { id: `eq.${id}` }, env).catch(() => null);
  const existing = existingRows?.[0];
  if (!existing) return corsResponse(request, { error: "not_found" }, 404);

  const patch = {};
  const events = []; // audit events to emit after a successful write

  if ("status" in body) {
    if (!SUPPORT_CASE_STATUSES.includes(body.status)) return corsResponse(request, { error: "invalid_status" }, 400);
    if (body.status !== existing.status) {
      patch.status = body.status;
      patch.resolved_at = body.status === "resolved" ? new Date().toISOString() : null;
      events.push({ action: "support_case_status_changed", metadata: { caseId: id, from: existing.status, to: body.status } });
    }
  }
  if ("priority" in body) {
    if (!SUPPORT_CASE_PRIORITIES.includes(body.priority)) return corsResponse(request, { error: "invalid_priority" }, 400);
    if (body.priority !== existing.priority) {
      patch.priority = body.priority;
      events.push({ action: "support_case_priority_changed", metadata: { caseId: id, from: existing.priority, to: body.priority } });
    }
  }
  if ("assignedTo" in body) {
    const newAssignee = body.assignedTo || null;
    if (newAssignee) {
      const staffRows = await supabaseGet("staff", { user_id: `eq.${newAssignee}`, active: "eq.true", select: "user_id" }, env).catch(() => []);
      if (!staffRows?.[0]) return corsResponse(request, { error: "invalid_assignee" }, 400);
    }
    if (newAssignee !== existing.assigned_to) {
      patch.assigned_to = newAssignee;
      events.push({ action: "support_case_assignment_changed", metadata: { caseId: id, from: existing.assigned_to, to: newAssignee } });
    }
  }
  let contentChanged = false;
  if ("subject" in body && String(body.subject).trim() && body.subject !== existing.subject) { patch.subject = String(body.subject).trim(); contentChanged = true; }
  if ("description" in body && body.description !== existing.description) { patch.description = body.description; contentChanged = true; }
  if (contentChanged) events.push({ action: "support_case_updated", metadata: { caseId: id } });

  if (Object.keys(patch).length === 0) {
    const people = await fetchProfilesById([existing.user_id, existing.created_by, existing.assigned_to], env);
    return corsResponse(request, mapCaseRow(existing, people)); // nothing actually changed
  }

  // Deferred Fix #1: every semantic change gets its own audit row (Work
  // Order 7 item 5 lists status/priority/assignment as distinct event
  // types), written here as ONE batched INSERT (logAdminActions) -- a
  // single PostgREST array-body insert is one atomic Postgres statement, so
  // either all of this request's events are recorded or none are, never a
  // partial set. Writing this BEFORE the patch means a failure here now
  // always means the case is unchanged; the 500 below is accurate.
  try {
    await logAdminActions(events.map((evt) => ({
      actorUserId: admin.userId, actorRole: admin.role, action: evt.action, targetUserId: existing.user_id, metadata: evt.metadata,
    })), env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  let updated;
  try {
    const rows = await supabasePatch("support_cases", { id: `eq.${id}` }, patch, env);
    updated = rows[0];
  } catch (e) {
    // Residual gap: the audit rows above now describe changes that were
    // never actually applied. Documented, and strictly preferable to the
    // case changing with no audit record at all -- see the report for
    // Deferred Fix #1.
    console.error("admin_support_case_update_failed", e.message);
    return corsResponse(request, { error: "update_failed" }, 500);
  }

  const people = await fetchProfilesById([updated.user_id, updated.created_by, updated.assigned_to], env);
  return corsResponse(request, mapCaseRow(updated, people));
}

// POST /api/admin/support-cases/notes -- add an internal note. Body: {caseId, note}
async function handleAdminSupportCaseAddNote(request, env) {
  const admin = await requireAdmin(request, env, { roles: SUPPORT_CASE_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);

  let body;
  try { body = await request.json(); } catch { return corsResponse(request, { error: "invalid_body" }, 400); }
  const { caseId, note } = body || {};
  if (!caseId || !note || !String(note).trim()) return corsResponse(request, { error: "missing_fields" }, 400);

  const caseRows = await supabaseGet("support_cases", { id: `eq.${caseId}`, select: "id,user_id" }, env).catch(() => []);
  const caseRow = caseRows?.[0];
  if (!caseRow) return corsResponse(request, { error: "not_found" }, 404);

  // Deferred Fix #1: same explicit-id pattern as case creation -- generated
  // here so the audit row (note content itself is never logged, per Work
  // Order 7 item 5 -- only that a note was added, to which case, by whom)
  // can be written BEFORE the insert.
  const noteId = crypto.randomUUID();

  try {
    await logAdminAction({
      actorUserId: admin.userId, actorRole: admin.role,
      action: "support_case_note_added", targetUserId: caseRow.user_id,
      metadata: { caseId, noteId },
    }, env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  let created;
  try {
    const rows = await supabasePost("support_case_notes", { id: noteId, case_id: caseId, author_id: admin.userId, note: String(note).trim() }, env);
    created = rows[0];
  } catch (e) {
    // Residual gap: the audit row above now describes a note that was
    // never actually created. Documented, and strictly preferable to a
    // created note with no audit record at all -- see the report for
    // Deferred Fix #1.
    console.error("admin_support_case_note_failed", e.message);
    return corsResponse(request, { error: "note_failed" }, 500);
  }

  const people = await fetchProfilesById([created.author_id], env);
  return corsResponse(request, { id: created.id, authorId: created.author_id, authorName: people[created.author_id]?.email ?? null, note: created.note, createdAt: created.created_at }, 201);
}

// GET /api/admin/staff -- active staff roster, for the case-assignment
// picker only (Work Order 7, "Assign/unassign staff where appropriate" --
// unusable without a way to see who's assignable). Scoped to
// SUPPORT_CASE_ROLES, same as the rest of this module; not a general staff-
// management endpoint (no create/edit/revoke here -- that's explicitly
// deferred, same as every other Work Order so far).
async function handleAdminStaffList(request, env) {
  const admin = await requireAdmin(request, env, { roles: SUPPORT_CASE_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);

  const rows = await supabaseGet("staff", { active: "eq.true", select: "user_id,role" }, env).catch(() => []);
  const people = await fetchProfilesById(rows.map((r) => r.user_id), env);
  return corsResponse(request, {
    staff: rows.map((r) => ({ userId: r.user_id, role: r.role, email: people[r.user_id]?.email ?? null, fullName: people[r.user_id]?.fullName ?? null })),
  });
}

// ─── BACK OFFICE: STAFF MANAGEMENT (Work Order 9) ──────────────────────────
// Superadmin-only -- a deliberately narrower gate than every other module's
// (SUPPORT_CASE_ROLES / CUSTOMER_MGMT_ROLES / BILLING_MGMT_ROLES all include
// support or billing_ops alongside superadmin; this one does not), matching
// "Support and billing_ops: no staff-management access" exactly. This is a
// distinct capability from handleAdminStaffList above (Work Order 7's
// support-case assignment picker), which is left completely untouched --
// same role gate and trimmed active-only shape it's always had. Widening
// that endpoint to superadmin-only or to carry these extra fields would
// break the picker for the support role that still legitimately needs it;
// two different consumers with two different trust levels get two
// endpoints, not one endpoint stretched to cover both.
const STAFF_MGMT_ROLES = ["superadmin"];
// Mirrors the `staff` table's own CHECK constraint (staff.role IN (...)) --
// not a new decision, just this endpoint's own copy of an existing one, so
// an invalid role is rejected here with a clean 400 instead of surfacing a
// raw Postgres constraint-violation error.
const STAFF_ROLES = ["support", "billing_ops", "superadmin"];

// GET /api/admin/staff-directory -- full staff roster, active AND inactive
// (a deactivated member has to still be visible to be found and
// reactivated), with exactly the fields Work Order 9 asks for: name/email,
// role, active status, granted date, and last sign-in (via
// fetchLastSignInAt -- the same Admin Users API read handleAdminCustomerDetail
// already does for customers, nothing new). No invitation flow, no
// password/MFA data, no auth tokens or service-role credentials anywhere in
// this response.
async function handleAdminStaffDirectory(request, env) {
  const admin = await requireAdmin(request, env, { roles: STAFF_MGMT_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);

  const rows = await supabaseGet("staff", {
    select: "user_id,role,active,granted_at,revoked_at",
    order: "active.desc,granted_at.desc",
  }, env).catch(() => []);

  const people = await fetchProfilesById(rows.map((r) => r.user_id), env);
  // One Admin Users call per staff row -- same non-bulk API
  // handleAdminCustomerDetail already uses for a single customer, just run
  // for every row here. Staff rosters are inherently small (headcount, not
  // customer volume), so this stays a handful of parallel requests, not a
  // scaling concern the way it would be for a customer-sized table.
  const staff = await Promise.all(rows.map(async (r) => ({
    userId: r.user_id,
    email: people[r.user_id]?.email ?? null,
    fullName: people[r.user_id]?.fullName ?? null,
    role: r.role,
    active: r.active,
    grantedAt: r.granted_at,
    revokedAt: r.revoked_at,
    lastSignInAt: await fetchLastSignInAt(r.user_id, env),
  })));

  return corsResponse(request, { staff });
}

// POST /api/admin/staff/update -- change a staff member's role and/or
// active status. Body: { staffUserId, role?, active? }, either or both --
// same partial-update-plus-diff shape Work Order 7's support-case update
// endpoint already established, reused here rather than inventing a
// separate role-change endpoint and a separate activate/deactivate one.
//
// Two safety rules, enforced before any write, per Work Order 9 section 3:
//   1. Self-lockout: a superadmin can never demote or deactivate their OWN
//      staff row through this endpoint, full stop -- not conditioned on
//      whether they're the last one. "Must not be able to accidentally
//      remove their own access" reads as an absolute rule, not a
//      last-superadmin-only one; another superadmin must make that change
//      for them if it's ever genuinely needed.
//   2. Last-superadmin protection: the last active superadmin can never be
//      demoted or deactivated by anyone, self or otherwise -- checked by
//      counting OTHER active superadmin rows, so there is always at least
//      one account left able to manage staff at all.
// Both checks run only when the request would actually *remove* superadmin
// or active status -- promotions, reactivations, and true no-ops (setting a
// field to the value it already has) are never blocked and never audited.
async function handleAdminStaffUpdate(request, env) {
  const admin = await requireAdmin(request, env, { roles: STAFF_MGMT_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);

  let body;
  try { body = await request.json(); } catch { return corsResponse(request, { error: "invalid_body" }, 400); }
  const targetUserId = body?.staffUserId;
  if (!targetUserId) return corsResponse(request, { error: "missing_staff_user_id" }, 400);
  if ("role" in body && !STAFF_ROLES.includes(body.role)) {
    return corsResponse(request, { error: "invalid_role" }, 400);
  }
  if ("active" in body && typeof body.active !== "boolean") {
    return corsResponse(request, { error: "invalid_active" }, 400);
  }

  const rows = await supabaseGet("staff", { user_id: `eq.${targetUserId}`, select: "user_id,role,active" }, env).catch(() => []);
  const current = rows?.[0];
  if (!current) return corsResponse(request, { error: "not_found" }, 404);

  const changingRole = "role" in body && body.role !== current.role;
  const changingActive = "active" in body && body.active !== current.active;
  const losingSuperadmin = changingRole && current.role === "superadmin" && body.role !== "superadmin";
  const losingActive = changingActive && current.active === true && body.active === false;

  if (losingSuperadmin || losingActive) {
    if (targetUserId === admin.userId) {
      return corsResponse(request, { error: "cannot_modify_own_access" }, 400);
    }
    if (current.role === "superadmin" && current.active === true) {
      const otherActiveSuperadmins = await supabaseGet("staff", {
        role: "eq.superadmin", active: "eq.true", user_id: `neq.${targetUserId}`, select: "user_id", limit: "1",
      }, env).catch(() => []);
      if (otherActiveSuperadmins.length === 0) {
        return corsResponse(request, { error: "cannot_remove_last_superadmin" }, 400);
      }
    }
  }

  if (!changingRole && !changingActive) {
    // True no-op: return the unchanged row, write nothing, audit nothing.
    const people = await fetchProfilesById([targetUserId], env);
    return corsResponse(request, {
      userId: targetUserId, role: current.role, active: current.active,
      email: people[targetUserId]?.email ?? null, fullName: people[targetUserId]?.fullName ?? null,
    });
  }

  const patch = {};
  const events = [];
  if (changingRole) {
    patch.role = body.role;
    events.push({ action: "staff_role_changed", metadata: { from: current.role, to: body.role } });
  }
  if (changingActive) {
    patch.active = body.active;
    // revoked_at mirrors granted_at's own semantics -- set on deactivation,
    // cleared on reactivation. Existing column, no new schema.
    patch.revoked_at = body.active ? null : new Date().toISOString();
    events.push({ action: body.active ? "staff_reactivated" : "staff_deactivated", metadata: {} });
  }

  // Deferred Fix #1: one audit row per changed dimension (role vs. active
  // are independent facts, same reasoning as Work Order 7's case-update
  // audit splitting), written as ONE batched INSERT (logAdminActions) --
  // atomic at the Postgres level, and written BEFORE the staff-table patch
  // so a failure here now always means nothing changed; the 500 below is
  // accurate. Metadata carries only role names / nothing, never any
  // customer or credential data.
  try {
    await logAdminActions(events.map((evt) => ({
      actorUserId: admin.userId,
      actorRole: admin.role,
      action: evt.action,
      targetUserId,
      metadata: evt.metadata,
    })), env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  // Residual gap, same as every other handler touched by Deferred Fix #1:
  // if this patch itself fails, the audit rows above describe a change
  // that was never actually applied. Documented, and strictly preferable
  // to a staff role/access change with no audit record at all.
  const [updated] = await supabasePatch("staff", { user_id: `eq.${targetUserId}` }, patch, env);

  const people = await fetchProfilesById([targetUserId], env);
  return corsResponse(request, {
    userId: targetUserId, role: updated.role, active: updated.active,
    email: people[targetUserId]?.email ?? null, fullName: people[targetUserId]?.fullName ?? null,
  });
}

// ─── BACK OFFICE: STAFF INVITATION (Work Order) ────────────────────────────
// Replaces the manual "create a row directly in the staff table" process.
// Verified directly against the live Supabase project before building this:
//   - POST /auth/v1/admin/generate_link (type: "invite") is the real,
//     documented mechanism -- it creates the auth.users row itself and
//     returns a single-use hashed_token; no password is ever created or
//     handled here or by the invitee.
//   - Redeeming it is the exact same redirect-free pattern already proven
//     for True Customer Impersonation: POST /auth/v1/verify with
//     { type: "invite", token_hash }, called client-side by the Back
//     Office app itself -- never a redirect link, so this has no
//     dependency on the project's configured redirect allow-list at all.
//   - The resulting session's JWT carries amr = [{method:"otp"}] -- the
//     SAME signature True Customer Impersonation uses to block customer
//     mutations. handleAcceptStaffInvitation below explicitly passes
//     isAdminCall: true to requireAuth() for exactly this reason: accepting
//     an invitation is an admin/staff-onboarding action, not a customer
//     path, and would otherwise be incorrectly blocked by that gate.
//   - Inviting an email that already has an account fails cleanly with
//     Supabase's own email_exists error -- promoting an existing customer
//     to staff is a distinct scenario with its own unresolved policy
//     questions (should their customer data/subscription be affected?)
//     and is deliberately out of scope here; that request is rejected with
//     a clear, distinct error rather than an invented behavior.
//
// A pending invitation is deliberately NOT a `staff` row (requirement: "a
// pending invitation must not grant Back Office access before
// acceptance") -- requireAdmin() requires an active staff row to exist at
// all, so as long as none exists, there is no access, full stop. Pending
// invitations live in KV (SUBSCRIPTION_CACHE), the same reusable,
// naturally-time-limited (TTL) mechanism True Customer Impersonation's
// grant already established -- no new table, no new columns. The `staff`
// row is created for the first time only inside handleAcceptStaffInvitation,
// once a redeemed session proves the invitee holds the actual token.
const STAFF_INVITATION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
function invitationKvKey(userId) {
  return `invitation:${userId}`;
}

// POST /api/admin/staff/invite -- body { email, role }.
async function handleAdminStaffInvite(request, env) {
  const admin = await requireAdmin(request, env, { roles: STAFF_MGMT_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return corsResponse(request, { error: "not_configured" }, 503);
  let body;
  try { body = await request.json(); } catch { return corsResponse(request, { error: "invalid_body" }, 400); }
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const role = body?.role;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return corsResponse(request, { error: "invalid_email" }, 400);
  if (!STAFF_ROLES.includes(role)) return corsResponse(request, { error: "invalid_role" }, 400);

  // generate_link both creates the auth.users row AND returns the
  // redeemable token in one call -- the invited user's id isn't known
  // until this succeeds, so it's unavoidably the first step here (unlike
  // every other fail-closed mutation in this file, which audits before
  // its one mutation runs). If the audit write below then fails, the
  // invitee is left with an unconfirmed auth.users row and no KV entry --
  // harmless (accept-invite requires the KV entry to exist) but real
  // enough to flag as the same kind of residual ordering gap already
  // documented elsewhere.
  let inviteUserId, hashedToken;
  try {
    const genRes = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: sbHeaders(env),
      body: JSON.stringify({ type: "invite", email }),
    });
    const genBody = await genRes.json();
    if (!genRes.ok) {
      if (genBody?.error_code === "email_exists") return corsResponse(request, { error: "email_already_registered" }, 409);
      throw new Error(`generate_link_${genRes.status}`);
    }
    inviteUserId = genBody.id;
    hashedToken = genBody.hashed_token;
    if (!inviteUserId || !hashedToken) throw new Error("generate_link_missing_fields");
  } catch (e) {
    console.error("admin_staff_invite_link_failed", e.message);
    return corsResponse(request, { error: "invitation_failed" }, 502);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + STAFF_INVITATION_TTL_SECONDS * 1000).toISOString();

  try {
    await logAdminAction({
      actorUserId: admin.userId, actorRole: admin.role,
      action: "staff_invitation_sent", targetUserId: inviteUserId,
      metadata: { email, role, expiresAt },
    }, env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  const invitation = { email, role, invitedBy: admin.userId, invitedAt: now.toISOString(), expiresAt };
  try {
    await env.SUBSCRIPTION_CACHE.put(invitationKvKey(inviteUserId), JSON.stringify(invitation), { expirationTtl: STAFF_INVITATION_TTL_SECONDS });
  } catch (e) {
    console.error("admin_staff_invite_grant_failed", e.message);
    return corsResponse(request, { error: "grant_failed" }, 500);
  }

  // hashedToken is handed back once, to the superadmin who just requested
  // it -- they construct the acceptance link and relay it to the new hire
  // through whatever channel is appropriate. It's never logged, never
  // stored server-side beyond the KV entry above (which doesn't include
  // it), and is single-use regardless.
  return corsResponse(request, { userId: inviteUserId, email, role, expiresAt, hashedToken });
}

// GET /api/admin/staff/invitations -- list pending (not yet accepted)
// invitations. KV list() plus a defensive expiresAt filter (belt-and-
// suspenders against any brief eventual-consistency lag right at TTL
// expiry -- real expiry is enforced by the KV TTL itself regardless).
async function handleAdminStaffInvitationsList(request, env) {
  const admin = await requireAdmin(request, env, { roles: STAFF_MGMT_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);

  const listResult = await env.SUBSCRIPTION_CACHE.list({ prefix: "invitation:" }).catch(() => ({ keys: [] }));
  const now = Date.now();
  const invitations = [];
  for (const { name } of listResult.keys) {
    const raw = await env.SUBSCRIPTION_CACHE.get(name, "json").catch(() => null);
    if (!raw) continue;
    if (new Date(raw.expiresAt).getTime() <= now) continue;
    invitations.push({ userId: name.slice("invitation:".length), ...raw });
  }

  const inviterIds = invitations.map((i) => i.invitedBy);
  const people = await fetchProfilesById(inviterIds, env);
  return corsResponse(request, {
    invitations: invitations.map((i) => ({
      userId: i.userId, email: i.email, role: i.role,
      invitedAt: i.invitedAt, expiresAt: i.expiresAt,
      invitedBy: i.invitedBy, invitedByName: people[i.invitedBy]?.fullName ?? people[i.invitedBy]?.email ?? null,
    })),
  });
}

// POST /api/admin/staff/invite/revoke -- body { userId }.
async function handleAdminStaffInvitationRevoke(request, env) {
  const admin = await requireAdmin(request, env, { roles: STAFF_MGMT_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);
  let body;
  try { body = await request.json(); } catch { return corsResponse(request, { error: "invalid_body" }, 400); }
  const targetId = body?.userId;
  if (!targetId) return corsResponse(request, { error: "missing_user_id" }, 400);

  const invitation = await env.SUBSCRIPTION_CACHE.get(invitationKvKey(targetId), "json").catch(() => null);
  if (!invitation) return corsResponse(request, { error: "not_found" }, 404);

  try {
    await logAdminAction({
      actorUserId: admin.userId, actorRole: admin.role,
      action: "staff_invitation_revoked", targetUserId: targetId,
      metadata: { email: invitation.email, role: invitation.role },
    }, env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  await env.SUBSCRIPTION_CACHE.delete(invitationKvKey(targetId)).catch(() => {});
  // Best-effort: also remove the unconfirmed auth.users row generate_link
  // created, so a revoked invitation leaves nothing behind at all. Not
  // fatal if this fails -- the KV entry above (the actual authorization
  // gate for accept-invite) is already gone, which is what actually matters.
  try {
    await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${targetId}`, { method: "DELETE", headers: sbHeaders(env) });
  } catch (e) {
    console.error("admin_staff_invite_revoke_cleanup_failed", e.message);
  }

  return corsResponse(request, { success: true });
}

// POST /api/admin/staff/accept-invite -- called by the INVITEE, not an
// existing staff member (they have none of the required staff row yet, by
// design). Deliberately uses requireAuth() directly, not requireAdmin(),
// with isAdminCall: true so a fresh invite-derived session (amr=[otp]) is
// exempt from True Customer Impersonation's customer-mutation gate -- this
// is a staff-onboarding action, not a customer path. The KV invitation
// entry (not the JWT, not anything the client can forge) is the actual
// authorization: only a user_id with a real, matching, unexpired pending
// invitation can ever succeed here, so a random authenticated customer
// account can't self-grant staff access by simply calling this endpoint.
async function handleAcceptStaffInvitation(request, env) {
  const auth = await requireAuth(request, env, { allowDeletionLocked: true, isAdminCall: true });
  if (!auth.ok) return corsResponse(request, { error: auth.error }, auth.status);

  const invitation = await env.SUBSCRIPTION_CACHE.get(invitationKvKey(auth.userId), "json").catch(() => null);
  if (!invitation || new Date(invitation.expiresAt).getTime() <= Date.now()) {
    return corsResponse(request, { error: "no_pending_invitation" }, 400);
  }

  const existingStaff = await supabaseGet("staff", { user_id: `eq.${auth.userId}`, select: "user_id" }, env).catch(() => []);
  if (existingStaff?.[0]) return corsResponse(request, { error: "already_staff" }, 400);

  // Audit-before-mutation: if this write fails, no staff row exists yet,
  // so the 500 below is accurate.
  try {
    await logAdminAction({
      actorUserId: auth.userId, actorRole: invitation.role,
      action: "staff_invitation_accepted", targetUserId: auth.userId,
      metadata: { role: invitation.role },
    }, env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  try {
    await supabasePost("staff", {
      user_id: auth.userId, role: invitation.role, granted_by: invitation.invitedBy, active: true,
    }, env);
  } catch (e) {
    console.error("admin_staff_invite_accept_failed", e.message);
    return corsResponse(request, { error: "accept_failed" }, 502);
  }

  await env.SUBSCRIPTION_CACHE.delete(invitationKvKey(auth.userId)).catch(() => {});
  return corsResponse(request, { success: true, role: invitation.role });
}

// ─── BACK OFFICE: SYSTEM HEALTH (Work Order 10) ────────────────────────────
// Every active staff role can see this (support/billing_ops/superadmin) --
// no role restriction passed to requireAdmin, unlike every other module.
// Operational status is not sensitive the way customer or billing data is,
// and any staff member troubleshooting a report benefits from being able to
// check it themselves. No audit logging here, by explicit instruction --
// this is an aggregate operational read, the same precedent the dashboard
// (Work Order 6) already established for itself.
//
// "Worker" health is not actually probed -- the fact that this handler is
// running at all, in the same request that will return this response, IS
// the proof the Worker is up. Database and KV reuse checkSupabaseHealth()/
// checkKvHealth() (now also shared with handleHealth and the dashboard,
// since the Fix KV Health Reporting work order). Stripe gets its only real
// connectivity check anywhere in this file (see checkStripeHealth above) --
// unchanged by that work order, which touched only handleHealth and the
// dashboard's systemHealth section.
function computeOverallHealthStatus(checks) {
  const critical = [checks.worker.status, checks.database.status];
  const secondary = [checks.kv.status, checks.stripe.status];
  if (critical.includes("unavailable")) return "unavailable";
  if (critical.includes("degraded") || secondary.includes("unavailable") || secondary.includes("degraded")) return "degraded";
  return "healthy";
}

async function handleAdminSystemHealth(request, env) {
  const admin = await requireAdmin(request, env); // any active staff role
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);

  const [db, kv, stripe] = await Promise.all([
    checkSupabaseHealth(env),
    checkKvHealth(env),
    checkStripeHealth(env),
  ]);

  // KV and Stripe outages degrade the product (both have existing,
  // documented fallback/error-handling paths elsewhere -- getSubscription()
  // falls back to Supabase when KV is unavailable, and billing views
  // already handle a Stripe outage as stripeError rather than crashing)
  // rather than taking it down entirely, so they can only ever push the
  // overall status to "degraded", never "unavailable" -- that's reserved
  // for the Worker or the database itself being unreachable.
  const checks = {
    worker: { status: "healthy" },
    database: !db.configured
      ? { status: "unavailable", detail: "not_configured" }
      : db.ok ? { status: "healthy" } : { status: "unavailable", detail: "connectivity_error" },
    kv: kv.ok ? { status: "healthy" } : { status: "unavailable", detail: "connectivity_error" },
    stripe: !stripe.configured
      ? { status: "unavailable", detail: "not_configured" }
      : stripe.ok ? { status: "healthy" } : { status: "unavailable", detail: stripe.code || "connectivity_error" },
  };

  return corsResponse(request, {
    status: computeOverallHealthStatus(checks),
    checkedAt: new Date().toISOString(),
    checks,
  });
}

// ─── AI USAGE & COST: DAILY HISTORICAL AGGREGATION ─────────────────────────
// Replaces the pg_cron job usage_daily_summary was designed around
// (billing-daily-usage-aggregation, re-scheduled by
// 20260905010000_ai_usage_historical_retention.sql) -- confirmed live that
// pg_cron isn't available on this Supabase tier, so that job has never
// actually executed. Same source/target tables, same daily 00:15 UTC
// timing, same "sum yesterday's ai_request_log rows, upsert into
// usage_daily_summary" shape -- just run by the Worker's own Cron Trigger
// instead of Postgres's scheduler, through the exact same service-role path
// every other scheduled job in this file already uses. No new endpoint, no
// credentials exposed anywhere a request could reach them.
//
// Idempotent by construction, not by accident: each run recomputes the
// FULL previous UTC day's totals from ai_request_log (immutable once
// written -- nothing ever updates a row after logAIRequest inserts it) and
// upserts via supabaseUpsert's existing resolution=merge-duplicates Prefer
// header, which REPLACES the conflicting row's columns outright rather than
// incrementing them. Running this twice for the same day recomputes and
// writes the identical numbers both times -- never doubled.
async function runAiUsageDailyAggregation(env) {
  const now = new Date();
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const yesterdayUTC = new Date(todayUTC.getTime() - 86400000);
  const summaryDate = yesterdayUTC.toISOString().slice(0, 10);

  // A closed date range needs two `created_at` filters (gte + lt) --
  // supabaseGet's flat params object can only hold one value per key (a
  // second entry would just overwrite the first), so this one query is
  // built directly instead of stretching that helper for a shape nothing
  // else in the file needs.
  const url = new URL(`${env.SUPABASE_URL}/rest/v1/ai_request_log`);
  url.searchParams.set("select", "user_id,feature,tokens_in,tokens_out,success,latency_ms,cost_usd");
  url.searchParams.append("created_at", `gte.${yesterdayUTC.toISOString()}`);
  url.searchParams.append("created_at", `lt.${todayUTC.toISOString()}`);
  url.searchParams.set("limit", "50000"); // one day's volume, comfortably above PostgREST's 1000-row default cap
  const r = await fetch(url.toString(), { headers: sbHeaders(env) });
  if (!r.ok) throw new Error(`ai_usage_aggregation_fetch_${r.status}`);
  const rows = await r.json();

  const buckets = new Map(); // `${user_id} ${feature}` -> running aggregate for summaryDate
  for (const row of rows) {
    const key = `${row.user_id} ${row.feature}`;
    const b = buckets.get(key) || {
      user_id: row.user_id, summary_date: summaryDate, feature: row.feature,
      request_count: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, error_count: 0, latency_sum_ms: 0,
    };
    b.request_count++;
    b.tokens_in += row.tokens_in || 0;
    b.tokens_out += row.tokens_out || 0;
    b.cost_usd += row.cost_usd || 0;
    if (!row.success) b.error_count++;
    b.latency_sum_ms += row.latency_ms || 0;
    buckets.set(key, b);
  }

  const summaryRows = [...buckets.values()];
  if (summaryRows.length > 0) await supabaseUpsert("usage_daily_summary", summaryRows, "user_id,summary_date,feature", env);
  return { summaryDate, buckets: summaryRows.length, sourceRows: rows.length };
}

// ─── BACK OFFICE: AI USAGE & COST ──────────────────────────────────────────
// billing_ops/superadmin only, matching the existing BILLING_MGMT_ROLES --
// this is company AI spend, the same sensitivity class as the Stripe revenue
// billing_ops/superadmin already see elsewhere; support does not get it,
// same precedent as every other billing-adjacent view.
//
// Two sources, one per period, never blended in the same response:
//   - today/7d/30d: raw ai_request_log -- all three comfortably inside its
//     90-day retention, more precise (per-request latency, so p95 is real).
//   - 90d: usage_daily_summary -- the permanent aggregate (correction:
//     ai_request_log's 90-day TTL cleanup would otherwise silently lose
//     cost/error/latency history; usage_daily_summary now rolls those up
//     nightly, see 20260905010000_ai_usage_historical_retention.sql, and
//     survives the cleanup). p95 latency is NOT reconstructable from a daily
//     sum, so it's reported as null for this period rather than guessed.
// Both sources are normalized to the same intermediate shape so byFeature/
// byUser/byPlan/totals are computed by one shared reducer regardless of
// which table answered the query -- no duplicated aggregation logic.
const AI_USAGE_WINDOW_DAYS = { today: 1, "7d": 7, "30d": 30, "90d": 90 };
const AI_USAGE_HISTORICAL_PERIODS = new Set(["90d"]);

function planForStatus(subscriptionStatus) {
  return BILLING_STATE_PLAN[computeBillingState({ subscription_status: subscriptionStatus })] ?? "Free";
}

// Reporting-only grouping layer (Full AI Call-Site Audit work order). Maps
// every one of the 18 feature tags actually written to ai_request_log/
// usage_daily_summary into one of 11 product-level groups, verified against
// the audit's 38 call sites (each call site's tag appears in exactly one
// group below -- no tag, and therefore no call site, is unmapped or double
// counted). Does not touch quota/entitlement logic anywhere -- getFeatureLimit
// and the three Layer 1b/1c/1d gates in handleClaude are untouched; this is
// purely how the Back Office reads the SAME already-logged rows back.
//
//   Resume Intelligence            resume_analysis, resume_analysis_followup
//                                   (12 call sites: ATS analysis, Deep Insights,
//                                   Cover Letter, Score Benchmark, Job Fit,
//                                   AI Resume Builder, apply-fix x2, improve,
//                                   re-score, image OCR upload)
//   Interview Intelligence         interview_prep, interview_prep_followup
//                                   (3 call sites: generate questions,
//                                   per-answer feedback, mock summary)
//   Networking Intelligence        networking_outreach
//                                   (2 call sites: initial message, follow-up)
//   Market & Opportunity           salary_analysis, job_intelligence,
//     Intelligence                 opportunity_intelligence (3 call sites)
//   Smart Apply & Job Tracking     smart_apply, job_tracker_change,
//                                   job_change_analysis (5 call sites: manual
//                                   generate/retry/prepare + the two job-change
//                                   tags neither has a dedicated quota case).
//                                   Deliberately excludes smart_apply_auto_prep
//                                   (kept separate below -- distinct scheduled
//                                   flagship feature, not a manual action).
//   Career Guidance & Coaching     ai_request (4 call sites: Daily Briefing,
//                                   Action Plan, Career Progress, AI Career
//                                   Coach chat -- every one of these omits a
//                                   feature tag and falls to the default).
//   LinkedIn Intelligence          linkedin_intelligence,
//                                   linkedin_intelligence_premium (3 call sites)
//   Outcome Intelligence           outcome_intelligence (1 call site)
//   Referral Intelligence          referral_intelligence (1 call site)
//   Proactive Job Alerts           proactive_job_alerts (3 call sites: Critical
//                                   Opportunity, Watchlist Activity, Weekly)
//   Smart Apply Auto Prep          smart_apply_auto_prep (1 call site)
//
// 12 + 3 + 2 + 3 + 5 + 4 + 3 + 1 + 1 + 3 + 1 = 38, matching the audit total
// exactly. Any tag NOT in this map (none exist today -- `feature` is
// client-supplied and unvalidated, see handleClaude) falls into "other"
// rather than being silently dropped, so a future/unexpected tag still shows
// up with its real cost instead of vanishing from the report.
const AI_FEATURE_TAG_TO_GROUP = {
  resume_analysis: "resume_intelligence",
  resume_analysis_followup: "resume_intelligence",
  interview_prep: "interview_intelligence",
  interview_prep_followup: "interview_intelligence",
  networking_outreach: "networking_intelligence",
  salary_analysis: "market_opportunity_intelligence",
  job_intelligence: "market_opportunity_intelligence",
  opportunity_intelligence: "market_opportunity_intelligence",
  smart_apply: "smart_apply_job_tracking",
  job_tracker_change: "smart_apply_job_tracking",
  job_change_analysis: "smart_apply_job_tracking",
  ai_request: "career_guidance_coaching",
  linkedin_intelligence: "linkedin_intelligence",
  linkedin_intelligence_premium: "linkedin_intelligence",
  outcome_intelligence: "outcome_intelligence",
  referral_intelligence: "referral_intelligence",
  proactive_job_alerts: "proactive_job_alerts",
  smart_apply_auto_prep: "smart_apply_auto_prep",
};

const AI_FEATURE_GROUP_LABELS = {
  resume_intelligence: "Resume Intelligence",
  interview_intelligence: "Interview Intelligence",
  networking_intelligence: "Networking Intelligence",
  market_opportunity_intelligence: "Market & Opportunity Intelligence",
  smart_apply_job_tracking: "Smart Apply & Job Tracking",
  career_guidance_coaching: "Career Guidance & Coaching",
  linkedin_intelligence: "LinkedIn Intelligence",
  outcome_intelligence: "Outcome Intelligence",
  referral_intelligence: "Referral Intelligence",
  proactive_job_alerts: "Proactive Job Alerts",
  smart_apply_auto_prep: "Smart Apply Auto Prep",
  other: "Other / Unclassified",
};

function normalizeAiRequestLogRow(row) {
  return {
    userId: row.user_id, feature: row.feature,
    requests: 1, tokensIn: row.tokens_in || 0, tokensOut: row.tokens_out || 0,
    costUsd: row.cost_usd || 0, errorCount: row.success ? 0 : 1,
    latencySumMs: row.latency_ms != null ? row.latency_ms : 0,
    latencyCount: row.latency_ms != null ? 1 : 0,
    rawLatencyMs: row.latency_ms, // only individual rows can feed a percentile
  };
}

function normalizeUsageDailySummaryRow(row) {
  return {
    userId: row.user_id, feature: row.feature,
    requests: row.request_count || 0, tokensIn: row.tokens_in || 0, tokensOut: row.tokens_out || 0,
    costUsd: row.cost_usd || 0, errorCount: row.error_count || 0,
    latencySumMs: row.latency_sum_ms || 0,
    latencyCount: row.request_count || 0, // every logged call carries a latency_ms, so request_count is the right denominator for this day's average
    rawLatencyMs: null, // a daily sum has no per-request distribution -- no percentile from this source, by design
  };
}

function aggregateAiUsageRows(normalizedRows) {
  const totals = { requests: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, errorCount: 0, latencySumMs: 0, latencyCount: 0 };
  const byFeature = new Map();
  const byUser = new Map();
  const latencies = [];

  for (const r of normalizedRows) {
    totals.requests += r.requests; totals.tokensIn += r.tokensIn; totals.tokensOut += r.tokensOut;
    totals.costUsd += r.costUsd; totals.errorCount += r.errorCount;
    totals.latencySumMs += r.latencySumMs; totals.latencyCount += r.latencyCount;
    if (r.rawLatencyMs != null) latencies.push(r.rawLatencyMs);

    const f = byFeature.get(r.feature) || { feature: r.feature, requests: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, errorCount: 0 };
    f.requests += r.requests; f.tokensIn += r.tokensIn; f.tokensOut += r.tokensOut; f.costUsd += r.costUsd; f.errorCount += r.errorCount;
    byFeature.set(r.feature, f);

    const u = byUser.get(r.userId) || { userId: r.userId, requests: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };
    u.requests += r.requests; u.tokensIn += r.tokensIn; u.tokensOut += r.tokensOut; u.costUsd += r.costUsd;
    byUser.set(r.userId, u);
  }

  latencies.sort((a, b) => a - b);
  // Only meaningful when every contributing row had a real percentile-eligible
  // latency (i.e. the raw ai_request_log path) -- see normalizeUsageDailySummaryRow.
  const p95LatencyMs = latencies.length === totals.latencyCount && latencies.length
    ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]
    : null;

  // Group rollup, built from byFeature (not a second pass over normalizedRows)
  // so a group's totals are always exactly the sum of its own children --
  // trivially verifiable, never a separately-accumulated number that could
  // drift from the per-feature figures the admin can already see today.
  const byGroup = new Map();
  for (const f of byFeature.values()) {
    const groupId = AI_FEATURE_TAG_TO_GROUP[f.feature] || "other";
    const g = byGroup.get(groupId) || {
      groupId, groupLabel: AI_FEATURE_GROUP_LABELS[groupId] || AI_FEATURE_GROUP_LABELS.other,
      requests: 0, tokensIn: 0, tokensOut: 0, tokensTotal: 0, costUsd: 0, children: [],
    };
    g.requests += f.requests;
    g.tokensIn += f.tokensIn;
    g.tokensOut += f.tokensOut;
    g.tokensTotal += f.tokensIn + f.tokensOut;
    g.costUsd += f.costUsd; // real logged cost only -- rows with no cost data contribute 0, never estimated
    g.children.push({
      feature: f.feature,
      requests: f.requests, tokensIn: f.tokensIn, tokensOut: f.tokensOut,
      tokensTotal: f.tokensIn + f.tokensOut, costUsd: f.costUsd,
    });
    byGroup.set(groupId, g);
  }
  for (const g of byGroup.values()) g.children.sort((a, b) => b.costUsd - a.costUsd);

  return { totals, byFeature, byUser, byGroup, p95LatencyMs };
}

async function handleAdminAiUsage(request, env) {
  const admin = await requireAdmin(request, env, { roles: BILLING_MGMT_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);

  const url = new URL(request.url);
  const requestedPeriod = url.searchParams.get("period");
  const period = AI_USAGE_WINDOW_DAYS[requestedPeriod] ? requestedPeriod : "30d";
  const isHistorical = AI_USAGE_HISTORICAL_PERIODS.has(period);

  let normalizedRows, truncated;
  if (isHistorical) {
    // usage_daily_summary has no per-row created_at -- summary_date is a
    // plain DATE, so the cutoff is computed the same way, just compared to
    // a date instead of a timestamp.
    const sinceDate = new Date(Date.now() - AI_USAGE_WINDOW_DAYS[period] * 86400000).toISOString().slice(0, 10);
    const { rows, total } = await supabaseGetWithCount("usage_daily_summary", {
      select: "user_id,feature,request_count,tokens_in,tokens_out,cost_usd,error_count,latency_sum_ms,summary_date",
      summary_date: `gte.${sinceDate}`,
      order: "summary_date.desc",
      limit: "5000",
    }, env);
    normalizedRows = rows.map(normalizeUsageDailySummaryRow);
    truncated = total > rows.length;
  } else {
    const since = new Date(Date.now() - AI_USAGE_WINDOW_DAYS[period] * 86400000).toISOString();
    const { rows, total } = await supabaseGetWithCount("ai_request_log", {
      select: "user_id,feature,model,tokens_in,tokens_out,success,error_code,latency_ms,cost_usd,created_at",
      created_at: `gte.${since}`,
      order: "created_at.desc",
      limit: "5000",
    }, env);
    normalizedRows = rows.map(normalizeAiRequestLogRow);
    truncated = total > rows.length;
  }

  const { totals, byFeature, byUser, byGroup, p95LatencyMs } = aggregateAiUsageRows(normalizedRows);

  // Top 20 by cost -- the operationally useful cut (who's actually driving
  // spend), not a full per-user list (Customer Management already covers
  // browsing every customer).
  const topUsers = [...byUser.values()].sort((a, b) => b.costUsd - a.costUsd).slice(0, 20);
  const people = await fetchProfilesById(topUsers.map((u) => u.userId), env);

  // Plan breakdown needs every distinct user in the window, not just the
  // cost-ranked top 20 -- a low-cost-but-frequent Free-plan caller shouldn't
  // be invisible from the plan-level view just because they're not a top
  // spender individually.
  const allUserIds = [...byUser.keys()];
  const profileRows = allUserIds.length
    ? await supabaseGet("profiles", { id: `in.(${allUserIds.join(",")})`, select: "id,subscription_status" }, env).catch(() => [])
    : [];
  const planByUserId = Object.fromEntries(profileRows.map((p) => [p.id, planForStatus(p.subscription_status)]));
  const byPlan = new Map();
  for (const u of byUser.values()) {
    const plan = planByUserId[u.userId] || "Free";
    const p = byPlan.get(plan) || { plan, requests: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };
    p.requests += u.requests; p.tokensIn += u.tokensIn; p.tokensOut += u.tokensOut; p.costUsd += u.costUsd;
    byPlan.set(plan, p);
  }

  return corsResponse(request, {
    period,
    source: isHistorical ? "usage_daily_summary" : "ai_request_log",
    truncated,
    totals: {
      requests: totals.requests,
      tokensIn: totals.tokensIn, tokensOut: totals.tokensOut, tokensTotal: totals.tokensIn + totals.tokensOut,
      costUsd: totals.costUsd,
      errorCount: totals.errorCount,
      errorRate: totals.requests ? totals.errorCount / totals.requests : 0,
      avgLatencyMs: totals.latencyCount ? Math.round(totals.latencySumMs / totals.latencyCount) : null,
      p95LatencyMs,
    },
    byFeature: [...byFeature.values()].sort((a, b) => b.costUsd - a.costUsd),
    byCustomer: topUsers.map((u) => ({ ...u, email: people[u.userId]?.email ?? null, fullName: people[u.userId]?.fullName ?? null })),
    byPlan: [...byPlan.values()].sort((a, b) => b.costUsd - a.costUsd),
    // Additive only -- byFeature/byCustomer/byPlan/totals above are byte-for-byte
    // unchanged from before this work order, so the existing admin frontend
    // keeps working without modification. byGroup is new: the same per-feature
    // figures already in byFeature, organized into the 11 product-level groups
    // with each group's own feature-tag children (the finest resolution
    // ai_request_log/usage_daily_summary can distinguish -- several call
    // sites intentionally share one feature tag today, see the audit).
    byGroup: [...byGroup.values()].sort((a, b) => b.costUsd - a.costUsd),
  });
}

// ─── BACK OFFICE: HIGH-RISK CUSTOMER OPERATIONS (Work Order 6) ─────────────
// Every operation here is superadmin-only except billing-portal-link
// generation (see BILLING_MGMT_ROLES below it, matching the existing
// billing-view tier -- it never touches card data or changes anything, so
// it doesn't need the same gate as the genuinely destructive/financial
// actions). Deliberately a single, separate, narrower constant from every
// other module's role list -- these are the highest-blast-radius actions
// in the whole Back Office, and support/billing_ops get none of them.
const HIGH_RISK_ROLES = ["superadmin"];

// ─── 1. Refunds ─────────────────────────────────────────────────────────
// Reuses the exact Stripe refund primitive (POST /v1/refunds) against a
// charge id the caller already saw via GET /api/admin/customers/billing --
// no new Stripe wiring. `amount` is optional (full refund of the charge if
// omitted); Stripe itself rejects an amount that exceeds what's actually
// refundable, so that validation isn't duplicated here. `caseId` is
// optional free-form traceability (a support case id, if this refund was
// discussed there) -- not enforced, since inventing a mandatory linkage
// policy wasn't asked for.
async function handleAdminRefund(request, env) {
  const admin = await requireAdmin(request, env, { roles: HIGH_RISK_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);
  if (!env.STRIPE_SECRET_KEY) return corsResponse(request, { error: "stripe_not_configured" }, 503);

  let body;
  try { body = await request.json(); } catch { return corsResponse(request, { error: "invalid_body" }, 400); }
  const targetId = body?.userId;
  const chargeId = body?.chargeId;
  if (!targetId || !chargeId) return corsResponse(request, { error: "missing_fields" }, 400);
  const amount = body?.amount;
  if (amount != null && (!Number.isInteger(amount) || amount <= 0)) {
    return corsResponse(request, { error: "invalid_amount" }, 400);
  }
  const reason = ["duplicate", "fraudulent", "requested_by_customer"].includes(body?.reason) ? body.reason : undefined;
  const caseId = typeof body?.caseId === "string" && body.caseId ? body.caseId : null;

  const profileRows = await supabaseGet("profiles", { id: `eq.${targetId}`, select: "id,stripe_customer_id" }, env).catch(() => []);
  const profile = profileRows?.[0];
  if (!profile) return corsResponse(request, { error: "not_found" }, 404);
  if (!profile.stripe_customer_id) return corsResponse(request, { error: "no_stripe_customer" }, 400);

  // Confirm the charge actually belongs to this customer before refunding
  // it -- prevents a chargeId typo or mismatch from refunding a different
  // customer's payment.
  let charge;
  try {
    charge = await stripeRequest("GET", `/charges/${chargeId}`, null, env);
  } catch (_) {
    return corsResponse(request, { error: "charge_not_found" }, 404);
  }
  if (charge.customer !== profile.stripe_customer_id) {
    return corsResponse(request, { error: "charge_customer_mismatch" }, 400);
  }

  // Audit-before-mutation (same pattern as every fail-closed admin mutation
  // in this file since Deferred Fix #1): if this write fails, no refund has
  // been issued yet, so the 500 below is accurate.
  try {
    await logAdminAction({
      actorUserId: admin.userId, actorRole: admin.role,
      action: "customer_refund_issued", targetUserId: targetId,
      metadata: { chargeId, amount: amount ?? charge.amount, currency: charge.currency, reason: reason ?? null, caseId },
    }, env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  let refund;
  try {
    const refundBody = { charge: chargeId };
    if (amount != null) refundBody.amount = String(amount);
    if (reason) refundBody.reason = reason;
    refund = await stripeRequest("POST", "/refunds", refundBody, env);
  } catch (e) {
    // Never the raw Stripe error message -- e.stripeCode is Stripe's own
    // stable, non-sensitive error enum.
    console.error("admin_refund_failed", e.message);
    return corsResponse(request, { error: "refund_failed", detail: e.stripeCode || null }, 502);
  }

  return corsResponse(request, { success: true, refundId: refund.id, amount: refund.amount, currency: refund.currency, status: refund.status });
}

// ─── 2. Subscription / plan changes on a customer's behalf ────────────────
// All three reuse the exact shared functions the customer's own self-
// service endpoints call (cancelSubscriptionForUser / resumeSubscriptionForUser
// / changePlanForUser, extracted above) -- no separate Stripe logic.
async function handleAdminSubscriptionCancel(request, env) {
  const admin = await requireAdmin(request, env, { roles: HIGH_RISK_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);
  let body;
  try { body = await request.json(); } catch { return corsResponse(request, { error: "invalid_body" }, 400); }
  const targetId = body?.userId;
  if (!targetId) return corsResponse(request, { error: "missing_user_id" }, 400);
  const existing = await supabaseGet("profiles", { id: `eq.${targetId}`, select: "id" }, env).catch(() => []);
  if (!existing?.[0]) return corsResponse(request, { error: "not_found" }, 404);

  try {
    await logAdminAction({ actorUserId: admin.userId, actorRole: admin.role, action: "customer_subscription_cancelled_by_staff", targetUserId: targetId }, env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  const result = await cancelSubscriptionForUser(targetId, env);
  if (!result.ok) return corsResponse(request, { error: result.error }, result.status);
  return corsResponse(request, { success: true, ...result.data });
}

async function handleAdminSubscriptionResume(request, env) {
  const admin = await requireAdmin(request, env, { roles: HIGH_RISK_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);
  let body;
  try { body = await request.json(); } catch { return corsResponse(request, { error: "invalid_body" }, 400); }
  const targetId = body?.userId;
  if (!targetId) return corsResponse(request, { error: "missing_user_id" }, 400);
  const existing = await supabaseGet("profiles", { id: `eq.${targetId}`, select: "id" }, env).catch(() => []);
  if (!existing?.[0]) return corsResponse(request, { error: "not_found" }, 404);

  try {
    await logAdminAction({ actorUserId: admin.userId, actorRole: admin.role, action: "customer_subscription_resumed_by_staff", targetUserId: targetId }, env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  const result = await resumeSubscriptionForUser(targetId, env);
  if (!result.ok) return corsResponse(request, { error: result.error }, result.status);
  return corsResponse(request, { success: true, ...result.data });
}

async function handleAdminChangePlan(request, env) {
  const admin = await requireAdmin(request, env, { roles: HIGH_RISK_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);
  let body;
  try { body = await request.json(); } catch { return corsResponse(request, { error: "invalid_body" }, 400); }
  const targetId = body?.userId;
  const plan = body?.plan;
  if (!targetId) return corsResponse(request, { error: "missing_user_id" }, 400);
  if (plan !== "pro" && plan !== "premium") return corsResponse(request, { error: "invalid_plan" }, 400);
  const existing = await supabaseGet("profiles", { id: `eq.${targetId}`, select: "id" }, env).catch(() => []);
  if (!existing?.[0]) return corsResponse(request, { error: "not_found" }, 404);

  try {
    await logAdminAction({
      actorUserId: admin.userId, actorRole: admin.role,
      action: "customer_plan_changed_by_staff", targetUserId: targetId,
      metadata: { to: plan },
    }, env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  const result = await changePlanForUser(targetId, plan, env);
  if (!result.ok) return corsResponse(request, { error: result.error }, result.status);
  return corsResponse(request, { success: true, ...result.data });
}

// ─── 3. Stripe Billing Portal link, generated on a customer's behalf ──────
// Reuses the exact same Stripe call handlePortalSession already makes for
// a customer generating their own link -- the only difference is the
// target id comes from the request body instead of the caller's own JWT.
// Never touches a card or payment-method value at all; Stripe's hosted
// portal is where the customer actually enters that. Scoped to
// BILLING_MGMT_ROLES (billing_ops/superadmin), matching the existing
// billing-view tier -- this is materially lower-risk than every other
// operation in this section.
async function handleAdminBillingPortalLink(request, env) {
  const admin = await requireAdmin(request, env, { roles: BILLING_MGMT_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);
  if (!env.STRIPE_SECRET_KEY) return corsResponse(request, { error: "stripe_not_configured" }, 503);

  let body;
  try { body = await request.json(); } catch { return corsResponse(request, { error: "invalid_body" }, 400); }
  const targetId = body?.userId;
  if (!targetId) return corsResponse(request, { error: "missing_user_id" }, 400);
  const rows = await supabaseGet("profiles", { id: `eq.${targetId}`, select: "id,stripe_customer_id" }, env).catch(() => []);
  const profile = rows?.[0];
  if (!profile) return corsResponse(request, { error: "not_found" }, 404);
  if (!profile.stripe_customer_id) return corsResponse(request, { error: "no_stripe_customer" }, 400);

  try {
    await logAdminAction({ actorUserId: admin.userId, actorRole: admin.role, action: "customer_billing_portal_link_generated", targetUserId: targetId }, env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  let session;
  try {
    session = await stripeRequest("POST", "/billing_portal/sessions", {
      customer: profile.stripe_customer_id,
      return_url: "https://careerpersonaai.com/#settings",
    }, env);
  } catch (e) {
    console.error("admin_portal_link_failed", e.message);
    return corsResponse(request, { error: "portal_session_failed" }, 502);
  }

  return corsResponse(request, { url: session.url });
}

// ─── 4. Schedule account deletion (30-day window only) ─────────────────────
// Reuses requestAccountDeletionForUser() -- the exact same 30-day
// scheduling logic (including cancelling live billing first) the
// customer's own self-service endpoint runs. There is no "purge now"
// counterpart anywhere in this section, by explicit instruction: immediate/
// permanent purge is never exposed to staff. Work Order 8's existing
// cancel-scheduled-deletion action can reverse this at any point within
// the 30-day window.
async function handleAdminScheduleDeletion(request, env) {
  const admin = await requireAdmin(request, env, { roles: HIGH_RISK_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);
  let body;
  try { body = await request.json(); } catch { return corsResponse(request, { error: "invalid_body" }, 400); }
  const targetId = body?.userId;
  if (!targetId) return corsResponse(request, { error: "missing_user_id" }, 400);
  const existing = await supabaseGet("profiles", { id: `eq.${targetId}`, select: "id,deletion_status" }, env).catch(() => []);
  const profile = existing?.[0];
  if (!profile) return corsResponse(request, { error: "not_found" }, 404);
  if (profile.deletion_status === "scheduled" || profile.deletion_status === "in_progress") {
    return corsResponse(request, { error: "deletion_already_scheduled" }, 400);
  }

  try {
    await logAdminAction({ actorUserId: admin.userId, actorRole: admin.role, action: "customer_deletion_scheduled_by_staff", targetUserId: targetId }, env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  const result = await requestAccountDeletionForUser(targetId, env);
  if (!result.ok) return corsResponse(request, { error: result.error }, result.status);
  return corsResponse(request, { success: true, ...result.data });
}

// ─── 5. Trigger a password reset ───────────────────────────────────────────
// Calls Supabase Auth's own /recover endpoint -- the exact mechanism a
// customer's own "forgot password" flow would use. Staff never sees, sets,
// or handles a password at any point; Supabase emails the customer a reset
// link directly. This is a deliberate safeguard, not an oversight: the
// customer is always notified when this fires, the same way a genuine
// self-service password-reset request would notify them.
async function handleAdminResetPassword(request, env) {
  const admin = await requireAdmin(request, env, { roles: HIGH_RISK_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);
  let body;
  try { body = await request.json(); } catch { return corsResponse(request, { error: "invalid_body" }, 400); }
  const targetId = body?.userId;
  if (!targetId) return corsResponse(request, { error: "missing_user_id" }, 400);
  const rows = await supabaseGet("profiles", { id: `eq.${targetId}`, select: "id,email" }, env).catch(() => []);
  const profile = rows?.[0];
  if (!profile) return corsResponse(request, { error: "not_found" }, 404);

  try {
    await logAdminAction({ actorUserId: admin.userId, actorRole: admin.role, action: "customer_password_reset_triggered", targetUserId: targetId }, env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  try {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/recover`, {
      method: "POST",
      headers: sbHeaders(env),
      body: JSON.stringify({ email: profile.email }),
    });
    if (!r.ok) throw new Error(`recover_${r.status}`);
  } catch (e) {
    console.error("admin_password_reset_failed", e.message);
    return corsResponse(request, { error: "password_reset_failed" }, 502);
  }

  return corsResponse(request, { success: true });
}

// ─── 6. Revoke a customer's active sessions ────────────────────────────────
// Verified directly against the live Supabase project (Work Order: Verify
// & Fix Admin Revoke Sessions). Findings, in order:
//   - DELETE /auth/v1/admin/users/{id}/sessions -- the route this handler
//     originally called -- does not exist on this project's GoTrue version.
//     It returns a plain "404 page not found" (not GoTrue's own JSON error
//     shape), and confirmed via a real throwaway test session that it does
//     NOT invalidate anything. The old `r.status !== 404` tolerance (meant
//     for "user already gone is fine") silently treated that route-missing
//     404 as success, so this was reporting success while doing nothing.
//   - PUT /auth/v1/admin/users/{id} { ban_duration } does invalidate access
//     WHILE the ban is active, but is not a real revocation: the instant
//     the ban is lifted, the customer's original refresh token resumes
//     working -- confirmed by testing a brief ban immediately followed by
//     clearing it. Not viable for "sign them out" (self-heals).
//   - PUT /auth/v1/admin/users/{id} { password: <random> } is the one
//     mechanism confirmed to permanently kill an existing session (checked
//     twice afterward -- it does not self-heal). This is the same
//     operation as a password change, which GoTrue invalidates existing
//     sessions for by design.
// The random password is never seen by staff or the customer, so a
// recovery-email is triggered immediately after (the same /recover call
// handleAdminResetPassword already uses) so the customer has a real path
// back in. That email send is best-effort, not required for success:
// Supabase rate-limits /recover, and a rate-limit there must not undo the
// fact that the session was already genuinely revoked, which is this
// action's actual purpose.
async function handleAdminRevokeSessions(request, env) {
  const admin = await requireAdmin(request, env, { roles: HIGH_RISK_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);
  let body;
  try { body = await request.json(); } catch { return corsResponse(request, { error: "invalid_body" }, 400); }
  const targetId = body?.userId;
  if (!targetId) return corsResponse(request, { error: "missing_user_id" }, 400);
  const existing = await supabaseGet("profiles", { id: `eq.${targetId}`, select: "id,email" }, env).catch(() => []);
  const profile = existing?.[0];
  if (!profile) return corsResponse(request, { error: "not_found" }, 404);

  try {
    await logAdminAction({ actorUserId: admin.userId, actorRole: admin.role, action: "customer_sessions_revoked", targetUserId: targetId }, env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  try {
    const r = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${targetId}`, {
      method: "PUT",
      headers: sbHeaders(env),
      body: JSON.stringify({ password: crypto.randomUUID() + crypto.randomUUID() }),
    });
    if (!r.ok) throw new Error(`revoke_${r.status}`);
  } catch (e) {
    console.error("admin_revoke_sessions_failed", e.message);
    return corsResponse(request, { error: "revoke_failed" }, 502);
  }

  try {
    await fetch(`${env.SUPABASE_URL}/auth/v1/recover`, {
      method: "POST",
      headers: sbHeaders(env),
      body: JSON.stringify({ email: profile.email }),
    });
  } catch (e) {
    // Best-effort: the session is already revoked above (this action's
    // actual purpose) regardless of whether this follow-up email goes out.
    console.error("admin_revoke_sessions_recovery_email_failed", e.message);
  }

  return corsResponse(request, { success: true });
}

// ─── 7. True customer impersonation ────────────────────────────────────────
// Verified directly against the live Supabase project before building this
// (see the Work Order report). Design, in order of the actual findings:
//   - Supabase's Admin API supports POST /auth/v1/admin/generate_link
//     (type: "magiclink"), which mints a real, single-use credential for
//     ANY user without ever touching their password -- this is the
//     documented, supported mechanism, not a workaround.
//   - Its `action_link`/redirect-based redemption is NOT usable here: a
//     live test showed Supabase silently overrides an unrecognized
//     `redirect_to` with whatever's on the project's own configured
//     redirect allow-list (a real anti-open-redirect protection), so
//     redirect-based redemption can't reliably land the customer back in
//     this app without a project-level config change this Work Order
//     doesn't make.
//   - The fix: skip the redirect entirely. The raw `hashed_token` is
//     redeemed directly via the customer app's own client-side
//     supabase.auth.verifyOtp({ token_hash, type: "magiclink" }) call --
//     confirmed live to return a genuine, working session with no
//     redirect or allow-list involved, and confirmed single-use (a second
//     redemption attempt is rejected).
//   - The resulting session's JWT carries amr = [{method:"otp"}], which
//     requireAuth() now uses to block every non-GET customer request by
//     default while impersonating (see its own comment for why this is
//     safe against the existing password-recovery flow, which also
//     produces an otp-tagged session but never reaches this Worker).
//   - "Time-limited" is enforced two ways: the UI-facing 15-minute window
//     below (matching the original grant), and a hard backstop nothing
//     client-side can extend -- the customer app loads this session with
//     autoRefreshToken/persistSession both off, so the session dies within
//     Supabase's own natural access-token lifetime (~1 hour) no matter
//     what, and is never written to localStorage in the first place.
//   - The KV grant remains the authorization/audit anchor for *starting*
//     impersonation (superadmin-only, fully audited) -- it does not need
//     to police the in-progress session itself, since the ephemeral,
//     non-refreshing client design already bounds it.
const IMPERSONATION_TTL_SECONDS = 15 * 60;
function impersonationKvKey(staffUserId) {
  return `impersonation:${staffUserId}`;
}

async function handleAdminImpersonateStart(request, env) {
  const admin = await requireAdmin(request, env, { roles: HIGH_RISK_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return corsResponse(request, { error: "not_configured" }, 503);
  let body;
  try { body = await request.json(); } catch { return corsResponse(request, { error: "invalid_body" }, 400); }
  const targetId = body?.userId;
  if (!targetId) return corsResponse(request, { error: "missing_user_id" }, 400);
  const existing = await supabaseGet("profiles", { id: `eq.${targetId}`, select: "id,full_name,email,deletion_status" }, env).catch(() => []);
  const target = existing?.[0];
  if (!target) return corsResponse(request, { error: "not_found" }, 404);
  // A customer whose own account is locked for deletion can't be
  // impersonated into either -- the underlying session would immediately
  // hit the same account_scheduled_for_deletion lock every real request
  // for that account already does, so there's nothing useful to show, and
  // no reason to carve out a bypass here that doesn't exist anywhere else.
  if (target.deletion_status === "scheduled" || target.deletion_status === "in_progress") {
    return corsResponse(request, { error: "account_scheduled_for_deletion" }, 400);
  }

  const expiresAt = new Date(Date.now() + IMPERSONATION_TTL_SECONDS * 1000).toISOString();
  const grant = { targetUserId: targetId, targetName: target.full_name || target.email, startedAt: new Date().toISOString(), expiresAt };

  // Audit-before-mutation: if this write fails, no impersonation
  // credential has been issued yet, so the 500 below is accurate.
  try {
    await logAdminAction({
      actorUserId: admin.userId, actorRole: admin.role,
      action: "impersonation_started", targetUserId: targetId,
      metadata: { expiresAt },
    }, env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  let hashedToken;
  try {
    const genRes = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/generate_link`, {
      method: "POST",
      headers: sbHeaders(env),
      body: JSON.stringify({ type: "magiclink", email: target.email }),
    });
    if (!genRes.ok) throw new Error(`generate_link_${genRes.status}`);
    const genBody = await genRes.json();
    hashedToken = genBody.hashed_token;
    if (!hashedToken) throw new Error("generate_link_missing_token");
  } catch (e) {
    console.error("admin_impersonation_link_failed", e.message);
    return corsResponse(request, { error: "impersonation_link_failed" }, 502);
  }

  try {
    await env.SUBSCRIPTION_CACHE.put(impersonationKvKey(admin.userId), JSON.stringify(grant), { expirationTtl: IMPERSONATION_TTL_SECONDS });
  } catch (e) {
    console.error("admin_impersonation_grant_failed", e.message);
    return corsResponse(request, { error: "grant_failed" }, 500);
  }

  // The one-time token is handed back exactly once, to the superadmin who
  // just authenticated and requested it, over the same HTTPS response
  // already carrying their own session -- it is redeemed client-side by
  // the customer app itself (never logged, never stored server-side
  // beyond this point) and is single-use regardless.
  return corsResponse(request, { ...grant, hashedToken });
}

async function handleAdminImpersonateEnd(request, env) {
  const admin = await requireAdmin(request, env, { roles: HIGH_RISK_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);

  const existingGrant = await env.SUBSCRIPTION_CACHE.get(impersonationKvKey(admin.userId), "json").catch(() => null);
  if (!existingGrant) return corsResponse(request, { success: true }); // nothing active -- true no-op, no audit

  try {
    await logAdminAction({
      actorUserId: admin.userId, actorRole: admin.role,
      action: "impersonation_ended", targetUserId: existingGrant.targetUserId,
    }, env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  await env.SUBSCRIPTION_CACHE.delete(impersonationKvKey(admin.userId)).catch(() => {});
  return corsResponse(request, { success: true });
}

// Deliberately unaudited -- a lightweight status poll the Back Office UI
// calls to render/refresh the impersonation banner, not a data-access or
// mutation event. Auditing every poll would be exactly the kind of
// unnecessary logging noise Deferred Fix #5 already reasoned against.
async function handleAdminImpersonateStatus(request, env) {
  const admin = await requireAdmin(request, env, { roles: HIGH_RISK_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);
  const grant = await env.SUBSCRIPTION_CACHE.get(impersonationKvKey(admin.userId), "json").catch(() => null);
  if (!grant || new Date(grant.expiresAt) <= new Date()) return corsResponse(request, { active: false });
  return corsResponse(request, { active: true, ...grant });
}

// ─── 8. Scoped customer profile editing ────────────────────────────────────
// Fixed allowlist of the exact fields already shown on the customer's own
// Settings page and already exposed read-only via GET
// /api/admin/customers/detail -- no new columns, no freeform field names.
// One audit row per changed field (same batched-insert pattern as Work
// Order 7/9's multi-event updates), carrying the actual before/after
// values -- this is the one operation in this Work Order where the values
// themselves belong in the audit trail, since "what did the profile say
// before" is the whole point of a support-driven correction.
const CUSTOMER_PROFILE_EDITABLE_FIELDS = {
  fullName: "full_name",
  phone: "phone",
  country: "country",
  location: "location",
  jobTitle: "job_title",
  yearsExperience: "years_experience",
};

async function handleAdminCustomerProfileUpdate(request, env) {
  const admin = await requireAdmin(request, env, { roles: HIGH_RISK_ROLES });
  if (!admin.ok) return corsResponse(request, { error: admin.error }, admin.status);
  let body;
  try { body = await request.json(); } catch { return corsResponse(request, { error: "invalid_body" }, 400); }
  const targetId = body?.userId;
  if (!targetId) return corsResponse(request, { error: "missing_user_id" }, 400);
  const fields = body?.fields;
  if (!fields || typeof fields !== "object" || Array.isArray(fields)) {
    return corsResponse(request, { error: "missing_fields" }, 400);
  }
  const unknownKeys = Object.keys(fields).filter((k) => !(k in CUSTOMER_PROFILE_EDITABLE_FIELDS));
  if (unknownKeys.length > 0) return corsResponse(request, { error: "invalid_field" }, 400);
  if ("yearsExperience" in fields && fields.yearsExperience != null && typeof fields.yearsExperience !== "number") {
    return corsResponse(request, { error: "invalid_field_value" }, 400);
  }
  for (const key of ["fullName", "phone", "country", "location", "jobTitle"]) {
    if (key in fields && fields[key] != null && typeof fields[key] !== "string") {
      return corsResponse(request, { error: "invalid_field_value" }, 400);
    }
  }

  const selectCols = Object.values(CUSTOMER_PROFILE_EDITABLE_FIELDS).join(",");
  const existing = await supabaseGet("profiles", { id: `eq.${targetId}`, select: `id,${selectCols}` }, env).catch(() => []);
  const current = existing?.[0];
  if (!current) return corsResponse(request, { error: "not_found" }, 404);

  const patch = {};
  const events = [];
  for (const [apiKey, column] of Object.entries(CUSTOMER_PROFILE_EDITABLE_FIELDS)) {
    if (!(apiKey in fields)) continue;
    const newValue = fields[apiKey];
    if (newValue !== current[column]) {
      patch[column] = newValue;
      events.push({ field: apiKey, metadata: { field: apiKey, from: current[column] ?? null, to: newValue ?? null } });
    }
  }

  if (events.length === 0) {
    return corsResponse(request, { success: true, changed: [] }); // true no-op, no audit
  }

  try {
    await logAdminActions(events.map((evt) => ({
      actorUserId: admin.userId, actorRole: admin.role, action: "customer_profile_edited_by_staff", targetUserId: targetId, metadata: evt.metadata,
    })), env);
  } catch (e) {
    console.error("admin_audit_log_failed", e.message);
    return corsResponse(request, { error: "audit_log_failed" }, 500);
  }

  await supabasePatch("profiles", { id: `eq.${targetId}` }, patch, env);
  return corsResponse(request, { success: true, changed: events.map((e) => e.field) });
}

// ─── ROUTER ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      if (method === "OPTIONS") {
        return new Response(null, { status: 204, headers: getCorsHeaders(request) });
      }

      if (method === "GET" && path === "/health")             return handleHealth(request, env);
      if (method === "GET" && path === "/api/billing/state") return handleBillingState(request, env);
      if (method === "GET" && path === "/api/admin/session") return handleAdminSession(request, env);
      if (method === "GET" && path === "/api/admin/customers") return handleAdminCustomerList(request, env);
      if (method === "GET" && path === "/api/admin/customers/detail") return handleAdminCustomerDetail(request, env);
      if (method === "GET" && path === "/api/admin/customers/billing") return handleAdminCustomerBilling(request, env);
      if (method === "GET" && path === "/api/admin/dashboard") return handleAdminDashboard(request, env);
      if (method === "GET" && path === "/api/admin/support-cases") return handleAdminSupportCaseList(request, env);
      if (method === "GET" && path === "/api/admin/support-cases/detail") return handleAdminSupportCaseDetail(request, env);
      if (method === "GET" && path === "/api/admin/staff") return handleAdminStaffList(request, env);
      if (method === "GET" && path === "/api/admin/staff-directory") return handleAdminStaffDirectory(request, env);
      if (method === "GET" && path === "/api/admin/staff/invitations") return handleAdminStaffInvitationsList(request, env);
      if (method === "GET" && path === "/api/admin/system-health") return handleAdminSystemHealth(request, env);
      if (method === "GET" && path === "/api/admin/ai-usage") return handleAdminAiUsage(request, env);
      if (method === "GET" && path === "/api/admin/customers/impersonate/status") return handleAdminImpersonateStatus(request, env);

      if (method === "POST") {
        if (path === "/api/jobs")                    return handleJobSearch(request, env);
        if (path === "/api/billing/checkout-session") return handleCheckoutSession(request, env);
        if (path === "/api/billing/confirm-session") return handleConfirmSession(request, env);
        if (path === "/api/billing/cancel")          return handleCancelSubscription(request, env);
        if (path === "/api/billing/resume")          return handleResumeSubscription(request, env);
        if (path === "/api/billing/change-plan")     return handleChangePlan(request, env);
        if (path === "/api/billing/portal-session")  return handlePortalSession(request, env);
        if (path === "/api/account/request-deletion") return handleRequestAccountDeletion(request, env);
        if (path === "/api/account/cancel-deletion")  return handleCancelAccountDeletion(request, env);
        if (path === "/webhooks/stripe")             return handleStripeWebhook(request, env);
        if (path === "/api/admin/support-cases")        return handleAdminSupportCaseCreate(request, env);
        if (path === "/api/admin/support-cases/update") return handleAdminSupportCaseUpdate(request, env);
        if (path === "/api/admin/support-cases/notes")  return handleAdminSupportCaseAddNote(request, env);
        if (path === "/api/admin/customers/cancel-deletion") return handleAdminCancelCustomerDeletion(request, env);
        if (path === "/api/admin/staff/update")              return handleAdminStaffUpdate(request, env);
        if (path === "/api/admin/staff/invite")               return handleAdminStaffInvite(request, env);
        if (path === "/api/admin/staff/invite/revoke")        return handleAdminStaffInvitationRevoke(request, env);
        if (path === "/api/admin/staff/accept-invite")        return handleAcceptStaffInvitation(request, env);
        if (path === "/api/admin/customers/refund")                    return handleAdminRefund(request, env);
        if (path === "/api/admin/customers/subscription/cancel")       return handleAdminSubscriptionCancel(request, env);
        if (path === "/api/admin/customers/subscription/resume")       return handleAdminSubscriptionResume(request, env);
        if (path === "/api/admin/customers/subscription/change-plan")  return handleAdminChangePlan(request, env);
        if (path === "/api/admin/customers/billing-portal-link")       return handleAdminBillingPortalLink(request, env);
        if (path === "/api/admin/customers/schedule-deletion")         return handleAdminScheduleDeletion(request, env);
        if (path === "/api/admin/customers/reset-password")            return handleAdminResetPassword(request, env);
        if (path === "/api/admin/customers/revoke-sessions")           return handleAdminRevokeSessions(request, env);
        if (path === "/api/admin/customers/impersonate/start")         return handleAdminImpersonateStart(request, env);
        if (path === "/api/admin/customers/impersonate/end")           return handleAdminImpersonateEnd(request, env);
        if (path === "/api/admin/customers/profile/update")            return handleAdminCustomerProfileUpdate(request, env);
        // Back Office routes not yet implemented must 404 explicitly, never
        // fall through to the Claude proxy catch-all below.
        if (path.startsWith("/api/admin/"))          return corsResponse(request, { error: "not_found" }, 404);
        return handleClaude(request, env, ctx); // POST / — Claude proxy (catch-all)
      }

      return corsResponse(request, { error: "not_found" }, 404);
    } catch (e) {
      console.error("worker_error", e.message);
      return corsResponse(request, { error: "internal_error" }, 500);
    }
  },

  // Scheduler entry point (Cron Triggers, see wrangler.toml). event.cron
  // identifies which registered schedule fired; ctx.waitUntil keeps the
  // invocation alive until the work (bounded by PROACTIVE_ALERTS_TIME_BUDGET_MS
  // for the Proactive Alerts branch) finishes.
  async scheduled(event, env, ctx) {
    if (event.cron === "0 13 * * *") {
      ctx.waitUntil(
        runSmartApplyAutoPrepSchedule(env).catch(e => console.error("[smartApplyAutoPrep] schedule_error", e.message))
      );
      return;
    }
    if (event.cron === "0 3 * * *") {
      ctx.waitUntil(
        runAccountDeletionPurgeSchedule(env).catch(e => console.error("[accountDeletion] schedule_error", e.message))
      );
      return;
    }
    if (event.cron === "15 0 * * *") {
      ctx.waitUntil(
        runAiUsageDailyAggregation(env).catch(e => console.error("[aiUsageAggregation] schedule_error", e.message))
      );
      return;
    }
    ctx.waitUntil(
      runProactiveJobAlertsSchedule(event.cron, env).catch(e => console.error("[proactiveAlerts] schedule_error", event.cron, e.message))
    );
  },
};

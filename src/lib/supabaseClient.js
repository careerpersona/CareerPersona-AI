import { createClient } from "@supabase/supabase-js";

// Anon/publishable key — safe to expose client-side. Every table is protected by
// row-level security scoped to auth.uid(), so this key alone grants no data access.
const SUPABASE_URL = "https://cbzebqxbohgkgcqfgmdm.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNiemVicXhib2hna2djcWZnbWRtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNzI4ODMsImV4cCI6MjA5NzY0ODg4M30._W9GabazL0_RG-N3wq6raRtRwM83VqqRJQqi6Vq0kmk";

// Capture the URL hash AND search params synchronously before createClient()
// processes and removes them. Used by useAuth to:
//  • seed recoveryMode on the very first render (type=recovery in hash)
//  • detect auth callback URLs so a loading screen is shown while the PKCE code
//    or implicit token is being exchanged (prevents the login-page flash)
export const initialLocationHash =
  typeof window !== "undefined" ? window.location.hash : "";
export const initialLocationSearch =
  typeof window !== "undefined" ? window.location.search : "";

// True Customer Impersonation (Back Office -> "View as customer"). This page
// load is redeeming a one-time Back Office impersonation token when the URL
// carries `impersonate_token` -- set only by AdminShell's window.open call,
// never by anything a real customer's own browsing produces. Verified
// directly against the live Supabase project (see the Work Order report)
// that this is the one reliable way to tell an impersonation session apart
// from every real customer flow.
const impersonationParams =
  typeof window !== "undefined" ? new URLSearchParams(initialLocationSearch) : new URLSearchParams();
export const isImpersonationEntry = impersonationParams.has("impersonate_token");
export const impersonationTokenHash = impersonationParams.get("impersonate_token");
export const impersonationExpiresAtMs = impersonationParams.has("impersonate_exp")
  ? Number(impersonationParams.get("impersonate_exp")) * 1000
  : null;

// Deliberately ephemeral for an impersonation session: never written to
// localStorage (persistSession: false) and never silently kept alive past
// its own natural lifetime (autoRefreshToken: false) -- the session is
// bounded by Supabase's own access-token expiry (~1 hour) no matter what,
// with nothing client-side able to extend it. Every other page load (the
// entire rest of the real customer app) is unaffected -- this branch is
// only ever taken when the URL was opened via the Back Office's own
// impersonation entry point.
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, isImpersonationEntry ? {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
} : undefined);

// Client-side defense-in-depth for impersonation (the Worker's requireAuth()
// is the authoritative enforcement -- see its own comment -- this is a
// second, redundant layer so a blocked write never even reaches the
// network). Every actual mutation path in this app funnels through one of
// these three surfaces (PostgREST via supabase.from(), RPC calls, or
// Storage), so wrapping them here covers the app's existing ~13,000 lines
// of call sites without touching any of them individually. Reads are
// completely unaffected -- only the four mutating query-builder methods,
// rpc(), and Storage's write methods are intercepted.
if (isImpersonationEntry) {
  const blockedResult = { data: null, error: { message: "Action blocked while impersonating a customer." } };
  const realFrom = supabase.from.bind(supabase);
  supabase.from = (table) => {
    const builder = realFrom(table);
    for (const method of ["insert", "update", "upsert", "delete"]) {
      if (typeof builder[method] === "function") {
        builder[method] = () => Promise.resolve(blockedResult);
      }
    }
    return builder;
  };
  supabase.rpc = () => Promise.resolve(blockedResult);
  const realStorageFrom = supabase.storage.from.bind(supabase.storage);
  supabase.storage.from = (bucket) => {
    const storageBuilder = realStorageFrom(bucket);
    for (const method of ["upload", "update", "remove", "move", "copy"]) {
      if (typeof storageBuilder[method] === "function") {
        storageBuilder[method] = () => Promise.resolve(blockedResult);
      }
    }
    return storageBuilder;
  };
}

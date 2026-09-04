import { useEffect, useRef, useState, useCallback } from "react";
import { supabase } from "./lib/supabaseClient.js";
import { fetchAdminSession } from "./lib/adminApi.js";
import { AdminAuthContext } from "./lib/adminAuthContext.js";

// Status values, in the order a normal sign-in walks through them:
//   loading         -- initial mount, checking for an existing Supabase session
//   signed_out      -- no Supabase session (show LoginPage)
//   checking_admin  -- Supabase session found/created, verifying staff status
//   authorized      -- active staff row confirmed (show AdminShell)
//   unauthorized    -- authenticated, but no active staff row (show AccessDeniedPage)
//   error           -- the staff check itself failed (network/server), not a denial
export function AdminAuthProvider({ children }) {
  const [status, setStatus] = useState("loading");
  const [session, setSession] = useState(null);
  const [role, setRole] = useState(null);
  const [error, setError] = useState("");
  // Guards against a stale async check clobbering state after a newer one
  // (or a sign-out) has already landed -- e.g. the admin-session fetch for a
  // just-replaced session resolving after the user has already signed out.
  const checkId = useRef(0);

  const runAdminCheck = useCallback(async (nextSession) => {
    const myCheckId = ++checkId.current;
    setStatus("checking_admin");
    setError("");

    const result = await fetchAdminSession(nextSession.access_token);
    if (checkId.current !== myCheckId) return; // superseded by a newer check

    if (result.ok) {
      setRole(result.role);
      setStatus("authorized");
      return;
    }
    if (result.reason === "not_staff") {
      setRole(null);
      setStatus("unauthorized");
      return;
    }
    if (result.reason === "unauthenticated") {
      // Session existed client-side but the Worker rejected the token
      // (expired/invalid) -- treat as signed out rather than "denied".
      setSession(null);
      setRole(null);
      setStatus("signed_out");
      return;
    }
    // network_error / server_error -- transient, not a denial. Distinct
    // status so the UI can offer "Try again" rather than "you're not staff".
    setRole(null);
    setStatus("error");
    setError("Couldn't verify Back Office access. Check your connection and try again.");
  }, []);

  useEffect(() => {
    let cancelled = false;

    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      if (data.session) {
        setSession(data.session);
        runAdminCheck(data.session);
      } else {
        setStatus("signed_out");
      }
    });

    const { data: sub } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (cancelled) return;
      if (event === "SIGNED_OUT" || !nextSession) {
        checkId.current++; // invalidate any in-flight check
        setSession(null);
        setRole(null);
        setStatus("signed_out");
        return;
      }
      setSession(nextSession);
      runAdminCheck(nextSession);
    });

    return () => {
      cancelled = true;
      sub?.subscription?.unsubscribe();
    };
  }, [runAdminCheck]);

  const login = useCallback(async (email, password) => {
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    // On success, onAuthStateChange (above) picks up the new session and
    // runs the admin check -- nothing further to do here. On failure,
    // nothing changes: status stays "signed_out" and LoginPage shows the
    // returned error message itself.
    return authError ? { ok: false, message: authError.message } : { ok: true };
  }, []);

  const logout = useCallback(async () => {
    checkId.current++; // invalidate any in-flight check
    try { await supabase.auth.signOut(); } catch { /* clear local state regardless */ }
    setSession(null);
    setRole(null);
    setStatus("signed_out");
  }, []);

  const retry = useCallback(() => {
    if (session) runAdminCheck(session);
  }, [session, runAdminCheck]);

  const value = {
    status, role, error,
    email: session?.user?.email || null,
    userId: session?.user?.id || null,
    // Only ever used to call /api/admin/* as a Bearer token -- never rendered,
    // logged, or persisted anywhere beyond Supabase's own session storage.
    accessToken: session?.access_token || null,
    login, logout, retry,
  };

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>;
}

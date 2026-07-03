import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

const LS = {
  form: "cp_network_form",
  results: "cp_network_results",
  draft: "cp_network_draft",
  emailTo: "cp_network_emailto",
  emailSent: "cp_network_emailsent",
};
const safe = (k, fb) => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; } catch { return fb; } };
const lsWrite = (key, val) => { try { localStorage.setItem(LS[key], JSON.stringify(val)); } catch {} };

export function useNetworkingSession(userId, defaultForm = {}) {
  const [session, setSession] = useState(() => ({
    form: safe(LS.form, { targetName: "", targetRole: "", targetCompany: "", yourBackground: "", purpose: "coffee-chat", jobDesc: "", ...defaultForm }),
    results: safe(LS.results, null),
    draft: safe(LS.draft, null),
    emailTo: safe(LS.emailTo, ""),
    emailSent: safe(LS.emailSent, false),
  }));
  const loadedFor = useRef(null);
  const saveTimer = useRef(null);

  useEffect(() => {
    if (!userId || loadedFor.current === userId) return;
    loadedFor.current = userId;
    (async () => {
      const { data, error } = await supabase
        .from("networking_sessions")
        .select("*")
        .eq("user_id", userId)
        .maybeSingle();
      if (error) return;
      if (data) {
        const next = {
          form: data.form || { targetName: "", targetRole: "", targetCompany: "", yourBackground: "", purpose: "coffee-chat", jobDesc: "" },
          results: data.results || null,
          draft: data.draft || null,
          emailTo: data.email_to || "",
          emailSent: !!data.email_sent,
        };
        // Populate localStorage so subsequent page loads are instant
        Object.keys(LS).forEach(k => { try { localStorage.setItem(LS[k], JSON.stringify(next[k])); } catch {} });
        setSession(next);
      } else {
        // First load for this account — migrate any existing localStorage data to Supabase
        const local = {
          form: safe(LS.form, null),
          results: safe(LS.results, null),
          draft: safe(LS.draft, null),
          emailTo: safe(LS.emailTo, ""),
          emailSent: safe(LS.emailSent, false),
        };
        if (local.form || local.results || local.draft) {
          await supabase.from("networking_sessions").upsert({
            user_id: userId,
            form: local.form,
            results: local.results,
            draft: local.draft,
            email_to: local.emailTo,
            email_sent: local.emailSent,
          }, { onConflict: "user_id" });
        }
      }
    })();
  }, [userId]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const persist = useCallback((next) => {
    if (!userId) return;
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      await supabase.from("networking_sessions").upsert({
        user_id: userId,
        form: next.form,
        results: next.results,
        draft: next.draft,
        email_to: next.emailTo,
        email_sent: next.emailSent,
      }, { onConflict: "user_id" });
    }, 600);
  }, [userId]);

  const update = useCallback((key, updater) => {
    setSession(prev => {
      const nextVal = typeof updater === "function" ? updater(prev[key]) : updater;
      const next = { ...prev, [key]: nextVal };
      lsWrite(key, nextVal); // keep localStorage in sync for instant next-load
      persist(next);
      return next;
    });
  }, [persist]);

  return {
    form: session.form,
    setForm: (v) => update("form", v),
    results: session.results,
    setResults: (v) => update("results", v),
    draft: session.draft,
    setDraft: (v) => update("draft", v),
    emailTo: session.emailTo,
    setEmailTo: (v) => update("emailTo", v),
    emailSent: session.emailSent,
    setEmailSent: (v) => update("emailSent", v),
  };
}

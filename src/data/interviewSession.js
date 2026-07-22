import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

const TABLE = "interview_sessions";

const toRow = (userId, s, extra = {}) => ({
  user_id: userId,
  job_description: s.jobDesc || null,
  questions: s.questions || [],
  answers: s.savedFeedback || {},
  mode: s.mode || "browse",
  readiness_score: s.mockSummary?.avgScore != null ? Math.round(s.mockSummary.avgScore * 10) : null,
  session_state: {
    resume: s.resume || "",
    resumeFileName: s.resumeFileName || "",
    mockAnswers: s.mockAnswers || {},
    mockSummary: s.mockSummary || null,
    mockIdx: s.mockIdx || 0,
    mockAnswerDraft: s.mockAnswerDraft || "",
    activeQ: s.activeQ || null,
    showReview: s.showReview || false,
  },
  ...extra,
});

const fromRow = (r) => ({
  questions: r.questions || [],
  jobDesc: r.job_description || "",
  savedFeedback: r.answers || {},
  mode: r.mode || "browse",
  resume: r.session_state?.resume || "",
  resumeFileName: r.session_state?.resumeFileName || "",
  mockAnswers: r.session_state?.mockAnswers || {},
  mockSummary: r.session_state?.mockSummary || null,
  mockIdx: r.session_state?.mockIdx || 0,
  mockAnswerDraft: r.session_state?.mockAnswerDraft || "",
  activeQ: r.session_state?.activeQ || null,
  showReview: r.session_state?.showReview || false,
});

// Loads the single active session for this user.
// Only one active session can exist per user (enforced by a partial unique index
// on interview_sessions where status = 'active').
// `loadedFor` tracks which userId the current session belongs to so consumers
// can distinguish a stale render from a genuine "no session" state.
export function useInterviewSession(userId) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadedFor, setLoadedFor] = useState(undefined);
  const rowIdRef = useRef(null);

  useEffect(() => {
    let active = true;
    if (!userId) { setSession(null); setLoadedFor(userId); setLoading(false); rowIdRef.current = null; return; }
    setLoading(true);
    supabase.from(TABLE).select("*").eq("user_id", userId).eq("status", "active").limit(1)
      .then(({ data, error }) => {
        if (!active) return;
        if (!error && data && data.length) {
          rowIdRef.current = data[0].id;
          setSession(fromRow(data[0]));
        } else {
          rowIdRef.current = null;
          setSession(null);
        }
        setLoadedFor(userId);
        setLoading(false);
      });
    return () => { active = false; };
  }, [userId]);

  // Updates the active session in place. If no active row exists yet (e.g. after
  // complete() was called), inserts a new one with status='active'.
  const save = useCallback(async (s) => {
    if (!userId) return;
    const row = toRow(userId, s);
    if (rowIdRef.current) {
      const { error } = await supabase.from(TABLE).update(row).eq("id", rowIdRef.current);
      if (error) throw error;
    } else {
      const { data, error } = await supabase.from(TABLE).insert({ ...row, status: "active" }).select().single();
      if (error) throw error;
      rowIdRef.current = data.id;
    }
  }, [userId]);

  // Marks the active session as permanently completed with its final data.
  // After this, rowIdRef is cleared so any future save() call inserts a new
  // active session rather than touching the completed record.
  const complete = useCallback(async (s) => {
    if (!userId || !rowIdRef.current) return;
    const row = toRow(userId, s, { status: "completed" });
    const { error } = await supabase.from(TABLE).update(row).eq("id", rowIdRef.current);
    if (error) throw error;
    rowIdRef.current = null;
  }, [userId]);

  // Deletes the active session. Used when the user explicitly discards an
  // unfinished interview to start fresh. Safe to call after complete() —
  // rowIdRef is already null so the delete is skipped.
  const clear = useCallback(async () => {
    if (rowIdRef.current) {
      await supabase.from(TABLE).delete().eq("id", rowIdRef.current);
      rowIdRef.current = null;
    }
    setSession(null);
  }, []);

  const refresh = useCallback(async () => {
    if (!userId) return;
    const { data, error } = await supabase.from(TABLE).select("*").eq("user_id", userId).eq("status", "active").limit(1);
    if (error) return;
    if (data && data.length) {
      rowIdRef.current = data[0].id;
      setSession(fromRow(data[0]));
    } else {
      rowIdRef.current = null;
      setSession(null);
    }
  }, [userId]);

  return { session, loading, loadedFor, save, clear, complete, refresh };
}

// Returns all completed interview sessions for a user, newest first.
// Used to render the interview history list below the active session.
export function useInterviewHistory(userId) {
  const [history, setHistory] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!userId) { setHistory([]); setLoading(false); return; }
    setLoading(true);
    supabase
      .from(TABLE)
      .select("id, job_description, readiness_score, updated_at")
      .eq("user_id", userId)
      .eq("status", "completed")
      .order("updated_at", { ascending: false })
      .then(({ data, error }) => {
        setHistory((!error && data) ? data : []);
        setLoading(false);
      });
  }, [userId]);

  return { history, loading };
}

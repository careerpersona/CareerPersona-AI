import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

const TABLE = "interview_sessions";

const toRow = (userId, s) => ({
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

// The existing UI only ever has one active interview session per user, so
// this loads the most recent row and updates it in place rather than
// modeling a list — mirrors the prior single-slot localStorage behavior.
export function useInterviewSession(userId) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const rowIdRef = useRef(null);

  useEffect(() => {
    let active = true;
    if (!userId) { setSession(null); setLoading(false); rowIdRef.current = null; return; }
    setLoading(true);
    supabase.from(TABLE).select("*").eq("user_id", userId).order("updated_at", { ascending: false }).limit(1)
      .then(({ data, error }) => {
        if (!active) return;
        if (!error && data && data.length) {
          rowIdRef.current = data[0].id;
          setSession(fromRow(data[0]));
        } else {
          rowIdRef.current = null;
          setSession(null);
        }
        setLoading(false);
      });
    return () => { active = false; };
  }, [userId]);

  const save = useCallback(async (s) => {
    if (!userId) return;
    const row = toRow(userId, s);
    if (rowIdRef.current) {
      const { error } = await supabase.from(TABLE).update(row).eq("id", rowIdRef.current);
      if (error) throw error;
    } else {
      const { data, error } = await supabase.from(TABLE).insert(row).select().single();
      if (error) throw error;
      rowIdRef.current = data.id;
    }
  }, [userId]);

  const clear = useCallback(async () => {
    if (rowIdRef.current) {
      await supabase.from(TABLE).delete().eq("id", rowIdRef.current);
      rowIdRef.current = null;
    }
    setSession(null);
  }, []);

  return { session, loading, save, clear };
}

import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

const TABLE = "smart_apply_queue";

export function useSmartApplyQueue(userId) {
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId) { setQueue([]); return; }
    setLoading(true);
    const { data, error } = await supabase.from(TABLE).select("*").eq("user_id", userId).order("created_at", { ascending: false });
    if (!error && data) setQueue(data);
    setLoading(false);
  }, [userId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Step 1: create the queue row immediately (status "queued") so the UI gets
  // instant feedback while the AI generation call is still in flight.
  const enqueue = useCallback(async (userId, job, resumeId) => {
    const { data, error } = await supabase
      .from(TABLE)
      .insert({ user_id: userId, job_id: job.id || job.job_id, job_title: job.title, company: job.company, resume_id: resumeId || null, status: "queued" })
      .select()
      .single();
    if (error) throw error;
    await refresh();
    return data;
  }, [refresh]);

  // Step 2: fill in the AI-generated bundle and flip status to "ready".
  const markReady = useCallback(async (id, aiResult) => {
    const { error } = await supabase.from(TABLE).update({
      tailored_resume: aiResult.tailoredResume || null,
      cover_letter: aiResult.coverLetter || null,
      recruiter_message: aiResult.recruiterMessage || null,
      networking_message: aiResult.networkingMessage || null,
      missing_skills: aiResult.missingSkills || null,
      interview_probability: aiResult.interviewProbability ?? null,
      hiring_probability: aiResult.hiringProbability ?? null,
      application_questions: aiResult.applicationQuestions || null,
      status: "ready",
    }).eq("id", id);
    if (error) throw error;
    await refresh();
  }, [refresh]);

  const markFailed = useCallback(async (id) => {
    await supabase.from(TABLE).delete().eq("id", id);
    await refresh();
  }, [refresh]);

  const markApplied = useCallback(async (id, applicationId) => {
    const { error } = await supabase.from(TABLE).update({ status: "applied", application_id: applicationId }).eq("id", id);
    if (error) throw error;
    await refresh();
  }, [refresh]);

  const skip = useCallback(async (id) => {
    const { error } = await supabase.from(TABLE).update({ status: "skipped" }).eq("id", id);
    if (error) throw error;
    await refresh();
  }, [refresh]);

  return { queue, loading, enqueue, markReady, markFailed, markApplied, skip, refresh };
}

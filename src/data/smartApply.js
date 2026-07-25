import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

const TABLE = "smart_apply_queue";

// Module-level: tracks queue IDs currently being AI-generated in this browser session.
// Resets on page reload — any "queued" row NOT in this Set during a refresh is an orphan
// from a previous session and gets automatically reset to "failed".
const _activeGenerations = new Set();

export function useSmartApplyQueue(userId) {
  const [queue, setQueue] = useState([]);
  // Start loading=true when userId is already available so consumers never see
  // a false "empty" state before the first Supabase fetch completes.
  const [loading, setLoading] = useState(() => !!userId);

  const refresh = useCallback(async () => {
    if (!userId) { setQueue([]); return; }
    setLoading(true);
    const { data, error } = await supabase
      .from(TABLE).select("*").eq("user_id", userId).order("created_at", { ascending: false });
    if (!error && data) {
      // Orphan cleanup: "queued" rows not tracked in _activeGenerations are stuck
      // from a previous session (tab close, refresh mid-generation). Mark them failed.
      const orphans = data.filter(q => q.status === "queued" && !_activeGenerations.has(q.id));
      if (orphans.length > 0) {
        try {
          await Promise.all(orphans.map(q =>
            supabase.from(TABLE).update({ status: "failed" }).eq("id", q.id)
          ));
          const { data: clean } = await supabase
            .from(TABLE).select("*").eq("user_id", userId).order("created_at", { ascending: false });
          if (clean) { setQueue(clean); setLoading(false); return; }
        } catch { /* cleanup failure is non-fatal — use original data */ }
      }
      setQueue(data);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Step 1: create or reuse a queue row for this job.
  // Returns the row if generation should proceed, null if a valid row already exists (skip generation).
  const enqueue = useCallback(async (userId, job, resumeId) => {
    // Deduplication: look for any existing non-terminal row for this job.
    const { data: rows } = await supabase
      .from(TABLE).select("*").eq("user_id", userId).eq("job_id", job.id || job.job_id)
      .order("created_at", { ascending: false });
    const existing = (rows || []).find(r => !["applied", "skipped"].includes(r.status));
    if (existing) {
      if (existing.status === "queued" || existing.status === "ready") {
        await refresh();
        return null; // already in progress or ready — caller skips generation
      }
      // status === "failed": reset so it can be regenerated
      await supabase.from(TABLE).update({ status: "queued" }).eq("id", existing.id);
      _activeGenerations.add(existing.id);
      await refresh();
      return { ...existing, status: "queued" };
    }
    const { data, error } = await supabase
      .from(TABLE)
      .insert({ user_id: userId, job_id: job.id || job.job_id, job_title: job.title, company: job.company, job_description: (job.description || "").slice(0, 1200), resume_id: resumeId || null, status: "queued" })
      .select().single();
    if (error) {
      console.error("smart_apply_queue insert failed:", error.code, error.message, { userId, job_id: job.id || job.job_id });
      throw error;
    }
    _activeGenerations.add(data.id);
    await refresh();
    return data;
  }, [refresh]);

  // Step 2: fill in the AI-generated bundle and flip status to "ready".
  const markReady = useCallback(async (id, aiResult) => {
    _activeGenerations.delete(id);
    const { error } = await supabase.from(TABLE).update({
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
      status: "ready",
    }).eq("id", id);
    if (error) {
      console.error("markReady failed:", error.code, error.message, { id });
      throw error;
    }
    await refresh();
  }, [refresh]);

  // Mark a row as failed (keeps it visible for retry) instead of deleting it.
  const markFailed = useCallback(async (id) => {
    _activeGenerations.delete(id);
    await supabase.from(TABLE).update({ status: "failed" }).eq("id", id);
    await refresh();
  }, [refresh]);

  // Reset a failed row back to queued so AI generation can be retried.
  const resetToQueued = useCallback(async (id) => {
    await supabase.from(TABLE).update({ status: "queued" }).eq("id", id);
    _activeGenerations.add(id);
    await refresh();
  }, [refresh]);

  const markApplied = useCallback(async (id, applicationId) => {
    const { error } = await supabase.from(TABLE).update({ status: "applied", application_id: applicationId }).eq("id", id);
    if (error) throw error;
    await refresh();
  }, [refresh]);

  // Permanently delete all non-applied queue entries for a given job_id.
  // Called when the user removes a saved job so stale queue cards don't linger.
  const purgeByJobId = useCallback(async (jobId) => {
    if (!userId || !jobId) return;
    const { error } = await supabase
      .from(TABLE)
      .delete()
      .eq("user_id", userId)
      .eq("job_id", jobId)
      .neq("status", "applied"); // preserve applied history
    if (error) console.error("purgeByJobId failed:", error.code, error.message, { jobId });
    await refresh();
  }, [userId, refresh]);

  // Partially update document fields on a queue row (camelCase patch → snake_case DB columns).
  // Used by PackageView to persist user edits to individual documents.
  const patchQueueItem = useCallback(async (id, patch) => {
    const dbPatch = {};
    if (patch.tailoredResume !== undefined) dbPatch.tailored_resume = patch.tailoredResume;
    if (patch.coverLetter !== undefined) dbPatch.cover_letter = patch.coverLetter;
    if (patch.recruiterMessage !== undefined) dbPatch.recruiter_message = patch.recruiterMessage;
    if (patch.networkingMessage !== undefined) dbPatch.networking_message = patch.networkingMessage;
    if (patch.jobChangeAnalysis !== undefined) dbPatch.job_change_analysis = patch.jobChangeAnalysis;
    const { error } = await supabase.from(TABLE).update(dbPatch).eq("id", id);
    if (error) throw error;
    await refresh();
  }, [refresh]);

  return { queue, loading, enqueue, markReady, markFailed, resetToQueued, markApplied, purgeByJobId, patchQueueItem, refresh };
}

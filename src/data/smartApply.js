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
      if (existing.status === "queued" || existing.status === "ready" || existing.status === "needs_review") {
        await refresh();
        return null; // already in progress, ready, or awaiting manual review — caller skips generation
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
    // Defensive: a successful insert().select().single() should always return a row
    // with an id. If it somehow doesn't, adding `undefined` to _activeGenerations would
    // silently fail to protect this row from the very next refresh()'s orphan cleanup
    // (which marks any "queued" row not in this set as "failed") — fail loudly instead.
    if (!data?.id) throw new Error("smart_apply_queue insert returned no row id");
    _activeGenerations.add(data.id);
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
      salary_insight: aiResult.salaryInsight || null,
      company_insight: aiResult.companyInsight || null,
      status: "ready",
    }).eq("id", id);
    if (error) {
      _activeGenerations.delete(id);
      console.error("markReady failed:", error.code, error.message, { id });
      throw error;
    }
    // Remove from active set only after the DB commit succeeds. Removing it
    // before the UPDATE causes a race: a concurrent refresh() sees the row as
    // "queued" without an active-generation entry and flags it as an orphan,
    // which then writes status="failed" and can win the UPDATE race against us.
    _activeGenerations.delete(id);
    await refresh();
  }, [refresh]);

  // Same persistence as markReady, but for packages that failed Package Integrity
  // Validation. Content is still saved (so it's visible/editable in PackageView) but
  // status is "needs_review" instead of "ready", keeping it out of the Apply-ready queue.
  const markNeedsReview = useCallback(async (id, aiResult) => {
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
      status: "needs_review",
    }).eq("id", id);
    if (error) {
      _activeGenerations.delete(id);
      console.error("markNeedsReview failed:", error.code, error.message, { id });
      throw error;
    }
    _activeGenerations.delete(id);
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
  // Used by PackageView to persist user edits to individual documents. Also accepts an
  // optional `status` so an edit can atomically re-validate and flip needs_review <-> ready
  // in the same write, instead of a separate round trip.
  const patchQueueItem = useCallback(async (id, patch) => {
    const dbPatch = {};
    if (patch.tailoredResume !== undefined) dbPatch.tailored_resume = patch.tailoredResume;
    if (patch.coverLetter !== undefined) dbPatch.cover_letter = patch.coverLetter;
    if (patch.recruiterMessage !== undefined) dbPatch.recruiter_message = patch.recruiterMessage;
    if (patch.networkingMessage !== undefined) dbPatch.networking_message = patch.networkingMessage;
    if (patch.jobChangeAnalysis !== undefined) dbPatch.job_change_analysis = patch.jobChangeAnalysis;
    if (patch.status !== undefined) dbPatch.status = patch.status;
    const { error } = await supabase.from(TABLE).update(dbPatch).eq("id", id);
    if (error) throw error;
    await refresh();
  }, [refresh]);

  return { queue, loading, enqueue, markReady, markNeedsReview, markFailed, resetToQueued, markApplied, purgeByJobId, patchQueueItem, refresh };
}

-- CareerPersona AI — Phase 8, Finding C3 (database layer) — full account lockout
--
-- The C3 Worker/API fix (requireAuth's deletion-status check) closed the
-- Worker-mediated half of the account-deletion lock. The follow-up read-only
-- audit found that ~27 feature tables, plus the "resumes" Storage bucket, are
-- written directly from the browser via the Supabase client, entirely
-- bypassing the Worker -- so a deletion-locked user with a still-valid
-- session could keep creating/editing/deleting feature data and uploading or
-- deleting resume files directly against Supabase's REST/Storage APIs, even
-- though the Worker itself was already fully locked down.
--
-- This migration closes that remaining gap with a single reusable trigger
-- function, following the exact additive pattern already proven safe in
-- 20260818000000_protect_account_deletion_columns.sql (C2): allow
-- service_role/postgres through unconditionally, otherwise look up the
-- acting user's own profiles.deletion_status and reject the write if it's
-- 'scheduled' or 'in_progress'. It is purely additive -- it does not modify
-- 20260811000000_account_deletion.sql or 20260818000000_protect_account_
-- deletion_columns.sql, does not touch any existing RLS policy, and does not
-- replace or remove the existing billing_column_protection trigger (which
-- keeps doing its own, narrower job: rejecting writes to the 9 billing +
-- 3 deletion-lifecycle columns on profiles regardless of deletion_status).
--
-- The guard only ever fires on INSERT/UPDATE/DELETE (BEFORE ROW). SELECT is
-- structurally untouched -- Postgres triggers never fire for SELECT -- so
-- Export My Data (which only ever reads) and every other read path keep
-- working unchanged for a locked account, exactly as required.
--
-- One function, reused across all 27 feature tables AND the "resumes"
-- Storage bucket (storage.objects is a real, trigger-capable table; the
-- bucket scoping for Storage is expressed in the trigger's WHEN clause, not
-- hardcoded into the function, so the same function serves both cases).

CREATE OR REPLACE FUNCTION public.deletion_lock_guard()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  is_locked boolean;
BEGIN
  -- Same bypass as protect_billing_columns(): service_role (the Worker) and
  -- postgres (migrations, pg_cron, direct admin access) are never subject to
  -- this guard -- request-deletion, cancel-deletion, and the purge scheduler
  -- all run under service_role and must be unaffected.
  IF auth.role() IS NULL OR auth.role() IN ('service_role', 'postgres') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT (deletion_status IN ('scheduled', 'in_progress'))
    INTO is_locked
    FROM public.profiles
    WHERE id = auth.uid();

  IF is_locked THEN
    RAISE EXCEPTION 'This account is scheduled for deletion. Writes are disabled until deletion is cancelled.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- One BEFORE INSERT OR UPDATE OR DELETE trigger per feature table, all using
-- the same shared function above. Ownership (which row belongs to whom) is
-- still entirely governed by each table's existing RLS policy, unchanged by
-- this migration -- this guard only adds an additional "is the acting user
-- currently deletion-locked" check on top of that, never a "whose row is
-- this" check.
CREATE TRIGGER deletion_lock_profiles BEFORE INSERT OR UPDATE OR DELETE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_profile_details BEFORE INSERT OR UPDATE OR DELETE ON public.profile_details FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_applications BEFORE INSERT OR UPDATE OR DELETE ON public.applications FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_saved_jobs BEFORE INSERT OR UPDATE OR DELETE ON public.saved_jobs FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_networking_contacts BEFORE INSERT OR UPDATE OR DELETE ON public.networking_contacts FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_networking_sessions BEFORE INSERT OR UPDATE OR DELETE ON public.networking_sessions FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_interview_sessions BEFORE INSERT OR UPDATE OR DELETE ON public.interview_sessions FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_salary_research BEFORE INSERT OR UPDATE OR DELETE ON public.salary_research FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_linkedin_profile_analyses BEFORE INSERT OR UPDATE OR DELETE ON public.linkedin_profile_analyses FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_referral_analyses BEFORE INSERT OR UPDATE OR DELETE ON public.referral_analyses FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_ai_briefings BEFORE INSERT OR UPDATE OR DELETE ON public.ai_briefings FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_ai_action_plans BEFORE INSERT OR UPDATE OR DELETE ON public.ai_action_plans FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_career_progress_analysis BEFORE INSERT OR UPDATE OR DELETE ON public.career_progress_analysis FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_job_intelligence_analysis BEFORE INSERT OR UPDATE OR DELETE ON public.job_intelligence_analysis FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_resume_analysis_history BEFORE INSERT OR UPDATE OR DELETE ON public.resume_analysis_history FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_job_watchlist BEFORE INSERT OR UPDATE OR DELETE ON public.job_watchlist FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_company_watchlist BEFORE INSERT OR UPDATE OR DELETE ON public.company_watchlist FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_notifications BEFORE INSERT OR UPDATE OR DELETE ON public.notifications FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_automation_preferences BEFORE INSERT OR UPDATE OR DELETE ON public.automation_preferences FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_outcome_patterns BEFORE INSERT OR UPDATE OR DELETE ON public.outcome_patterns FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_outcome_analyses BEFORE INSERT OR UPDATE OR DELETE ON public.outcome_analyses FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_recommendation_evaluations BEFORE INSERT OR UPDATE OR DELETE ON public.recommendation_evaluations FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_smart_apply_queue BEFORE INSERT OR UPDATE OR DELETE ON public.smart_apply_queue FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_assistant_conversations BEFORE INSERT OR UPDATE OR DELETE ON public.assistant_conversations FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_assistant_messages BEFORE INSERT OR UPDATE OR DELETE ON public.assistant_messages FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_user_resumes BEFORE INSERT OR UPDATE OR DELETE ON public.user_resumes FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();
CREATE TRIGGER deletion_lock_activity_log BEFORE INSERT OR UPDATE OR DELETE ON public.activity_log FOR EACH ROW EXECUTE FUNCTION public.deletion_lock_guard();

-- Storage: same guard function, scoped to the "resumes" bucket only via each
-- trigger's WHEN clause rather than hardcoding the bucket name into the
-- shared function body. Split into an INSERT/UPDATE trigger (WHEN can
-- reference NEW) and a separate DELETE trigger (WHEN can only reference OLD
-- -- Postgres rejects a combined INSERT/UPDATE/DELETE trigger whose WHEN
-- clause references NEW, since a DELETE has no NEW row at all) rather than
-- one combined trigger. SELECT (and therefore createSignedUrl, which reads
-- rather than writes) is unaffected -- neither trigger fires for SELECT,
-- matching the "reads must remain available" and "Export My Data must keep
-- working" requirements exactly.
CREATE TRIGGER deletion_lock_resumes_storage_write
  BEFORE INSERT OR UPDATE ON storage.objects
  FOR EACH ROW
  WHEN (NEW.bucket_id = 'resumes')
  EXECUTE FUNCTION public.deletion_lock_guard();

CREATE TRIGGER deletion_lock_resumes_storage_delete
  BEFORE DELETE ON storage.objects
  FOR EACH ROW
  WHEN (OLD.bucket_id = 'resumes')
  EXECUTE FUNCTION public.deletion_lock_guard();

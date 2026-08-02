import { useSyncedList } from "./syncList";
import { supabase } from "../lib/supabaseClient";

const TABLE = "applications";
const LOCAL_KEY = "cp_apps";

// Application Outcome Intelligence's response_status is derived from the Tracker's
// own (richer) status, never entered separately -- avoids maintaining two parallel
// status fields that could drift. See docs/Application Outcome Intelligence Locked
// Blueprint.md, "Locked Implementation Decisions".
export const RESPONSE_STATUS_FROM_STATUS = {
  Applied: "pending",
  "Phone Screen": "interview_invited",
  Interview: "interview_invited",
  "Final Interview": "interview_invited",
  Offer: "offer",
  Rejected: "rejected",
  Withdrawn: "withdrawn",
  Ghosted: "ghosted",
};
export const isInterviewStage = (status) => status === "Phone Screen" || status === "Interview" || status === "Final Interview";

const toRow = (a, userId) => ({
  id: a.id,
  user_id: userId,
  company: a.company,
  job_title: a.jobTitle,
  status: a.status,
  date_applied: a.date || null,
  follow_up_date: a.followUpDate || null,
  contact_name: a.contactName || null,
  contact_email: a.contactEmail || null,
  apply_url: a.url || null,
  notes: a.notes || null,
  ats_score: a.atsScore !== "" && a.atsScore != null ? Number(a.atsScore) : null,
  resume_used: a.resume || null,
  cover_letter: a.coverLetter || null,
  resume_id: a.resumeId || null,
  response_status: RESPONSE_STATUS_FROM_STATUS[a.status] || "pending",
  response_received_at: a.responseReceivedAt || null,
  rejection_stage: a.rejectionStage || null,
  first_interview_at: a.firstInterviewAt || null,
  application_source: a.applicationSource || null,
  cover_letter_sent: !!a.coverLetterSent,
  smart_apply_used: !!a.smartApplyUsed,
  smart_apply_queue_item_id: a.smartApplyQueueItemId || null,
  smart_apply_score: a.smartApplyScore ?? null,
  days_since_posted: a.daysSincePosted ?? null,
  company_size_estimate: a.companySizeEstimate || null,
  industry: a.industry || null,
  remote_policy: a.remotePolicy || null,
  referral_used: !!a.referralUsed,
  salary_range_min: a.salaryRangeMin ?? null,
  salary_range_max: a.salaryRangeMax ?? null,
});

const fromRow = (r) => ({
  id: r.id,
  company: r.company,
  jobTitle: r.job_title,
  status: r.status,
  date: r.date_applied || "",
  followUpDate: r.follow_up_date || "",
  contactName: r.contact_name || "",
  contactEmail: r.contact_email || "",
  url: r.apply_url || "",
  notes: r.notes || "",
  atsScore: r.ats_score != null ? String(r.ats_score) : "",
  resume: r.resume_used || "",
  coverLetter: r.cover_letter || "",
  resumeId: r.resume_id || null,
  responseStatus: r.response_status || "pending",
  responseReceivedAt: r.response_received_at || null,
  rejectionStage: r.rejection_stage || "",
  firstInterviewAt: r.first_interview_at || null,
  applicationSource: r.application_source || "",
  coverLetterSent: !!r.cover_letter_sent,
  smartApplyUsed: !!r.smart_apply_used,
  smartApplyQueueItemId: r.smart_apply_queue_item_id || null,
  smartApplyScore: r.smart_apply_score ?? null,
  daysSincePosted: r.days_since_posted ?? null,
  companySizeEstimate: r.company_size_estimate || "",
  industry: r.industry || "",
  remotePolicy: r.remote_policy || "",
  referralUsed: !!r.referral_used,
  salaryRangeMin: r.salary_range_min != null ? String(r.salary_range_min) : "",
  salaryRangeMax: r.salary_range_max != null ? String(r.salary_range_max) : "",
});

export function useApplications(userId) {
  return useSyncedList(TABLE, LOCAL_KEY, userId, toRow, fromRow, "id");
}

// Direct, synchronous insert — used when another table's row needs to point at
// this application via a foreign key (e.g. smart_apply_queue.application_id)
// and can't wait for useSyncedList's deferred background sync to catch up.
export async function insertApplicationRow(userId, app) {
  const { error } = await supabase.from(TABLE).insert(toRow(app, userId));
  if (error) throw error;
}

// Direct upsert — used by TrackerPage save/edit so failures surface to the UI
// immediately rather than being swallowed by syncListDiff's fire-and-forget pattern.
// syncListDiff will fire again after setApplications but the row is already in DB
// so the redundant upsert is a no-op.
export async function upsertApplicationRow(userId, app) {
  if (!userId) throw new Error("upsertApplicationRow: userId is required");
  console.log(`[Tracker] 💾 Upserting application id=${app.id} user=${userId}`);
  const { error } = await supabase
    .from(TABLE)
    .upsert(toRow(app, userId), { onConflict: "id" });
  if (error) {
    console.error(`[Tracker] ❌ Upsert failed:`, error.code, error.message, { id: app.id });
    throw error;
  }
  console.log(`[Tracker] ✅ Upsert confirmed in Supabase id=${app.id}`);
}

// Confirmed delete — waits for Supabase to acknowledge removal before the caller
// updates local state. Explicit user_id filter ensures the DELETE passes RLS.
// 0 rows deleted is NOT an error: it means the item was local-only (syncListDiff
// upsert may have failed silently). Only throw on an actual Supabase error so
// that local-only items can always be removed from state without surfacing a
// spurious "Delete failed" message.
export async function deleteApplicationRow(userId, id) {
  if (!userId) throw new Error("deleteApplicationRow: userId is required (not signed in)");
  console.log(`[Tracker] 🗑️ Deleting application id=${id} user=${userId}`);
  const { data, error } = await supabase
    .from(TABLE)
    .delete()
    .eq("id", id)
    .eq("user_id", userId)
    .select("id");
  if (error) {
    console.error(`[Tracker] ❌ Delete failed:`, error.code, error.message, { id, userId });
    throw error;
  }
  if (!data?.length) {
    // Row wasn't in the DB (local-only item — syncListDiff upsert may have failed).
    // This is safe: no DB row means no ghost-restore on refresh.
    console.warn(`[Tracker] ⚠️ No DB row for id=${id} — item was local-only, removing from state`);
  } else {
    console.log(`[Tracker] ✅ Delete confirmed in Supabase id=${id}`);
  }
}

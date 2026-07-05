import { useSyncedList } from "./syncList";
import { supabase } from "../lib/supabaseClient";

const TABLE = "applications";
const LOCAL_KEY = "cp_apps";

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

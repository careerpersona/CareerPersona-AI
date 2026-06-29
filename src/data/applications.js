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

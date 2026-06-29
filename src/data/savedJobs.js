import { useSyncedList } from "./syncList";

const TABLE = "saved_jobs";
const LOCAL_KEY = "cp_saved";

const toRow = (j, userId) => ({
  user_id: userId,
  job_id: j.job_id,
  title: j.title,
  company: j.company,
  location: j.location || null,
  salary_min: j.salaryMin || null,
  salary_max: j.salaryMax || null,
  employment_type: j.employmentType || null,
  remote: !!j.remote,
  description: j.description || null,
  apply_url: j.applyUrl || null,
  source: j.source || null,
  date_posted: j.datePosted || null,
  match_score: j.matchScore != null ? Number(j.matchScore) : null,
  ats_score: j.atsScore != null ? Number(j.atsScore) : null,
});

const fromRow = (r) => ({
  job_id: r.job_id,
  id: r.job_id,
  title: r.title,
  company: r.company,
  location: r.location || "",
  salaryMin: r.salary_min,
  salaryMax: r.salary_max,
  employmentType: r.employment_type || "",
  remote: r.remote,
  description: r.description || "",
  applyUrl: r.apply_url || "",
  source: r.source || "",
  datePosted: r.date_posted || "",
  matchScore: r.match_score,
  atsScore: r.ats_score,
  saved_at: r.created_at,
});

export function useSavedJobs(userId) {
  return useSyncedList(TABLE, LOCAL_KEY, userId, toRow, fromRow, "job_id");
}

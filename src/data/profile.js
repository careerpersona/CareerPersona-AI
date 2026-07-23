import { supabase } from "../lib/supabaseClient";

// Merges the existing `profiles` table with the additive `profile_details`
// table into the flat shape the rest of the app already expects
// (same field names as the old localStorage cp_user object).
export async function fetchProfile(userId, email) {
  const [{ data: base }, { data: details }] = await Promise.all([
    supabase.from("profiles").select("*").eq("id", userId).maybeSingle(),
    supabase.from("profile_details").select("*").eq("user_id", userId).maybeSingle(),
  ]);

  return {
    id: userId,
    email: base?.email || email,
    full_name: base?.full_name || "",
    phone: base?.phone || "",
    location: base?.location || "",
    job_title: base?.job_title || "",
    years_experience: base?.years_experience || "",
    plan: base?.plan || "free",
    subscription_status: base?.subscription_status || "no_subscription",
    stripe_customer_id: base?.stripe_customer_id || null,
    trial_ends_at: base?.trial_ends_at || null,
    email_address: details?.email_address || "",
    preferred_job_title: details?.preferred_job_title || "",
    preferred_industry: details?.preferred_industry || "",
    work_type: details?.work_type || "",
    desired_salary: details?.desired_salary || "",
    preferred_language: details?.preferred_language || "en",
    job_language: details?.job_language || "en",
    career_goal: details?.career_goal || "",
    career_timeline: details?.career_timeline || "",
  };
}

export async function upsertProfile(userId, updates) {
  const baseFields = ["full_name", "phone", "location", "job_title", "years_experience"];
  const detailFields = ["email_address", "preferred_job_title", "preferred_industry", "work_type", "desired_salary", "preferred_language", "job_language", "career_goal", "career_timeline"];

  const baseUpdate = Object.fromEntries(baseFields.filter(f => f in updates).map(f => [f, updates[f]]));
  const detailUpdate = Object.fromEntries(detailFields.filter(f => f in updates).map(f => [f, updates[f]]));

  await Promise.all([
    Object.keys(baseUpdate).length
      ? supabase.from("profiles").update(baseUpdate).eq("id", userId)
      : Promise.resolve(),
    Object.keys(detailUpdate).length
      ? supabase.from("profile_details").upsert({ user_id: userId, ...detailUpdate })
      : Promise.resolve(),
  ]);
}

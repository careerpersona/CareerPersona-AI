import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

const TABLE = "user_resumes";
const BUCKET = "resumes";

export function useResumes(userId) {
  const [resumes, setResumes] = useState([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId) { setResumes([]); return; }
    setLoading(true);
    const { data, error } = await supabase.from(TABLE).select("*").eq("user_id", userId).order("created_at", { ascending: false });
    if (!error && data) setResumes(data);
    setLoading(false);
  }, [userId]);

  useEffect(() => { refresh(); }, [refresh]);

  // file is an optional browser File object (the original upload); content is the
  // extracted/pasted text that's already shown in the page's textarea.
  const saveResume = useCallback(async (name, content, file) => {
    if (!userId) throw new Error("Not signed in");
    let file_url = null;
    let file_type = null;
    if (file) {
      try {
        const ext = file.name.split(".").pop().toLowerCase();
        const path = `${userId}/${Date.now()}_${file.name}`;
        const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false });
        if (upErr) {
          // Storage bucket may not exist yet — save content only (non-fatal).
          console.warn("Resume file storage unavailable:", upErr.message, "— saving content only");
        } else {
          file_url = path;
          file_type = ext;
        }
      } catch (storageErr) {
        console.warn("Resume storage threw:", storageErr?.message, "— saving content only");
      }
    }
    const { data, error } = await supabase
      .from(TABLE)
      .insert({ user_id: userId, name: name || "My Resume", content, file_url, file_type })
      .select()
      .single();
    if (error) {
      console.error("user_resumes insert failed:", error.code, error.message);
      throw error;
    }
    await refresh();
    return data;
  }, [userId, refresh]);

  const deleteResume = useCallback(async (resume) => {
    console.log(`[Resume] 🗑️ Deleting resume id=${resume.id} name="${resume.name}" user=${userId}`);

    // Null out FK references in smart_apply_queue first — the queue table has
    // resume_id uuid references user_resumes(id) with no on-delete action, so
    // deleting a resume that was used in a package would fail with a constraint
    // violation. Setting resume_id to null preserves the generated packages.
    const { error: fkError } = await supabase
      .from("smart_apply_queue")
      .update({ resume_id: null })
      .eq("resume_id", resume.id)
      .eq("user_id", userId);
    if (fkError) {
      console.warn(`[Resume] ⚠️ FK null-out failed (will attempt delete anyway):`, fkError.code, fkError.message);
    } else {
      console.log(`[Resume] ✅ FK references cleared in smart_apply_queue`);
    }

    if (resume.file_url) {
      const { error: storErr } = await supabase.storage.from(BUCKET).remove([resume.file_url]);
      if (storErr) console.warn(`[Resume] ⚠️ Storage file delete failed (non-fatal):`, storErr.message);
      else console.log(`[Resume] ✅ Storage file removed`);
    }

    console.log(`[Resume] ⏳ Deleting DB row id=${resume.id}`);
    const { error } = await supabase.from(TABLE).delete().eq("id", resume.id).eq("user_id", userId);
    if (error) {
      console.error(`[Resume] ❌ Delete failed:`, error.code, error.message, { id: resume.id });
      throw error;
    }
    console.log(`[Resume] ✅ DB row deleted, refreshing list`);
    await refresh();
  }, [userId, refresh]);

  const downloadResume = useCallback(async (resume) => {
    if (!resume.file_url) return null;
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(resume.file_url, 60);
    if (error) throw error;
    return data.signedUrl;
  }, []);

  const setDefaultResume = useCallback(async (resume) => {
    await supabase.from(TABLE).update({ is_default: false }).eq("user_id", userId).neq("id", resume.id);
    await supabase.from(TABLE).update({ is_default: true }).eq("id", resume.id);
    await refresh();
  }, [userId, refresh]);

  const saveAnalysis = useCallback(async (resumeId, analysis) => {
    if (!userId || !resumeId || !analysis) return;
    const { error } = await supabase.from(TABLE).update({
      ats_score: analysis.atsScore ?? null,
      potential_ats_score: analysis.potentialAtsScore ?? null,
      keywords_found: analysis.keywordsFound ?? null,
      keywords_missing: analysis.keywordsMissing ?? null,
      suggestions: analysis.suggestions ?? null,
      score_breakdown: analysis.scoreBreakdown ?? null,
      top_priority: analysis.suggestions?.[0] ?? null,
      last_analyzed_at: new Date().toISOString(),
    }).eq("id", resumeId).eq("user_id", userId);
    if (error) throw error;
    await refresh();
  }, [userId, refresh]);

  const updateVersionLabel = useCallback(async (resumeId, label) => {
    if (!userId || !resumeId) return;
    const { error } = await supabase.from(TABLE).update({ version_label: label || null }).eq("id", resumeId).eq("user_id", userId);
    if (error) throw error;
    await refresh();
  }, [userId, refresh]);

  return { resumes, loading, saveResume, deleteResume, downloadResume, setDefaultResume, refresh, saveAnalysis, updateVersionLabel };
}

const HISTORY_TABLE = "resume_analysis_history";
const HISTORY_CACHE_KEY = (userId) => `cp_resume_history_${userId}`;

export function useResumeHistory(userId) {
  const [entries, setEntries] = useState([]);

  const refresh = useCallback(async () => {
    if (!userId) { setEntries([]); return; }
    const { data, error } = await supabase
      .from(HISTORY_TABLE)
      .select("*")
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (!error && data) {
      const normalised = data.map(rowToEntry);
      setEntries(normalised);
      try { localStorage.setItem(HISTORY_CACHE_KEY(userId), JSON.stringify(normalised)); } catch {}
    }
  }, [userId]);

  // Hydrate from localStorage cache immediately so the UI isn't blank
  // while the Supabase call is in flight.
  useEffect(() => {
    if (!userId) return;
    try {
      const cached = JSON.parse(localStorage.getItem(HISTORY_CACHE_KEY(userId)) || "[]");
      if (cached.length > 0) setEntries(cached);
    } catch {}
  }, [userId]);

  useEffect(() => { refresh(); }, [refresh]);

  const saveEntry = useCallback(async (entry, resumeId = null) => {
    if (!userId) return;
    const { data, error } = await supabase
      .from(HISTORY_TABLE)
      .insert({
        user_id: userId,
        resume_id: resumeId || null,
        resume_name: entry.resumeName || null,
        ats_score: entry.atsScore ?? null,
        potential_ats_score: entry.potentialAtsScore ?? null,
        job_title: entry.jobTitle || null,
        company: entry.company || null,
        analysis_type: entry.analysisType || "Initial Analysis",
        analysis_mode: entry.analysisMode || null,
        resume_status: entry.resumeStatus || null,
        resume_health: entry.resumeHealth || null,
      })
      .select()
      .single();
    if (error) throw error;
    const normalised = rowToEntry(data);
    setEntries(prev => {
      const updated = [normalised, ...prev].slice(0, 50);
      try { localStorage.setItem(HISTORY_CACHE_KEY(userId), JSON.stringify(updated)); } catch {}
      return updated;
    });
    return normalised;
  }, [userId]);

  return { entries, saveEntry, refresh };
}

function rowToEntry(r) {
  return {
    id: r.id,
    date: r.created_at,
    resumeName: r.resume_name || "",
    atsScore: r.ats_score,
    potentialAtsScore: r.potential_ats_score,
    jobTitle: r.job_title || "",
    company: r.company || "",
    analysisType: r.analysis_type,
    analysisMode: r.analysis_mode || null,
    resumeStatus: r.resume_status || null,
    resumeHealth: r.resume_health || null,
  };
}

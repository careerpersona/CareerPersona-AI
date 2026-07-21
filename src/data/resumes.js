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
    if (!error && data) {
      // Sort by most-recently-analyzed first; fall back to created_at for unanalyzed resumes.
      const sorted = [...data].sort((a, b) => {
        const aTime = new Date(a.last_analyzed_at || a.created_at);
        const bTime = new Date(b.last_analyzed_at || b.created_at);
        return bTime - aTime;
      });
      setResumes(sorted);
    }
    setLoading(false);
  }, [userId]);

  useEffect(() => { refresh(); }, [refresh]);

  // file is an optional browser File object (the original upload); content is the
  // extracted/pasted text that's already shown in the page's textarea.
  // langMeta: optional { language, detected_language, language_confidence }
  const saveResume = useCallback(async (name, content, file, langMeta) => {
    if (!userId) throw new Error("Not signed in");

    // Deduplicate: if the same resume content is already saved, update the name
    // and return the existing record instead of creating a duplicate entry.
    if (content?.trim()) {
      const fingerprint = content.trim().slice(0, 400);
      const { data: existing } = await supabase.from(TABLE).select("id, name, content").eq("user_id", userId);
      const match = existing?.find(r => r.content?.trim().slice(0, 400) === fingerprint);
      if (match) {
        if (name && match.name !== name) {
          await supabase.from(TABLE).update({ name }).eq("id", match.id).eq("user_id", userId);
        }
        await refresh();
        return { ...match, name: name || match.name };
      }
    }

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
    const insertRow = { user_id: userId, name: name || "My Resume", content, file_url, file_type };
    if (langMeta?.language) insertRow.language = langMeta.language;
    if (langMeta?.detected_language) insertRow.detected_language = langMeta.detected_language;
    if (langMeta?.language_confidence != null) insertRow.language_confidence = langMeta.language_confidence;
    const { data, error } = await supabase
      .from(TABLE)
      .insert(insertRow)
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

  const saveAnalysis = useCallback(async (resumeId, analysis, content = null) => {
    if (!userId || !resumeId || !analysis) return;
    const updateData = {
      ats_score: analysis.atsScore ?? null,
      potential_ats_score: analysis.potentialAtsScore ?? null,
      keywords_found: analysis.keywordsFound ?? null,
      keywords_missing: analysis.keywordsMissing ?? null,
      suggestions: analysis.suggestions ?? null,
      score_breakdown: analysis.scoreBreakdown ?? null,
      top_priority: analysis.suggestions?.[0] ?? null,
      last_analyzed_at: new Date().toISOString(),
    };
    if (content?.trim()) updateData.content = content.trim();
    const { error } = await supabase.from(TABLE).update(updateData).eq("id", resumeId).eq("user_id", userId);
    if (error) throw error;
    await refresh();
  }, [userId, refresh]);

  const updateVersionLabel = useCallback(async (resumeId, label) => {
    if (!userId || !resumeId) return;
    const { error } = await supabase.from(TABLE).update({ version_label: label || null }).eq("id", resumeId).eq("user_id", userId);
    if (error) throw error;
    await refresh();
  }, [userId, refresh]);

  const updateResumeLanguage = useCallback(async (resumeId, language, detectedLanguage, confidence) => {
    if (!userId || !resumeId) return;
    const upd = {};
    if (language !== undefined) upd.language = language;
    if (detectedLanguage !== undefined) upd.detected_language = detectedLanguage;
    if (confidence !== undefined) upd.language_confidence = confidence;
    if (!Object.keys(upd).length) return;
    const { error } = await supabase.from(TABLE).update(upd).eq("id", resumeId).eq("user_id", userId);
    if (error) throw error;
    await refresh();
  }, [userId, refresh]);

  return { resumes, loading, saveResume, deleteResume, downloadResume, setDefaultResume, refresh, saveAnalysis, updateVersionLabel, updateResumeLanguage };
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

    // Prevent duplicate history entries: if a row already exists for the same
    // resume + job title + analysis type, update it instead of inserting a new one.
    let existingId = null;
    try {
      const analysisType = entry.analysisType || "Initial Analysis";
      let query = supabase
        .from(HISTORY_TABLE)
        .select("id")
        .eq("user_id", userId)
        .eq("analysis_type", analysisType);
      if (resumeId) {
        query = query.eq("resume_id", resumeId);
      } else if (entry.resumeName) {
        query = query.eq("resume_name", entry.resumeName);
      }
      if (entry.jobTitle) query = query.eq("job_title", entry.jobTitle);
      const { data: found } = await query.order("created_at", { ascending: false }).limit(1);
      if (found?.[0]?.id) existingId = found[0].id;
    } catch {}

    let data, error;
    if (existingId) {
      const result = await supabase
        .from(HISTORY_TABLE)
        .update({
          ats_score: entry.atsScore ?? null,
          potential_ats_score: entry.potentialAtsScore ?? null,
          resume_status: entry.resumeStatus || null,
          resume_health: entry.resumeHealth || null,
          analysis_mode: entry.analysisMode || null,
        })
        .eq("id", existingId)
        .select()
        .single();
      data = result.data; error = result.error;
    } else {
      const result = await supabase
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
      data = result.data; error = result.error;
    }

    if (error) throw error;
    const normalised = rowToEntry(data);
    setEntries(prev => {
      // Remove the old entry (if updated) so it re-appears at the top with fresh data.
      const filtered = existingId ? prev.filter(e => e.id !== existingId) : prev;
      const updated = [normalised, ...filtered].slice(0, 50);
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
    resumeId: r.resume_id || null,
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

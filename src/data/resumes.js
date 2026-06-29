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
      const ext = file.name.split(".").pop().toLowerCase();
      const path = `${userId}/${Date.now()}_${file.name}`;
      const { error: upErr } = await supabase.storage.from(BUCKET).upload(path, file, { upsert: false });
      if (upErr) throw upErr;
      file_url = path;
      file_type = ext;
    }
    const { data, error } = await supabase
      .from(TABLE)
      .insert({ user_id: userId, name: name || "My Resume", content, file_url, file_type })
      .select()
      .single();
    if (error) throw error;
    await refresh();
    return data;
  }, [userId, refresh]);

  const deleteResume = useCallback(async (resume) => {
    if (resume.file_url) {
      await supabase.storage.from(BUCKET).remove([resume.file_url]).catch(() => {});
    }
    const { error } = await supabase.from(TABLE).delete().eq("id", resume.id);
    if (error) throw error;
    await refresh();
  }, [refresh]);

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

  return { resumes, loading, saveResume, deleteResume, downloadResume, setDefaultResume, refresh };
}

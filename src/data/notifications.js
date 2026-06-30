import { useState, useEffect, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

const TABLE = "notifications";

const fromRow = (r) => ({
  id: r.id,
  type: r.type,
  title: r.title,
  body: r.body || "",
  linkPage: r.link_page || null,
  read: !!r.read,
  time: new Date(r.created_at).toLocaleString(),
});

export function useNotifications(userId) {
  const [notifications, setNotifications] = useState([]);

  const refresh = useCallback(async () => {
    if (!userId) { setNotifications([]); return; }
    const { data, error } = await supabase
      .from(TABLE).select("*").eq("user_id", userId).order("created_at", { ascending: false }).limit(20);
    if (!error && data) setNotifications(data.map(fromRow));
  }, [userId]);

  useEffect(() => { refresh(); }, [refresh]);

  // Updates server-side by user_id (not by a client-held id list) so it can't
  // act on a stale snapshot of `notifications` from before a concurrent refresh.
  const markAllRead = useCallback(async () => {
    if (!userId) return;
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    const { error } = await supabase.from(TABLE).update({ read: true }).eq("user_id", userId).eq("read", false);
    if (error) console.error("markAllRead failed", error);
  }, [userId]);

  return { notifications, refresh, markAllRead };
}

// Plain insert used by other pages/components that generate notification-worthy
// events but don't otherwise need the live notifications list (e.g. the
// Dashboard's briefing/plan generators).
export async function insertNotification(userId, { type, title, body, linkPage }) {
  if (!userId) return;
  const { error } = await supabase.from(TABLE).insert({ user_id: userId, type, title, body: body || null, link_page: linkPage || null });
  if (error) console.error("insertNotification failed", error);
}

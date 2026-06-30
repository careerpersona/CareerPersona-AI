import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

const CONV_TABLE = "assistant_conversations";
const MSG_TABLE = "assistant_messages";

// The existing chat widget has no conversation list/switcher — just one
// ongoing conversation per user — so this finds-or-creates a single
// conversation row and appends each message to it as the chat happens.
//
// `loadedFor` tracks which userId the current messages/loading actually
// belong to. Without it, a consumer gating on "loading just became false"
// can be fooled by a stale render where the previous (e.g. undefined)
// user's effect already cleared loading right as the prop flips to the
// real userId, before that user's own fetch has even started.
export function useAssistantChat(userId) {
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadedFor, setLoadedFor] = useState(undefined);
  const conversationIdRef = useRef(null);

  useEffect(() => {
    let active = true;
    if (!userId) {
      setMessages([]); setLoadedFor(userId); setLoading(false);
      conversationIdRef.current = null;
      return;
    }
    setLoading(true);
    (async () => {
      const { data: convos, error: convErr } = await supabase
        .from(CONV_TABLE).select("id").eq("user_id", userId).order("updated_at", { ascending: false }).limit(1);
      if (!active) return;
      if (convErr || !convos || !convos.length) {
        conversationIdRef.current = null;
        setMessages([]); setLoadedFor(userId); setLoading(false);
        return;
      }
      conversationIdRef.current = convos[0].id;
      const { data: msgs, error: msgErr } = await supabase
        .from(MSG_TABLE).select("*").eq("conversation_id", convos[0].id).order("created_at", { ascending: true });
      if (!active) return;
      setMessages(!msgErr && msgs ? msgs.map(m => ({ role: m.role === "assistant" ? "ai" : "user", text: m.content })) : []);
      setLoadedFor(userId);
      setLoading(false);
    })();
    return () => { active = false; };
  }, [userId]);

  const addMessage = useCallback(async (role, text) => {
    if (!userId) return;
    if (!conversationIdRef.current) {
      const { data, error } = await supabase.from(CONV_TABLE).insert({ user_id: userId }).select().single();
      if (error) throw error;
      conversationIdRef.current = data.id;
    } else {
      await supabase.from(CONV_TABLE).update({ updated_at: new Date().toISOString() }).eq("id", conversationIdRef.current);
    }
    const dbRole = role === "ai" ? "assistant" : "user";
    const { error } = await supabase.from(MSG_TABLE).insert({ conversation_id: conversationIdRef.current, role: dbRole, content: text });
    if (error) throw error;
  }, [userId]);

  return { messages, loading, loadedFor, addMessage };
}

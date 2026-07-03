import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

// Diffs `prev` vs `next` (plain arrays, compared by `key`) and fires the
// minimal insert/update/delete calls against `table` in the background.
async function syncListDiff(table, prev, next, userId, toRow, key) {
  if (!userId) return;
  const prevById = new Map(prev.map(x => [x[key], x]));
  const nextIds = new Set(next.map(x => x[key]));

  const removed = prev.filter(x => !nextIds.has(x[key]));
  const changed = next.filter(x => {
    const old = prevById.get(x[key]);
    return !old || JSON.stringify(old) !== JSON.stringify(x);
  });

  try {
    if (removed.length) {
      await supabase.from(table).delete().eq("user_id", userId).in(key, removed.map(x => x[key]));
    }
    if (changed.length) {
      await supabase.from(table).upsert(changed.map(x => toRow(x, userId)));
    }
  } catch (err) {
    console.error(`syncListDiff(${table}) failed`, err);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One-time push of whatever is in localStorage for `localKey` into `table`,
// guarded by a per-user flag so it only ever runs once per browser/account.
// Uses upsert (not insert) to handle partial migrations and ID conflicts.
// Flag is only set on success — if the upsert fails, the next load retries.
// IDs that are not valid UUIDs are stripped so Supabase auto-generates them.
async function migrateLocalOnce(table, localKey, userId, toRow) {
  const flag = `${localKey}_migrated_v2_${userId}`;
  if (localStorage.getItem(flag)) return;
  let local = [];
  try { local = JSON.parse(localStorage.getItem(localKey) || "[]"); } catch {}
  if (local.length) {
    const rows = local.map(x => {
      const row = toRow(x, userId);
      if (!UUID_RE.test(row.id)) delete row.id;
      return row;
    });
    const { error } = await supabase.from(table).upsert(rows, { onConflict: "id" });
    if (error) {
      console.error(`migrateLocalOnce(${table}) failed`, error);
      return; // don't set flag — allow retry on next load
    }
  }
  localStorage.setItem(flag, "true");
}

// Drop-in replacement for useStorage(key, initial) that persists to a
// Supabase table instead of localStorage, while keeping the exact same
// [value, setValue] interface so existing components need no changes.
//
// The diff-and-sync side effect runs in a useEffect (not inside the setVal
// updater) so it stays StrictMode-safe — React 18 dev mode double-invokes
// updater functions to test purity, which would otherwise double-fire writes.
export function useSyncedList(table, localKey, userId, toRow, fromRow, idKey = "id") {
  const [val, setVal] = useState(() => { try { return JSON.parse(localStorage.getItem(localKey) || "[]"); } catch { return []; } });
  const loadedForUser = useRef(null);
  const prevRef = useRef(val);
  const skipNextSync = useRef(false);

  useEffect(() => {
    if (!userId || loadedForUser.current === userId) return;
    loadedForUser.current = userId;
    (async () => {
      await migrateLocalOnce(table, localKey, userId, toRow);
      const { data, error } = await supabase.from(table).select("*").eq("user_id", userId).order("created_at", { ascending: false });
      if (!error && data) {
        const mapped = data.map(fromRow);
        skipNextSync.current = true;
        prevRef.current = mapped;
        setVal(mapped);
        localStorage.setItem(localKey, JSON.stringify(mapped));
      }
    })();
  }, [userId]);

  useEffect(() => {
    localStorage.setItem(localKey, JSON.stringify(val));
    if (skipNextSync.current) { skipNextSync.current = false; prevRef.current = val; return; }
    if (val !== prevRef.current) {
      syncListDiff(table, prevRef.current, val, userId, toRow, idKey);
      prevRef.current = val;
    }
  }, [val]);

  const setValue = useCallback((v) => {
    setVal(prev => (typeof v === "function" ? v(prev) : v));
  }, []);

  return [val, setValue];
}

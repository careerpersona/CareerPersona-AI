import { useState, useEffect, useRef, useCallback } from "react";
import { supabase } from "../lib/supabaseClient";

// Diffs `prev` vs `next` (plain arrays, compared by `key`) and fires the
// minimal insert/update/delete calls against `table` in the background.
// `upsertConflict` lets callers specify the ON CONFLICT column(s) — required
// for tables whose unique key differs from the primary key (e.g. saved_jobs
// uses "user_id,job_id" so saves are idempotent before a _db_id is assigned).
async function syncListDiff(table, prev, next, userId, toRow, key, upsertConflict) {
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
      const { error } = await supabase.from(table).delete().eq("user_id", userId).in(key, removed.map(x => x[key]));
      if (error) console.error(`syncListDiff(${table}) delete error`, error);
    }
    if (changed.length) {
      const upsertOpts = upsertConflict ? { onConflict: upsertConflict } : undefined;
      const { error } = await supabase.from(table).upsert(changed.map(x => toRow(x, userId)), upsertOpts);
      if (error) console.error(`syncListDiff(${table}) upsert error`, error);
    }
  } catch (err) {
    console.error(`syncListDiff(${table}) failed`, err);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// One-time push of whatever is in localStorage for `localKey` into `table`.
// `migrateConflict` is the ON CONFLICT column(s) for the upsert — defaults to
// "id" for tables keyed by UUID, but must be "user_id,job_id" for saved_jobs
// (which has a UNIQUE (user_id, job_id) constraint and rows without a _db_id
// during migration would otherwise conflict and fail).
async function migrateLocalOnce(table, localKey, userId, toRow, migrateConflict = "id") {
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
    const { error } = await supabase.from(table).upsert(rows, { onConflict: migrateConflict });
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
// opts.upsertConflict — passed to syncListDiff; use when the table's effective
//   unique key for upsert differs from its primary key.
// opts.migrateConflict — passed to migrateLocalOnce; same reason.
export function useSyncedList(table, localKey, userId, toRow, fromRow, idKey = "id", opts = {}) {
  const [val, setVal] = useState(() => { try { return JSON.parse(localStorage.getItem(localKey) || "[]"); } catch { return []; } });
  const loadedForUser = useRef(null);
  const prevRef = useRef(val);
  const skipNextSync = useRef(false);

  useEffect(() => {
    if (!userId) { loadedForUser.current = null; setVal([]); return; }
    if (loadedForUser.current === userId) return;
    loadedForUser.current = userId;
    (async () => {
      await migrateLocalOnce(table, localKey, userId, toRow, opts.migrateConflict);
      const { data, error } = await supabase.from(table).select("*").eq("user_id", userId).order("created_at", { ascending: false });
      if (error) { console.error(`useSyncedList(${table}) load error`, error); return; }
      if (data) {
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
      syncListDiff(table, prevRef.current, val, userId, toRow, idKey, opts.upsertConflict);
      prevRef.current = val;
    }
  }, [val]);

  const setValue = useCallback((v) => {
    setVal(prev => (typeof v === "function" ? v(prev) : v));
  }, []);

  const refresh = useCallback(async () => {
    if (!userId) return;
    const { data, error } = await supabase.from(table).select("*").eq("user_id", userId).order("created_at", { ascending: false });
    if (error) { console.error(`useSyncedList(${table}) refresh error`, error); return; }
    if (data) {
      const mapped = data.map(fromRow);
      skipNextSync.current = true;
      prevRef.current = mapped;
      setVal(mapped);
      localStorage.setItem(localKey, JSON.stringify(mapped));
    }
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  return [val, setValue, refresh];
}

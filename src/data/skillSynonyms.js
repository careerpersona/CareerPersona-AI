import { supabase } from "../lib/supabaseClient";

// Module-level cache: the skill_synonyms table is small, read-only reference
// data, so it's fetched once per app session and reused -- never re-fetched
// per job or per search (the Compatibility Engine must stay zero-network per
// scoring pass).
let _cache = null;
let _pending = null;

// Returns a plain { alias: canonical } object. On any failure (offline, RLS,
// table not yet migrated) resolves to {} so callers degrade to unnormalized
// matching rather than throwing.
export async function loadSkillSynonyms() {
  if (_cache) return _cache;
  if (_pending) return _pending;
  _pending = supabase
    .from("skill_synonyms")
    .select("alias, canonical")
    .then(({ data, error }) => {
      _cache = error || !data ? {} : Object.fromEntries(data.map(r => [r.alias, r.canonical]));
      _pending = null;
      return _cache;
    })
    .catch(() => {
      _cache = {};
      _pending = null;
      return _cache;
    });
  return _pending;
}

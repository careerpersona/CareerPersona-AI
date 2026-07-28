# Wrangler Deployment Failure — Investigation & Fix

## Root cause

A stale `wrangler.jsonc` file at `C:\Users\ggund\wrangler.jsonc` — a leftover from this project's original Wrangler setup on 2026-06-23 — was silently intercepting every `wrangler deploy` for this Worker.

Wrangler's config-file discovery (`findWranglerConfig` → `file()`, in `wrangler-dist/cli.js`) searches upward from the current directory **independently per filename**, in priority order `wrangler.json` → `wrangler.jsonc` → `wrangler.toml`, stopping at the very first match regardless of how far up the tree it had to go. Because a `wrangler.jsonc` existed one directory level above this project (in the developer's home directory) while the project itself only ever had a `wrangler.toml`, the home-directory file won on **extension priority**, despite being farther away than the project's own config. Wrangler then resolved the entry point and all bindings against the wrong directory (`C:\Users\ggund\worker.js`, which doesn't exist) instead of this project's real `worker.js`, `SUBSCRIPTION_CACHE` KV binding, and `SUPABASE_URL` var.

## Timeline of the investigation

1. `wrangler deploy` failed with `"The entry-point file at 'worker.js' was not found"`.
2. Ruled out **project structure** — `worker.js` confirmed to exist exactly where `wrangler.toml`'s `main` field expects it, run from the repo root, no history of the file ever moving.
3. Ruled out **Wrangler's `autoconfig` feature** — tried both `--autoconfig=false` and the older `--x-autoconfig=false` flag names; neither had any measurable effect on the failure (confirmed via Wrangler's own telemetry log, which never recorded the flag as used).
4. Ruled out **Wrangler version** — pinned and tested `4.67.1` (the release immediately preceding `4.68.0`, which is where Cloudflare's own release notes confirm `autoconfig` was enabled by default). Failed identically to the latest `4.114.0`.
5. Ruled out **this repository entirely** — built the smallest possible Worker (a 4-line `worker.js`, a 3-line `wrangler.toml`) in a fresh temp directory outside the project. Failed identically.
6. Investigated **Node.js version** — confirmed a real, separate, upstream Node.js bug (`nodejs/node#56645`, a Windows-specific `fetch()`/libuv race condition matching our exact crash signature, `src\win\async.c` line 94) explains the crash-on-exit we kept seeing, but it's a different symptom from the entry-point failure, not a cause of it. Ruled out Node v26 as the cause of the *entry-point* failure specifically by re-running the same minimal reproduction under a portable Node v24 (Active LTS) install — failed identically.
7. Searched Cloudflare's own `workers-sdk` issue tracker for this exact failure signature and for any cross-reference to the Node.js bug above — found no matching bug report and no maintainer-documented workaround.
8. Read Wrangler's actual bundled source (`getEntry` → `resolveEntryWithMain` → `fileExists`) to understand exactly how the entry-point path is computed, then added one temporary, immediately-reverted debug log to the **installed Wrangler package only** (never to this project's own source) to print the live values of `config.configPath`, `config.main`, and the resolved paths.
9. That single debug run revealed the actual values: `configPath = C:\Users\ggund\wrangler.jsonc`, `main = C:\Users\ggund\worker.js` — proving Wrangler was resolving everything against the developer's home directory, not the project.
10. Traced `findWranglerConfig`/`file()` in Wrangler's source to understand exactly *why* — the per-filename upward-search-priority mechanism described above — and confirmed via a read-only check that `C:\Users\ggund\wrangler.jsonc` existed while `wrangler.json`/`wrangler.toml` did not exist at that same level.

## Why the earlier hypotheses were ruled out, specifically

| Hypothesis | Evidence against it |
|---|---|
| Project misconfiguration | Minimal reproduction outside the repo failed identically |
| `autoconfig` feature | Flag had no effect; pre-`4.68.0` version (`4.67.1`) failed identically |
| Wrangler version drift | `4.67.1` and `4.114.0` both failed, byte-identical error |
| Node.js v26 | Node v24 (Active LTS) failed identically on the same minimal reproduction |
| Known/documented Wrangler bug | No matching issue or maintainer response found in `cloudflare/workers-sdk` |

Each was eliminated with a direct, reproducible test — not inferred from correlation.

## Confirmed mechanism

```js
// findWranglerConfig, wrangler-dist/cli.js
const userConfigPath = file(`wrangler.json`,  { cwd: referencePath })
                     ?? file(`wrangler.jsonc`, { cwd: referencePath })
                     ?? file(`wrangler.toml`,  { cwd: referencePath });

// file(), wrangler-dist/cli.js
function file(name, options) {
  for (dir of up(start, options)) {              // walks cwd -> filesystem root
    if (fs.statSync(path.join(dir, name)).isFile()) return path.join(dir, name); // first match wins
  }
}
```

Three **independent, full upward sweeps**, one per filename, in extension-priority order. A match anywhere up the tree short-circuits the search — including a match that's farther away than a lower-priority filename sitting right in the project directory.

## The fix

1. **Removed the stray file from discovery** — renamed `C:\Users\ggund\wrangler.jsonc` to `C:\Users\ggund\wrangler.jsonc.bak` (preserved, not deleted, in case it's ever needed for reference).
2. **Made deployment deterministic going forward** — added an explicit `--config wrangler.toml` to every deploy invocation, via two new `package.json` scripts:
   ```json
   "worker:deploy": "wrangler deploy --config wrangler.toml",
   "worker:deploy:dry": "wrangler deploy --config wrangler.toml --dry-run"
   ```
   Passing `--config` explicitly bypasses `findWranglerConfig`'s upward search entirely (confirmed in source: `resolveWranglerConfigPath` short-circuits to the given path when `config !== undefined`), so this project is now immune to this entire class of bug regardless of what config files exist anywhere above it in the directory tree — on this machine or any other.

**Deployment standard going forward:** always use `npm run worker:deploy` / `npm run worker:deploy:dry` rather than a bare `npx wrangler deploy`, so no one has to remember the flag manually.

## Recommendations for future developers

- If a fresh clone of this repo (or a setup on a new machine) ever produces a similar `"entry-point file ... was not found"` error pointing at a directory that isn't this project, **suspect a stray `wrangler.json`/`wrangler.jsonc`/`wrangler.toml` in a parent directory first** (home directory, a parent folder used for other projects, a monorepo root) before suspecting this repository or the Wrangler version.
- Always deploy via `npm run worker:deploy` (or `worker:deploy:dry` for a dry run), never a bare `wrangler deploy`, to avoid depending on Wrangler's upward config-discovery at all.
- If the `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` crash appears in a Wrangler run on Windows, that's a separate, already-understood issue (upstream Node.js bug `nodejs/node#56645`, Windows + Node v24+, triggered by Wrangler's own telemetry `fetch()` call on exit) — cosmetic to the run's actual result, not a cause of config/entry-point failures.

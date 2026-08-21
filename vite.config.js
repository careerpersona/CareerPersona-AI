import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { sentryVitePlugin } from '@sentry/vite-plugin'
import { execSync } from 'node:child_process'

// Single source of truth for "release" -- passed to Sentry.init() in
// src/sentry.js via the __SENTRY_RELEASE__ define below, and to
// @sentry/vite-plugin's release name here, so uploaded source maps and
// reported client errors always resolve to the exact same release.
let gitSha = 'unknown'
try {
  gitSha = execSync('git rev-parse HEAD').toString().trim()
} catch {
  // Not a git checkout (unlikely in this deployment, but fail safe rather
  // than fail the build) -- Sentry.init() falls back to "dev" itself when
  // __SENTRY_RELEASE__ isn't defined, so this only matters for local builds
  // run outside a git working tree.
}

// Source-map upload only runs when SENTRY_AUTH_TOKEN is present (set as a
// Cloudflare Pages build environment secret, never read anywhere else in
// this repo, never written to any file). Its absence -- e.g. a local
// `npm run build` -- simply skips upload rather than failing the build.
const sentryAuthToken = process.env.SENTRY_AUTH_TOKEN

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    sentryAuthToken && sentryVitePlugin({
      org: 'sellatrend-enterprises-llc',
      project: 'javascript-react',
      authToken: sentryAuthToken,
      release: { name: gitSha },
      sourcemaps: {
        // Source maps must exist on disk (build.sourcemap below) for this
        // plugin to find and upload them, but the publicly-deployed dist/
        // output should not itself serve them -- delete the .map files
        // (and the sourceMappingURL comments, via build.sourcemap:"hidden"
        // below) after upload completes.
        filesToDeleteAfterUpload: ['./dist/**/*.map'],
      },
    }),
  ].filter(Boolean),
  build: {
    // "hidden": generate real source maps for Sentry to upload, but omit
    // the //# sourceMappingURL comment from the shipped JS so browsers/
    // devtools never auto-fetch them from the public bundle. Combined with
    // filesToDeleteAfterUpload above, the maps never end up served at all
    // once the Sentry plugin has uploaded them.
    sourcemap: 'hidden',
  },
  define: {
    __SENTRY_RELEASE__: JSON.stringify(gitSha),
  },
  server: {
    host: true,
    port: 5173,
  },
})

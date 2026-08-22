import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      // __SENTRY_RELEASE__ isn't a real global -- it's a build-time string
      // replaced by Vite's `define` (vite.config.js), read only in
      // src/sentry.js. Declaring it here is the standard ESLint pattern for
      // a define-injected identifier; it doesn't exist at runtime outside
      // the built bundle, so it's not part of globals.browser.
      globals: { ...globals.browser, __SENTRY_RELEASE__: "readonly" },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    // tools/ is Node-only ESM (no JSX, no browser globals) -- react-hooks and
    // react-refresh rules don't apply here, so this is a separate block
    // rather than an addition to the browser-scoped one above.
    files: ['tools/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // vite.config.js is a Node-context build script (process.env, node:child_process),
    // not browser code -- it's still matched by the **/*.{js,jsx} block above (for its
    // js.configs.recommended/react-hooks/react-refresh extends, harmless no-ops here),
    // but that block's globals: globals.browser doesn't include `process`. ESLint merges
    // languageOptions.globals across cascading matched configs, so this adds Node globals
    // on top rather than replacing the browser set.
    files: ['vite.config.js'],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // worker.js's ~14 lint findings are all the same idiom: `catch (_) { ... }`,
    // where `_` is a deliberately-ignored caught error -- not a real unused-variable
    // bug. caughtErrorsIgnorePattern is the standard ESLint option for exactly this
    // convention. Scoped to worker.js only (not the shared browser block above) so it
    // doesn't also silence the same idiom's few unrelated occurrences in App.jsx --
    // that file's lint debt is out of scope for this change.
    files: ['worker.js'],
    rules: {
      'no-unused-vars': ['error', { caughtErrorsIgnorePattern: '^_' }],
    },
  },
])

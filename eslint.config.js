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
])

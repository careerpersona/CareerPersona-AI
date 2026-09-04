import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Back Office — a completely separate Vite application from the customer
// app's own vite.config.js (repo root). Never imports from, or is imported
// by, src/App.jsx -- kept in its own admin/ directory with its own
// package.json and node_modules so there is no possibility of Back Office
// code ending up in the customer bundle. Deploys as a separate Cloudflare
// Pages project (root directory: admin/) to admin.careerpersonaai.com --
// not wired up yet, per Work Order 2 scope (build only, do not deploy).
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5190, // distinct from the customer app's 5173/5180
  },
})

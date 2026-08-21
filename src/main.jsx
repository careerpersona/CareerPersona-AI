import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { initSentry, Sentry } from './sentry.js'

// Must run before anything else renders so it can capture errors from the
// very first paint onward, including any thrown during App's own mount.
initSentry()

function ErrorFallback() {
  return (
    <div style={{ minHeight: '100vh', background: '#F7F8FC', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, fontFamily: 'inherit' }}>
      <div style={{ maxWidth: 420, width: '100%', textAlign: 'center', background: '#FFFFFF', border: '1px solid #E2E8F0', borderRadius: 16, boxShadow: '0 1px 4px rgba(0,0,0,0.04)', padding: 32 }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
        <div style={{ fontSize: 20, fontWeight: 800, color: '#0F172A', marginBottom: 10 }}>Something went wrong</div>
        <div style={{ fontSize: 14, color: '#334155', marginBottom: 24, lineHeight: 1.6 }}>
          CareerPersona AI hit an unexpected error. This has been reported automatically. Reloading usually fixes it.
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{ border: 'none', borderRadius: 10, padding: '11px 22px', fontSize: 14, fontWeight: 700, cursor: 'pointer', color: '#fff', background: 'linear-gradient(135deg,#6B21E8,#9B59F5)' }}
        >
          Reload
        </button>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Sentry.ErrorBoundary fallback={<ErrorFallback />} showDialog={false}>
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
)

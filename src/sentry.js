import * as Sentry from "@sentry/react";

// DSN is public client configuration by design (Sentry's own documentation:
// it identifies where to send events, it does not grant read/write access to
// the project) -- safe to commit, unlike the Sentry auth token used only at
// build time for source-map upload (see vite.config.js, read from the
// SENTRY_AUTH_TOKEN env var, never referenced here or shipped to the client).
const DSN = "https://2502c5e5cb89fbdfe00246b615406cd1@o4511945670328320.ingest.us.sentry.io/4511945715810304";

// Matches the git commit SHA vite.config.js injects at build time and hands
// to @sentry/vite-plugin as the release name, so uploaded source maps and
// reported events always resolve to the same release. Falls back to
// "dev" when running `vite dev` (no build-time injection happens there).
const RELEASE = typeof __SENTRY_RELEASE__ !== "undefined" ? __SENTRY_RELEASE__ : "dev";

// Strip anything that looks like a credential/token from a string value
// (query params, header values, breadcrumb messages) before it ever leaves
// the browser. Deliberately broad/defensive rather than trying to enumerate
// every current secret name.
const SENSITIVE_KEY_PATTERN = /(auth|token|secret|password|apikey|api_key|session|cookie)/i;

function scrubUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url, window.location.origin);
    let changed = false;
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_KEY_PATTERN.test(key)) { u.searchParams.set(key, "[Filtered]"); changed = true; }
    }
    return changed ? u.toString() : url;
  } catch {
    return url;
  }
}

function scrubHeaders(headers) {
  if (!headers || typeof headers !== "object") return headers;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SENSITIVE_KEY_PATTERN.test(k) ? "[Filtered]" : v;
  }
  return out;
}

export function initSentry() {
  Sentry.init({
    dsn: DSN,
    release: RELEASE,
    environment: import.meta.env.MODE, // "production" for `vite build`, "development" for `vite dev`
    // Error monitoring only -- no performance tracing, no profiling. This app
    // sends real user resume/document text and AI-generated content through
    // normal fetch calls; tracing would add breadcrumb/span volume with no
    // debugging value proportional to that added surface area.
    tracesSampleRate: 0,
    // Session Replay intentionally not enabled -- explicitly out of scope
    // for this task (records DOM/user input, a much larger privacy surface
    // than error capture) and not something to add without separate,
    // explicit approval.
    integrations: [],
    // Do not auto-attach IP address or infer user identity from the request
    // -- nothing here calls Sentry.setUser() either, so no account
    // email/name/id is ever sent. Errors are still fully actionable via
    // release + environment + the "page" tag set in App.jsx.
    sendDefaultPii: false,
    beforeBreadcrumb(breadcrumb) {
      // console breadcrumbs can echo whatever an app-level console.error(...)
      // call happened to log -- several call sites in this app log the raw
      // Error object alongside a feature tag (e.g. console.error("[Benchmark]", e)),
      // and in rare paths that could include a fragment of user-entered resume
      // text surfaced in an AI-parsing error message. Drop console breadcrumbs
      // entirely rather than trying to pattern-match every possible case;
      // captured exceptions themselves (the actual point of this integration)
      // are unaffected.
      if (breadcrumb.category === "console") return null;
      if (breadcrumb.data?.url) breadcrumb.data.url = scrubUrl(breadcrumb.data.url);
      return breadcrumb;
    },
    beforeSend(event) {
      if (event.request) {
        if (event.request.url) event.request.url = scrubUrl(event.request.url);
        if (event.request.headers) event.request.headers = scrubHeaders(event.request.headers);
        // This app never puts request bodies into Sentry via any integration
        // used here, but strip defensively in case that ever changes --
        // request bodies could contain resume text, cover letters, or job
        // descriptions typed by the user.
        delete event.request.data;
        delete event.request.cookies;
      }
      return event;
    },
  });
}

export { Sentry };

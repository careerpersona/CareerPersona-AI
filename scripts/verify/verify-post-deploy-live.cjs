/**
 * verify-post-deploy-live.cjs — post-deployment smoke test. Runs the local
 * frontend but hits the REAL deployed Cloudflare Worker (job search, via
 * proxy.dawn-voice-2790.workers.dev) and the REAL Supabase skill_synonyms
 * table — only auth/profile/resumes/queue/saved_jobs are mocked, since no
 * real user session is available headlessly. Confirms the full Compatibility
 * Engine pipeline works end-to-end against production infrastructure, not
 * just against mocks.
 *
 * When to run: immediately after every `npm run worker:deploy`, to confirm
 * the live Worker responds and the Compatibility Engine still scores jobs
 * correctly against production data.
 * Production-safe: touches real production infrastructure (live Worker,
 * live Supabase skill_synonyms table, live Adzuna/JSearch calls) — safe to
 * run any time since it's read-only, but it is NOT a fully local/offline test.
 * Prerequisites: dev server running at http://localhost:5180 (must be on the
 * Worker's CORS allowlist in worker.js's ALLOWED_ORIGINS — update the port
 * in both this file and worker.js if you use a different one).
 * Run: node scripts/verify/verify-post-deploy-live.cjs
 */
const { chromium } = require('playwright');

const SUPABASE_HOST = 'cbzebqxbohgkgcqfgmdm.supabase.co';
const SUPABASE_SESSION_KEY = `sb-cbzebqxbohgkgcqfgmdm-auth-token`;
const FAKE_UID = '11111111-1111-1111-1111-111111111111';
const FAKE_EMAIL = 'test@careerpersona.dev';
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 86400 * 365;
function makeJWT(payload) {
  const b64url = (s) => Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fake_sig`;
}
const ACCESS_TOKEN = makeJWT({ sub: FAKE_UID, email: FAKE_EMAIL, role: 'authenticated', aud: 'authenticated', iss: `https://${SUPABASE_HOST}/auth/v1`, iat: Math.floor(Date.now() / 1000), exp: FAR_FUTURE });
const SUPABASE_SESSION = { access_token: ACCESS_TOKEN, token_type: 'bearer', expires_in: 86400 * 365, expires_at: FAR_FUTURE, refresh_token: 'fake_refresh_token', user: { id: FAKE_UID, aud: 'authenticated', role: 'authenticated', email: FAKE_EMAIL, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } };
const FAKE_PROFILE = { id: FAKE_UID, email: FAKE_EMAIL, full_name: 'Test User', preferred_job_title: 'Software Engineer', location: 'San Francisco, CA', work_type: 'Remote', desired_salary: '150000', subscription_status: 'admin', country: 'US' };
// Resume deliberately uses non-canonical spellings ("React.js", "Node") to
// force a real synonym-dictionary lookup against the live skill_synonyms table.
const RESUME = { id: 'resume-A', user_id: FAKE_UID, name: 'My Resume', content: 'Jane Doe\nSoftware Engineer\njane@example.com | (415) 111-2222\n\nSKILLS\nReact.js, Node, AWS, Docker, Python', is_default: true, file_url: null, file_type: null, ats_score: 80, potential_ats_score: 90, keywords_found: [], keywords_missing: [], language: 'en', created_at: new Date().toISOString(), last_analyzed_at: new Date().toISOString() };

let claudeCallCount = 0;
let realJobsApiHit = false;
let realSkillSynonymsHit = false;

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  // Mock ONLY auth/profile/resumes/queue/saved_jobs — everything else (job search, skill_synonyms) hits the real backend.
  await context.route(`**/${SUPABASE_HOST}/auth/**`, async (route) => {
    const url = route.request().url();
    if (url.includes('/token') || url.includes('/session')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SUPABASE_SESSION) });
    if (url.includes('/user')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SUPABASE_SESSION.user) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await context.route(`**/${SUPABASE_HOST}/rest/v1/profiles*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([FAKE_PROFILE]) }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/profile_details*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([FAKE_PROFILE]) }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/user_resumes*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([RESUME]) }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/smart_apply_queue*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/saved_jobs*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  // Deliberately NOT mocking skill_synonyms (real table) or the Worker's /api/jobs (real deploy).
  await context.route(`**/${SUPABASE_HOST}/rest/v1/skill_synonyms*`, (route) => { realSkillSynonymsHit = true; return route.continue(); });
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/jobs/, (route) => { realJobsApiHit = true; return route.continue(); });
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/?$/, (route) => { claudeCallCount++; return route.continue(); });
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/billing/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'ADMIN', plan: 'Admin', quotas: { ai_request: { unlimited: true } } }) }));

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', err => { pageErrors.push(err.message); console.log('*** PAGE ERROR:', err.message); });
  await page.addInitScript(([sessionKey, sessionJson]) => { localStorage.setItem(sessionKey, sessionJson); }, [SUPABASE_SESSION_KEY, JSON.stringify(SUPABASE_SESSION)]);

  console.log('=== LOADING APP ===');
  await page.goto('http://localhost:5180');
  await page.waitForTimeout(2500);
  console.log('=== NAVIGATING TO JOB SEARCH ===');
  await page.goto('http://localhost:5180/#jobs');
  await page.waitForTimeout(1500);

  console.log('=== SUBMITTING REAL SEARCH (hits live Worker + live Adzuna/JSearch) ===');
  const titleInput = page.locator('input[placeholder*="Software Engineer" i]').first();
  await titleInput.fill('Software Engineer');
  await page.getByRole('button', { name: /search jobs/i }).click();
  await page.waitForTimeout(9000);

  const bodyText = await page.evaluate(() => document.body.innerText);
  const hasAiMatch = /AI Match/i.test(bodyText);
  const hasMatchBadge = /%\s*Match/i.test(bodyText);
  const hasSmartApply = /Smart Apply/i.test(bodyText);
  const matchSnippets = bodyText.match(/\d{1,3}%\s*Match/g) || [];

  console.log('\n=== RESULTS ===');
  console.log('Real /api/jobs call hit (live Worker):', realJobsApiHit ? '✅' : '❌');
  console.log('Real skill_synonyms table queried (live Supabase):', realSkillSynonymsHit ? '✅' : '❌');
  console.log('"AI Match" text present (should be gone):', hasAiMatch ? '❌ FAIL' : '✅ PASS');
  console.log('Match % badges present:', hasMatchBadge ? `✅ (${matchSnippets.length} found: ${matchSnippets.slice(0,5).join(', ')})` : '❌ FAIL');
  console.log('Smart Apply button present:', hasSmartApply ? '✅' : '❌');
  console.log('Claude API calls during search (should be 0):', claudeCallCount, claudeCallCount === 0 ? '✅ PASS' : '❌ FAIL');
  console.log('Page errors:', pageErrors.length === 0 ? '✅ none' : `❌ ${pageErrors.length}`);
  if (!hasMatchBadge) {
    console.log('\n=== DEBUG: full body text (badge check failed) ===');
    console.log(bodyText.slice(0, 2500));
  }

  await browser.close();
  const failed = !realJobsApiHit || hasAiMatch || !hasMatchBadge || claudeCallCount > 0 || pageErrors.length > 0;
  process.exit(failed ? 1 : 0);
})();

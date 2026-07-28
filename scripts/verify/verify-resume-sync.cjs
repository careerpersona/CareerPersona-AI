/**
 * verify-resume-sync.cjs — confirms Job Search's auto-activated resume (the
 * most-recently-analyzed resume, per useResumes' sort order) is reflected as
 * the "active"/highlighted resume in Resume Library, so the two pages never
 * silently disagree about which resume is in use.
 *
 * When to run: after any change to useResumes' sort/selection logic, Job
 * Search's auto-activate effect, or Resume Library's active-resume highlight.
 * Production-safe: no — all Supabase calls are mocked with two fixture
 * resumes. Local development only.
 * Prerequisites: dev server running at http://localhost:5173 (update the
 * port in this file if your dev server runs elsewhere). Runs non-headless
 * (headless: false) by default.
 * Run: node scripts/verify/verify-resume-sync.cjs
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
const FAKE_PROFILE = { id: FAKE_UID, email: FAKE_EMAIL, full_name: 'Test User', preferred_job_title: 'Software Engineer', location: 'San Francisco, CA', work_type: 'Remote', subscription_status: 'admin', country: 'US' };

// TWO resumes, neither is_default, so the "second" one becomes resumes[0] by
// last_analyzed_at desc (useResumes sorts that way) — this is the one Job
// Search's auto-activate effect should pick, and Resume Library must agree.
const RESUME_A = { id: 'resume-A', user_id: FAKE_UID, name: 'Older Resume', content: 'Jane Doe\nOlder resume content\njane@example.com | (415) 111-2222', is_default: false, file_url: null, file_type: null, ats_score: 70, potential_ats_score: 85, keywords_found: [], keywords_missing: [], language: 'en', created_at: new Date(Date.now() - 100000).toISOString(), last_analyzed_at: new Date(Date.now() - 100000).toISOString() };
const RESUME_B = { id: 'resume-B', user_id: FAKE_UID, name: 'Newer Resume', content: 'John Smith\nNewer resume content\njohn@example.com | (415) 234-5678', is_default: false, file_url: null, file_type: null, ats_score: 80, potential_ats_score: 90, keywords_found: [], keywords_missing: [], language: 'en', created_at: new Date().toISOString(), last_analyzed_at: new Date().toISOString() };

async function txt(page) { return page.evaluate(() => document.body.innerText); }

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 60 });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  await context.route(`**/${SUPABASE_HOST}/rest/**`, async (route) => {
    const method = route.request().method();
    if (method === 'POST' || method === 'PATCH') return route.fulfill({ status: 200, contentType: 'application/json', body: '[{}]' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await context.route(`**/${SUPABASE_HOST}/auth/**`, async (route) => {
    const url = route.request().url();
    if (url.includes('/token') || url.includes('/session')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SUPABASE_SESSION) });
    if (url.includes('/user')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SUPABASE_SESSION.user) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await context.route(`**/${SUPABASE_HOST}/rest/v1/profiles*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([FAKE_PROFILE]) }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/user_resumes*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([RESUME_B, RESUME_A]) }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/smart_apply_queue*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev/, async (route) => {
    const url = route.request().url();
    if (url.includes('/api/billing')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'ADMIN', plan: 'Admin', quotas: { ai_request: { unlimited: true }, resume_analysis: { unlimited: true } } }) });
    if (url.includes('/api/trial')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ activated: true }) });
    return route.continue();
  });

  const page = await context.newPage();
  page.on('pageerror', err => console.log(`*** PAGE ERROR: ${err.message}`));
  await page.addInitScript(([sessionKey, sessionJson]) => { localStorage.setItem(sessionKey, sessionJson); }, [SUPABASE_SESSION_KEY, JSON.stringify(SUPABASE_SESSION)]);

  console.log('=== LOADING APP ===');
  await page.goto('http://localhost:5173');
  await page.waitForTimeout(3000);

  console.log('=== JOB SEARCH: check auto-activated resume ===');
  await page.goto('http://localhost:5173/#jobs');
  await page.waitForTimeout(2000);
  const jsButtonText = (await txt(page)).match(/📄[^\n]*/)?.[0] || '(not found)';
  console.log('Job Search active-resume button:', jsButtonText);

  console.log('=== RESUME LIBRARY: check which resume shows as active ===');
  await page.goto('http://localhost:5173/#resume');
  await page.waitForTimeout(2000);
  const libraryText = await txt(page);
  const olderSelected = /Older Resume/.test(libraryText);
  const newerSelected = /Newer Resume/.test(libraryText);
  console.log('Resume Library page text (first 1200 chars):');
  console.log(libraryText.slice(0, 1200));

  console.log('\n=== VERDICT ===');
  console.log('Job Search picked:', jsButtonText.includes('Newer Resume') ? 'Newer Resume ✅ (expected, sorted first)' : jsButtonText);
  // Look for the selection checkmark near "Newer Resume" text specifically via DOM structure.
  const activeMarker = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.resume-lib-item'));
    return items.map(el => ({ text: el.innerText.slice(0, 60), highlighted: el.style.borderLeft.includes('167') || getComputedStyle(el).borderLeftWidth === '3px' }));
  });
  console.log('Resume Library items + highlight state:', JSON.stringify(activeMarker, null, 2));

  await browser.close();
})().catch(e => { console.error('SCRIPT ERROR:', e); process.exit(1); });

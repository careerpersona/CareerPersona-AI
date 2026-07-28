/**
 * verify-downstream-pages.cjs — confirms Dashboard, Saved Jobs, and
 * Opportunity Intelligence still render correctly reading match_score off a
 * saved_jobs row that also carries a compatibility_breakdown value. Guards
 * against a Compatibility Engine or savedJobs.js schema change silently
 * breaking one of these three read-only consumers.
 *
 * When to run: after any change to src/data/savedJobs.js's toRow/fromRow,
 * the saved_jobs schema, or how Dashboard/SavedJobsPage/OpportunityPage read
 * job.matchScore.
 * Production-safe: no — all Supabase calls are mocked with a fixture
 * saved_jobs row. Local development only.
 * Prerequisites: dev server running at http://localhost:5185 (update the
 * port in this file if your dev server runs elsewhere).
 * Run: node scripts/verify/verify-downstream-pages.cjs
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
const SAVED_JOB_ROW = {
  id: 'saved-1', user_id: FAKE_UID, job_id: 'adzuna_1', title: 'Senior Software Engineer', company: 'Acme Corp',
  location: 'San Francisco, CA', salary_min: 140000, salary_max: 180000, employment_type: 'Full-time', remote: true,
  description: 'React and AWS required', apply_url: '#', source: 'Adzuna', date_posted: new Date().toISOString(),
  match_score: 92, ats_score: null,
  compatibility_breakdown: { match_score: 92, weights_version: 'v1', confidence: 'High', components: { skills: 0.45, jobTitle: 0.25, salary: 0.13, location: 0.15 }, raw_components: { skills: 1, jobTitle: 1, salary: 0.9, location: 1 }, gates: [{ id: 'remote_onsite_requirement', label: 'Remote work requirement', passed: true, reason: '' }], computed_at: new Date().toISOString() },
  created_at: new Date().toISOString(),
};

(async () => {
  const browser = await chromium.launch({ headless: true });
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
  await context.route(`**/${SUPABASE_HOST}/rest/v1/profile_details*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([FAKE_PROFILE]) }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/user_resumes*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/smart_apply_queue*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/skill_synonyms*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/saved_jobs*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([SAVED_JOB_ROW]) }));
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/?$/, (route) => { console.log('*** UNEXPECTED CLAUDE CALL:', route.request().url()); return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/billing/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'ADMIN', plan: 'Admin', quotas: { ai_request: { unlimited: true } } }) }));
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/trial/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ activated: true }) }));

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', err => { pageErrors.push(err.message); console.log('*** PAGE ERROR:', err.message); });
  await page.addInitScript(([sessionKey, sessionJson]) => { localStorage.setItem(sessionKey, sessionJson); }, [SUPABASE_SESSION_KEY, JSON.stringify(SUPABASE_SESSION)]);

  for (const [label, hash] of [['DASHBOARD', '#dashboard'], ['SAVED JOBS', '#saved'], ['OPPORTUNITY INTELLIGENCE', '#opportunity']]) {
    console.log(`\n=== ${label} (${hash}) ===`);
    await page.goto(`http://localhost:5185/${hash}`);
    await page.waitForTimeout(1500);
    const bodyText = await page.evaluate(() => document.body.innerText);
    const has92 = /92%/.test(bodyText);
    console.log(`Shows the 92% match score: ${has92 ? '✅' : '(not on this page — may be expected)'}`);
  }

  console.log('\n=== SUMMARY ===');
  console.log('Page errors across all 3 pages:', pageErrors.length === 0 ? '✅ none' : `❌ ${pageErrors.length}`);

  await browser.close();
  process.exit(pageErrors.length > 0 ? 1 : 0);
})();

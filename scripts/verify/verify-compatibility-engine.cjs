/**
 * verify-compatibility-engine.cjs — confirms the deterministic Career
 * Compatibility Engine (src/lib/compatibility/*) is wired correctly: no
 * "AI Match" UI anywhere, a Match % badge appears instantly with zero Claude
 * calls during search, no auto Smart Apply generation fires, and the manual
 * Smart Apply button is still present.
 *
 * When to run: after any change to src/lib/compatibility/*, JobSearchPage's
 * scoring wiring in src/App.jsx, or worker.js's skill extraction.
 * Production-safe: no — all Supabase/Worker calls are mocked, including
 * /api/jobs (fake job fixtures). Local development only.
 * Prerequisites: dev server running at http://localhost:5183 (update the
 * BASE port in this file if your dev server runs elsewhere).
 * Run: node scripts/verify/verify-compatibility-engine.cjs
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
const RESUME = { id: 'resume-A', user_id: FAKE_UID, name: 'My Resume', content: 'Jane Doe\nSoftware Engineer\njane@example.com | (415) 111-2222\n\nSKILLS\nJavaScript, React, Node.js, AWS, Docker', is_default: true, file_url: null, file_type: null, ats_score: 80, potential_ats_score: 90, keywords_found: [], keywords_missing: [], language: 'en', created_at: new Date().toISOString(), last_analyzed_at: new Date().toISOString() };
const MOCK_JOBS = [
  { id: 'adzuna_1', source: 'Adzuna', title: 'Senior Software Engineer', company: 'Acme Corp', location: 'San Francisco, CA', description: 'We need React and AWS experience.', salaryMin: 140000, salaryMax: 180000, employmentType: 'Full-time', experienceLevel: '', remote: true, applyUrl: '#', datePosted: new Date().toISOString(), skills: ['React', 'AWS', 'Docker'] },
  { id: 'rapid_1', source: 'JSearch', title: 'Backend Engineer', company: 'Beta Inc', location: 'New York, NY', description: 'Node.js and Kubernetes required.', salaryMin: 120000, salaryMax: 150000, employmentType: 'Full-time', experienceLevel: 'Mid Level', remote: false, applyUrl: '#', datePosted: new Date().toISOString(), skills: ['Node.js', 'Kubernetes'] },
];

let claudeCallCount = 0;

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
  await context.route(`**/${SUPABASE_HOST}/rest/v1/user_resumes*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([RESUME]) }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/smart_apply_queue*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/skill_synonyms*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ alias: 'react.js', canonical: 'React' }]) }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/saved_jobs*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/jobs/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobs: MOCK_JOBS, total: MOCK_JOBS.length, page: 1, sources: { adzuna: 1, rapidapi: 1 } }) }));
  // Root "/" on the worker = the Claude proxy. If this ever fires during search, AI Match is still calling Claude.
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/?$/, async (route) => {
    claudeCallCount++;
    console.log('*** CLAUDE CALL DETECTED:', route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ text: '{}' }] }) });
  });
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/billing/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'ADMIN', plan: 'Admin', quotas: { ai_request: { unlimited: true }, resume_analysis: { unlimited: true } } }) }));

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', err => { pageErrors.push(err.message); console.log('*** PAGE ERROR:', err.message); });
  await page.addInitScript(([sessionKey, sessionJson]) => { localStorage.setItem(sessionKey, sessionJson); }, [SUPABASE_SESSION_KEY, JSON.stringify(SUPABASE_SESSION)]);

  console.log('=== LOADING APP ===');
  await page.goto('http://localhost:5183');
  await page.waitForTimeout(2000);

  console.log('=== NAVIGATING TO JOB SEARCH ===');
  await page.goto('http://localhost:5183/#jobs');
  await page.waitForTimeout(1500);

  console.log('=== SUBMITTING SEARCH ===');
  const titleInput = page.locator('input[placeholder*="Software Engineer" i]').first();
  await titleInput.fill('Software Engineer');
  await page.getByRole('button', { name: /search jobs/i }).click();
  await page.waitForTimeout(2000);

  const bodyText = await page.evaluate(() => document.body.innerText);
  const hasAiMatchButton = /🤖\s*AI Match|AI Match/i.test(bodyText);
  const hasMatchBadge = /%\s*Match/i.test(bodyText);
  const hasSmartApplyButton = /Smart Apply/i.test(bodyText);
  const hasSenior = /Senior Software Engineer/.test(bodyText);

  console.log('\n=== RESULTS ===');
  console.log('Jobs rendered (found "Senior Software Engineer"):', hasSenior);
  console.log('"AI Match" text present anywhere on page:', hasAiMatchButton, hasAiMatchButton ? '❌ FAIL — should be fully removed' : '✅ PASS');
  console.log('Match % badge present:', hasMatchBadge, hasMatchBadge ? '✅ PASS' : '❌ FAIL — expected instant Match % badge');
  console.log('Smart Apply button present:', hasSmartApplyButton, hasSmartApplyButton ? '✅ PASS' : '❌ FAIL');
  console.log('Claude API calls during search (should be 0):', claudeCallCount, claudeCallCount === 0 ? '✅ PASS' : '❌ FAIL — Claude was called during search/scoring');
  console.log('Page errors:', pageErrors.length === 0 ? '✅ none' : `❌ ${pageErrors.length} error(s)`);

  const matchSnippet = bodyText.match(/[\s\S]{0,40}%\s*Match[\s\S]{0,10}/);
  console.log('\nMatch badge snippet:', matchSnippet ? matchSnippet[0].replace(/\s+/g, ' ').trim() : '(none found)');

  await browser.close();
  const failed = hasAiMatchButton || !hasMatchBadge || !hasSmartApplyButton || claudeCallCount > 0 || pageErrors.length > 0;
  process.exit(failed ? 1 : 0);
})();

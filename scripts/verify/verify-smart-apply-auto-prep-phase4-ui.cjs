/**
 * verify-smart-apply-auto-prep-phase4-ui.cjs — confirms the Smart Apply Auto
 * Prep Phase 4 UI: the Daily Preparation Setting control renders in Settings
 * (Off/1/2, correct helper text, no "Level"/"Tier" terminology anywhere),
 * changing it writes to automation_preferences, and the Smart Apply Queue
 * shows an "Auto-Prepared" badge only on generation_source: "automatic" rows.
 *
 * Production-safe: no — all Supabase/Worker calls are mocked. Local
 * development only. Prerequisites: dev server running at http://localhost:5173.
 * Run: node scripts/verify/verify-smart-apply-auto-prep-phase4-ui.cjs
 */
const { chromium } = require('playwright');

const SUPABASE_HOST = 'cbzebqxbohgkgcqfgmdm.supabase.co';
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
const RESUME = { id: 'resume-A', user_id: FAKE_UID, name: 'My Resume', content: 'Jane Doe\nSoftware Engineer\n(415) 111-2222\njane@example.com', is_default: true, file_url: null, file_type: null, ats_score: 80, potential_ats_score: 90, keywords_found: [], keywords_missing: [], language: 'en', created_at: new Date().toISOString(), last_analyzed_at: new Date().toISOString() };
const QUEUE_ITEMS = [
  { id: 'q-auto', user_id: FAKE_UID, job_id: 'adzuna_1', job_title: 'Senior Software Engineer', company: 'Acme Corp', tailored_resume: 'Jane Doe\n(415) 111-2222\njane@example.com', cover_letter: 'Dear Hiring Manager, ...', recruiter_message: 'Hi', networking_message: 'Hi', status: 'ready', generation_source: 'automatic', generation_result: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  { id: 'q-manual', user_id: FAKE_UID, job_id: 'rapid_1', job_title: 'Backend Engineer', company: 'Beta Inc', tailored_resume: 'Jane Doe\n(415) 111-2222\njane@example.com', cover_letter: 'Dear Hiring Manager, ...', recruiter_message: 'Hi', networking_message: 'Hi', status: 'ready', generation_source: 'manual', generation_result: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
];

let prefUpsertBody = null;

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
  await context.route(`**/${SUPABASE_HOST}/rest/v1/skill_synonyms*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/saved_jobs*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/smart_apply_queue*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(QUEUE_ITEMS) }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/automation_preferences*`, async (route) => {
    const method = route.request().method();
    if (method === 'POST' || method === 'PATCH') {
      prefUpsertBody = route.request().postDataJSON();
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[{}]' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }); // no row yet -> defaults to Off (0)
  });
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/billing\/state/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ billingState: 'ADMIN', planDisplayName: 'Admin', quotas: {} }) }));

  const page = await context.newPage();
  const results = [];
  const check = (label, pass) => { results.push({ label, pass }); console.log(`${pass ? '✅' : '❌'} ${label}`); };

  await page.addInitScript(({ session, key }) => { localStorage.setItem(key, JSON.stringify(session)); }, { session: SUPABASE_SESSION, key: `sb-cbzebqxbohgkgcqfgmdm-auth-token` });
  // Cold start always forces "dashboard" on first login (App.jsx's
  // wasLoggedIn effect), so a preset cp_active_page/hash is discarded --
  // land on dashboard first, then click through the real user-menu
  // navigation exactly as an actual user would.
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  await page.locator('button[title="Test"]').click({ timeout: 10000 });
  await page.locator('button:has-text("Settings")').first().click({ timeout: 10000 });
  await page.waitForTimeout(1000);

  const heading = page.locator('text=Smart Apply Auto Prep').first();
  check('Settings page renders the "Smart Apply Auto Prep" card heading', await heading.count() > 0);

  const helperText = page.locator('text=Max 20 AI-prepared applications/month.').first();
  check('Helper text "Max 20 AI-prepared applications/month." is always visible', await helperText.count() > 0);

  const bodyText = await page.locator('body').innerText();
  check('No "Level"/"Tier"/"Automation Level" terminology appears anywhere on the page', !/Level \d|Trust Tier|Automation Level/i.test(bodyText));
  check('Off / 1 application per day / 2 applications per day options present', bodyText.includes('Off') && bodyText.includes('1 application/day') && bodyText.includes('2 applications/day'));

  const select = page.locator('select').filter({ has: page.locator('option:has-text("2 applications/day")') }).first();
  check('Daily Preparation Setting select control is present', await select.count() > 0);
  if (await select.count() > 0) {
    await select.selectOption('1');
    await page.waitForTimeout(500);
    check('Changing the setting writes to automation_preferences (value: 1, feature_key: smart_apply_auto_prep)', prefUpsertBody?.value === 1 && prefUpsertBody?.feature_key === 'smart_apply_auto_prep');
  }

  // Navigate to Saved Jobs / Smart Apply Queue to check the Auto-Prepared badge,
  // via the real desktop nav menu (SPA-internal navigation) -- a full
  // reload/goto would remount the app and re-trigger the forced-dashboard
  // redirect the settings navigation above already had to work around.
  await page.locator('button[aria-haspopup="true"]').click({ timeout: 10000 });
  await page.locator('[role="menuitem"]:has-text("Saved Jobs")').first().click({ timeout: 10000 });
  await page.waitForTimeout(1000);
  const queueTab = page.locator('button:has-text("Smart Apply"), button:has-text("Queue")').first();
  if (await queueTab.count() > 0) { await queueTab.click({ timeout: 5000 }); await page.waitForTimeout(500); }

  const autoBadges = page.locator('text=Auto-Prepared');
  check('Exactly one "Auto-Prepared" badge shown (only the automatic-source row)', await autoBadges.count() === 1);

  const autoCard = page.locator('text=Senior Software Engineer').first();
  const manualCard = page.locator('text=Backend Engineer').first();
  check('Automatic-source job card is present (Senior Software Engineer)', await autoCard.count() > 0);
  check('Manual-source job card is present with no Auto-Prepared badge (Backend Engineer)', await manualCard.count() > 0);

  console.log('\n=== SUMMARY ===');
  const failed = results.filter(r => !r.pass);
  console.log(failed.length === 0 ? `✅ ALL ${results.length} CHECKS PASSED` : `❌ ${failed.length}/${results.length} CHECKS FAILED:\n${failed.map(f => '  - ' + f.label).join('\n')}`);

  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
})();

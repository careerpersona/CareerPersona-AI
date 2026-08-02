/**
 * verify-full-analysis-navigation.cjs — confirms the Dashboard's "Full
 * Analysis" button always opens the Application Tracker with the Insights
 * tab already selected, regardless of what cp_tracker_tab remembers, while
 * normal in-Tracker tab clicks still remember the user's last selected tab.
 *
 * Covers the 4 required scenarios:
 *  1. First-time user (no cp_tracker_tab in sessionStorage) -> Insights
 *  2. Fresh browser session (new context, nothing persisted) -> Insights
 *  3. Returning user whose last Tracker tab was Applications -> still Insights
 *  4. Normal Tracker navigation (clicking a tab manually) still remembers it
 *
 * Production-safe: no — mocked Supabase session, local dev only.
 * Prerequisites: dev server running at http://localhost:5173.
 * Run: node scripts/verify/verify-full-analysis-navigation.cjs
 */
const { chromium } = require('playwright');

const SUPABASE_HOST = 'cbzebqxbohgkgcqfgmdm.supabase.co';
const SUPABASE_SESSION_KEY = `sb-cbzebqxbohgkgcqfgmdm-auth-token`;
const FAKE_UID = '55555555-5555-5555-5555-555555555555';
const FAKE_EMAIL = 'navtest@careerpersona.dev';
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 86400 * 365;
function makeJWT(payload) {
  const b64url = (s) => Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fake_sig`;
}
const ACCESS_TOKEN = makeJWT({ sub: FAKE_UID, email: FAKE_EMAIL, role: 'authenticated', aud: 'authenticated', iss: `https://${SUPABASE_HOST}/auth/v1`, iat: Math.floor(Date.now() / 1000), exp: FAR_FUTURE });
const SUPABASE_SESSION = { access_token: ACCESS_TOKEN, token_type: 'bearer', expires_in: 86400 * 365, expires_at: FAR_FUTURE, refresh_token: 'fake_refresh_token', user: { id: FAKE_UID, aud: 'authenticated', role: 'authenticated', email: FAKE_EMAIL, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } };
const FAKE_PROFILE = { id: FAKE_UID, email: FAKE_EMAIL, full_name: 'Nav Test', subscription_status: 'premium_active', country: 'US' };

async function newMockedContext(browser) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await context.route(`**/${SUPABASE_HOST}/rest/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await context.route(`**/${SUPABASE_HOST}/auth/**`, (route) => {
    const url = route.request().url();
    if (url.includes('/token') || url.includes('/session')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SUPABASE_SESSION) });
    if (url.includes('/user')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SUPABASE_SESSION.user) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await context.route(`**/${SUPABASE_HOST}/rest/v1/profiles*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([FAKE_PROFILE]) }));
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/billing/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'PREMIUM', plan: 'Premium', quotas: { ai_request: { unlimited: true } } }) }));
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/trial/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ activated: true }) }));
  return context;
}

async function newPage(context, { seedTrackerTab } = {}) {
  const page = await context.newPage();
  await page.addInitScript(([sessionKey, sessionJson]) => { localStorage.setItem(sessionKey, sessionJson); }, [SUPABASE_SESSION_KEY, JSON.stringify(SUPABASE_SESSION)]);
  if (seedTrackerTab) {
    await page.addInitScript((tab) => { sessionStorage.setItem('cp_tracker_tab', JSON.stringify(tab)); }, seedTrackerTab);
  }
  return page;
}

const results = [];
const check = (label, pass, detail) => { results.push({ label, pass }); console.log(`${pass ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`); };

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ===== Scenario 1: first-time user, no cp_tracker_tab set at all =====
  {
    const context = await newMockedContext(browser);
    const page = await newPage(context);
    await page.goto('http://localhost:5173/#dashboard');
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Full Analysis ↗' }).click();
    await page.waitForTimeout(800);
    const bodyText = await page.evaluate(() => document.body.innerText);
    check('Scenario 1 (first-time user, no stored tab): Full Analysis opens Insights', bodyText.includes('What is Application Outcome Intelligence?') || bodyText.includes('Funnel Overview'));
    await context.close();
  }

  // ===== Scenario 2: fresh browser session (brand-new context, nothing persisted) =====
  {
    const context = await newMockedContext(browser);
    const page = await newPage(context); // no seed at all -- fully fresh
    await page.goto('http://localhost:5173/#dashboard');
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Full Analysis ↗' }).click();
    await page.waitForTimeout(800);
    const bodyText = await page.evaluate(() => document.body.innerText);
    check('Scenario 2 (fresh browser session): Full Analysis opens Insights', bodyText.includes('What is Application Outcome Intelligence?') || bodyText.includes('Funnel Overview'));
    await context.close();
  }

  // ===== Scenario 3: returning user whose last Tracker tab was Applications =====
  {
    const context = await newMockedContext(browser);
    const page = await newPage(context, { seedTrackerTab: 'applications' });
    await page.goto('http://localhost:5173/#dashboard');
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: 'Full Analysis ↗' }).click();
    await page.waitForTimeout(800);
    const bodyText = await page.evaluate(() => document.body.innerText);
    check('Scenario 3 (last tab was Applications): Full Analysis STILL opens Insights', bodyText.includes('What is Application Outcome Intelligence?') || bodyText.includes('Funnel Overview'));
    await context.close();
  }

  // ===== Scenario 4: normal in-Tracker navigation still remembers the last tab =====
  {
    const context = await newMockedContext(browser);
    const page = await newPage(context);
    await page.goto('http://localhost:5173/#dashboard');
    await page.waitForTimeout(1000);
    await page.goto('http://localhost:5173/#tracker');
    await page.waitForTimeout(1000);
    // Default lands on Applications tab.
    let bodyText = await page.evaluate(() => document.body.innerText);
    check('Scenario 4a: fresh Tracker visit defaults to Applications tab', bodyText.includes('No Applications Yet') || bodyText.includes('applications tracked'));
    // Manually click Insights.
    await page.getByRole('button', { name: /Insights/ }).click();
    await page.waitForTimeout(500);
    bodyText = await page.evaluate(() => document.body.innerText);
    check('Scenario 4b: manual click to Insights works', bodyText.includes('What is Application Outcome Intelligence?') || bodyText.includes('Funnel Overview'));
    // Navigate away and back to Tracker via normal navigation (not the Dashboard button).
    await page.goto('http://localhost:5173/#dashboard');
    await page.waitForTimeout(800);
    await page.goto('http://localhost:5173/#tracker');
    await page.waitForTimeout(800);
    bodyText = await page.evaluate(() => document.body.innerText);
    check('Scenario 4c: normal Tracker navigation still remembers Insights was last selected', bodyText.includes('What is Application Outcome Intelligence?') || bodyText.includes('Funnel Overview'));
    await context.close();
  }

  console.log('\n=== SUMMARY ===');
  const failed = results.filter(r => !r.pass);
  console.log(failed.length === 0 ? `✅ ALL ${results.length} CHECKS PASSED` : `❌ ${failed.length}/${results.length} CHECKS FAILED: ${failed.map(f => f.label).join('; ')}`);

  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
})();

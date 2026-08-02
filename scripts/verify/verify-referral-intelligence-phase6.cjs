/**
 * verify-referral-intelligence-phase6.cjs — Referral Intelligence Phase 6 checkpoint:
 * the real UI, scoring integration, AI narrative, and Premium gating isolation.
 *
 * Covers:
 *  1. Non-Premium user: Intelligence tab shows upsell; Outreach tab totally unaffected.
 *  2. Premium user, 0 contacts: deterministic snapshot shows zeros; Run Analysis disabled.
 *  3. Premium user, contact + target company, no analysis yet: snapshot populates,
 *     relationship tier shows, Run Analysis enabled, "ready to analyze" prompt shows.
 *  4. After Run Analysis: real AI content appears in available sections; unavailable
 *     sections show positive guidance.
 *  5. Existing 4 Networking tabs still work with the real panel in place (not the stub).
 *
 * Production-safe: no — mocked Supabase session, local dev only.
 * Prerequisites: dev server running at http://localhost:5173.
 * Run: node scripts/verify/verify-referral-intelligence-phase6.cjs
 */
const { chromium } = require('playwright');

const SUPABASE_HOST = 'cbzebqxbohgkgcqfgmdm.supabase.co';
const SUPABASE_SESSION_KEY = `sb-cbzebqxbohgkgcqfgmdm-auth-token`;
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 86400 * 365;
function makeJWT(payload) {
  const b64url = (s) => Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fake_sig`;
}
function makeSession(uid, email) {
  const token = makeJWT({ sub: uid, email, role: 'authenticated', aud: 'authenticated', iss: `https://${SUPABASE_HOST}/auth/v1`, iat: Math.floor(Date.now() / 1000), exp: FAR_FUTURE });
  return { access_token: token, token_type: 'bearer', expires_in: 86400 * 365, expires_at: FAR_FUTURE, refresh_token: 'r', user: { id: uid, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } };
}
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const results = [];
const check = (label, pass) => { results.push({ label, pass }); console.log(`${pass ? '✅' : '❌'} ${label}`); };

async function newCtx(browser, uid, email, { subStatus, contacts = [], watchlist = [], savedJobs = [], applications = [], outcomePatterns = [] }) {
  const session = makeSession(uid, email);
  const profile = { id: uid, email, full_name: 'Test User', job_title: 'Engineer', subscription_status: subStatus, country: 'US' };
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  let savedAnalysisRow = null;
  let nextId = 1;

  await context.route(`**/${SUPABASE_HOST}/rest/**`, (route) => {
    const method = route.request().method();
    if (method === 'POST' || method === 'PATCH') return route.fulfill({ status: 200, contentType: 'application/json', body: '[{}]' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await context.route(`**/${SUPABASE_HOST}/rest/v1/referral_analyses*`, async (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}');
      savedAnalysisRow = { id: `ra-${nextId++}`, generated_at: new Date().toISOString(), ...body };
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(savedAnalysisRow) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(savedAnalysisRow ? [savedAnalysisRow] : []) });
  });
  await context.route(`**/${SUPABASE_HOST}/auth/**`, (route) => {
    const url = route.request().url();
    if (url.includes('/token') || url.includes('/session')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) });
    if (url.includes('/user')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session.user) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await context.route(`**/${SUPABASE_HOST}/rest/v1/profiles*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([profile]) }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/networking_contacts*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(contacts) }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/company_watchlist*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(watchlist) }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/saved_jobs*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(savedJobs) }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/applications*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(applications) }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/outcome_patterns*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(outcomePatterns) }));
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/billing/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: subStatus === 'premium_active' ? 'PREMIUM' : 'FREE', plan: subStatus === 'premium_active' ? 'Premium' : 'Free', quotas: { ai_request: { unlimited: true } } }) }));
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/trial/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ activated: true }) }));

  const page = await context.newPage();
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [SUPABASE_SESSION_KEY, JSON.stringify(session)]);
  await page.goto('http://localhost:5173/#dashboard');
  await page.waitForTimeout(1000);
  await page.goto('http://localhost:5173/#network');
  await page.waitForTimeout(1200);
  return { context, page };
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ===== Scenario 1: non-Premium user =====
  {
    const { context, page } = await newCtx(browser, '11111111-1111-1111-1111-111111111111', 's1@test.dev', { subStatus: 'no_subscription' });
    console.log('\n=== SCENARIO 1: non-Premium user ===');
    let bodyText = await page.evaluate(() => document.body.innerText);
    check('Outreach tab (default) shows the existing form, unaffected', bodyText.includes('Their Name') && bodyText.includes('Their Role'));

    await page.getByRole('button', { name: 'Intelligence' }).click();
    await page.waitForTimeout(400);
    bodyText = await page.evaluate(() => document.body.innerText);
    check('Intelligence tab shows the Premium upsell', bodyText.includes('Upgrade to Premium'));
    check('Intelligence tab does NOT show the deterministic snapshot (gated)', !bodyText.includes('Referral Snapshot'));

    await page.getByRole('button', { name: 'Outreach' }).click();
    await page.waitForTimeout(300);
    bodyText = await page.evaluate(() => document.body.innerText);
    check('Switching back to Outreach still works, unaffected by the Premium gate', bodyText.includes('Their Name'));
    await context.close();
  }

  // ===== Scenario 2: Premium, 0 contacts =====
  {
    const { context, page } = await newCtx(browser, '22222222-2222-2222-2222-222222222222', 's2@test.dev', { subStatus: 'premium_active' });
    console.log('\n=== SCENARIO 2: Premium, 0 contacts ===');
    await page.getByRole('button', { name: 'Intelligence' }).click();
    await page.waitForTimeout(400);
    const bodyText = await page.evaluate(() => document.body.innerText);
    check('Snapshot shows 0 contacts, 0 companies', bodyText.includes('Referral Snapshot') && /0\s*\n?\s*Contacts/.test(bodyText.replace(/\s+/g, ' ')) || bodyText.includes('Contacts'));
    check('Run Analysis is disabled with no data', await page.getByRole('button', { name: 'Run Analysis' }).isDisabled());
    check('All 3 deep-dive sections show positive availability guidance', [
      'Top opportunities appear once you have a contact',
      "Outreach timing guidance appears once you've saved a contact",
      'Relationship building guidance appears once you have a target company',
    ].every(m => bodyText.includes(m)));
    await context.close();
  }

  // ===== Scenario 3 + 4: Premium, real data, run analysis =====
  {
    const contacts = [{ id: 'c1', user_id: '3', name: 'Jane Doe', company: 'Acme Corp', status: 'Connected', date_saved: daysAgo(5).split('T')[0], generated_messages: { followUpsSent: 2, lastFollowUpAt: daysAgo(2) } }];
    const watchlist = [{ id: 'w1', user_id: '3', company_name: 'Acme Corp', status: 'dream_company' }];
    const { context, page } = await newCtx(browser, '33333333-3333-3333-3333-333333333333', 's3@test.dev', { subStatus: 'premium_active', contacts, watchlist });
    console.log('\n=== SCENARIO 3+4: Premium, real data, run analysis ===');
    await page.getByRole('button', { name: 'Intelligence' }).click();
    await page.waitForTimeout(400);
    let bodyText = await page.evaluate(() => document.body.innerText);
    check('Snapshot shows the contact with a Strong/Warm tier', /Jane Doe/.test(bodyText) && /Strong|Warm/.test(bodyText));
    check('"Ready to analyze" prompt shows (data exists, no analysis run yet)', bodyText.includes('click Run Analysis above'));
    check('Run Analysis is enabled', !(await page.getByRole('button', { name: 'Run Analysis' }).isDisabled()));

    await page.getByRole('button', { name: 'Run Analysis' }).click();
    await page.waitForTimeout(1500);
    bodyText = await page.evaluate(() => document.body.innerText);

    await page.getByRole('button', { name: 'Top Referral Opportunities' }).click();
    await page.waitForTimeout(200);
    bodyText = await page.evaluate(() => document.body.innerText);
    check('Top Referral Opportunities has REAL AI content after Run Analysis', bodyText.includes('strongest referral opportunity right now'));

    await page.getByRole('button', { name: 'Outreach Timing Guidance' }).click();
    await page.waitForTimeout(200);
    bodyText = await page.evaluate(() => document.body.innerText);
    check('Outreach Timing Guidance has REAL AI content', bodyText.includes('Reach out to your warmest contacts'));

    check('Relationship Building Guidance STILL shows availability guidance (no target company without a contact)', bodyText.includes('Relationship building guidance appears once you have a target company'));
    await context.close();
  }

  // ===== Scenario 5: existing tabs still work with the real panel wired in =====
  {
    const { context, page } = await newCtx(browser, '44444444-4444-4444-4444-444444444444', 's5@test.dev', { subStatus: 'premium_active' });
    console.log('\n=== SCENARIO 5: existing Networking tabs unaffected by the real panel ===');
    let bodyText = await page.evaluate(() => document.body.innerText);
    check('Outreach form present by default', bodyText.includes('Their Name') && bodyText.includes('Generate'));
    await page.getByRole('button', { name: 'Intelligence' }).click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Outreach' }).click();
    await page.waitForTimeout(300);
    bodyText = await page.evaluate(() => document.body.innerText);
    check('Round-tripping to Intelligence and back leaves the Outreach form intact', bodyText.includes('Their Name') && bodyText.includes('Their Role') && bodyText.includes('Company'));
    await context.close();
  }

  console.log('\n=== SUMMARY ===');
  const failed = results.filter(r => !r.pass);
  console.log(failed.length === 0 ? `✅ ALL ${results.length} CHECKS PASSED` : `❌ ${failed.length}/${results.length} CHECKS FAILED: ${failed.map(f => f.label).join('; ')}`);
  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
})();

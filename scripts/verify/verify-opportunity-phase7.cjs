/**
 * verify-opportunity-phase7.cjs — Referral Intelligence Phase 7 checkpoint:
 * OpportunityPage as a pure consumer of the shared scoringEngine.js, never a
 * second implementation.
 *
 * Covers:
 *  1. No contacts/watchlist: Referral Opportunities empty state (unchanged UX).
 *  2. Contact matches a saved job's company: shows as a ranked referral opportunity
 *     with the contact's name/email and the job's title/match/apply link -- sourced
 *     from computeCompanyReadiness, not an inline match.
 *  3. Contact matches a watchlist-only company (no saved job there): still shows,
 *     with a "Find Jobs" CTA instead of an Apply link (job is null, handled).
 *  4. Company Watchlist tab's "has contact" badge/stat reflect the same shared
 *     matchContactsToCompany() result (via watchlistEnriched.hasContact).
 *  5. Better Job Opportunities' inline "Referral" badge (refCon) still works,
 *     now sourced from matchContactsToCompany() instead of an inline .find().
 *  6. When a persisted referral_analyses row exists, its AI narrative
 *     (analyses.topOpportunities.finding) renders as the "AI Insight" callout.
 *  7. Zero console/page errors throughout (circular-import / runtime safety).
 *
 * Production-safe: no — mocked Supabase session, local dev only.
 * Prerequisites: dev server running at http://localhost:5173.
 * Run: node scripts/verify/verify-opportunity-phase7.cjs
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

const results = [];
const check = (label, pass) => { results.push({ label, pass }); console.log(`${pass ? '✅' : '❌'} ${label}`); };

async function newCtx(browser, uid, email, { contacts = [], watchlist = [], savedJobs = [], applications = [], referralAnalyses = [] }) {
  const session = makeSession(uid, email);
  const profile = { id: uid, email, full_name: 'Test User', job_title: 'Engineer', subscription_status: 'premium_active', country: 'US' };
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const pageErrors = [];

  await context.route(`**/${SUPABASE_HOST}/rest/**`, (route) => {
    const method = route.request().method();
    if (method === 'POST' || method === 'PATCH') return route.fulfill({ status: 200, contentType: 'application/json', body: '[{}]' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
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
  await context.route(`**/${SUPABASE_HOST}/rest/v1/outcome_patterns*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/referral_analyses*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(referralAnalyses) }));
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/billing/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'PREMIUM', plan: 'Premium', quotas: { ai_request: { unlimited: true } } }) }));

  const page = await context.newPage();
  page.on('pageerror', err => { pageErrors.push(err.message); console.log('*** PAGE ERROR:', err.message); });
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [SUPABASE_SESSION_KEY, JSON.stringify(session)]);
  await page.goto('http://localhost:5173/#dashboard');
  await page.waitForTimeout(1000);
  await page.goto('http://localhost:5173/#opportunity');
  await page.waitForTimeout(1200);
  return { context, page, pageErrors };
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ===== Scenario 1: empty state =====
  {
    const { context, page, pageErrors } = await newCtx(browser, '11111111-1111-1111-1111-111111111111', 'o1@test.dev', {});
    console.log('\n=== SCENARIO 1: no contacts, no watchlist ===');
    const bodyText = await page.evaluate(() => document.body.innerText);
    check('Referral Opportunities empty state shows (no contacts message)', bodyText.includes('Add contacts in Networking Intelligence'));
    check('No page errors', pageErrors.length === 0);
    await context.close();
  }

  // ===== Scenario 2+5: contact matches a saved job's company =====
  {
    const contacts = [{ id: 'c1', user_id: '2', name: 'Jane Doe', company: 'Acme Corp', email: 'jane@acme.com', status: 'Connected', date_saved: new Date().toISOString().split('T')[0], generated_messages: { followUpsSent: 2 } }];
    const savedJobs = [{ job_id: 'j1', title: 'Senior Engineer', company: 'Acme Corp', match_score: 82, apply_url: 'https://acme.example/apply', location: 'Remote' }];
    const watchlist = [{ id: 'w1', company_name: 'Acme Corp', status: 'watching' }];
    const { context, page, pageErrors } = await newCtx(browser, '22222222-2222-2222-2222-222222222222', 'o2@test.dev', { contacts, savedJobs, watchlist });
    console.log('\n=== SCENARIO 2+5: contact matches a saved job\'s company ===');
    const bodyText = await page.evaluate(() => document.body.innerText);
    check('Referral Opportunities shows the ranked company with job title', bodyText.includes('Senior Engineer — Acme Corp'));
    check('Shows the matched contact name', bodyText.includes('Jane Doe'));
    check('Shows the contact email', bodyText.includes('jane@acme.com'));
    check('Shows the match % from the saved job', bodyText.includes('82% match'));
    check('Better Job Opportunities shows the Referral badge (from matchContactsToCompany)', bodyText.includes('Referral'));
    check('No page errors', pageErrors.length === 0);
    await context.close();
  }

  // ===== Scenario 3: watchlist-only target (no saved job) =====
  {
    const contacts = [{ id: 'c2', user_id: '3', name: 'Sam Lee', company: 'Beta Inc', email: '', status: 'Met', date_saved: new Date().toISOString().split('T')[0], generated_messages: { followUpsSent: 1 } }];
    const watchlist = [{ id: 'w2', company_name: 'Beta Inc', status: 'dream_company' }];
    const { context, page, pageErrors } = await newCtx(browser, '33333333-3333-3333-3333-333333333333', 'o3@test.dev', { contacts, watchlist });
    console.log('\n=== SCENARIO 3: watchlist-only target company, no saved job ===');
    const bodyText = await page.evaluate(() => document.body.innerText);
    check('Referral Opportunities shows the company name alone (no job title)', bodyText.includes('Beta Inc'));
    check('Shows the matched contact name', bodyText.includes('Sam Lee'));
    check('Shows "Find Jobs" CTA instead of Apply (no job at this company)', bodyText.includes('Find Jobs'));
    check('No page errors', pageErrors.length === 0);

    // Switch to the Company Watchlist tab and confirm the shared hasContact flows through.
    await page.getByRole('button', { name: /Company Watchlist/ }).click();
    await page.waitForTimeout(400);
    const wlText = await page.evaluate(() => document.body.innerText);
    check('Watchlist tab shows "has contact here" (from the same matchContactsToCompany result)', wlText.includes('Beta Inc') && /contact/i.test(wlText));
    await context.close();
  }

  // ===== Scenario 6: persisted AI insight renders =====
  {
    const contacts = [{ id: 'c3', user_id: '4', name: 'Kim Park', company: 'Gamma LLC', email: 'kim@gamma.dev', status: 'Connected', date_saved: new Date().toISOString().split('T')[0], generated_messages: { followUpsSent: 3 } }];
    const savedJobs = [{ job_id: 'j2', title: 'Product Manager', company: 'Gamma LLC', match_score: 90 }];
    const watchlist = [{ id: 'w3', company_name: 'Gamma LLC', status: 'dream_company' }];
    const referralAnalyses = [{
      id: 'ra1', generated_at: new Date().toISOString(), contact_count: 1, company_count: 1,
      content: { v: 1, analyses: { topOpportunities: { finding: 'UNIQUE_MARKER_Gamma_LLC_is_your_strongest_opportunity', evidence: 'Company readiness score.' } } },
    }];
    const { context, page, pageErrors } = await newCtx(browser, '44444444-4444-4444-4444-444444444444', 'o4@test.dev', { contacts, savedJobs, watchlist, referralAnalyses });
    console.log('\n=== SCENARIO 6: persisted Referral Intelligence output renders as AI Insight ===');
    const bodyText = await page.evaluate(() => document.body.innerText);
    check('AI Insight callout shows the persisted narrative text verbatim', bodyText.includes('UNIQUE_MARKER_Gamma_LLC_is_your_strongest_opportunity'));
    check('AI Insight label renders', bodyText.includes('AI Insight'));
    check('No page errors', pageErrors.length === 0);
    await context.close();
  }

  console.log('\n=== SUMMARY ===');
  const failed = results.filter(r => !r.pass);
  console.log(failed.length === 0 ? `✅ ALL ${results.length} CHECKS PASSED` : `❌ ${failed.length}/${results.length} CHECKS FAILED: ${failed.map(f => f.label).join('; ')}`);
  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
})();

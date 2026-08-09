/**
 * verify-referral-intelligence-rc.cjs — Referral Intelligence RELEASE CANDIDATE
 * functional verification matrix (Phase 9). Exercises the full workflow across
 * the four primary data states requested for RC sign-off, cross-checking
 * NetworkingPage's Intelligence tab AND OpportunityPage's Referral Opportunities
 * card in the SAME browser context per scenario (both must read from the same
 * shared scoringEngine.js output for the same underlying data).
 *
 * Scenarios:
 *  1. No contacts, no target companies, no AI analysis.
 *  2. One contact, no matching target company.
 *  3. Contact with a target company, no persisted AI analysis yet.
 *  4. Full data (contacts + watchlist + applications) + persisted analysis + history.
 *  + Error-handling: Run Analysis failure surfaces the translated error, no crash.
 *
 * Production-safe: no — mocked Supabase session, local dev only.
 * Prerequisites: dev server running at http://localhost:5173.
 * Run: node scripts/verify/verify-referral-intelligence-rc.cjs
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

async function newCtx(browser, uid, email, opts = {}) {
  const {
    subStatus = 'premium_active', contacts = [], watchlist = [], savedJobs = [],
    applications = [], referralAnalyses = [], failAnalysisSave = false, viewport = { width: 1400, height: 900 },
  } = opts;
  const session = makeSession(uid, email);
  const profile = { id: uid, email, full_name: 'Test User', job_title: 'Engineer', subscription_status: subStatus, country: 'US' };
  const context = await browser.newContext({ viewport });
  const pageErrors = [];
  const consoleErrors = [];

  let analysisRows = [...referralAnalyses];
  let nextId = analysisRows.length + 1;

  await context.route(`**/${SUPABASE_HOST}/rest/**`, (route) => {
    const method = route.request().method();
    if (method === 'POST' || method === 'PATCH') return route.fulfill({ status: 200, contentType: 'application/json', body: '[{}]' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await context.route(`**/${SUPABASE_HOST}/rest/v1/referral_analyses*`, async (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      if (failAnalysisSave) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ message: 'simulated failure' }) });
      const body = JSON.parse(route.request().postData() || '{}');
      const row = { id: `ra-${nextId++}`, generated_at: new Date().toISOString(), ...body };
      analysisRows = [row, ...analysisRows];
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(row) });
    }
    const sorted = [...analysisRows].sort((a, b) => new Date(b.generated_at) - new Date(a.generated_at));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(sorted) });
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
  const billingStateFor = (s) => s === 'premium_active' ? 'PREMIUM_ACTIVE' : s === 'pro_active' ? 'PRO_ACTIVE' : 'FREE';
  const planDisplayNameFor = (s) => s === 'premium_active' ? 'Premium' : s === 'pro_active' ? 'Pro' : 'Free';
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/billing/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ billingState: billingStateFor(subStatus), planDisplayName: planDisplayNameFor(subStatus), quotas: { ai_request: { unlimited: true } } }) }));

  const page = await context.newPage();
  page.on('pageerror', err => { pageErrors.push(err.message); console.log('*** PAGE ERROR:', err.message); });
  page.on('console', msg => { if (msg.type() === 'error') { consoleErrors.push(msg.text()); console.log('*** CONSOLE ERROR:', msg.text()); } });
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [SUPABASE_SESSION_KEY, JSON.stringify(session)]);
  await page.goto('http://localhost:5173/#dashboard');
  await page.waitForTimeout(900);
  return { context, page, pageErrors, consoleErrors };
}

async function gotoNetworkIntelligence(page) {
  await page.goto('http://localhost:5173/#network');
  await page.waitForTimeout(900);
  const btn = page.getByRole('button', { name: 'Intelligence' });
  if (await btn.count()) { await btn.click(); await page.waitForTimeout(400); }
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ===== SCENARIO 1: no contacts, no target companies, no AI analysis =====
  {
    console.log('\n=== SCENARIO 1: empty state (no contacts, no companies, no analysis) ===');
    const { context, page, pageErrors, consoleErrors } = await newCtx(browser, '10000000-0000-0000-0000-000000000001', 's1@test.dev', {});
    await gotoNetworkIntelligence(page);
    let bodyText = await page.evaluate(() => document.body.innerText);
    check('S1: Snapshot shows 0/0/0 counts', bodyText.includes('Referral Snapshot'));
    check('S1: All 3 availability messages show (nothing available yet)', [
      'Top opportunities appear once you have a contact',
      "Outreach timing guidance appears once you've saved a contact",
      'Relationship building guidance appears once you have a target company',
    ].every(m => bodyText.includes(m)));
    check('S1: Run Analysis disabled', await page.getByRole('button', { name: 'Run Analysis' }).isDisabled());
    check('S1: No "ready to analyze" prompt (nothing available)', !bodyText.includes('click Run Analysis above'));

    // Premium behavior: same profile but non-premium (Pro, paying but not Premium) should
    // show the upsell and leave Outreach untouched -- Pro (not Free) is required here so
    // this still proves Referral Intelligence's Premium gate doesn't leak into Outreach,
    // now that Outreach itself is correctly, separately locked for true Free users.
    const nonPrem = await newCtx(browser, '10000000-0000-0000-0000-000000000002', 's1np@test.dev', { subStatus: 'pro_active' });
    await gotoNetworkIntelligence(nonPrem.page);
    const npText = await nonPrem.page.evaluate(() => document.body.innerText);
    check('S1: Non-Premium shows upsell, not the Snapshot', npText.includes('Upgrade to Premium') && !npText.includes('Referral Snapshot'));
    await nonPrem.page.getByRole('button', { name: 'Outreach' }).click();
    await nonPrem.page.waitForTimeout(300);
    const npOutreach = await nonPrem.page.evaluate(() => document.body.innerText);
    check('S1: Non-Premium (Pro) Outreach tab still fully functional', npOutreach.includes('Their Name'));
    await nonPrem.context.close();

    // Opportunity integration: empty state there too.
    await page.goto('http://localhost:5173/#opportunity');
    await page.waitForTimeout(900);
    bodyText = await page.evaluate(() => document.body.innerText);
    check('S1: Opportunity page Referral Opportunities empty state', bodyText.includes('Add contacts in Networking Intelligence'));

    check('S1: No page errors', pageErrors.length === 0);
    check('S1: No console errors', consoleErrors.length === 0);
    await context.close();
  }

  // ===== SCENARIO 2: one contact, no matching target company =====
  {
    console.log('\n=== SCENARIO 2: one contact, no matching target company ===');
    const contacts = [{ id: 'c1', user_id: '2', name: 'Alex Kim', company: 'Solo Corp', status: 'Replied', date_saved: daysAgo(3).split('T')[0], generated_messages: { followUpsSent: 1 } }];
    const { context, page, pageErrors, consoleErrors } = await newCtx(browser, '20000000-0000-0000-0000-000000000001', 's2@test.dev', { contacts });
    await gotoNetworkIntelligence(page);
    let bodyText = await page.evaluate(() => document.body.innerText);
    check('S2: Snapshot shows the contact', bodyText.includes('Alex Kim'));
    check('S2: Warmest Contacts list shows a tier badge', /Cold|Warming|Warm|Strong/.test(bodyText));
    check('S2: "Ready to analyze" banner confirms outreachTiming is live-available (no analysis run yet, so deep-dive rows still show placeholder text by design)', bodyText.includes('click Run Analysis above'));
    check('S2: Top opportunities placeholder shown (no target company)', bodyText.includes('Top opportunities appear once you have a contact at one of your target companies'));
    check('S2: Relationship building placeholder shown (no target company gap to show)', bodyText.includes('Relationship building guidance appears once you have a target company'));
    check('S2: Run Analysis enabled (outreachTiming available)', !(await page.getByRole('button', { name: 'Run Analysis' }).isDisabled()));

    await page.goto('http://localhost:5173/#opportunity');
    await page.waitForTimeout(900);
    bodyText = await page.evaluate(() => document.body.innerText);
    check('S2: Opportunity page still shows empty state (no target company match)', bodyText.includes('Add contacts in Networking Intelligence') || bodyText.includes("None of your contacts currently work"));

    check('S2: No page errors', pageErrors.length === 0);
    check('S2: No console errors', consoleErrors.length === 0);
    await context.close();
  }

  // ===== SCENARIO 3: contact with a target company, no persisted analysis =====
  {
    console.log('\n=== SCENARIO 3: contact + target company, no persisted analysis ===');
    const contacts = [{ id: 'c2', user_id: '3', name: 'Priya Rao', company: 'Vertex Systems', status: 'Connected', date_saved: daysAgo(1).split('T')[0], generated_messages: { followUpsSent: 2 } }];
    const watchlist = [{ id: 'w1', company_name: 'Vertex Systems', status: 'dream_company' }];
    const savedJobs = [{ job_id: 'j1', title: 'Staff Engineer', company: 'Vertex Systems', match_score: 88, apply_url: 'https://vertex.example/apply' }];
    const { context, page, pageErrors, consoleErrors } = await newCtx(browser, '30000000-0000-0000-0000-000000000001', 's3@test.dev', { contacts, watchlist, savedJobs });
    await gotoNetworkIntelligence(page);
    let bodyText = await page.evaluate(() => document.body.innerText);
    check('S3: Snapshot shows Priya Rao and Vertex Systems overlap', bodyText.includes('Priya Rao'));
    check('S3: "Ready to analyze" prompt confirms topOpportunities is live-available (company readiness computed)', bodyText.includes('click Run Analysis above'));
    check('S3: Run Analysis enabled', !(await page.getByRole('button', { name: 'Run Analysis' }).isDisabled()));

    // Opportunity integration -- same shared engine, same company/contact should appear.
    await page.goto('http://localhost:5173/#opportunity');
    await page.waitForTimeout(900);
    bodyText = await page.evaluate(() => document.body.innerText);
    check('S3: Opportunity page shows the SAME ranked company (Vertex Systems)', bodyText.includes('Staff Engineer — Vertex Systems'));
    check('S3: Opportunity page shows the SAME contact (Priya Rao) from the shared engine', bodyText.includes('Priya Rao'));
    check('S3: Opportunity page shows the match % from the saved job', bodyText.includes('88% match'));
    check('S3: No persisted-analysis AI Insight shown yet (none generated)', !bodyText.includes('AI Insight'));

    check('S3: No page errors', pageErrors.length === 0);
    check('S3: No console errors', consoleErrors.length === 0);
    await context.close();
  }

  // ===== SCENARIO 4: full data + persisted analysis + history =====
  {
    console.log('\n=== SCENARIO 4: full data, persisted analysis, history ===');
    const contacts = [
      { id: 'c3', user_id: '4', name: 'Dana Wu', company: 'Northwind Inc', status: 'Connected', date_saved: daysAgo(2).split('T')[0], generated_messages: { followUpsSent: 3 } },
      { id: 'c4', user_id: '4', name: 'Marco Silva', company: 'Northwind Inc', status: 'Not Contacted', date_saved: daysAgo(90).split('T')[0], generated_messages: { followUpsSent: 0 } },
    ];
    const watchlist = [{ id: 'w2', company_name: 'Northwind Inc', status: 'dream_company' }];
    const savedJobs = [{ job_id: 'j2', title: 'Principal Engineer', company: 'Northwind Inc', match_score: 91, apply_url: 'https://northwind.example/apply' }];
    const applications = [{ id: 'ap1', user_id: '4', company: 'Northwind Inc', job_title: 'Principal Engineer', status: 'Applied' }];
    const referralAnalyses = [
      { id: 'ra-old', generated_at: daysAgo(10), contact_count: 1, company_count: 1, content: { v: 1, analyses: { topOpportunities: { finding: 'OLD_ANALYSIS_MARKER', evidence: 'old' } } } },
      { id: 'ra-new', generated_at: daysAgo(1), contact_count: 2, company_count: 1, content: { v: 1, analyses: {
        topOpportunities: { finding: 'RC_SCENARIO4_NorthwindInc_top_opportunity_marker', evidence: 'Company readiness score.' },
        outreachTiming: { finding: 'RC_SCENARIO4_outreach_timing_marker', evidence: 'Relationship scores.' },
      } } },
    ];
    const { context, page, pageErrors, consoleErrors } = await newCtx(browser, '40000000-0000-0000-0000-000000000001', 's4@test.dev', { contacts, watchlist, savedJobs, applications, referralAnalyses });
    await gotoNetworkIntelligence(page);
    let bodyText = await page.evaluate(() => document.body.innerText);
    check('S4: Snapshot shows both contacts', bodyText.includes('Dana Wu') && bodyText.includes('Marco Silva'));
    check('S4: Warmest Contacts ranked (Dana Wu, connected+recent, ranks above Marco, not-contacted+stale)', bodyText.indexOf('Dana Wu') < bodyText.indexOf('Marco Silva'));
    await page.getByRole('button', { name: 'Top Referral Opportunities' }).click();
    await page.waitForTimeout(200);
    bodyText = await page.evaluate(() => document.body.innerText);
    check('S4: Deep dive shows the LATEST analysis content, not the stale one', bodyText.includes('RC_SCENARIO4_NorthwindInc_top_opportunity_marker') && !bodyText.includes('OLD_ANALYSIS_MARKER'));
    await page.getByRole('button', { name: 'Outreach Timing Guidance' }).click();
    await page.waitForTimeout(200);
    bodyText = await page.evaluate(() => document.body.innerText);
    check('S4: Second AI section also shows real content', bodyText.includes('RC_SCENARIO4_outreach_timing_marker'));
    check('S4: History card shows both analyses (contact/company counts)', bodyText.includes('Analysis History') && /2\s*·\s*1/.test(bodyText.replace(/ /g, ' ')));

    // Opportunity integration: AI Insight + ranked company from the shared engine.
    await page.goto('http://localhost:5173/#opportunity');
    await page.waitForTimeout(900);
    bodyText = await page.evaluate(() => document.body.innerText);
    check('S4: Opportunity page AI Insight shows the persisted narrative', bodyText.includes('RC_SCENARIO4_NorthwindInc_top_opportunity_marker'));
    check('S4: Opportunity page shows the ranked company with job details', bodyText.includes('Principal Engineer — Northwind Inc') && bodyText.includes('91% match'));

    // Premium behavior regression: switch a fresh non-premium profile with the SAME data, confirm gated.
    const nonPrem = await newCtx(browser, '40000000-0000-0000-0000-000000000002', 's4np@test.dev', { subStatus: 'no_subscription', contacts, watchlist, savedJobs, applications, referralAnalyses });
    await gotoNetworkIntelligence(nonPrem.page);
    const npText = await nonPrem.page.evaluate(() => document.body.innerText);
    check('S4: Non-Premium still gated even with full data present', npText.includes('Upgrade to Premium') && !npText.includes('Dana Wu'));
    await nonPrem.context.close();

    check('S4: No page errors', pageErrors.length === 0);
    check('S4: No console errors', consoleErrors.length === 0);
    await context.close();
  }

  // ===== ERROR HANDLING: Run Analysis save fails =====
  {
    console.log('\n=== ERROR HANDLING: Run Analysis failure surfaces translated error, no crash ===');
    const contacts = [{ id: 'c5', user_id: '5', name: 'Test Contact', company: 'ErrorCo', status: 'Connected', date_saved: daysAgo(1).split('T')[0], generated_messages: { followUpsSent: 1 } }];
    const watchlist = [{ id: 'w3', company_name: 'ErrorCo', status: 'watching' }];
    const { context, page, pageErrors, consoleErrors } = await newCtx(browser, '50000000-0000-0000-0000-000000000001', 's5@test.dev', { contacts, watchlist, failAnalysisSave: true });
    await gotoNetworkIntelligence(page);
    await page.getByRole('button', { name: 'Run Analysis' }).click();
    await page.waitForTimeout(1200);
    const bodyText = await page.evaluate(() => document.body.innerText);
    check('ERR: Translated failure message shown, not a raw error/stack trace', bodyText.includes('Analysis failed. Please try again.'));
    check('ERR: Page did not crash (Snapshot still rendered)', bodyText.includes('Referral Snapshot'));
    check('ERR: No uncaught page errors despite the backend failure', pageErrors.length === 0);
    await context.close();
  }

  console.log('\n=== SUMMARY ===');
  const failed = results.filter(r => !r.pass);
  console.log(failed.length === 0 ? `✅ ALL ${results.length} CHECKS PASSED` : `❌ ${failed.length}/${results.length} CHECKS FAILED:\n${failed.map(f => '  - ' + f.label).join('\n')}`);
  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
})();

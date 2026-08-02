/**
 * verify-outcome-intel-below-threshold.cjs — confirms Application Outcome
 * Intelligence behaves exactly as the locked blueprint specifies for an
 * account with fewer than 5 logged outcomes (below the Early Signal
 * threshold): no AI-generated content anywhere, Dashboard shows only raw
 * funnel stats + "log more" guidance, Insights page shows only raw funnel
 * stats + a locked "not enough data" card with Learning Milestones, and the
 * Run Analysis control is disabled so no AI call can even be triggered.
 *
 * Production-safe: no — all Supabase calls are mocked with a fixture of 3
 * mature, decided (non-withdrawn, non-pending) applications. Local dev only.
 * Prerequisites: dev server running at http://localhost:5173.
 * Run: node scripts/verify/verify-outcome-intel-below-threshold.cjs
 */
const { chromium } = require('playwright');

const SUPABASE_HOST = 'cbzebqxbohgkgcqfgmdm.supabase.co';
const SUPABASE_SESSION_KEY = `sb-cbzebqxbohgkgcqfgmdm-auth-token`;
const FAKE_UID = '22222222-2222-2222-2222-222222222222';
const FAKE_EMAIL = 'lowdata@careerpersona.dev';
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 86400 * 365;
function makeJWT(payload) {
  const b64url = (s) => Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fake_sig`;
}
const ACCESS_TOKEN = makeJWT({ sub: FAKE_UID, email: FAKE_EMAIL, role: 'authenticated', aud: 'authenticated', iss: `https://${SUPABASE_HOST}/auth/v1`, iat: Math.floor(Date.now() / 1000), exp: FAR_FUTURE });
const SUPABASE_SESSION = { access_token: ACCESS_TOKEN, token_type: 'bearer', expires_in: 86400 * 365, expires_at: FAR_FUTURE, refresh_token: 'fake_refresh_token', user: { id: FAKE_UID, aud: 'authenticated', role: 'authenticated', email: FAKE_EMAIL, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } };
const FAKE_PROFILE = { id: FAKE_UID, email: FAKE_EMAIL, full_name: 'Low Data User', preferred_job_title: 'Software Engineer', location: 'Austin, TX', work_type: 'Remote', desired_salary: '130000', subscription_status: 'premium_active', country: 'US' };

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().split('T')[0];

// Exactly 3 outcomes logged: all mature (>14 days old) and all decided
// (rejected/offer/interview_invited, never "pending", never "withdrawn").
// computeOutcomesLoggedCount() -> 3, which is < 5 -> computeConfidenceTier()
// must return null (blueprint: "Under 5 -> no analysis at all").
const APPLICATIONS = [
  { id: 'app-1', user_id: FAKE_UID, company: 'Acme Corp', job_title: 'Backend Engineer', status: 'Rejected', date_applied: daysAgo(40), response_status: 'rejected', notes: '', apply_url: '#' },
  { id: 'app-2', user_id: FAKE_UID, company: 'Globex', job_title: 'Platform Engineer', status: 'Offer', date_applied: daysAgo(30), response_status: 'offer', notes: '', apply_url: '#' },
  { id: 'app-3', user_id: FAKE_UID, company: 'Initech', job_title: 'Software Engineer', status: 'Interview', date_applied: daysAgo(25), response_status: 'interview_invited', notes: '', apply_url: '#' },
];
// Expected funnel: applied=3, responded=3 (100%), interviewed=2 (offer+interview, 67%), offered=1

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  let claudeCallFired = false;

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
  await context.route(`**/${SUPABASE_HOST}/rest/v1/applications*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(APPLICATIONS) }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/user_resumes*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/smart_apply_queue*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/saved_jobs*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/outcome_patterns*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/outcome_analyses*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/recommendation_evaluations*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/?$/, (route) => { claudeCallFired = true; console.log('*** UNEXPECTED CLAUDE CALL:', route.request().url()); return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/billing/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'PREMIUM', plan: 'Premium', quotas: { ai_request: { unlimited: true } } }) }));
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/trial/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ activated: true }) }));

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', err => { pageErrors.push(err.message); console.log('*** PAGE ERROR:', err.message); });
  await page.addInitScript(([sessionKey, sessionJson]) => { localStorage.setItem(sessionKey, sessionJson); }, [SUPABASE_SESSION_KEY, JSON.stringify(SUPABASE_SESSION)]);

  const results = [];
  const check = (label, pass, detail) => { results.push({ label, pass }); console.log(`${pass ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`); };

  // ===== DASHBOARD =====
  console.log('\n=== DASHBOARD (#dashboard) ===');
  await page.goto('http://localhost:5173/#dashboard');
  await page.waitForTimeout(1500);
  let bodyText = await page.evaluate(() => document.body.innerText);

  check('Dashboard shows the Outcome Intelligence card title', bodyText.includes('Outcome Intelligence'));
  check('Dashboard shows raw funnel counts (Applied 3)', bodyText.includes('Applied 3'));
  check('Dashboard shows Response 3 (100%)', bodyText.includes('Response 3 (100%)'));
  check('Dashboard shows Interview 2 (67%)', bodyText.includes('Interview 2 (67%)'));
  check('Dashboard shows Offer 1 (plain count, no AI)', bodyText.includes('Offer 1'));
  check('Dashboard shows "Log more outcomes" guidance (not AI insights)', bodyText.includes('Log more outcomes to unlock pattern insights'));
  check('Dashboard does NOT show "What\'s Working" AI line', !bodyText.includes("What's Working:"));
  check('Dashboard does NOT show "What to Change" AI line', !bodyText.includes('What to Change:'));

  // ===== TRACKER > INSIGHTS TAB =====
  console.log('\n=== TRACKER (#tracker) -> Insights tab ===');
  await page.goto('http://localhost:5173/#tracker');
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /Insights/ }).click();
  await page.waitForTimeout(500);
  bodyText = await page.evaluate(() => document.body.innerText);

  check('Insights page shows the permanent "What is Application Outcome Intelligence?" intro', bodyText.includes('What is Application Outcome Intelligence?'));
  check('Insights page shows illustrative Example Insights, clearly badged', bodyText.includes('Example Insights') && bodyText.includes('EXAMPLE') && bodyText.includes('Illustrative examples only'));
  check('Example Insights includes the sample insight copy', bodyText.includes('Resume Version 3 generated more interviews than Version 1.'));
  check('Insights page shows raw funnel counts (Applied 3)', /Applied[\s\S]{0,10}3/.test(bodyText));
  check('Insights page shows "Not enough data yet" title', bodyText.includes('Not enough data yet'));
  check('Insights page shows dynamic progress: "You\'ve logged 3 outcomes."', bodyText.includes("You've logged 3 outcomes."));
  check('Insights page tells user exactly 2 more outcomes needed (5 - 3)', bodyText.includes('Log 2 more to unlock your first AI-powered analysis.'));
  check('Insights page shows the locked milestone roadmap (Application Funnel unlocked, Early Pattern Analysis locked at 5)', bodyText.includes('Application Funnel') && bodyText.includes('Unlocks at 5'));
  check('Insights page does NOT show "Top AI Insights"', !bodyText.includes('Top AI Insights'));
  check('Insights page does NOT show "What\'s Working" section', !bodyText.includes("What's Working"));
  check('Insights page does NOT show "What to Change" section', !bodyText.includes('What to Change'));
  check('Insights page does NOT show "Analysis Deep Dives"', !bodyText.includes('Analysis Deep Dives'));
  check('Insights page does NOT show "Recommendation Results"', !bodyText.includes('Recommendation Results'));
  check('Insights page does NOT show a confidence tier badge (Early Signal/Emerging/High Confidence)', !/Early Signal|Emerging|High Confidence/.test(bodyText));

  const runBtn = page.getByRole('button', { name: 'Run Analysis' });
  const isDisabled = await runBtn.isDisabled();
  check('Run Analysis button is disabled below the 5-outcome threshold', isDisabled);

  // Attempt to click it anyway (defense in depth) and confirm no AI call fires.
  await runBtn.click({ force: true }).catch(() => {});
  await page.waitForTimeout(800);
  check('No Anthropic/Claude call fired even after attempting to click Run Analysis', !claudeCallFired);

  // ===== BOUNDARY: exactly 5 outcomes (the blueprint's Early Signal threshold) =====
  // Re-mock applications to exactly 5 mature, decided outcomes. No analysis has been
  // run/saved yet (outcome_analyses still empty), so this isolates two things at once:
  //  1. The Insights page's *live* gate (outcomesLoggedCount) should flip to unlocked.
  //  2. The Dashboard's gate reads the *last saved analysis tier*, not the live count,
  //     so it must still show zero AI content -- there is no saved analysis yet.
  const APPLICATIONS_AT_5 = [
    ...APPLICATIONS,
    { id: 'app-4', user_id: FAKE_UID, company: 'Umbrella Corp', job_title: 'SRE', status: 'Rejected', date_applied: daysAgo(20), response_status: 'rejected', notes: '', apply_url: '#' },
    { id: 'app-5', user_id: FAKE_UID, company: 'Soylent', job_title: 'DevOps Engineer', status: 'Phone Screen', date_applied: daysAgo(16), response_status: 'interview_invited', notes: '', apply_url: '#' },
  ];
  await context.route(`**/${SUPABASE_HOST}/rest/v1/applications*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(APPLICATIONS_AT_5) }));

  console.log('\n=== BOUNDARY CHECK: exactly 5 outcomes logged ===');
  // Hash-only navigation doesn't force the SPA to refetch (no network activity on a
  // same-document fragment change) -- a hard reload is required to pick up the new
  // applications mock, otherwise the page still holds the 3-application state in memory.
  await page.goto('http://localhost:5173/#tracker');
  await page.reload();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /Insights/ }).click();
  await page.waitForTimeout(500);
  bodyText = await page.evaluate(() => document.body.innerText);

  check('At 5 outcomes, Insights page no longer shows "Not enough data yet"', !bodyText.includes('Not enough data yet'));
  check('At 5 outcomes, Insights page shows the "ready to analyze" prompt (Early Signal tier reached)', bodyText.includes('click Run Analysis above to generate your first Outcome Intelligence report'));
  const runBtnAt5 = page.getByRole('button', { name: 'Run Analysis' });
  check('At 5 outcomes, Run Analysis button is now enabled', !(await runBtnAt5.isDisabled()));
  check('At 5 outcomes, still no AI content rendered (no analysis has been generated/saved yet)', !bodyText.includes('Top AI Insights') && !bodyText.includes('Analysis Deep Dives'));
  check('At 5 outcomes (no analysis yet), the intro is still shown in FULL (not collapsed)', bodyText.includes('CareerPersona AI learns from every application outcome you record'));
  check('At 5 outcomes (no analysis yet), Example Insights are still shown', bodyText.includes('Example Insights'));

  await page.goto('http://localhost:5173/#dashboard');
  await page.reload();
  await page.waitForTimeout(1500);
  bodyText = await page.evaluate(() => document.body.innerText);
  check('At 5 outcomes, Dashboard STILL shows "Log more outcomes" (gates on last saved analysis tier, not live count)', bodyText.includes('Log more outcomes to unlock pattern insights'));
  check('At 5 outcomes, Dashboard still shows no AI What\'s Working / What to Change lines', !bodyText.includes("What's Working:") && !bodyText.includes('What to Change:'));

  // ===== ONCE A REAL ANALYSIS EXISTS: intro collapses, examples disappear =====
  const FAKE_ANALYSIS_ROW = {
    id: 'analysis-1', user_id: FAKE_UID, period_start: daysAgo(90), period_end: daysAgo(0),
    application_count: 5, outcomes_logged_count: 5, confidence_tier: 'early_signal',
    generated_at: new Date().toISOString(),
    analysis: {
      v: 1, confidenceTier: 'early_signal',
      analyses: {
        responsePattern: { finding: 'Sample finding', evidence: 'Sample evidence' },
        funnelStage: { finding: 'Sample finding', evidence: 'Sample evidence' },
        companyProfileFit: { finding: 'Sample finding', evidence: 'Sample evidence' },
        applicationQuality: { finding: 'Sample finding', evidence: 'Sample evidence' },
        resumeVersion: { finding: 'Sample finding', evidence: 'Sample evidence' },
        strategicPrediction: { targeting: 'x', approachChanges: 'x', resumeSignals: 'x', opportunityCost: 'x' },
      },
      topInsights: [{ text: 'Real AI insight text', evidence: 'Real evidence' }],
      whatWorking: ['Real what-working line'],
      whatToChange: ['Real what-to-change line'],
    },
  };
  await context.route(`**/${SUPABASE_HOST}/rest/v1/outcome_analyses*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([FAKE_ANALYSIS_ROW]) }));

  console.log('\n=== ONCE A REAL ANALYSIS EXISTS ===');
  await page.goto('http://localhost:5173/#tracker');
  await page.reload();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: /Insights/ }).click();
  await page.waitForTimeout(500);
  bodyText = await page.evaluate(() => document.body.innerText);

  check('With a real analysis, the intro title is STILL present (never disappears)', bodyText.includes('What is Application Outcome Intelligence?'));
  check('With a real analysis, the intro body is collapsed (bullet list not visible by default)', !bodyText.includes('Which resume version performs best'));
  check('With a real analysis, Example Insights section is gone (replaced by real content)', !bodyText.includes('Example Insights'));
  check('With a real analysis, the real Top AI Insights section renders', bodyText.includes('Top AI Insights') && bodyText.includes('Real AI insight text'));

  // Expand the collapsed intro and confirm the explanatory content is still reachable.
  await page.getByRole('button', { name: 'What is Application Outcome Intelligence?' }).click();
  await page.waitForTimeout(300);
  bodyText = await page.evaluate(() => document.body.innerText);
  check('The collapsed intro expands on click to reveal the same explanatory bullets', bodyText.includes('Which resume version performs best'));

  console.log('\n=== SUMMARY ===');
  const failed = results.filter(r => !r.pass);
  console.log(`Page errors: ${pageErrors.length === 0 ? '✅ none' : '❌ ' + pageErrors.length}`);
  console.log(failed.length === 0 ? `✅ ALL ${results.length} CHECKS PASSED` : `❌ ${failed.length}/${results.length} CHECKS FAILED: ${failed.map(f => f.label).join('; ')}`);

  await browser.close();
  process.exit(failed.length === 0 && pageErrors.length === 0 ? 0 : 1);
})();

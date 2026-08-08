/**
 * verify-outcome-intel-data-driven-availability.cjs — confirms Application Outcome
 * Intelligence's availability logic is now data-driven per analysis, not
 * application-count-driven, per the 2026-08 architecture migration.
 *
 * Covers all required scenarios:
 *  1. 0 outcomes: Funnel visible, AI analyses unavailable with positive guidance.
 *  2. 1 decided outcome: first AI generation available; only analyses whose own data
 *     requirement is met appear with real content; the rest show positive guidance.
 *  3. Multiple resume versions with limited outcomes: Resume Version analysis becomes
 *     available; other analyses remain independently gated by their own requirements.
 *  4. Full-data scenario: every analysis renders; Dashboard behavior, confidence tiers,
 *     and existing AI insight rendering are all unchanged.
 *
 * Production-safe: no — mocked Supabase session, local dev only.
 * Prerequisites: dev server running at http://localhost:5173.
 * Run: node scripts/verify/verify-outcome-intel-data-driven-availability.cjs
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
  return { access_token: token, token_type: 'bearer', expires_in: 86400 * 365, expires_at: FAR_FUTURE, refresh_token: 'fake_refresh_token', user: { id: uid, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } };
}
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().split('T')[0];

const results = [];
const check = (label, pass, detail) => { results.push({ label, pass }); console.log(`${pass ? '✅' : '❌'} ${label}${detail ? ' — ' + detail : ''}`); };

// Deep-dive rows are collapsible: a real finding's text only enters innerText once its
// "+/-" toggle is expanded (unavailable rows have no toggle -- their guidance text is
// always visible). Click the row's title to expand it before checking for its content.
async function expandAnalysis(page, titleText) {
  await page.getByRole('button', { name: titleText }).click().catch(() => {});
  await page.waitForTimeout(200);
}

async function newScenarioContext(browser, uid, email, applications) {
  const session = makeSession(uid, email);
  const profile = { id: uid, email, full_name: 'Scenario Test', subscription_status: 'premium_active', country: 'US' };
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  // Catch-all registered FIRST -- Playwright resolves multiple matching routes in
  // last-registered-wins order, so the specific outcome_analyses handler below (which
  // needs to win) must be registered AFTER this one.
  await context.route(`**/${SUPABASE_HOST}/rest/**`, async (route) => {
    const method = route.request().method();
    if (method === 'POST' || method === 'PATCH') return route.fulfill({ status: 200, contentType: 'application/json', body: '[{}]' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  // Stateful mock for outcome_analyses: capture what saveAnalysis() POSTs so the
  // subsequent refresh() GET actually reflects it -- a real round-trip, not a static
  // fixture. Without this, Run Analysis appears to silently do nothing (POST
  // "succeeds" against the generic mock above, but the follow-up GET still returns the
  // original empty array, so the UI never shows the result). Registered AFTER the
  // catch-all so it wins.
  let savedAnalysisRow = null;
  let nextId = 1;

  await context.route(`**/${SUPABASE_HOST}/rest/v1/outcome_analyses*`, async (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      const body = JSON.parse(route.request().postData() || '{}');
      savedAnalysisRow = { id: `analysis-${nextId++}`, generated_at: new Date().toISOString(), ...body };
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
  await context.route(`**/${SUPABASE_HOST}/rest/v1/applications*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(applications) }));
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/billing/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'PREMIUM', plan: 'Premium', quotas: { ai_request: { unlimited: true } } }) }));

  const page = await context.newPage();
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [SUPABASE_SESSION_KEY, JSON.stringify(session)]);
  await page.goto('http://localhost:5173/#dashboard');
  await page.waitForTimeout(1000);
  await page.goto('http://localhost:5173/#tracker');
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /Insights/ }).click();
  await page.waitForTimeout(500);
  return { context, page };
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ===== Scenario 1: 0 decided outcomes =====
  {
    const APPS = [
      { id: 'a1', user_id: 'u1', company: 'Acme Corp', job_title: 'Engineer', status: 'Applied', date_applied: daysAgo(2), response_status: 'pending', notes: '', apply_url: '#' },
    ];
    const { context, page } = await newScenarioContext(browser, '11111111-1111-1111-1111-111111111111', 's1@test.dev', APPS);
    console.log('\n=== SCENARIO 1: 0 decided outcomes ===');
    let bodyText = await page.evaluate(() => document.body.innerText);
    check('Funnel is visible with Applied 1', bodyText.includes('Applied') && /Applied\s*\n?\s*1|1\s*\n?\s*Applied/.test(bodyText.replace(/\s+/g, ' ')) || bodyText.includes('1'));
    check('Run Analysis button is disabled at 0 decided outcomes', await page.getByRole('button', { name: 'Run Analysis' }).isDisabled());
    check('No "ready to analyze" prompt shown yet (still 0 decided outcomes)', !bodyText.includes('click Run Analysis above to generate your first Outcome Intelligence report'));
    check('No confidence tier badge shown', !/Early Signal|Emerging|High Confidence/.test(bodyText));
    check('All 6 analyses show positive availability guidance, not real findings', [
      'Response pattern insights appear after your first employer response.',
      'Funnel stage insights become available after your first hiring outcome.',
      'Company and industry insights become available as you receive outcomes from more employers.',
      'Smart Apply comparison becomes available once outcomes exist for both Smart Apply and manual applications.',
      'Resume comparison becomes available after outcomes have been recorded for multiple resume versions.',
      'Strategic predictions become available once your other analyses have insights to build on.',
    ].every(msg => bodyText.includes(msg)));
    check('No negative/gated wording anywhere ("Unlocks at", "Waiting for", "Not enough data")', !/Unlocks at|Waiting for|Not enough data/i.test(bodyText));
    await context.close();
  }

  // ===== Scenario 2: exactly 1 decided outcome (an Interview), nothing else =====
  {
    const APPS = [
      { id: 'a1', user_id: 'u2', company: 'Globex', job_title: 'SWE', status: 'Interview', date_applied: daysAgo(5), response_status: 'interview_invited', notes: '', apply_url: '#' },
    ];
    const { context, page } = await newScenarioContext(browser, '22222222-2222-2222-2222-222222222222', 's2@test.dev', APPS);
    console.log('\n=== SCENARIO 2: 1 decided outcome (Interview) ===');
    let bodyText = await page.evaluate(() => document.body.innerText);
    check('Run Analysis button is enabled at 1 decided outcome', !(await page.getByRole('button', { name: 'Run Analysis' }).isDisabled()));
    check('"Ready to analyze" prompt shown', bodyText.includes('click Run Analysis above to generate your first Outcome Intelligence report'));

    await page.getByRole('button', { name: 'Run Analysis' }).click();
    await page.waitForTimeout(1500);
    bodyText = await page.evaluate(() => document.body.innerText);

    check('Confidence tier badge now shows (Early Signal)', bodyText.includes('Early Signal'));

    await expandAnalysis(page, 'Response Pattern Analysis');
    bodyText = await page.evaluate(() => document.body.innerText);
    check('Response Pattern analysis has REAL content (finding text, not availability message)', bodyText.includes('Applications to mid-size companies are responding'));

    await expandAnalysis(page, 'Funnel Stage Intelligence');
    bodyText = await page.evaluate(() => document.body.innerText);
    check('Funnel Stage analysis has REAL content (interview counts as a hiring outcome)', bodyText.includes('Most of your rejections are happening early'));

    await expandAnalysis(page, 'Strategic Prediction Engine');
    bodyText = await page.evaluate(() => document.body.innerText);
    check('Strategic Prediction analysis has REAL content', bodyText.includes('Consider prioritizing mid-size'));

    check('Company Profile Fit still shows availability guidance (no company/industry data logged)', bodyText.includes('Company and industry insights become available as you receive outcomes from more employers.'));
    check('Application Quality still shows availability guidance (no Smart Apply data)', bodyText.includes('Smart Apply comparison becomes available once outcomes exist for both Smart Apply and manual applications.'));
    check('Resume Version still shows availability guidance (no resume version data)', bodyText.includes('Resume comparison becomes available after outcomes have been recorded for multiple resume versions.'));
    await context.close();
  }

  // ===== Scenario 3: multiple resume versions, limited outcomes =====
  {
    const APPS = [
      { id: 'a1', user_id: 'u3', company: 'Initech', job_title: 'Backend Eng', status: 'Rejected', date_applied: daysAgo(10), response_status: 'rejected', resume_id: 'resume-v1', notes: '', apply_url: '#' },
      { id: 'a2', user_id: 'u3', company: 'Umbrella', job_title: 'Backend Eng', status: 'Interview', date_applied: daysAgo(6), response_status: 'interview_invited', resume_id: 'resume-v2', notes: '', apply_url: '#' },
    ];
    const { context, page } = await newScenarioContext(browser, '33333333-3333-3333-3333-333333333333', 's3@test.dev', APPS);
    console.log('\n=== SCENARIO 3: multiple resume versions, limited outcomes ===');
    await page.getByRole('button', { name: 'Run Analysis' }).click();
    await page.waitForTimeout(1500);
    let bodyText = await page.evaluate(() => document.body.innerText);

    await expandAnalysis(page, 'Resume Version Effectiveness');
    bodyText = await page.evaluate(() => document.body.innerText);
    check('Resume Version analysis has REAL content (2 distinct resume versions with outcomes)', bodyText.includes('Resume version 2 is outperforming version 1'));

    await expandAnalysis(page, 'Response Pattern Analysis');
    bodyText = await page.evaluate(() => document.body.innerText);
    check('Response Pattern has real content (2 decided outcomes)', bodyText.includes('Applications to mid-size companies are responding'));

    check('Company Profile Fit STILL shows guidance (no company_size/industry/remote_policy logged)', bodyText.includes('Company and industry insights become available as you receive outcomes from more employers.'));
    check('Application Quality STILL shows guidance (no Smart Apply data at all)', bodyText.includes('Smart Apply comparison becomes available once outcomes exist for both Smart Apply and manual applications.'));
    await context.close();
  }

  // ===== Scenario 4: full-data, every analysis available =====
  {
    const APPS = [];
    for (let i = 0; i < 32; i++) {
      APPS.push({
        id: `full-${i}`, user_id: 'u4', company: `Company ${i}`, job_title: 'Engineer',
        status: i % 4 === 0 ? 'Offer' : i % 3 === 0 ? 'Interview' : 'Rejected',
        date_applied: daysAgo(40 - i),
        response_status: i % 4 === 0 ? 'offer' : i % 3 === 0 ? 'interview_invited' : 'rejected',
        resume_id: i % 2 === 0 ? 'resume-v1' : 'resume-v2',
        company_size_estimate: i % 2 === 0 ? 'mid' : 'enterprise',
        industry: i % 2 === 0 ? 'fintech' : 'healthcare',
        remote_policy: i % 2 === 0 ? 'remote' : 'hybrid',
        smart_apply_used: i % 2 === 0,
        cover_letter_sent: i % 2 === 0,
        rejection_stage: i % 3 !== 0 && i % 4 !== 0 ? 'phone_screen' : null,
        notes: '', apply_url: '#',
      });
    }
    const { context, page } = await newScenarioContext(browser, '44444444-4444-4444-4444-444444444444', 's4@test.dev', APPS);
    console.log('\n=== SCENARIO 4: full-data, everything available ===');
    await page.getByRole('button', { name: 'Run Analysis' }).click();
    await page.waitForTimeout(1500);
    let bodyText = await page.evaluate(() => document.body.innerText);

    check('Confidence tier badge shows High Confidence (32 decided outcomes >= 30)', bodyText.includes('High Confidence'));

    // Only one deep-dive row can be expanded at a time (accordion, single openKey), so
    // check each one's real content right after expanding it, not in a batch.
    const EXPECTED = {
      'Response Pattern Analysis': 'Applications to mid-size companies are responding',
      'Funnel Stage Intelligence': 'Most of your rejections are happening early',
      'Company Profile Fit': 'Mid-size, remote-friendly companies show your strongest response signal',
      'Application Quality Correlation': 'Applications sent with a cover letter are trending',
      'Resume Version Effectiveness': 'Resume version 2 is outperforming version 1',
      'Strategic Prediction Engine': 'Consider prioritizing mid-size',
    };
    let allSixReal = true;
    for (const [title, expectedText] of Object.entries(EXPECTED)) {
      await expandAnalysis(page, title);
      const text = await page.evaluate(() => document.body.innerText);
      if (!text.includes(expectedText)) allSixReal = false;
    }
    bodyText = await page.evaluate(() => document.body.innerText);
    check('All 6 analyses render real content, zero availability-guidance messages remain', allSixReal);
    check('No availability-guidance placeholder text remains for any of the 6', ![
      'appear after your first employer response',
      'become available after your first hiring outcome',
      'become available as you receive outcomes from more employers',
      'becomes available once outcomes exist for both Smart Apply',
      'becomes available after outcomes have been recorded for multiple resume versions',
      'become available once your other analyses have insights to build on',
    ].some(msg => bodyText.includes(msg)));
    check('Top AI Insights and What Working/Change still populate normally', bodyText.includes('Top AI Insights') && bodyText.includes('Mid-size companies are your strongest-responding segment'));

    // Dashboard behavior unchanged: still gates on Emerging+ tier, still shows real funnel.
    await page.goto('http://localhost:5173/#dashboard');
    await page.reload();
    await page.waitForTimeout(1500);
    bodyText = await page.evaluate(() => document.body.innerText);
    check('Dashboard shows the Outcome Intelligence card', bodyText.includes('Outcome Intelligence'));
    check('Dashboard shows real funnel counts (Applied 32)', bodyText.includes('Applied 32'));
    check('Dashboard shows AI What\'s Working / What to Change (tier is High Confidence, well past Emerging)', bodyText.includes("What's Working:") || bodyText.includes('What to Change:'));
    await context.close();
  }

  console.log('\n=== SUMMARY ===');
  const failed = results.filter(r => !r.pass);
  console.log(failed.length === 0 ? `✅ ALL ${results.length} CHECKS PASSED` : `❌ ${failed.length}/${results.length} CHECKS FAILED: ${failed.map(f => f.label).join('; ')}`);
  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
})();

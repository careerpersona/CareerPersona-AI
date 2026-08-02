/**
 * verify-referral-intelligence-responsive.cjs — Referral Intelligence RC
 * responsive validation (Phase 9). Desktop / tablet / mobile (375px), checking
 * for horizontal overflow (the standard proxy for "awkward wrapping, clipping,
 * or overflow" used throughout this app) plus screenshots of the mobile view
 * for visual confirmation.
 *
 * Production-safe: no — mocked Supabase session, local dev only.
 * Prerequisites: dev server running at http://localhost:5173.
 * Run: node scripts/verify/verify-referral-intelligence-responsive.cjs
 */
const { chromium } = require('playwright');
const path = require('path');

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

const SCRATCH = process.env.SCRATCH_DIR || path.join(__dirname, '_rc_screens');
require('fs').mkdirSync(SCRATCH, { recursive: true });

async function newCtx(browser, viewport) {
  const uid = '90000000-0000-0000-0000-000000000001';
  const email = 'resp@test.dev';
  const session = makeSession(uid, email);
  const profile = { id: uid, email, full_name: 'Test User', job_title: 'Engineer', subscription_status: 'premium_active', country: 'US' };
  const contacts = [
    { id: 'c1', user_id: uid, name: 'Dana Wu', company: 'Northwind International Holdings', status: 'Connected', date_saved: daysAgo(2).split('T')[0], generated_messages: { followUpsSent: 3 } },
    { id: 'c2', user_id: uid, name: 'Marco Silva', company: 'Northwind International Holdings', status: 'Not Contacted', date_saved: daysAgo(90).split('T')[0], generated_messages: { followUpsSent: 0 } },
  ];
  const watchlist = [{ id: 'w1', company_name: 'Northwind International Holdings', status: 'dream_company' }];
  const savedJobs = [{ job_id: 'j1', title: 'Principal Software Engineering Manager', company: 'Northwind International Holdings', match_score: 91, apply_url: 'https://northwind.example/apply' }];
  const applications = [{ id: 'ap1', user_id: uid, company: 'Northwind International Holdings', job_title: 'Principal Software Engineering Manager', status: 'Applied' }];
  const referralAnalyses = [
    {
      id: 'ra1', generated_at: new Date().toISOString(), contact_count: 2, company_count: 1,
      content: { v: 1, analyses: {
        topOpportunities: { finding: 'Northwind International Holdings is your strongest referral opportunity based on Dana Wu’s strong relationship score and dream-company status.', evidence: 'Company readiness score of 92.' },
        outreachTiming: { finding: 'Reach out to Dana Wu within the next few days while the relationship is still fresh.', evidence: 'Recency-weighted relationship score.' },
      } },
    },
    {
      id: 'ra0', generated_at: daysAgo(7), contact_count: 1, company_count: 1,
      content: { v: 1, analyses: { topOpportunities: { finding: 'Earlier analysis.', evidence: 'Earlier evidence.' } } },
    },
  ];

  const context = await browser.newContext({ viewport });
  await context.route(`**/${SUPABASE_HOST}/rest/**`, (route) => {
    const method = route.request().method();
    if (method === 'POST' || method === 'PATCH') return route.fulfill({ status: 200, contentType: 'application/json', body: '[{}]' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await context.route(`**/${SUPABASE_HOST}/rest/v1/referral_analyses*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(referralAnalyses) }));
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
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/billing/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'PREMIUM', plan: 'Premium', quotas: { ai_request: { unlimited: true } } }) }));
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/trial/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ activated: true }) }));

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', err => { pageErrors.push(err.message); console.log('*** PAGE ERROR:', err.message); });
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [SUPABASE_SESSION_KEY, JSON.stringify(session)]);
  await page.goto('http://localhost:5173/#dashboard');
  await page.waitForTimeout(900);
  return { context, page, pageErrors };
}

async function noHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

const VIEWPORTS = [
  { name: 'desktop', viewport: { width: 1400, height: 900 } },
  { name: 'tablet', viewport: { width: 768, height: 1024 } },
  { name: 'mobile-375', viewport: { width: 375, height: 812 } },
];

(async () => {
  const browser = await chromium.launch({ headless: true });

  for (const { name, viewport } of VIEWPORTS) {
    console.log(`\n=== VIEWPORT: ${name} (${viewport.width}x${viewport.height}) ===`);
    const { context, page, pageErrors } = await newCtx(browser, viewport);

    // Networking page, Outreach tab (default) -- regression check.
    await page.goto('http://localhost:5173/#network');
    await page.waitForTimeout(900);
    check(`[${name}] Outreach tab: no horizontal overflow`, await noHorizontalOverflow(page));

    // Intelligence tab.
    await page.getByRole('button', { name: 'Intelligence' }).click();
    await page.waitForTimeout(500);
    check(`[${name}] Intelligence tab: no horizontal overflow`, await noHorizontalOverflow(page));
    let bodyText = await page.evaluate(() => document.body.innerText);
    check(`[${name}] Referral Snapshot heading present`, bodyText.includes('Referral Snapshot'));
    check(`[${name}] Warmest Contacts (tier badges) present`, bodyText.includes('Dana Wu') && /Strong|Warm|Warming|Cold/.test(bodyText));
    if (name === 'mobile-375') {
      await page.screenshot({ path: path.join(SCRATCH, '01-intelligence-snapshot-375.png'), fullPage: true });
    }

    // Expand both deep-dive sections.
    await page.getByRole('button', { name: 'Top Referral Opportunities' }).click();
    await page.waitForTimeout(300);
    check(`[${name}] Deep dive (Top Opportunities) expanded: no horizontal overflow`, await noHorizontalOverflow(page));
    if (name === 'mobile-375') {
      await page.screenshot({ path: path.join(SCRATCH, '02-deepdive-top-opportunities-375.png'), fullPage: true });
    }
    await page.getByRole('button', { name: 'Outreach Timing Guidance' }).click();
    await page.waitForTimeout(300);
    check(`[${name}] Deep dive (Outreach Timing) expanded: no horizontal overflow`, await noHorizontalOverflow(page));
    bodyText = await page.evaluate(() => document.body.innerText);
    check(`[${name}] Availability guidance (unavailable section) present without overflow`, bodyText.includes('Relationship building guidance appears once you have a target company'));
    if (name === 'mobile-375') {
      await page.screenshot({ path: path.join(SCRATCH, '03-deepdive-both-expanded-375.png'), fullPage: true });
    }

    // History section.
    check(`[${name}] Analysis History heading present`, bodyText.includes('Analysis History') || (await page.evaluate(() => document.body.innerText)).includes('Analysis History'));

    // Opportunity Intelligence integration.
    await page.goto('http://localhost:5173/#opportunity');
    await page.waitForTimeout(900);
    check(`[${name}] Opportunity page: no horizontal overflow`, await noHorizontalOverflow(page));
    bodyText = await page.evaluate(() => document.body.innerText);
    check(`[${name}] Opportunity page shows AI Insight + ranked company`, bodyText.includes('AI Insight') && bodyText.includes('Northwind International Holdings'));
    if (name === 'mobile-375') {
      await page.screenshot({ path: path.join(SCRATCH, '04-opportunity-referral-375.png'), fullPage: true });
    }

    // Premium gate (long company/contact names, long premium body copy) -- separate non-premium context.
    if (name === 'mobile-375') {
      const npContext = await browser.newContext({ viewport });
      const npUid = '90000000-0000-0000-0000-000000000002';
      const npSession = makeSession(npUid, 'resp-np@test.dev');
      const npProfile = { id: npUid, email: 'resp-np@test.dev', full_name: 'Test User', job_title: 'Engineer', subscription_status: 'no_subscription', country: 'US' };
      await npContext.route(`**/${SUPABASE_HOST}/rest/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
      await npContext.route(`**/${SUPABASE_HOST}/rest/v1/profiles*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([npProfile]) }));
      await npContext.route(`**/${SUPABASE_HOST}/auth/**`, (route) => {
        const url = route.request().url();
        if (url.includes('/token') || url.includes('/session')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(npSession) });
        if (url.includes('/user')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(npSession.user) });
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      });
      await npContext.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/billing/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'FREE', plan: 'Free', quotas: {} }) }));
      await npContext.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/trial/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ activated: true }) }));
      const npPage = await npContext.newPage();
      await npPage.addInitScript(([k, v]) => localStorage.setItem(k, v), [SUPABASE_SESSION_KEY, JSON.stringify(npSession)]);
      await npPage.goto('http://localhost:5173/#dashboard');
      await npPage.waitForTimeout(900);
      await npPage.goto('http://localhost:5173/#network');
      await npPage.waitForTimeout(900);
      await npPage.getByRole('button', { name: 'Intelligence' }).click();
      await npPage.waitForTimeout(500);
      check(`[${name}] Premium gate: no horizontal overflow`, await noHorizontalOverflow(npPage));
      await npPage.screenshot({ path: path.join(SCRATCH, '05-premium-gate-375.png'), fullPage: true });
      await npContext.close();
    }

    check(`[${name}] No page errors across full walkthrough`, pageErrors.length === 0);
    await context.close();
  }

  console.log('\n=== SUMMARY ===');
  const failed = results.filter(r => !r.pass);
  console.log(failed.length === 0 ? `✅ ALL ${results.length} CHECKS PASSED` : `❌ ${failed.length}/${results.length} CHECKS FAILED:\n${failed.map(f => '  - ' + f.label).join('\n')}`);
  console.log(`\nScreenshots saved to: ${SCRATCH}`);
  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
})();

/**
 * verify-pro-premium-change-plan.cjs — confirms an existing PRO_ACTIVE
 * subscriber clicking "Upgrade to Premium" on the Pricing page goes through
 * POST /api/billing/change-plan (an existing-subscription upgrade), never
 * through a new Stripe Checkout session, and that the UI/billingState
 * correctly reflect Premium afterward. Closes the durable-coverage gap noted
 * in the Pro -> Premium billing audit: the code path was already confirmed
 * correct by reading (see commit 156f377 and the follow-up audit), but had
 * no repeatable automated test. This script needs no real Stripe UI
 * interaction -- change-plan is a plain fetch to our own Worker, not a
 * Stripe-hosted redirect -- so the Stripe Checkout shadow-root limitation
 * that blocked earlier live-verification attempts does not apply here.
 *
 * When to run: after any change to PricingPage's upgrade button logic
 * (handleChangePlan/handleCheckout routing), the /api/billing/change-plan
 * Worker endpoint's request/response shape, or App()'s billingState/isPremium
 * derivation.
 * Production-safe: no -- all Supabase and Worker calls are mocked. No real
 * Stripe account, payment, or network call is ever made. Local development
 * only.
 * Prerequisites: dev server running at http://localhost:5173 (update BASE
 * below if your dev server runs elsewhere).
 * Run: node scripts/verify/verify-pro-premium-change-plan.cjs
 */
const { chromium } = require('playwright');

const BASE = 'http://localhost:5173';
const SUPABASE_HOST = 'cbzebqxbohgkgcqfgmdm.supabase.co';
const WORKER_HOST = 'proxy.dawn-voice-2790.workers.dev';
const SUPABASE_SESSION_KEY = `sb-${SUPABASE_HOST.split('.')[0]}-auth-token`;
const FAKE_UID = '11111111-1111-1111-1111-111111111111';
const FAKE_EMAIL = 'test@careerpersona.dev';
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 86400 * 365;

function makeJWT(payload) {
  const b64url = (s) => Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fake_sig`;
}
const ACCESS_TOKEN = makeJWT({ sub: FAKE_UID, email: FAKE_EMAIL, role: 'authenticated', aud: 'authenticated', iss: `https://${SUPABASE_HOST}/auth/v1`, iat: Math.floor(Date.now() / 1000), exp: FAR_FUTURE });
const SUPABASE_SESSION = { access_token: ACCESS_TOKEN, token_type: 'bearer', expires_in: 86400 * 365, expires_at: FAR_FUTURE, refresh_token: 'fake_refresh_token', user: { id: FAKE_UID, aud: 'authenticated', role: 'authenticated', email: FAKE_EMAIL, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } };
const FAKE_PROFILE = { id: FAKE_UID, email: FAKE_EMAIL, full_name: 'Test User', preferred_job_title: 'Software Engineer', location: 'San Francisco, CA', work_type: 'Remote', subscription_status: 'pro_active', country: 'US' };

const PERIOD_END = new Date(Date.now() + 20 * 86400 * 1000).toISOString();
function billingStateBody(tier) {
  const isPremium = tier === 'premium';
  return {
    billingState: isPremium ? 'PREMIUM_ACTIVE' : 'PRO_ACTIVE',
    subscriptionStatus: isPremium ? 'premium_active' : 'pro_active',
    planDisplayName: isPremium ? 'Premium' : 'Pro',
    canUseAI: true,
    canUseJobs: true,
    trialEndsAt: null,
    daysRemaining: null,
    periodEnd: PERIOD_END,
    cancelAtPeriodEnd: false,
    paymentMethodOnFile: true,
    quotas: { ai_request: { used: 0, limit: 2000, remaining: 2000, unlimited: false } },
  };
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  // Flips true the moment change-plan succeeds -- every subsequent
  // GET /api/billing/state read reflects the upgraded tier, same as the
  // real Worker (DB write -> KV invalidate -> fresh read) would.
  let upgraded = false;
  let changePlanCalls = [];
  let checkoutSessionCalls = 0;
  let stripeNetworkCalls = 0;

  // --- Supabase auth/REST (generic auth pattern, permissive catch-all) ---
  await context.route(`**/${SUPABASE_HOST}/auth/**`, async (route) => {
    const url = route.request().url();
    if (url.includes('/token') || url.includes('/session')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SUPABASE_SESSION) });
    if (url.includes('/user')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SUPABASE_SESSION.user) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  // .maybeSingle()/.single() send Accept: application/vnd.pgrst.object+json
  // and expect a bare object back (not array-wrapped) -- fetchProfile
  // (src/data/profile.js) uses .maybeSingle() on both tables, and its
  // hasProfileDetails flag (drives the first-launch splash vs. going
  // straight to the requested page) is derived from whether this resolves
  // truthy, so the response shape has to match exactly what PostgREST sends.
  const singleOrArray = (route, row) => {
    const wantsSingle = route.request().headers()['accept']?.includes('vnd.pgrst.object+json');
    return route.fulfill({ status: 200, contentType: 'application/json', body: wantsSingle ? JSON.stringify(row) : JSON.stringify([row]) });
  };
  await context.route(`**/${SUPABASE_HOST}/rest/v1/profiles*`, (route) => singleOrArray(route, FAKE_PROFILE));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/profile_details*`, (route) => singleOrArray(route, { user_id: FAKE_UID, desired_salary: null }));
  await context.route(`**/${SUPABASE_HOST}/rest/**`, async (route) => {
    const method = route.request().method();
    if (method === 'POST' || method === 'PATCH') return route.fulfill({ status: 200, contentType: 'application/json', body: '[{}]' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  // --- Any other Worker call (AI/quota routes) -- not exercised by this flow.
  // Registered FIRST: Playwright tries routes in reverse-registration order
  // (last registered wins), so the specific /api/billing/* handlers below
  // (registered after this) correctly take precedence over this catch-all
  // for their own URLs, instead of every billing call falling through here.
  await context.route(`**/${WORKER_HOST}/**`, async (route) => {
    console.log('*** UNEXPECTED WORKER CALL:', route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // --- Worker: billing state (stateful, reflects the upgrade once it lands) ---
  await context.route(`**/${WORKER_HOST}/api/billing/state`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(billingStateBody(upgraded ? 'premium' : 'pro')) })
  );

  // --- Worker: change-plan (the endpoint under test) ---
  await context.route(`**/${WORKER_HOST}/api/billing/change-plan`, async (route) => {
    const body = route.request().postDataJSON();
    changePlanCalls.push(body);
    upgraded = true;
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, subscription_status: 'premium_active' }) });
  });

  // --- Worker: checkout-session -- must NEVER be hit for an existing subscriber's upgrade ---
  await context.route(`**/${WORKER_HOST}/api/billing/checkout-session`, async (route) => {
    checkoutSessionCalls++;
    console.log('*** UNEXPECTED CHECKOUT-SESSION CALL:', route.request().url(), route.request().postData());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ url: 'https://checkout.stripe.com/should-not-be-reached' }) });
  });

  // --- Real Stripe domains -- must never be contacted by this flow ---
  await context.route(/(^|\.)stripe\.com\//, async (route) => {
    stripeNetworkCalls++;
    console.log('*** UNEXPECTED REAL STRIPE NETWORK CALL:', route.request().url());
    return route.abort();
  });

  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on('pageerror', (err) => { pageErrors.push(err.message); console.log('*** PAGE ERROR:', err.message); });
  page.on('console', (msg) => { if (msg.type() === 'error') { consoleErrors.push(msg.text()); console.log('*** CONSOLE ERROR:', msg.text()); } });
  // Seed cp_user too (not just the Supabase session) so App()'s profile state
  // starts non-null on first render -- avoids the "brand-new user" first-login
  // branch (App.jsx: wasLoggedIn ref check -> FirstLaunchExperience splash or
  // a forced redirect to #dashboard), which would otherwise hijack navigation
  // away from #pricing regardless of the URL this test opens.
  const CP_USER = { ...FAKE_PROFILE, hasProfileDetails: true, plan: 'pro', cancel_at_period_end: false };
  await page.addInitScript(([sessionKey, sessionJson, cpUserJson]) => {
    localStorage.setItem(sessionKey, sessionJson);
    localStorage.setItem('cp_user', cpUserJson);
  }, [SUPABASE_SESSION_KEY, JSON.stringify(SUPABASE_SESSION), JSON.stringify(CP_USER)]);

  console.log('=== 1. Open Pricing page as a PRO_ACTIVE subscriber ===');
  await page.goto(`${BASE}/#pricing`);

  const premiumButton = page.getByRole('button', { name: 'Upgrade to Premium', exact: true });
  const preClickVisible = await premiumButton.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false);
  console.log(`"Upgrade to Premium" button visible before click: ${preClickVisible ? '✅' : '❌'}`);
  // Pro-only subscriber: exactly the Pro card should read "Current Plan" pre-upgrade.
  const currentPlanCountBefore = await page.getByRole('button', { name: '✓ Current Plan', exact: true }).count();

  console.log('\n=== 2. Click "Upgrade to Premium" ===');
  await premiumButton.click({ timeout: 10000 });
  await page.waitForTimeout(1500);

  console.log('\n=== 3. Verify POST /api/billing/change-plan was called correctly ===');
  const changePlanCalledOnce = changePlanCalls.length === 1;
  const changePlanBodyCorrect = changePlanCalledOnce && changePlanCalls[0]?.plan === 'premium';
  console.log(`change-plan called exactly once: ${changePlanCalledOnce ? '✅' : `❌ (called ${changePlanCalls.length}x)`}`);
  console.log(`change-plan body was { plan: "premium" }: ${changePlanBodyCorrect ? '✅' : `❌ (${JSON.stringify(changePlanCalls[0])})`}`);

  console.log('\n=== 4. Verify Stripe Checkout was never invoked ===');
  console.log(`checkout-session endpoint never called: ${checkoutSessionCalls === 0 ? '✅' : `❌ (called ${checkoutSessionCalls}x)`}`);
  console.log(`real stripe.com never contacted: ${stripeNetworkCalls === 0 ? '✅' : `❌ (contacted ${stripeNetworkCalls}x)`}`);

  console.log('\n=== 5. Verify success UI/state update ===');
  const bodyText = await page.evaluate(() => document.body.innerText);
  const showsSuccessBanner = /Welcome to CareerPersona AI Premium/.test(bodyText);
  console.log(`Success banner shows "...Premium...": ${showsSuccessBanner ? '✅' : '❌'}`);

  // Premium subscribers correctly see BOTH the Pro card AND the Premium card
  // marked "Current Plan" (Premium includes everything Pro has) -- so the
  // real signal that the Premium card specifically flipped is the count
  // going from 1 (Pro card only) to 2 (Pro + Premium cards), not a single
  // strict-mode match on the ambiguous shared button name.
  const currentPlanCountAfter = await page.getByRole('button', { name: '✓ Current Plan', exact: true }).count();
  const premiumCardFlipped = currentPlanCountBefore === 1 && currentPlanCountAfter === 2;
  console.log(`"Current Plan" buttons: ${currentPlanCountBefore} before -> ${currentPlanCountAfter} after upgrade: ${premiumCardFlipped ? '✅' : '❌'}`);

  console.log('\n=== 6. Verify zero console/page errors ===');
  console.log(`Page errors: ${pageErrors.length === 0 ? '✅ none' : `❌ ${pageErrors.length}`}`);
  console.log(`Console errors: ${consoleErrors.length === 0 ? '✅ none' : `❌ ${consoleErrors.length}`}`);

  const allPass = preClickVisible && changePlanCalledOnce && changePlanBodyCorrect
    && checkoutSessionCalls === 0 && stripeNetworkCalls === 0
    && showsSuccessBanner && premiumCardFlipped
    && pageErrors.length === 0 && consoleErrors.length === 0;

  console.log('\n=== SUMMARY ===');
  console.log(allPass ? '✅ ALL CHECKS PASSED' : '❌ ONE OR MORE CHECKS FAILED');

  await browser.close();
  process.exit(allPass ? 0 : 1);
})();

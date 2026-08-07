/**
 * verify-interview-copilot-ui.cjs — confirms the Real-Time Interview
 * Co-Pilot UI matches the locked blueprint: Premium-only gating, single-tap
 * category trigger (no separate confirm step), visible "AI is thinking…"
 * state, proactive "1 hint left" warning, and the graceful cap-reached
 * state (both per-interview and monthly).
 *
 * Scope note: askClaude has a DEV_MODE short-circuit (shared by every AI
 * call in this app, so no dev/test run ever spends real Anthropic tokens)
 * that returns a mocked response BEFORE any network request is made. That
 * means this harness cannot observe the actual request body (feature key,
 * sessionId, trimmed context) sent to the worker for a live assist tap --
 * those are verified by direct source inspection instead, not runtime
 * interception. What IS fully real here, unaffected by DEV_MODE: the
 * quota-status peek (workerBillingPost, not askClaude -- no DEV_MODE
 * bypass, since it costs no AI tokens) and every UI behavior driven by it,
 * which is what actually determines the cap-reached states below.
 *
 * Production-safe: no — all Supabase/Worker calls are mocked. Local
 * development only. Prerequisites: dev server running at http://localhost:5173.
 * Run: node scripts/verify/verify-interview-copilot-ui.cjs
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ── Static source checks ──────────────────────────────────────────────────
// Covers what DEV_MODE makes unobservable at runtime (see file header):
// request shape correctness for the live-assist call.
function runStaticChecks(check) {
  const appSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'App.jsx'), 'utf8');
  const fnMatch = appSrc.match(/const buildInterviewAssistPrompt = \(category, shortNote\) => \{[\s\S]*?\n  \};/);
  const fnSrc = fnMatch ? fnMatch[0] : '';
  check('buildInterviewAssistPrompt exists with the locked (category, shortNote) signature', !!fnMatch);
  check('Job context is trimmed to 150 chars, not the 600-char length existing practice-mode calls use', fnSrc.includes('.slice(0, 150)') && !fnSrc.includes('.slice(0, 600)'));
  check('Prompt does not embed the active question object (no live-transcript grounding, per §1)', !fnSrc.includes('questionContext') && !fnSrc.includes('activeQ'));

  const handlerMatch = appSrc.match(/const handleLiveAssist = async \(category\) => \{[\s\S]*?\n  \};/);
  const handlerSrc = handlerMatch ? handlerMatch[0] : '';
  check('handleLiveAssist exists with the locked single-tap (category) signature', !!handlerMatch);
  check('Assist request uses the interview_copilot_assist feature key', handlerSrc.includes('"interview_copilot_assist"'));
  check('Assist request passes sessionId via extraBody (per-interview quota key)', /extraBody:\s*\{\s*sessionId\s*\}/.test(handlerSrc));
  check('max_tokens capped at 200 (within the locked 150-250 range)', /askClaude\(\s*[\s\S]*?,\s*200,/.test(handlerSrc));
}

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
const SESSION_ROW_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const INTERVIEW_SESSION_ROW = {
  id: SESSION_ROW_ID, user_id: FAKE_UID, company: null, job_title: null,
  job_description: 'Senior Product Manager, Series C B2B SaaS', questions: [{ id: 1, category: 'Behavioral', difficulty: 'Medium', question: 'Tell me about a time you disagreed with your manager.' }],
  answers: {}, mode: 'browse', readiness_score: null, status: 'active',
  session_state: { resume: '', resumeFileName: '', mockAnswers: {}, mockSummary: null, mockIdx: 0, mockAnswerDraft: '', activeQ: null, showReview: false, liveAssists: [] },
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
};

function fakeProfile(subscriptionStatus) {
  return { id: FAKE_UID, email: FAKE_EMAIL, full_name: 'Test User', preferred_job_title: 'Product Manager', location: 'San Francisco, CA', work_type: 'Remote', desired_salary: '160000', subscription_status: subscriptionStatus, country: 'US' };
}

async function setupContext(browser, { subscriptionStatus, quotaStatus }) {
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
  await context.route(`**/${SUPABASE_HOST}/rest/v1/profiles*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([fakeProfile(subscriptionStatus)]) }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/profile_details*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([fakeProfile(subscriptionStatus)]) }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/interview_sessions*`, (route) => {
    const method = route.request().method();
    if (method === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([INTERVIEW_SESSION_ROW]) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[{}]' });
  });

  // Real network call (not DEV_MODE-bypassed -- see file header) -- this is
  // what actually drives the cap-reached scenarios below.
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/interview-copilot\/quota-status/, (route) => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(quotaStatus) });
  });
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/billing\/state/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ billingState: subscriptionStatus === 'premium_active' ? 'PREMIUM_ACTIVE' : 'PRO_ACTIVE', planDisplayName: 'Plan', quotas: {} }) }));
  // Worker catch-all "/" -- DEV_MODE bypasses askClaude before this is ever
  // reached (see file header); left routed only so an unexpected real call
  // fails loudly via an obviously-wrong body instead of hanging.
  await context.route('https://proxy.dawn-voice-2790.workers.dev/', async (route) => {
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: [{ text: '{}' }], usage: {} }) });
  });

  const page = await context.newPage();
  await page.addInitScript(({ session, key }) => { localStorage.setItem(key, JSON.stringify(session)); }, { session: SUPABASE_SESSION, key: `sb-${SUPABASE_HOST.split('.')[0]}-auth-token` });
  await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
  // Navigate to Interview via the real desktop nav menu (SPA-internal --
  // a reload/goto would re-trigger App.jsx's forced-dashboard-on-login effect).
  await page.locator('button[aria-haspopup="true"]').click({ timeout: 10000 });
  await page.locator('[role="menuitem"]:has-text("Interview")').first().click({ timeout: 10000 });
  await page.waitForTimeout(1200);

  return { context, page };
}

(async () => {
  const results = [];
  const check = (label, pass) => { results.push({ label, pass }); console.log(`${pass ? '✅' : '❌'} ${label}`); };

  console.log('\n=== Static source checks (request shape DEV_MODE hides at runtime) ===');
  runStaticChecks(check);

  console.log('\n=== Runtime UI checks ===');
  const browser = await chromium.launch({ headless: true });

  // ── Scenario 1: non-Premium (Pro) user -- Live Assist must not render at all ──
  {
    const { context, page } = await setupContext(browser, { subscriptionStatus: 'pro_active', quotaStatus: { perInterviewRemaining: 6, monthlyRemaining: 50 } });
    const liveAssist = page.locator('text=Live Assist');
    check('Non-Premium (Pro) user does not see the Live Assist card at all', await liveAssist.count() === 0);
    await context.close();
  }

  // ── Scenario 2: Premium user, plenty of quota -- normal tap-to-hint flow ──
  {
    const { context, page } = await setupContext(browser, { subscriptionStatus: 'premium_active', quotaStatus: { perInterviewRemaining: 6, monthlyRemaining: 50 } });
    const liveAssist = page.locator('text=Live Assist');
    check('Premium user sees the Live Assist card', await liveAssist.count() > 0);

    const behavioralChip = page.locator('button:has-text("Behavioral")').last();
    check('Category chip is present and directly clickable (no separate confirm button)', await behavioralChip.count() > 0);
    const getHintBtn = page.locator('button:has-text("Get Hint")');
    check('No separate "Get Hint" confirm button exists (single-tap trigger, not two-step)', await getHintBtn.count() === 0);

    await behavioralChip.click({ timeout: 5000 });
    await page.waitForTimeout(150);
    const thinking = page.locator('text=AI is thinking');
    check('A visible "AI is thinking…" state appears immediately after the tap', await thinking.count() > 0);

    await page.waitForTimeout(1200);
    const hintText = page.locator('text=Lead with the outcome');
    check('The hint response renders after generation completes (DEV_MODE mock)', await hintText.count() > 0);

    await context.close();
  }

  // ── Scenario 3: Premium user, exactly one assist remaining -- proactive warning ──
  {
    const { context, page } = await setupContext(browser, { subscriptionStatus: 'premium_active', quotaStatus: { perInterviewRemaining: 1, monthlyRemaining: 50 } });
    await page.waitForTimeout(500);
    const warning = page.locator('text=1 hint left');
    check('Proactive "1 hint left" warning shown BEFORE the last assist is spent (not after)', await warning.count() > 0);
    const behavioralChip = page.locator('button:has-text("Behavioral")').last();
    check('Category chips remain tappable while exactly one assist remains', await behavioralChip.count() > 0);
    await context.close();
  }

  // ── Scenario 4: Premium user, per-interview cap already reached -- graceful degrade ──
  {
    const { context, page } = await setupContext(browser, { subscriptionStatus: 'premium_active', quotaStatus: { perInterviewRemaining: 0, monthlyRemaining: 44 } });
    await page.waitForTimeout(500);
    const capMsg = page.locator('text=No hints remaining for this interview');
    check('Per-interview cap-reached message shown (not a silent failure)', await capMsg.count() > 0);
    // "Behavioral" also appears in the unrelated question-category FILTER row
    // above (independent of Co-Pilot, correctly still visible) -- exactly
    // one match means only that filter chip remains and the live-assist
    // chip is gone; two would mean the live-assist chip is still showing.
    const behavioralChips = page.locator('button:has-text("Behavioral")');
    check('Live-assist category chips are hidden once the per-interview cap is reached (only the unrelated filter chip remains)', await behavioralChips.count() === 1);
    const startMockBtn = page.locator('button:has-text("Start Mock Interview")');
    check('Rest of the Interview page (mock interview) is unaffected by the cap', await startMockBtn.count() > 0);
    await context.close();
  }

  // ── Scenario 5: Premium user, monthly cap already reached -- graceful degrade ──
  {
    const { context, page } = await setupContext(browser, { subscriptionStatus: 'premium_active', quotaStatus: { perInterviewRemaining: 4, monthlyRemaining: 0 } });
    await page.waitForTimeout(500);
    const capMsg = page.locator('text=No hints remaining this month');
    check('Monthly cap-reached message shown, distinct from the per-interview message', await capMsg.count() > 0);
    await context.close();
  }

  console.log('\n=== SUMMARY ===');
  const failed = results.filter(r => !r.pass);
  console.log(failed.length === 0 ? `✅ ALL ${results.length} CHECKS PASSED` : `❌ ${failed.length}/${results.length} CHECKS FAILED:\n${failed.map(f => '  - ' + f.label).join('\n')}`);

  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
})();

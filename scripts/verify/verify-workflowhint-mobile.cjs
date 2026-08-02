/**
 * verify-workflowhint-mobile.cjs — confirms whether the Application Tracker's
 * two-part header instruction (tracker.workflowHintAction / workflowHintWhy)
 * renders as two clean lines (one per sentence) on both desktop and a 375px
 * mobile viewport, measured via actual bounding-box height vs. computed
 * line-height -- not a visual guess. Saves a screenshot of the header region
 * for visual confirmation at each viewport.
 *
 * Production-safe: no — mocked Supabase session, local dev only.
 * Prerequisites: dev server running at http://localhost:5173.
 * Run: node scripts/verify/verify-workflowhint-mobile.cjs
 */
const { chromium } = require('playwright');
const path = require('path');

const SUPABASE_HOST = 'cbzebqxbohgkgcqfgmdm.supabase.co';
const SUPABASE_SESSION_KEY = `sb-cbzebqxbohgkgcqfgmdm-auth-token`;
const FAKE_UID = '44444444-4444-4444-4444-444444444444';
const FAKE_EMAIL = 'mobilehint@careerpersona.dev';
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 86400 * 365;
function makeJWT(payload) {
  const b64url = (s) => Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fake_sig`;
}
const ACCESS_TOKEN = makeJWT({ sub: FAKE_UID, email: FAKE_EMAIL, role: 'authenticated', aud: 'authenticated', iss: `https://${SUPABASE_HOST}/auth/v1`, iat: Math.floor(Date.now() / 1000), exp: FAR_FUTURE });
const SUPABASE_SESSION = { access_token: ACCESS_TOKEN, token_type: 'bearer', expires_in: 86400 * 365, expires_at: FAR_FUTURE, refresh_token: 'fake_refresh_token', user: { id: FAKE_UID, aud: 'authenticated', role: 'authenticated', email: FAKE_EMAIL, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } };
const FAKE_PROFILE = { id: FAKE_UID, email: FAKE_EMAIL, full_name: 'Mobile Test', subscription_status: 'premium_active', country: 'US' };

async function measureAt(browser, width, height, label) {
  const context = await browser.newContext({ viewport: { width, height } });
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

  const page = await context.newPage();
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [SUPABASE_SESSION_KEY, JSON.stringify(SUPABASE_SESSION)]);

  await page.goto('http://localhost:5173/#dashboard');
  await page.waitForTimeout(1000);
  await page.goto('http://localhost:5173/#tracker');
  await page.waitForTimeout(1200);

  const result = await page.evaluate(() => {
    const h1 = Array.from(document.querySelectorAll('h1')).find(h => h.textContent.includes('Application Tracker'));
    const container = h1 ? h1.parentElement : null;
    const paras = container ? Array.from(container.querySelectorAll('p')) : [];
    // Container order: [0] applications-tracked count, [1] action line, [2] why line.
    const actionEl = paras[1];
    const whyEl = paras[2];
    const measure = (el) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const box = el.getBoundingClientRect();
      // Ground truth: one ClientRect per visual line, straight from the layout engine --
      // not derived from height/line-height division, which can be thrown off by
      // sub-pixel rounding or a container whose width isn't actually fixed (this header
      // is a flex row with flex-wrap, so its width can shift with content length).
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = range.getClientRects();
      return { text: el.textContent, width: box.width, height: box.height, fontSize: cs.fontSize, lineHeight: cs.lineHeight, lineCount: rects.length };
    };
    return { action: measure(actionEl), why: measure(whyEl) };
  });

  console.log(`\n=== ${label} (${width}px viewport) ===`);
  let totalLines = 0;
  for (const [key, r] of Object.entries(result)) {
    if (!r) { console.log(`❌ Could not locate the "${key}" line.`); continue; }
    console.log(`[${key}] "${r.text}"`);
    console.log(`  ${r.width.toFixed(1)}px wide x ${r.height.toFixed(1)}px tall, font ${r.fontSize}, line-height ${r.lineHeight} -> ${r.lineCount} line(s)`);
    totalLines += r.lineCount;
  }
  console.log(totalLines === 2 ? `✅ Exactly 2 lines total (1 per sentence)` : `❌ ${totalLines} lines total (expected 2)`);

  const screenshotPath = path.join(__dirname, `_screenshot-twopart-${label.replace(/\s+/g, '-').toLowerCase()}-${width}px.png`);
  const header = page.locator('h1', { hasText: 'Application Tracker' }).locator('xpath=ancestor::div[1]');
  await header.screenshot({ path: screenshotPath }).catch(async () => {
    await page.screenshot({ path: screenshotPath, clip: { x: 0, y: 0, width, height: Math.min(height, 400) } });
  });
  console.log('Screenshot saved:', screenshotPath);

  await context.close();
  return totalLines;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  await measureAt(browser, 375, 812, 'MOBILE');
  await measureAt(browser, 1400, 900, 'DESKTOP');
  await browser.close();
})();

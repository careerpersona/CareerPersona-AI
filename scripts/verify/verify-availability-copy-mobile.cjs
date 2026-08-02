/**
 * verify-availability-copy-mobile.cjs — measures how the 6 new positive
 * availability-guidance messages render at desktop and 375px mobile, per the
 * data-driven-availability migration. These are longer sentences than the old
 * "Unlocks at N" copy, so they're measured (not guessed) for excessive wrapping.
 *
 * Production-safe: no — mocked Supabase session, local dev only.
 * Prerequisites: dev server running at http://localhost:5173.
 * Run: node scripts/verify/verify-availability-copy-mobile.cjs
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
const uid = '66666666-6666-6666-6666-666666666666';
const email = 'copytest@careerpersona.dev';
const session = { access_token: makeJWT({ sub: uid, email, role: 'authenticated', aud: 'authenticated', iss: `https://${SUPABASE_HOST}/auth/v1`, iat: Math.floor(Date.now() / 1000), exp: FAR_FUTURE }), token_type: 'bearer', expires_in: 86400 * 365, expires_at: FAR_FUTURE, refresh_token: 'r', user: { id: uid, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } };
const profile = { id: uid, email, full_name: 'Copy Test', subscription_status: 'premium_active', country: 'US' };
// Zero decided outcomes -- guarantees all 6 availability messages render at once.
const APPS = [{ id: 'a1', user_id: uid, company: 'Acme', job_title: 'Engineer', status: 'Applied', date_applied: new Date().toISOString().split('T')[0], response_status: 'pending', notes: '', apply_url: '#' }];

async function measureAt(browser, width, height, label) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.route(`**/${SUPABASE_HOST}/rest/**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await context.route(`**/${SUPABASE_HOST}/auth/**`, (route) => {
    const url = route.request().url();
    if (url.includes('/token') || url.includes('/session')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) });
    if (url.includes('/user')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session.user) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await context.route(`**/${SUPABASE_HOST}/rest/v1/profiles*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([profile]) }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/applications*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(APPS) }));
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/billing/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'PREMIUM', plan: 'Premium', quotas: { ai_request: { unlimited: true } } }) }));
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/trial/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ activated: true }) }));

  const page = await context.newPage();
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [SUPABASE_SESSION_KEY, JSON.stringify(session)]);
  await page.goto('http://localhost:5173/#dashboard');
  await page.waitForTimeout(1000);
  await page.goto('http://localhost:5173/#tracker');
  await page.waitForTimeout(1000);
  await page.getByRole('button', { name: /Insights/ }).click();
  await page.waitForTimeout(500);

  const messages = await page.evaluate(() => {
    // Each availability card is a plain div (not a button) with a title, then a
    // muted 12px guidance line -- find those guidance divs specifically.
    const cards = Array.from(document.querySelectorAll('div')).filter(d => {
      const cs = getComputedStyle(d);
      return cs.fontSize === '12px' && cs.color !== '' && d.children.length === 0 && d.textContent.length > 20 &&
        (d.textContent.includes('become') || d.textContent.includes('appear') || d.textContent.includes('becomes'));
    });
    return cards.map(el => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const rects = range.getClientRects();
      const box = el.getBoundingClientRect();
      return { text: el.textContent, lineCount: rects.length, width: box.width, height: box.height };
    });
  });

  console.log(`\n=== ${label} (${width}px viewport) ===`);
  let anyExcessive = false;
  messages.forEach(m => {
    const flag = m.lineCount >= 4 ? '⚠️ ' : '';
    if (m.lineCount >= 4) anyExcessive = true;
    console.log(`${flag}[${m.lineCount} line(s), ${m.width.toFixed(0)}x${m.height.toFixed(0)}px] "${m.text}"`);
  });
  console.log(`Found ${messages.length} availability messages. ${anyExcessive ? '⚠️ Some wrap excessively (4+ lines)' : '✅ None wrap excessively'}`);

  const screenshotPath = path.join(__dirname, `_screenshot-availability-${label.toLowerCase()}-${width}px.png`);
  const card = page.locator('div', { hasText: 'Analysis Deep Dives' }).first();
  await card.screenshot({ path: screenshotPath }).catch(() => {});
  console.log('Screenshot saved:', screenshotPath);

  await context.close();
  return messages;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  await measureAt(browser, 375, 812, 'MOBILE');
  await measureAt(browser, 1400, 900, 'DESKTOP');
  await browser.close();
})();

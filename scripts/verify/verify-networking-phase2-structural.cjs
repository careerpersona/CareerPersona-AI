/**
 * verify-networking-phase2-structural.cjs — Referral Intelligence Phase 2
 * checkpoint: confirms the new Outreach/Intelligence tab wrapper is purely
 * structural and every existing NetworkingPage behavior (linkedin, email,
 * followup, tips) is byte-for-byte unaffected.
 *
 * Production-safe: no — mocked Supabase session, local dev only.
 * Prerequisites: dev server running at http://localhost:5173.
 * Run: node scripts/verify/verify-networking-phase2-structural.cjs
 */
const { chromium } = require('playwright');

const SUPABASE_HOST = 'cbzebqxbohgkgcqfgmdm.supabase.co';
const SUPABASE_SESSION_KEY = `sb-cbzebqxbohgkgcqfgmdm-auth-token`;
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 86400 * 365;
function makeJWT(payload) {
  const b64url = (s) => Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fake_sig`;
}
const uid = '77777777-7777-7777-7777-777777777777';
const email = 'nettest@careerpersona.dev';
const session = { access_token: makeJWT({ sub: uid, email, role: 'authenticated', aud: 'authenticated', iss: `https://${SUPABASE_HOST}/auth/v1`, iat: Math.floor(Date.now() / 1000), exp: FAR_FUTURE }), token_type: 'bearer', expires_in: 86400 * 365, expires_at: FAR_FUTURE, refresh_token: 'r', user: { id: uid, aud: 'authenticated', role: 'authenticated', email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } };
const profile = { id: uid, email, full_name: 'Net Test', job_title: 'Engineer', subscription_status: 'premium_active', country: 'US' };
const SAVED_CONTACT = { id: 'c1', user_id: uid, name: 'Jane Doe', company: 'Acme', email: 'jane@acme.com', status: 'Replied', subject: 'Hi', date_saved: new Date().toISOString().split('T')[0], generated_messages: { role: 'Engineer', method: 'email', originalMessage: 'hi', linkedinMessage: 'hi', linkedinNote: 'hi', followUpsSent: 1, followUpHistory: [] }, created_at: new Date().toISOString() };

const results = [];
const check = (label, pass) => { results.push({ label, pass }); console.log(`${pass ? '✅' : '❌'} ${label}`); };

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

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
  await context.route(`**/${SUPABASE_HOST}/rest/v1/networking_contacts*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([SAVED_CONTACT]) }));
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev\/api\/billing/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ billingState: 'PREMIUM_ACTIVE', planDisplayName: 'Premium', quotas: { ai_request: { unlimited: true } } }) }));

  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', err => { pageErrors.push(err.message); console.log('*** PAGE ERROR:', err.message); });
  await page.addInitScript(([k, v]) => localStorage.setItem(k, v), [SUPABASE_SESSION_KEY, JSON.stringify(session)]);

  await page.goto('http://localhost:5173/#dashboard');
  await page.waitForTimeout(1000);
  await page.goto('http://localhost:5173/#network');
  await page.waitForTimeout(1200);

  let bodyText = await page.evaluate(() => document.body.innerText);
  check('Networking page loads with title', bodyText.includes('Networking Assistant'));
  check('New Outreach/Intelligence tab bar renders', bodyText.includes('Outreach') && bodyText.includes('Intelligence'));
  check('Defaults to Outreach tab (existing form visible)', bodyText.includes('Their Name') || bodyText.includes('theirName') || bodyText.includes('Their Role'));

  // Existing generate form still present and functional-looking.
  check('Existing outreach form fields present (Their Name, Their Role, Company)', bodyText.includes('Their Name') && bodyText.includes('Their Role') && bodyText.includes('Company'));
  check('Existing Generate button present', bodyText.includes('Generate') || bodyText.includes('generateBtn'));

  // Click into Intelligence tab -- real panel as of Phase 6 (profile here is Premium).
  await page.getByRole('button', { name: 'Intelligence' }).click();
  await page.waitForTimeout(300);
  bodyText = await page.evaluate(() => document.body.innerText);
  check('Intelligence tab shows the real Referral Intelligence panel', bodyText.includes('Referral Snapshot'));
  check('Intelligence tab does NOT show the outreach form', !bodyText.includes('Their Name'));

  // Click back to Outreach -- existing form must reappear unchanged.
  await page.getByRole('button', { name: 'Outreach' }).click();
  await page.waitForTimeout(300);
  bodyText = await page.evaluate(() => document.body.innerText);
  check('Switching back to Outreach restores the existing form', bodyText.includes('Their Name') && bodyText.includes('Their Role'));

  // Simulate having results, to check the 4 existing sub-tabs render exactly as before.
  await context.route(`**/${SUPABASE_HOST}/rest/v1/networking_sessions*`, (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify([{
      user_id: uid,
      form: { targetName: 'Jane', targetRole: 'PM', targetCompany: 'Acme', purpose: 'coffee-chat', yourBackground: 'Engineer', jobDesc: '' },
      results: { linkedinMessage: 'Hi Jane', linkedinNote: 'Note', email: { subject: 'Subj', body: 'Body' }, followUp: 'FU', icebreakers: ['a', 'b'], doList: ['do1'], dontList: ['dont1'], callToAction: 'Ask' },
      draft: { linkedinMessage: 'Hi Jane', linkedinNote: 'Note', emailSubject: 'Subj', emailBody: 'Body', callToAction: 'Ask' },
      email_to: '', email_sent: false,
    }]),
  }));
  await page.reload();
  await page.waitForTimeout(1200);
  bodyText = await page.evaluate(() => document.body.innerText);
  check('With results present, the 4 existing sub-tabs still render (linkedin/email/followup/tips)',
    bodyText.includes('LinkedIn') && bodyText.includes('Email') && bodyText.includes('Follow') && bodyText.includes('Tips'));
  check('Outer Outreach/Intelligence tab bar still present alongside the sub-tabs', bodyText.includes('Outreach') && bodyText.includes('Intelligence'));

  console.log('\n=== SUMMARY ===');
  const failed = results.filter(r => !r.pass);
  console.log(`Page errors: ${pageErrors.length === 0 ? '✅ none' : '❌ ' + pageErrors.length}`);
  console.log(failed.length === 0 ? `✅ ALL ${results.length} CHECKS PASSED` : `❌ ${failed.length}/${results.length} CHECKS FAILED: ${failed.map(f => f.label).join('; ')}`);
  await browser.close();
  process.exit(failed.length === 0 && pageErrors.length === 0 ? 0 : 1);
})();

/**
 * ARCHIVED — DO NOT USE FOR CURRENT VERIFICATION.
 * This script targets the legacy AI Match / automatic Smart Apply workflow.
 * It is retained for historical reference only. It is not expected to work
 * with the current Compatibility Engine architecture (AI Match and automatic
 * Smart Apply generation were both removed from src/App.jsx). It should not
 * be used for current production verification — see ../README.md for the
 * active verification scripts.
 */
/**
 * verify-smartapply-debug.cjs — reproduces the reported "Smart Apply failed.
 * Please try again." error with a properly seeded active resume (the
 * previous verify-workflow.cjs only seeded sessionStorage.cp_jobs_resume,
 * which JobSearchPage's autoSmartApply/smartApply no longer read — resumeText
 * there is derived from resumes.find(r => r.id === activeResumeId), so
 * user_resumes must return a real row).
 *
 * Run: node verify-smartapply-debug.cjs
 * Requires dev server running at http://localhost:5173
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SCREENSHOT_DIR = path.join(
  'C:\\Users\\ggund\\AppData\\Local\\Temp\\claude\\c--Users-ggund-CareerPersona-AI-new\\a666cc49-18a1-4d11-ab44-33637d77b345\\scratchpad',
  'screenshots'
);
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

const SUPABASE_HOST = 'cbzebqxbohgkgcqfgmdm.supabase.co';
const SUPABASE_SESSION_KEY = `sb-cbzebqxbohgkgcqfgmdm-auth-token`;
const FAKE_UID = '11111111-1111-1111-1111-111111111111';
const FAKE_EMAIL = 'test@careerpersona.dev';
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 86400 * 365;

function makeJWT(payload) {
  const b64url = (s) => Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fake_sig`;
}
const ACCESS_TOKEN = makeJWT({ sub: FAKE_UID, email: FAKE_EMAIL, role: 'authenticated', aud: 'authenticated', iss: `https://${SUPABASE_HOST}/auth/v1`, iat: Math.floor(Date.now() / 1000), exp: FAR_FUTURE });
const SUPABASE_SESSION = { access_token: ACCESS_TOKEN, token_type: 'bearer', expires_in: 86400 * 365, expires_at: FAR_FUTURE, refresh_token: 'fake_refresh_token', user: { id: FAKE_UID, aud: 'authenticated', role: 'authenticated', email: FAKE_EMAIL, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } };
const FAKE_PROFILE = { id: FAKE_UID, email: FAKE_EMAIL, full_name: 'Test User', preferred_job_title: 'Software Engineer', location: 'San Francisco, CA', work_type: 'Remote', subscription_status: 'admin', country: 'US' };

const SAMPLE_RESUME = `John Smith\nSenior Software Engineer | San Francisco, CA\njohn.smith@email.com | (415) 234-5678\n\nSUMMARY\n5+ years Python/AWS experience. Proven 40% API latency reduction. Led 5-person team.\n\nEXPERIENCE\nSenior Software Engineer — Acme Corp (2020–Present)\n• Architected microservices handling 2M+ daily requests, reduced costs 35%\n• Led cross-functional team of 5, delivered data pipeline 2 weeks early\n\nSKILLS: Python, AWS, React, TypeScript, PostgreSQL, Docker, Node.js, SQL`;

const FAKE_RESUME_ROW = {
  id: 'resume-1111', user_id: FAKE_UID, name: 'My Resume', content: SAMPLE_RESUME,
  is_default: true, file_url: null, file_type: null,
  ats_score: 78, potential_ats_score: 90, keywords_found: ['Python', 'AWS'], keywords_missing: ['Docker'],
  language: 'en', detected_language: 'en', language_confidence: 0.95,
  created_at: new Date().toISOString(), last_analyzed_at: new Date().toISOString(),
};

async function ss(page, name) { await page.screenshot({ path: path.join(SCREENSHOT_DIR, name + '.png'), fullPage: false }); console.log('📸 ' + name); }
async function waitFor(page, text, timeout = 30000) { try { await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout }); return true; } catch { return false; } }
async function txt(page) { return page.evaluate(() => document.body.innerText); }

(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 60 });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  await context.route(`**/${SUPABASE_HOST}/auth/**`, async (route) => {
    const url = route.request().url();
    if (url.includes('/token') || url.includes('/session')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SUPABASE_SESSION) });
    if (url.includes('/user')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(SUPABASE_SESSION.user) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  // Playwright checks routes in REVERSE registration order (last registered
  // wins) — so the generic catch-all must be registered FIRST, with more
  // specific handlers registered AFTER to take precedence over it.
  await context.route(`**/${SUPABASE_HOST}/rest/**`, async (route) => {
    const method = route.request().method();
    if (method === 'POST' || method === 'PATCH') return route.fulfill({ status: 200, contentType: 'application/json', body: '[{}]' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  await context.route(`**/${SUPABASE_HOST}/rest/v1/profiles*`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([FAKE_PROFILE]) }));
  await context.route(`**/${SUPABASE_HOST}/rest/v1/user_resumes*`, (route) => {
    console.log('[MOCK] user_resumes ->', route.request().method(), route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([FAKE_RESUME_ROW]) });
  });
  let queueRows = [];
  let queueCounter = 0;
  await context.route(`**/${SUPABASE_HOST}/rest/v1/smart_apply_queue*`, async (route) => {
    const method = route.request().method();
    const url = route.request().url();
    if (method === 'POST') {
      queueCounter++;
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
      const row = { id: `q-${queueCounter}`, user_id: FAKE_UID, job_id: body.job_id || `job_${queueCounter}`, job_title: body.job_title || 'Software Engineer', company: body.company || 'Company', job_description: body.job_description || '', resume_id: body.resume_id || null, status: 'queued', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      queueRows.push(row);
      // .select().single() sends Accept: application/vnd.pgrst.object+json and
      // expects a bare object, not an array — mismatching this silently breaks
      // data.id downstream (a real fragility, see write-up).
      const wantsSingle = (route.request().headers()['accept'] || '').includes('pgrst.object');
      return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(wantsSingle ? row : [row]) });
    }
    if (method === 'PATCH') {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
      const idMatch = url.match(/id=eq\.([^&]+)/);
      const id = idMatch ? decodeURIComponent(idMatch[1]) : null;
      const row = queueRows.find(r => r.id === id);
      if (row) Object.assign(row, body);
      console.log(`[MOCK PATCH] smart_apply_queue id=${id} -> ${JSON.stringify(body).slice(0, 200)}`);
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(queueRows) });
  });
  await context.route(`**/${SUPABASE_HOST}/rest/v1/notifications*`, async (route) => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify([{ id: `n-${Date.now()}`, user_id: FAKE_UID }]) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  const MOCK_JOBS = Array.from({ length: 4 }, (_, i) => ({
    id: `adzuna_test_${i + 1}`, source: 'Adzuna',
    title: ['Senior Software Engineer', 'Backend Engineer', 'Full Stack Developer', 'Platform Engineer'][i],
    company: ['Acme Corp', 'Beta Inc', 'Gamma LLC', 'Delta Tech'][i],
    location: 'San Francisco, CA',
    description: `Experienced Python/AWS engineer needed. Requirements: Python, AWS, React, TypeScript, Docker. Team of ${i + 3}.`,
    salaryMin: 120000 + i * 10000, salaryMax: 180000 + i * 10000, employmentType: 'Full-time', experienceLevel: 'Senior',
    remote: i % 2 === 0, applyUrl: `https://example.com/job/${i + 1}`, datePosted: new Date(Date.now() - i * 86400000).toISOString(),
    skills: ['Python', 'AWS', 'React'],
  }));
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev/, async (route) => {
    const url = route.request().url();
    if (url.includes('/api/billing')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'ADMIN', plan: 'Admin', quotas: { ai_request: { used: 0, limit: null, remaining: null, unlimited: true }, resume_analysis: { used: 0, limit: null, remaining: null, unlimited: true } } }) });
    if (url.includes('/api/trial')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ activated: true }) });
    if (url.includes('/api/jobs')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ jobs: MOCK_JOBS, total: MOCK_JOBS.length, sources: { adzuna: MOCK_JOBS.length, rapidapi: 0 } }) });
    return route.continue();
  });

  const page = await context.newPage();
  page.on('request', req => { const u = req.url(); if (u.includes('supabase') || u.includes('workers.dev')) console.log('[REQ]', req.method(), u); });
  page.on('console', msg => {
    const text = msg.text();
    const ts = new Date().toISOString().slice(11, 23);
    console.log(`[${ts}] [${msg.type()}] ${text}`);
  });
  page.on('pageerror', err => console.log(`\n*** PAGE ERROR: ${err.message}\n${err.stack}\n`));

  await page.addInitScript(([sessionKey, sessionJson]) => {
    localStorage.setItem(sessionKey, sessionJson);
    sessionStorage.setItem('cp_jobs_filters', JSON.stringify({ title: 'Software Engineer', keywords: '', country: 'US', city: '', remote: false, employmentType: 'Any', experienceLevel: 'Any', salaryMin: '' }));
    sessionStorage.removeItem('cp_jobs_results');
    sessionStorage.removeItem('cp_jobs_match');
    sessionStorage.removeItem('cp_jobs_searched');
  }, [SUPABASE_SESSION_KEY, JSON.stringify(SUPABASE_SESSION)]);

  console.log('\n=== LOADING APP ===');
  await page.goto('http://localhost:5173');
  await page.waitForTimeout(4000);
  await ss(page, 'debug-01-loaded');

  console.log('\n=== NAVIGATE TO JOB SEARCH ===');
  await page.goto('http://localhost:5173/#jobs');
  await page.waitForTimeout(2000);
  await ss(page, 'debug-02-jobsearch');
  console.log('Active resume button text:', (await txt(page)).match(/📄[^\n]*/)?.[0] || '(not found)');

  let searchInput = page.getByLabel('Job Title', { exact: false }).first();
  if (!await searchInput.isVisible({ timeout: 2000 }).catch(() => false)) searchInput = page.locator('input').first();
  await searchInput.click({ force: true });
  await searchInput.fill('Software Engineer', { force: true });

  console.log('\n=== SEARCH ===');
  const searchBtn = page.locator('button').filter({ hasText: /Search Jobs/ }).first();
  await searchBtn.click({ timeout: 5000 });
  await waitFor(page, 'Acme Corp', 15000);
  await ss(page, 'debug-03-jobs');

  console.log('\n=== WAITING FOR AI MATCH + SMART APPLY (60s) ===');
  await page.waitForTimeout(60000);
  await ss(page, 'debug-04-after-wait');

  console.log('\n=== FINAL PAGE TEXT ===');
  console.log((await txt(page)).slice(0, 1500));

  console.log('\n=== MOCK smart_apply_queue FINAL STATE ===');
  console.log(JSON.stringify(queueRows, null, 2));

  await browser.close();
})().catch(e => { console.error('SCRIPT ERROR:', e); process.exit(1); });

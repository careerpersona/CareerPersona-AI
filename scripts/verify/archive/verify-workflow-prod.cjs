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
 * verify-workflow-prod.cjs — AI Match + Smart Apply workflow verification on PRODUCTION.
 *
 * Target: https://careerpersonaai.com (Cloudflare Pages — built with DEV_MODE=false)
 *
 * Production difference vs localhost:
 *   DEV_MODE = false → askClaude() POSTs to the Worker root (proxy.dawn-voice-2790.workers.dev)
 *   instead of the in-browser _devMockRoute() mock. This test intercepts that endpoint
 *   and returns the same shaped responses so the full code path executes without consuming
 *   real Anthropic API quota.
 *
 * Auth: injects a valid-structured Supabase session into localStorage via addInitScript()
 *   so getSession() reads it directly (far-future expires_at → no refresh network call).
 *
 * Run: node verify-workflow-prod.cjs
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const APP_URL = 'https://careerpersonaai.com';

const SCREENSHOT_DIR = path.join(
  'C:\\Users\\ggund\\AppData\\Local\\Temp\\claude\\c--Users-ggund-CareerPersona-AI-new\\4ce6861b-2b62-48b9-ab3c-91a7afacfe7a\\scratchpad',
  'screenshots-prod'
);
if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

// ─── Constants ────────────────────────────────────────────────────────────────
const SUPABASE_HOST = 'cbzebqxbohgkgcqfgmdm.supabase.co';
const SUPABASE_SESSION_KEY = `sb-cbzebqxbohgkgcqfgmdm-auth-token`;
const FAKE_UID = '11111111-1111-1111-1111-111111111111';
const FAKE_EMAIL = 'test@careerpersona.dev';
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 86400 * 365;

function makeJWT(payload) {
  const b64url = (s) => Buffer.from(JSON.stringify(s)).toString('base64url');
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(payload)}.fake_sig`;
}

const ACCESS_TOKEN = makeJWT({
  sub: FAKE_UID, email: FAKE_EMAIL, role: 'authenticated',
  aud: 'authenticated',
  iss: `https://${SUPABASE_HOST}/auth/v1`,
  iat: Math.floor(Date.now() / 1000),
  exp: FAR_FUTURE,
});

const SUPABASE_SESSION = {
  access_token: ACCESS_TOKEN,
  token_type: 'bearer',
  expires_in: 86400 * 365,
  expires_at: FAR_FUTURE,
  refresh_token: 'fake_refresh_token_no_calls_needed',
  user: {
    id: FAKE_UID, aud: 'authenticated', role: 'authenticated',
    email: FAKE_EMAIL, app_metadata: {}, user_metadata: {},
    created_at: new Date().toISOString(),
  },
};

const FAKE_PROFILE = {
  id: FAKE_UID, email: FAKE_EMAIL, name: 'Test User',
  preferred_job_title: 'Software Engineer', location: 'San Francisco, CA',
  work_type: 'Remote', subscription_status: 'admin',
};

const SAMPLE_RESUME = `John Smith — Senior Software Engineer | San Francisco, CA
john@example.com | (555) 123-4567

SUMMARY
5+ years Python/AWS experience. Proven 40% API latency reduction. Led 5-person team.

EXPERIENCE
Senior Software Engineer — Acme Corp (2020–Present)
• Architected microservices handling 2M+ daily requests, reduced costs 35%
• Led cross-functional team of 5, delivered data pipeline 2 weeks early
• Drove 40% API latency reduction via Redis caching

Software Engineer — Startup Inc (2018–2020)
• React/TypeScript frontend for 50K+ MAU; integrated Stripe & Twilio

SKILLS: Python, AWS, React, TypeScript, PostgreSQL, Docker, Node.js, SQL`;

// ─── Production mock responses ────────────────────────────────────────────────
// In production DEV_MODE=false; askClaude() POSTs to the Worker root and expects:
//   { content: [{ text: "<json string>" }] }
// We read the prompt from the request body and return the appropriate mock.
function mockAiResponse(prompt) {
  const p = prompt.toLowerCase();

  // AI Match (per-job scoring) — buildMatchPrompt contains "matchScore" + "interviewProbability"
  if ((p.includes('matchscore') && p.includes('interviewprobability')) ||
       p.includes('analyze resume-job match')) {
    return JSON.stringify({
      matchScore: 76, atsScore: 74, interviewProbability: 62,
      matchingSkills: ['Python', 'AWS', 'React'],
      missingSkills: ['Docker', 'Kubernetes'],
      summary: 'Strong technical match with core requirements.',
    });
  }

  // Smart Apply full package — buildSmartApplyPrompt contains "application package"
  if (p.includes('application package') ||
      (p.includes('tailoredresume') && p.includes('recruitermessage'))) {
    return JSON.stringify({
      tailoredResume: SAMPLE_RESUME,
      coverLetter: 'Dear Hiring Manager,\n\nI am excited to apply. My Python/AWS background aligns directly with your requirements.\n\nBest regards,\nJohn Smith',
      recruiterMessage: 'Hi, I came across this role and my background is a strong fit. Would love to connect.',
      networkingMessage: 'Hi, I saw you work at this company. Would love to connect!',
      missingSkills: ['Docker', 'Kubernetes'],
      interviewProbability: 68,
      hiringProbability: 42,
      applicationQuestions: ['Describe your experience with distributed systems.'],
      salaryInsight: {
        marketRange: { low: 140000, median: 165000, high: 195000 },
        userPositioning: '55th–70th percentile',
        negotiationLeverage: 'Strong — 40% latency reduction is direct business impact.',
        benchmarks: ['Staff Engineer at Series B: $170K–$200K total comp'],
      },
      companyInsight: {
        culture: 'Engineering-driven culture with strong ownership.',
        recentNews: 'Actively expanding engineering headcount.',
        hiringTrend: 'growing',
        redFlags: [],
        greenFlags: ['Strong eng culture', 'Competitive equity'],
        talkingPoints: ['Your caching work aligns with their performance requirements'],
      },
    });
  }

  // Daily Briefing
  if (p.includes('daily briefing')) {
    return JSON.stringify({
      v: 2, summary: 'You have 3 active applications. ATS score trending up.',
      newMatchingJobs: '23 new roles this week.', highestPayingJobs: '$150K–$185K at Series B startups.',
      jobsClosingSoon: '2 applications need follow-up.', priorityRecommendation: 'Add Docker to resume.',
      companiesHiringNow: 'Amazon, Stripe, Notion.', newOpportunities: 'Staff Engineer roles open.',
      resumeUpdates: 'Resume is competitive.', atsScoreChanges: 'ATS score: 82.',
      interviewInvitations: '1 interview stage pending.', recruiterActivity: 'LinkedIn at 87%.',
      applicationUpdates: '3 under review.', salaryChanges: '+6% YoY.',
      marketUpdates: 'Demand for full-stack engineers remains high.',
      careerInsights: 'Customized resumes see 40% higher interview rates.',
      dailyHighlights: ['Follow up on 2 applications', 'Add Docker & Kubernetes', 'Check 3 new matches'],
      generatedAt: new Date().toISOString(),
    });
  }

  // Action Plan
  if (p.includes('action plan') || p.includes('productivityscore')) {
    return JSON.stringify({
      v: 2, productivityScore: 72,
      categories: [
        { id: 'priorities', category: "Today's Priorities", task: 'Follow up on Stripe application.', time: '10 min', status: 'pending' },
        { id: 'applications', category: 'Recommended Applications', task: 'Apply to Staff Engineer at Notion.', time: '30 min', status: 'pending' },
        { id: 'resume', category: 'Resume Improvements', task: 'Add Docker to skills section.', time: '15 min', status: 'pending' },
        { id: 'interview', category: 'Interview Practice', task: 'Practice STAR for production incident question.', time: '20 min', status: 'pending' },
      ],
    });
  }

  // Fallback — return empty JSON so the app doesn't crash on unexpected prompts
  return '{}';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function ss(page, name) {
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: false });
  console.log(`📸 ${name}`);
}
async function waitFor(page, text, timeout = 45000) {
  try {
    await page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });
    return true;
  } catch { return false; }
}
async function waitGone(page, text, timeout = 60000) {
  try {
    await page.waitForFunction((t) => !document.body.innerText.includes(t), text, { timeout });
    return true;
  } catch { return false; }
}
async function txt(page) { return page.evaluate(() => document.body.innerText); }

// ─── Report state ──────────────────────────────────────────────────────────────
const report = {
  firstSearchScores: false,
  analysisComplete1: false,
  countdownAfterComplete: null,
  countdownNum: null,
  secondSearchScores: false,
  analysisComplete2: false,
};
const consoleLogs = [];

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  const browser = await chromium.launch({ headless: false, slowMo: 80 });
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });

  // ── Route interception ────────────────────────────────────────────────────

  // Supabase auth — intercept in case getSession() makes a network call
  await context.route(`**/${SUPABASE_HOST}/auth/**`, async (route) => {
    const url = route.request().url();
    if (url.includes('/token') || url.includes('/session')) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(SUPABASE_SESSION) });
    }
    if (url.includes('/user')) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify(SUPABASE_SESSION.user) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  // Supabase REST: profiles
  await context.route(`**/${SUPABASE_HOST}/rest/v1/profiles*`, async (route) => {
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify([FAKE_PROFILE]) });
  });

  // Supabase REST: smart_apply_queue
  let queueCounter = 0;
  await context.route(`**/${SUPABASE_HOST}/rest/v1/smart_apply_queue*`, async (route) => {
    const method = route.request().method();
    if (method === 'POST') {
      queueCounter++;
      const id = `q-${queueCounter}-${Date.now()}`;
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch {}
      return route.fulfill({
        status: 201, contentType: 'application/json',
        body: JSON.stringify([{
          id, user_id: FAKE_UID,
          job_id: body.job_id || `job_${queueCounter}`,
          job_title: body.job_title || 'Software Engineer',
          company: body.company || 'Company',
          status: 'queued',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }]),
      });
    }
    if (method === 'PATCH') {
      return route.fulfill({ status: 204, body: '' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  // Supabase REST: notifications
  await context.route(`**/${SUPABASE_HOST}/rest/v1/notifications*`, async (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({ status: 201, contentType: 'application/json',
        body: JSON.stringify([{ id: `notif-${Date.now()}`, user_id: FAKE_UID }]) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  // Supabase REST: catch-all
  await context.route(`**/${SUPABASE_HOST}/rest/**`, async (route) => {
    const method = route.request().method();
    if (method === 'POST' || method === 'PATCH') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[{}]' });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  // Mock jobs: normalizeAdzuna() format
  const MOCK_JOBS = Array.from({ length: 8 }, (_, i) => ({
    id: `adzuna_test_${i + 1}`,
    source: 'Adzuna',
    title: ['Senior Software Engineer', 'Backend Engineer', 'Full Stack Developer', 'Platform Engineer',
            'DevOps Engineer', 'Staff Engineer', 'Frontend Engineer', 'Data Engineer'][i],
    company: ['Acme Corp', 'Beta Inc', 'Gamma LLC', 'Delta Tech',
              'Epsilon Co', 'Zeta Systems', 'Eta Labs', 'Theta Corp'][i],
    location: 'San Francisco, CA',
    description: `Experienced Python/AWS engineer needed. Requirements: Python, AWS, React, TypeScript, Docker. Team of ${i + 3}.`,
    salaryMin: 120000 + i * 10000,
    salaryMax: 180000 + i * 10000,
    employmentType: 'Full-time',
    experienceLevel: 'Senior',
    remote: i % 2 === 0,
    applyUrl: `https://example.com/job/${i + 1}`,
    datePosted: new Date(Date.now() - i * 86400000).toISOString(),
    skills: ['Python', 'AWS', 'React', 'TypeScript', 'Docker'].slice(0, 3 + i % 3),
  }));

  // Worker: handles all proxy.dawn-voice-2790.workers.dev calls
  // /api/billing, /api/trial, /api/jobs → same mocks as localhost test
  // POST / (no /api/ path) → Claude proxy mock (PRODUCTION ONLY — DEV_MODE=false)
  await context.route(/proxy\.dawn-voice-2790\.workers\.dev/, async (route) => {
    const url = route.request().url();
    const method = route.request().method();
    process.stdout.write(`[WORKER INTERCEPT] ${method} ${url}\n`);

    if (url.includes('/api/billing')) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({
          state: 'ADMIN', plan: 'Admin',
          quotas: {
            ai_request: { used: 0, limit: null, remaining: null, unlimited: true },
            resume_analysis: { used: 0, limit: null, remaining: null, unlimited: true },
          },
        }) });
    }
    if (url.includes('/api/trial')) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ activated: true }) });
    }
    if (url.includes('/api/jobs')) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ jobs: MOCK_JOBS, total: MOCK_JOBS.length,
          sources: { adzuna: MOCK_JOBS.length, rapidapi: 0 } }) });
    }

    // Claude proxy (root POST) — this is the path taken in production (DEV_MODE=false)
    if (method === 'POST') {
      let prompt = '';
      try {
        const body = JSON.parse(route.request().postData() || '{}');
        prompt = (body.messages?.[0]?.content || '');
      } catch {}

      process.stdout.write(`[CLAUDE PROXY] feature=${JSON.parse(route.request().postData() || '{}').feature || '?'}, prompt_len=${prompt.length}\n`);

      // Simulate realistic AI latency so progress bars and state transitions fire correctly
      await new Promise(r => setTimeout(r, 900 + Math.random() * 400));

      const text = mockAiResponse(prompt);
      return route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ content: [{ text }] }),
      });
    }

    return route.continue();
  });

  // ── Page setup ────────────────────────────────────────────────────────────
  const page = await context.newPage();

  page.on('request', req => {
    const url = req.url();
    if (url.includes('workers.dev') || url.includes('supabase.co')) {
      process.stdout.write(`[REQUEST] ${req.method()} ${url}\n`);
    }
  });
  page.on('console', msg => {
    const text = msg.text();
    const ts = new Date().toISOString().slice(11, 23);
    const entry = `[${ts}] [${msg.type()}] ${text}`;
    consoleLogs.push(entry);
    if (/SmartApply|autoApply|autoAnalyz|Scoring|complete|match|failed|error|resume|billing|profile|warn/i.test(text)) {
      process.stdout.write(`LOG: ${text}\n`);
    }
  });
  page.on('pageerror', err => {
    const entry = `[PAGE ERROR] ${err.message}`;
    consoleLogs.push(entry);
    process.stdout.write(`PAGE ERROR: ${err.message}\n`);
  });
  page.on('requestfailed', req => {
    const entry = `[REQUEST FAILED] ${req.method()} ${req.url()} — ${req.failure()?.errorText}`;
    consoleLogs.push(entry);
    if (req.url().includes('supabase') || req.url().includes('workers.dev')) {
      process.stdout.write(`REQUEST FAILED: ${req.method()} ${req.url()}\n`);
    }
  });

  // Inject session + sessionStorage BEFORE page scripts run
  await page.addInitScript(([sessionKey, sessionJson, resumeText]) => {
    localStorage.setItem(sessionKey, sessionJson);
    sessionStorage.setItem('cp_jobs_resume', JSON.stringify(resumeText));
    sessionStorage.setItem('cp_jobs_filters', JSON.stringify({
      title: 'Software Engineer',
      keywords: '',
      country: 'United States',
      city: '',
      remote: false,
      employmentType: 'Any',
      experienceLevel: 'Any',
      salaryMin: '',
    }));
    sessionStorage.removeItem('cp_jobs_results');
    sessionStorage.removeItem('cp_jobs_match');
    sessionStorage.removeItem('cp_jobs_searched');
    sessionStorage.removeItem('cp_jobs_page');
    sessionStorage.removeItem('cp_jobs_hasmore');
  }, [SUPABASE_SESSION_KEY, JSON.stringify(SUPABASE_SESSION), SAMPLE_RESUME]);

  // ── Load the app ──────────────────────────────────────────────────────────
  console.log('\n=== LOADING APP (PRODUCTION) ===');
  console.log(`Target: ${APP_URL}`);
  await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(5000); // production build may take longer to hydrate

  const appText = await txt(page);
  const hasSignIn = /sign in|login|log in/i.test(appText) && !/dashboard|job search|career/i.test(appText);
  const seemsLoggedIn = !hasSignIn;
  console.log('Auth state:', seemsLoggedIn ? 'Logged in ✅' : 'STILL ON LOGIN PAGE ❌');
  await ss(page, '01-app-loaded');

  if (!seemsLoggedIn) {
    console.log('App text (first 800 chars):');
    console.log(appText.slice(0, 800));
    await browser.close();
    process.exit(1);
  }

  // ── Navigate to Job Search ────────────────────────────────────────────────
  console.log('\n=== NAVIGATE TO JOB SEARCH ===');
  let navigated = false;
  const navLink = page.locator('text=Job Search').first();
  if (await navLink.isVisible({ timeout: 3000 }).catch(() => false)) {
    await navLink.click();
    navigated = true;
  }
  if (!navigated) {
    await page.goto(`${APP_URL}/#jobs`);
  }
  await page.waitForTimeout(2000);
  await ss(page, '02-job-search-page');

  // ── Find the Job Title search input ──────────────────────────────────────
  let searchInput = page.getByLabel('Job Title', { exact: false }).first();
  if (!await searchInput.isVisible({ timeout: 2000 }).catch(() => false)) {
    searchInput = page.locator('input').filter({ hasAttribute: 'placeholder' }).first();
  }
  if (!await searchInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    searchInput = page.getByRole('textbox').first();
  }
  if (!await searchInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    searchInput = page.locator('input').first();
  }
  const inputVisible = await searchInput.isVisible({ timeout: 2000 }).catch(() => false);
  console.log('Search input found:', inputVisible ? 'YES ✅' : 'using force-click fallback');

  // ─────────────────────────────────────────────────────────────────────────
  // FIRST SEARCH
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n=== FIRST SEARCH ===');
  await searchInput.click({ force: true });
  await searchInput.fill('Software Engineer', { force: true });
  await page.waitForTimeout(300);

  const resumeInStorage = await page.evaluate(() => {
    const raw = sessionStorage.getItem('cp_jobs_resume');
    if (!raw) return 'EMPTY/NULL';
    try { const v = JSON.parse(raw); return v ? `SET (${String(v).slice(0, 40)}...)` : 'EMPTY STRING'; }
    catch { return `PARSE ERROR: ${raw.slice(0, 60)}`; }
  });
  console.log(`Resume in sessionStorage: ${resumeInStorage}`);

  const t0 = Date.now();
  const searchBtn = page.locator('button').filter({ hasText: /Search Jobs/ }).first();
  await searchBtn.click({ timeout: 5000 });
  console.log('Search clicked at t=0');

  const jobsAppearedSelectors = ['Acme Corp', 'Senior Software Engineer', 'Backend Engineer', 'Adzuna', 'Full-time'];
  let jobsLoaded = false;
  for (const s of jobsAppearedSelectors) {
    if (await waitFor(page, s, 15000)) { jobsLoaded = true; break; }
  }
  console.log('Jobs loaded:', jobsLoaded ? `YES ✅ (+${((Date.now()-t0)/1000).toFixed(1)}s)` : 'TIMEOUT ❌');
  await ss(page, '03-jobs-loaded');

  console.log('Watching for scoring status...');
  const scoringStarted = await waitFor(page, 'AI Scoring', 15000);
  if (scoringStarted) {
    const scoringText = (await txt(page)).match(/Scoring\s+\d+\s*\/\s*\d+/);
    console.log(`Scoring bar visible ✅: ${scoringText ? scoringText[0] : '(text present)'}`);
    await ss(page, '04-scoring-in-progress');
  } else {
    console.log('No scoring bar — checking for scores directly');
  }

  // Production mock returns matchScore:76 → "76% Match" in the UI
  const firstScore = await waitFor(page, '76', 60000);
  if (firstScore) {
    report.firstSearchScores = true;
    console.log(`First AI score visible ✅ (+${((Date.now()-t0)/1000).toFixed(1)}s)`);
    await ss(page, '05-first-score-visible');
  } else {
    console.log('❌ No AI scores appeared on first search');
    await ss(page, '05-no-scores');
  }

  const complete1 = await waitFor(page, 'AI Analysis Complete', 90000);
  let completeTime1 = Date.now();
  if (complete1) {
    report.analysisComplete1 = true;
    const textAtComplete = await txt(page);
    const alreadyCountingDown = /preparing\s+\d+\s+application|AI is preparing/i.test(textAtComplete);
    report.countdownAfterComplete = !alreadyCountingDown;
    console.log(`Analysis complete ✅ (+${((completeTime1-t0)/1000).toFixed(1)}s)`);
    console.log('Smart Apply countdown started before complete?', alreadyCountingDown ? 'YES ❌ (serialization bug!)' : 'NO ✅');
    await ss(page, '06-analysis-complete');
  } else {
    console.log('⚠️ "Analysis complete" not found in 90s');
    await ss(page, '06-analysis-timeout');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // SMART APPLY COUNTDOWN
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n=== SMART APPLY COUNTDOWN ===');
  const countdownFound = await waitFor(page, 'AI is preparing', 30000);
  if (countdownFound) {
    const countdownTime = Date.now();
    const t = await txt(page);
    const m = t.match(/AI is preparing (\d+) application/i) || t.match(/preparing (\d+) application/i);
    const num = m ? parseInt(m[1] || m[2]) : null;
    report.countdownNum = num;
    console.log(`Countdown appeared ✅ (+${((countdownTime-t0)/1000).toFixed(1)}s after search)`);
    if (complete1) {
      const afterComplete = countdownTime - completeTime1;
      console.log(`Time after "Analysis complete": ${afterComplete}ms ${afterComplete >= 0 ? '✅ (serialization working)' : '❌ (appeared before complete!)'}`);
      if (afterComplete < 0) report.countdownAfterComplete = false;
    }
    console.log(`Countdown number: ${num === null ? '(not parsed)' : num === 5 ? '5 ✅' : `${num} ❌ (expected 5)`}`);
    await ss(page, '07-countdown-visible');
  } else {
    const errTxt = await txt(page);
    const hasError = /smart apply failed|failed. please try again/i.test(errTxt);
    console.log('Countdown not found.', hasError ? 'Smart Apply failed error shown (RLS/auth rejection).' : 'No error — countdown may have been too fast.');
    await ss(page, '07-no-countdown');
  }

  await waitGone(page, 'AI is preparing', 120000);
  await page.waitForTimeout(2000);
  await ss(page, '08-after-smart-apply-1');

  // ─────────────────────────────────────────────────────────────────────────
  // SECOND SEARCH (the main bug scenario)
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n=== SECOND SEARCH (main bug verification) ===');
  await searchInput.click({ force: true });
  await searchInput.fill('Data Scientist', { force: true });
  await page.waitForTimeout(300);

  const t1 = Date.now();
  await searchBtn.click({ timeout: 5000 });
  console.log('Second search clicked');

  await page.waitForTimeout(800);
  const stillOldScores = (await txt(page)).includes('76%');
  console.log('Old scores cleared:', !stillOldScores ? 'YES ✅' : 'Not yet (may still be loading)');

  await waitFor(page, 'Engineer', 20000);
  await ss(page, '09-second-search-jobs');

  const scoring2 = await waitFor(page, 'AI Scoring', 15000);
  console.log('Scoring restarted on 2nd search:', scoring2 ? 'YES ✅' : 'NO ❌');
  if (scoring2) await ss(page, '10-second-scoring');

  const score2 = await waitFor(page, '76', 60000);
  if (score2) {
    report.secondSearchScores = true;
    console.log(`AI scores appeared on 2nd search ✅ (+${((Date.now()-t1)/1000).toFixed(1)}s) — this was the main bug!`);
    await ss(page, '11-second-scores');
  } else {
    console.log('❌ AI scores did NOT appear on 2nd search — BUG STILL PRESENT');
    await ss(page, '11-no-second-scores');
  }

  const complete2 = await waitFor(page, 'AI Analysis Complete', 90000);
  if (complete2) {
    report.analysisComplete2 = true;
    console.log(`2nd search analysis complete ✅ (+${((Date.now()-t1)/1000).toFixed(1)}s)`);
    await ss(page, '12-second-complete');
  } else {
    console.log('❌ 2nd search analysis did not complete');
    await ss(page, '12-no-second-complete');
  }

  const countdown2 = await waitFor(page, 'AI is preparing', 30000);
  console.log('Smart Apply on 2nd search:', countdown2 ? 'YES ✅' : 'NO (may have failed or too fast)');
  if (countdown2) await ss(page, '13-second-countdown');

  await waitGone(page, 'AI is preparing', 120000);
  await page.waitForTimeout(2000);
  await ss(page, '14-final-state');

  // ─────────────────────────────────────────────────────────────────────────
  // REPORT
  // ─────────────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('  VERIFICATION REPORT — PRODUCTION (careerpersonaai.com)');
  console.log('═'.repeat(60));
  const pass = (v) => v ? 'PASS ✅' : 'FAIL ❌';
  console.log(`A) AI Match scores on 1st search:    ${pass(report.firstSearchScores)}`);
  console.log(`B) "Analysis complete" on 1st search: ${pass(report.analysisComplete1)}`);
  console.log(`C) Smart Apply AFTER analysis:        ${report.countdownAfterComplete === null ? 'N/A (countdown not seen)' : pass(report.countdownAfterComplete)}`);
  console.log(`D) Countdown starts at 5:             ${report.countdownNum === null ? 'N/A' : pass(report.countdownNum === 5)} ${report.countdownNum !== null ? `(got ${report.countdownNum})` : ''}`);
  console.log(`E) AI Match scores on 2nd search:    ${pass(report.secondSearchScores)}`);
  console.log(`F) "Analysis complete" on 2nd search: ${pass(report.analysisComplete2)}`);
  console.log('─'.repeat(60));
  const passing = [report.firstSearchScores, report.analysisComplete1, report.secondSearchScores, report.analysisComplete2]
    .filter(Boolean).length;
  const verdict = passing === 4 ? 'ALL CORE CHECKS PASS ✅' : `${4 - passing} CORE CHECK(S) FAILED ❌`;
  console.log(`  VERDICT: ${verdict}`);
  console.log('═'.repeat(60));
  console.log(`\nScreenshots: ${SCREENSHOT_DIR}`);
  if (consoleLogs.length > 0) {
    console.log('\nBROWSER CONSOLE (AI-related):');
    consoleLogs.forEach(l => console.log(`  ${l}`));
  }

  await browser.close();
  process.exit(passing === 4 ? 0 : 1);
})().catch(e => {
  console.error('\nTEST CRASHED:', e.message, e.stack?.split('\n').slice(0, 3).join('\n'));
  process.exit(1);
});

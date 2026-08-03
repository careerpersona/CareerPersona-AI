/**
 * verify-i18n.mjs — loads every app page in every supported language (en,
 * es, de, ja, ar) with a fake authenticated session, screenshots each
 * combination, and flags two failure classes: the auth screen leaking
 * through (fake session didn't persist) and English text leaking into the
 * ja/ar renders (missing or incomplete translation keys).
 *
 * When to run: after adding/editing i18n locale files, adding a new page, or
 * touching auth-session bootstrapping — and periodically as a regression
 * check since it's the only tool that screenshots every language x page
 * combination in one pass.
 * Production-safe: no — all Supabase calls are mocked. Local development
 * only.
 * Prerequisites: dev server running at http://localhost:5173 (update BASE in
 * this file if your dev server runs elsewhere). Screenshots + report.json are
 * written to the SCRATCHPAD path hardcoded near the top — update it to a
 * writable directory before running outside the original Claude session.
 * Run: node scripts/verify/verify-i18n.mjs
 */
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const SCRATCHPAD = "C:/Users/ggund/AppData/Local/Temp/claude/c--Users-ggund-CareerPersona-AI-new/a666cc49-18a1-4d11-ab44-33637d77b345/scratchpad/screenshots-phase7";
mkdirSync(SCRATCHPAD, { recursive: true });

const BASE = "http://localhost:5173";
const LANGS = ["en", "es", "de", "ja", "ar"];
const PAGES = ["briefing", "plan", "progress", "jobintel", "dashboard", "resume", "jobs", "interview", "salary", "network", "tracker", "saved", "opportunity", "profile", "settings", "pricing", "alerts"];

// Proactive Job Alerts (Phase 7 i18n runtime verification): one critical
// alert fixture exercises the AI Explanation Rule fact-chip strings
// (tier/urgency/confidence/matchChip) alongside the narrative labels, not
// just the empty-state copy already covered by the default [] REST fallback.
const FAKE_ALERT_CANDIDATE_ID = "00000000-0000-0000-0000-0000000000a1";
function makeFakeAlertRow() {
  return {
    id: "00000000-0000-0000-0000-0000000000b1",
    user_id: FAKE_ID,
    candidate_id: FAKE_ALERT_CANDIDATE_ID,
    digest_type: "daily_critical",
    delivered_at: new Date().toISOString(),
    engaged_at: null,
    dismissed_at: null,
    application_id: null,
    explanation: {
      whyUrgent: "This role closes within 72 hours and a strong contact at this company was just confirmed.",
      basedOn: { urgencyFactors: [{ type: "closing_soon" }, { type: "referral_confirmed" }], matchScore: 92, confidenceTier: "exceptional" },
    },
    alert_candidates: {
      id: FAKE_ALERT_CANDIDATE_ID,
      job_id: "verify_i18n_job_1",
      job_title: "Senior Product Manager",
      company: "Acme Corp",
      alert_tier: "critical",
      match_score: 92,
      previous_tier: null,
      tier_change_reason: null,
      lifecycle_status: "alerted",
    },
  };
}
const SUPABASE_URL = "https://cbzebqxbohgkgcqfgmdm.supabase.co";
const FAKE_ID = "00000000-0000-0000-0000-000000000001";

function makeJWT(payload) {
  const b64url = s => Buffer.from(s).toString("base64url");
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  return `${header}.${body}.fakesig`;
}

function makeFakeSession(lang) {
  const accessToken = makeJWT({
    sub: FAKE_ID,
    email: "verify@test.com",
    role: "authenticated",
    exp: 9999999999,
    iat: 1700000000,
    aud: "authenticated",
    iss: "supabase",
  });
  const user = {
    id: FAKE_ID,
    aud: "authenticated",
    role: "authenticated",
    email: "verify@test.com",
    email_confirmed_at: "2024-01-01T00:00:00Z",
    phone: "",
    confirmed_at: "2024-01-01T00:00:00Z",
    last_sign_in_at: "2024-01-01T00:00:00Z",
    app_metadata: { provider: "email", providers: ["email"] },
    user_metadata: { full_name: "Test User" },
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };
  return {
    access_token: accessToken,
    token_type: "bearer",
    expires_in: 3600,
    expires_at: 9999999999,
    refresh_token: "fake-refresh-token",
    user,
  };
}

function makeFakeProfile(lang) {
  return {
    id: FAKE_ID,
    email: "verify@test.com",
    full_name: "Test User",
    phone: "",
    location: "San Francisco, CA",
    job_title: "Software Engineer",
    years_experience: "5",
    plan: "free",
    // premium_active bypasses the Proactive Job Alerts premium gate so the
    // "alerts" page renders real content, not just the upsell copy.
    subscription_status: "premium_active",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T00:00:00Z",
  };
}

function makeFakeProfileDetails(lang) {
  return {
    user_id: FAKE_ID,
    preferred_language: lang,
    preferred_job_title: "Software Engineer",
    preferred_industry: "Technology",
    work_type: "remote",
    desired_salary: "",
    career_goal: "",
    career_timeline: "",
    email_address: "verify@test.com",
  };
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const findings = [];

  for (const lang of LANGS) {
    console.log(`\n=== Language: ${lang} ===`);
    const session = makeFakeSession(lang);
    const fakeProfile = makeFakeProfile(lang);
    const fakeDetails = makeFakeProfileDetails(lang);
    const fakeUser = {
      id: FAKE_ID,
      email: "verify@test.com",
      full_name: "Test User",
      location: "San Francisco, CA",
      job_title: "Software Engineer",
      years_experience: "5",
      plan: "free",
      preferred_language: lang,
    };
    const sbKey = `sb-cbzebqxbohgkgcqfgmdm-auth-token`;

    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });

    // Inject fake auth into localStorage before every page load
    await context.addInitScript(({ sbKey, session, fakeUser }) => {
      // Supabase auth session (so getSession() returns immediately without network)
      localStorage.setItem(sbKey, JSON.stringify(session));
      // App-level user (cp_user key)
      localStorage.setItem("cp_user", JSON.stringify(fakeUser));
    }, { sbKey, session, fakeUser });

    // Intercept ALL Supabase network calls
    await context.route(`${SUPABASE_URL}/**`, async (route) => {
      const url = route.request().url();
      const method = route.request().method();

      // Auth endpoints
      if (url.includes("/auth/v1/token") || url.includes("/auth/v1/user")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(session),
        });
        return;
      }

      // REST: profiles table
      if (url.includes("/rest/v1/profiles")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(method === "GET" ? fakeProfile : {}),
        });
        return;
      }

      // REST: profile_details table
      if (url.includes("/rest/v1/profile_details")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(method === "GET" ? fakeDetails : {}),
        });
        return;
      }

      // REST: alerts (joined with alert_candidates) -- one critical alert
      // fixture so Proactive Job Alerts' AI-narrative + fact-chip strings
      // render, not just the empty-state copy.
      if (url.includes("/rest/v1/alerts")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(method === "GET" ? [makeFakeAlertRow()] : {}),
        });
        return;
      }
      if (url.includes("/rest/v1/alert_candidates")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(method === "GET" ? [makeFakeAlertRow().alert_candidates] : {}),
        });
        return;
      }

      // REST: realtime/websocket → block
      if (url.includes("/realtime/")) {
        await route.abort();
        return;
      }

      // All other REST calls → empty success
      if (url.includes("/rest/v1/")) {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: method === "GET" ? "[]" : "{}",
        });
        return;
      }

      // Everything else (storage, etc.) → continue
      await route.continue();
    });

    const page = await context.newPage();

    for (const pageId of PAGES) {
      console.log(`  Page: ${pageId}`);
      try {
        // Navigate with hash to set initial page (app reads hash before localStorage)
        await page.goto(`${BASE}/#${pageId}`, { waitUntil: "networkidle", timeout: 20000 });
        await page.waitForTimeout(2000);

        // Screenshot
        const screenshotPath = join(SCRATCHPAD, `${lang}-${pageId}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });

        // Check that we're NOT on the auth screen (which would mean our fake user failed)
        const isAuthScreen = await page.evaluate(() => {
          const h = document.body.innerText;
          return h.includes("Sign In") && h.includes("Sign Up") && h.includes("you@email.com");
        });

        if (isAuthScreen) {
          console.log(`    ⚠️  Auth screen shown — fake user did not persist`);
          findings.push({ lang, page: pageId, issue: "auth-screen-shown" });
        } else {
          // Collect visible text for English leakage check (non-English only).
          // Phase 7 (Proactive Job Alerts i18n): es/de are the LTR
          // representatives, ar is the RTL representative -- all three now
          // checked, not just ja/ar, so the "alerts" page's new namespace is
          // verified in both a Latin-script LTR locale and a non-Latin one.
          if (lang === "ja" || lang === "ar" || lang === "es" || lang === "de") {
            const texts = await page.$$eval("*:not(script):not(style)", (els) =>
              els
                .filter((el) => el.children.length === 0 && el.innerText?.trim().length > 5)
                .map((el) => el.innerText?.trim())
                .filter(Boolean)
                .slice(0, 200)
            );

            const suspicious = texts.filter((t) => {
              if (t.length < 8) return false;
              // Skip numbers, URLs, emails
              if (/^[\d$€£¥₹%+\-–—.,!?/\\@#*]/.test(t)) return false;
              if (/\.(com|org|net|io)/.test(t)) return false;
              // Skip product names that stay in English
              if (/CareerPersona|Google|LinkedIn|GitHub|Apple|Microsoft|OpenAI|Claude/i.test(t)) return false;
              const words = t.split(/\s+/);
              if (words.length < 3) return false;
              const asciiLetters = (t.match(/[a-zA-Z]/g) || []).length;
              return asciiLetters / t.length > 0.7;
            });

            if (suspicious.length > 0) {
              findings.push({ lang, page: pageId, suspicious: suspicious.slice(0, 5) });
              console.log(`    ⚠️  Possible English leakage:`, suspicious.slice(0, 3));
            } else {
              console.log(`    ✅ No English leakage detected`);
            }
          } else {
            console.log(`    ✅ Page rendered`);
          }
        }
      } catch (e) {
        console.log(`    ❌ Error: ${e.message}`);
        findings.push({ lang, page: pageId, error: e.message });
      }
    }

    await context.close();
  }

  writeFileSync(join(SCRATCHPAD, "report.json"), JSON.stringify({ languages: LANGS, pages: PAGES, findings }, null, 2));

  console.log("\n=== SUMMARY ===");
  const authFails = findings.filter((f) => f.issue === "auth-screen-shown");
  const leakages = findings.filter((f) => f.suspicious);
  const errors = findings.filter((f) => f.error);
  console.log(`Auth screen shown: ${authFails.length} pages`);
  console.log(`English leakage: ${leakages.length} pages`);
  console.log(`Errors: ${errors.length} pages`);
  if (authFails.length > 0) authFails.forEach((f) => console.log(`  AUTH: ${f.lang}/${f.page}`));
  if (leakages.length > 0) leakages.forEach((f) => console.log(`  LEAK: ${f.lang}/${f.page}:`, f.suspicious));
  if (errors.length > 0) errors.forEach((f) => console.log(`  ERR: ${f.lang}/${f.page}:`, f.error));

  await browser.close();
  console.log("\nScreenshots:", SCRATCHPAD);
}

run().catch((e) => { console.error(e); process.exit(1); });

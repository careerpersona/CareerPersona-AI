//
// These strings are the verbatim text of the five approved English legal
// drafts produced during the Phase 7 legal-document drafting work. They are
// reproduced here exactly as drafted -- not rewritten, summarized, or
// paraphrased -- for internal inspection and lawyer review. Do not edit the
// substantive text of these documents outside of an explicit drafting task;
// this file is a content source for LegalDocumentPage, not a place to make
// editorial changes.
//
// Rendering uses a small markdown-flavored formatter (see
// renderLegalContent in App.jsx) that understands #/##/### headings, **bold**
// and *italic* inline text, "- " bullet lists, "> " blockquotes, "---"
// horizontal rules, and falls back to plain paragraphs for anything else
// (including the one markdown table in the Privacy Policy, which is why its
// rows render as plain lines rather than an HTML table -- acceptable for an
// internal-inspection build).

export const PRIVACY_POLICY = `
**Effective Date:** [DATE TO BE SET AT PUBLICATION]

**Language:** This Privacy Policy is written and maintained in English. Where translated versions are made available for convenience, the English version is the authoritative text and controls in the event of any conflict or inconsistency between versions.

---

## 1. Who We Are

CareerPersona AI is operated by **SELLATREND ENTERPRISES LLC**, a Georgia limited liability company, founded by Guven Gunduz. Our business address is 3939 Royal Dr, Unit 155, Kennesaw, GA 30144, USA.

---

## 2. What Information We Collect

We collect the following categories of information when you use CareerPersona AI:

**Account and profile information:** name, email address, phone number, country, location, LinkedIn URL, website URL, job title, years of experience, and skills, provided when you create an account or complete your profile.

**Job preferences:** preferred job title, preferred industry, work-type preference (remote/hybrid/on-site), desired salary, preferred language, career goals, and career timeline.

**Resume content:** the text and, where you upload a file, the original file of any resume you add to the platform, along with related metadata (version labels, language, ATS analysis results, keyword matches, and similar analysis output).

**Job search and application data:** jobs you save, applications you track (company, role, status, dates, notes, contacts, salary and location details you enter), and job listing details captured at the time you save or apply to a job.

**Career activity data:** interview practice sessions, salary research results, networking contacts and outreach records, LinkedIn profile analyses, referral-related analyses, AI-generated career briefings and action plans, career-progress and outcome-tracking data, job/company watchlists, and records created by the Smart Apply and AI Assistant Chat features.

**Billing information:** your subscription plan and status, and identifiers Stripe assigns to your customer and subscription records. We do not store your payment card details ourselves — those are handled directly by Stripe.

**Usage and support information:** a record of certain feature activity within the app, and quota/usage counters associated with AI features, used to operate quotas and troubleshoot the service.

---

## 3. How We Use Information

We use the information described above to:

- Provide the features you use: resume analysis and optimization, job search and matching, application tracking, interview preparation, salary research, networking and referral tracking, LinkedIn profile optimization, career progress and outcome analysis, and the AI Assistant Chat feature.
- Operate account functions: authentication, your profile, and your subscription/billing status.
- Operate job search: send your search criteria (title, location, and similar filters) to job listing providers and return matching results to you.
- Provide the data export and account deletion features described in Sections 8 and 9.
- Maintain and troubleshoot the service, including tracking feature usage against plan quotas.

---

## 4. AI-Powered Features

CareerPersona AI includes multiple AI-powered features (resume analysis and rewriting, cover letter generation, interview question generation, salary estimates, career briefings and action plans, LinkedIn content suggestions, networking message drafts, job-fit analysis, and the AI Assistant Chat, among others).

**What is sent to our AI provider:** When you use an AI-powered feature, relevant content you provide — which may include your resume text, job description text you paste or that is retrieved for a job you're viewing, and other career-related information you enter (such as your career goals or chat messages) — is sent to our AI provider, **Anthropic**, as part of the request needed to generate that feature's output. Only the content relevant to the specific feature you're using is sent for that request.

**Why it is processed:** This content is processed solely to generate the output you requested (for example, an ATS score and suggested edits, a drafted cover letter, or a chat response) and to return that output to you within the app.

**Salary estimates specifically:** the app discloses in-product that salary figures produced by this feature are AI-generated estimates for guidance only, not verified market data.

We do not currently have any AI feature confirmed to make automated decisions about you with legal or similarly significant effects (e.g., automated hiring decisions) — all AI outputs in this product (scores, suggestions, drafts) are informational and presented for your own review and use.

---

## 5. How Information Is Shared — Service Providers

We do not sell your personal information. We share information with the following service providers, each of which processes information only as needed to provide their part of the service:

| Provider | Role | What they may process |
|---|---|---|
| **Supabase** | Database, authentication, and file storage | Substantially all account and product data described in Section 2, including uploaded resume files |
| **Cloudflare** (Workers, Pages, KV, and its public CDN) | Application hosting, API processing, a short-lived billing-status cache, and delivery of a third-party PDF-parsing script (pdf.js) via Cloudflare's CDN | Requests you make to the app; a cached copy of your subscription status; for the CDN-delivered script, no application data is sent — only what any request to a hosted file reveals (such as your IP address) |
| **Stripe** | Payment processing and subscription billing | Your billing/contact details needed to process payment; we do not receive or store your card number |
| **Anthropic** | AI processing for AI-powered features | The prompt content described in Section 4, for the specific feature you use |
| **Adzuna** | Job listing search | Search parameters (job title, location, and similar filters) you submit when searching for jobs — not your account profile |
| **RapidAPI / JSearch** | Job listing search | Search parameters (job title, location, and similar filters) you submit when searching for jobs — not your account profile |
| **Google (Google Fonts)** | Web font delivery | No account or application data. When you load the app, your browser requests font files directly from Google's servers; Google receives only what any such request reveals (such as your IP address and browser information) — we do not send your resume, profile, or other application data to Google |

We do not use any third-party analytics or advertising service — this audit confirmed no such service is integrated into the product.

---

## 6. Data Storage and Processing

Your data is stored in a Supabase-hosted database located in the **us-west-2** region (Oregon, USA), and, for uploaded resume files, in Supabase Storage within the same project. Application logic runs on Cloudflare Workers, and the web application is served via Cloudflare Pages — both operate on Cloudflare's global network rather than a single fixed location, meaning requests to and from the application may be handled at a Cloudflare location other than where your data is stored.

---

## 7. Cookies and Similar Technologies

CareerPersona AI does not currently use cookies. Your login session is stored using your browser's local storage (not a cookie), and other local/session storage is used to remember in-app preferences and unsaved work within your browser. This audit confirmed no third-party tracking or advertising script is loaded by the application.

---

## 8. Account Deletion

You may request deletion of your account from your account settings.

- **What happens immediately:** your account is locked — while deletion is scheduled, you can only see a screen confirming the scheduled deletion date, cancel the deletion request, or export your data (see Section 9); no other part of the app is accessible. Any active paid subscription is **canceled immediately** with your provider, Stripe — not at the end of your current billing period.
- **The 30-day window:** your account and data are scheduled for permanent deletion 30 days after your request.
- **Cancelling your deletion request:** if you cancel within the 30-day window, your account and access are fully restored. **Your previously canceled Stripe subscription is not automatically restored** — because cancellation was immediate, resuming paid access requires subscribing again.
- **What is deleted when the 30 days elapse:** your profile and profile details; your resumes (including uploaded files) and related analysis history; job applications and saved jobs; interview sessions; networking contacts and sessions; salary research and salary offer records; LinkedIn and referral analyses; AI-generated briefings, action plans, and career/job intelligence records; job and company watchlists; notifications; automation preferences; outcome-tracking records; the Smart Apply queue; AI Assistant Chat history; billing/usage records associated with your account; your Supabase authentication account; and the cached billing-status entry associated with your account.
- **After deletion completes:** a minimal internal record is kept solely to confirm the deletion occurred and to support the 30-day scheduling and retry process described above. That record no longer contains your account identifier or any of the data listed above — it is limited to a newly generated, unrelated reference identifier, the dates the deletion was requested/completed, and its status. This record is currently retained for 12 months after completion and then automatically removed.

**Refunds:** Subscription payments are generally non-refundable once payment has been made. Cancelling your subscription — including by requesting account deletion — stops future renewal charges but does not, by itself, refund amounts already paid. If CareerPersona AI caused a genuine billing or service problem, we intend to investigate and provide an appropriate remedy where warranted. If you have a billing concern, please contact us first at info@sellatrend.com so we can review it. Contacting us is not a legal prerequisite to disputing a charge or exercising any right you may have under applicable law.

---

## 9. Data Export

You can download a copy of your data at any time from account settings, or from the account-deletion screen described in Section 8, using the same export function in both places. The export is a single file, generated and downloaded directly in your browser — it is not emailed to you.

The export includes: your profile; your resumes and related analysis history; job applications; saved jobs; interview sessions; networking contacts and sessions; salary research and salary offer records; LinkedIn and referral analyses; AI-generated career briefings, action plans, career-progress, and job-intelligence records; job and company watchlists; notifications; automation preferences; outcome-tracking records; the Smart Apply queue; and AI Assistant Chat history.

For resume files you uploaded, the export includes a temporary download link (valid for one hour) rather than the file itself embedded in the export.

The export does **not** include your internal activity log or your billing/subscription state records — these are excluded by design.

Where a saved job or application in your export originated from a job search, the export contains the job details as they were stored at the time you saved it — we do not re-fetch updated information from the original job listing source to build your export.

---

## 10. Security

Access to your data within our database is restricted so that, under normal application access, an account can only read and modify its own records. Data-deletion operations described in Section 8 are performed only through our backend service using elevated access, not directly by the client application. All communication with the application occurs over encrypted (HTTPS) connections.

---

## 11. Your Choices and Rights

**Product controls available to you today**, confirmed by this audit:
- Edit your profile and job-preference information at any time in Settings.
- Export a copy of your data (Section 9).
- Request deletion of your account, with the ability to cancel within 30 days (Section 8).

---

## 12. International Use

CareerPersona AI is accessible to users internationally. Our primary database is hosted in the **us-west-2** region (Oregon, USA); other infrastructure — including Cloudflare's network, which operates across multiple global locations — processes requests without being tied to a single fixed location.

---

## 13. Changes to This Privacy Policy

We may update this Privacy Policy from time to time. When we do, we will revise the "Effective Date" above. If changes are material, we will provide additional notice through a method we determine is appropriate at that time.

---

## 14. Contact Us

If you have questions about this Privacy Policy, or wish to reach us about your data, contact us at **info@sellatrend.com**.
`;

export const TERMS_OF_SERVICE = `
**Effective Date:** [DATE TO BE SET AT PUBLICATION]

**Language:** These Terms of Service are written and maintained in English. Where translated versions are made available for convenience, the English version is the authoritative text and controls in the event of any conflict or inconsistency between versions.

---

## 1. Agreement and Eligibility

These Terms of Service ("Terms") are an agreement between you and **SELLATREND ENTERPRISES LLC**, a Georgia limited liability company ("CareerPersona AI," "we," "us," or "our"), governing your use of the CareerPersona AI application and website (the "Service"). By creating an account or otherwise using the Service, you agree to these Terms.

---

## 2. Description of the Service

CareerPersona AI is a career-management platform. Based on the verified product implementation, the Service includes:

- Profile and job-preference management.
- Resume upload, storage, AI-assisted analysis (including ATS-style scoring and suggested edits), and version history.
- Job search, using listings retrieved from third-party job-listing providers (Section 6), and the ability to save jobs and track applications.
- AI-generated content, including cover letters, interview questions and practice sessions, career briefings and action plans, LinkedIn profile and networking content, and salary estimates (Section 5).
- An AI Assistant Chat feature.
- Networking-contact and referral tracking.
- A "Smart Apply" application-package queue.
- Paid subscription tiers that unlock additional usage of the AI-powered features above (Section 7).
- Data export and account deletion, as described in Sections 4 and 12 and in the Privacy Policy.

We may add, modify, or remove features of the Service at any time.

---

## 3. Accounts and Account Security

To use most of the Service, you must create an account with an email address and password (or another supported sign-in method). You are responsible for maintaining the confidentiality of your login credentials and for all activity that occurs under your account. You agree to provide accurate information when creating and maintaining your account.

You must notify us at info@sellatrend.com if you become aware of any unauthorized use of your account.

---

## 4. User-Provided Content and User Responsibilities

**Your content.** You retain ownership of the content you provide to the Service — including your resume text and files, profile information, job application notes, and messages you send through the AI Assistant Chat ("Your Content"). By submitting Your Content, you grant us the rights necessary to store, process, and display it back to you as part of operating the Service, including sending relevant portions of it to our AI provider as described in Section 5 and in the Privacy Policy.

**Your responsibilities.** You are responsible for the accuracy of the information you provide (including your resume and profile details) and for how you use any output the Service generates — including whether and how you submit it to employers or other third parties.

---

## 5. AI-Generated Content and Limitations *(critical section)*

CareerPersona AI includes multiple AI-powered features: resume analysis and rewriting, ATS scoring, cover-letter generation, interview question generation and practice feedback, career briefings and action plans, career-progress and outcome analysis, LinkedIn profile and networking-message suggestions, job-fit analysis, salary estimates, and the AI Assistant Chat.

**These features use a third-party AI provider (Anthropic).** As described in our Privacy Policy, using an AI-powered feature may send relevant content you provide — such as your resume text, a job description, or your chat messages — to Anthropic to generate that feature's output.

**AI output is informational only.**
- AI-generated content — including but not limited to career suggestions, resume and cover-letter content, interview preparation material, job-fit analysis, and salary estimates — is provided for your information and convenience. It requires your own judgment and review before you rely on it.
- We do not represent AI-generated output as accurate, complete, or suitable for any particular purpose, and it is not professional advice — including not legal advice, financial advice, career-counseling advice, or any other professional advice.
- Salary estimates specifically are AI-generated estimates for general guidance only, not verified market data — consistent with the in-product disclosure already shown to users.
- **We do not promise or guarantee any employment outcome** (including being hired, receiving interviews, or receiving offers) as a result of using the Service or any AI-generated content it produces.
- You are solely responsible for reviewing, editing, and deciding whether to use any AI-generated content, including before submitting it to a prospective employer or any other third party.

---

## 6. Job Listings and Third-Party Services

Job listings displayed in the Service are retrieved from third-party providers — **Adzuna** and **RapidAPI/JSearch** — based on the search criteria you provide. We do not create, verify, or guarantee the accuracy, completeness, or current availability of any job listing, and we are not the employer for any listed position. When you save a job or track an application, the Service stores the job details as they existed at the time you saved them; we do not continuously verify that a saved listing remains accurate or active.

---

## 7. Subscriptions, Billing, Cancellation, and Refunds

The Service offers free and paid subscription tiers. Paid subscriptions are billed on a recurring basis through our payment processor, **Stripe**. We do not receive or store your full payment card number.

**Cancellation.** You may cancel your subscription at any time. Cancellation stops future renewal charges.

**Refunds.** Subscription payments are generally non-refundable once payment has been made. Cancelling your subscription — including by requesting account deletion (Section 12) — stops future renewal charges but does not, by itself, refund amounts already paid. If CareerPersona AI caused a genuine billing or service problem, we intend to investigate and provide an appropriate remedy where warranted. If you have a billing concern, please contact us first at info@sellatrend.com so we can review it. Contacting us is not a legal prerequisite to disputing a charge or exercising any right you may have under applicable law.

**Account deletion and billing.** If you request account deletion, any active paid subscription is canceled immediately (not at the end of your current billing period). If you cancel your deletion request within the 30-day window, your account access is restored, but your canceled subscription is not automatically restored — resuming paid access requires subscribing again. (See Section 12 and the Privacy Policy for the full account-deletion process.)

---

## 8. Acceptable Use

CareerPersona AI is intended for your own individual career-management use. The complete rules governing acceptable use of the Service — including restrictions on data scraping, bot and automation abuse, account sharing, reverse engineering, fraudulent or fabricated content, interference with the Service, circumventing usage limits, abusive AI use, spam and outreach abuse, AI safeguard circumvention, job-listing data misuse, multiple accounts, and facilitating third-party platform violations — are set out in full in our **Fair Use / Acceptable Use Policy**.

Two points from that Policy are highlighted here because they define the boundary of what's expected from ordinary use of the Service:

- **Truthful use is permitted; fabrication is not.** Using CareerPersona AI's AI features to truthfully tailor your resume or cover letter, or to persuasively present your genuine experience, is permitted and is a core intended use of the Service. Fabricating credentials, degrees, certifications, employment history, qualifications, or another person's identity is prohibited.
- **Preparation is permitted; certain live assistance is not.** Using the Service to prepare for and practice for interviews, assessments, or examinations is permitted and is a core intended use of the Service. The Fair Use / Acceptable Use Policy addresses the prohibition on using the Service as real-time assistance to generate or supply answers during an actual interview, assessment, examination, or proctored test where such assistance is not allowed.

For the complete list of acceptable-use rules, see our Fair Use / Acceptable Use Policy, which is intended to be incorporated into these Terms.

---

## 9. Intellectual Property Rights

The Service, including its software, design, and branding, is owned by SELLATREND ENTERPRISES LLC or its licensors. We grant you a limited, non-exclusive, non-transferable right to use the Service for your personal career-management purposes, subject to these Terms. As stated in Section 4, you retain ownership of Your Content.

---

## 10. Third-Party Links and Services

The Service may contain links to, or integrate with, third-party services (including job listings and their source websites, and Stripe's billing portal). We do not control and are not responsible for the content, policies, or practices of third-party services. Your use of any third-party service is governed by that service's own terms.

---

## 11. Account Suspension and Termination

We may suspend or terminate your access to the Service if we reasonably believe you have violated these Terms.

---

## 12. Privacy and Account Deletion

Our collection and use of your information is described in our Privacy Policy, which is incorporated into these Terms by reference. As described there:

- You may request deletion of your account, which locks your account, cancels any active subscription immediately, and schedules permanent deletion of your data 30 days later; you may cancel the deletion request within that window (which restores account access but does not restore a canceled subscription).
- You may export a copy of your data — profile, resumes, applications, saved jobs, interview sessions, networking data, salary research, LinkedIn/referral analyses, AI-generated career analyses, watchlists, notifications, automation preferences, outcome-tracking data, the Smart Apply queue, and AI Assistant Chat history — at any time, directly from the app.

Nothing in these Terms limits the rights or disclosures described in the Privacy Policy; where the two documents describe the same product behavior, the Privacy Policy is the more detailed source and both must be kept consistent.

---

## 13. Disclaimers

**We are deliberately not drafting a substantive warranty-disclaimer clause in this document.** Standard SaaS boilerplate (e.g., blanket "AS IS" / "AS AVAILABLE" disclaimers, disclaimers of implied warranties of merchantability or fitness for a particular purpose) has **not** been included here, because its enforceability and appropriate scope have not been reviewed by an attorney, and inserting confident-sounding boilerplate without that review risks stating something we cannot actually stand behind.

---

## 14. Limitation of Liability

**As with Section 13, we are not drafting a substantive limitation-of-liability clause here.** No liability cap, no exclusion of consequential/indirect/incidental damages, and no other limitation has been asserted in this draft, because none has been reviewed or approved by an attorney.

---

## 15. Indemnification

---

## 16. Governing Law and Dispute Resolution

---

## 17. Changes to These Terms

We may update these Terms from time to time. When we do, we will revise the "Effective Date" above. If changes are material, we will provide additional notice through a method we determine is appropriate at that time.

---

## 18. Contact Information

SELLATREND ENTERPRISES LLC
3939 Royal Dr, Unit 155
Kennesaw, GA 30144, USA

For questions about these Terms, contact us at **info@sellatrend.com**.
`;

export const REFUND_POLICY = `
**Effective Date:** [DATE TO BE SET AT PUBLICATION]

**Language:** This Refund & Cancellation Policy is written and maintained in English. Where translated versions are made available for convenience, the English version is the authoritative text and controls in the event of any conflict or inconsistency between versions.

This Policy should be read together with our Terms of Service (Section 7) and Privacy Policy, which describe the same subscription, cancellation, and account-deletion behavior. Where this Policy and those documents both address the same topic, the substantive position is intended to be identical.

---

## 1. Cancelling Your Subscription

You may cancel your paid subscription at any time. Cancellation stops future renewal charges — you will not be billed again once your cancellation takes effect.

Cancellation does not, by itself, refund any amount you've already paid.

---

## 2. Refunds

Subscription payments are generally non-refundable once payment has been made.

If CareerPersona AI caused a genuine billing or service problem — for example, a billing error on our part or a service failure we were responsible for — we intend to investigate and provide an appropriate remedy where warranted.

Refunds are considered on a case-by-case basis for genuine problems of the kind described above. This Policy does not promise a refund in every case, and a request that does not qualify under this Policy may be denied. If we deny a request, we intend to provide you with a clear explanation of why.

We do not accuse customers of fraud or dishonesty when reviewing a refund request; requests are reviewed on their merits.

---

## 3. How to Request a Refund or Report a Billing Problem

If you believe something went wrong with your billing or the Service, please contact us first at **info@sellatrend.com** and explain the issue. We intend to review genuine problems and, where we caused the problem, provide an appropriate remedy.

Contacting us first is how we're able to look into and fix legitimate problems quickly. **Contacting us is not a legal prerequisite** to disputing a charge or exercising any right you may have under applicable law — you are not required to contact us before pursuing a chargeback, dispute, or any other right available to you.

---

## 4. Legal Rights That May Apply to You

Depending on where you are located, you may have legal rights regarding cancellation, refunds, or subscription renewal that exist independently of this Policy, including but not limited to:

- Statutory withdrawal or "cooling-off" rights (for example, under EU or UK distance-selling law).
- U.S. state-level auto-renewal or subscription-disclosure requirements.
- Other mandatory refund rights under applicable consumer-protection law.
- Requirements around the timing of cancellation or specific notices before a renewal charge.
- Chargeback or payment-dispute rights through your card issuer or payment provider.

---

## 5. Account Deletion and Your Subscription

This section reflects the verified behavior of the account-deletion feature, consistent with our Privacy Policy and Terms of Service:

- **Requesting account deletion immediately cancels any active paid subscription.** This cancellation happens right away — not at the end of your current billing period.
- Your account then enters a **30-day deletion window**, during which your account is locked except for the ability to cancel the deletion request or export your data.
- **If you cancel the deletion request within the 30-day window, your account access is restored.** However, **your canceled subscription is not automatically restored** — because cancellation was immediate, you will need to **subscribe again** if you want to resume paid access.

The refund position in Section 2 applies the same way here — the immediate cancellation caused by requesting deletion does not, by itself, refund any amount already paid, and the same case-by-case review described in Sections 2–3 applies if you believe a genuine billing problem occurred in connection with a deletion request.

---

## 6. Payment Method

Paid subscriptions are billed through our payment processor, Stripe. We do not receive or store your full card number.

---

## 7. Changes to This Policy

We may update this Policy from time to time. When we do, we will revise the "Effective Date" above.

---

## 8. Contact Information

SELLATREND ENTERPRISES LLC
3939 Royal Dr, Unit 155
Kennesaw, GA 30144, USA

For billing questions, refund requests, or cancellation help, contact us at **info@sellatrend.com**.
`;

export const FAIR_USE_POLICY = `
**Effective Date:** [DATE TO BE SET AT PUBLICATION]

**Language:** This Fair Use / Acceptable Use Policy is written and maintained in English. Where translated versions are made available for convenience, the English version is the authoritative text and controls in the event of any conflict or inconsistency between versions.

CareerPersona AI is operated by **SELLATREND ENTERPRISES LLC**, a Georgia limited liability company, founded by Guven Gunduz. Our business address is 3939 Royal Dr, Unit 155, Kennesaw, GA 30144, USA.

**Relationship to the Terms of Service:** This Policy is intended to be incorporated into, and form part of, our Terms of Service — it is meant to become the detailed source of truth for acceptable use, with the Terms' own Section 8 shortened to reference this document once both are finalized.

CareerPersona AI is intended for your own individual career-management use — managing your resume, searching and tracking jobs, preparing for interviews, and using the AI-powered features to support that work. Ordinary, truthful use of the Service for these purposes is always permitted. The rules below describe conduct that falls outside that intended use.

---

## Prohibited Conduct

**1. Scraping and bulk data collection.** Scraping, bulk-extracting, or systematically collecting data from the Service is prohibited.

**2. Bots and abusive automation.** Using bots or automated requests designed to bypass normal usage limits or security controls is prohibited.

**3. Account sharing and resale.** Sharing, transferring, renting, or reselling your account or your paid access is prohibited.

**4. Reverse engineering.** Reverse engineering, attempting to extract the source code of, or attempting to copy or reproduce the Service is prohibited, except to the extent such a restriction is prohibited by applicable law.

**5. Fraud and fabrication.** Submitting false or fraudulent information to an employer or any other third party, or fabricating credentials, degrees, certifications, employment history, qualifications, or another person's identity, is prohibited.

This does **not** prohibit truthful resume tailoring, cover-letter customization, or the persuasive presentation of your genuine experience — that is a core, intended use of the Service.
> *Example — permitted:* Changing emphasis or wording to better present your genuine experience for a particular role.
> *Example — prohibited:* Inventing a degree, certification, employer, job title, or employment history you don't actually have.

**6. Interference and unauthorized access.** Attempting to interfere with, damage, disrupt, compromise, or gain unauthorized access to the Service, or to another user's account or data, is prohibited.

**7. Circumventing restrictions.** Circumventing subscription, quota, usage, or security restrictions is prohibited.

**8. Abusive automated AI use.** Using the AI features in bulk or automated fashion at a scale inconsistent with ordinary individual career use — including generating content for resale, or operating a competing or third-party service through CareerPersona AI — is prohibited.

This does **not** prohibit using CareerPersona AI's own built-in features as designed, including features that act on multiple jobs or applications at once.
> *Example — permitted:* Using a built-in feature provided by CareerPersona AI as designed, even if it processes several jobs or applications together.
> *Example — prohibited:* Scripting repeated requests specifically to bypass quotas or extract data at scale.

**9. Spam and outreach abuse.** Using the Networking/Outreach features to send spam or mass unsolicited outreach, or otherwise using those features abusively, is prohibited — including conduct that violates the applicable rules of the third-party platform where outreach occurs (for example, LinkedIn or an email provider).

**10. AI safeguard circumvention and off-topic use.** Attempting to extract system prompts from, jailbreak, manipulate, or otherwise circumvent the safeguards of the AI Assistant or any other AI feature is prohibited, as is using the AI features primarily as a general-purpose AI service unrelated to their intended career-management functions.

**11. Job-listing data.** Extracting, republishing, redistributing, or reselling job-listing data obtained through the Service is prohibited.

**12. Multiple accounts.** Creating multiple accounts for the purpose of circumventing free-tier, subscription, quota, or usage limits is prohibited.

**13. Facilitating third-party violations.** Using CareerPersona AI to facilitate violations of applicable third-party platform terms or policies is prohibited.

**14. Live interview and exam assistance.** Using CareerPersona AI as real-time assistance to generate or supply answers **during** an actual interview, assessment, examination, or proctored test where such assistance is prohibited or inconsistent with the applicable rules of that interview, assessment, examination, or test is prohibited.

This is a rule about *when and how* the Service is used — interview preparation, practice, and advance preparation remain fully permitted and are a core intended use.
> *Example — permitted:* Practicing likely interview questions and answers before an interview.
> *Example — prohibited:* Using CareerPersona AI to generate answers in real time during a live assessment where that kind of assistance isn't allowed.

*The examples above are illustrative only and do not create any additional prohibited category beyond the fourteen rules stated.*

---

## Enforcement

Violating this Policy is a violation of our Terms of Service and may result in action under the Terms' existing account suspension/termination provisions (Terms of Service, Section 11).

We do not assert that violating this Policy is necessarily unlawful — violations are treated as breaches of our agreement with you (the Terms of Service), not as legal conclusions about the conduct itself.

---

## Contact

Questions about this Policy can be directed to **info@sellatrend.com**.
`;

export const COOKIE_POLICY = `
**Effective Date:** [DATE TO BE SET AT PUBLICATION]

**Language:** This Cookie Policy is written and maintained in English. Where translated versions are made available for convenience, the English version is the authoritative text and controls in the event of any conflict or inconsistency between versions.

CareerPersona AI is operated by **SELLATREND ENTERPRISES LLC**, a Georgia limited liability company, founded by Guven Gunduz. Our business address is 3939 Royal Dr, Unit 155, Kennesaw, GA 30144, USA.

---

## Do We Use Cookies?

**No. CareerPersona AI does not currently use cookies.**

Because we don't use cookies, there are no advertising cookies, analytics cookies, or tracking cookies to describe here — none of those categories apply to this Service.

## What About Other Browser Storage?

Our application does use your browser's **local storage** for certain functionality — for example, to keep you signed in between visits and to remember some in-app preferences or unsaved work. Local storage is a different browser technology than cookies: it's not automatically sent to our servers with every request the way a cookie can be, and it's used here for the app to function, not for advertising or tracking.

## What About Google Fonts?

When you load CareerPersona AI, your browser requests font files directly from Google's servers to display the application's typography. This is a direct font-loading request, not a cookie, and not an advertising or tracking service — Google receives only what any such request reveals (such as your IP address and browser information); we do not send your resume, profile, or other application data to Google as part of this request. This is the same disclosure made in our Privacy Policy.

## Do We Use Advertising or Tracking Scripts?

No. CareerPersona AI does not load any third-party advertising or tracking script.

## Questions

If you have questions about this Cookie Policy, contact us at **info@sellatrend.com**.

## Changes to This Policy

If our use of cookies or similar technology ever changes, we will update this Policy to reflect that.
`;

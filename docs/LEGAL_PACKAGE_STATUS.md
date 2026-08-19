# Legal Package Status

**Last updated:** 2026-08-16
**Status:** DRAFT PACKAGE — NOT PUBLISHED — PENDING ATTORNEY REVIEW

This file exists so a future Claude Code session (or a human) can understand exactly where the CareerPersona AI legal package stands without needing prior conversation history.

---

## 1. Current Status

| Document | Status |
|---|---|
| Privacy Policy | DRAFT, pending legal review |
| Terms of Service | DRAFT, pending legal review |
| Refund & Cancellation Policy | DRAFT, pending legal review |
| Fair Use / Acceptable Use Policy | DRAFT, pending legal review |
| Cookie Policy | DRAFT, pending legal review |

- All five documents are implemented as inspectable draft pages in the running app.
- They are **not** in primary navigation, not in the footer, not on signup, and not on checkout — they are directly accessible by URL for internal inspection only.
- They are **not** presented as finalized or public legal documents anywhere in the app. Every rendered page carries a visible draft warning (see Section 3).
- **The app is not to be published or launched until attorney review is completed and any required changes have been implemented.**

## 2. Business Identity

| Field | Value |
|---|---|
| Business | SELLATREND ENTERPRISES LLC |
| State of formation | Georgia |
| Business address | 3939 Royal Dr, Unit 155, Kennesaw, GA 30144, USA |
| Founder | Guven Gunduz |
| Contact | info@sellatrend.com |
| Product/app name | CareerPersona AI |

English is the authoritative language for all legal documents. Translations into other supported app languages are planned only after the English documents are legally approved — no other language versions of these documents exist yet, and none should be created before that approval.

## 3. Legal Package — Source Location

All five documents live as template-literal string constants in:

```
src/legal/documents.js
```

| Export name | Document |
|---|---|
| `PRIVACY_POLICY` | Privacy Policy |
| `TERMS_OF_SERVICE` | Terms of Service |
| `REFUND_POLICY` | Refund & Cancellation Policy |
| `FAIR_USE_POLICY` | Fair Use / Acceptable Use Policy |
| `COOKIE_POLICY` | Cookie Policy |

They are rendered in `src/App.jsx` via a small hand-rolled markdown-subset formatter (`parseInline`, `renderLegalContent`) and a shared `LegalDocumentPage` component, at these routes:

| Route (`page` state) | Document |
|---|---|
| `legal-privacy` | Privacy Policy |
| `legal-terms` | Terms of Service |
| `legal-refund` | Refund & Cancellation Policy |
| `legal-fairuse` | Fair Use / Acceptable Use Policy |
| `legal-cookies` | Cookie Policy |

Every rendered page displays a hardcoded, always-visible draft warning: **"DRAFT — NOT FOR PUBLICATION — PENDING LEGAL REVIEW."** As of Phase 9 (commit `94efa44`), the `support` route (Contact/Support page) provides only the contact/support mechanism (email) — it no longer links to or exposes any of the five draft legal documents, keeping Support independent of this still-unapproved package. The five documents remain fully disconnected (not in `validPages`, no render path) and pending attorney review.

## 4. Lawyer Review Status

**The documents have not been legally approved.** They were drafted using verified facts about the product's actual implementation (data handling, third-party providers, deletion/export behavior, acceptable-use conduct rules) combined with business-decided policy positions (Section 5), but no attorney has reviewed them.

Each document marks open legal questions inline with `[LEGAL REVIEW REQUIRED]`, and facts not independently verified with `[UNCONFIRMED / DO NOT PUBLISH AS FACT]`. The major unresolved legal-review topics, consolidated across all five documents, are:

- Legal basis for processing (data protection law framing)
- International data transfers (mechanism, e.g. Standard Contractual Clauses; jurisdiction-specific data-residency requirements)
- Anthropic contractual/retention/training/human-review questions (what Anthropic itself does with prompt content sent to it)
- Age/minors position (whether the Service is restricted to adults — currently left open both ways)
- Refund and consumer-protection requirements (statutory withdrawal/cooling-off rights, auto-renewal statutes, mandatory refund obligations, chargeback rights)
- Legally required user rights and product capabilities (formally-defined data-subject rights beyond what's already implemented)
- Acceptable-use enforceability (whether the conduct rules are enforceable as drafted, including reverse-engineering carve-outs and third-party-platform rules)
- Fair Use Policy incorporation/precedence relative to the Terms of Service (which document controls in a conflict — currently neither is stated to control)
- Suspension/termination process (grounds, notice, and user rights on termination — not drafted)
- Governing law/dispute resolution (no jurisdiction or dispute mechanism has been asserted, including no assumption that Georgia law applies)
- Warranty disclaimers and limitation of liability (deliberately left undrafted rather than filled with generic SaaS boilerplate)
- Cookie/ePrivacy implications of local storage (whether local-storage-only use triggers cookie-law-style obligations independent of literal cookie use)

**Do not resolve any of these questions in this codebase.** They require attorney judgment.

## 5. Business Positions Already Made

These are business-decided policy positions (not legal conclusions), consistently reflected across the relevant documents:

- Subscription payments are generally non-refundable once paid, subject to applicable law; if CareerPersona AI caused a genuine billing or service problem, the business intends to investigate and provide an appropriate remedy where warranted.
- Users should contact the business first (info@sellatrend.com) about a billing or service problem, but this is a business preference, not a legal prerequisite — it does not require anyone to contact the business before disputing a charge, filing a chargeback, or exercising any right available under applicable law.
- Truthful resume/cover-letter tailoring and persuasive presentation of genuine experience is permitted and is a core intended use of the Service; fabricating credentials, degrees, certifications, employment history, qualifications, or another person's identity is prohibited.
- Interview/assessment preparation and practice are permitted and are a core intended use of the Service; using the Service as real-time assistance to generate or supply answers during an actual interview, assessment, examination, or proctored test is prohibited where inconsistent with the applicable rules of that interview/assessment/test.
- The age/minors position remains intentionally undecided — the documents state neither an 18+ restriction nor an absence of any age restriction — pending a business/legal decision.
- Canceling a subscription (including via account deletion) stops future renewal charges immediately but does not, by itself, refund amounts already paid; the canceled Stripe subscription is not automatically restored if deletion is later canceled.

## 6. Technical Facts Already Verified

- Supabase database project region: **us-west-2 (Oregon, USA)**, confirmed directly via `npx supabase projects list`.
- Cloudflare Workers and Cloudflare Pages operate on Cloudflare's global network and must not be described as located solely in us-west-2 — only the Supabase database/storage location is pinned to that region.
- Google Fonts is actively loaded by the application (browser requests font files directly from Google's servers) and is disclosed, consistently, in both the Privacy Policy (Section 5, subprocessor table) and the Cookie Policy (its own "What About Google Fonts?" section) — in both places described narrowly as a font-loading request, not as a cookie, advertising service, or tracking service.
- CareerPersona AI does not currently use cookies (verified across the codebase; wording in both the Privacy Policy and Cookie Policy uses "does not currently," left open to the technology changing in the future).
- Browser local storage is used for application functionality (session persistence and in-app preferences/unsaved work) — this is explicitly distinguished from cookies in both the Privacy Policy and Cookie Policy.

## 7. Important Implementation Rule

Future Claude Code sessions must not silently rewrite or "improve" the legal documents. Before changing any legal document:

1. Identify exactly which document and section is being changed.
2. Preserve already-approved business decisions (Section 5 of this file).
3. Do not invent legal conclusions — do not resolve an open `[LEGAL REVIEW REQUIRED]` item unilaterally.
4. Keep unresolved legal questions marked for attorney review.
5. Do not publish, commit, push, or deploy legal-document changes unless explicitly instructed to do so in that specific request.

## 8. Current Next Step

**NEXT STEP: Find qualified legal counsel and provide the five-document legal package plus the Lawyer Review Index (Section 4 of this file) for attorney review. Do not publish the legal documents or launch the app until counsel has reviewed them and the required changes have been implemented.**

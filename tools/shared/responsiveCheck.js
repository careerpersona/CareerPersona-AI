// Reusable responsive-overflow check, extracted from the
// noHorizontalOverflow() helper duplicated inside
// scripts/verify/verify-referral-intelligence-responsive.cjs. Existing
// scripts/verify/*.cjs files are not modified to use this (see
// Developer-Toolkit-Architecture.md's "existing scripts are not touched"
// rule) -- this is here so the *next* feature's responsive verification
// script can import it instead of re-copy-pasting the same one-line check.
//
// Takes a Playwright `page` -- callers own browser/context/navigation setup
// (mock session, routes, viewport), since that varies per feature and isn't
// something this shared helper should own.
export async function noHorizontalOverflow(page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
}

export const STANDARD_VIEWPORTS = [
  { name: "desktop", viewport: { width: 1400, height: 900 } },
  { name: "tablet", viewport: { width: 768, height: 1024 } },
  { name: "mobile-375", viewport: { width: 375, height: 812 } },
];

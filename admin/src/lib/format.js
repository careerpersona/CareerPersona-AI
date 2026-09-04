// Forced to UTC display -- these values (signup date, application date,
// profile-updated date) are calendar dates from the database, most stored
// as UTC midnight. Formatting in the viewer's local timezone would shift
// the displayed day backward for anyone west of UTC (e.g. "2026-08-01T00:00Z"
// rendering as "Jul 31" for a US-based support agent), which is misleading
// for a date meant to read as a specific day, not a precise moment.
export function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
  } catch {
    return "—";
  }
}

export function formatDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "—";
  }
}

// Stripe amounts are always integer minor units (cents for usd) -- amount/100
// with the currency's own symbol via Intl, not a hardcoded "$".
export function formatMoney(amountMinorUnits, currency) {
  if (amountMinorUnits == null || !currency) return "—";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency.toUpperCase() }).format(amountMinorUnits / 100);
  } catch {
    return `${(amountMinorUnits / 100).toFixed(2)} ${currency?.toUpperCase()}`;
  }
}

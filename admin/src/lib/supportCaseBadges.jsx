import { MUTED, TEXT, DANGER, WARNING, SUCCESS, ACCENT } from "./theme.js";

// Status/priority badges shared between SupportCaseListPage and
// SupportCaseDetailPage. Split out from SupportCaseListPage.jsx (where they
// originally lived) because a component file exporting non-component
// constants breaks Fast Refresh -- same reason lib/ui.jsx exists as its own
// file rather than living inside CustomerDetailPage.jsx.

export const STATUS_COLOR = { open: WARNING, in_progress: ACCENT, resolved: SUCCESS };
export const PRIORITY_COLOR = { low: MUTED, normal: TEXT, high: WARNING, urgent: DANGER };

export function StatusBadge({ status }) {
  const color = STATUS_COLOR[status] || MUTED;
  return <span style={{ fontSize: 11, fontWeight: 700, color, background: `${color}20`, borderRadius: 999, padding: "3px 9px", textTransform: "capitalize" }}>{status.replace("_", " ")}</span>;
}

export function PriorityBadge({ priority }) {
  const color = PRIORITY_COLOR[priority] || MUTED;
  return <span style={{ fontSize: 11, fontWeight: 700, color, textTransform: "capitalize" }}>{priority}</span>;
}

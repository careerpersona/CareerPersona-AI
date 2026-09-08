// RTL support, Stage 2 building block (see the RTL architecture audit in
// project memory). Once dir="rtl" is set for Arabic (Stage 1), known-Latin-
// script content embedded inside RTL paragraphs -- emails, URLs, job titles,
// company names, brand names, user-entered Latin text -- needs to be
// isolated so the Unicode bidi algorithm doesn't visually reorder it based
// on the surrounding Arabic context. <bdi dir="ltr"> is the standard native
// mechanism for this: it isolates its contents from the surrounding
// bidirectional context while forcing a known direction, rather than
// leaving direction to content-based auto-detection (which real-world
// emails/URLs can confuse).
//
// This component only provides the mechanism -- wiring it into the actual
// render points (job titles, company names, etc.) is later-stage work, not
// done as part of adding this utility.
export default function LatinText({ children, style, ...rest }) {
  return (
    <bdi dir="ltr" style={{ unicodeBidi: "isolate", ...style }} {...rest}>
      {children}
    </bdi>
  );
}

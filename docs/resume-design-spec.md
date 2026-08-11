# CareerPersona AI — Master Resume Design Specification
**Version 1.0 — Locked Design**
**Source of truth: `/QA/Resume Review/` master template image**

---

## 0. Governing Rules

1. This document describes the **only** approved visual layout for all CareerPersona AI resumes.
2. Every renderer (Browser Preview, PDF, DOCX) must match this specification exactly.
3. **Content is dynamic. Layout is fixed.**
4. Sections whose data does not exist for a user are **hidden entirely** — no empty headings, no placeholder text.
5. No renderer may invent spacing, colors, or typographic choices not listed here.

---

## 1. Color Palette (fixed — never changes)

| Token | Hex | Usage |
|---|---|---|
| `accent` | `#6B21E8` | Name, section titles, section icons, company names, icon circles, timeline line & dot, bullet dots, link underlines |
| `accentBg` | `#F3EEFF` | Header background, section bar background |
| `darkGray` | `#1F2937` | Role titles, degree names, project names, body headings |
| `bodyText` | `#374151` | Body paragraphs, skills text, bullet text |
| `dateText` | `#4B5563` | Dates, locations, secondary metadata |
| `white` | `#FFFFFF` | Page/card background |
| `separator` | `#DDD6FE` | Thin dashed lines between experience entries |

---

## 2. Page / Canvas Layout (fixed)

| Property | Value |
|---|---|
| Page width | Full container width (browser) / Letter 8.5 × 11 in (PDF/DOCX) |
| Left margin | ~8 mm (PDF), ~0.5 in (DOCX), ~24 px (browser) |
| Right margin | Same as left |
| Top margin | 0 (header fills to top edge) |
| Bottom margin | ~14 mm (PDF) / ~0.5 in (DOCX) |

---

## 3. Header (fixed structure, dynamic content)

### 3.1 Container
- Background: `accentBg` (`#F3EEFF`)
- Spans the **full page width** — edge to edge, no side margins
- Contains three rows stacked vertically and centered horizontally

### 3.2 Row 1 — Name
| Property | Value |
|---|---|
| Text | User's full name |
| Case | UPPERCASE |
| Font weight | Bold (700) |
| Font size | ~28–32 pt (browser ~32 px) |
| Color | `accent` (`#6B21E8`) |
| Alignment | Centered |
| Top padding | ~14 px above first baseline |

### 3.3 Row 2 — Job Title
| Property | Value |
|---|---|
| Text | User's current or target job title |
| Font weight | Regular (400) |
| Font size | ~13–14 pt |
| Color | `darkGray` (`#1F2937`) |
| Alignment | Centered |
| Spacing | ~6 px below name baseline |

### 3.4 Row 3 — Contact Row
| Property | Value |
|---|---|
| Layout | Single horizontal row, centered |
| Spacing | ~16–20 px gap between each item |
| Bottom padding | ~10–12 px below last baseline |

Each contact item is a pair: **[icon] [text]**

| Contact Field | Icon | Behavior |
|---|---|---|
| Location | Pin / map-marker icon | Always show if present |
| Email | Envelope icon | Always show if present; underlined with `accent` |
| Phone | Phone icon | Always show if present; underlined with `accent` |
| LinkedIn | LinkedIn "in" logo | Show only if user has LinkedIn URL |
| GitHub | GitHub octocat icon | Show only if user has GitHub URL |
| Portfolio | Globe icon | Show only if user has portfolio URL |

- Icon color: `accent`
- Text color: `bodyText`
- Links (email, LinkedIn, GitHub, portfolio): underlined in `accent` color
- Phone: underlined in `accent` color
- Location: underlined in `accent` color
- Icon size: ~14 px, vertically centered with text
- Text size: ~11–12 pt

**Dynamic rule:** Omit any contact field not present in user data. The remaining items re-flow to stay centered.

---

## 4. Section Bars (fixed structure)

Every section begins with a full-width bar containing:

### 4.1 Bar Container
- Background: `accentBg` (`#F3EEFF`)
- Full page width (edge to edge)
- Height: ~36–40 px (browser), ~9–10 mm (PDF)
- Vertical rhythm: text + icon vertically centered in bar

### 4.2 Left — Section Icon
- Shape: circle, outline style
- Circle border color: `accent`
- Icon inside circle: unique SVG icon per section (see §4.4)
- Icon color: `accent`
- Circle diameter: ~22–24 px
- Left position: aligned to the left content margin

### 4.3 Right of Icon — Section Title
- Text: section name (see §4.4)
- Case: UPPERCASE
- Font weight: Bold (700)
- Font size: ~11–12 pt
- Color: `accent`
- Left gap from icon: ~8 px
- Vertical alignment: centered with icon

### 4.4 Section Registry (fixed — one row per section)

| Section | Icon | Title Text | Optional? |
|---|---|---|---|
| Professional Summary | Person / profile silhouette | PROFESSIONAL SUMMARY | No (always shown if content exists) |
| Experience | Briefcase | EXPERIENCE | No |
| Education | Graduation cap | EDUCATION | No |
| Skills | Code brackets `</>` | SKILLS | No |
| Certifications | Award ribbon | CERTIFICATIONS (OPTIONAL) | Yes |
| Projects | Folder | PROJECTS (OPTIONAL) | Yes |
| Languages | Globe | LANGUAGES (OPTIONAL) | Yes |

**Dynamic rule:** If a section has no data, the entire section bar AND its content are hidden.

---

## 5. Professional Summary Section

### 5.1 Content Area
- Background: `white`
- Top padding from bar: ~10 px
- Bottom padding before next section bar: ~14 px

### 5.2 Paragraph Text
| Property | Value |
|---|---|
| Font weight | Regular (400) |
| Font size | ~11–12 pt |
| Color | `bodyText` (`#374151`) |
| Alignment | Left |
| Line height | ~1.5 |
| Left indent | Aligned to content margin (same as all body text) |

---

## 6. Experience Section

### 6.1 Timeline
Each experience entry is anchored to a **left timeline**:

| Element | Spec |
|---|---|
| Vertical line | 2 px wide, color `accent`, runs the full height of the entry's bullet list |
| Entry dot | Filled circle, ~8–10 px diameter, color `accent`, positioned at the top-left of the entry, on the timeline line |
| Left offset | Timeline positioned at the content margin; bullet text indented ~16 px right of the timeline line |

### 6.2 Entry Header Row
One horizontal row containing:

**Left side (fills remaining width):**
- `[Role Title]` — bold (`700`), `darkGray`, ~12–13 pt
- ` | ` — plain separator, `bodyText`, regular weight
- `[Company Name]` — italic (`italic`), `accent` color, ~12–13 pt

**Right side (right-aligned block, no wrap):**
- Line 1: Date range (e.g. `Jan 2022 – Present`) — regular, `dateText`, ~11 pt
- Line 2: Location (e.g. `Atlanta, GA`) — regular, `dateText`, ~11 pt, right-aligned below date

### 6.3 Bullet Points
- Indented under the entry, to the right of the timeline line
- Bullet character: filled round dot (`•`), color `accent`
- Bullet text: regular weight, `bodyText`, ~11–12 pt
- Left alignment: consistent indent ~16 px right of timeline
- Vertical spacing between bullets: ~4–5 px

### 6.4 Separator Between Entries
- A thin horizontal dashed line, color `separator` (`#DDD6FE`)
- Width: full content width
- Appears **between** entries, not after the last one

### 6.5 Dynamic Rules
- Show as many entries as the user has
- Entries appear in reverse-chronological order (most recent first)
- If no experience data exists, hide the entire Experience section

---

## 7. Education Section

### 7.1 Entry Layout
One horizontal row:

**Left side:**
- `[Degree Name]` — bold (`700`), `darkGray`, ~12–13 pt

**Right side (right-aligned block):**
- Line 1: Graduation date (e.g. `May 2017`) — regular, `dateText`, ~11 pt
- Line 2: Location (e.g. `Atlanta, GA`) — regular, `dateText`, ~11 pt

Below the degree row:
- `[Institution Name]` — italic (`italic`), `accent` color, ~11–12 pt, left-aligned

### 7.2 Dynamic Rules
- Show as many degrees as the user has
- If no education data, hide entire section

---

## 8. Skills Section

### 8.1 Layout
- Single horizontal line (or wrapping lines) of skills
- Skills separated by ` | ` (space, pipe, space)
- Example: `JavaScript | TypeScript | React | Node.js | Python | AWS`

### 8.2 Typography
| Property | Value |
|---|---|
| Font weight | Regular (400) |
| Font size | ~11–12 pt |
| Color | `bodyText` (`#374151`) |
| Alignment | Left |

### 8.3 Dynamic Rules
- Show all skills the user provides
- If no skills, hide entire section

---

## 9. Certifications Section (Optional)

### 9.1 Layout
- Bullet list, one certification per line
- Bullet character: `•`, color `accent`

### 9.2 Typography
| Property | Value |
|---|---|
| Text | Certification name (e.g. `AWS Certified Solutions Architect – Associate`) |
| Font weight | Regular (400) |
| Font size | ~11–12 pt |
| Color | `bodyText` |

### 9.3 Dynamic Rules
- Show only if user has certifications
- If no certifications, hide entire section (bar + content)

---

## 10. Projects Section (Optional)

### 10.1 Entry Layout
One horizontal row:

**Left side:**
- `[Project Name]` — bold (`700`), `darkGray`, ~12 pt

**Right side:**
- Year (e.g. `2024`) — regular, `dateText`, ~11 pt, right-aligned

Below project name:
- Bullet list of project highlights — same spec as Experience bullets

### 10.2 Dynamic Rules
- Show only if user has projects
- If no projects, hide entire section

---

## 11. Languages Section (Optional)

### 11.1 Layout
- Single line (or wrapping), items separated by ` | `
- Each item: `Language (Proficiency Level)`
- Example: `English (Native) | Spanish (Conversational) | Turkish (Basic)`

### 11.2 Typography
| Property | Value |
|---|---|
| Font weight | Regular (400) |
| Font size | ~11–12 pt |
| Color | `bodyText` |

### 11.3 Dynamic Rules
- Show only if user has language data
- If no languages, hide entire section

---

## 12. Vertical Spacing (fixed rhythm)

| Between | Spacing |
|---|---|
| Header bottom edge → first section bar | 0 (section bar starts immediately) |
| Section bar bottom → section content top | ~10–12 px |
| Section content bottom → next section bar | ~0 (bars are flush, no gap between sections) |
| Experience entry header → first bullet | ~6 px |
| Between bullets | ~4 px |
| Last bullet → separator line | ~10 px |
| Separator line → next entry header | ~10 px |

---

## 13. Typography Summary (fixed)

| Element | Weight | Size | Color |
|---|---|---|---|
| Name | Bold 700 | 28–32 pt | `#6B21E8` |
| Job Title | Regular 400 | 13–14 pt | `#1F2937` |
| Contact text | Regular 400 | 11–12 pt | `#374151` |
| Section title | Bold 700 | 11–12 pt | `#6B21E8` |
| Role / Degree / Project name | Bold 700 | 12–13 pt | `#1F2937` |
| Company / Institution | Italic 400 | 12–13 pt | `#6B21E8` |
| Date / Location | Regular 400 | 11 pt | `#4B5563` |
| Body paragraph | Regular 400 | 11–12 pt | `#374151` |
| Bullet text | Regular 400 | 11–12 pt | `#374151` |
| Skills / Languages | Regular 400 | 11–12 pt | `#374151` |

Font family: **Calibri** (DOCX), **Helvetica/Arial** (PDF), **system-ui / sans-serif** (browser).

---

## 14. Fixed vs Dynamic Element Checklist

### Fixed (never changes)
- [ ] Color palette (all 7 tokens above)
- [ ] Header background color and edge-to-edge span
- [ ] Name: uppercase, bold, purple, centered
- [ ] Job title: regular, dark gray, centered
- [ ] Contact row layout: icon + text pairs, horizontally centered
- [ ] Section bar: full-width, accentBg, circle icon + uppercase title
- [ ] Section icon per section (see §4.4 registry)
- [ ] Experience timeline: left vertical line + entry dot
- [ ] Role/Company on same row with ` | ` separator
- [ ] Date/Location as a two-line right-aligned block
- [ ] Separator dashes between experience entries
- [ ] Education degree/institution/date/location layout
- [ ] Skills as pipe-separated inline text
- [ ] Bullet style: round filled dot, accent color
- [ ] All spacing values in §12
- [ ] All typography values in §13

### Dynamic (changes per user)
- [ ] Full name
- [ ] Job title
- [ ] Which contact fields appear (only those with data)
- [ ] Contact field values (email address, phone number, URLs, location)
- [ ] Number of experience entries
- [ ] Each entry's role, company, date range, location, bullets
- [ ] Number of education entries
- [ ] Each degree's name, institution, date, location
- [ ] Skills list (any length)
- [ ] Whether Certifications section appears and its items
- [ ] Whether Projects section appears, each project name, year, bullets
- [ ] Whether Languages section appears and its items
- [ ] Section visibility (entire section hidden if no data)

---

## 15. Section Order (fixed)

Sections always appear in this sequence. Optional sections are skipped if empty.

1. Header (always)
2. Professional Summary (always if content exists)
3. Experience (always if content exists)
4. Education (always if content exists)
5. Skills (always if content exists)
6. Certifications (optional)
7. Projects (optional)
8. Languages (optional)

---

*Document status: LOCKED — implemented. This spec's palette and layout are live in the Browser Preview, PDF, and DOCX renderers.*

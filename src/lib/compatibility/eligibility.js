// Eligibility Engine -- structural pass/fail gates, kept strictly separate
// from the weighted Compatibility score (a gate failure never becomes a
// weighted score component). Pure function, no I/O.
//
// Structured as a registry so future gates (visa sponsorship, security
// clearance, licensing, citizenship) are additions -- one new { id, evaluate }
// entry appended to DEFAULT_GATES -- never a change to evaluateEligibility
// itself or its callers.
//
// Employment Type (Full-time/Part-time/Contract/etc.) is deliberately NOT a
// gate here, and is also absent from compatibility.js's weighted components.
// Two reasons: (1) there is no persisted candidate-side preference for it --
// only profile_details.work_type (Remote/Hybrid/On-site, used by the gate
// below) and JobSearchPage's filters.employmentType, which is a per-search
// UI filter, not a stored profile field. (2) that per-search filter already
// gets sent to both job APIs (worker.js: EMP_TYPE_MAP for Adzuna,
// employment_types for JSearch) and constrains which jobs come back before
// the engine ever sees them -- so a gate here would either duplicate
// filtering that already happened upstream, or have nothing to evaluate
// against when the filter is left on "Any". Adding a persisted preference to
// gate against generally would mean collecting a new profile field, which is
// new data collection, not something this refactor introduced.

export const DEFAULT_GATES = [
  {
    id: "remote_onsite_requirement",
    label: "Remote work requirement",
    evaluate: ({ job, profile }) => {
      // Only a strict "Remote" preference is treated as a hard requirement --
      // "Hybrid"/"On-site"/unset are not gated, since those aren't exclusive
      // requirements the way "I only want Remote" is.
      if (profile?.work_type !== "Remote") return { passed: true, reason: "" };
      return job?.remote
        ? { passed: true, reason: "" }
        : { passed: false, reason: "This role is not remote; your profile requires Remote." };
    },
  },
];

export function evaluateEligibility({ job, profile }, gates = DEFAULT_GATES) {
  const results = gates.map(g => {
    const { passed, reason } = g.evaluate({ job, profile });
    return { id: g.id, label: g.label, passed, reason: reason || "" };
  });
  return { gates: results, passed: results.every(r => r.passed) };
}

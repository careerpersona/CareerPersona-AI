// Shared exit-code convention across every tool in tools/. A TOOL_ERROR (bad
// config, missing file) is deliberately distinct from FAIL (a real finding),
// so a broken config can never silently read as "clean" via a 0 exit code,
// and can never be confused with a genuine regression via a 1 exit code.
export const PASS = 0;
export const FAIL = 1;
export const TOOL_ERROR = 2;

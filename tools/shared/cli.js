// Minimal shared flag parser -- no dependency, matches this project's convention
// of plain Node scripts with no external CLI framework. Supports --flag=value
// and bare --flag (boolean true). Everything else is ignored, not errored on,
// so each tool can define its own additional flags freely.
export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const eq = raw.indexOf("=");
    if (eq === -1) args[raw.slice(2)] = true;
    else args[raw.slice(2, eq)] = raw.slice(eq + 1);
  }
  return {
    format: args.format || "console",
    out: args.out || null,
    feature: args.feature || null,
    strict: args.strict === true || args.strict === "true",
    ...args,
  };
}

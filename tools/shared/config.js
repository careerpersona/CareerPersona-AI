import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

export class ConfigError extends Error {}

// Loads a JSON config file relative to the repo root (e.g. "tools/config/regression-suites.json").
// Throws ConfigError (not a plain Error) so callers can distinguish "bad config"
// (TOOL_ERROR) from any other failure mode.
export function loadConfig(relativePath) {
  const fullPath = path.join(REPO_ROOT, relativePath);
  let raw;
  try {
    raw = readFileSync(fullPath, "utf8");
  } catch {
    throw new ConfigError(`Config file not found: ${relativePath} (resolved to ${fullPath})`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(`Config file is not valid JSON: ${relativePath} (${e.message})`);
  }
}

export function toRepoRelative(absolutePath) {
  return path.relative(REPO_ROOT, absolutePath).split(path.sep).join("/");
}

/**
 * Every tunable in one place, read from the environment once at startup.
 *
 * Values are validated and clamped rather than trusted: a typo in .env should
 * produce a sane default and a warning, not a crash halfway through a run.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.join(HERE, "..");

const warnings = [];

// Load .env if there is one, using Node's built-in loader (20.12+) rather than
// taking a dotenv dependency. Real environment variables still win.
try {
  process.loadEnvFile?.(path.join(PROJECT_ROOT, ".env"));
} catch {
  // No .env file - defaults below apply.
}

function readInt(name, fallback, { min, max }) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) {
    warnings.push(`${name}="${raw}" is not a number - using ${fallback}.`);
    return fallback;
  }
  if (value < min || value > max) {
    const clamped = Math.min(Math.max(value, min), max);
    warnings.push(`${name}=${value} is outside ${min}-${max} - using ${clamped}.`);
    return clamped;
  }
  return value;
}

function readBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  warnings.push(`${name}="${raw}" is not a boolean - using ${fallback}.`);
  return fallback;
}

// HEADED=1 is the friendlier spelling of HEADLESS=false; either works.
const headless = process.env.HEADED ? !readBool("HEADED", false) : readBool("HEADLESS", true);

// The pause between actions is the main thing keeping this polite. It stays
// configurable, but not down to zero - a floor of 1s is enforced deliberately.
const PAUSE_FLOOR_MS = 1000;
const pauseMin = readInt("PAUSE_MIN_MS", 2000, { min: PAUSE_FLOOR_MS, max: 60_000 });
const pauseMax = readInt("PAUSE_MAX_MS", 5000, { min: PAUSE_FLOOR_MS, max: 120_000 });

if (pauseMax < pauseMin) {
  warnings.push(`PAUSE_MAX_MS (${pauseMax}) is below PAUSE_MIN_MS (${pauseMin}) - swapping them.`);
}

const maxResults = readInt("MAX_RESULTS", 40, { min: 1, max: 200 });
if (maxResults > 60) {
  warnings.push(`MAX_RESULTS=${maxResults} is a large run; expect it to take a while and raise your block risk.`);
}

export const config = Object.freeze({
  host: process.env.HOST || "127.0.0.1",
  port: readInt("PORT", 5000, { min: 1, max: 65_535 }),

  headless,
  // Persisting the browser profile lets a one-time consent click survive into
  // later headless runs. Set to "" to use a throwaway profile each time.
  userDataDir:
    process.env.USER_DATA_DIR === ""
      ? ""
      : path.resolve(PROJECT_ROOT, process.env.USER_DATA_DIR || ".browser-profile"),

  maxResults,
  maxScrolls: readInt("MAX_SCROLLS", 10, { min: 1, max: 30 }),
  // How long to keep watching for a lazy-loaded batch after a scroll before
  // calling the feed exhausted. The old fixed 2-strike rule gave up on slow
  // connections while Google was still loading.
  scrollSettleMs: readInt("SCROLL_SETTLE_MS", 8000, { min: 1000, max: 60_000 }),
  scrollStrikes: readInt("SCROLL_STRIKES", 3, { min: 1, max: 10 }),
  pauseMinMs: Math.min(pauseMin, pauseMax),
  pauseMaxMs: Math.max(pauseMin, pauseMax),
  navigationTimeoutMs: readInt("NAVIGATION_TIMEOUT_MS", 60_000, { min: 5_000, max: 180_000 }),
  detailTimeoutMs: readInt("DETAIL_TIMEOUT_MS", 15_000, { min: 2_000, max: 60_000 }),

  lookupEmails: readBool("LOOKUP_EMAILS", true),
  emailTimeoutMs: readInt("EMAIL_TIMEOUT_MS", 10_000, { min: 1_000, max: 60_000 }),
  // Ceiling on a fetched page body. We only need the first chunk of markup,
  // and an unbounded read lets one hostile response exhaust memory.
  maxPageBytes: readInt("MAX_PAGE_BYTES", 2_000_000, { min: 10_000, max: 50_000_000 }),
  respectRobots: readBool("RESPECT_ROBOTS", true),

  runsDir: path.resolve(PROJECT_ROOT, process.env.RUNS_DIR || "runs"),
  logLevel: (process.env.LOG_LEVEL || "info").toLowerCase(),
});

export const configWarnings = Object.freeze(warnings);

/** A one-line summary for the startup banner. */
export function describeConfig() {
  return [
    `mode=${config.headless ? "headless" : "headed"}`,
    `cap=${config.maxResults}`,
    `pause=${config.pauseMinMs}-${config.pauseMaxMs}ms`,
    `emails=${config.lookupEmails ? "on" : "off"}`,
    `robots=${config.respectRobots ? "respected" : "IGNORED"}`,
  ].join("  ");
}

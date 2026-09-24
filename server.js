/**
 * Express front end for the lead finder.
 *
 * A search runs in the background so the page can show listings as they are
 * found; the browser polls /status/:jobId. CSV export happens in the browser,
 * so what you download is exactly what the table is showing.
 */

import express from "express";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseAreas } from "./src/areas.js";
import { CATEGORIES } from "./src/categories.js";
import { config, configWarnings, describeConfig } from "./src/config.js";
import { SiteFetcher } from "./src/emails.js";
import { log } from "./src/logger.js";
import { BlockedError, ConsentRequired, closeActiveBrowser, identityKey, scrape } from "./src/maps.js";
import { createShutdown } from "./src/shutdown.js";
import { createRunsReader } from "./src/runs.js";
import { createJob, getJob, RUNS_DIR } from "./src/store.js";
import { hasMailExchanger } from "./src/verify.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STARTED_AT = Date.now();


const app = express();
app.use(express.json());
app.use(express.static(path.join(HERE, "public")));

// Etiquette rule: one browser session at a time. Two concurrent searches would
// mean two Chromium instances hammering Google in parallel, so a second search is
// refused rather than queued.
let searchInFlight = false;
let activeJob = null;

/** The whole pipeline for one search: Maps pass over each area, then emails. */
async function runSearch(job) {
  await job.writeMeta();
  const areas = parseAreas(job.city);
  // One business can appear in two neighbouring areas; keep the first sighting.
  const seen = new Set();

  try {
    for (const [index, area] of areas.entries()) {
      if (job.stopRequested) break;
      const prefix = areas.length > 1 ? `[${index + 1}/${areas.length}] ${area}: ` : "";

      await scrape(job.category, area, {
        limit: config.maxResults,
        onlyWithWebsite: job.onlyWithWebsite,
        onResult: (row) => {
          const key = identityKey(row);
          if (seen.has(key)) {
            log.debug("skipping duplicate across areas", { name: row.name });
            return undefined;
          }
          seen.add(key);
          return job.addResult(row);
        },
        onStatus: (message, options) => job.setStatus(prefix + message, options),
        shouldStop: () => job.stopRequested,
      });
    }
  } catch (error) {
    if (error instanceof BlockedError) {
      job.setStatus(
        `${error.message} Stopped - nothing was retried or bypassed. ` +
          "Try again later, or with a smaller search.",
        { state: "blocked", needsAttention: true },
      );
      return;
    }
    if (error instanceof ConsentRequired) {
      job.setStatus(error.message, { state: "error", needsAttention: true });
      return;
    }
    log.error("search failed", { job: job.id, error: error.stack ?? error.message });
    job.setStatus(`Search failed: ${error.message}`, { state: "error", needsAttention: true });
    return;
  }

  if (job.lookupEmails && !job.stopRequested) {
    job.phase = "emails";
    await lookupEmails(job);
  }
  job.phase = "finished";
  await job.writeMeta();

  if (job.stopRequested) {
    job.setStatus(`Stopped. ${job.results.length} businesses kept.`, { state: "stopped" });
  } else {
    const withEmail = job.results.filter((row) => row.email).length;
    const across = areas.length > 1 ? ` across ${areas.length} areas` : "";
    job.setStatus(
      `Done. ${job.results.length} businesses${across}, ${withEmail} with an email address.`,
      { state: "done" },
    );
  }
}

/**
 * Second pass: visit each business's own site.
 *
 * One request per site answers three questions at once - is there a contact
 * address, what shape is the site in, and can that address receive mail.
 */
async function lookupEmails(job) {
  const fetcher = new SiteFetcher();
  const targets = job.results
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.website && !row.email);

  for (const [position, { row, index }] of targets.entries()) {
    if (job.stopRequested) return;

    let host = row.website;
    try {
      host = new URL(row.website).hostname || row.website;
    } catch {
      /* keep the raw string in the status line */
    }
    job.setStatus(`Checking ${host} (${position + 1}/${targets.length})...`);

    try {
      const { email, source, analysis } = await fetcher.inspect(row.website);
      const changes = {};

      if (analysis) {
        changes.score = analysis.score;
        changes.signals = analysis.signals;
        changes.site_builder = analysis.builder ?? "";
      }
      if (email) {
        changes.email = email;
        changes.email_source = source ?? "";
        changes.email_verified = await hasMailExchanger(email);
      }
      if (Object.keys(changes).length) await job.updateResult(index, changes);
    } catch (error) {
      log.debug("site inspection failed", { website: row.website, error: error.message });
    }
  }
}

/* -------------------------------- routes --------------------------------- */

app.get("/api/config", (_request, response) => {
  response.json({
    categories: CATEGORIES,
    maxResults: config.maxResults,
    headless: config.headless,
    lookupEmails: config.lookupEmails,
  });
});

/** Liveness probe for Docker / a process supervisor. */
app.get("/healthz", (_request, response) => {
  response.json({
    status: "ok",
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 1000),
    searchInFlight,
    headless: config.headless,
  });
});

app.post("/search", (request, response) => {
  const city = String(request.body?.city ?? "").trim();
  const category = String(request.body?.category ?? "").trim();
  if (!city || !category) {
    return response.status(400).json({ error: "Pick a category and type a city." });
  }

  if (searchInFlight) {
    return response.status(409).json({ error: "A search is already running. Let it finish, or press Stop." });
  }
  searchInFlight = true;

  const job = createJob({
    city,
    category,
    onlyWithWebsite: request.body?.only_with_website !== false,
    lookupEmails: request.body?.lookup_emails !== false,
  });

  // Deliberately not awaited: the request returns immediately and the browser
  // follows progress through /status/:jobId.
  activeJob = job;
  runSearch(job).finally(() => {
    searchInFlight = false;
    activeJob = null;
  });

  return response.json({ job_id: job.id });
});

const runsReader = createRunsReader({ runsDir: RUNS_DIR, readdir, readFile, stat });

/** Past runs, newest first. Paginated; see src/runs.js for why that matters. */
app.get("/api/runs", async (request, response) => {
  try {
    response.json(await runsReader.list(request.query));
  } catch (error) {
    log.error("could not list runs", { error: error.message });
    response.status(500).json({ error: "Could not read the runs directory." });
  }
});

/** The rows of one past run. */
app.get("/api/runs/:id", async (request, response) => {
  if (!/^[a-f0-9]{6,32}$/i.test(request.params.id)) {
    return response.status(400).json({ error: "Bad run id." });
  }
  try {
    const body = await readFile(path.join(RUNS_DIR, `${request.params.id}.jsonl`), "utf8");
    const results = body.split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return response.json({ id: request.params.id, count: results.length, results });
  } catch {
    return response.status(404).json({ error: "No such run." });
  }
});


app.get("/status/:jobId", (request, response) => {
  const job = getJob(request.params.jobId);
  if (!job) return response.status(404).json({ error: "Unknown job." });
  return response.json(job.snapshot());
});

app.post("/stop/:jobId", (request, response) => {
  const job = getJob(request.params.jobId);
  if (!job) return response.status(404).json({ error: "Unknown job." });
  job.requestStop();
  return response.json({ ok: true });
});

// Anything the routes throw lands here as JSON, not an HTML stack trace.
app.use((error, _request, response, _next) => {
  log.error("unhandled request error", { error: error.stack ?? error.message });
  response.status(500).json({ error: "Something went wrong. Check the server log." });
});

for (const warning of configWarnings) log.warn(warning);

const server = app.listen(config.port, config.host, () => {
  log.info(`Lead Finder on http://${config.host}:${config.port}  ${describeConfig()}`);
  if (config.headless) log.info("Running headless - no browser window will open. Use HEADED=1 to watch it.");
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    log.error(
      `Port ${config.port} is already in use. Stop the other process, or set a different port: PORT=5001 npm start`,
    );
    process.exit(1);
  }
  throw error;
});

const shutdown = createShutdown({
  closeServer: () => new Promise((resolve) => server.close(() => resolve())),
  getActiveJob: () => activeJob,
  closeBrowser: closeActiveBrowser,
  exit: (code) => process.exit(code),
  log,
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { shutdown(signal); });
}

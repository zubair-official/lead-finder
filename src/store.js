/**
 * Job registry for search runs.
 *
 * One job per search. Every result is appended to runs/<jobId>.jsonl the moment
 * it is scraped, so stopping a run mid-way never loses what was already found.
 *
 * Node runs this on one thread, so unlike the locking a threaded server needs,
 * nothing here can be interrupted mid-update.
 */

import { randomBytes } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { config } from "./config.js";

export const RUNS_DIR = config.runsDir;

/** state: running | done | stopped | blocked | error | interrupted
 *  "blocked" is reserved for Google refusing us (CAPTCHA / unusual traffic);
 *  "interrupted" means the server stopped while the run was still going. */
export class Job {
  constructor({ city, category, onlyWithWebsite, lookupEmails }) {
    this.id = randomBytes(6).toString("hex");
    this.city = city;
    this.category = category;
    this.onlyWithWebsite = onlyWithWebsite;
    this.lookupEmails = lookupEmails;

    this.state = "running";
    // maps -> emails -> finished. The UI shows a different empty-email cell
    // during the email pass ("not checked yet") than after it ("none found").
    this.phase = "maps";
    this.message = "Starting browser...";
    this.needsAttention = false;
    this.results = [];
    this.stopRequested = false;
    this.createdAt = new Date().toISOString();
  }

  get filePath() {
    return path.join(RUNS_DIR, `${this.id}.jsonl`);
  }

  get metaPath() {
    return path.join(RUNS_DIR, `${this.id}.meta.json`);
  }

  /**
   * The JSONL rows do not record what was searched for, so a small sidecar
   * file carries that. Written at the start and again at the end, not on every
   * row: if the process dies mid-run the row count is recoverable from the
   * .jsonl itself.
   */
  async writeMeta() {
    try {
      await mkdir(RUNS_DIR, { recursive: true });
      await writeFile(
        this.metaPath,
        JSON.stringify({
          id: this.id,
          city: this.city,
          category: this.category,
          state: this.state,
          count: this.results.length,
          withEmail: this.results.filter((row) => row.email).length,
          createdAt: this.createdAt,
        }, null, 2),
        "utf8",
      );
    } catch {
      // History is a convenience; never fail a run over it.
    }
  }

  /** Record one business and flush it to disk immediately. */
  async addResult(row) {
    this.results.push(row);
    await mkdir(RUNS_DIR, { recursive: true });
    await appendFile(this.filePath, `${JSON.stringify(row)}\n`, "utf8");
  }

  /** Patch an existing row (used when the email lookup fills one in later). */
  async updateResult(index, changes) {
    Object.assign(this.results[index], changes);
    await mkdir(RUNS_DIR, { recursive: true });
    const body = this.results.map((row) => JSON.stringify(row)).join("\n");
    await writeFile(this.filePath, body ? `${body}\n` : "", "utf8");
  }

  setStatus(message, { state, needsAttention = false } = {}) {
    this.message = message;
    this.needsAttention = needsAttention;
    if (state) this.state = state;
  }

  /**
   * Record that the server went away mid-run.
   *
   * Without this the sidecar keeps saying "running" forever, so an interrupted
   * run is indistinguishable from one still in progress in the history list.
   */
  async markInterrupted() {
    this.stopRequested = true;
    this.phase = "finished";
    this.setStatus(
      `Interrupted: the server stopped during this run. ${this.results.length} businesses were saved.`,
      { state: "interrupted" },
    );
    await this.writeMeta();
  }

  requestStop() {
    this.stopRequested = true;
    this.setStatus("Stopping after the current listing...");
  }

  snapshot() {
    return {
      id: this.id,
      state: this.state,
      phase: this.phase,
      message: this.message,
      needs_attention: this.needsAttention,
      city: this.city,
      category: this.category,
      count: this.results.length,
      results: this.results,
    };
  }
}

const jobs = new Map();

export function createJob(options) {
  const job = new Job(options);
  jobs.set(job.id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id) ?? null;
}

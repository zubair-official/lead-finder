import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { createShutdown } from "../src/shutdown.js";

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/** A job stub that records what the shutdown sequence asked it to do. */
function fakeJob() {
  const calls = [];
  return {
    id: "job123",
    calls,
    requestStop() { calls.push("requestStop"); },
    async markInterrupted() { calls.push("markInterrupted"); },
  };
}

function harness(overrides = {}) {
  const order = [];
  const exits = [];
  const deps = {
    closeServer: async () => { order.push("closeServer"); },
    getActiveJob: () => null,
    closeBrowser: async () => { order.push("closeBrowser"); return true; },
    exit: (code) => { exits.push(code); },
    log: silentLog,
    ...overrides,
  };
  return { shutdown: createShutdown(deps), order, exits };
}

describe("createShutdown", () => {
  it("closes the server and the browser, then exits cleanly", async () => {
    const { shutdown, order, exits } = harness();
    await shutdown("SIGTERM");
    assert.deepEqual(order, ["closeServer", "closeBrowser"]);
    assert.deepEqual(exits, [0]);
  });

  it("stops the running job before closing, and records it as interrupted", async () => {
    const job = fakeJob();
    const { shutdown, exits } = harness({ getActiveJob: () => job });
    await shutdown("SIGINT");
    assert.deepEqual(job.calls, ["requestStop", "markInterrupted"]);
    assert.deepEqual(exits, [0]);
  });

  it("asks the job to stop before the browser is closed", async () => {
    const order = [];
    const job = {
      id: "j",
      requestStop() { order.push("requestStop"); },
      async markInterrupted() { order.push("markInterrupted"); },
    };
    const { shutdown } = harness({
      getActiveJob: () => job,
      closeServer: async () => order.push("closeServer"),
      closeBrowser: async () => { order.push("closeBrowser"); return true; },
    });
    await shutdown("SIGTERM");
    assert.deepEqual(order, ["requestStop", "closeServer", "closeBrowser", "markInterrupted"]);
  });

  it("still exits when closing the browser throws", async () => {
    const job = fakeJob();
    const { shutdown, exits } = harness({
      getActiveJob: () => job,
      closeBrowser: async () => { throw new Error("chromium is wedged"); },
    });
    await shutdown("SIGTERM");
    assert.deepEqual(exits, [0]);
    // The run is still recorded even though the browser would not close.
    assert.ok(job.calls.includes("markInterrupted"));
  });

  it("still exits when the HTTP server will not close", async () => {
    const { shutdown, order, exits } = harness({
      closeServer: async () => { throw new Error("sockets still open"); },
    });
    await shutdown("SIGTERM");
    assert.deepEqual(order, ["closeBrowser"]);
    assert.deepEqual(exits, [0]);
  });

  it("does nothing when there is no job and no browser", async () => {
    const { shutdown, exits } = harness({ closeBrowser: async () => false });
    await shutdown("SIGTERM");
    assert.deepEqual(exits, [0]);
  });

  it("forces an immediate exit on a second signal", async () => {
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const { shutdown, exits } = harness({ closeServer: () => blocked });

    const first = shutdown("SIGINT");       // parks on closeServer
    await shutdown("SIGINT");               // impatient second Ctrl-C
    assert.deepEqual(exits, [1], "second signal should exit(1) straight away");

    release();
    await first;
    assert.deepEqual(exits, [1, 0]);
  });

  it("exits anyway if the sequence outlives the grace period", async () => {
    const { shutdown, exits } = harness({
      graceMs: 20,
      closeServer: () => new Promise((resolve) => setTimeout(resolve, 200)),
    });
    const running = shutdown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(exits, [1], "the deadline should have fired");
    await running;
  });
});

describe("Job.markInterrupted", () => {
  it("writes an interrupted state to the run's sidecar", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "lead-finder-test-"));
    try {
      process.env.RUNS_DIR = directory;
      // Imported after RUNS_DIR is set: config reads the environment on load.
      const { Job } = await import(`../src/store.js?runs=${encodeURIComponent(directory)}`);

      const job = new Job({ city: "Lahore", category: "cafe", onlyWithWebsite: true, lookupEmails: true });
      await job.addResult({ name: "A Cafe", address: "1 Road", email: "" });
      await job.markInterrupted();

      assert.equal(job.state, "interrupted");
      assert.equal(job.stopRequested, true);
      assert.equal(job.phase, "finished");

      const meta = JSON.parse(await readFile(job.metaPath, "utf8"));
      assert.equal(meta.state, "interrupted");
      assert.equal(meta.count, 1);

      // The row written before the interruption survives.
      const rows = (await readFile(job.filePath, "utf8")).split("\n").filter(Boolean);
      assert.equal(rows.length, 1);
      assert.equal(JSON.parse(rows[0]).name, "A Cafe");
    } finally {
      delete process.env.RUNS_DIR;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

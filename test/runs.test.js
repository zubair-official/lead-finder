import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  countRows,
  createRunsReader,
  metaIsFresh,
  parseRunsQuery,
} from "../src/runs.js";

describe("parseRunsQuery", () => {
  it("defaults when nothing is supplied", () => {
    assert.deepEqual(parseRunsQuery(), { limit: DEFAULT_LIMIT, offset: 0 });
    assert.deepEqual(parseRunsQuery({}), { limit: DEFAULT_LIMIT, offset: 0 });
  });

  it("accepts sensible values", () => {
    assert.deepEqual(parseRunsQuery({ limit: "10", offset: "20" }), { limit: 10, offset: 20 });
  });

  it("clamps a limit that would return everything", () => {
    assert.equal(parseRunsQuery({ limit: "100000" }).limit, MAX_LIMIT);
    assert.equal(parseRunsQuery({ limit: "0" }).limit, 1);
    assert.equal(parseRunsQuery({ limit: "-5" }).limit, 1);
  });

  it("refuses a negative offset", () => {
    assert.equal(parseRunsQuery({ offset: "-10" }).offset, 0);
  });

  it("falls back to defaults on junk", () => {
    assert.deepEqual(parseRunsQuery({ limit: "lots", offset: "soon" }), { limit: DEFAULT_LIMIT, offset: 0 });
  });
});

describe("countRows", () => {
  it("counts rows and those with an email", () => {
    const text = [
      JSON.stringify({ name: "A", email: "a@x.test" }),
      JSON.stringify({ name: "B", email: "" }),
      JSON.stringify({ name: "C", email: "c@x.test" }),
    ].join("\n");
    assert.deepEqual(countRows(text), { total: 3, withEmail: 2 });
  });

  it("ignores blank lines and a trailing newline", () => {
    assert.deepEqual(countRows(`${JSON.stringify({ email: "a@x.test" })}\n\n`), { total: 1, withEmail: 1 });
  });

  it("still counts a half-written final line", () => {
    // A run killed mid-append can leave a truncated row.
    const text = `${JSON.stringify({ email: "a@x.test" })}\n{"name":"B","ema`;
    assert.deepEqual(countRows(text), { total: 2, withEmail: 1 });
  });

  it("handles empty input", () => {
    assert.deepEqual(countRows(""), { total: 0, withEmail: 0 });
    assert.deepEqual(countRows(null), { total: 0, withEmail: 0 });
  });
});

describe("metaIsFresh", () => {
  it("trusts a sidecar written after its rows", () => {
    assert.equal(metaIsFresh(200, 100), true);
    assert.equal(metaIsFresh(100, 100), true);
  });

  it("distrusts a sidecar older than its rows", () => {
    assert.equal(metaIsFresh(100, 200), false);
  });

  it("distrusts a missing sidecar", () => {
    assert.equal(metaIsFresh(Number.NaN, 200), false);
    assert.equal(metaIsFresh(200, Number.NaN), false);
  });
});

/** An in-memory runs/ directory that records how often each file is read. */
function fakeDisk(files) {
  const reads = [];
  return {
    reads,
    readdir: async () => Object.keys(files),
    stat: async (file) => {
      const name = file.split(/[\\/]/).pop();
      if (!files[name]) throw new Error("ENOENT");
      return { mtimeMs: files[name].mtimeMs, size: files[name].body.length };
    },
    readFile: async (file) => {
      const name = file.split(/[\\/]/).pop();
      if (!files[name]) throw new Error("ENOENT");
      reads.push(name);
      return files[name].body;
    },
  };
}

const row = (email) => JSON.stringify({ name: "X", address: "Y", email });

describe("createRunsReader", () => {
  it("uses the sidecar's counts and never opens the rows", async () => {
    const disk = fakeDisk({
      "aaa.jsonl": { mtimeMs: 1000, body: [row("a@x.test"), row("")].join("\n") },
      "aaa.meta.json": {
        mtimeMs: 2000,
        body: JSON.stringify({ id: "aaa", city: "Lahore", category: "cafe", state: "done", count: 2, withEmail: 1, createdAt: "2026-09-01T00:00:00Z" }),
      },
    });
    const reader = createRunsReader({ runsDir: "/runs", ...disk });

    const { runs, total } = await reader.list();

    assert.equal(total, 1);
    assert.equal(runs[0].count, 2);
    assert.equal(runs[0].withEmail, 1);
    assert.equal(runs[0].city, "Lahore");
    assert.equal(runs[0].countsFrom, "meta");
    assert.ok(!disk.reads.includes("aaa.jsonl"), "the rows file should not have been read");
  });

  it("falls back to the rows when the sidecar is older than them", async () => {
    const disk = fakeDisk({
      "bbb.jsonl": { mtimeMs: 5000, body: [row("a@x.test"), row("b@x.test"), row("")].join("\n") },
      "bbb.meta.json": {
        mtimeMs: 1000, // written at the start of the run, before the rows
        body: JSON.stringify({ id: "bbb", city: "Multan", category: "restaurant", state: "running", count: 0, withEmail: 0, createdAt: "2026-09-02T00:00:00Z" }),
      },
    });
    const reader = createRunsReader({ runsDir: "/runs", ...disk });

    const { runs } = await reader.list();

    assert.equal(runs[0].count, 3, "should reflect the rows actually on disk, not the stale sidecar");
    assert.equal(runs[0].withEmail, 2);
    assert.equal(runs[0].countsFrom, "file");
  });

  it("lists a run that has no sidecar at all", async () => {
    const disk = fakeDisk({ "ccc.jsonl": { mtimeMs: 7000, body: [row("a@x.test")].join("\n") } });
    const reader = createRunsReader({ runsDir: "/runs", ...disk });

    const { runs } = await reader.list();

    assert.equal(runs[0].id, "ccc");
    assert.equal(runs[0].count, 1);
    assert.equal(runs[0].city, "");
    assert.equal(runs[0].state, "unknown");
    assert.ok(runs[0].createdAt, "should fall back to the file's timestamp");
  });

  it("caches a stale-sidecar count until the file changes", async () => {
    const files = {
      "ddd.jsonl": { mtimeMs: 5000, body: [row("a@x.test")].join("\n") },
    };
    const disk = fakeDisk(files);
    const reader = createRunsReader({ runsDir: "/runs", ...disk });

    await reader.list();
    await reader.list();
    assert.equal(disk.reads.filter((n) => n === "ddd.jsonl").length, 1, "second call should hit the cache");

    // A new row lands: mtime moves, so the cache key changes.
    files["ddd.jsonl"] = { mtimeMs: 6000, body: [row("a@x.test"), row("b@x.test")].join("\n") };
    const { runs } = await reader.list();
    assert.equal(runs[0].count, 2);
    assert.equal(disk.reads.filter((n) => n === "ddd.jsonl").length, 2, "a changed file should be re-read");
  });

  it("paginates, newest first, and reports the true total", async () => {
    const files = {};
    for (let i = 1; i <= 5; i += 1) {
      const id = `run${i}`;
      files[`${id}.jsonl`] = { mtimeMs: 1000 + i, body: row("a@x.test") };
      files[`${id}.meta.json`] = {
        mtimeMs: 9000,
        body: JSON.stringify({ id, city: `City${i}`, category: "cafe", state: "done", count: 1, withEmail: 1, createdAt: `2026-09-0${i}T00:00:00Z` }),
      };
    }
    const reader = createRunsReader({ runsDir: "/runs", ...fakeDisk(files) });

    const first = await reader.list({ limit: 2 });
    assert.equal(first.total, 5);
    assert.equal(first.runs.length, 2);
    assert.deepEqual(first.runs.map((r) => r.city), ["City5", "City4"], "newest first");

    const second = await reader.list({ limit: 2, offset: 2 });
    assert.deepEqual(second.runs.map((r) => r.city), ["City3", "City2"]);

    const tail = await reader.list({ limit: 2, offset: 4 });
    assert.deepEqual(tail.runs.map((r) => r.city), ["City1"]);
  });

  it("only reads rows for the page being returned", async () => {
    const files = {};
    for (let i = 1; i <= 6; i += 1) {
      // No sidecars, so every run would need its rows counted.
      files[`r${i}.jsonl`] = { mtimeMs: 1000 + i, body: row("a@x.test") };
    }
    const disk = fakeDisk(files);
    const reader = createRunsReader({ runsDir: "/runs", ...disk });

    await reader.list({ limit: 2 });

    assert.equal(disk.reads.length, 2, `read ${disk.reads.length} files for a 2-item page: ${disk.reads}`);
  });

  it("survives an empty or missing runs directory", async () => {
    const reader = createRunsReader({
      runsDir: "/runs",
      readdir: async () => { throw new Error("ENOENT"); },
      stat: async () => { throw new Error("ENOENT"); },
      readFile: async () => { throw new Error("ENOENT"); },
    });
    assert.deepEqual(await reader.list(), { runs: [], total: 0, limit: DEFAULT_LIMIT, offset: 0 });
  });
});

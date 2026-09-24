/**
 * Listing past runs without re-reading every one of them.
 *
 * The first version counted rows by loading each `.jsonl` in full and
 * JSON.parsing every line, for every run, on every request — and the UI calls
 * this on page load and again after each search finishes. With a few hundred
 * runs that is a lot of disk and parsing to answer "what did I search for".
 *
 * Three things fix it: the sidecar already records the counts, so it is trusted
 * whenever it is at least as new as its `.jsonl`; the listing is paginated, so
 * at most one page ever needs the fallback; and results are cached against file
 * mtime and size, so repeat polls do no I/O beyond a stat.
 */

import path from "node:path";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
const CACHE_LIMIT = 500;

/** Clamp `?limit=` and `?offset=` into something sane. */
export function parseRunsQuery({ limit, offset } = {}) {
  const asInt = (value, fallback) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    limit: Math.min(Math.max(asInt(limit, DEFAULT_LIMIT), 1), MAX_LIMIT),
    offset: Math.max(asInt(offset, 0), 0),
  };
}

/** Count rows in a JSONL body. A malformed line is counted but not trusted. */
export function countRows(text) {
  let total = 0;
  let withEmail = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    total += 1;
    try {
      if (JSON.parse(line).email) withEmail += 1;
    } catch {
      // A half-written final line can happen if a run was killed mid-append.
    }
  }
  return { total, withEmail };
}

/**
 * Can the sidecar's counts be believed?
 *
 * The sidecar is written when a run starts and again when it ends, while rows
 * are appended in between. So it is only authoritative when it is at least as
 * new as the file it describes.
 */
export function metaIsFresh(metaMtimeMs, jsonlMtimeMs) {
  if (!Number.isFinite(metaMtimeMs) || !Number.isFinite(jsonlMtimeMs)) return false;
  return metaMtimeMs >= jsonlMtimeMs;
}

/** Newest first; runs with no sidecar fall back to the file's own timestamp. */
export function compareRuns(a, b) {
  return String(b.sortKey ?? "").localeCompare(String(a.sortKey ?? ""));
}

/**
 * @param {object} deps  fs functions are injected so this is testable without a disk.
 */
export function createRunsReader({ runsDir, readdir, readFile, stat, cache = new Map() }) {
  const jsonlPath = (id) => path.join(runsDir, `${id}.jsonl`);
  const metaPath = (id) => path.join(runsDir, `${id}.meta.json`);

  async function statOrNull(file) {
    try {
      return await stat(file);
    } catch {
      return null;
    }
  }

  async function readMeta(id) {
    try {
      return JSON.parse(await readFile(metaPath(id), "utf8"));
    } catch {
      // Runs from before the sidecar existed still list, just without labels.
      return null;
    }
  }

  /** Counts for one run, from the sidecar when possible, else from the file. */
  async function countsFor(id, meta, stats) {
    if (meta && metaIsFresh(stats.metaMtimeMs, stats.jsonlMtimeMs)
        && Number.isFinite(meta.count) && Number.isFinite(meta.withEmail)) {
      return { total: meta.count, withEmail: meta.withEmail, source: "meta" };
    }

    const key = `${id}:${stats.jsonlMtimeMs}:${stats.size}`;
    const hit = cache.get(key);
    if (hit) return { ...hit, source: "cache" };

    let counted = { total: 0, withEmail: 0 };
    try {
      counted = countRows(await readFile(jsonlPath(id), "utf8"));
    } catch {
      // Deleted between listing and reading; report it as empty.
    }

    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, counted);
    return { ...counted, source: "file" };
  }

  return {
    async list(query = {}) {
      const { limit, offset } = parseRunsQuery(query);

      const entries = await readdir(runsDir).catch(() => []);
      const ids = entries
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => name.slice(0, -".jsonl".length));

      // Cheap pass: stat and sidecar only, enough to order and paginate.
      const summaries = await Promise.all(ids.map(async (id) => {
        const [jsonlStat, metaStat] = await Promise.all([
          statOrNull(jsonlPath(id)),
          statOrNull(metaPath(id)),
        ]);
        const meta = metaStat ? await readMeta(id) : null;
        return {
          id,
          meta,
          stats: {
            jsonlMtimeMs: jsonlStat?.mtimeMs ?? Number.NaN,
            metaMtimeMs: metaStat?.mtimeMs ?? Number.NaN,
            size: jsonlStat?.size ?? 0,
          },
          // Sidecar time if we have it, otherwise the file's own mtime.
          sortKey: meta?.createdAt
            ?? (jsonlStat ? new Date(jsonlStat.mtimeMs).toISOString() : ""),
        };
      }));

      summaries.sort(compareRuns);
      const page = summaries.slice(offset, offset + limit);

      // Expensive pass: only for the page, and only when the sidecar is stale.
      const runs = await Promise.all(page.map(async ({ id, meta, stats, sortKey }) => {
        const counts = await countsFor(id, meta, stats);
        return {
          id,
          city: meta?.city ?? "",
          category: meta?.category ?? "",
          createdAt: meta?.createdAt ?? (Number.isFinite(stats.jsonlMtimeMs)
            ? new Date(stats.jsonlMtimeMs).toISOString()
            : null),
          state: meta?.state ?? "unknown",
          count: counts.total,
          withEmail: counts.withEmail,
          countsFrom: counts.source,
          sortKey: undefined,
        };
      }));

      return { runs, total: summaries.length, limit, offset };
    },
  };
}

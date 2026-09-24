import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CONTACT_PATHS, SiteFetcher } from "../src/emails.js";

/** Pretend DNS: every host is public, so the address guard stays out of the way. */
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }];

const htmlResponse = (body, { status = 200, url = "https://x.example/" } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  headers: {
    get: (name) => {
      const key = String(name).toLowerCase();
      if (key === "content-type") return "text/html; charset=utf-8";
      if (key === "content-length") return String(body.length);
      return null;
    },
  },
  text: async () => body,
});

/** A fetch stub that records every URL it is asked for. */
function recordingFetch(handler) {
  const calls = [];
  const impl = async (url, options) => {
    calls.push(String(url));
    return handler(String(url), options);
  };
  return { impl, calls };
}

const contentCalls = (calls) => calls.filter((url) => !url.endsWith("/robots.txt"));

describe("per-site time budget", () => {
  it("stops after the homepage when the host is unreachable", async () => {
    const { impl, calls } = recordingFetch(async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
    });
    const fetcher = new SiteFetcher({ resolve: publicDns, fetchImpl: impl });

    const result = await fetcher.inspect("https://gone.example/");

    // Before this change every one of the six paths was attempted.
    assert.equal(contentCalls(calls).length, 1, `tried ${contentCalls(calls).length} paths: ${contentCalls(calls)}`);
    assert.ok(CONTACT_PATHS.length > 1, "there is more than one path to skip");
    assert.equal(result.email, null);
    assert.deepEqual(result.analysis.signals, ["unreachable"]);
  });

  it("does not give up on the other paths when the homepage merely 404s", async () => {
    // A 404 means the host is alive; /contact may still exist.
    const { impl, calls } = recordingFetch(async (url) => {
      if (url.endsWith("/robots.txt")) return htmlResponse("", { status: 404 });
      if (url.endsWith("/contact")) return htmlResponse('<a href="mailto:hi@live.example">mail</a>');
      return htmlResponse("<html>nothing here</html>", { status: 404 });
    });
    const fetcher = new SiteFetcher({ resolve: publicDns, fetchImpl: impl });

    const result = await fetcher.inspect("https://live.example/");

    assert.equal(result.email, "hi@live.example");
    assert.ok(contentCalls(calls).length >= 2, "should have gone past the homepage");
  });

  it("stops requesting once the budget is spent", async () => {
    const { impl, calls } = recordingFetch(async (url) => {
      if (url.endsWith("/robots.txt")) return htmlResponse("", { status: 404 });
      // Every content page is alive but holds the connection open.
      await new Promise((resolve) => setTimeout(resolve, 40));
      return htmlResponse("<html>no address here</html>");
    });
    const fetcher = new SiteFetcher({
      resolve: publicDns,
      fetchImpl: impl,
      timeout: 1000,
      budget: 90, // room for about two pages
    });

    const startedAt = Date.now();
    const result = await fetcher.inspect("https://slow.example/");
    const elapsed = Date.now() - startedAt;

    assert.equal(result.email, null);
    assert.ok(
      contentCalls(calls).length < CONTACT_PATHS.length,
      `budget should have cut the run short, but all ${CONTACT_PATHS.length} paths were tried`,
    );
    assert.ok(elapsed < 1000, `took ${elapsed}ms, which is past the budget`);
  });

  it("still finds an email on the homepage without spending the budget", async () => {
    const { impl, calls } = recordingFetch(async (url) => {
      if (url.endsWith("/robots.txt")) return htmlResponse("", { status: 404 });
      return htmlResponse('<a href="mailto:info@quick.example">Contact</a>');
    });
    const fetcher = new SiteFetcher({ resolve: publicDns, fetchImpl: impl });

    const result = await fetcher.inspect("https://quick.example/");

    assert.equal(result.email, "info@quick.example");
    assert.equal(contentCalls(calls).length, 1, "should stop at the first hit");
  });

  it("caps a single request at whatever is left of the budget", async () => {
    const timeouts = [];
    const impl = async (url, options) => {
      // AbortSignal.timeout does not expose its delay, so record the shape we
      // can see: that a signal was supplied at all, and the call order.
      timeouts.push({ url: String(url), hasSignal: Boolean(options?.signal) });
      if (String(url).endsWith("/robots.txt")) return htmlResponse("", { status: 404 });
      return htmlResponse("<html>none</html>");
    };
    const fetcher = new SiteFetcher({ resolve: publicDns, fetchImpl: impl, timeout: 9999, budget: 5000 });

    await fetcher.inspect("https://x.example/");
    assert.ok(timeouts.length > 0);
    assert.ok(timeouts.every((entry) => entry.hasSignal), "every request should carry an abort signal");
  });
});

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SiteFetcher } from "../src/emails.js";
import {
  BlockedAddressError,
  assertPublicUrl,
  isBlockedHostname,
  isPrivateAddress,
  readCapped,
} from "../src/net.js";

/** A resolver stub, so none of these tests touch DNS. */
const resolvesTo = (...addresses) => async () => addresses.map((address) => ({ address, family: 4 }));
const resolveFails = async () => { throw new Error("ENOTFOUND"); };

describe("isPrivateAddress", () => {
  it("flags loopback, RFC1918 and link-local IPv4", () => {
    for (const address of [
      "127.0.0.1", "127.1.2.3", "10.0.0.1", "10.255.255.255",
      "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254",
      "0.0.0.0", "100.64.0.1", "255.255.255.255", "224.0.0.1",
    ]) {
      assert.equal(isPrivateAddress(address), true, `${address} should be private`);
    }
  });

  it("leaves public IPv4 alone", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.255.255", "93.184.216.34"]) {
      assert.equal(isPrivateAddress(address), false, `${address} should be public`);
    }
  });

  it("flags loopback, unique-local and link-local IPv6", () => {
    for (const address of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1"]) {
      assert.equal(isPrivateAddress(address), true, `${address} should be private`);
    }
  });

  it("sees through IPv4-mapped IPv6", () => {
    assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
    assert.equal(isPrivateAddress("::ffff:169.254.169.254"), true);
    assert.equal(isPrivateAddress("::ffff:8.8.8.8"), false);
  });

  it("leaves public IPv6 alone", () => {
    assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
  });

  it("does not treat a hostname as an address", () => {
    assert.equal(isPrivateAddress("example.com"), false);
    assert.equal(isPrivateAddress(""), false);
  });
});

describe("isBlockedHostname", () => {
  it("blocks names that never mean a public site", () => {
    for (const host of [
      "localhost", "LOCALHOST", "localhost.", "api.localhost",
      "printer.local", "db.internal", "metadata.google.internal", "instance-data", "",
    ]) {
      assert.equal(isBlockedHostname(host), true, `${host} should be blocked`);
    }
  });

  it("allows ordinary hostnames", () => {
    for (const host of ["example.com", "bouldincreekcafe.com", "shop.localhostel.com"]) {
      assert.equal(isBlockedHostname(host), false, `${host} should be allowed`);
    }
  });
});

describe("assertPublicUrl", () => {
  it("accepts a public hostname", async () => {
    const url = await assertPublicUrl("https://example.com/contact", { resolve: resolvesTo("93.184.216.34") });
    assert.equal(url.hostname, "example.com");
  });

  it("refuses a hostname that resolves into the private range", async () => {
    await assert.rejects(
      () => assertPublicUrl("https://sneaky.example/", { resolve: resolvesTo("127.0.0.1") }),
      BlockedAddressError,
    );
  });

  it("refuses when any resolved address is private", async () => {
    await assert.rejects(
      () => assertPublicUrl("https://mixed.example/", { resolve: resolvesTo("8.8.8.8", "169.254.169.254") }),
      BlockedAddressError,
    );
  });

  it("refuses a literal private IP without consulting DNS", async () => {
    const never = async () => { throw new Error("DNS should not be used for a literal IP"); };
    await assert.rejects(() => assertPublicUrl("http://169.254.169.254/latest/meta-data/", { resolve: never }),
      BlockedAddressError);
    await assert.rejects(() => assertPublicUrl("http://127.0.0.1:5000/", { resolve: never }), BlockedAddressError);
    await assert.rejects(() => assertPublicUrl("http://[::1]:5000/", { resolve: never }), BlockedAddressError);
  });

  it("refuses internal hostnames", async () => {
    await assert.rejects(() => assertPublicUrl("http://localhost:5000/"), BlockedAddressError);
    await assert.rejects(() => assertPublicUrl("http://metadata.google.internal/"), BlockedAddressError);
  });

  it("refuses non-HTTP schemes", async () => {
    await assert.rejects(() => assertPublicUrl("file:///etc/passwd"), BlockedAddressError);
    await assert.rejects(() => assertPublicUrl("ftp://example.com/x"), BlockedAddressError);
    await assert.rejects(() => assertPublicUrl("not a url"), BlockedAddressError);
  });

  it("lets an unresolvable name through, so it fails as 'unreachable' not as a policy breach", async () => {
    const url = await assertPublicUrl("https://gone.example/", { resolve: resolveFails });
    assert.equal(url.hostname, "gone.example");
  });
});

describe("readCapped", () => {
  const streamed = (text, contentLength) => ({
    headers: { get: (name) => (name === "content-length" ? contentLength ?? null : null) },
    body: {
      getReader() {
        let sent = false;
        return {
          async read() {
            if (sent) return { done: true, value: undefined };
            sent = true;
            return { done: false, value: new TextEncoder().encode(text) };
          },
          async cancel() {},
        };
      },
    },
  });

  it("returns a small body whole", async () => {
    const { text, truncated } = await readCapped(streamed("<html>hi</html>"), 1000);
    assert.equal(text, "<html>hi</html>");
    assert.equal(truncated, false);
  });

  it("stops reading once the cap is passed", async () => {
    const { text, truncated } = await readCapped(streamed("x".repeat(5000)), 100);
    assert.equal(text.length, 100);
    assert.equal(truncated, true);
  });

  it("refuses up front when content-length already exceeds the cap", async () => {
    const { text, truncated } = await readCapped(streamed("x".repeat(10), "999999999"), 1000);
    assert.equal(text, "");
    assert.equal(truncated, true);
  });

  it("falls back to text() when there is no streaming body", async () => {
    const response = { headers: { get: () => null }, text: async () => "<html>plain</html>" };
    const { text, truncated } = await readCapped(response, 1000);
    assert.equal(text, "<html>plain</html>");
    assert.equal(truncated, false);
  });
});

describe("SiteFetcher refuses internal targets", () => {
  it("reports a blocked host instead of requesting it", async () => {
    // No fetch stub needed: if the guard leaks, this would try to open a socket.
    const fetcher = new SiteFetcher({ resolve: resolvesTo("127.0.0.1") });
    const result = await fetcher.inspect("http://localhost:5000/");
    assert.equal(result.blocked, true);
    assert.equal(result.email, null);
    assert.equal(result.analysis, null);
  });

  it("blocks a public-looking host that resolves to loopback", async () => {
    const fetcher = new SiteFetcher({ resolve: resolvesTo("127.0.0.1") });
    const result = await fetcher.inspect("https://internal.example/");
    assert.equal(result.blocked, true);
  });
});

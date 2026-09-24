/**
 * Guards for fetching URLs that came from somewhere else.
 *
 * The website addresses this tool visits are taken from Google Maps listings —
 * third-party data nobody here controls. Fetching them from a server means an
 * attacker who can get a listing published can choose a URL our server will
 * request. Pointed at `http://169.254.169.254/` that reads cloud metadata;
 * pointed at `http://127.0.0.1:5000/` it reaches services bound to loopback.
 *
 * So every hop is resolved and checked against the private address space
 * before a request is made, redirects included: a public hostname that 302s to
 * 127.0.0.1 is the standard way around a naive check.
 */

import { lookup } from "node:dns/promises";

/** Redirect chains longer than this are refused rather than followed. */
export const MAX_REDIRECTS = 5;

export class BlockedAddressError extends Error {
  constructor(message) {
    super(message);
    this.name = "BlockedAddressError";
  }
}

// Hostnames that never refer to a public site, whatever DNS says.
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".localdomain", ".home.arpa"];

const ipv4ToInt = (parts) => ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];

/** Ranges that are not routable on the public internet, or are special-use. */
const BLOCKED_V4_RANGES = [
  ["0.0.0.0", 8],        // "this network"
  ["10.0.0.0", 8],       // RFC1918 private
  ["100.64.0.0", 10],    // CGNAT
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local, incl. cloud metadata at 169.254.169.254
  ["172.16.0.0", 12],    // RFC1918 private
  ["192.0.0.0", 24],     // IETF protocol assignments
  ["192.0.2.0", 24],     // TEST-NET-1
  ["192.168.0.0", 16],   // RFC1918 private
  ["198.18.0.0", 15],    // benchmarking
  ["198.51.100.0", 24],  // TEST-NET-2
  ["203.0.113.0", 24],   // TEST-NET-3
  ["224.0.0.0", 4],      // multicast
  ["240.0.0.0", 4],      // reserved, incl. 255.255.255.255
];

function parseIpv4(value) {
  const parts = String(value).split(".");
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  if (numbers.some((number) => Number.isNaN(number) || number > 255)) return null;
  return numbers;
}

function isPrivateIpv4(value) {
  const parts = parseIpv4(value);
  if (!parts) return false;
  const address = ipv4ToInt(parts);
  return BLOCKED_V4_RANGES.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (address & mask) === (ipv4ToInt(parseIpv4(base)) & mask);
  });
}

function isPrivateIpv6(value) {
  const address = String(value).toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];

  // ::ffff:127.0.0.1 and friends are IPv4 wearing an IPv6 hat.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return isPrivateIpv4(mapped[1]);

  if (address === "::" || address === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(address)) return true; // fe80::/10 link-local
  if (/^ff[0-9a-f]{2}:/.test(address)) return true;    // ff00::/8 multicast
  return false;
}

/** True for any address that is not routable on the public internet. */
export function isPrivateAddress(value) {
  if (!value) return false;
  const address = String(value).trim();
  return address.includes(":") ? isPrivateIpv6(address) : isPrivateIpv4(address);
}

/** True for hostnames that should never be resolved at all. */
export function isBlockedHostname(hostname) {
  const host = String(hostname ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!host) return true;
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Throw unless `url` is an http(s) address that resolves to a public host.
 *
 * `resolve` is injectable so the checks can be tested without touching DNS.
 */
export async function assertPublicUrl(url, { resolve = lookup } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new BlockedAddressError(`Not a usable URL: ${url}`);
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BlockedAddressError(`Refusing a non-HTTP address: ${parsed.protocol}//`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostname(hostname)) {
    throw new BlockedAddressError(`Refusing an internal hostname: ${parsed.hostname}`);
  }

  // A literal IP needs no lookup, and must not get one: DNS would not be
  // consulted for it at request time either.
  if (isPrivateAddress(hostname)) {
    throw new BlockedAddressError(`Refusing a private address: ${parsed.hostname}`);
  }
  if (parseIpv4(hostname) || hostname.includes(":")) return parsed;

  let addresses;
  try {
    addresses = await resolve(hostname, { all: true });
  } catch {
    // A name that will not resolve is the site's problem, not a policy breach;
    // let the request itself fail so it is reported as "unreachable".
    return parsed;
  }

  const list = Array.isArray(addresses) ? addresses : [addresses];
  for (const entry of list) {
    const address = typeof entry === "string" ? entry : entry?.address;
    if (address && isPrivateAddress(address)) {
      throw new BlockedAddressError(`${parsed.hostname} resolves to a private address (${address})`);
    }
  }
  return parsed;
}

/**
 * Read a response body with a hard byte ceiling.
 *
 * `response.text()` will happily buffer a multi-gigabyte body into memory. We
 * only ever need the first chunk of markup, so stop once the cap is reached and
 * parse what arrived.
 */
export async function readCapped(response, maxBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { text: "", truncated: true, bytes: declared };
  }

  if (!response.body || typeof response.body.getReader !== "function") {
    // No streaming body (a stubbed response in a test, or an old runtime).
    const text = await response.text();
    const bytes = Buffer.byteLength(text, "utf8");
    return bytes > maxBytes
      ? { text: text.slice(0, maxBytes), truncated: true, bytes }
      : { text, truncated: false, bytes };
  }

  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  let truncated = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        chunks.push(value.slice(0, value.byteLength - (bytes - maxBytes)));
        truncated = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return { text: Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8"), truncated, bytes };
}

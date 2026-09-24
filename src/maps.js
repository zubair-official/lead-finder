/**
 * Scrape a Google Maps search for businesses, politely.
 *
 * Limits are configurable (see src/config.js) but the conduct rules are not:
 *   * one browser, one page, no parallel tabs
 *   * a randomised pause between scrolls and between detail panels, never
 *     below a 1 second floor however it is configured
 *   * if Google shows a CAPTCHA or an unusual-traffic page we throw
 *     BlockedError and stop. We never try to solve or work around it.
 *   * we never click Google's cookie/consent dialog on the user's behalf.
 *     Headed, we wait for them to click it; headless, we stop and say so.
 */

import { pathToFileURL } from "node:url";

import { chromium } from "playwright";

import { config } from "./config.js";
import { log } from "./logger.js";

export const MAX_RESULTS = config.maxResults;
export const MAX_SCROLLS = config.maxScrolls;
const CONSENT_WAIT_MS = 180_000;

// Google's class names churn every few months. Each entry lists fallbacks,
// most-stable first; aria/data attributes outlive the obfuscated classes.
export const SELECTORS = {
  feed: 'div[role="feed"]',
  cardLink: "a.hfpxzc", // one per result; aria-label is the name
  cardWebsite: 'a[data-value="Website"], a.lcr4fd',
  cardRating: 'span[role="img"][aria-label*="star"]', // aria-label reads "4.9 stars"
  cardReviews: "span.UY7F9", // only present when signed in
  detailPanel: 'div[role="main"][aria-label]',
  detailWebsite: 'a[data-item-id="authority"]',
  detailPhone: 'button[data-item-id^="phone:tel:"]',
  detailAddress: 'button[data-item-id="address"]',
  endOfList: "text=You've reached the end of the list",
};

const BLOCK_TEXT_MARKERS = ["unusual traffic", "our systems have detected"];
const CONSENT_MARKERS = ["consent.google.com", "/consent"];

// Signed in, Maps renders "4.9 (1,234)". Signed out it renders a bare "4.9"
// on its own line with no review count, so both shapes have to parse.
const RATING_RE = /(\d(?:[.,]\d)?)\s*\(\s*([\d.,]+)\s*\)/;
const BARE_RATING_RE = /^([0-5][.,]\d)$/;
// Maps sprinkles private-use icon glyphs through the card text.
const PUA_RE = /[-]/g;
const PHONE_RE = /(\+?\d[\d\s().-]{7,}\d)/;
const PHONE_FULL_RE = /^(\+?\d[\d\s().-]{7,}\d)$/;
const SEPARATORS = ["·", "⋅", "•"];

export class BlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = "BlockedError";
  }
}

export class ConsentRequired extends Error {
  constructor(message) {
    super(message);
    this.name = "ConsentRequired";
  }
}

export const EMPTY_BUSINESS = {
  name: "", category: "", address: "", phone: "", rating: "",
  reviews: "", website: "", email: "", email_source: "", maps_url: "",
  // Filled in by the email pass (see src/signals.js). score is "how much
  // opportunity", so a neglected site scores high.
  score: null, signals: [], site_builder: "", email_verified: null,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The etiquette pause. Every scroll and every detail open goes through here. */
function pause() {
  const { pauseMinMs, pauseMaxMs } = config;
  return sleep(pauseMinMs + Math.random() * (pauseMaxMs - pauseMinMs));
}

/** Strip Maps' icon glyphs and odd spaces out of a scraped field. */
export function cleanText(value) {
  return String(value ?? "")
    .replace(PUA_RE, " ")
    .replace(/ /g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s·⋅•,]+|[\s·⋅•,]+$/g, "");
}

function splitLine(line) {
  let working = line;
  for (const separator of SEPARATORS) working = working.split(separator).join("|");
  return working.split("|").map((part) => part.trim()).filter(Boolean);
}

/**
 * Pull category / address / phone / rating out of a card's innerText.
 *
 * Parsing the rendered text survives Google's class-name churn far better than
 * per-field selectors do.
 */
export function parseCardText(text) {
  const lines = String(text ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  const parsed = { category: "", address: "", phone: "", rating: "", reviews: "" };

  const ratingMatch = RATING_RE.exec(String(text ?? ""));
  if (ratingMatch) {
    parsed.rating = ratingMatch[1].replace(",", ".");
    parsed.reviews = ratingMatch[2].replace(/\D/g, "");
  } else {
    for (const line of lines) {
      const bare = BARE_RATING_RE.exec(line);
      if (bare) {
        parsed.rating = bare[1].replace(",", ".");
        break;
      }
    }
  }

  for (const line of lines.slice(1)) {
    const lowered = line.toLowerCase();
    if (lowered === "sponsored" || lowered === "ad" || BARE_RATING_RE.test(line)) continue;

    if (["open", "clos", "hours"].some((word) => lowered.includes(word))) {
      const phoneMatch = PHONE_RE.exec(line);
      if (phoneMatch && !parsed.phone) parsed.phone = phoneMatch[1].trim();
      continue;
    }

    const parts = splitLine(line);
    if (parts.length >= 2 && !parsed.address) {
      // "Coffee shop - 300 Webster St" -> category, address
      if (!parsed.category) parsed.category = parts[0];
      parsed.address = parts[parts.length - 1];
    } else if (parts.length === 1 && PHONE_FULL_RE.test(parts[0]) && !parsed.phone) {
      parsed.phone = parts[0];
    }
  }

  if (!parsed.phone) {
    for (const line of lines) {
      const phoneMatch = PHONE_RE.exec(line);
      if (phoneMatch && phoneMatch[1].replace(/\D/g, "").length >= 9) {
        parsed.phone = phoneMatch[1].trim();
        break;
      }
    }
  }

  return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, cleanText(value)]));
}

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid",
]);

/** Drop the utm_* tracking Google appends to listed websites. */
export function cleanUrl(url) {
  if (!url) return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) parsed.searchParams.delete(key);
  }
  // URL always renders an empty query as "", so this drops the trailing "?" too.
  return parsed.toString();
}

export function isExternal(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return Boolean(host) && !host.includes("google.") && !host.includes("gstatic.");
  } catch {
    return false;
  }
}

/** Throw if Google is refusing us. Called before and after every navigation. */
export async function checkNotBlocked(page) {
  const url = (page.url() || "").toLowerCase();
  if (url.includes("/sorry/") || url.includes("recaptcha")) {
    throw new BlockedError("Google returned its 'unusual traffic' page.");
  }
  let body = "";
  try {
    if ((await page.locator('iframe[src*="recaptcha"], form#captcha-form').count()) > 0) {
      throw new BlockedError("A CAPTCHA appeared on the page.");
    }
    body = ((await page.locator("body").innerText({ timeout: 5000 })) || "").toLowerCase();
  } catch (error) {
    if (error instanceof BlockedError) throw error;
    return;
  }
  for (const marker of BLOCK_TEXT_MARKERS) {
    if (body.includes(marker)) throw new BlockedError("Google is showing an unusual-traffic warning.");
  }
}

/** Wait for the human to dismiss Google's consent screen. We never click it. */
async function handleConsent(page, onStatus) {
  const onConsent = () => CONSENT_MARKERS.some((marker) => (page.url() || "").includes(marker));
  if (!onConsent()) return;

  if (config.headless) {
    throw new ConsentRequired(
      "Google is showing its cookie/consent screen, and nothing can click it in " +
        "headless mode. Run once with HEADED=1, accept it in the window that opens, " +
        "and the saved browser profile will carry that consent into headless runs.",
    );
  }

  onStatus(
    "Google is showing its cookie/consent screen. Please click your choice in " +
      "the browser window that just opened - I won't accept it for you. " +
      "Waiting up to 3 minutes...",
    { needsAttention: true },
  );

  const deadline = Date.now() + CONSENT_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(2000);
    if (!onConsent()) {
      onStatus("Consent screen cleared, carrying on...");
      return;
    }
  }
  throw new ConsentRequired(
    "The consent screen was still up after 3 minutes. Dismiss it in the browser " +
      "window and run the search again.",
  );
}

/**
 * Wait for Google to lazy-load the next batch after a scroll.
 *
 * Polls the DOM (no extra requests to Google) until the listing count grows or
 * the settle window expires. Returning as soon as it grows keeps a fast
 * connection fast; the window is what stops a slow one from being mistaken for
 * the end of the list.
 */
async function waitForMoreListings(page, previousCount, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const count = await page.locator(SELECTORS.cardLink).count();
    if (count > previousCount) return count;
  }
  return previousCount;
}

/** Scroll the results panel until it stops growing, we hit the cap, or run out of scrolls. */
async function scrollFeed(page, onStatus, shouldStop, limit) {
  const feed = page.locator(SELECTORS.feed).first();
  let previous = await page.locator(SELECTORS.cardLink).count();
  let stagnant = 0;

  for (let scrollNumber = 1; scrollNumber <= MAX_SCROLLS; scrollNumber += 1) {
    if (shouldStop()) return;

    if (previous >= limit) {
      onStatus(`Found ${previous} listings - that's the cap, moving on.`);
      return;
    }
    if ((await page.locator(SELECTORS.endOfList).count()) > 0) {
      onStatus(`Reached the end of Google's list at ${previous} listings.`);
      return;
    }

    onStatus(`Scrolling for more listings (${previous} so far, scroll ${scrollNumber}/${MAX_SCROLLS})...`);
    try {
      await feed.evaluate((element) => element.scrollBy(0, element.scrollHeight));
    } catch {
      log.debug("feed.evaluate scroll failed, falling back to mouse wheel");
      await page.mouse.wheel(0, 3000);
    }

    // The etiquette pause happens first, then we give Google a further window
    // to actually deliver the batch before judging the feed exhausted.
    await pause();
    await checkNotBlocked(page);
    const count = await waitForMoreListings(page, previous, config.scrollSettleMs);

    if (count === previous) {
      stagnant += 1;
      log.debug(`no growth after scroll ${scrollNumber} (strike ${stagnant}/${config.scrollStrikes})`);
      if (stagnant >= config.scrollStrikes) {
        onStatus(`No new listings after ${stagnant} tries - stopping at ${count}.`);
        return;
      }
    } else {
      stagnant = 0;
    }
    previous = count;
  }
  onStatus(`Reached the scroll limit (${MAX_SCROLLS}) with ${previous} listings.`);
}

const normalise = (value) => String(value ?? "").replace(/\s+/g, " ").trim().toLowerCase();

/** Second dedupe key: Maps can list one business under two different hrefs. */
export const identityKey = (business) => `${normalise(business.name)}|${normalise(business.address)}`;

/**
 * Return the detail panel for `expectedName`, or null if it never arrives.
 *
 * Maps swaps the panel contents asynchronously, so the panel on screen right
 * after a click is often still the previous business. Reading that panel
 * silently attaches one business's website and phone to another, so we confirm
 * the panel identity and skip the listing rather than guess.
 */
async function waitForDetailPanel(page, expectedName, timeout = config.detailTimeoutMs) {
  const wanted = normalise(expectedName);
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const panels = page.locator(SELECTORS.detailPanel);
    const total = await panels.count();
    for (let index = 0; index < total; index += 1) {
      const panel = panels.nth(index);
      const label = normalise(await panel.getAttribute("aria-label"));
      // LF_DEBUG=1 shows the panel swapping late, which is the race this guards.
      if (process.env.LF_DEBUG) console.log(`   [debug] want ${JSON.stringify(wanted)} | panel ${JSON.stringify(label)} | match ${label === wanted}`);
      if (!wanted || label === wanted) return panel;
      const heading = panel.locator("h1").first();
      if ((await heading.count()) > 0 && normalise(await heading.innerText()) === wanted) return panel;
    }
    await page.waitForTimeout(400);
  }
  return null;
}

/** Fill in whatever the card didn't show, from an already-confirmed panel. */
async function readDetailPanel(panel, business) {
  if (!business.website) {
    const link = panel.locator(SELECTORS.detailWebsite).first();
    if ((await link.count()) > 0) {
      const href = (await link.getAttribute("href")) || "";
      if (isExternal(href)) business.website = cleanUrl(href);
    }
  }

  if (!business.phone) {
    const phoneButton = panel.locator(SELECTORS.detailPhone).first();
    if ((await phoneButton.count()) > 0) {
      const itemId = (await phoneButton.getAttribute("data-item-id")) || "";
      business.phone = itemId.replace("phone:tel:", "").trim() || business.phone;
    }
  }

  if (!business.address) {
    const addressButton = panel.locator(SELECTORS.detailAddress).first();
    if ((await addressButton.count()) > 0) {
      const label = (await addressButton.getAttribute("aria-label")) || "";
      business.address = label.replace("Address:", "").trim();
    }
  }

  if (!business.name) {
    const heading = panel.locator("h1").first();
    if ((await heading.count()) > 0) business.name = (await heading.innerText()).trim();
  }
}

/**
 * The browser currently in use, if any.
 *
 * scrape() closes its own browser in a finally block, but that block never runs
 * if the process is being torn down. Holding the handle here lets the shutdown
 * path close Chromium instead of orphaning it.
 */
let activeBrowser = null;

/**
 * Close whatever browser is open. Safe to call when there is none.
 *
 * @returns {Promise<boolean>} true if something was actually closed.
 */
export async function closeActiveBrowser() {
  if (!activeBrowser) return false;
  const { browser, context } = activeBrowser;
  activeBrowser = null;
  // A persistent context owns its own browser: closing it twice throws.
  await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  return true;
}

const CONTEXT_OPTIONS = {
  viewport: { width: 1360, height: 900 },
  locale: "en-US",
};

/**
 * Launch Chromium, reusing a saved profile when one is configured.
 *
 * The profile is what makes headless practical: cookies set by a one-off
 * headed consent click are still there on the next headless run.
 */
async function openBrowser(headless) {
  if (config.userDataDir) {
    log.debug("launching with persistent profile", config.userDataDir);
    const context = await chromium.launchPersistentContext(config.userDataDir, {
      headless,
      ...CONTEXT_OPTIONS,
    });
    activeBrowser = { browser: null, context };
    return activeBrowser;
  }
  const browser = await chromium.launch({ headless });
  activeBrowser = { browser, context: await browser.newContext(CONTEXT_OPTIONS) };
  return activeBrowser;
}

/**
 * Search Google Maps and return the businesses found.
 *
 * onResult is called for each kept business as soon as it is scraped, so the
 * caller can persist it before the run finishes.
 */
export async function scrape(
  category,
  city,
  {
    limit = MAX_RESULTS,
    onlyWithWebsite = true,
    onResult = async () => {},
    onStatus = (message) => console.log(`[status] ${message}`),
    shouldStop = () => false,
    headless = config.headless,
  } = {},
) {
  const cappedLimit = Math.min(limit, MAX_RESULTS);
  const query = `${category} near ${city}`.trim();
  const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
  const collected = [];

  const { context } = await openBrowser(headless);
  const page = context.pages()[0] ?? (await context.newPage());

  try {
    onStatus(`Opening Google Maps for "${query}"...`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
    await handleConsent(page, onStatus);
    await checkNotBlocked(page);

    try {
      await page.locator(SELECTORS.feed).first().waitFor({ state: "visible", timeout: 30_000 });
    } catch {
      await checkNotBlocked(page);
      if ((await page.locator(SELECTORS.detailWebsite).count()) > 0) {
        throw new Error(
          "Google jumped straight to a single business instead of a results list. Try a broader search.",
        );
      }
      throw new Error("The results panel never appeared. Try again in a little while.");
    }

    await scrollFeed(page, onStatus, shouldStop, cappedLimit);

    const cards = page.locator(SELECTORS.cardLink);
    const total = Math.min(await cards.count(), cappedLimit);
    onStatus(`Reading ${total} listings...`);

    const seen = new Set();
    // Maps sometimes lists one business under two hrefs (an ad slot plus the
    // organic result), so identity is a second, stronger dedupe key.
    const seenIdentity = new Set();
    for (let index = 0; index < total; index += 1) {
      if (shouldStop()) {
        onStatus("Stopped by you - keeping everything found so far.");
        break;
      }

      const cardLink = cards.nth(index);
      const mapsUrl = (await cardLink.getAttribute("href")) || "";
      if (seen.has(mapsUrl)) continue;
      seen.add(mapsUrl);

      const business = {
        ...EMPTY_BUSINESS,
        name: ((await cardLink.getAttribute("aria-label")) || "").trim(),
        maps_url: mapsUrl,
      };

      const card = cardLink.locator("xpath=..");
      let parsed = {};
      try {
        parsed = parseCardText(await card.innerText({ timeout: 5000 }));
      } catch {
        parsed = {};
      }
      for (const [field, value] of Object.entries(parsed)) {
        if (value && !business[field]) business[field] = value;
      }

      const ratingNode = card.locator(SELECTORS.cardRating).first();
      if ((await ratingNode.count()) > 0) {
        const label = (await ratingNode.getAttribute("aria-label")) || "";
        const stars = /(\d(?:[.,]\d)?)/.exec(label);
        if (stars) business.rating = stars[1].replace(",", ".");
      }
      const reviewsNode = card.locator(SELECTORS.cardReviews).first();
      if ((await reviewsNode.count()) > 0 && !business.reviews) {
        try {
          business.reviews = (await reviewsNode.innerText({ timeout: 2000 })).replace(/\D/g, "");
        } catch {
          /* review count is optional */
        }
      }

      const websiteLink = card.locator(SELECTORS.cardWebsite).first();
      if ((await websiteLink.count()) > 0) {
        const href = (await websiteLink.getAttribute("href")) || "";
        if (isExternal(href)) business.website = cleanUrl(href);
      }

      // Only worth a click if the card left something important out.
      if (!business.website || !business.phone) {
        onStatus(`Opening details for ${business.name || `listing ${index + 1}`}...`);
        await pause();
        try {
          await cardLink.click({ timeout: 15_000 });
          await checkNotBlocked(page);
          const panel = await waitForDetailPanel(page, business.name);
          if (panel) {
            await readDetailPanel(panel, business);
          } else {
            onStatus(`Detail panel never matched ${business.name} - skipping its extras.`);
          }
        } catch (error) {
          if (error instanceof BlockedError) throw error;
          // A single unreadable listing shouldn't end the run.
        }
      }

      if (onlyWithWebsite && !business.website) continue;

      const identity = identityKey(business);
      if (identity !== "|" && seenIdentity.has(identity)) continue;
      seenIdentity.add(identity);

      collected.push(business);
      await onResult(business);
      onStatus(`Found ${collected.length}: ${business.name}`);
    }

    if (!shouldStop()) {
      onStatus(`Google Maps pass finished - ${collected.length} businesses kept.`);
    }
  } finally {
    await closeActiveBrowser();
  }

  return collected;
}

/* ---------------- CLI: npm run scrape -- cafe "Austin, TX" --limit 10 ------- */

async function main(argv) {
  const args = argv.filter((value) => !value.startsWith("--"));
  const [category, city] = args;
  if (!category || !city) {
    console.error("Usage: npm run scrape -- <category> <city> [--limit N] [--all] [--headed]");
    return 1;
  }
  const limitFlag = argv.find((value) => value.startsWith("--limit"));
  const limit = limitFlag ? Number(limitFlag.split("=")[1] ?? argv[argv.indexOf(limitFlag) + 1]) || 10 : 10;

  let rows;
  try {
    rows = await scrape(category, city, {
      limit,
      onlyWithWebsite: !argv.includes("--all"),
      // --headed overrides the configured mode, for watching a headless deploy.
      ...(argv.includes("--headed") ? { headless: false } : {}),
    });
  } catch (error) {
    if (error instanceof BlockedError) {
      console.error(`\nBLOCKED: ${error.message}\nStopping. Try again later, or with a smaller search.`);
      return 2;
    }
    if (error instanceof ConsentRequired) {
      console.error(`\n${error.message}`);
      return 3;
    }
    throw error;
  }

  console.log(`\n${"-".repeat(70)}\n${rows.length} businesses\n${"-".repeat(70)}`);
  for (const row of rows) {
    console.log(`${row.name}\n   ${row.category} | ${row.rating} (${row.reviews} reviews)`);
    console.log(`   ${row.address}\n   ${row.phone}\n   ${row.website}\n`);
  }
  return 0;
}

// pathToFileURL, not string concatenation: on Windows a manual `file://` prefix
// yields file://D:/... while import.meta.url is file:///D:/..., so the CLI would
// never start. argv[1] is absent when this module is imported via `node -e`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

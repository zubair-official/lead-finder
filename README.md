# Lead Finder

Search Google Maps for businesses by category and city, keep the ones that list
a website, then visit each site to pull a contact email **and grade how much
work it needs**. Results stream into a sortable table as they're found, with
CSV and JSON export.

Built for web developers looking for clients: a cafe on plain HTTP with no
mobile layout and a 2017 copyright is a warmer lead than one with a current
site, and the tool ranks them that way.

Runs **headless by default** — no browser window opens. Node.js, Express and
Playwright; no database, no build step, no frontend framework.

![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![Express](https://img.shields.io/badge/express-5.x-lightgrey)
![Playwright](https://img.shields.io/badge/playwright-1.63-blue)
![Tests](https://img.shields.io/badge/tests-61%20passing-236B50)

---

## Why it exists

Finding local businesses that already have a website is a useful starting point
for freelance web work: they've shown they'll pay for one, and you can see what
they currently have. Google Maps has the listings but no export, and its Places
API returns no email addresses. So this does two passes — one over Maps for the
listings, one over each business's own site for the email.

> [!IMPORTANT]
> This is an unofficial, low-volume developer tool. It is not affiliated with
> or endorsed by Google. You are responsible for complying with applicable
> laws, website terms, robots.txt directives, and privacy requirements. The
> scraper stops when it encounters CAPTCHA, unusual-traffic, consent, or other
> blocking pages and does not try to bypass them.

## Contributing and security

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before
opening a pull request; it explains the test workflow and the scraper
safeguards that changes must preserve. Please use GitHub Discussions for usage
questions and the issue forms for reproducible bugs or focused features.

Report vulnerabilities privately through [GitHub Security
Advisories](https://github.com/zubair-official/lead_finder/security/advisories/new)
as described in [SECURITY.md](SECURITY.md). Do not post credentials, cookies,
browser profiles, or scraped lead data in a public issue.

## Quick start

```bash
npm install
```

```bash
npm start
```

Open <http://127.0.0.1:5000>, type a city, pick a category, hit **Search**.
Nothing visible happens on your desktop — Chromium runs in the background — and
rows appear in the table as they're found. **Export CSV** downloads exactly the
rows on screen.

Console-only, no web UI:

```bash
npm run scrape -- cafe "Austin, TX" --limit 10
```

Flags: `--all` keeps businesses with no website, `--headed` opens a visible
window so you can watch a run.

## Coverage: why one search is never "all of them"

Google Maps has no pagination. The results panel is an infinite-scroll feed
that lazy-loads about 20 listings at a time, and **Google caps a single query
at roughly 120 results** before it says "You've reached the end of the list" —
a limit no scraper can get around. On top of that, `MAX_RESULTS` (40 by
default) stops the run earlier still.

So covering a city means **several smaller searches, not one big one**.
Comma-separate areas in the city field and they run back-to-back, merged into
one list and deduplicated by name + address:

```
Gulberg Lahore, DHA Lahore, Model Town Lahore, Johar Town Lahore
```

`MAX_RESULTS` applies per area, so four areas at 40 gives up to 160 businesses.
Narrowing the category works the same way — `bbq`, `fast food` and `cafe` each
get their own ceiling.

Budget the time: each listing opens a detail panel and each website gets
visited, so roughly 6-10 seconds per business. Forty results is about 5 minutes;
a four-area sweep at 40 each is closer to half an hour.

### If a search stops early

The scroller waits up to `SCROLL_SETTLE_MS` (8s) after each scroll for Google
to deliver the next batch, and only stops after `SCROLL_STRIKES` (3)
consecutive scrolls with no new listings. On a slow connection, raise both —
an earlier 2-strike rule with no settle window was cutting runs short at ~18
results while Google was still loading.

```bash
SCROLL_SETTLE_MS=15000
SCROLL_STRIKES=5
PAUSE_MIN_MS=3000
PAUSE_MAX_MS=6000
```

`LOG_LEVEL=debug` prints the count after every scroll, which tells you whether
you are hitting Google's ceiling or your own.

## Lead scoring

The email pass already downloads each business's homepage, so grading the site
costs no extra requests. Each signal adds to an **opportunity score** out of
100 — higher means more wrong with the site, so a higher score is a better
prospect. Sort by the Score column to put the best leads on top.

| Signal | Points | What it means |
| --- | --- | --- |
| `unreachable` | 40 | They list a website that doesn't load at all |
| `social_only` | 35 | A Facebook/Instagram page standing in for a website |
| `no_https` | 25 | Still on plain `http://` |
| `no_viewport` | 20 | No mobile viewport, so almost certainly not responsive |
| `stale_copyright` | 12 | Copyright notice two or more years out of date |
| `missing_title` | 10 | No `<title>`, so nothing useful in search results |
| `slow` | 8 | Homepage took over 3 seconds |
| `site_builder` | 8 | Wix / Squarespace / GoDaddy / Weebly / WordPress |
| `no_description` | 5 | No meta description |

An empty Signals cell reads **clean** when the site was checked and nothing was
wrong, and **—** when it hasn't been graded yet. Those are different answers.

### Where it will not go

Website addresses come from Google Maps listings, which is third-party data.
Before any request the target is resolved and checked, and **private,
loopback, link-local and cloud-metadata addresses are refused** — including
when a public hostname redirects to one, since redirects are followed by hand
and every hop is re-checked. Page bodies are read up to `MAX_PAGE_BYTES`
rather than buffered whole. This matters most when self-hosting: a server that
will fetch any URL it is handed is a way into whatever else is on that network.

Found emails also get a DNS **MX lookup**, so a ✓ next to an address means the
domain can actually receive mail. That is not proof the mailbox exists, but it
catches scraped addresses on domains that never had mail configured.

## Run history

Every run is written to `runs/<jobId>.jsonl` as it happens, with a small
`.meta.json` sidecar recording what was searched. The **Past runs** panel lists
them newest first; click one to load it back into the table. Runs made before
this feature existed still list, just without a label.

## Configuration

Copy `.env.example` to `.env` and edit — it's loaded automatically (Node's
built-in loader, no `dotenv` dependency). Real environment variables win over
the file. Everything is optional.

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `5000` | `PORT=5001 npm start` for a one-off |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` |
| `HEADLESS` | `true` | `false`, or `HEADED=1`, opens a visible window |
| `USER_DATA_DIR` | `.browser-profile` | Persists cookies between runs; `""` for a throwaway profile |
| `MAX_RESULTS` | `40` | 1–200. Big runs are slow and raise your block risk |
| `MAX_SCROLLS` | `10` | How hard to work the results panel |
| `SCROLL_SETTLE_MS` | `8000` | How long to wait for a lazy-loaded batch before giving up |
| `SCROLL_STRIKES` | `3` | Consecutive no-growth scrolls before stopping |
| `PAUSE_MIN_MS` / `PAUSE_MAX_MS` | `2000` / `5000` | Delay between actions. **Floored at 1000ms** |
| `LOOKUP_EMAILS` | `true` | Turn off for a Maps-only run |
| `EMAIL_TIMEOUT_MS` | `10000` | Per-request timeout when fetching a business site |
| `MAX_PAGE_BYTES` | `2000000` | Ceiling on a fetched page body |
| `RESPECT_ROBOTS` | `true` | Leave it on |
| `RUNS_DIR` | `runs` | Where the incremental JSONL files go |

Bad values are clamped to a sane range and logged as a warning rather than
crashing mid-run. The pause floor is enforced regardless of what you set — see
[Etiquette](#etiquette).

### Headless and Google's consent screen

Headless is the default, but it removes the human who could click Google's
cookie/consent dialog. The tool will not click that dialog for you, so if it
appears in a headless run the search stops with an explanation instead of
hanging.

The fix is a one-time thing:

```bash
HEADED=1 npm start
```

Run one search, accept the dialog in the window that opens, then stop. The
consent cookie is saved in `.browser-profile/` and every later headless run
reuses it.

Note that headless Chromium is easier for Google to fingerprint, so blocks are
somewhat more likely than in headed mode. That makes the stop-on-CAPTCHA
behaviour below more important, not less.

## Deploying

**The app itself cannot run on a serverless or static-only host.** It
needs a long-lived process, a real Chromium, a writable disk and 5-15 minutes
per job; those platforms give none of the four. In particular the in-memory job
store means `POST /search` and `GET /status/:jobId` would land on different
function instances, so every poll returns 404.

What you can deploy:

| Where | What runs | Notes |
| --- | --- | --- |
| Any static file host | The demo in `dist/` | Real UI, sample data, no scraper |
| Render / Railway / Fly.io / a VPS | Everything | Use the `Dockerfile`; see the warning below |
| Your own machine | Everything | What it was built for |

### The static demo

```bash
npm run build:demo
```

```bash
npm run preview:demo
```

That writes `dist/index.html` — a single self-contained file. It is the real UI
with a shim over `fetch()` that answers the app's own endpoints from
`demo/sample-data.json`, so sorting, filtering, column toggles, CSV/JSON export
and the live row animations all run the same code as production. Clicking
Search replays a saved run on a timeline, phases and all.

The sample businesses are **fictional**, with reserved `555-01xx` numbers and
`.example` domains. Publishing invented quality scores about real, named
companies would be making public claims that might not be true.

Upload the generated `dist/` directory to any static file host. Set
`DEMO_REPO_URL` while building to put a GitHub link in the demo banner.

### Running it for real on a host

The `Dockerfile` works on any container host. Two things to weigh first:
datacenter IPs get blocked by Google far faster than a home connection, and a
public instance means anyone who finds the URL is scraping through your server,
under your account. Put authentication in front of it.

## Docker

```bash
docker build -t lead-finder .
```

```bash
docker run --rm -p 5000:5000 -v "$(pwd)/runs:/app/runs" lead-finder
```

The base image is `mcr.microsoft.com/playwright`, which already contains
Chromium and its system libraries. `/healthz` is wired up as the container
health check. A consent screen can't be answered inside a container, so if you
hit one, do the `HEADED=1` step above on your host once and mount the resulting
profile.

## Tests

```bash
npm test
```

52 tests on the built-in `node:test` runner — no test framework dependency.
They cover the things that actually break: Maps card text in both its signed-in
and signed-out shapes, sponsored-listing labels, private-use icon glyphs, email
extraction and its false positives, tracking-parameter stripping, duplicate
detection, website signal scoring, MX verification, and config validation
(including that the pause floor holds when someone sets it to zero). The Playwright half is verified by running a real
search.

## How it works

| File | Job |
| --- | --- |
| `server.js` | Express routes; runs each search in the background |
| `src/signals.js` | Grades a website from the HTML we already fetched |
| `src/verify.js` | DNS MX check for found email addresses |
| `src/config.js` | Environment parsing, validation and clamping |
| `src/logger.js` | Small levelled logger |
| `src/areas.js` | Splits "A, B, C" into separate searches |
| `src/maps.js` | Playwright pass over Google Maps |
| `src/emails.js` | Fetches each business's own site looking for an email |
| `src/store.js` | Job state, and the incremental write to `runs/` |
| `public/index.html` | The whole UI — form, live table, CSV export |
| `scripts/build-demo.mjs` | Builds the portable static demo in `dist/` |
| `demo/sample-data.json` | Fictional businesses used by that demo |

```
GET  /                -> the UI
GET  /api/config      -> categories, result cap, headless flag
GET  /api/runs        -> past runs, newest first
GET  /api/runs/:id    -> the rows of one saved run
GET  /healthz         -> { status, uptimeSeconds, searchInFlight, headless }
POST /search          -> { job_id }; starts a run, returns immediately, 409 if one is active
GET  /status/:jobId   -> { state, phase, message, results[] }; polled every 2s
POST /stop/:jobId     -> stop after the current listing
```

A search runs in two passes. The **Maps pass** scrolls the results panel, reads
each card, and opens a listing's detail panel when the card didn't show a
website or phone number. The **email pass** never touches Google: for each
business with a website it fetches the homepage, then `/contact`,
`/contact-us`, `/about`, stopping at the first address it finds. `robots.txt` is
checked first.

Every result is appended to `runs/<jobId>.jsonl` the moment it's scraped, so
pressing **Stop** — or killing the process — never loses what was found.

### Three details worth knowing

**Detail panels are confirmed before they're read.** Maps swaps panel contents
asynchronously, so the panel on screen right after a click is often still the
*previous* business. Reading it attaches one business's website and phone to
another. `waitForDetailPanel()` matches the panel's `aria-label` against the
listing that was clicked and skips rather than guess. This was a real bug: one
café was credited with the neighbouring coffee shop's website. Run with
`LOG_LEVEL=debug` and you can watch the panel lag by three polls before it
catches up.

**Emails are ranked, not first-match.** A `mailto:` link outranks a loose text
match, and an address on the business's own domain outranks the web designer's
address in the footer. It discards retina asset filenames (`logo@2x.png`),
Sentry and Wix keys, and placeholders like `you@example.com`. Plenty of sites
list no email — an empty column is a real answer, not a bug.

**Listings are deduplicated twice.** Google sometimes returns one business under
two different URLs (an ad slot plus the organic result), so a normalised
name + address key catches what the URL key misses.

### Frontend

One page, no framework. The table renders incrementally: new rows are appended
and highlighted, and cells are patched in place when the email pass fills them
in, so a 2-second poll doesn't rebuild or re-animate the whole table. Rows are
only reordered when the sort actually changes, because moving a `<tr>` restarts
its CSS animation. All animation is disabled under `prefers-reduced-motion`.

Sort by any column, filter across every field at once, show/hide columns (the
choice persists in `localStorage`), copy an email or phone number with one
click, and export what's on screen as CSV or JSON.

The palette is three colours — white, `#2563eb` for actions, `#236B50` for
success and found-email states — plus greys for text and borders. Both brand
colours pass WCAG AA on white (5.17:1 and 6.38:1) and carry white text at the
same ratios.

## Etiquette

These are deliberate. Limits are configurable; conduct is not:

- A randomised pause between every scroll and every detail panel, **never below
  1 second** however `PAUSE_MIN_MS` is set.
- One browser, one page, no parallel tabs — a second concurrent search gets a
  `409` rather than a queue slot.
- **If Google shows a CAPTCHA or an "unusual traffic" page, the run stops
  immediately** and says so. Nothing is retried, solved, or bypassed.
- Google's cookie/consent dialog is never clicked for you.

Two things to know before deploying this anywhere: scraping Maps results is
against Google's Terms of Service regardless of volume, and Google's markup
changes every few months. If a run suddenly returns nothing, the `SELECTORS`
object at the top of `src/maps.js` is the first place to look. This is built for
low-volume use — dozens of results per search, not thousands.

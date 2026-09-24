# Contributing

Thanks for helping improve Lead Finder. Small, focused pull requests are easiest to review.

## Before opening an issue

- Search existing issues and discussions first.
- Use Discussions for setup help, questions, and early ideas.
- Use an issue for a reproducible bug or an agreed feature.
- Remove business contact data, cookies, tokens, browser-profile files, and other sensitive information from logs and screenshots.

## Local setup

```bash
git clone https://github.com/zubair-official/lead_finder.git
cd lead_finder
npm install
npm test
```

Run the app with `npm start`. Build the static portfolio demo with `npm run build:demo` and preview it with `npm run preview:demo`.

## Pull requests

1. Create a branch from `main`.
2. Keep the change focused and explain the user-visible behavior.
3. Add or update tests for changed parsing, scoring, configuration, or deduplication logic.
4. Run `npm test` and, for UI/demo changes, `npm run build:demo`.
5. Do not commit `runs/`, `.browser-profile/`, `.env`, `dist/`, or `node_modules/`.

## Non-negotiable scraper boundaries

Contributions must keep these safeguards intact:

- one browser session and one page at a time;
- randomized pauses between scroll and detail actions, with an enforced floor;
- a finite result cap;
- immediate stop when Google displays CAPTCHA, unusual-traffic, consent, or blocking pages;
- no CAPTCHA solving, stealth plugins, proxy rotation, fingerprint spoofing, access-control bypasses, or attempts to evade rate limits;
- website inspection must respect `robots.txt` by default;
- outbound requests must refuse private, loopback, link-local, and
  cloud-metadata addresses, on every redirect hop.

Changes that remove or work around these boundaries will not be accepted.

## Code style

The project deliberately uses modern JavaScript, ES modules, the built-in `node:test` runner, and a framework-free frontend. Match the surrounding style, prefer plain functions, and avoid dependencies for behavior available in Node.js itself.


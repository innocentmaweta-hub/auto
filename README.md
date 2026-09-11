# Auto

Auto is a Windows desktop browser-automation recorder built with Electron and Playwright.

## What it does

1. Open Auto.
2. Enter a starting URL.
3. Click **Record**.
4. Use the browser normally: navigate, click, type, select and scroll.
5. Click **Stop recording**.
6. Choose how many times to replay the workflow.
7. Click **Run**.
8. Use **Until stopped** for a continuous run and **Stop run** when finished.
9. Save the workflow as JSON for reuse.

The recorder stores selectors and actions rather than relying only on mouse coordinates, making recorded workflows more reusable across runs.

## First setup on Windows

Install Node.js 20+ from the official Node.js website, then in this repository run:

```bash
npm install
npx playwright install chromium
npm start
```

For a Windows installer:

```bash
npm run build:win
```

The installer will be placed in `dist/`.

## Current v0.1 features

- Electron desktop GUI
- Playwright-managed Chromium browser
- Record navigation, clicks, text fields, selects and scrolling
- Replay a workflow a chosen number of times
- Continuous replay with a stop control
- Save workflows to JSON
- Password fields are not recorded by default

## Important limitation

This first version is intended for legitimate browser workflows, testing and repetitive tasks. It does not attempt to defeat CAPTCHAs, anti-bot systems, rate limits, access controls or other website security measures. Sites may also change their HTML, which can make a recorded selector need editing.

## Roadmap

- Edit individual recorded steps
- Delete/reorder steps
- Add explicit wait steps
- Variables and secure secrets
- Better selector fallbacks
- Workflow library
- Browser profile support
- Pause/resume
- Run history and error screenshots
- Improved installer and auto-update support

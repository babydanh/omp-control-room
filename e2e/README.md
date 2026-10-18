# Pixel Agents e2e tests

Playwright end-to-end tests for the Company board. This README is the single source of truth for what's e2e-tested, what's not, and how to run the suite.

## What this suite covers

One spec today: `e2e/tests/standalone/company.spec.ts` (`@area:company`). It drives a Company run in the browser: it plans, asks a question, waits for approval, then verifies the approved work. The owner process is a real `e2e/fixtures/company-host.ts`, and OMP is scripted by `e2e/fixtures/mock-omp-company.cjs`.

Each test carries an `@area:<tag>` in its title, and the inventory below groups tests by that tag.

## What's NOT covered (gaps + deferred)

Scenarios that exist as product behavior but are not in the automated suite. PRs that close a gap should remove the corresponding row.

| Scenario                                                                                 | Why not automated                                                                                                                            | Tracked                      |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| External asset directory add/remove via Settings                                         | Needs bundled test asset packs                                                                                                               | none                         |
| Bypass-permissions startup flag                                                          | Security-sensitive; manual review path                                                                                                       | none                         |
| Workspace folder add/remove mid-session                                                  | Edge case; infra-heavy                                                                                                                       | none                         |
| Producer/viewer relay scenarios (multi-viewer replay, producer reconnect reconciliation) | Producer endpoint not yet built                                                                                                              | `feat/producer-viewer-split` |

## Pre-release manual smoke

CI green on this suite is the safety net for behavioral regressions. The checks below are what e2e can't meaningfully assert on (visual polish, real-Claude integration, cross-process behaviors). Run them before tagging a Marketplace release — not on every PR.

**Real Claude Code integration** (mock-claude is a fixture; real Claude's JSONL has edge cases the mock doesn't):

- Use a session with a large pasted image (multi-MB base64 user message) — confirm the "Possible format issue" warning doesn't false-fire and tool tracking still works.
- Test with one MCP server installed — confirm `mcp_progress` records don't break tool status.

**`npx pixel-agents` standalone** (e2e covers Chrome via Playwright; verify other browsers + real workflow):

- `node dist/cli.js` (or `npx pixel-agents` after publish), open `http://localhost:3100` in Firefox AND Safari, run a real Claude session in a terminal — confirm agents appear and update via WebSocket.
- Refresh the browser mid-session — WebSocketTransport reconnects, agents reappear from server state.

**Platform sanity** (CI hosts ≠ your machine):

- On the OS you primarily develop on, run a normal session for ~5 minutes — confirm no surprise CPU spikes, no leaked file watchers, panel reload doesn't lose state.

## Running

```bash
cd pixel-agents
npm run compile && npm run e2e               # full suite

npm run e2e -- --grep "@area:company"        # filter by area tag
npm run e2e -- --headed                      # watch chromium for standalone test

npm run e2e:inventory                        # regenerate the inventory section below
npm run test:report                          # build the Allure dashboard from latest run
npm run test:report:open                     # serve + open the Allure dashboard in a browser
```

## What to read before adding a test

- `pixel-agents/CLAUDE.md` — architecture and message protocol
- `pixel-agents/e2e/fixtures/company-host.ts` — the owner process the Company spec drives
- `pixel-agents/e2e/helpers/company.ts` — spawns and tears down that host per test

When you add a new test:

- Pick a `test.describe` block that matches an existing `@area:` tag, OR add a new area to the "What this suite covers" section above and pick a tag.
- Add `@area:<tag>` to the test title.
- Run `npm run e2e:inventory` and commit the regenerated section.

When you remove a test:

- Run `npm run e2e:inventory` so the inventory drops it.
- If the scenario it tested is now manual or deferred, add a row to "What's NOT covered".

## Test inventory

This section is auto-generated. Do not edit between the markers; CI fails on drift.

<!-- BEGIN:E2E-INVENTORY -->

1 tests total. Generated by `scripts/generate-e2e-inventory.mjs`. Re-run after adding or removing tests.

### `@area:company` (1 tests)

- `e2e/standalone/company.spec.ts:14` — Company plans, asks, waits for approval, then verifies the approved work

<!-- END:E2E-INVENTORY -->

## Coverage philosophy

We do not measure e2e via code coverage (too noisy, doesn't map to user-observable scenarios). Coverage is tracked by:

1. **The inventory section above** — every test in the suite with its area tag and file:line.
2. **The "What's NOT covered" gap list** — deliberately maintained; closing a gap removes the corresponding row.
3. **Allure dashboard** — run `npm run test:report` after a suite run, then open `allure-report/allure/index.html`.

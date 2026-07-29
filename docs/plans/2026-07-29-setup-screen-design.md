# JIRA Timer — Setup screen & team onboarding

**Date:** 2026-07-29
**Goal:** Make a fresh clone self-explanatory, so teammates can run their own
instance against their own JIRA boards during an AI/Claude Code office-hours
session — and customize it afterwards.

## Context

The repo is public at `github.com/flpetho/jira-timer`. Today an unconfigured
visitor gets the full app chrome (board picker, empty story list) plus a thin
warn banner, which reads as broken rather than "not set up yet". Credentials come
from `.env.local`, which a fresh clone does not have at all.

The audience is teammates who may not have cloned a repo before. The screen is
therefore an **onboarding surface**, not a diagnostic for the author.

## Scope

1. A logged-out / not-configured screen with tailored states.
2. README quickstart written for a cloner, not the author.
3. `CLAUDE.md` so Claude Code can help them customize.
4. A friendly startup preflight for common stumbles.
5. Screenshots for the README (setup screen + timer with invented data).

Explicitly out of scope: in-browser credential entry. Credentials stay in
`.env.local`; the app never writes or stores a token itself.

## 1. Server: classify the connection state

`lib/jira.ts` replaces the bare `{ok, status, error}` with a discriminated reason.

```ts
export type ConnReason = 'ok' | 'unconfigured' | 'rejected' | 'unreachable';

export interface MyselfResult {
  ok: boolean;
  status: number;
  reason: ConnReason;
  missing: string[];       // env var NAMES only, never values
  baseUrl: string | null;  // non-secret; prefills the copy block
  devMode: boolean;        // NODE_ENV !== 'production' → save-and-wait vs restart
  name?: string; email?: string; error?: string;
}
```

Decision order in `getMyself()`:

1. Any of `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_API_TOKEN` unset →
   `unconfigured`, `missing` naming exactly which. No network call.
2. `401` or `403` → `rejected` (expired, revoked, or email/token mismatch).
3. Any other non-OK response, or a thrown fetch → `unreachable`, raw error attached.
4. Otherwise `ok`.

Two pure helpers carry the logic so they can be unit-tested without mocking the
network:

```ts
export function missingCreds(env: NodeJS.ProcessEnv): string[]
export function reasonForStatus(status: number): ConnReason
```

`isConfigured()` becomes `missingCreds(process.env).length === 0`, removing the
current duplicated definition of "configured".

`/api/me` needs no change — it returns `getMyself()` verbatim.

**Security:** `baseUrl`, `missing`, and `devMode` reach the browser; the token
never does. On a localhost-only server this adds no exposure — the browser
already learns the host from every successful call.

## 2. Client: `app/SetupScreen.tsx`

The header stays mounted; only the body swaps, so it reads as "the app, not set
up yet". Props: `me`, `timer`, `now`, `onRetry`, `onPause`.

| state | headline | body |
|---|---|---|
| `null` | Checking connection… | quiet line; prevents a flash of setup UI on load |
| `unconfigured` | Let's connect JIRA Timer | missing vars named, token link, copy block of only the missing lines, save-and-wait (dev) or restart (prod) |
| `rejected` | JIRA rejected your credentials | expired/revoked/mismatch causes, token link, token line only — skips the intro |
| `unreachable` | Couldn't reach `<host>` | check site URL, VPN, network; raw error in collapsed `<details>` |

Shared footer: the reassurance strip when `timer` has stories (total tracked,
story count, running story, Pause), then Retry plus a quiet "rechecking
automatically" note.

**Why the reassurance strip:** the timer persists to `~/.jira-timer/state.json`
and works without JIRA — only the story list and worklog posting need it. A
mid-session token expiry must not look like lost time, and pausing needs no
JIRA call.

**Polling:** `loadMe` currently polls every 60s, too slow while someone is
actively setting up. Poll every 5s while disconnected, 60s once connected.

**The payoff moment:** Next 14's dev bundler watches `.env` files, and `creds()`
reads `process.env` at call time — so in `npm run dev` a teammate pastes their
token, saves, and the 5s poll flips the screen to connected on its own. No
restart, no button. Production (launchd) still needs
`sh scripts/service.sh update`, which is why `devMode` is sent to the client.

Styling reuses existing dark tokens and `.banner`/`.card` classes in
`globals.css` rather than a parallel system.

## 3. README quickstart

Rewrite the top for someone landing on the GitHub page: prerequisites
(Node ≥ 18.17), `git clone` → `npm install` → `cp .env.example .env.local` →
`npm run dev`, how to find their own Atlassian site URL (the host in their
browser when JIRA is open), what to do if port 4100 is taken, and a
"customize it with Claude Code" section. The launchd service moves lower — it is
the author's setup, not a cloner's first step.

## 4. Preflight

A check before `npm run dev` with plain-English failures instead of stack traces:
missing `.env.local` (offer the copy command), Node too old, port 4100 in use.

## 5. Screenshots

Public repo, so no real JIRA data. The setup screen is safe by construction. For
the connected view, point `JIRA_BASE_URL` at a throwaway local mock serving
canned `myself` / `board` / `sprint` / `issue` responses with invented stories,
capture, then discard. The real token and `~/.jira-timer/state.json` are never
involved.

## Testing

- Unit (vitest): `missingCreds` across all eight present/absent combinations;
  `reasonForStatus` for 401/403/404/500/0.
- Unit: reassurance-strip totals derive from existing `activeSeconds`, already covered.
- Manual: each of the four screen states, driven by editing `.env.local`.
- Regression: existing 17 tests must stay green.

## Notes for implementation

- Port 4100 is occupied by the running launchd service. Test with
  `npm run dev -- -p 4101` so the author's live timer is never interrupted.
- Work on a feature branch in the main checkout, not a worktree: the launchd
  agent and `~/.jira-timer` are tied to this directory, and testing the real
  service matters more than isolation here.

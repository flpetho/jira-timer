# JIRA Timer — notes for Claude

A local single-user timer that tracks active time against JIRA stories and logs
the result as a worklog. Next.js 14 App Router, TypeScript, no database, no auth,
no state management library. Runs only on the user's machine.

## Commands

```bash
npm run dev        # localhost:4100 (runs scripts/preflight.mjs first)
npm test           # vitest, pure logic only
npx tsc --noEmit   # typecheck
npm run build      # production build
sh scripts/service.sh update   # rebuild + restart the always-on launchd agent
```

Port 4100 is often occupied by the user's always-on instance. Use
`npm run dev -- -p 4101` rather than stopping their timer — safe because dev
builds into `.next-dev` (see below).

## The one important design rule

**Time is stored as segments, never as a running total.** A `Segment` is
`{start, end}` with `end: null` meaning currently running. Active time is the sum
of segment durations (`lib/time.ts` → `activeSeconds`). This is the whole point
of the app: an idle window accrues nothing, so never compute elapsed time as
`now - firstStart`.

## Layout

```
app/
  page.tsx          Main UI. Client component, ~550 lines. Polls JIRA, owns all state.
  SetupScreen.tsx   Shown whenever JIRA isn't reachable. Explains how to connect.
  globals.css       All styling. CSS variables at the top; no framework.
  api/
    me/             Connection check + why it failed
    boards/         Board list + which to preselect
    stories/        Issues for a board's active sprint
    timer/          start / pause — local only, never calls JIRA
    done/           Post a worklog, optionally transition status
    transitions/    Available status transitions for a story
lib/
  jira.ts           All JIRA HTTP. Has `import 'server-only'`.
  conn.ts           Connection-state classification. Pure, no I/O, no server-only.
  time.ts           Segment maths and duration formatting.
  timer-logic.ts    Pure state transitions: startTimer, pauseActive, markDone.
  store.ts          Reads/writes ~/.jira-timer/state.json.
  types.ts          Shared types.
scripts/
  preflight.mjs     Friendly checks before `npm run dev`.
  serve.sh          Production server, launched by launchd.
  service.sh        start/stop/restart/status/update for the launchd agent.
```

## Things that will bite you

**`lib/jira.ts` cannot be imported from tests.** Its `import 'server-only'`
throws outside a server context. Anything that needs unit tests goes in a
separate module — that's why `lib/conn.ts` exists apart from `lib/jira.ts`.

**Timer actions must not depend on JIRA.** `/api/timer` only touches the local
state file. Keep it that way: the timer has to work when JIRA is down, and the
setup screen deliberately still offers a Pause button.

**Never let dev and production share a build directory.** `next dev` and
`next start` both default to `./.next`, so a dev server in this checkout would
overwrite the build the launchd agent is serving; it then 500s with
`MODULE_NOT_FOUND` on chunks that vanished, which in a browser looks like a blank
page. `next.config.js` sends dev to `.next-dev` to prevent exactly that. Don't
collapse the two.

**Changing the icon needs a version bump.** Browsers store favicons separately
from the HTTP cache and a hard reload won't clear it, so editing
`public/icon.svg` alone leaves the old artwork on screen. Bump `ICON_VERSION` in
`app/icon-version.ts`; both the `<link rel="icon">` and the manifest read from it.

**State lives outside the repo**, at `~/.jira-timer/state.json`. It's the user's
real tracked time. Never overwrite it while testing — set `HOME` to a temp dir to
get an isolated state file instead.

**Config comes only from env.** No JIRA instance, project key, or board is
hardcoded anywhere, and it should stay that way — the repo is public. Read
credentials through `creds()` in `lib/jira.ts` at call time, not at module load,
so that `next dev`'s `.env.local` reloading works.

**Values shipped in `.env.example` count as unconfigured.** `missingCreds` in
`lib/conn.ts` treats `paste-your-token-here` and friends as absent, so a
half-filled `.env.local` shows setup instructions rather than a confusing 401.

## Testing

`npm test` covers pure logic only: `lib/time.test.ts`, `lib/timer-logic.test.ts`,
`lib/conn.test.ts`. There are no component or HTTP tests — if you add a feature
with real logic in it, put that logic in a pure function in `lib/` and test it
there rather than reaching for a rendering harness.

To exercise the UI by hand, `npm run dev -- -p 4101` and edit `.env.local`; the
dev server reloads it and the browser reconnects within a few seconds.

## Style

Match what's there: named exports, no default exports outside `app/`, no comment
restating what code does — comments explain *why*, especially around the segment
model and anything JIRA's API does unexpectedly. Formatting is 2-space indent,
single quotes, trailing commas, ~100 column lines. No Prettier or ESLint config
ships with the repo, so follow the surrounding file.

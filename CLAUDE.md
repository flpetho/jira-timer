# JIRA Timer — notes for Claude

A local single-user timer that tracks active time against JIRA stories, attributes
it to activities, and logs the result as worklogs. Next.js 14 App Router,
TypeScript, vanilla CSS, no database, no auth, no state management library. Runs
only on the user's machine.

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

## The board is the layout

The page is the board's three columns, top to bottom in the order the board reads
them left to right: **To Do, In Progress, Done**, then a quiet **Tracked
elsewhere** group. A story's column comes from JIRA's `status.statusCategory.key`
(`new` / `indeterminate` / `done`) via `stageFor` — never from the status *name*,
which teams rename freely.

Two things follow from this that are easy to undo:

- **`getBoardIssues` splits on `statusCategory`, not `resolution`.** A story parked
  in the Done column with no resolution set is Done to everyone looking at the
  board; splitting on resolution filed it as open, where it contradicted the board.
- **Nothing is hoisted above the columns.** The story you're working on renders as
  a full card *inside its own column*, so its position can never disagree with the
  heading above it.

## Focused is not the same as active

`activeKey` is the story whose clock is running. **Focused** (`focusKey` in
`lib/stages.ts`) is the story showing its full readout — clock, activity
breakdown, estimate line — and it is deliberately *not* the same thing:
`pauseActive` sets `activeKey` to null, so keying the expanded card off the timer
alone made every one of those figures vanish the instant you stopped, and the only
route back was to start the clock again. Focus falls back to the most recently
worked open story, so stopping keeps the numbers on screen.

A third thing sits alongside those two: **open**. Any row can be opened into the
same card (`openCards` + `isOpen` in `page.tsx`), and the focused story is always
open. So the focused card has no Close button — there'd be nothing to collapse to.

An opened card may have **no timer at all** (`row.timer === null`) — a Done issue
someone finished without this app. That card still has a summary, status and
description worth reading, so it renders without a clock or bars rather than
bailing out. Guard on `story` before touching segments.

## The one important design rule

**Time is stored as segments, never as a running total.** A `Segment` is
`{start, end, activity?, logged?}` with `end: null` meaning currently running.
Active time is the sum of segment durations (`lib/time.ts` → `activeSeconds`).
This is the whole point of the app: an idle window accrues nothing, so never
compute elapsed time as `now - firstStart`.

`activity` labels a chunk; `logged` marks it as covered by a worklog. Both are
optional so state files written before those existed still load — see
`normalizeState`.

## Layout

```
app/
  page.tsx          Main UI. Client component, ~990 lines. Polls JIRA, owns all state.
  SetupScreen.tsx   Shown whenever JIRA isn't reachable. Explains how to connect.
  globals.css       All styling. Design tokens at the top; no framework.
  icon-version.ts   ICON_VERSION — bump when public/icon.svg changes.
  api/
    me/             Connection check, why it failed, and the activity list
    boards/         Boards you have work in; ?q= searches all of them
    stories/        Open + resolved issues for a board, or board=all to pool
    timer/          start / pause / relabel / discard — local only, never calls JIRA
    done/           Post one worklog per activity, optionally transition status
    transitions/    GET the available transitions; POST one, without logging time
lib/
  jira.ts           All JIRA HTTP. Has `import 'server-only'`.
  conn.ts           Connection-state classification. Pure, no I/O, no server-only.
  activities.ts     Activity parsing + apportioning a rounded total. Pure.
  stages.ts         Board columns: grouping, which story is focused, which
                    transition finishes a story. Pure.
  time.ts           Segment maths and duration formatting.
  timer-logic.ts    Pure state transitions and unlogged-time grouping.
  store.ts          Reads/writes ~/.jira-timer/state.json, normalising on read.
  types.ts          Shared types.
scripts/
  preflight.mjs     Friendly checks before `npm run dev`.
  serve.sh          Production server, launched by launchd.
  service.sh        start/stop/restart/status/update for the launchd agent.
```

## Things that will bite you

**`lib/jira.ts` cannot be imported from tests.** Its `import 'server-only'`
throws outside a server context. Anything that needs unit tests goes in a
separate module — that's why `lib/conn.ts` and `lib/activities.ts` exist apart
from `lib/jira.ts`.

**Three time quantities, easily conflated.** `tracked` (local segments),
`StoryTimer.loggedSeconds` (what *this app* sent), and `JiraIssue.secondsSpent`
(JIRA's total, including worklogs from before this app existed). Display uses
JIRA's total; `pendingLogSeconds` subtracts only our own. Swapping those would
cancel a user's pre-existing time against newly tracked work and silently log
nothing.

**Round the total, never the parts.** Done splits one rounded total across
activities (`apportion` in `lib/activities.ts`) using largest-remainder. Rounding
each activity separately inflates badly — three 2-minute chunks at a 5-minute
increment would log 15 minutes for 6 minutes of work, corrupting the
estimate-vs-actual data the tool exists to produce.

**Display grouping and logging grouping are different functions.** Three of them,
and mixing them up breaks something each way:

- `trackedByActivity` — **display.** *All* tracked time per activity, logged chunks
  included, with `loggedSeconds` marking the already-banked part. The card's clock
  counts everything, so this is the only one that adds up to it.
- `unloggedBreakdown` — display, unlogged only, running chunk in its own `Running`
  row. Still used where "what would Done send?" is the question.
- `unloggedByActivity` — **logging.** Folds the running chunk into `Unlabelled`. A
  worklog must never read "Running": by the time anything reaches JIRA the chunk is
  closed and genuinely unattributed.

`/api/done` must use `unloggedByActivity`. Pointing it at `trackedByActivity` would
re-send time JIRA already has on every Done.

**Relabelling and discarding have deliberately different reach.** Both ignore the
**open** segment — it isn't finished, the breakdown shows it as `Running` rather than
under a label, and stopping is what attributes it. They differ on logged time:

- `relabelActivity` **does** touch logged segments. Safe, because a logged segment is
  never re-sent (`unloggedByActivity` skips it, `pendingLogSeconds` subtracts it), so
  a label change is display-only. It cannot rewrite the comment on a worklog JIRA
  already holds, and the UI says so. Restricting it made every Done story — whose
  segments are all logged — permanently stuck showing "Unlabelled".
- `discardUnlogged` **must not**. Dropping a logged segment pulls `activeSeconds`
  below `loggedSeconds`, so the story shows less tracked time than it has already
  sent, and `pendingLogSeconds` is wrong from then on.

`discardUnlogged` also leaves `loggedSeconds` alone: those worklogs exist in JIRA
whatever happens locally.

**Unlogged time is summed from segments, never `tracked - loggedSeconds`.** Done
rounds (`TIMER_ROUND_MINUTES`) and then marks *every* closed segment logged, so a
story tracked for 7333s and logged as 7200s has 133s of pure rounding residue.
Subtracting totals counted that as unsent work: the row advertised "2m unlogged"
while the card's bars correctly showed nothing to resolve and `/api/done` refused to
send anything. `unloggedSeconds` sums the segments no worklog covers, which is the
figure all three agree on.

**JIRA's Done category includes cancellation.** Most boards have both `Done` and
`Cancelled` in `statusCategory = done`, and `/transitions` doesn't guarantee an
order — so `.find(t => t.toStage === 'done')` will sometimes arm the Done dialog to
write finished work off as cancelled. `preferredDoneTransition` exists to skip
those; it returns null rather than guessing when Cancelled is the only way in.

**Timer actions must not depend on JIRA.** `/api/timer` only touches the local
state file. Keep it that way: the timer has to work when JIRA is down, and the
setup screen deliberately still offers a Pause button. This is why starting the
clock on a To Do story *offers* to move it to In Progress through a separate
`POST /api/transitions` instead of transitioning as a side effect of starting.

**Never let dev and production share a build directory.** `next dev` and
`next start` both default to `./.next`, so a dev server in this checkout would
overwrite the build the launchd agent is serving; it then 500s with
`MODULE_NOT_FOUND` on chunks that vanished, which in a browser looks like a blank
page. `next.config.js` sends dev to `.next-dev` to prevent exactly that. Don't
collapse the two.

**`/rest/api/2/search` is 410 Gone on current JIRA Cloud.** Use
`/rest/api/3/search/jql`, which is token-paginated (`nextPageToken`, `isLast`) and
returns **no** `total`. Code that reads `total` from a search silently sees
`undefined` — that has already caused one wrong conclusion.

**Changing the icon needs a version bump.** Browsers store favicons separately
from the HTTP cache and a hard reload won't clear it, so editing
`public/icon.svg` alone leaves the old artwork on screen. Bump `ICON_VERSION` in
`app/icon-version.ts`; both the `<link rel="icon">` and the manifest read from it.

**State lives outside the repo**, at `~/.jira-timer/state.json`. It's the user's
real tracked time. Never overwrite it while testing — set `HOME` to a temp dir to
get an isolated state file instead.

**Config comes only from env.** No JIRA instance, project key, board, or activity
list is hardcoded anywhere, and it should stay that way — the repo is public. Read
credentials through `creds()` in `lib/jira.ts` at call time, not at module load,
so that `next dev`'s `.env.local` reloading works.

**Values shipped in `.env.example` count as unconfigured.** `missingCreds` in
`lib/conn.ts` treats `paste-your-token-here` and friends as absent, so a
half-filled `.env.local` shows setup instructions rather than a confusing 401.

## JIRA quirks worth knowing

- There is **no user→board endpoint**. `getMyBoards` bridges via projects: find
  the user's assigned issues, take their distinct projects, ask for each project's
  boards. This can include sibling boards holding none of their work — accepted,
  since it's a handful instead of the 405 the raw board list returns.
- `?name=` on `/rest/agile/1.0/board` filters server-side. Use it rather than
  downloading every board to filter locally.
- `/api/stories` fetches the Done column **and** everything before it, so Done can
  show sprint work finished without the timer. A story in neither list isn't on
  this board, which is what makes "does this board still have it?" answerable
  without an extra call — and all it answers, hence Tracked elsewhere.
- `statusCategory` works in the Agile board JQL, and `status.statusCategory` comes
  back inside the `status` field already being requested, so the columns cost no
  extra field and no extra call.
- `aggregatetimespent` rolls subtasks up; `timespent` doesn't, so a parent whose
  work happens in its subtasks reads as zero. Both are requested and the aggregate
  wins.
- Kanban boards return 400 from the active-sprint endpoint; that's treated as
  "no sprint", not an error.
- A worklog exposes only `comment` as a free-text field, and this instance has no
  Tempo, so the activity label goes in the comment. Nothing else per-worklog is
  visible in JIRA's UI.

## Design tokens

`globals.css` opens with the palette. Two rules that are easy to undo by accident:

- **One accent.** `--accent` is every interactive thing. `--warn` and `--danger`
  are only for things wanting attention. Green (`--ok`) is **status only** — the
  connection dot — and deliberately not a UI colour. Done used to be green while
  Start was blue, which put three colours on one card.
- **Neutrals are near-black at ~8% saturation.** They were 26%, which read as
  navy. Keep new surfaces in the same family rather than introducing a new tint.
- **Done recedes by losing its surface, not by changing colour.** `.row.receded`
  drops the panel so a finished story sits directly on the page and falls to
  `--faint`. That keeps "done" a different *class* of object without spending a
  colour on it, which matters because green is reserved for the connection dot.

## Testing

`npm test` covers pure logic only: `time`, `timer-logic`, `conn`, `activities`,
`stages` (113 tests). There are no component or HTTP tests — if you add a feature
with real logic in it, put that logic in a pure function in `lib/` and test it
there rather than reaching for a rendering harness. `lib/stages.ts` is the worked
example: the column grouping, focus fallback and transition choice are all pure and
all tested, leaving `page.tsx` to render what they return.

To exercise the UI by hand, `npm run dev -- -p 4101` and edit `.env.local`; the
dev server reloads it and the browser reconnects within a few seconds. For states
that need controlled data, point `JIRA_BASE_URL` at a small local mock and set
`HOME` to a temp dir so the real state file is untouched.

## Style

Match what's there: named exports, no default exports outside `app/`, no comment
restating what code does — comments explain *why*, especially around the segment
model and anything JIRA's API does unexpectedly. Formatting is 2-space indent,
single quotes, trailing commas, ~100 column lines. No Prettier or ESLint config
ships with the repo, so follow the surrounding file.

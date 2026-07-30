# The page as the board's columns

## The problem

The page had its own three groups — a hoisted active card, "Current iteration", and
"Completed" — and none of them were the board's. Two consequences:

1. **The app and the board disagreed.** "Completed" was built from
   `resolution != Unresolved`. A story parked in the Done column without a
   resolution set came back in the *open* query, so the board showed it Done and
   the app showed it under Current iteration.
2. **Stopping the clock hid the work.** `pauseActive` sets `activeKey` to null, and
   the expanded card was keyed off `activeKey`. Pausing collapsed the story to a
   one-line row, so the clock, the activity breakdown and the estimate line all
   disappeared. The only way to see time you had just measured was to start the
   clock again.

## The shape

Four groups, top to bottom in the order the board reads left to right:

```
ITERATION  Sprint 14

TO DO            2
  ┌──────────────────────────┐
  │ ACME-42   TO DO          │   the focused story: full card,
  │ 00:53:17                 │   rendered inside its own column
  │ Paused · time still here │
  │ [JIRA still has this in  │
  │  To Do]  [Move] [Not now]│
  │ [ Resume ]      [ Done ] │
  └──────────────────────────┘
  ┌ ACME-51  TO DO ──────────┐
  └──────────────────────────┘

IN PROGRESS      0
  Nothing in this column.

DONE             4
  ✓ ACME-38  DONE  2h in JIRA  2m unlogged
  ✓ ACME-31  DONE  5m in JIRA

TRACKED ELSEWHERE
  ✓ B-7  45m unlogged            [Log time]
```

Nothing is hoisted above the columns. The story you're working on is a full card
*inside* its column, so its position can't contradict the heading above it.

## Where a story's column comes from

`status.statusCategory.key` — `new` / `indeterminate` / `done` — mapped by
`stageFor`. Not the status *name*, which teams rename freely. The category arrives
nested inside the `status` field the app already requests, so the columns cost no
extra field and no extra call.

`getBoardIssues` splits on `statusCategory` rather than `resolution`, which is the
actual fix for (1) above.

## Tracked elsewhere

A story the timer recorded time against that appears in neither list isn't on this
board — moved, or dropped from the sprint. That's *all* the app knows: it can't
know the story's real column, because the columns it has are this board's.

So those stories get their own group rather than being folded into Done, which
would assert a state the app can't verify. Dropping them instead was rejected
outright: an earlier fix exists precisely to stop tracked time going invisible.

## Focused ≠ active

`activeKey` is the story whose clock is running. **Focused** is the story showing
its full readout, and the two are deliberately different — that's the fix for (2).
Focus is `activeKey`, or when nothing runs, the most recently worked story that the
board still has open. Done and off-board stories are never eligible: a finished
story shouldn't reclaim the big card just by being the last thing touched.

The card keeps its weight when paused; only the clock changes (`.clock.paused`,
`.card.active.is-paused`), plus a line saying the time is still counted.

## The activity bars

The card shows where its time went by category — always, not only while the clock
runs. Two suppressions used to prevent that:

- `collectUnlogged` skips chunks already sent to JIRA, so a story whose time had all
  been logged showed no categories at all.
- `ActivityBreakdown` returned null for a single category, on the reasoning that one
  row restated the clock above it.

Both hid the thing that's wanted. The clock gives a total; the bars give the shape
of it, and a lone row still names the category — which the clock can't. A breakdown
that dropped logged chunks also didn't add up to the clock directly above it, since
that counts all tracked time.

`trackedByActivity` is the display counterpart to the logging functions: every
tracked second per activity, with `loggedSeconds` recording how much of each is
already in JIRA. Each bar is split accordingly — the banked part at lower opacity,
the part Done will still send at full. Same accent throughout, so a bar reads as one
quantity rather than two colours competing. A unit test asserts the rows sum to
`activeSeconds`, which is what the clock shows.

The logging path is untouched: `/api/done` still uses `unloggedByActivity`, or every
Done would re-send time JIRA already has.

## Opening a story

Any collapsed row opens into the same card the focused story gets. Three states now
exist and they're distinct: **active** (clock running), **focused** (keeps its
readout, survives a pause), **open** (the user opened it). The focused story is
always open, which is why its card has no Close button.

The collapsed row lost its inline description in the process. It was the longest
thing a story had, and rendering it made a "row" as tall as a card — opening the
story is now how you read it.

A card may have no timer behind it at all, for a Done issue finished without this
app. It still opens; it just has no clock and no bars.

## Resolving unlogged time

An unlogged-time chip used to be a dead end: it told you time was unsent without
offering anything to do about it. Each breakdown row with unsent time now has a `⋯`
that opens two actions:

- **Move to…** — reattribute the time to another activity, or back to Unlabelled.
  The fix for a chunk stopped without a label, or labelled wrongly.
- **Remove…** — throw it away, behind a confirm that names the amount.

Neither touches the **running** chunk: it isn't finished, and stopping is what
attributes it. They differ on logged time, on purpose.

**Relabelling reaches logged time.** It has to. Done marks every closed segment
logged, so a rule of "unlogged only" left every finished story stuck displaying
"Unlabelled" with no way to fix it — which is exactly what turned up in the Done
column. It's safe because a logged segment is never re-sent (`unloggedByActivity`
skips it, `pendingLogSeconds` subtracts it), so the change is display-only. What it
can't do is rewrite the comment on a worklog JIRA already holds, and the panel says
so plainly: "already logged — renaming it here won't change JIRA's worklog".

**Discarding does not.** Dropping a logged segment would pull `activeSeconds` below
`loggedSeconds`, leaving a story showing less tracked time than it has already sent
and breaking `pendingLogSeconds` permanently. So Remove appears only where there's
unsent time, and where a category is partly logged the panel scopes it: "only the 45m
not yet sent can be removed".

`discardUnlogged` leaves `loggedSeconds` untouched either way. Those worklogs exist
in JIRA regardless of what happens locally.

Both are local-only actions on `/api/timer`, so they hold the rule that timer actions
never depend on JIRA.

## The unlogged figure was overstating itself

`unlogged` used to be `tracked - loggedSeconds`. Done rounds to
`TIMER_ROUND_MINUTES` and *then* marks every closed segment logged, so a story
tracked for 7333s and logged as 7200s carries 133s of pure rounding residue.
Subtracting totals counted that as unsent work, which produced a genuine
contradiction on screen: the row advertised "2m unlogged", the card's bars showed
every category fully logged with nothing to resolve, and `/api/done` refused to send
anything at all.

`unloggedSeconds` sums the segments no worklog covers. All three now agree, and the
misleading chip is gone.

## Changing status

The expanded card carries a status control listing every transition JIRA offers, in
either direction — including moving something back out of Done. The running-timer
nudge stays, because it's proactive at the moment it matters; this covers the rest
without putting a control on every collapsed row.

This is what the "story has time but sits in To Do" case needed. Though often the
better fix there is discarding the stray time: a story with 16 seconds on it from a
mis-start isn't really in progress.

## Starting work on a To Do story

Starting the clock on something JIRA still calls To Do offers a one-click move to
In Progress. Offered, never automatic: `/api/timer` must keep working when JIRA is
unreachable, so the transition goes through a separate `POST /api/transitions` that
the user asks for. Dismissible, and absent entirely when the story has no
transition into the In Progress column.

## The Done visual

Done and off-board rows **lose their surface**: the panel drops away so the row sits
directly on the page, text falls to `--faint`, and a `✓` leads the line. A finished
story becomes a different class of object rather than a dimmer copy of the same one.

Deliberately no colour: `--ok` green is reserved for the connection dot, and the
palette runs on one accent. Losing the surface says "settled" without spending one.

## Bugs closed alongside

- **Done left stories open.** The dialog defaulted to "leave status unchanged", so
  finished work sat in In Progress. It now preselects a transition into Done —
  through `preferredDoneTransition`, which skips `Cancelled`, `Rejected`, `Won't
  Do` and friends. JIRA's Done *category* covers abandonment as well as
  completion, and `/transitions` doesn't guarantee an order, so taking the first
  match would sometimes have armed the dialog to write finished work off as
  cancelled. When that's the only route into Done it preselects nothing.
- **The same figure printed twice.** Once tracked time equalled logged time, the
  focused card's clock, its estimate line and a "N in JIRA" chip all showed the
  same number. The chip is gone; the two lines below it already carried both
  figures. The "Not logged to JIRA" badge went too — the neighbouring
  "N unlogged" chip says it, with the amount.
- **Subtask time was invisible.** `timespent` counts only the issue itself, so a
  parent whose work happens in its subtasks read as zero. `aggregatetimespent` is
  requested too and wins.

## Testing

The grouping, the focus fallback and the transition choice are pure functions in
`lib/stages.ts` with 31 unit tests; `trackedByActivity`, `relabelActivity`,
`discardUnlogged` and `unloggedSeconds` add 24 more to `timer-logic` — keeping
`page.tsx` to rendering what they return. 113 tests total.

The write paths were exercised end to end against a seeded state file under an
isolated `HOME`, never the real one: relabelling merged Unlabelled into an existing
category, removing cleared the segments while leaving `loggedSeconds` intact, and a
fully-logged category correctly offered no resolve affordance at all.

Verified against the live board: `statusCategory` is accepted in the Agile board
JQL, the columns came back 2 / 0 / 4 with no error, and the Done dialog preselected
`Done → Done` rather than `Cancelled`. Moving a story to "In Test" in JIRA moved it
from To Do to In Progress in the app without any mapping for that status name, which
is the point of grouping on the category.

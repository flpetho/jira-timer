# Activity breakdown within a story

**Date:** 2026-07-29
**Goal:** Attribute tracked time to activities (meeting, building, testing) within a
single story, so a designer can see where a story's hours actually went.

## Constraint

This JIRA has no Tempo (`/rest/tempo-core/*` and `/rest/tempo-timesheets/*` both
404), so there is no work-attribute API. A worklog exposes only:

```
self, author, updateAuthor, comment, created, updated,
started, timeSpent, timeSpentSeconds, id, issueId
```

Issue-level custom fields named "Category" exist but tag the whole issue, not a
chunk of time. The only per-chunk field that is visible in JIRA's UI is the
worklog **comment**. So the activity label lives there, and one worklog per
activity gives both a correct total and a visible breakdown.

## Data model

```ts
interface Segment {
  start: number;
  end: number | null;
  activity?: string | null;  // absent on existing data → "Unlabelled"
  logged?: boolean;          // already covered by a worklog
}
```

Both fields optional, so existing `state.json` files need no migration.

`StoryTimer.loggedSeconds` keeps its current meaning — the amount **this app** has
sent — so the JIRA reconciliation built earlier is unaffected.

## Rounding

`TIMER_ROUND_MINUTES` rounds the total, exactly as today. Rounding each activity
independently would inflate badly: three 2-minute chunks at a 5-minute increment
would log 15 minutes for 6 minutes of work, corrupting the estimate-vs-actual data
the tool exists to produce.

Instead Done computes the amount to send with the existing
`pendingLogSeconds(tracked, loggedByUs, roundMinutes)`, then apportions that
amount across activities by their share of raw unlogged time, using the
largest-remainder method at whole-minute granularity so the parts sum exactly to
the total:

```
raw: Building 30m, Meeting 12m, Testing 5m   (47m)
round(47m) − alreadyLogged = 45m to send
apportion → Building 29m, Meeting 11m, Testing 5m   (= 45m)
```

Groups that apportion to zero are dropped rather than posted, since JIRA rejects a
zero-length worklog. The remaining parts still sum to the total.

## Activities

`JIRA_ACTIVITIES` in `.env.local`, comma separated. Unset gives a default of
`Meeting, Building, Testing, Review, Other`. Explicitly blank turns the feature
off, so Pause behaves exactly as it does today — a designer's list can differ
entirely from an engineer's.

## Interaction

While a timer runs, the active card offers one button per activity under "Stop and
log as…". Clicking one closes the current segment, tags it, and stops the clock in
a single action. Plain Pause remains for stepping away and leaves the chunk
unlabelled; unlabelled time is shown as such and can be attributed later. The
story stays open either way — only Done writes to JIRA.

Beneath the card, the story's time so far is listed per activity, including an
"Unlabelled" row when applicable.

## Repeat logging

Segments already covered by a worklog carry `logged: true` and are excluded from
the next grouping, so a second Done only breaks down new chunks. Combined with
`pendingLogSeconds`, this keeps the no-double-logging guarantee intact.

## Testing

Pure and unit-testable, in `lib/activities.ts`:

- `parseActivities` — unset default, explicit blank, trimming, dedupe, empties
- `apportion` — exact sums, proportional split, largest-remainder tie handling,
  more groups than whole minutes, zero total, whole-minute parts

Plus `timer-logic` coverage for tagging a segment on pause, grouping unlogged
segments by activity, and marking segments logged.

# Time the timer never saw, and the gap between iterations

Three problems that surfaced from a story created and logged against entirely in JIRA,
then dragged into the current sprint.

## 1. A story with hours on it showed no time at all

A story created in JIRA — 4h estimated, 1h already logged — arrived in the In Progress
column. Opening it showed a card with no clock and no bars, visibly emptier than every
story beside it, despite JIRA holding an hour against it.

The cause is that the hour was logged **in JIRA**, not by this timer, so there was no
local `StoryTimer` and the card's clock and breakdown were both behind a
`story && …` guard.

**`trackedByActivity` now takes JIRA's `secondsSpent`** and turns whatever this app
didn't send into a trailing **Untracked** row: time logged before the timer existed, by
someone else, or in JIRA directly. It also accepts a null story, which is exactly this
case.

That fixed a quieter bug at the same time. The card prints "N spent" immediately above
the bars, taken from JIRA — so whenever JIRA knew more than the app had sent, the bars
silently failed to add up to the number right above them.

**The clock stays out of it.** It reads 00:00:00, and that's deliberate: the clock means
"what this timer measured". Showing JIRA's hour there would imply an hour of local
unsent work, which is the conflation the three-quantities rule exists to prevent, and it
would make the unlogged figure wrong. The hour belongs in the estimate line and the bar.

**Untracked is display-only.** No local segments sit behind it, so it offers neither
relabel nor remove — there is nothing to change. `canRelabel` excludes it.

## 2. The sprint was never the problem

The worry was that the app would stay pinned to a named sprint and go blind when that
sprint closed. It doesn't: only the *board* is persisted, and `getActiveSprint` re-reads
`state=active` from JIRA on every poll. The current iteration is followed automatically
and there is no setting to go stale.

Two real edges did turn up:

- It takes `values[0]`, so a board with **parallel active sprints** silently gets one of
  them. Latent, not yet reachable.
- **Between iterations** — one sprint closed, the next not started — `getActiveSprint`
  returns null and `getBoardIssues` falls back to *every issue on the board*. That's
  correct for Kanban and wrong for scrum: it turns the columns into an undifferentiated
  backlog with no sign that anything has changed.

Only the board's `type` distinguishes the two, since JIRA reports no sprint for both.
The board list lives client-side, so that's where the decision is made. The heading now
reads **Between iterations** and the fallback is put behind *"Show all N issues on the
board"* rather than filling the columns — with a line saying the columns will fill in on
their own when the next sprint starts, because they will.

## 3. Controls moved when a card opened

`Start` sat on the right of a collapsed row but bottom-left on an open one, so both it
and the disclose arrow jumped as a story was opened or closed.

Collapsed rows are now content plus the disclose arrow on the top line, with actions
beneath at bottom-left — the same arrangement as an open card, where Close is top-right
and the actions are bottom-left. Neither control moves. Rows with nothing to do get no
action strip at all rather than an empty one.

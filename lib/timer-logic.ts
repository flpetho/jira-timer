import type { TimerState, StoryTimer, JiraIssue } from './types';
import { roundSeconds } from './time';
import { UNLABELLED, RUNNING, type ActivityRaw } from './activities';

export type IssueMeta = Pick<JiraIssue, 'key' | 'summary' | 'status' | 'assignee' | 'estimateSeconds'>;

export function emptyState(): TimerState {
  return { activeKey: null, stories: {} };
}

function ensureStory(state: TimerState, issue: IssueMeta): StoryTimer {
  const existing = state.stories[issue.key];
  if (existing) {
    existing.summary = issue.summary;
    existing.status = issue.status;
    existing.assignee = issue.assignee;
    // Only adopt JIRA's estimate if we don't already have one recorded.
    if (existing.estimateSeconds == null) existing.estimateSeconds = issue.estimateSeconds;
    return existing;
  }
  const created: StoryTimer = {
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    assignee: issue.assignee,
    estimateSeconds: issue.estimateSeconds,
    segments: [],
    doneAt: null,
    worklogId: null,
    loggedSeconds: null,
  };
  state.stories[issue.key] = created;
  return created;
}

/**
 * Close the open segment on the active story, if any, and clear activeKey.
 * `activity` labels the chunk that just ended — omitted when simply stepping away,
 * which leaves it unlabelled to be attributed later.
 */
export function pauseActive(state: TimerState, now: number, activity?: string): TimerState {
  const key = state.activeKey;
  if (key) {
    const story = state.stories[key];
    const last = story?.segments[story.segments.length - 1];
    if (last && last.end === null) {
      last.end = now;
      if (activity) last.activity = activity;
    }
  }
  state.activeKey = null;
  return state;
}

export interface ActivityRow extends ActivityRaw {
  /** True for the chunk still accruing. Display concern only. */
  running?: boolean;
}

/**
 * Unlogged tracked time per activity. Segments already covered by a worklog are
 * excluded, so a second Done only breaks down new work.
 *
 * `splitRunning` separates the open segment into its own row, pinned first — the
 * display wants it distinguished and in a fixed position, while logging wants it
 * folded into Unlabelled like any other unattributed chunk.
 */
function collectUnlogged(story: StoryTimer, now: number, splitRunning: boolean): ActivityRow[] {
  const totals = new Map<string, number>();
  let runningSeconds = 0;

  for (const seg of story.segments) {
    if (seg.logged) continue;
    const isOpen = seg.end === null;
    const seconds = Math.max(0, Math.round(((seg.end ?? now) - seg.start) / 1000));
    if (seconds <= 0) continue;

    if (splitRunning && isOpen) {
      runningSeconds += seconds;
      continue;
    }
    const name = seg.activity?.trim() || UNLABELLED;
    totals.set(name, (totals.get(name) ?? 0) + seconds);
  }

  // First-seen order for the rest, so labelling something doesn't reshuffle the list.
  const rows: ActivityRow[] = [...totals.entries()].map(([activity, seconds]) => ({
    activity,
    seconds,
  }));
  return runningSeconds > 0
    ? [{ activity: RUNNING, seconds: runningSeconds, running: true }, ...rows]
    : rows;
}

/** For logging: the open chunk counts as Unlabelled, same as any unattributed time. */
export function unloggedByActivity(story: StoryTimer, now: number): ActivityRaw[] {
  return collectUnlogged(story, now, false);
}

/** For display: the running chunk is its own row, always first. */
export function unloggedBreakdown(story: StoryTimer, now: number): ActivityRow[] {
  return collectUnlogged(story, now, true);
}

/**
 * Backfill the `logged` flag for state written before activities existed.
 *
 * Those stories were logged as one lump, so their segments carry no flag; without
 * this, resuming one would count its already-sent time as unlogged and over-report
 * what Done will add. A story with `doneAt` and a logged total had all its closed
 * segments covered, so marking them is accurate.
 *
 * Idempotent, and safe to run on every read: `startTimer` clears `doneAt`, so
 * segments added after a resume are never caught by it.
 */
export function normalizeState(state: TimerState): TimerState {
  for (const story of Object.values(state.stories)) {
    if (story.doneAt == null || (story.loggedSeconds ?? 0) <= 0) continue;
    for (const seg of story.segments) {
      if (seg.end !== null && seg.logged === undefined) seg.logged = true;
    }
  }
  return state;
}

/** Mark every unlogged segment as covered, once its time has been sent. */
export function markSegmentsLogged(story: StoryTimer): void {
  for (const seg of story.segments) {
    if (seg.end !== null) seg.logged = true;
  }
}

/** Start or resume the timer on a story: pause whatever is active, then open a fresh segment. */
export function startTimer(state: TimerState, issue: IssueMeta, now: number): TimerState {
  pauseActive(state, now);
  const story = ensureStory(state, issue);
  story.doneAt = null; // resuming un-completes
  // loggedSeconds and worklogId are deliberately KEPT. Any worklog we already
  // pushed still exists in JIRA, so forgetting it here would re-send that time
  // on the next Done. pendingLogSeconds() subtracts it instead.
  story.segments.push({ start: now, end: null });
  state.activeKey = issue.key;
  return state;
}

/**
 * How many seconds to send to JIRA now: the rounded total minus whatever we've
 * already logged. Rounding the total rather than the delta keeps repeated logs
 * consistent with what a single log at the end would have produced.
 *
 * Zero or negative means there's nothing new to log.
 */
export function pendingLogSeconds(
  activeSecs: number,
  alreadyLogged: number,
  roundMinutes: number,
): number {
  return roundSeconds(activeSecs, roundMinutes) - alreadyLogged;
}

/**
 * Mark a story done: close its segment(s) and record the worklog we just pushed.
 * `loggedSeconds` accumulates, because JIRA keeps every worklog — the story's
 * logged total is the sum, not the size of the latest one.
 */
export function markDone(
  state: TimerState,
  key: string,
  now: number,
  worklogId: string,
  loggedSeconds: number,
): TimerState {
  if (state.activeKey === key) {
    pauseActive(state, now);
  } else {
    const story = state.stories[key];
    const last = story?.segments[story.segments.length - 1];
    if (last && last.end === null) last.end = now;
  }
  const story = state.stories[key];
  if (story) {
    story.doneAt = now;
    story.worklogId = worklogId;
    story.loggedSeconds = (story.loggedSeconds ?? 0) + loggedSeconds;
    // Everything closed is now covered by a worklog; a later Done starts fresh.
    markSegmentsLogged(story);
  }
  return state;
}

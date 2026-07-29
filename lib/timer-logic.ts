import type { TimerState, StoryTimer, JiraIssue } from './types';
import { roundSeconds } from './time';

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

/** Close the open segment on the active story, if any, and clear activeKey. */
export function pauseActive(state: TimerState, now: number): TimerState {
  const key = state.activeKey;
  if (key) {
    const story = state.stories[key];
    const last = story?.segments[story.segments.length - 1];
    if (last && last.end === null) last.end = now;
  }
  state.activeKey = null;
  return state;
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
  }
  return state;
}

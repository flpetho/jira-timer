import { describe, it, expect } from 'vitest';
import {
  emptyState,
  startTimer,
  pauseActive,
  markDone,
  pendingLogSeconds,
  unloggedByActivity,
  unloggedBreakdown,
  trackedByActivity,
  relabelActivity,
  discardUnlogged,
  unloggedSeconds,
  normalizeState,
} from './timer-logic';
import type { TimerState } from './types';
import { activeSeconds } from './time';
import type { IssueMeta } from './timer-logic';

const M = 60 * 1000;
const issue = (key: string, over?: Partial<IssueMeta>): IssueMeta => ({
  key,
  summary: `${key} summary`,
  status: 'To Do',
  assignee: 'Ferenc',
  estimateSeconds: null,
  ...over,
});

describe('startTimer', () => {
  it('creates a story, sets it active, opens one segment', () => {
    const s = startTimer(emptyState(), issue('TEST-67'), 1000);
    expect(s.activeKey).toBe('TEST-67');
    expect(s.stories['TEST-67'].segments).toEqual([{ start: 1000, end: null }]);
  });

  it('switching stories pauses the first', () => {
    let s = startTimer(emptyState(), issue('TEST-67'), 0);
    s = startTimer(s, issue('TEST-68'), 5 * M);
    expect(s.activeKey).toBe('TEST-68');
    expect(s.stories['TEST-67'].segments).toEqual([{ start: 0, end: 5 * M }]);
    expect(activeSeconds(s.stories['TEST-67'].segments, 99 * M)).toBe(300);
  });

  it('adopts a JIRA estimate only when none is stored', () => {
    let s = startTimer(emptyState(), issue('TEST-67', { estimateSeconds: 3600 }), 0);
    expect(s.stories['TEST-67'].estimateSeconds).toBe(3600);
    s = pauseActive(s, M);
    s = startTimer(s, issue('TEST-67', { estimateSeconds: 7200 }), 2 * M);
    expect(s.stories['TEST-67'].estimateSeconds).toBe(3600); // unchanged
  });
});

describe('pause + resume', () => {
  it('accumulates across pause/resume, ignoring the paused gap', () => {
    let s = startTimer(emptyState(), issue('TEST-67'), 0);
    s = pauseActive(s, 10 * M); // worked 10m
    expect(s.activeKey).toBeNull();
    s = startTimer(s, issue('TEST-67'), 60 * M); // resume 50m later
    s = pauseActive(s, 65 * M); // worked 5m more
    const secs = activeSeconds(s.stories['TEST-67'].segments, 999 * M);
    expect(secs).toBe(15 * 60); // 10m + 5m, NOT 65m wall-clock
    expect(s.stories['TEST-67'].segments).toHaveLength(2);
  });
});

describe('markDone', () => {
  it('closes the active segment and records the worklog', () => {
    let s = startTimer(emptyState(), issue('TEST-67'), 0);
    s = markDone(s, 'TEST-67', 20 * M, '90210', 20 * 60);
    const story = s.stories['TEST-67'];
    expect(s.activeKey).toBeNull();
    expect(story.doneAt).toBe(20 * M);
    expect(story.worklogId).toBe('90210');
    expect(story.loggedSeconds).toBe(1200);
    expect(story.segments[0].end).toBe(20 * M);
  });

  it('closes a dangling segment even when the story is not the active one', () => {
    let s = startTimer(emptyState(), issue('TEST-67'), 0);
    s = startTimer(s, issue('TEST-68'), 5 * M); // 67 paused, 68 active
    s = markDone(s, 'TEST-67', 30 * M, '1', 300);
    expect(s.activeKey).toBe('TEST-68'); // 68 still running
    expect(s.stories['TEST-67'].doneAt).toBe(30 * M);
  });

  it('accumulates logged time across repeated Done presses', () => {
    let s = startTimer(emptyState(), issue('TEST-67'), 0);
    s = markDone(s, 'TEST-67', 10 * M, 'w1', 600); // logged 10m
    s = startTimer(s, issue('TEST-67'), 20 * M); // reopened, worked more
    s = markDone(s, 'TEST-67', 30 * M, 'w2', 600); // logged 10m more
    // JIRA now holds two worklogs totalling 20m, so our record must agree.
    expect(s.stories['TEST-67'].loggedSeconds).toBe(1200);
  });
});

describe('reopening a completed story', () => {
  it('clears doneAt so it is back in play', () => {
    let s = startTimer(emptyState(), issue('TEST-67'), 0);
    s = markDone(s, 'TEST-67', 10 * M, 'w1', 600);
    expect(s.stories['TEST-67'].doneAt).toBe(10 * M);
    s = startTimer(s, issue('TEST-67'), 20 * M);
    expect(s.stories['TEST-67'].doneAt).toBeNull();
    expect(s.activeKey).toBe('TEST-67');
  });

  it('keeps the already-logged total, so resuming cannot double-log', () => {
    // The worklog is already in JIRA. Forgetting it here would re-send that time.
    let s = startTimer(emptyState(), issue('TEST-67'), 0);
    s = markDone(s, 'TEST-67', 10 * M, 'w1', 600);
    s = startTimer(s, issue('TEST-67'), 20 * M);
    expect(s.stories['TEST-67'].loggedSeconds).toBe(600);
  });
});

describe('activity attribution', () => {
  it('labels the chunk that just ended, not the whole story', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 30 * M, 'Meeting');
    s = startTimer(s, issue('TEST-1'), 40 * M);
    s = pauseActive(s, 100 * M, 'Building');
    expect(s.stories['TEST-1'].segments.map((g) => g.activity)).toEqual(['Meeting', 'Building']);
  });

  it('leaves a plain pause unlabelled', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 30 * M);
    expect(s.stories['TEST-1'].segments[0].activity).toBeUndefined();
  });

  it('totals unlogged time per activity, bucketing unlabelled chunks', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M, 'Meeting');
    s = startTimer(s, issue('TEST-1'), 20 * M);
    s = pauseActive(s, 50 * M, 'Building');
    s = startTimer(s, issue('TEST-1'), 60 * M);
    s = pauseActive(s, 65 * M); // no label
    s = startTimer(s, issue('TEST-1'), 70 * M);
    s = pauseActive(s, 80 * M, 'Meeting'); // same activity again — must merge
    expect(unloggedByActivity(s.stories['TEST-1'], 99 * M)).toEqual([
      { activity: 'Meeting', seconds: 20 * 60 },
      { activity: 'Building', seconds: 30 * 60 },
      { activity: 'Unlabelled', seconds: 5 * 60 },
    ]);
  });

  it('excludes chunks already covered by a worklog', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M, 'Meeting');
    s = markDone(s, 'TEST-1', 10 * M, 'w1', 600);
    expect(unloggedByActivity(s.stories['TEST-1'], 10 * M)).toEqual([]);

    s = startTimer(s, issue('TEST-1'), 20 * M);
    s = pauseActive(s, 35 * M, 'Building');
    // Only the new chunk, so a second Done can't re-send the meeting.
    expect(unloggedByActivity(s.stories['TEST-1'], 35 * M)).toEqual([
      { activity: 'Building', seconds: 15 * 60 },
    ]);
  });
});

describe('unloggedBreakdown (display)', () => {
  it('pins the running chunk first and keeps it out of Unlabelled', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M, 'Meeting');
    s = startTimer(s, issue('TEST-1'), 20 * M);
    s = pauseActive(s, 25 * M); // stopped without a label — a real gap
    s = startTimer(s, issue('TEST-1'), 30 * M); // still running
    const rows = unloggedBreakdown(s.stories['TEST-1'], 45 * M);
    // Running first regardless of when its segment was opened.
    expect(rows[0]).toEqual({ activity: 'Running', seconds: 15 * 60, running: true });
    expect(rows.slice(1)).toEqual([
      { activity: 'Meeting', seconds: 10 * 60 },
      { activity: 'Unlabelled', seconds: 5 * 60 },
    ]);
  });

  it('omits the running row when nothing is running', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M, 'Meeting');
    const rows = unloggedBreakdown(s.stories['TEST-1'], 20 * M);
    expect(rows.some((r) => r.running)).toBe(false);
  });
});

describe('relabelActivity', () => {
  it('attributes a chunk that was stopped without a label', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M); // no label
    s = relabelActivity(s, 'TEST-1', 'Unlabelled', 'Building');
    expect(trackedByActivity(s.stories['TEST-1'], 20 * M)).toEqual([
      { activity: 'Building', seconds: 10 * 60, loggedSeconds: 0 },
    ]);
  });

  it('moves time from one activity to another', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M, 'Meeting');
    s = relabelActivity(s, 'TEST-1', 'Meeting', 'Review');
    expect(trackedByActivity(s.stories['TEST-1'], 20 * M)).toEqual([
      { activity: 'Review', seconds: 10 * 60, loggedSeconds: 0 },
    ]);
  });

  it('merges into an activity that already has time', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M, 'Building');
    s = startTimer(s, issue('TEST-1'), 20 * M);
    s = pauseActive(s, 25 * M); // unlabelled
    s = relabelActivity(s, 'TEST-1', 'Unlabelled', 'Building');
    expect(trackedByActivity(s.stories['TEST-1'], 30 * M)).toEqual([
      { activity: 'Building', seconds: 15 * 60, loggedSeconds: 0 },
    ]);
  });

  it('clearing a label back to Unlabelled removes it rather than writing the word', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M, 'Meeting');
    s = relabelActivity(s, 'TEST-1', 'Meeting', 'Unlabelled');
    expect(s.stories['TEST-1'].segments[0].activity).toBeNull();
  });

  // Every Done story has all its segments logged, so refusing to touch logged time
  // left "Unlabelled" rows on finished work permanently unfixable.
  it('relabels logged time too, keeping it marked as logged', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M, 'Meeting');
    s = markDone(s, 'TEST-1', 10 * M, 'w1', 10 * 60);
    s = relabelActivity(s, 'TEST-1', 'Meeting', 'Building');
    expect(trackedByActivity(s.stories['TEST-1'], 20 * M)).toEqual([
      { activity: 'Building', seconds: 10 * 60, loggedSeconds: 10 * 60 },
    ]);
  });

  // Safe precisely because a logged segment is never re-sent: relabelling one must
  // not resurrect it into the next worklog.
  it('relabelling logged time gives a later Done nothing new to send', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M, 'Meeting');
    s = markDone(s, 'TEST-1', 10 * M, 'w1', 10 * 60);
    s = relabelActivity(s, 'TEST-1', 'Meeting', 'Building');
    expect(unloggedByActivity(s.stories['TEST-1'], 20 * M)).toEqual([]);
    expect(unloggedSeconds(s.stories['TEST-1'], 20 * M)).toBe(0);
    expect(s.stories['TEST-1'].loggedSeconds).toBe(10 * 60);
  });

  it('relabels a partly-logged category as a whole', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M, 'Meeting');
    s = markDone(s, 'TEST-1', 10 * M, 'w1', 10 * 60);
    s = startTimer(s, issue('TEST-1'), 20 * M);
    s = pauseActive(s, 35 * M, 'Meeting');
    s = relabelActivity(s, 'TEST-1', 'Meeting', 'Building');
    expect(trackedByActivity(s.stories['TEST-1'], 40 * M)).toEqual([
      { activity: 'Building', seconds: 25 * 60, loggedSeconds: 10 * 60 },
    ]);
  });

  it('leaves the running chunk alone — stopping is what labels it', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = relabelActivity(s, 'TEST-1', 'Unlabelled', 'Building');
    expect(s.stories['TEST-1'].segments[0].activity).toBeUndefined();
    expect(s.stories['TEST-1'].segments[0].end).toBeNull();
  });

  it('is a no-op for an unknown story or activity', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M, 'Meeting');
    const before = JSON.stringify(s);
    s = relabelActivity(s, 'NOPE-1', 'Meeting', 'Building');
    s = relabelActivity(s, 'TEST-1', 'Testing', 'Building');
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe('unloggedSeconds', () => {
  // The bug this replaced: `tracked - loggedSeconds` counted the rounding residue as
  // unsent work, so a fully-logged story advertised "2m unlogged" that /api/done
  // would then refuse to send.
  it('is zero once every segment is logged, whatever the rounding did', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 0 + 7333 * 1000);
    // Done rounded 7333s down to 7200s and marked the segment covered.
    s = markDone(s, 'TEST-1', 7333 * 1000, 'w1', 7200);
    const story = s.stories['TEST-1'];
    expect(activeSeconds(story.segments, 8000 * 1000) - (story.loggedSeconds ?? 0)).toBe(133);
    expect(unloggedSeconds(story, 8000 * 1000)).toBe(0);
  });

  it('counts only the chunks no worklog covers', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M, 'Meeting');
    s = markDone(s, 'TEST-1', 10 * M, 'w1', 10 * 60);
    s = startTimer(s, issue('TEST-1'), 20 * M);
    s = pauseActive(s, 35 * M, 'Building');
    expect(unloggedSeconds(s.stories['TEST-1'], 40 * M)).toBe(15 * 60);
  });

  it('includes the chunk still running', () => {
    const s = startTimer(emptyState(), issue('TEST-1'), 0);
    expect(unloggedSeconds(s.stories['TEST-1'], 5 * M)).toBe(5 * 60);
  });

  it('is zero for a story with no segments', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M, 'Building');
    s = discardUnlogged(s, 'TEST-1', 'Building');
    expect(unloggedSeconds(s.stories['TEST-1'], 20 * M)).toBe(0);
  });
});

describe('discardUnlogged', () => {
  it('throws away a mis-start', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 16 * 1000); // 16 seconds, unlabelled
    s = discardUnlogged(s, 'TEST-1', 'Unlabelled');
    expect(s.stories['TEST-1'].segments).toEqual([]);
    expect(activeSeconds(s.stories['TEST-1'].segments, 60 * M)).toBe(0);
  });

  it('removes only the named activity', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M, 'Meeting');
    s = startTimer(s, issue('TEST-1'), 20 * M);
    s = pauseActive(s, 40 * M, 'Building');
    s = discardUnlogged(s, 'TEST-1', 'Meeting');
    expect(trackedByActivity(s.stories['TEST-1'], 50 * M)).toEqual([
      { activity: 'Building', seconds: 20 * 60, loggedSeconds: 0 },
    ]);
  });

  // The worklog exists in JIRA whatever happens to the local segments, so the
  // record of what we sent must survive.
  it('never discards logged time, and keeps loggedSeconds intact', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M, 'Meeting');
    s = markDone(s, 'TEST-1', 10 * M, 'w1', 10 * 60);
    s = discardUnlogged(s, 'TEST-1', 'Meeting');
    expect(s.stories['TEST-1'].segments).toHaveLength(1);
    expect(s.stories['TEST-1'].loggedSeconds).toBe(10 * 60);
  });

  it('leaves the running chunk alone', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = discardUnlogged(s, 'TEST-1', 'Unlabelled');
    expect(s.stories['TEST-1'].segments).toHaveLength(1);
  });

  it('discarding everything unlogged leaves nothing for Done to send', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 30 * M, 'Building');
    s = discardUnlogged(s, 'TEST-1', 'Building');
    const story = s.stories['TEST-1'];
    expect(pendingLogSeconds(activeSeconds(story.segments, 40 * M), 0, 5)).toBe(0);
  });
});

describe('trackedByActivity (display)', () => {
  it('groups every tracked chunk by activity, logged or not', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M, 'Meeting');
    s = markDone(s, 'TEST-1', 10 * M, 'w1', 10 * 60);
    s = startTimer(s, issue('TEST-1'), 20 * M);
    s = pauseActive(s, 50 * M, 'Building');
    expect(trackedByActivity(s.stories['TEST-1'], 60 * M)).toEqual([
      { activity: 'Meeting', seconds: 10 * 60, loggedSeconds: 10 * 60 },
      { activity: 'Building', seconds: 30 * 60, loggedSeconds: 0 },
    ]);
  });

  // The case that showed nothing at all before: a story whose time has all been
  // sent to JIRA. unloggedBreakdown returns [] for it by design.
  it('still reports categories once everything has been logged', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 40 * M, 'Building');
    s = markDone(s, 'TEST-1', 40 * M, 'w1', 40 * 60);
    expect(unloggedBreakdown(s.stories['TEST-1'], 50 * M)).toEqual([]);
    expect(trackedByActivity(s.stories['TEST-1'], 50 * M)).toEqual([
      { activity: 'Building', seconds: 40 * 60, loggedSeconds: 40 * 60 },
    ]);
  });

  it('splits a partly-logged category into logged and not', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M, 'Building');
    s = markDone(s, 'TEST-1', 10 * M, 'w1', 10 * 60);
    s = startTimer(s, issue('TEST-1'), 20 * M);
    s = pauseActive(s, 35 * M, 'Building');
    expect(trackedByActivity(s.stories['TEST-1'], 40 * M)).toEqual([
      { activity: 'Building', seconds: 25 * 60, loggedSeconds: 10 * 60 },
    ]);
  });

  it('pins the running chunk first and never calls it logged', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M, 'Meeting');
    s = markDone(s, 'TEST-1', 10 * M, 'w1', 10 * 60);
    s = startTimer(s, issue('TEST-1'), 20 * M); // still running
    const rows = trackedByActivity(s.stories['TEST-1'], 35 * M);
    expect(rows[0]).toEqual({
      activity: 'Running',
      seconds: 15 * 60,
      loggedSeconds: 0,
      running: true,
    });
    expect(rows[1]).toEqual({ activity: 'Meeting', seconds: 10 * 60, loggedSeconds: 10 * 60 });
  });

  it('sums to the same total the clock shows', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 10 * M, 'Meeting');
    s = markDone(s, 'TEST-1', 10 * M, 'w1', 10 * 60);
    s = startTimer(s, issue('TEST-1'), 20 * M);
    const story = s.stories['TEST-1'];
    const rows = trackedByActivity(story, 45 * M);
    const summed = rows.reduce((n, r) => n + r.seconds, 0);
    expect(summed).toBe(activeSeconds(story.segments, 45 * M));
  });

  it('reports nothing for a story with no tracked time', () => {
    const s = emptyState();
    s.stories['TEST-1'] = {
      key: 'TEST-1',
      summary: 'x',
      status: 'To Do',
      assignee: null,
      estimateSeconds: null,
      segments: [],
      doneAt: null,
      worklogId: null,
      loggedSeconds: null,
    };
    expect(trackedByActivity(s.stories['TEST-1'], 0)).toEqual([]);
  });

  it('keeps Running out of what gets logged', () => {
    // The worklog for an open, unattributed chunk must say Unlabelled — by the
    // time anything is logged the chunk is closed and genuinely unattributed.
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    const forLogging = unloggedByActivity(s.stories['TEST-1'], 30 * M);
    expect(forLogging).toEqual([{ activity: 'Unlabelled', seconds: 30 * 60 }]);
    expect(forLogging.some((g) => g.activity === 'Running')).toBe(false);
  });
});

describe('normalizeState', () => {
  it('backfills logged on segments written before activities existed', () => {
    // Shape of an old state file: logged as one lump, no per-segment flags.
    const old: TimerState = {
      activeKey: null,
      stories: {
        'TEST-1': {
          key: 'TEST-1',
          summary: 's',
          status: 'To Do',
          assignee: null,
          estimateSeconds: null,
          segments: [{ start: 0, end: 60 * M }],
          doneAt: 60 * M,
          worklogId: 'w1',
          loggedSeconds: 3600,
        },
      },
    };
    expect(normalizeState(old).stories['TEST-1'].segments[0].logged).toBe(true);
  });

  it('leaves an unlogged story alone', () => {
    let s = startTimer(emptyState(), issue('TEST-1'), 0);
    s = pauseActive(s, 30 * M, 'Building');
    expect(normalizeState(s).stories['TEST-1'].segments[0].logged).toBeUndefined();
  });
});

describe('pendingLogSeconds', () => {
  it('is the whole rounded total when nothing was logged yet', () => {
    expect(pendingLogSeconds(20 * 60, 0, 5)).toBe(20 * 60);
  });

  it('subtracts what JIRA already has', () => {
    // 20m of work, 5m already logged -> only 15m is new.
    expect(pendingLogSeconds(20 * 60, 5 * 60, 5)).toBe(15 * 60);
  });

  it('is zero or less when no new time has accrued', () => {
    expect(pendingLogSeconds(5 * 60, 5 * 60, 5)).toBe(0);
    expect(pendingLogSeconds(23, 5 * 60, 5)).toBe(0); // 23s rounds up to the 5m already logged
  });

  it('rounds the total, not the delta, so repeated logs stay consistent', () => {
    // 12m actual rounds to 10m; 5m already logged leaves 5m new, not 7m.
    expect(pendingLogSeconds(12 * 60, 5 * 60, 5)).toBe(5 * 60);
  });

  it('counts only our own worklogs, never JIRA total time spent', () => {
    // Someone logged 3h in JIRA before installing the timer, then tracks 40m here.
    // `alreadyLogged` must stay "what this app sent" (0), so the full 40m is new.
    // Passing JIRA's 3h total would yield a negative and silently log nothing.
    const trackedHere = 40 * 60;
    const loggedByThisApp = 0;
    expect(pendingLogSeconds(trackedHere, loggedByThisApp, 5)).toBe(40 * 60);

    const jiraTotalIncludingExternal = 3 * 3600;
    expect(pendingLogSeconds(trackedHere, jiraTotalIncludingExternal, 5)).toBeLessThan(0);
  });
});

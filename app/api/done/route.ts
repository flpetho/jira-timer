import { NextResponse } from 'next/server';
import { readState, writeState } from '@/lib/store';
import { markDone, pendingLogSeconds, unloggedByActivity } from '@/lib/timer-logic';
import { apportion } from '@/lib/activities';
import { activeSeconds } from '@/lib/time';
import { addWorklog, doTransition } from '@/lib/jira';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const key = body?.key as string | undefined;
  const transitionId = body?.transitionId as string | undefined;
  const note = (body?.note as string | undefined)?.trim();

  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 });

  const state = await readState();
  const story = state.stories[key];
  if (!story) return NextResponse.json({ error: `no timer for ${key}` }, { status: 404 });

  const now = Date.now();
  const roundMin = parseInt(process.env.TIMER_ROUND_MINUTES || '5', 10);
  const raw = activeSeconds(story.segments, now);
  // Log only what JIRA doesn't have yet. A story can legitimately be logged more
  // than once — reopened in JIRA, or simply worked on again after a first Done —
  // and every worklog we pushed still counts, so re-sending it would double up.
  const alreadyLogged = story.loggedSeconds ?? 0;
  const rounded = pendingLogSeconds(raw, alreadyLogged, roundMin);

  if (rounded <= 0) {
    return NextResponse.json(
      {
        error: alreadyLogged
          ? `No new time to log — ${Math.round(alreadyLogged / 60)}m is already in JIRA.`
          : 'no active time recorded to log',
        loggedSeconds: alreadyLogged,
      },
      { status: 400 },
    );
  }

  const startedMs = story.segments[0]?.start ?? now;
  const suffix = note ? `${note} (via jira-timer)` : 'Tracked via jira-timer';

  // One worklog per activity, so the breakdown is visible in JIRA's Work Log tab.
  // `rounded` is apportioned rather than each activity being rounded on its own,
  // which would inflate the total (three 2m chunks -> three 5m worklogs).
  const groups = unloggedByActivity(story, now);
  const shares = apportion(rounded, groups);
  const posts =
    shares.length > 0
      ? shares.map((s) => ({ seconds: s.seconds, comment: `${s.activity} — ${suffix}` }))
      : [{ seconds: rounded, comment: suffix }];

  try {
    const ids: string[] = [];
    // Sequential on purpose: JIRA recomputes timespent per worklog, and concurrent
    // writes to the same issue have been known to drop one.
    for (const p of posts) {
      const { id } = await addWorklog(key, p.seconds, p.comment, startedMs);
      ids.push(id);
    }
    if (transitionId) await doTransition(key, transitionId);
    markDone(state, key, now, ids[ids.length - 1], rounded);
    await writeState(state);
    return NextResponse.json({
      ok: true,
      worklogId: ids[ids.length - 1],
      worklogIds: ids,
      loggedSeconds: rounded,
      breakdown: shares,
      state,
    });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

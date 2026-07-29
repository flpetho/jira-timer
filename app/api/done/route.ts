import { NextResponse } from 'next/server';
import { readState, writeState } from '@/lib/store';
import { markDone, pendingLogSeconds } from '@/lib/timer-logic';
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
  const comment = note ? `${note} (via jira-timer)` : 'Tracked via jira-timer';

  try {
    const { id } = await addWorklog(key, rounded, comment, startedMs);
    if (transitionId) await doTransition(key, transitionId);
    markDone(state, key, now, id, rounded);
    await writeState(state);
    return NextResponse.json({ ok: true, worklogId: id, loggedSeconds: rounded, state });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

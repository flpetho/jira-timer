import { NextResponse } from 'next/server';
import { readState, writeState } from '@/lib/store';
import { markDone } from '@/lib/timer-logic';
import { activeSeconds, roundSeconds } from '@/lib/time';
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
  if (story.worklogId && story.doneAt) {
    return NextResponse.json(
      { error: 'already logged', worklogId: story.worklogId, loggedSeconds: story.loggedSeconds },
      { status: 409 },
    );
  }

  const now = Date.now();
  const roundMin = parseInt(process.env.TIMER_ROUND_MINUTES || '5', 10);
  const raw = activeSeconds(story.segments, now);
  const rounded = roundSeconds(raw, roundMin);

  if (rounded <= 0) {
    return NextResponse.json({ error: 'no active time recorded to log' }, { status: 400 });
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

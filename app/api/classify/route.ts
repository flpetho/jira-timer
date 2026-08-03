import { NextResponse } from 'next/server';
import { readState, writeState } from '@/lib/store';
import { classifiable, labelClassifiable, markClassified } from '@/lib/timer-logic';
import { addWorklog } from '@/lib/jira';

export const dynamic = 'force-dynamic';

/**
 * File the time since the last stop under an activity, and send it to JIRA.
 *
 * Deliberately its own route rather than another `/api/timer` action: this one calls
 * JIRA, and `/api/timer` has to keep working when JIRA is unreachable.
 *
 * Order matters. The label is written to state *before* the request and the logged
 * flag only *after* it succeeds, so a failed push leaves the chunk filed but still
 * pending — the next classify, or Done, sends it under the label it already has.
 * Nothing is lost and nothing is double-sent.
 *
 * The worklog carries the chunk's exact length. Rounding each classification would
 * inflate the total badly — see the note in lib/activities.ts — so rounding is left
 * to Done's leftover sweep, where a single bucket makes it safe.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const key = (body?.key as string | undefined)?.trim();
  const activity = (body?.activity as string | undefined)?.trim();

  if (!key || !activity) {
    return NextResponse.json({ error: 'key and activity required' }, { status: 400 });
  }

  const state = await readState();
  const story = state.stories[key];
  if (!story) return NextResponse.json({ error: `no timer for ${key}` }, { status: 404 });

  // Where the work began, for JIRA's worklog date — read before labelling so it
  // reflects the earliest chunk being filed.
  const startedMs = classifiable(story)[0]?.start ?? Date.now();

  const seconds = labelClassifiable(state, key, activity);
  if (seconds <= 0) {
    return NextResponse.json(
      { error: 'Nothing to file yet — stop the timer first.', state },
      { status: 400 },
    );
  }
  await writeState(state);

  try {
    const { id } = await addWorklog(key, seconds, `${activity} — Tracked via jira-timer`, startedMs);
    markClassified(state, key, seconds, id);
    await writeState(state);
    return NextResponse.json({ ok: true, worklogId: id, loggedSeconds: seconds, state });
  } catch (e: unknown) {
    const reason = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      {
        // The label stuck; only the send failed. Say both, so the state on screen
        // (filed, still unsent) makes sense.
        error: `Filed as ${activity}, but JIRA wouldn't take the worklog: ${reason}`,
        pending: true,
        state,
      },
      { status: 502 },
    );
  }
}

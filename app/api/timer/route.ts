import { NextResponse } from 'next/server';
import { readState, writeState } from '@/lib/store';
import {
  startTimer,
  pauseActive,
  relabelActivity,
  discardUnlogged,
  type IssueMeta,
} from '@/lib/timer-logic';

export const dynamic = 'force-dynamic';

// Local timer state only — fast (a single JSON file read), no JIRA calls.
export async function GET() {
  return NextResponse.json(await readState());
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const action = body?.action as string | undefined;
  const now = Date.now();
  const state = await readState();

  if (action === 'start') {
    const issue = body?.issue as IssueMeta | undefined;
    if (!issue?.key) {
      return NextResponse.json({ error: 'start requires an issue' }, { status: 400 });
    }
    startTimer(state, issue, now);
  } else if (action === 'pause') {
    // An activity labels the chunk that just ended. Absent means "stepping away",
    // which leaves it unlabelled so it can be attributed later.
    const activity = (body?.activity as string | undefined)?.trim() || undefined;
    pauseActive(state, now, activity);
  } else if (action === 'relabel' || action === 'discard') {
    // Fixing up time the timer already measured. Still no JIRA call: these only
    // change what a future Done would send, never what it already sent.
    const key = (body?.key as string | undefined)?.trim();
    const activity = (body?.activity as string | undefined)?.trim();
    if (!key || !activity) {
      return NextResponse.json({ error: `${action} requires key and activity` }, { status: 400 });
    }
    if (!state.stories[key]) {
      return NextResponse.json({ error: `no timer for ${key}` }, { status: 404 });
    }
    if (action === 'relabel') {
      const to = body?.to as string | undefined;
      if (to == null) {
        return NextResponse.json({ error: 'relabel requires to' }, { status: 400 });
      }
      relabelActivity(state, key, activity, to);
    } else {
      discardUnlogged(state, key, activity);
    }
  } else {
    return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  }

  await writeState(state);
  // Return the whole state so the client can update instantly, no refetch.
  return NextResponse.json(state);
}

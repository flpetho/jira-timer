import { NextResponse } from 'next/server';
import { readState, writeState } from '@/lib/store';
import { startTimer, pauseActive, type IssueMeta } from '@/lib/timer-logic';

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
  } else {
    return NextResponse.json({ error: `unknown action: ${action}` }, { status: 400 });
  }

  await writeState(state);
  // Return the whole state so the client can update instantly, no refetch.
  return NextResponse.json(state);
}

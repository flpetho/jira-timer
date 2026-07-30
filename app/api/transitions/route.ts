import { NextResponse } from 'next/server';
import { doTransition, getTransitions } from '@/lib/jira';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get('key');
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 });
  try {
    const transitions = await getTransitions(key);
    return NextResponse.json({ transitions });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

/**
 * Move a story's status without logging any time — what `/api/done` does, minus the
 * worklog. Kept apart from the timer routes so that starting or pausing a timer
 * still needs nothing from JIRA.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const key = body?.key as string | undefined;
  const transitionId = body?.transitionId as string | undefined;
  if (!key || !transitionId) {
    return NextResponse.json({ error: 'key and transitionId required' }, { status: 400 });
  }
  try {
    await doTransition(key, transitionId);
    return NextResponse.json({ ok: true });
  } catch (e: unknown) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

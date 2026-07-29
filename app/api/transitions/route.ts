import { NextResponse } from 'next/server';
import { getTransitions } from '@/lib/jira';

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

import { NextResponse } from 'next/server';
import { getMyself } from '@/lib/jira';

export const dynamic = 'force-dynamic';

export async function GET() {
  const me = await getMyself();
  return NextResponse.json(me);
}

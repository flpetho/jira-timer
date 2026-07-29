import { NextResponse } from 'next/server';
import { getBoards } from '@/lib/jira';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const boards = await getBoards();
    // Which board the UI preselects. JIRA_BOARD_MATCH is a case-insensitive
    // substring of the board name (not a regex — a typo shouldn't 502 the list).
    const match = process.env.JIRA_BOARD_MATCH?.trim().toLowerCase();
    const matched = match
      ? boards.find((b) => b.name.toLowerCase().includes(match))?.id
      : undefined;
    const defaultBoardId = matched ?? boards[0]?.id ?? null;
    return NextResponse.json({ boards, defaultBoardId });
  } catch (e: unknown) {
    return NextResponse.json(
      { boards: [], defaultBoardId: null, error: e instanceof Error ? e.message : String(e) },
      { status: 502 },
    );
  }
}

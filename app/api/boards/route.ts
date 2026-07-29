import { NextResponse } from 'next/server';
import { getBoards, getMyBoards, searchBoards } from '@/lib/jira';
import type { JiraBoard } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Where the returned list came from, so the UI can label it honestly. */
export type BoardScope = 'mine' | 'search' | 'all';

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams.get('q')?.trim() ?? '';

  try {
    let boards: JiraBoard[];
    let scope: BoardScope;

    if (q) {
      // Name search runs on JIRA's side, so this reaches every visible board
      // without us pulling the whole list down.
      boards = await searchBoards(q);
      scope = 'search';
    } else {
      boards = await getMyBoards();
      scope = 'mine';
      // A brand-new account with nothing assigned would otherwise see an empty
      // picker and have no way forward.
      if (boards.length === 0) {
        boards = await getBoards();
        scope = 'all';
      }
    }

    // Which board the UI preselects. JIRA_BOARD_MATCH is a case-insensitive
    // substring of the board name (not a regex — a typo shouldn't 502 the list).
    // Skipped while searching: the user is choosing, not being chosen for.
    const match = process.env.JIRA_BOARD_MATCH?.trim().toLowerCase();
    const matched = match
      ? boards.find((b) => b.name.toLowerCase().includes(match))?.id
      : undefined;
    const defaultBoardId = scope === 'search' ? null : matched ?? boards[0]?.id ?? null;

    return NextResponse.json({ boards, defaultBoardId, scope });
  } catch (e: unknown) {
    return NextResponse.json(
      {
        boards: [],
        defaultBoardId: null,
        scope: q ? 'search' : 'mine',
        error: e instanceof Error ? e.message : String(e),
      },
      { status: 502 },
    );
  }
}

import { NextResponse } from 'next/server';
import { getAllMyBoardIssues, getBoardIssues, isConfigured } from '@/lib/jira';
import type { JiraIssue, JiraSprint } from '@/lib/types';

export const dynamic = 'force-dynamic';

// JIRA issues for the selected board's current iteration, or for every board the
// user has work in when board=all. Deliberately does NOT touch the local timer
// store, so timer actions never wait on a JIRA call.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const boardParam = url.searchParams.get('board');
  const allBoards = boardParam === 'all';
  const boardId = allBoards ? null : Number(boardParam) || null;
  const mineOnly = url.searchParams.get('mine') !== 'false';

  const configured = isConfigured();
  let issues: JiraIssue[] = [];
  let doneIssues: JiraIssue[] = [];
  let sprint: JiraSprint | null = null;
  let boardCount = 0;
  let jiraError: string | null = null;

  if (configured && (allBoards || boardId)) {
    try {
      if (allBoards) {
        const result = await getAllMyBoardIssues(mineOnly);
        issues = result.issues;
        doneIssues = result.doneIssues;
        boardCount = result.boards.length;
        // No single current iteration exists across boards.
        sprint = null;
      } else {
        const result = await getBoardIssues(boardId as number, mineOnly);
        issues = result.issues;
        doneIssues = result.doneIssues;
        sprint = result.sprint;
        boardCount = 1;
      }
    } catch (e: unknown) {
      jiraError = e instanceof Error ? e.message : String(e);
    }
  }

  return NextResponse.json({
    configured,
    jiraError,
    boardId,
    allBoards,
    boardCount,
    sprint,
    mineOnly,
    issues,
    doneIssues,
  });
}

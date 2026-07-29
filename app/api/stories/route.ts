import { NextResponse } from 'next/server';
import { getBoardIssues, isConfigured } from '@/lib/jira';
import type { JiraIssue, JiraSprint } from '@/lib/types';

export const dynamic = 'force-dynamic';

// JIRA issues for the selected board's current iteration. Deliberately does NOT
// touch the local timer store, so timer actions never wait on a JIRA call.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const boardId = Number(url.searchParams.get('board')) || null;
  const mineOnly = url.searchParams.get('mine') !== 'false';

  const configured = isConfigured();
  let issues: JiraIssue[] = [];
  let sprint: JiraSprint | null = null;
  let jiraError: string | null = null;

  if (configured && boardId) {
    try {
      const result = await getBoardIssues(boardId, mineOnly);
      issues = result.issues;
      sprint = result.sprint;
    } catch (e: unknown) {
      jiraError = e instanceof Error ? e.message : String(e);
    }
  }

  return NextResponse.json({ configured, jiraError, boardId, sprint, mineOnly, issues });
}

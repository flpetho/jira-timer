import 'server-only';
import type { JiraIssue, JiraTransition, JiraBoard, JiraSprint } from './types';
import { missingCreds, reasonForStatus, type MyselfResult } from './conn';

export type { MyselfResult };

function creds() {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  const base = (process.env.JIRA_BASE_URL || '').replace(/\/$/, '');
  return { email, token, base };
}

/** Single definition of "configured": nothing in CRED_VARS is missing. */
export function isConfigured(): boolean {
  return missingCreds(process.env).length === 0;
}

function authHeader(): string {
  const { email, token } = creds();
  if (!email || !token) throw new Error('JIRA credentials not configured (set JIRA_EMAIL + JIRA_API_TOKEN).');
  return 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
}

async function jira(pathname: string, init?: RequestInit): Promise<Response> {
  const { base } = creds();
  if (!base) throw new Error('JIRA_BASE_URL is not set (e.g. https://your-org.atlassian.net).');
  return fetch(`${base}${pathname}`, {
    ...init,
    headers: {
      Authorization: authHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
    cache: 'no-store',
  });
}

async function bodyText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 400);
  } catch {
    return '';
  }
}

export async function getMyself(): Promise<MyselfResult> {
  const missing = missingCreds(process.env);
  // baseUrl is echoed back so the setup screen can prefill what's already known.
  // Suppressed while it's one of the missing vars, so we never hand back a placeholder.
  const { base } = creds();
  const baseUrl = missing.includes('JIRA_BASE_URL') ? null : base || null;
  const devMode = process.env.NODE_ENV !== 'production';
  const common = { missing, baseUrl, devMode };

  if (missing.length) {
    return {
      ok: false,
      status: 0,
      reason: 'unconfigured',
      ...common,
      error: `Not configured: ${missing.join(', ')}`,
    };
  }

  try {
    const res = await jira('/rest/api/2/myself');
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        reason: reasonForStatus(res.status),
        ...common,
        error: await bodyText(res),
      };
    }
    const d = await res.json();
    return {
      ok: true,
      status: 200,
      reason: 'ok',
      ...common,
      name: d.displayName,
      email: d.emailAddress,
    };
  } catch (e: unknown) {
    // A thrown fetch means DNS failure, refused connection, or offline.
    return {
      ok: false,
      status: 0,
      reason: 'unreachable',
      ...common,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

function mapIssue(i: any): JiraIssue {
  const f = i.fields ?? {};
  return {
    key: i.key,
    summary: f.summary ?? '',
    status: f.status?.name ?? '?',
    assignee: f.assignee?.displayName ?? null,
    issuetype: f.issuetype?.name ?? '?',
    priority: f.priority?.name ?? null,
    estimateSeconds: f.timeoriginalestimate ?? f.timetracking?.originalEstimateSeconds ?? null,
    description: descriptionToText(f.description),
  };
}

const ISSUE_FIELDS =
  'summary,status,assignee,issuetype,priority,timeoriginalestimate,timetracking,description';

/** Flatten Atlassian Document Format (ADF) — or a plain string — to readable text. */
function adfToText(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text ?? '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention') return node.attrs?.text ?? '';
  if (node.type === 'emoji') return node.attrs?.shortName ?? '';
  const children = Array.isArray(node.content) ? node.content.map(adfToText).join('') : '';
  const block = ['paragraph', 'heading', 'listItem', 'blockquote', 'codeBlock', 'rule'];
  if (block.includes(node.type)) return children + '\n';
  return children;
}

/** Strip the most common JIRA wiki-markup markers so plain-text descriptions read cleanly. */
function wikiToText(s: string): string {
  return s
    .replace(/\r\n/g, '\n')
    .replace(/^h[1-6]\.\s*/gm, '') // headings
    .replace(/^\s*bq\.\s*/gm, '') // block quotes
    .replace(/\{code(:[^}]*)?\}/g, '') // code fences
    .replace(/\{\{([^}]*)\}\}/g, '$1') // {{monospace}}
    .replace(/\[([^|\]]+)\|[^\]]+\]/g, '$1') // [text|url] -> text
    .replace(/\[([^\]]+)\]/g, '$1') // [url] -> url
    .replace(/^\s*[*#-]\s+/gm, '• ') // list items -> bullets
    .replace(/(^|[^\w])[*_]([^*_\n]+)[*_]/g, '$1$2') // *bold* / _italic_ -> text
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function descriptionToText(desc: unknown): string | null {
  if (!desc) return null;
  if (typeof desc === 'string') return wikiToText(desc) || null;
  const text = adfToText(desc).replace(/\n{3,}/g, '\n\n').trim();
  return text || null;
}

/** All boards the user can see (Scrum + Kanban), for the board picker. */
export async function getBoards(): Promise<JiraBoard[]> {
  const boards: JiraBoard[] = [];
  let startAt = 0;
  // Page through so users with many boards see them all.
  for (let i = 0; i < 10; i++) {
    const res = await jira(`/rest/agile/1.0/board?maxResults=50&startAt=${startAt}`);
    if (!res.ok) throw new Error(`Get boards failed: ${res.status} ${await bodyText(res)}`);
    const data = await res.json();
    for (const b of data.values ?? []) boards.push({ id: b.id, name: b.name, type: b.type });
    if (data.isLast || (data.values ?? []).length === 0) break;
    startAt += data.maxResults ?? 50;
  }
  boards.sort((a, b) => a.name.localeCompare(b.name));
  return boards;
}

/** The board's active sprint (the "current iteration"), or null for Kanban / no active sprint. */
export async function getActiveSprint(boardId: number): Promise<JiraSprint | null> {
  const res = await jira(`/rest/agile/1.0/board/${boardId}/sprint?state=active`);
  if (!res.ok) return null; // Kanban boards 400 here — treated as "no sprint".
  const data = await res.json();
  const s = (data.values ?? [])[0];
  return s ? { id: s.id, name: s.name } : null;
}

/** One page of issues from a board/sprint endpoint, filtered by JQL clauses. */
async function fetchIssues(path: string, clauses: string[], order: string): Promise<JiraIssue[]> {
  const jql = `${clauses.join(' AND ')} ORDER BY ${order}`;
  const params = new URLSearchParams({ maxResults: '100', fields: ISSUE_FIELDS, jql });
  const res = await jira(`${path}?${params.toString()}`);
  if (!res.ok) throw new Error(`Board issues failed: ${res.status} ${await bodyText(res)}`);
  const data = await res.json();
  return (data.issues ?? []).map(mapIssue);
}

/**
 * The board's current iteration (active sprint), split by resolution. Falls back
 * to the board's issues when there's no active sprint. `mineOnly` restricts both
 * lists to the current user.
 *
 * `doneIssues` exists so the Completed section can show iteration work that was
 * finished in JIRA even when the timer never tracked it — otherwise a story you
 * completed without the timer is invisible here.
 */
export async function getBoardIssues(
  boardId: number,
  mineOnly: boolean,
): Promise<{ issues: JiraIssue[]; doneIssues: JiraIssue[]; sprint: JiraSprint | null }> {
  const sprint = await getActiveSprint(boardId);
  const path = sprint
    ? `/rest/agile/1.0/board/${boardId}/sprint/${sprint.id}/issue`
    : `/rest/agile/1.0/board/${boardId}/issue`;
  const mine = mineOnly ? ['assignee = currentUser()'] : [];

  const [issues, doneIssues] = await Promise.all([
    fetchIssues(path, [...mine, 'resolution = Unresolved'], 'status ASC, updated DESC'),
    fetchIssues(path, [...mine, 'resolution != Unresolved'], 'updated DESC'),
  ]);
  return { issues, doneIssues, sprint };
}

export async function getTransitions(key: string): Promise<JiraTransition[]> {
  const res = await jira(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`);
  if (!res.ok) throw new Error(`Get transitions failed: ${res.status} ${await bodyText(res)}`);
  const data = await res.json();
  return (data.transitions ?? []).map((t: any) => ({
    id: String(t.id),
    name: t.name,
    to: t.to?.name ?? '',
  }));
}

export async function addWorklog(
  key: string,
  timeSpentSeconds: number,
  comment: string,
  startedMs: number,
): Promise<{ id: string }> {
  const res = await jira(`/rest/api/2/issue/${encodeURIComponent(key)}/worklog`, {
    method: 'POST',
    body: JSON.stringify({
      timeSpentSeconds: Math.max(60, Math.round(timeSpentSeconds)),
      comment,
      started: toJiraDate(startedMs),
    }),
  });
  if (!res.ok) throw new Error(`Add worklog failed: ${res.status} ${await bodyText(res)}`);
  const data = await res.json();
  return { id: String(data.id) };
}

export async function doTransition(key: string, transitionId: string): Promise<void> {
  const res = await jira(`/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, {
    method: 'POST',
    body: JSON.stringify({ transition: { id: transitionId } }),
  });
  if (!res.ok) throw new Error(`Transition failed: ${res.status} ${await bodyText(res)}`);
}

/** JIRA wants: yyyy-MM-ddTHH:mm:ss.SSS+hhmm */
function toJiraDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const abs = Math.abs(off);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`
  );
}

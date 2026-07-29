// Epoch-millisecond timestamps throughout.

export interface Segment {
  start: number;
  end: number | null; // null = currently running
}

export interface StoryTimer {
  key: string;
  summary: string;
  status: string;
  assignee: string | null;
  estimateSeconds: number | null;
  segments: Segment[];
  doneAt: number | null;
  worklogId: string | null;
  loggedSeconds: number | null;
}

export interface TimerState {
  activeKey: string | null;
  stories: Record<string, StoryTimer>;
}

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  assignee: string | null;
  issuetype: string;
  priority: string | null;
  estimateSeconds: number | null;
  description: string | null;
}

export interface JiraTransition {
  id: string;
  name: string;
  to: string;
}

export interface JiraBoard {
  id: number;
  name: string;
  type: string;
}

export interface JiraSprint {
  id: number;
  name: string;
}

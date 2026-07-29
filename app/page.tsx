'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { activeSeconds, formatClock, formatDurationShort, isRunning } from '@/lib/time';
import type { MyselfResult } from '@/lib/conn';
import SetupScreen from './SetupScreen';
import type {
  JiraBoard,
  JiraIssue,
  JiraSprint,
  JiraTransition,
  StoryTimer,
  TimerState,
} from '@/lib/types';

interface IssuesData {
  configured: boolean;
  jiraError: string | null;
  boardId: number | null;
  sprint: JiraSprint | null;
  mineOnly: boolean;
  issues: JiraIssue[];
}

async function jpost(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

export default function Home() {
  const [me, setMe] = useState<MyselfResult | null>(null);
  const [issuesData, setIssuesData] = useState<IssuesData | null>(null);
  const [timer, setTimer] = useState<TimerState | null>(null);
  const [boards, setBoards] = useState<JiraBoard[]>([]);
  const [selectedBoard, setSelectedBoard] = useState<number | null>(null);
  const [boardFilter, setBoardFilter] = useState('');
  const [mineOnly, setMineOnly] = useState<boolean>(true);
  const [hydrated, setHydrated] = useState(false);
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [issuesLoading, setIssuesLoading] = useState(false);
  const [now, setNow] = useState<number>(() => Date.now());
  const [busy, setBusy] = useState<string | null>(null);
  const [doneFor, setDoneFor] = useState<StoryTimer | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const tick = useRef<ReturnType<typeof setInterval>>();

  const toggleDesc = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const connected = me?.ok === true;

  const loadMe = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { cache: 'no-store' });
      setMe(await res.json());
    } catch {
      // This branch means the timer's OWN server didn't answer — not JIRA.
      // Most often it's mid-restart after `service.sh update`.
      setMe({
        ok: false,
        status: 0,
        reason: 'unreachable',
        missing: [],
        baseUrl: null,
        devMode: true,
        error: "Couldn't reach the timer's own server. It may be restarting — retry in a moment.",
      });
    }
  }, []);

  const loadTimer = useCallback(async () => {
    try {
      const res = await fetch('/api/timer', { cache: 'no-store' });
      setTimer(await res.json());
    } catch {
      /* keep last */
    }
  }, []);

  // Boards can take several seconds: JIRA pages them 50 at a time, so an account
  // with hundreds of boards costs one request per page.
  const loadBoards = useCallback(async () => {
    setBoardsLoading(true);
    try {
      const res = await fetch('/api/boards', { cache: 'no-store' });
      const d = await res.json();
      const list: JiraBoard[] = d.boards ?? [];
      setBoards(list);
      // Default board is resolved server-side from JIRA_BOARD_MATCH (else first board).
      setSelectedBoard((prev) => prev ?? d.defaultBoardId ?? null);
    } catch {
      /* keep last */
    } finally {
      setBoardsLoading(false);
    }
  }, []);

  const loadIssues = useCallback(async (board: number, mine: boolean) => {
    setIssuesLoading(true);
    try {
      const res = await fetch(`/api/stories?board=${board}&mine=${mine}`, { cache: 'no-store' });
      setIssuesData(await res.json());
    } catch {
      /* keep last */
    } finally {
      setIssuesLoading(false);
    }
  }, []);

  // Hydrate persisted selections (client only).
  useEffect(() => {
    const b = localStorage.getItem('jt.board');
    const m = localStorage.getItem('jt.mine');
    if (b) setSelectedBoard(Number(b));
    if (m != null) setMineOnly(m === 'true');
    setHydrated(true);
  }, []);

  // Connection check + local timer state (both cheap). While disconnected we poll
  // fast, so that saving credentials during setup flips the screen over on its own.
  useEffect(() => {
    loadMe();
    loadTimer();
    const t = setInterval(loadMe, connected ? 60_000 : 5_000);
    return () => clearInterval(t);
  }, [loadMe, loadTimer, connected]);

  // Load boards once connected.
  useEffect(() => {
    if (connected) loadBoards();
  }, [connected, loadBoards]);

  // Fetch (and poll) the selected board's current iteration. `connected` is a
  // dependency on purpose: without it a reconnect wouldn't refetch, leaving the
  // iteration empty until the next 30s tick while local stories showed instantly.
  useEffect(() => {
    if (!hydrated || selectedBoard == null || !connected) return;
    localStorage.setItem('jt.board', String(selectedBoard));
    localStorage.setItem('jt.mine', String(mineOnly));
    loadIssues(selectedBoard, mineOnly);
    const t = setInterval(() => loadIssues(selectedBoard, mineOnly), 30_000);
    return () => clearInterval(t);
  }, [hydrated, selectedBoard, mineOnly, loadIssues, connected]);

  // 1s clock tick for the live readout.
  useEffect(() => {
    tick.current = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick.current);
  }, []);

  // Timer actions update local state instantly from the POST response — no JIRA wait.
  const start = async (issue: JiraIssue) => {
    setBusy(issue.key);
    const { ok, data } = await jpost('/api/timer', {
      action: 'start',
      issue: {
        key: issue.key,
        summary: issue.summary,
        status: issue.status,
        assignee: issue.assignee,
        estimateSeconds: issue.estimateSeconds,
      },
    });
    if (ok) setTimer(data as TimerState);
    setBusy(null);
  };

  const pause = async () => {
    setBusy('pause');
    const { ok, data } = await jpost('/api/timer', { action: 'pause' });
    if (ok) setTimer(data as TimerState);
    setBusy(null);
  };

  const live = (t: StoryTimer | null | undefined) => (t ? activeSeconds(t.segments, now) : 0);

  // Derive the view from JIRA issues + local timer state (both already in memory).
  const stories = timer?.stories ?? {};
  const activeKey = timer?.activeKey ?? null;
  const active = activeKey ? stories[activeKey] ?? null : null;
  const issues = issuesData?.issues ?? [];
  const activeDesc = active ? issues.find((i) => i.key === active.key)?.description ?? null : null;
  // JIRA decides where a story sits. /api/stories returns only unresolved issues,
  // so anything it lists is live work — even if we logged time against it earlier.
  const openIssues = new Map(issues.map((i) => [i.key, i]));
  const upNext = issues
    .filter((i) => i.key !== activeKey)
    .map((i) => ({ issue: i, timer: stories[i.key] ?? null }));
  // Completed = time we recorded, for work JIRA no longer lists as open. Pressing
  // Done is deliberately NOT required: resolving a story in JIRA without it would
  // otherwise drop the story out of both lists and hide the tracked time entirely.
  //
  // Caveat: "no longer open" is inferred from the currently displayed issues, which
  // are scoped to the selected board and the assignee toggle — so switching boards
  // can surface a story that is still open elsewhere. Resolving that properly needs
  // a per-story JIRA lookup.
  const hasRecordedTime = (s: StoryTimer) => live(s) >= 60 || (s.loggedSeconds ?? 0) > 0;
  const lastActivity = (s: StoryTimer) =>
    s.doneAt ?? s.segments[s.segments.length - 1]?.end ?? 0;
  const completed = Object.values(stories)
    .filter((s) => hasRecordedTime(s) && !openIssues.has(s.key))
    .sort((a, b) => lastActivity(b) - lastActivity(a));

  // Board picker: filter the (often hundreds of) boards, cap the list, but always
  // keep the current selection visible as an option.
  const filteredBoards = boardFilter
    ? boards.filter((b) => b.name.toLowerCase().includes(boardFilter.toLowerCase()))
    : boards;
  const shownBoards = filteredBoards.slice(0, 100);
  const selectOptions =
    selectedBoard != null && !shownBoards.some((b) => b.id === selectedBoard)
      ? ([boards.find((b) => b.id === selectedBoard), ...shownBoards].filter(Boolean) as JiraBoard[])
      : shownBoards;

  // Until JIRA is reachable there is nothing to pick a board from, so the setup
  // screen takes over the body. The header stays put so it still reads as the app.
  if (!connected) {
    return (
      <div className="wrap">
        <Header me={me} connected={connected} syncing={false} />
        <SetupScreen
          me={me}
          timer={timer}
          now={now}
          onRetry={() => {
            loadMe();
            loadTimer();
          }}
          onPause={pause}
          pausing={busy === 'pause'}
        />
      </div>
    );
  }

  return (
    <div className="wrap">
      <Header me={me} connected={connected} syncing={boardsLoading || issuesLoading} />

      {issuesData?.jiraError && <div className="banner bad">JIRA error: {issuesData.jiraError}</div>}

      {/* Board picker + assignee filter */}
      <div className="controls">
        <input
          type="text"
          placeholder="Filter boards…"
          value={boardFilter}
          onChange={(e) => setBoardFilter(e.target.value)}
          disabled={!connected}
        />
        <select
          value={selectedBoard ?? ''}
          onChange={(e) => setSelectedBoard(e.target.value ? Number(e.target.value) : null)}
          disabled={!connected || boards.length === 0}
        >
          {selectedBoard == null && !boardsLoading && <option value="">Pick a board…</option>}
          {boards.length === 0 && (
            <option value="">
              {boardsLoading
                ? 'Loading boards from JIRA…'
                : connected
                  ? 'No boards found'
                  : 'Connect to load boards'}
            </option>
          )}
          {selectOptions.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <div className="grow" />
        <div className="seg">
          <button className={mineOnly ? 'on' : ''} onClick={() => setMineOnly(true)}>
            Assigned to me
          </button>
          <button className={!mineOnly ? 'on' : ''} onClick={() => setMineOnly(false)}>
            Everyone
          </button>
        </div>
      </div>
      {boardFilter && filteredBoards.length > shownBoards.length && (
        <div className="controls-hint">
          Showing {shownBoards.length} of {filteredBoards.length} matches — refine the filter.
        </div>
      )}

      {/* Active timer */}
      {active ? (
        <div className="card active">
          <div className="active-top">
            <span className="key">{active.key}</span>
            <span className="status-chip">{active.status}</span>
            {/* No tracked chip here — the clock below is the tracked figure. */}
            {active.loggedSeconds ? (
              <span className="chip-logged" title="Already sent to JIRA as a worklog">
                {formatDurationShort(active.loggedSeconds)} logged
              </span>
            ) : null}
            <span className="assignee">{active.assignee ?? 'Unassigned'}</span>
          </div>
          <div className="summary">{active.summary}</div>
          <div className={`clock ${isRunning(active.segments) ? 'running' : 'paused'}`}>
            {formatClock(live(active))}
          </div>
          <EstLine seconds={live(active)} estimate={active.estimateSeconds} />
          {activeDesc && (
            <Description
              text={activeDesc}
              open={expanded.has(active.key)}
              onToggle={() => toggleDesc(active.key)}
            />
          )}
          <div className="row-actions">
            <button onClick={pause} disabled={busy !== null || !isRunning(active.segments)}>
              Pause
            </button>
            <button className="ok" onClick={() => setDoneFor(active)} disabled={busy !== null}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="muted">No timer running. Pick a story below to start.</div>
        </div>
      )}

      {/* Current iteration */}
      <div className="iteration">
        <span className="lbl">{issuesData?.sprint ? 'Current iteration' : 'Open issues'}</span>
        {issuesData?.sprint && <span className="name">{issuesData.sprint.name}</span>}
        {/* Refreshing over data we already show: a quiet spinner, no layout shift. */}
        {issuesLoading && issuesData && <span className="spinner sm" aria-label="Refreshing" />}
      </div>
      {!issuesData ? (
        <Loading label="Loading stories from JIRA…" />
      ) : upNext.length === 0 ? (
        <div className="empty">
          {!connected
            ? 'Connect to JIRA to see stories.'
            : selectedBoard == null
              ? 'Pick a board above.'
              : mineOnly
                ? 'Nothing assigned to you in this iteration.'
                : 'No open issues in this iteration.'}
        </div>
      ) : (
        upNext.map(({ issue, timer: t }) => {
          const prior = live(t);
          return (
            <div className="row" key={issue.key}>
              <div className="grow">
                <div className="line1">
                  <span className="key">{issue.key}</span>
                  <span className="status-chip">{issue.status}</span>
                  <TimeChips tracked={prior} logged={t?.loggedSeconds ?? null} />
                  <span className="assignee">{issue.assignee ?? 'Unassigned'}</span>
                </div>
                <div className="summary" title={issue.summary}>
                  {issue.summary}
                </div>
                <MetaLine estimate={issue.estimateSeconds} actual={prior} />
                {issue.description && (
                  <Description
                    text={issue.description}
                    open={expanded.has(issue.key)}
                    onToggle={() => toggleDesc(issue.key)}
                  />
                )}
              </div>
              <button className="primary small" onClick={() => start(issue)} disabled={busy !== null}>
                {prior > 0 ? 'Resume' : 'Start'}
              </button>
            </div>
          );
        })
      )}

      {/* Completed */}
      {completed.length > 0 && (
        <>
          <div className="section-label">Completed</div>
          {completed.map((s) => {
            // Finished with time the timer measured but never sent. Worth calling
            // out here, because this row is the only place it's still visible.
            const unlogged = (s.loggedSeconds ?? 0) === 0 && live(s) >= 60;
            return (
              <div className="row" key={s.key}>
                <div className="grow">
                  <div className="line1">
                    <span className="key">{s.key}</span>
                    <span className="status-chip">{s.status}</span>
                    <TimeChips tracked={live(s)} logged={s.loggedSeconds} />
                    {unlogged && <span className="chip-unlogged">Not logged to JIRA</span>}
                    <span className="assignee">{s.assignee ?? 'Unassigned'}</span>
                  </div>
                  <div className="summary" title={s.summary}>
                    {s.summary}
                  </div>
                  {/* Compared against tracked time, matching the iteration rows —
                      previously this row measured overrun against logged time instead. */}
                  <MetaLine estimate={s.estimateSeconds} actual={live(s)} />
                </div>
                {unlogged && (
                  <button
                    className="small"
                    onClick={() => setDoneFor(s)}
                    disabled={busy !== null}
                    title="Send this tracked time to JIRA as a worklog"
                  >
                    Log time
                  </button>
                )}
              </div>
            );
          })}
        </>
      )}

      {doneFor && (
        <DoneDialog
          story={doneFor}
          liveSeconds={live(doneFor)}
          onClose={() => setDoneFor(null)}
          onDone={(state) => {
            setTimer(state);
            setDoneFor(null);
          }}
        />
      )}
    </div>
  );
}

/** Animated so a slow JIRA call reads as working rather than stuck. */
function Loading({ label }: { label: string }) {
  return (
    <div className="loading-row" role="status">
      <span className="spinner" />
      {label}
    </div>
  );
}

function Header({
  me,
  connected,
  syncing,
}: {
  me: MyselfResult | null;
  connected: boolean;
  syncing: boolean;
}) {
  return (
    <div className="header">
      <div className="brand">
        JIRA <span>Timer</span>
      </div>
      <div className="header-right">
        <button
          className="reload-btn"
          title="Reload the app"
          aria-label="Reload the app"
          onClick={() => window.location.reload()}
        >
          ↻
        </button>
        <div className="conn" title={syncing ? 'Talking to JIRA…' : me?.error || ''}>
          {/* The dot pulses whenever a JIRA request is in flight, so there's always
              one place to look to see whether the app is doing something. */}
          <span
            className={`dot ${connected ? 'ok' : me ? 'bad' : ''} ${syncing ? 'syncing' : ''}`}
          />
          {connected ? `Connected as ${me?.name ?? 'JIRA'}` : me ? 'Not connected' : 'Checking…'}
        </div>
      </div>
    </div>
  );
}

function Description({
  text,
  open,
  onToggle,
}: {
  text: string;
  open: boolean;
  onToggle: () => void;
}) {
  const long = text.length > 140;
  return (
    <>
      <div className={`desc ${!long || open ? 'open' : ''}`}>{text}</div>
      {long && (
        <button className="link" onClick={onToggle}>
          {open ? 'show less' : 'show more'}
        </button>
      )}
    </>
  );
}

/**
 * The two time facts a story can carry, always labelled so they can't be misread
 * as each other: what the timer measured here, and how much of it JIRA has.
 * They diverge legitimately — rounding, or more work after a first Done.
 */
function TimeChips({ tracked, logged }: { tracked: number; logged: number | null }) {
  const showTracked = tracked >= 60; // below a minute it would render "0m"
  const loggedSecs = logged ?? 0;
  if (!showTracked && loggedSecs <= 0) return null;
  return (
    <>
      {showTracked && (
        <span className="chip-tracked" title="Measured by the timer on this machine">
          {formatDurationShort(tracked)} tracked
        </span>
      )}
      {loggedSecs > 0 && (
        <span className="chip-logged" title="Already sent to JIRA as a worklog">
          {formatDurationShort(loggedSecs)} logged
        </span>
      )}
    </>
  );
}

/** Estimate, plus an overrun callout. The amounts themselves live in TimeChips. */
function MetaLine({ estimate, actual }: { estimate: number | null; actual: number }) {
  const over = estimate != null && actual > estimate;
  return (
    <div className="meta">
      <span className="est">
        {estimate != null ? `est ${formatDurationShort(estimate)}` : 'no estimate'}
      </span>
      {over && (
        <>
          <span>·</span>
          <span className="act over">{formatDurationShort(actual - estimate)} over</span>
        </>
      )}
    </div>
  );
}

function EstLine({ seconds, estimate }: { seconds: number; estimate: number | null }) {
  if (!estimate) {
    return (
      <div className="est-line">
        <b>{formatDurationShort(seconds)}</b> active · no estimate set
      </div>
    );
  }
  const over = seconds > estimate;
  return (
    <div className="est-line">
      <b>{formatDurationShort(seconds)}</b> active of <b>{formatDurationShort(estimate)}</b> estimate ·{' '}
      <span className={over ? 'over' : 'under'}>
        {over
          ? `${formatDurationShort(seconds - estimate)} over`
          : `${formatDurationShort(estimate - seconds)} left`}
      </span>
    </div>
  );
}

function DoneDialog({
  story,
  liveSeconds,
  onClose,
  onDone,
}: {
  story: StoryTimer;
  liveSeconds: number;
  onClose: () => void;
  onDone: (state: TimerState) => void;
}) {
  const [transitions, setTransitions] = useState<JiraTransition[] | null>(null);
  const [transitionId, setTransitionId] = useState<string>('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/transitions?key=${encodeURIComponent(story.key)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => setTransitions(d.transitions ?? []))
      .catch(() => setTransitions([]));
  }, [story.key]);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    const { ok, data } = await jpost('/api/done', {
      key: story.key,
      transitionId: transitionId || undefined,
      note: note || undefined,
    });
    if (ok && data?.state) {
      onDone(data.state as TimerState);
    } else {
      setError(data?.error || 'Failed to log time.');
      setSubmitting(false);
    }
  };

  return (
    <div className="backdrop" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Log &amp; finish {story.key}</h3>
        <div className="muted" style={{ fontSize: 12 }}>
          {story.summary}
        </div>
        <div className="big">{formatDurationShort(liveSeconds)}</div>
        <div className="faint" style={{ fontSize: 12 }}>
          Rounded to the nearest few minutes and posted as a worklog.
        </div>

        <div className="field">
          <label>Move status to</label>
          <select value={transitionId} onChange={(e) => setTransitionId(e.target.value)}>
            <option value="">— leave status unchanged —</option>
            {(transitions ?? []).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {t.to ? ` → ${t.to}` : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>Worklog note (optional)</label>
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>

        {error && (
          <div className="banner bad" style={{ marginBottom: 0 }}>
            {error}
          </div>
        )}

        <div className="dialog-actions">
          <button className="ghost" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button className="ok" onClick={submit} disabled={submitting}>
            {submitting ? 'Logging…' : 'Log to JIRA'}
          </button>
        </div>
      </div>
    </div>
  );
}

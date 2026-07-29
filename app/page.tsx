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

/** Either one board, or every board the user has work in pooled together. */
type BoardSel = number | 'all';

interface IssuesData {
  configured: boolean;
  jiraError: string | null;
  boardId: number | null;
  allBoards: boolean;
  boardCount: number;
  sprint: JiraSprint | null;
  mineOnly: boolean;
  issues: JiraIssue[];
  /** Iteration work JIRA considers resolved, tracked by the timer or not. */
  doneIssues: JiraIssue[];
}

/** A Completed row, which may come from JIRA, from local timer state, or both. */
interface CompletedRow {
  key: string;
  summary: string;
  status: string;
  assignee: string | null;
  estimateSeconds: number | null;
  timer: StoryTimer | null;
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
  // Boards you have work in — the toggle row. Kept separate from search results so
  // searching never disturbs what's on offer.
  const [myBoards, setMyBoards] = useState<JiraBoard[]>([]);
  // Boards picked out of a search this session, pinned alongside your own.
  const [pinnedBoards, setPinnedBoards] = useState<JiraBoard[]>([]);
  const [searchResults, setSearchResults] = useState<JiraBoard[] | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  // 'all' pools every board you have work in; a number is a single board.
  const [selectedBoard, setSelectedBoard] = useState<BoardSel | null>(null);
  const [boardFilter, setBoardFilter] = useState('');
  const [mineOnly, setMineOnly] = useState<boolean>(true);
  const [hydrated, setHydrated] = useState(false);
  const [boardsLoading, setBoardsLoading] = useState(false);
  const [boardScope, setBoardScope] = useState<'mine' | 'search' | 'all'>('mine');
  const [selectedBoardName, setSelectedBoardName] = useState<string | null>(null);
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

  // Just the boards you have work in — a handful, not the whole site.
  const loadMyBoards = useCallback(async () => {
    setBoardsLoading(true);
    try {
      const res = await fetch('/api/boards', { cache: 'no-store' });
      const d = await res.json();
      setMyBoards(d.boards ?? []);
      setBoardScope(d.scope ?? 'mine');
      // Default board is resolved server-side from JIRA_BOARD_MATCH (else first board).
      setSelectedBoard((prev) => prev ?? d.defaultBoardId ?? null);
    } catch {
      /* keep last */
    } finally {
      setBoardsLoading(false);
    }
  }, []);

  // Name search runs on JIRA's side, so it reaches every board you can see without
  // us downloading the lot.
  const runBoardSearch = useCallback(async (query: string) => {
    if (!query) {
      setSearchResults(null);
      return;
    }
    setBoardsLoading(true);
    try {
      const res = await fetch(`/api/boards?q=${encodeURIComponent(query)}`, { cache: 'no-store' });
      const d = await res.json();
      setSearchResults(d.boards ?? []);
    } catch {
      setSearchResults([]);
    } finally {
      setBoardsLoading(false);
    }
  }, []);

  const loadIssues = useCallback(async (board: BoardSel, mine: boolean) => {
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
    const n = localStorage.getItem('jt.boardName');
    if (b) setSelectedBoard(b === 'all' ? 'all' : Number(b));
    if (m != null) setMineOnly(m === 'true');
    if (n) setSelectedBoardName(n);
    setHydrated(true);
  }, []);

  // Remember the selected board's label, so a selection restored from localStorage
  // shows a real name rather than "Board 8557" before the list arrives.
  useEffect(() => {
    if (typeof selectedBoard !== 'number') return;
    const name = [...myBoards, ...pinnedBoards].find((b) => b.id === selectedBoard)?.name;
    if (name) {
      setSelectedBoardName(name);
      localStorage.setItem('jt.boardName', name);
    }
  }, [myBoards, pinnedBoards, selectedBoard]);

  // Connection check + local timer state (both cheap). While disconnected we poll
  // fast, so that saving credentials during setup flips the screen over on its own.
  useEffect(() => {
    loadMe();
    loadTimer();
    const t = setInterval(loadMe, connected ? 60_000 : 5_000);
    return () => clearInterval(t);
  }, [loadMe, loadTimer, connected]);

  // Your boards, once connected.
  useEffect(() => {
    if (connected) loadMyBoards();
  }, [connected, loadMyBoards]);

  // Search, debounced so typing doesn't fire a JIRA request per keystroke.
  useEffect(() => {
    if (!connected) return;
    const q = boardFilter.trim();
    const t = setTimeout(() => runBoardSearch(q), q ? 350 : 0);
    return () => clearTimeout(t);
  }, [connected, runBoardSearch, boardFilter]);

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

  // Completed is the union of two sources, deduped by key:
  //   1. stories the timer recorded time against that JIRA no longer lists as open
  //   2. iteration work JIRA reports as resolved, even if the timer never saw it
  // (2) is why a story finished without the timer still appears — with no time
  // badges, which is itself the useful signal for estimate-vs-actual.
  const doneIssues = issuesData?.doneIssues ?? [];
  const doneByKey = new Map(doneIssues.map((i) => [i.key, i]));
  const completed: CompletedRow[] = [];
  const seenCompleted = new Set<string>();

  for (const s of Object.values(stories)
    .filter((s) => hasRecordedTime(s) && !openIssues.has(s.key))
    .sort((a, b) => lastActivity(b) - lastActivity(a))) {
    // Prefer JIRA's copy of the metadata when it has one; it's more current.
    const ji = doneByKey.get(s.key);
    completed.push({
      key: s.key,
      summary: ji?.summary ?? s.summary,
      status: ji?.status ?? s.status,
      assignee: ji?.assignee ?? s.assignee,
      estimateSeconds: s.estimateSeconds ?? ji?.estimateSeconds ?? null,
      timer: s,
    });
    seenCompleted.add(s.key);
  }
  for (const i of doneIssues) {
    if (seenCompleted.has(i.key)) continue;
    completed.push({
      key: i.key,
      summary: i.summary,
      status: i.status,
      assignee: i.assignee,
      estimateSeconds: i.estimateSeconds,
      timer: stories[i.key] ?? null,
    });
  }

  // The toggle row: your boards, plus anything pinned from a search, plus the
  // current selection if it came from neither (e.g. restored from localStorage).
  const boardsById = new Map<number, JiraBoard>();
  for (const b of [...myBoards, ...pinnedBoards]) boardsById.set(b.id, b);
  if (typeof selectedBoard === 'number' && !boardsById.has(selectedBoard)) {
    boardsById.set(selectedBoard, {
      id: selectedBoard,
      name: selectedBoardName ?? `Board ${selectedBoard}`,
      type: '',
    });
  }
  const toggleBoards = [...boardsById.values()].sort((a, b) => a.name.localeCompare(b.name));
  const pickBoard = (sel: BoardSel) => {
    setSelectedBoard(sel);
    setSearchOpen(false);
    setBoardFilter('');
    setSearchResults(null);
  };

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

      {/* One toggle per board you're on. A handful of boards doesn't need a dropdown. */}
      <div className="controls">
        <div className="seg wrap-seg">
          {toggleBoards.length > 1 && (
            <button
              className={selectedBoard === 'all' ? 'on' : ''}
              onClick={() => pickBoard('all')}
              title="Pool stories from every board you have work in"
            >
              All boards
            </button>
          )}
          {toggleBoards.map((b) => (
            <button
              key={b.id}
              className={selectedBoard === b.id ? 'on' : ''}
              onClick={() => pickBoard(b.id)}
            >
              {b.name}
            </button>
          ))}
          {toggleBoards.length === 0 && (
            <button disabled>{boardsLoading ? 'Loading boards…' : 'No boards found'}</button>
          )}
        </div>
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

      {/* Reaching a board you have no work on is the exception, so it stays folded away. */}
      <div className="board-search">
        {searchOpen ? (
          <>
            <input
              type="text"
              autoFocus
              placeholder="Search all boards in JIRA…"
              value={boardFilter}
              onChange={(e) => setBoardFilter(e.target.value)}
            />
            <button
              className="ghost small"
              onClick={() => {
                setSearchOpen(false);
                setBoardFilter('');
                setSearchResults(null);
              }}
            >
              Cancel
            </button>
            {searchResults && (
              <div className="search-results">
                {searchResults.length === 0 ? (
                  <span className="faint">No board matching “{boardFilter}”</span>
                ) : (
                  searchResults.map((b) => (
                    <button
                      key={b.id}
                      className="small"
                      onClick={() => {
                        setPinnedBoards((prev) =>
                          prev.some((p) => p.id === b.id) ? prev : [...prev, b],
                        );
                        pickBoard(b.id);
                      }}
                    >
                      {b.name}
                    </button>
                  ))
                )}
              </div>
            )}
          </>
        ) : (
          <button className="link" onClick={() => setSearchOpen(true)}>
            Search all boards…
          </button>
        )}
      </div>
      {boardScope === 'all' && (
        <div className="controls-hint">Nothing assigned to you yet — showing all boards.</div>
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

      {/* Current iteration, or the pooled view across boards */}
      <div className="iteration">
        <span className="lbl">
          {issuesData?.allBoards
            ? 'Open issues'
            : issuesData?.sprint
              ? 'Current iteration'
              : 'Open issues'}
        </span>
        {issuesData?.allBoards ? (
          <span className="name">
            across {issuesData.boardCount} board{issuesData.boardCount === 1 ? '' : 's'}
          </span>
        ) : (
          issuesData?.sprint && <span className="name">{issuesData.sprint.name}</span>
        )}
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
                ? 'Nothing assigned to you here.'
                : 'No open issues here.'}
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
                  {/* Only meaningful when boards are pooled; otherwise it's the same
                      board on every row and just adds noise. */}
                  {issue.boardName && <span className="chip-board">{issue.boardName}</span>}
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
          {completed.map((row) => {
            const t = row.timer;
            const tracked = live(t);
            // Finished with time the timer measured but never sent. Worth calling
            // out here, because this row is the only place it's still visible.
            const unlogged = t != null && (t.loggedSeconds ?? 0) === 0 && tracked >= 60;
            return (
              <div className="row" key={row.key}>
                <div className="grow">
                  <div className="line1">
                    <span className="key">{row.key}</span>
                    <span className="status-chip">{row.status}</span>
                    <TimeChips tracked={tracked} logged={t?.loggedSeconds ?? null} />
                    {unlogged && <span className="chip-unlogged">Not logged to JIRA</span>}
                    <span className="assignee">{row.assignee ?? 'Unassigned'}</span>
                  </div>
                  <div className="summary" title={row.summary}>
                    {row.summary}
                  </div>
                  {/* Compared against tracked time, matching the iteration rows —
                      previously this row measured overrun against logged time instead. */}
                  <MetaLine estimate={row.estimateSeconds} actual={tracked} />
                </div>
                {unlogged && t && (
                  <button
                    className="small"
                    onClick={() => setDoneFor(t)}
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

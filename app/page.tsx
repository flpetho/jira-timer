'use client';

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { activeSeconds, formatClock, formatDurationShort, isRunning } from '@/lib/time';
import type { MyselfResult } from '@/lib/conn';
import { UNLABELLED } from '@/lib/activities';
import { trackedByActivity, unloggedSeconds } from '@/lib/timer-logic';
import {
  focusKey,
  groupByStage,
  preferredDoneTransition,
  STAGE_LABELS,
  STAGE_ORDER,
  type StageRow,
} from '@/lib/stages';
import SetupScreen from './SetupScreen';
import type {
  JiraBoard,
  JiraIssue,
  JiraSprint,
  JiraTransition,
  Stage,
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

/** Done and off-board rows share a receded treatment; the live columns don't. */
type Column = Stage | 'elsewhere';

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
  // Stories the user has opened into a full card. The focused story is always open
  // and isn't listed here — see isOpen.
  const [openCards, setOpenCards] = useState<Set<string>>(new Set());
  const tick = useRef<ReturnType<typeof setInterval>>();

  const toggleDesc = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const toggleCard = (key: string) =>
    setOpenCards((prev) => {
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
        activities: [],
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
  const start = async (issue: StageRow) => {
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

  /**
   * Fix up time the timer already measured: move it to another activity, or throw it
   * away. Local only — these change what a future Done would send, never what one
   * already sent, so no JIRA call is involved.
   */
  const resolveTime = async (
    key: string,
    action: 'relabel' | 'discard',
    activity: string,
    to?: string,
  ) => {
    setBusy(`${action}:${key}`);
    const { ok, data } = await jpost('/api/timer', { action, key, activity, to });
    if (ok) setTimer(data as TimerState);
    setBusy(null);
  };

  // `activity` labels the chunk that just ended. Omitted for a plain Pause.
  const pause = async (activity?: string) => {
    setBusy(activity ? `stop:${activity}` : 'pause');
    const { ok, data } = await jpost('/api/timer', { action: 'pause', activity });
    if (ok) setTimer(data as TimerState);
    setBusy(null);
  };

  const live = (t: StoryTimer | null | undefined) => (t ? activeSeconds(t.segments, now) : 0);
  /**
   * Tracked time this app hasn't sent yet, summed from the segments no worklog
   * covers. Never derived from JIRA's total, which would cancel out time logged
   * before the app existed.
   *
   * It used to be `live - loggedSeconds`, which counted Done's *rounding residue* as
   * unsent work: a story tracked for 7333s and logged as 7200s advertised "2m
   * unlogged" that /api/done would then refuse to send, on a card whose bars
   * correctly showed nothing left to resolve.
   */
  const unlogged = (t: StoryTimer | null | undefined) => (t ? unloggedSeconds(t, now) : 0);

  // Derive the view from JIRA issues + local timer state (both already in memory).
  const stories = timer?.stories ?? {};
  const activeKey = timer?.activeKey ?? null;
  const active = activeKey ? stories[activeKey] ?? null : null;
  const issues = issuesData?.issues ?? [];
  const doneIssues = issuesData?.doneIssues ?? [];
  const activities = me?.activities ?? [];

  // JIRA's status category decides which column a story sits in, so these sections
  // agree with the board even when a project renames its statuses. Work the timer
  // tracked that this board no longer lists goes to `elsewhere` rather than being
  // asserted as Done — all the app knows is that it isn't here.
  const groups = groupByStage({ issues, doneIssues, stories, now, activeKey });
  const allRows = [...groups.todo, ...groups.doing, ...groups.done, ...groups.elsewhere];
  // The story that keeps its full readout. Not the same as the running story: it
  // outlives a pause, so stopping the clock no longer hides the time it measured.
  const focused = focusKey(groups, activeKey, now);
  const isOpen = (key: string) => key === focused || openCards.has(key);
  const rowCount = allRows.length;

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

  /**
   * A story's full readout, rendered inside whichever column JIRA puts the story in
   * rather than hoisted above the board — so its position never contradicts the
   * stage heading above it.
   *
   * Shown for the focused story always, and for any row the user opens. Everything
   * here stays on screen when the clock stops: pausing used to collapse the story
   * back to a one-line row, so the only way to see time you had just measured was to
   * start the clock again.
   *
   * `row.timer` is null for a story the timer has never seen — a Done issue someone
   * finished without it. That card still has a summary, a status and a description
   * worth reading, so it opens too, just without a clock.
   */
  const renderCard = (row: StageRow, column: Column) => {
    const story = row.timer;
    const tracked = live(story);
    const runningNow = story ? isRunning(story.segments) : false;
    const finished = column === 'done' || column === 'elsewhere';
    const reload = () => {
      if (selectedBoard != null) loadIssues(selectedBoard, mineOnly);
    };
    return (
      <div className={`card active${runningNow ? '' : ' is-paused'}`} key={row.key}>
        <div className="active-top">
          <span className="key">{row.key}</span>
          <span className="status-chip">{row.status}</span>
          {/* No time chips here. The clock and the estimate line below already carry
              both figures, and a "N in JIRA" chip printed the same number a second
              time the moment tracked time equalled logged time. */}
          {row.boardName && <span className="chip-board">{row.boardName}</span>}
          <span className="assignee">{row.assignee ?? 'Unassigned'}</span>
          {/* The focused card is the one thing that stays put, so it has nothing to
              collapse back to. */}
          {row.key !== focused && (
            <button
              className="ghost small card-close"
              onClick={() => toggleCard(row.key)}
              aria-expanded={true}
              title="Collapse this story"
            >
              Close
            </button>
          )}
        </div>
        <div className="summary">{row.summary}</div>
        {story && (
          <>
            <div className={`clock ${runningNow ? 'running' : 'paused'}`}>
              {formatClock(tracked)}
            </div>
            {!runningNow && tracked > 0 && (
              <div className="clock-note">
                {finished ? 'Stopped' : 'Paused'} · this session’s time is still counted below
              </div>
            )}
          </>
        )}
        <EstLine
          seconds={tracked}
          spent={(row.secondsSpent ?? 0) + unlogged(story)}
          estimate={row.estimateSeconds ?? story?.estimateSeconds ?? null}
        />
        {/* Kept with the clock and the estimate line: the total and the shape of it
            are one thought, and the description shouldn't come between them. */}
        {story && (
          <ActivityBreakdown
            story={story}
            now={now}
            activities={activities}
            busy={busy}
            onResolve={(action, activity, to) => resolveTime(row.key, action, activity, to)}
          />
        )}
        {row.description && (
          <Description
            text={row.description}
            open={expanded.has(row.key)}
            onToggle={() => toggleDesc(row.key)}
          />
        )}
        {/* Tracking work that JIRA still calls To Do. Offered, never automatic:
            /api/timer must not depend on JIRA being reachable. */}
        {column === 'todo' && runningNow && (
          <MoveToInProgress key={row.key} storyKey={row.key} onMoved={reload} />
        )}
        {/* Stopping and attributing in one click. The story stays open either
            way — only Done writes to JIRA. */}
        {activities.length > 0 && runningNow && (
          <div className="stop-as">
            <div className="stop-as-label">Stop and log as…</div>
            <div className="stop-as-buttons">
              {activities.map((a) => (
                <button key={a} className="small" onClick={() => pause(a)} disabled={busy !== null}>
                  {busy === `stop:${a}` ? 'Stopping…' : a}
                </button>
              ))}
            </div>
          </div>
        )}
        <StatusControl storyKey={row.key} status={row.status} onMoved={reload} />
        <div className="row-actions">
          {runningNow ? (
            <button
              onClick={() => pause()}
              disabled={busy !== null}
              title={
                activities.length > 0
                  ? 'Stop without attributing — you can label it later'
                  : undefined
              }
            >
              Pause
            </button>
          ) : (
            <button onClick={() => start(row)} disabled={busy !== null}>
              {tracked > 0 ? 'Resume' : 'Start'}
            </button>
          )}
          {/* A finished story is only worth reopening this dialog for if there's
              still time to send; a live one can also be transitioned by it. */}
          {story && (!finished || unlogged(story) >= 60) && (
            <button className="primary" onClick={() => setDoneFor(story)} disabled={busy !== null}>
              {finished ? 'Log time' : 'Done'}
            </button>
          )}
        </div>
      </div>
    );
  };

  const renderRow = (row: StageRow, column: Column) => {
    if (isOpen(row.key)) return renderCard(row, column);
    const t = row.timer;
    const tracked = live(t);
    // Done and off-board rows recede: they're a record, not something to act on.
    const receded = column === 'done' || column === 'elsewhere';
    // Time this app measured but never sent. On a finished story this row is the
    // only place it's still visible, so it gets a way to send it.
    const notLogged = t != null && (t.loggedSeconds ?? 0) === 0 && tracked >= 60;
    return (
      <div className={`row${receded ? ' receded' : ''}`} key={row.key}>
        <div className="grow">
          <div className="line1">
            {receded && (
              <span className="done-mark" aria-hidden="true">
                ✓
              </span>
            )}
            <span className="key">{row.key}</span>
            <span className="status-chip">{row.status}</span>
            <TimeChips jiraSpent={row.secondsSpent} unlogged={unlogged(t)} />
            {/* Only meaningful when boards are pooled; otherwise it's the same
                board on every row and just adds noise. */}
            {row.boardName && <span className="chip-board">{row.boardName}</span>}
            <span className="assignee">{row.assignee ?? 'Unassigned'}</span>
          </div>
          <div className="summary" title={row.summary}>
            {row.summary}
          </div>
          {/* Overrun measured against JIRA's total, since that's the real actual. */}
          <MetaLine
            estimate={row.estimateSeconds}
            actual={(row.secondsSpent ?? 0) + unlogged(t)}
          />
          {/* No description here on purpose. It's the longest thing a story has, and
              inlining it made a "row" as tall as a card; opening the story is now
              how you read it. */}
        </div>
        <button
          className="ghost small disclose"
          onClick={() => toggleCard(row.key)}
          aria-expanded={false}
          aria-label={`Open ${row.key}`}
          title="Open this story"
        >
          ⌄
        </button>
        {receded ? (
          notLogged && t ? (
            <button
              className="small"
              onClick={() => setDoneFor(t)}
              disabled={busy !== null}
              title="Send this tracked time to JIRA as a worklog"
            >
              Log time
            </button>
          ) : null
        ) : (
          <button className="primary small" onClick={() => start(row)} disabled={busy !== null}>
            {tracked > 0 ? 'Resume' : 'Start'}
          </button>
        )}
      </div>
    );
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

      {/* Which iteration the columns below belong to. A subheading now, since the
          stage names do the section-labelling. */}
      <div className="iteration">
        {issuesData?.allBoards ? (
          <span className="name">
            across {issuesData.boardCount} board{issuesData.boardCount === 1 ? '' : 's'}
          </span>
        ) : issuesData?.sprint ? (
          <>
            <span className="lbl">Iteration</span>
            <span className="name">{issuesData.sprint.name}</span>
          </>
        ) : (
          <span className="lbl">No active sprint</span>
        )}
        {/* Refreshing over data we already show: a quiet spinner, no layout shift. */}
        {issuesLoading && issuesData && <span className="spinner sm" aria-label="Refreshing" />}
      </div>

      {!issuesData ? (
        <Loading label="Loading stories from JIRA…" />
      ) : rowCount === 0 ? (
        <div className="empty">
          {!connected
            ? 'Connect to JIRA to see stories.'
            : selectedBoard == null
              ? 'Pick a board above.'
              : mineOnly
                ? 'Nothing assigned to you here.'
                : 'No issues here.'}
        </div>
      ) : (
        <>
          {/* The board's columns, top to bottom in the order the board reads them. */}
          {STAGE_ORDER.map((stage) => (
            <section className={`stage stage-${stage}`} key={stage}>
              <div className="section-label">
                {STAGE_LABELS[stage]}
                <span className="count">{groups[stage].length}</span>
              </div>
              {groups[stage].length === 0 ? (
                <div className="empty sm">Nothing in this column.</div>
              ) : (
                groups[stage].map((row) => renderRow(row, stage))
              )}
            </section>
          ))}
          {/* No column of their own on this board — see StageGroups.elsewhere. */}
          {groups.elsewhere.length > 0 && (
            <section className="stage stage-elsewhere">
              <div className="section-label">
                Tracked elsewhere
                <span className="count">{groups.elsewhere.length}</span>
              </div>
              <div className="section-note">
                Time recorded against stories this board no longer lists.
              </div>
              {groups.elsewhere.map((row) => renderRow(row, 'elsewhere'))}
            </section>
          )}
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
            // Pull JIRA again so the "in JIRA" figure reflects the worklog we just
            // pushed, instead of lagging until the next 30s poll.
            if (selectedBoard != null) loadIssues(selectedBoard, mineOnly);
          }}
        />
      )}
    </div>
  );
}

/**
 * Where this story's tracked time has gone, by activity — all of it, including
 * chunks already sent to JIRA, and whether or not the clock is running.
 *
 * It used to show only unlogged time and hide itself when a single category covered
 * it, on the reasoning that one row restated the clock. Both suppressed the thing
 * that's actually wanted: the clock gives a total, the bars give the shape of it.
 * A story whose time had all been logged showed nothing at all.
 *
 * The already-logged part of each bar is dimmed rather than dropped, so what Done
 * will still send stays distinguishable from what JIRA already has.
 */
function ActivityBreakdown({
  story,
  now,
  activities,
  busy,
  onResolve,
}: {
  story: StoryTimer;
  now: number;
  activities: string[];
  busy: string | null;
  onResolve: (action: 'relabel' | 'discard', activity: string, to?: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const groups = trackedByActivity(story, now);
  if (groups.length === 0) return null;
  const total = groups.reduce((s, g) => s + g.seconds, 0);
  const short = (s: number) => (s < 60 ? '<1m' : formatDurationShort(s));
  return (
    <div className="breakdown">
      {groups.map((g) => {
        const pending = g.seconds - g.loggedSeconds;
        // Any finished chunk can be relabelled, logged or not — otherwise Done
        // stories, whose segments are all logged, could never be fixed. Removing is
        // narrower: dropping logged time would leave the story showing less tracked
        // time than it has already sent.
        const canRelabel = !g.running;
        const canRemove = !g.running && pending > 0;
        const open = editing === g.activity;
        return (
          <Fragment key={g.activity}>
            <div className={`breakdown-row${g.running ? ' is-running' : ''}`}>
              <span className={g.activity === UNLABELLED ? 'faint' : 'muted'}>{g.activity}</span>
              <span
                className="bar-track"
                style={{ width: `${Math.round((g.seconds / total) * 100)}%` }}
              >
                {g.loggedSeconds > 0 && (
                  <span
                    className="bar is-logged"
                    style={{ flexBasis: `${Math.round((g.loggedSeconds / g.seconds) * 100)}%` }}
                    title={`${short(g.loggedSeconds)} already logged to JIRA`}
                  />
                )}
                {pending > 0 && (
                  <span
                    className="bar"
                    style={{ flexBasis: `${Math.round((pending / g.seconds) * 100)}%` }}
                    title={`${short(pending)} not yet sent to JIRA`}
                  />
                )}
              </span>
              {/* Durations format to the minute, so a chunk under one would read "0m". */}
              <b>{short(g.seconds)}</b>
              {canRelabel ? (
                <button
                  className="ghost xs"
                  aria-expanded={open}
                  aria-label={`Change the ${g.activity} time`}
                  title={canRemove ? 'Move or remove this time' : 'Move this time'}
                  onClick={() => {
                    setEditing(open ? null : g.activity);
                    setConfirming(null);
                  }}
                >
                  ⋯
                </button>
              ) : (
                <span className="xs-spacer" />
              )}
            </div>
            {open && (
              <div className="resolve">
                <select
                  value=""
                  disabled={busy !== null}
                  aria-label={`Move the ${g.activity} time to another activity`}
                  onChange={(e) => {
                    if (!e.target.value) return;
                    onResolve('relabel', g.activity, e.target.value);
                    setEditing(null);
                  }}
                >
                  <option value="">Move to…</option>
                  {[...activities, UNLABELLED]
                    .filter((a) => a !== g.activity)
                    .map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                </select>
                {canRemove &&
                  (confirming === g.activity ? (
                    <>
                      <span className="resolve-warn">Remove {short(pending)}?</span>
                      <button
                        className="small danger"
                        disabled={busy !== null}
                        onClick={() => {
                          onResolve('discard', g.activity);
                          setEditing(null);
                          setConfirming(null);
                        }}
                      >
                        Remove
                      </button>
                      <button className="ghost small" onClick={() => setConfirming(null)}>
                        Keep
                      </button>
                    </>
                  ) : (
                    <button
                      className="ghost small"
                      disabled={busy !== null}
                      onClick={() => setConfirming(g.activity)}
                    >
                      Remove…
                    </button>
                  ))}
                {/* Relabelling renames the category here; it can't rewrite the comment
                    on a worklog JIRA already holds. Say so rather than implying it
                    reaches back into JIRA. */}
                {g.loggedSeconds > 0 && (
                  <span className="resolve-note">
                    {canRemove
                      ? `only the ${short(pending)} not yet sent can be removed`
                      : `already logged — renaming it here won’t change JIRA’s worklog`}
                  </span>
                )}
              </div>
            )}
          </Fragment>
        );
      })}
    </div>
  );
}

/**
 * Move a story to any status JIRA offers, in either direction.
 *
 * The running-timer nudge only covers To Do → In Progress at the moment it matters;
 * this covers the rest, including putting something back. Transitions are fetched
 * when the card opens, so a closed board costs nothing.
 */
function StatusControl({
  storyKey,
  status,
  onMoved,
}: {
  storyKey: string;
  status: string;
  onMoved: () => void;
}) {
  const [transitions, setTransitions] = useState<JiraTransition[] | null>(null);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/transitions?key=${encodeURIComponent(storyKey)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { transitions?: JiraTransition[] }) => alive && setTransitions(d.transitions ?? []))
      .catch(() => alive && setTransitions([]));
    return () => {
      alive = false;
    };
  }, [storyKey]);

  const move = async (transitionId: string) => {
    setMoving(true);
    setError(null);
    const { ok, data } = await jpost('/api/transitions', { key: storyKey, transitionId });
    if (ok) {
      onMoved();
      setMoving(false);
    } else {
      setError(data?.error || 'Failed to move the story.');
      setMoving(false);
    }
  };

  const options = transitions ?? [];
  return (
    <div className="status-control">
      <label htmlFor={`status-${storyKey}`}>Status</label>
      <select
        id={`status-${storyKey}`}
        value=""
        disabled={moving || options.length === 0}
        onChange={(e) => e.target.value && move(e.target.value)}
      >
        <option value="">{moving ? 'Moving…' : status}</option>
        {options.map((t) => (
          <option key={t.id} value={t.id}>
            → {t.to || t.name}
          </option>
        ))}
      </select>
      {error && <span className="nudge-error">{error}</span>}
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
 * Two labelled facts per story, and only two:
 *
 *  - what JIRA says is spent, which is the truth. Includes worklogs from before
 *    this app was installed and any made outside it, so it can exceed anything
 *    the timer measured.
 *  - what the timer has measured but not yet sent, which is the only actionable
 *    number: it's exactly what pressing Done will add.
 *
 * `unlogged` is tracked minus what THIS app already logged — never minus JIRA's
 * total, or pre-existing time would cancel out newly tracked work.
 */
function TimeChips({ jiraSpent, unlogged }: { jiraSpent: number | null; unlogged: number }) {
  const spent = jiraSpent ?? 0;
  const showUnlogged = unlogged >= 60; // below a minute it would render "0m"
  if (spent <= 0 && !showUnlogged) return null;
  return (
    <>
      {spent > 0 && (
        <span className="chip-logged" title="Time logged on this issue in JIRA">
          {formatDurationShort(spent)} in JIRA
        </span>
      )}
      {showUnlogged && (
        <span className="chip-tracked" title="Tracked here but not yet sent to JIRA">
          {formatDurationShort(unlogged)} unlogged
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

/**
 * `seconds` is this session's clock; `spent` is the real total — JIRA's logged time
 * plus anything tracked here and not yet sent. The estimate is judged against
 * `spent`, so a story that already had hours logged before this app shows an
 * honest remainder rather than pretending work started from zero.
 */
function EstLine({
  seconds,
  spent,
  estimate,
}: {
  seconds: number;
  spent: number;
  estimate: number | null;
}) {
  const total = Math.max(seconds, spent);
  if (!estimate) {
    return (
      <div className="est-line">
        <b>{formatDurationShort(total)}</b> spent · no estimate set
      </div>
    );
  }
  const over = total > estimate;
  return (
    <div className="est-line">
      <b>{formatDurationShort(total)}</b> spent of <b>{formatDurationShort(estimate)}</b> estimate ·{' '}
      <span className={over ? 'over' : 'under'}>
        {over
          ? `${formatDurationShort(total - estimate)} over`
          : `${formatDurationShort(estimate - total)} left`}
      </span>
    </div>
  );
}

/**
 * Offered when the clock is running on something JIRA still calls To Do.
 *
 * Deliberately a prompt rather than an automatic write: starting a timer must keep
 * working when JIRA is unreachable, so `/api/timer` never calls out. This does the
 * transition afterwards, as a separate request the user asks for. Renders nothing
 * when the story has no transition into the In Progress column.
 */
function MoveToInProgress({ storyKey, onMoved }: { storyKey: string; onMoved: () => void }) {
  const [target, setTarget] = useState<JiraTransition | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [moving, setMoving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(`/api/transitions?key=${encodeURIComponent(storyKey)}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { transitions?: JiraTransition[] }) => {
        if (!alive) return;
        setTarget((d.transitions ?? []).find((t) => t.toStage === 'doing') ?? null);
      })
      .catch(() => {
        /* leave the prompt hidden rather than guessing */
      });
    return () => {
      alive = false;
    };
  }, [storyKey]);

  if (dismissed || !target) return null;

  const move = async () => {
    setMoving(true);
    setError(null);
    const { ok, data } = await jpost('/api/transitions', {
      key: storyKey,
      transitionId: target.id,
    });
    if (ok) {
      setDismissed(true);
      onMoved();
    } else {
      setError(data?.error || 'Failed to move the story.');
      setMoving(false);
    }
  };

  return (
    <div className="nudge">
      <span className="nudge-text">JIRA still has this in To Do.</span>
      <button className="small" onClick={move} disabled={moving}>
        {moving ? 'Moving…' : `Move to ${target.to || 'In Progress'}`}
      </button>
      <button className="ghost small" onClick={() => setDismissed(true)} disabled={moving}>
        Not now
      </button>
      {error && <span className="nudge-error">{error}</span>}
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
      .then((d: { transitions?: JiraTransition[] }) => {
        const list = d.transitions ?? [];
        setTransitions(list);
        // Preselect the transition that finishes the story. This dialog is called
        // Done and used to default to leaving the status alone, so completed work
        // sat in In Progress on the board until someone moved it by hand.
        const finish = preferredDoneTransition(list);
        if (finish) setTransitionId(finish.id);
      })
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
          <button className="primary" onClick={submit} disabled={submitting}>
            {submitting ? 'Logging…' : 'Log to JIRA'}
          </button>
        </div>
      </div>
    </div>
  );
}

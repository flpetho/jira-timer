# JIRA Timer

A small local widget that reads the JIRA stories assigned to you, tracks
**active** time against one story while you work, and — when you finish — logs
the hours as a worklog and (optionally) transitions the story's status.

Built to answer "estimate vs. actual" for planning, without the wall-clock lie:
leaving the window open all weekend adds nothing. Only start→stop segments count.

## Setup

1. Generate a JIRA API token: https://id.atlassian.com/manage-profile/security/api-tokens
2. Copy env and fill in the token:
   ```bash
   cp .env.example .env.local
   # edit .env.local -> set JIRA_EMAIL + JIRA_API_TOKEN
   ```
3. Install and run:
   ```bash
   npm install
   npm run dev        # http://localhost:4100
   ```

## How it works

- **Connection indicator** (`GET /api/me`) validates your token via JIRA `/myself`.
- **Board picker** (`GET /api/boards`) lists every board you can see. The one
  preselected on load is resolved server-side from `JIRA_BOARD_MATCH`, falling
  back to the first board.
- **Story list** (`GET /api/stories?board=&mine=`) pulls the board's **active
  sprint** (falling back to all board issues when there's no active sprint),
  filtered by `resolution = Unresolved`, plus `assignee = currentUser()` when
  "mine only" is on. It deliberately never touches the local timer store, so
  timer actions never block on a JIRA call.
- **Start/Pause** open and close time segments; active time = Σ segments (`lib/time.ts`).
- **Done** posts a worklog (`timeSpentSeconds`, rounded to `TIMER_ROUND_MINUTES`) and, if you pick one, a status transition. The returned `worklogId` is stored so a story can't be double-logged.
- State persists to `~/.jira-timer/state.json` (human-readable; survives restarts; accrues across days).

## Env (`.env.local`)

| var | meaning |
|-----|---------|
| `JIRA_BASE_URL` | e.g. `https://your-org.atlassian.net` |
| `JIRA_EMAIL` | your Atlassian account email |
| `JIRA_API_TOKEN` | personal API token (never committed) |
| `JIRA_BOARD_MATCH` | case-insensitive substring of the board to preselect; blank = first board |
| `TIMER_ROUND_MINUTES` | round logged time to nearest N minutes (default 5) |

## Run at login (macOS)

A launchd agent (`com.jira-timer`) serves the production build on port 4100 so
the timer is always available.

```bash
sh scripts/service.sh start|stop|restart|status|update
```

`update` rebuilds the app and restarts the agent — run it after code changes.

## Tests

```bash
npm test        # pure time + state-transition logic (vitest)
```

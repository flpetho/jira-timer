#!/bin/sh
# A throwaway JIRA Timer to poke at, wired to a fake JIRA and a scratch state file.
#
# Nothing here can reach a real board or your real tracked time:
#   - JIRA_BASE_URL points at scripts/mock-jira.mjs, so worklogs and transitions
#     land in that process's memory and vanish when it stops.
#   - HOME is redirected, so state lives in <scratch>/.jira-timer/state.json rather
#     than in your own home folder.
#   - It serves on 4200, leaving the always-on instance on 4100 alone.
#
#   sh scripts/sandbox.sh
#
# Ctrl-C stops both processes.

set -e
cd "$(dirname "$0")/.." || exit 1

APP_PORT=${APP_PORT:-4200}
MOCK_PORT=${MOCK_PORT:-4199}
SCRATCH=${SCRATCH:-$(mktemp -d /tmp/jira-timer-sandbox.XXXXXX)}

mkdir -p "$SCRATCH/.jira-timer"

# Fail with something readable rather than a stack trace from whichever process loses.
# A short wait first: a just-stopped sandbox holds its port for a moment, and
# restarting immediately is the common case.
for port in "$APP_PORT" "$MOCK_PORT"; do
  waited=0
  while lsof -ti:"$port" >/dev/null 2>&1; do
    if [ "$waited" -ge 60 ]; then
      echo "Port $port is still in use after 12s — an older sandbox may be running." >&2
      echo "Stop it, or use another: APP_PORT=4300 MOCK_PORT=4299 sh scripts/sandbox.sh" >&2
      exit 1
    fi
    [ "$waited" -eq 0 ] && echo "Waiting for port $port to free up…"
    sleep 0.2
    waited=$((waited + 1))
  done
done

cleanup() {
  # Children first: `npx next dev` spawns the server that actually holds the port, and
  # killing only the wrapper orphans it — leaving 4200 occupied after Ctrl-C.
  for pid in "$MOCK_PID" "$APP_PID"; do
    [ -n "$pid" ] || continue
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

node scripts/mock-jira.mjs "$MOCK_PORT" &
MOCK_PID=$!

# Wait for the mock to actually answer. A fixed sleep fails on a slow cold start, and
# starting the app against a dead mock just produces a confusing setup screen.
ready=""
i=0
while [ "$i" -lt 25 ]; do
  if curl -sf "http://localhost:$MOCK_PORT/rest/api/2/myself" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.2
  i=$((i + 1))
done
if [ -z "$ready" ]; then
  echo "Mock JIRA never answered on $MOCK_PORT after 5s. See the output above." >&2
  exit 1
fi

echo "Sandbox state → $SCRATCH/.jira-timer/state.json"
echo "Starting the app on http://localhost:$APP_PORT …"
echo ""

# The mock accepts any credentials, so these are deliberately obvious fakes.
# `next dev` is used so .env.local isn't needed and edits reload.
HOME="$SCRATCH" \
JIRA_BASE_URL="http://localhost:$MOCK_PORT" \
JIRA_EMAIL="dana@example.test" \
JIRA_API_TOKEN="sandbox-not-a-real-token" \
JIRA_BOARD_MATCH="Checkout" \
JIRA_ACTIVITIES="Meeting,Building,Testing,Review,Other" \
  npx next dev -p "$APP_PORT" &
APP_PID=$!

wait $APP_PID

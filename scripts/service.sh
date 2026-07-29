#!/bin/sh
# Manage the JIRA Timer login service (macOS launchd agent).
# Usage: sh scripts/service.sh {start|stop|restart|status|update}
LABEL="com.jira-timer"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

case "$1" in
  start)
    launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null
    echo "started (http://localhost:4100)"
    ;;
  stop)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null
    echo "stopped"
    ;;
  restart)
    launchctl kickstart -k "$DOMAIN/$LABEL"
    echo "restarted"
    ;;
  status)
    launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E "state =|pid =" || echo "not loaded"
    ;;
  update)
    # Rebuild the app and restart the service to pick up code changes.
    cd "$(dirname "$0")/.." || exit 1
    npm run build && launchctl kickstart -k "$DOMAIN/$LABEL" && echo "rebuilt + restarted"
    ;;
  *)
    echo "usage: sh scripts/service.sh {start|stop|restart|status|update}"
    ;;
esac

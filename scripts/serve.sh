#!/bin/sh
# Production server for JIRA Timer — launched by launchd on login.
# Requires a prior `npm run build` (serves the .next production build).
cd "$(dirname "$0")/.." || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
exec /usr/local/bin/node node_modules/next/dist/bin/next start -p 4100

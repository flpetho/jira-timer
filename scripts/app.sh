#!/bin/sh
# Open JIRA Timer in a chrome-less standalone window (Chromium "app mode").
# Usage: npm run app   (dev server must be running on :4100)
URL="${1:-http://localhost:4100}"

for BIN in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
  if [ -x "$BIN" ]; then
    "$BIN" --app="$URL" --window-size=460,820 >/dev/null 2>&1 &
    exit 0
  fi
done

echo "No Chromium-based browser found."
echo "Open $URL and use the browser's 'Install app' option instead."

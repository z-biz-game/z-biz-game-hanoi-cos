#!/usr/bin/env bash
# One-shot verification: the node suites first, then a real browser against a real static
# server, driven over CDP. Everything this script starts exits with it, including the Chrome it
# launched with a throwaway profile.
#
# PORTS: WEB_PORT=5192 / CDP_PORT=9352. They MUST NOT collide with the rest of the family that
# may be running on this machine at the same time: gridlock serves :5180 with devtools :9340,
# nine-rings 5181/9341, hashashi 5181/9341, pour + lightsout 5190/9341, ferry 5188/9348,
# eulertrail 5186/9346, matchwork 5185/9345, tango 5191/9351, point24 5187/9347. Only one
# headless Chrome may run at a time on this box, so if :9352 is taken, change both here (or in
# the environment) rather than killing a process that is not yours.
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterisation saturates the cores and, with no CDP client attached, the process will not exit
# on its own. This board is plain 2D canvas, so stock headless Chrome is enough.
#
#   ./tools/verify.sh                                # suites + @boot @play @routes @save @reloaded @pointer @line
#   SCENARIOS="pointer" ./tools/verify.sh            # just the finger suite while editing the view
#   SKIP_UNIT=1 ./tools/verify.sh                    # browser only (what the CI browser job does)
#   BAKE_FIRST=1 ./tools/verify.sh                   # re-measure the table, then verify it
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
CDP_PORT=${CDP_PORT:-9352}
WEB_PORT=${WEB_PORT:-5192}
BASE=${BASE_URL:-http://127.0.0.1:$WEB_PORT/}
SHOTS=${SHOTS:-/tmp/puzzle-brief/shots}
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

# One headless Chrome at a time: refuse to start if somebody else's devtools port is bound.
if lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -q ":$CDP_PORT "; then
  echo "CDP_PORT $CDP_PORT is already listening — another playtest is running." >&2
  echo "wait for it, or rerun with CDP_PORT=… WEB_PORT=…" >&2
  exit 3
fi

mkdir -p "$SHOTS"
UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$CDP_PORT --user-data-dir=$UDD \
  --window-size=1000,820 --no-first-run --no-default-browser-check about:blank >/tmp/hanoi-chrome.log 2>&1 &
CPID=$!
node "$HERE/server.cjs" $WEB_PORT >/tmp/hanoi-server.log 2>&1 &
SPID=$!
cleanup() {
  kill -9 $CPID $SPID 2>/dev/null
  wait $CPID 2>/dev/null
  wait $SPID 2>/dev/null
  rm -rf $UDD
}
trap cleanup EXIT
# The watchdog redirects its own descriptors: a background subshell would otherwise inherit the
# script's stdout and hold the write end open for the whole timeout, stalling any pipeline that
# consumes this script's output long after the tests finished.
( sleep ${WD_TIMEOUT:-420}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# A fresh --user-data-dir binds DevTools later than a warm profile, and the static server needs a
# moment too: wait on both endpoints instead of guessing a sleep duration.
for i in $(seq 1 60); do
  curl -fsS -m 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$CDP_PORT" >&2; exit 3; }
for i in $(seq 1 40); do
  curl -fsS -m 1 "$BASE" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -fsS -m 2 "$BASE" >/dev/null 2>&1 || {
  echo "static server never answered on $BASE" >&2; exit 4; }

cd "$HERE"
FAILED=0

echo "=== bake (re-measure the table) ==="
# --check re-solves every row and writes nothing; BAKE_FIRST=1 regenerates js/data/lots.js.
if [ -n "${BAKE_FIRST:-}" ]; then
  node tools/bake.mjs >/tmp/hanoi-bake.log 2>&1 || FAILED=1
else
  node tools/bake.mjs --check >/tmp/hanoi-bake.log 2>&1 || FAILED=1
fi
tail -4 /tmp/hanoi-bake.log

echo "=== node suites ==="
# SKIP_UNIT=1 for the browser job in CI: the suites are its own job there.
if [ -z "${SKIP_UNIT:-}" ]; then
  for f in test/*.test.mjs; do
    echo "--- $f"
    # Not a pipe: `node f | tail` reports tail's status, and a red suite would sail through.
    node "$f" >/tmp/hanoi-unit.log 2>&1
    rc=$?
    tail -4 /tmp/hanoi-unit.log
    [ $rc -eq 0 ] || FAILED=1
  done
fi

export CDP_PORT
export BASE_URL=$BASE
node tools/playtest.mjs open "$BASE" | head -3
# js/data/lots.js has 32 measured rows and the shell resolves a route before it reports a state,
# so wait on window.hanoi rather than on a timer.
BOOT=""
for i in $(seq 1 60); do
  BOOT=$(node tools/playtest.mjs eval "window.hanoi?window.hanoi.state.id:'nope'" nonav 2>/dev/null | tr -d '\n" ')
  case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
done
echo "boot level: $BOOT"
case "$BOOT" in
  lot-*|daily-*|random-*) ;;
  *) echo "window.hanoi never reported a level at $BASE (got: $BOOT)" >&2; exit 5 ;;
esac

# @reloaded has to run after @save (it reads what @save left on disk through a real page reload),
# and every scenario shares this one browser process, which is what makes the persistence check
# mean something.
for s in ${SCENARIOS:-boot play routes save reloaded pointer line}; do
  echo "=== @$s ==="
  if [ "$s" = "reloaded" ]; then
    OUT=$(node tools/playtest.mjs eval "@$s" 2>&1)
  else
    OUT=$(node tools/playtest.mjs eval "@$s" nonav 2>&1)
  fi
  printf '%s\n' "$OUT" | python3 -c '
import sys, json
raw = sys.stdin.read()
# The driver marks its machine-readable line with `RESULT `. Counting braces from the first `{`
# instead would grab a per-row detail object printed before it — @pointer prints one line per
# assertion — and the suite would be read as far smaller than it is.
line = [l for l in raw.splitlines() if l.startswith("RESULT ")]
if not line:
    print("NO RESULT", raw[-400:]); sys.exit(1)
try:
    d = json.loads(line[-1][len("RESULT "):])
except Exception as e:
    print("BAD JSON", e, line[-1][:200]); sys.exit(1)
rows = d.get("rows", [])
print("rows:", len(rows), "fail:", d.get("fail"), "console:", d.get("console"))
for r in rows:
    if not r["pass"]: print("  FAIL", r["test"], json.dumps(r.get("detail"), ensure_ascii=False)[:240])
# The driver counted the page console; a non-zero count is a red suite even with every row green.
sys.exit(1 if (d.get("fail") or d.get("console")) else 0)
' || FAILED=1
  # A clean console is part of the contract: a thrown page error, a refused resource or a
  # rendering warning all count, even when every assertion above happened to pass.
  if printf '%s\n' "$OUT" | grep -qE '\[EXCEPTION\]|\[log:[a-z]+\]|\[(error|warning)\]'; then
    echo "  CONSOLE NOT CLEAN for @$s"
    printf '%s\n' "$OUT" | grep -E '\[EXCEPTION\]|\[log:[a-z]+\]|\[(error|warning)\]' | head -5
    FAILED=1
  fi
  node tools/playtest.mjs shot "$SHOTS/hanoi-$s.png" >/dev/null 2>&1
done

echo "=== console ==="
# The Log domain replays its buffer to a freshly attached client, so this dump sees everything the
# page said during the whole run — including advisories that arrived between two scenarios, where
# no per-scenario grep could reach them. Reading it without failing on it is how a dirty page used
# to print ALL GREEN.
LOGDUMP=$(node tools/playtest.mjs logs)
echo "$LOGDUMP"
if printf '%s\n' "$LOGDUMP" | grep -qE '\[EXCEPTION\]|\[log:[a-z]+\]|\[(error|warning)\]'; then
  echo "CONSOLE NOT CLEAN OVER THE WHOLE RUN" >&2
  FAILED=1
fi
kill $WD 2>/dev/null
wait $WD 2>/dev/null
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED

#!/bin/bash
#
# SwiftBar plugin: Magic Sticky dev-server control panel.
#
# Renders a menu-bar daisy glyph (🌼 green = all up / red = something down) with a
# dropdown row per server (up/down + Start/Stop), plus Start all / Stop all,
# Open logs, tests, a Fly deploy, and links to the live app + docs.
#
# The SAME script handles rendering (SwiftBar calls it with no args every 3s) and
# actions (invoked via `bash=... param0=...` menu lines).
#
# GUI apps don't inherit the login-shell PATH, so external tools are called by
# absolute path. Paths derive from $HOME so it works under any username.
#
# Install: symlink into SwiftBar's plugin folder, e.g.
#   ln -s "$HOME/Code/magicsticky/tools/swiftbar/magicsticky-servers.3s.sh" \
#         "$HOME/Library/Application Support/SwiftBar/Plugins/magicsticky-servers.3s.sh"
# (matches how aether's plugin is installed). See tools/swiftbar/README.md.

# <xbar.title>Magic Sticky Dev Servers</xbar.title>
# <xbar.version>1.0</xbar.version>
# <xbar.author>Andrew Baldock</xbar.author>
# <xbar.desc>Start/stop the Magic Sticky dev servers with live up/down status.</xbar.desc>

BUN="$HOME/.bun/bin/bun"
FLY="$HOME/.fly/bin/fly"
LSOF="/usr/sbin/lsof"
CURL="/usr/bin/curl"
SELF="$0"

CODE_DIR="$HOME/Code"
MS_DIR="${CODE_DIR}/magicsticky"

LIVE_URL="https://magicsticky.andrewbaldock.com"
GH_BASE="https://github.com/andrewbaldock/magicsticky/blob/main"
GOOGLE_CLIENT_ID="91567435125-jr7t0tds56jg684ebl9pensj1ti3kgka.apps.googleusercontent.com"

run_in_terminal() {
  local cmd="$1"
  osascript \
    -e "tell application \"Terminal\" to do script \"${cmd}; echo; echo '— done. Press any key to close. —'; read -n 1; exit\"" \
    -e 'tell application "Terminal" to activate'
}

# server registry: name|port|dir|uptype|cmd
#   uptype: http = any HTTP response on / | health = /healthz returns "ok"
#   cmd:    bun args to start it (default "run dev")
SERVERS=(
  "magicsticky-api|3001|${MS_DIR}|health|run start"
  "magicsticky-web|5180|${MS_DIR}|http|run dev:web"
)

# --- helpers ---------------------------------------------------------------

is_up() {
  local port="$1" uptype="$2"
  if [ "$uptype" = "health" ]; then
    "$CURL" -fsS --max-time 2 "http://localhost:${port}/healthz" 2>/dev/null | grep -q '"status":"ok"'
    return $?
  fi
  local code
  code=$("$CURL" -s -o /dev/null -w '%{http_code}' --max-time 2 "http://localhost:${port}/" 2>/dev/null)
  [ -n "$code" ] && [ "$code" != "000" ]
}

start_server() {
  local port="$1"
  for s in "${SERVERS[@]}"; do
    IFS='|' read -r name p dir uptype cmd <<< "$s"
    if [ "$p" = "$port" ]; then
      cd "$dir" || exit 1
      # The API needs a token to boot (it refuses without MAGICSTICKY_TOKEN); it reads .env
      # automatically via Bun, so a local .env must exist. nohup + log to /tmp.
      PATH="$HOME/.bun/bin:$PATH" nohup "$BUN" $cmd > "/tmp/${name}.log" 2>&1 &
      disown
      return 0
    fi
  done
}

stop_server() {
  local port="$1"
  local pids
  pids=$("$LSOF" -ti:"$port" 2>/dev/null)
  if [ -n "$pids" ]; then
    echo "$pids" | xargs kill 2>/dev/null
    sleep 1
    pids=$("$LSOF" -ti:"$port" 2>/dev/null)
    [ -n "$pids" ] && echo "$pids" | xargs kill -9 2>/dev/null
  fi
}

# --- action dispatch -------------------------------------------------------
case "$1" in
  start) start_server "$2"; exit 0 ;;
  stop) stop_server "$2"; exit 0 ;;
  startall)
    for s in "${SERVERS[@]}"; do
      IFS='|' read -r name p dir uptype cmd <<< "$s"
      is_up "$p" "$uptype" || start_server "$p"
    done
    exit 0 ;;
  stopall)
    for s in "${SERVERS[@]}"; do
      IFS='|' read -r name p dir uptype cmd <<< "$s"
      stop_server "$p"
    done
    exit 0 ;;
  deploy)
    # Fly deploy with the public client id as a build-arg (the GIS button needs it baked in).
    run_in_terminal "cd ${MS_DIR} && ${FLY} deploy -a magicsticky --build-arg VITE_GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}"
    exit 0 ;;
  test-unit)
    run_in_terminal "cd ${MS_DIR} && ${BUN} run test"
    exit 0 ;;
  test-e2e)
    run_in_terminal "cd ${MS_DIR} && ${BUN} run test:e2e"
    exit 0 ;;
  build-web)
    run_in_terminal "cd ${MS_DIR} && ${BUN} run build:web"
    exit 0 ;;
esac

# --- render ----------------------------------------------------------------
up_count=0
total=0
rows=""

for s in "${SERVERS[@]}"; do
  IFS='|' read -r name p dir uptype cmd <<< "$s"
  total=$((total + 1))
  if is_up "$p" "$uptype"; then
    up_count=$((up_count + 1))
    rows+="🌼 ${name} :${p} | color=#1faa59\n"
    rows+="-- Stop ${name} | bash=\"${SELF}\" param0=stop param1=${p} terminal=false refresh=true\n"
  else
    rows+="🌼 ${name} :${p} | color=#BA4951\n"
    rows+="-- Start ${name} | bash=\"${SELF}\" param0=start param1=${p} terminal=false refresh=true\n"
  fi
  rows+="-- Open ${name} log | bash=/usr/bin/open param0=-a param1=Console param2=/tmp/${name}.log terminal=false\n"
done

# Daisy glyph: green when all up, dusty red otherwise.
if [ "$up_count" -eq "$total" ]; then
  dot_color="#1faa59"
else
  dot_color="#BA4951"
fi

echo "🌼 | color=${dot_color} size=16"
echo "---"
echo "Magic Sticky — ${up_count}/${total} up | size=11 color=#888888"
echo "---"
echo -e "$rows"
echo "---"
echo "Open dev (web :5180) | href=http://localhost:5180 color=#5B8DEF"
echo "Open live app | href=${LIVE_URL} color=#5B8DEF"
echo "---"

echo "Tests | color=#888888"
echo "-- Unit (bun test) | bash=\"${SELF}\" param0=test-unit terminal=false"
echo "-- E2E (Playwright) | bash=\"${SELF}\" param0=test-e2e terminal=false"
echo "-----"
echo "-- Build web (vite build) | bash=\"${SELF}\" param0=build-web terminal=false color=#C77D3A"

echo "Docs | color=#888888"
echo "-- Architecture | href=${GH_BASE}/docs/architecture.md"
echo "-- Phase 2 plan | href=${GH_BASE}/plans/phase2-hosted-oauth.md"
echo "-- Repo on GitHub | href=https://github.com/andrewbaldock/magicsticky"

echo "---"
echo "Deploy to Fly (fly deploy) | bash=\"${SELF}\" param0=deploy terminal=false color=#C77D3A"
echo "---"
echo "Start all | bash=\"${SELF}\" param0=startall terminal=false refresh=true color=#1faa59"
echo "Stop all | bash=\"${SELF}\" param0=stopall terminal=false refresh=true color=#BA4951"
echo "Refresh now | refresh=true color=#888888"

#!/usr/bin/env bash
#
# e2e-env.sh — lifecycle for the isolated Orchestron environment that the
# docs/e2e-tests/ scenarios run against.
#
# The problem it solves: those scenarios kill sessions, delete records and
# flip config flags. Run them against the deployed instance and they eat
# real work. This brings up a second, complete Orchestron on the same host —
# its own data dir, port, bearer token, agent credentials and web bundle —
# so a full sweep is destructive only to itself.
#
#   ./scripts/e2e-env.sh up          start it (installs units, waits ready)
#   ./scripts/e2e-env.sh down        stop it and wipe its data
#   ./scripts/e2e-env.sh status      what is running, and is it isolated
#   ./scripts/e2e-env.sh reset       down + up, i.e. a clean slate
#   ./scripts/e2e-env.sh build       build the E2E web bundle (needed once)
#   ./scripts/e2e-env.sh fixtures    (re-)register the fixture projects
#   ./scripts/e2e-env.sh logs [api|web]   tail a service
#   ./scripts/e2e-env.sh token       print the E2E bearer token
#   ./scripts/e2e-env.sh env         print shell exports for a scenario run
#   ./scripts/e2e-env.sh wait <uuid> <status> [timeout]
#                                    poll a session to a status, honouring 429
#   ./scripts/e2e-env.sh test-self   self-check: up → assert → down → assert
#
# Everything is overridable from the environment; see CONFIG below. Nothing
# here touches the deployed instance, and `status` / `test-self` assert that
# rather than assuming it.
#
set -uo pipefail

# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------

# Repo root — derived from this script's own location, so running the copy
# inside a git worktree brings up *that* worktree's code. Override with
# E2E_REPO to point the units somewhere else.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
E2E_REPO="${E2E_REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}"

E2E_DATA_DIR="${E2E_DATA_DIR:-$HOME/.orchestron-e2e}"
E2E_API_PORT="${E2E_API_PORT:-8091}"
E2E_WEB_PORT="${E2E_WEB_PORT:-3011}"
E2E_CLAUDE_CONFIG_DIR="${E2E_CLAUDE_CONFIG_DIR:-$HOME/ClaudeConfigs/e2e}"
E2E_DIST_DIR="${E2E_DIST_DIR:-.next-e2e}"

# Cheap and fast: Haiku 4.5 answers a fixture prompt in ~10-20s for cents.
# A sweep of ~90 scenarios on Opus would cost more than the bugs it finds.
E2E_DEFAULT_MODEL="${E2E_DEFAULT_MODEL:-claude-haiku-4-5}"
# 4, not the RAM-derived default: a scenario sweep is sequential, and a low
# cap is itself testable (docs/e2e-tests/ has queue scenarios).
E2E_MAX_CONCURRENT="${E2E_MAX_CONCURRENT:-4}"
# 1 minute. The sleep/wake scenarios otherwise idle for the deployed
# instance's 15.
E2E_IDLE_TIMEOUT_MS="${E2E_IDLE_TIMEOUT_MS:-60000}"

# Fixture workspaces. These paths are what docs/e2e-tests/00-setup.md §4
# already names — keep them in sync with that table, it is the spec.
E2E_WORKSPACE_ROOT="${E2E_WORKSPACE_ROOT:-/tmp/orchestron-e2e}"

# The deployed instance, for the isolation assertions only. Read from its own
# config so this does not hard-code a port that has since moved.
PROD_DATA_DIR="${PROD_DATA_DIR:-$HOME/.orchestron}"
# Where the deployed units run from. Distinct from E2E_REPO: running this
# script out of a git worktree means E2E_REPO is that worktree, and the
# "did we clobber the deployed web build" check has to look at the tree the
# deployed unit actually serves.
PROD_REPO="${PROD_REPO:-$HOME/Works/agent-hq-orchestron}"

API_UNIT="orchestron-api-e2e.service"
WEB_UNIT="orchestron-web-e2e.service"
UNIT_DIR="$HOME/.config/systemd/user"

READY_TIMEOUT_SECS="${READY_TIMEOUT_SECS:-60}"

# ---------------------------------------------------------------------------
# output helpers
# ---------------------------------------------------------------------------

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_BOLD=$'\033[1m'
else
  C_RESET=''; C_DIM=''; C_RED=''; C_GREEN=''; C_YELLOW=''; C_BOLD=''
fi

log()  { printf '%s\n' "$*"; }
info() { printf '%s==>%s %s\n' "$C_BOLD" "$C_RESET" "$*"; }
ok()   { printf '  %sok%s   %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %swarn%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
bad()  { printf '  %sFAIL%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; }
dim()  { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_RESET"; }
die()  { printf '%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# preconditions
# ---------------------------------------------------------------------------

have() { command -v "$1" >/dev/null 2>&1; }

require_linux_systemd() {
  have systemctl || die "systemctl not found. This script targets Linux user
  services. On macOS the same env vars work with launchd — see
  scripts/README.md 'macOS'."
  systemctl --user show-environment >/dev/null 2>&1 \
    || die "no systemd user session (is XDG_RUNTIME_DIR set? try 'loginctl enable-linger \$USER')"
}

require_tools() {
  local missing=()
  for t in python3 curl node; do have "$t" || missing+=("$t"); done
  [ ${#missing[@]} -eq 0 ] || die "missing required tools: ${missing[*]}"
}

# The one thing this script genuinely cannot do for you. `claude` OAuth is
# interactive, so the E2E config dir has to be logged into by hand — once.
check_agent_credentials() {
  local creds="$E2E_CLAUDE_CONFIG_DIR/.credentials.json"
  if [ -s "$creds" ]; then
    ok "claude credentials present in $E2E_CLAUDE_CONFIG_DIR"
    return 0
  fi
  bad "no claude credentials at $creds"
  cat >&2 <<EOF

  The E2E environment spawns agents against its own CLAUDE_CONFIG_DIR so a
  test run cannot touch, rate-limit or log out your real session. That dir
  has to be authenticated once, interactively — OAuth cannot be scripted:

      mkdir -p $E2E_CLAUDE_CONFIG_DIR
      CLAUDE_CONFIG_DIR=$E2E_CLAUDE_CONFIG_DIR claude
      # then /login, complete the browser flow, and /exit

  Use the dedicated E2E account, not your own — a sweep burns quota and
  every session it leaves behind shows up in that account's history.

  Then re-run: $0 up
EOF
  return 1
}

# ---------------------------------------------------------------------------
# small utilities
# ---------------------------------------------------------------------------

port_open() {
  # Bash's /dev/tcp is enough and avoids depending on ss/lsof/netstat.
  (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && exec 3<&- && return 0
  return 1
}

json_get() {
  # json_get <file> <key> — one top-level key, empty string when absent.
  python3 - "$1" "$2" <<'PY' 2>/dev/null
import json, sys
try:
    with open(sys.argv[1]) as fh:
        print(json.load(fh).get(sys.argv[2], '') or '')
except Exception:
    print('')
PY
}

e2e_token() {
  json_get "$E2E_DATA_DIR/config.json" remoteToken
}

api_base() { printf 'http://127.0.0.1:%s' "$E2E_API_PORT"; }
web_base() { printf 'http://127.0.0.1:%s' "$E2E_WEB_PORT"; }

# Where the DEPLOYED api actually answers. Not necessarily loopback — this
# host binds it to its tailnet address — and getting this wrong is not a
# harmless mistake: probing 127.0.0.1:8090 returns "not running" for a
# perfectly healthy instance, and the isolation assertion that depends on it
# then passes by skipping itself.
prod_api_base() {
  local host port
  host="$(json_get "$PROD_DATA_DIR/config.json" bindHost)"
  port="$(json_get "$PROD_DATA_DIR/config.json" port)"
  host="${host:-127.0.0.1}"
  port="${port:-8090}"
  # A wildcard bind is not a dialable address; loopback reaches it.
  [ "$host" = "0.0.0.0" ] && host="127.0.0.1"
  [ "$host" = "::" ] && host="127.0.0.1"
  printf 'http://%s:%s' "$host" "$port"
}

# Authenticated GET against the E2E API. Prints body, returns curl's status.
api_get() {
  local path="$1" tok
  tok="$(e2e_token)"
  curl -fsS --max-time 15 -H "Authorization: Bearer $tok" "$(api_base)$path"
}

api_post() {
  local path="$1" body="$2" tok
  tok="$(e2e_token)"
  curl -fsS --max-time 20 -X POST \
    -H "Authorization: Bearer $tok" -H 'Content-Type: application/json' \
    -d "$body" "$(api_base)$path"
}

# Authenticated GET that keeps the status code *and* the body, so a 429 can be
# told apart from a transport failure. `api_get` uses `curl -f`, which throws
# both away. Prints the body, then the code on its own final line.
api_get_code() {
  local path="$1" tok
  tok="$(e2e_token)"
  curl -sS --max-time 15 -w '\n%{http_code}' \
    -H "Authorization: Bearer $tok" "$(api_base)$path"
}

# Seconds the API asked us to back off for, read out of a 429 body
# ("Rate limit exceeded, retry in 4 seconds"). Falls back to 4 — the value the
# API has been observed to send — when the body says nothing useful.
retry_after_secs() {
  local body="$1" n
  n="$(printf '%s' "$body" | sed -n 's/.*retry in \([0-9][0-9]*\) second.*/\1/p' | head -1)"
  printf '%s' "${n:-4}"
}

# Poll a session until it reaches a status, or give up.
#
#   wait_for_status <uuid> <status[|status...]> [timeout-secs]
#
# The API rate-limits fast polling — a tight curl loop over
# GET /api/sessions/:uuid earns a 429 asking for a 4s back-off, and briefly
# makes the environment look wedged rather than busy. That is correct product
# behaviour, so this paces itself around it instead: 500ms between polls, and
# on a 429 it sleeps for as long as the response asked before trying again.
# Time spent backing off still counts against the timeout.
#
# `status` may be an alternation, which is what a real wait usually needs:
#   wait_for_status "$id" 'idle|needs_input' 120
#
# Returns 0 on arrival, 1 on timeout or on a session that has gone away.
wait_for_status() {
  local uuid="$1" target="$2" timeout="${3:-60}"
  local deadline=$((SECONDS + timeout))
  local out code body status

  while [ $SECONDS -lt $deadline ]; do
    out="$(api_get_code "/api/sessions/$uuid" 2>/dev/null)"
    code="${out##*$'\n'}"
    body="${out%$'\n'*}"

    case "$code" in
      429)
        sleep "$(retry_after_secs "$body")"
        continue
        ;;
      404)
        bad "session $uuid is gone — cannot wait for '$target'"
        return 1
        ;;
      200)
        status="$(printf '%s' "$body" | python3 -c \
          'import json,sys;print(json.load(sys.stdin).get("status",""))' 2>/dev/null)"
        # Anchored regex, not a `case` pattern: `case` parses its alternation
        # at parse time, so a `|` arriving inside an expanded variable is
        # matched as a literal and every alternation silently never fires.
        [[ "$status" =~ ^($target)$ ]] && return 0
        ;;
    esac

    sleep 0.5
  done

  bad "session $uuid did not reach '$target' within ${timeout}s (last: ${status:-unknown})"
  return 1
}

cmd_wait() {
  local uuid="${1:-}" target="${2:-}" timeout="${3:-60}"
  [ -n "$uuid" ] && [ -n "$target" ] || die "usage: $0 wait <uuid> <status[|status]> [timeout]"
  wait_for_status "$uuid" "$target" "$timeout" && ok "session $uuid reached '$target'"
}

# ---------------------------------------------------------------------------
# destructive-path guard
#
# `down` does rm -rf on a path under $HOME. A typo'd or empty E2E_DATA_DIR
# would make that a very bad afternoon, so refuse anything that is not
# recognisably an E2E data dir.
# ---------------------------------------------------------------------------
assert_wipeable() {
  local d="$1"
  [ -n "$d" ]                       || die "refusing to wipe: empty path"
  [ "$d" != "/" ]                   || die "refusing to wipe: /"
  [ "$d" != "$HOME" ]               || die "refusing to wipe: \$HOME"
  [ "${d#"$HOME"/}" != "$d" ]       || die "refusing to wipe outside \$HOME: $d"
  case "$d" in
    *e2e*) : ;;
    *) die "refusing to wipe a path with no 'e2e' in it: $d" ;;
  esac
  # The single most expensive mistake available here.
  [ "$d" != "$PROD_DATA_DIR" ] || die "refusing to wipe the deployed data dir: $d"
}

# ---------------------------------------------------------------------------
# config.json
# ---------------------------------------------------------------------------

write_config() {
  mkdir -p "$E2E_DATA_DIR"
  local cfg="$E2E_DATA_DIR/config.json" token

  # Reuse an existing token so a stop/start cycle does not invalidate the
  # bearer a scenario run already exported. `down` wipes the dir, so a fresh
  # cycle still gets a fresh token.
  token="$(e2e_token)"
  if [ -z "$token" ]; then
    if have openssl; then
      token="e2e-$(openssl rand -hex 20)"
    else
      token="e2e-$(python3 -c 'import secrets;print(secrets.token_hex(20))')"
    fi
  fi

  E2E_TOKEN="$token" \
  E2E_API_PORT="$E2E_API_PORT" \
  E2E_DATA_DIR="$E2E_DATA_DIR" \
  E2E_MAX_CONCURRENT="$E2E_MAX_CONCURRENT" \
  E2E_IDLE_TIMEOUT_MS="$E2E_IDLE_TIMEOUT_MS" \
  python3 - "$cfg" <<'PY'
import json, os, sys

# Merge rather than overwrite: a scenario file may have flipped
# enableHeadlessMode or headlessStructuredOutput and be mid-run. Only the
# keys that define the *environment* are forced.
path = sys.argv[1]
try:
    with open(path) as fh:
        cfg = json.load(fh)
except Exception:
    cfg = {}

cfg.update({
    'bindHost': '127.0.0.1',
    'port': int(os.environ['E2E_API_PORT']),
    'dataDir': os.environ['E2E_DATA_DIR'],
    'remoteToken': os.environ['E2E_TOKEN'],
    # NOTE: there is deliberately no 'defaultModel' here. A default model is
    # a *project* field (ProjectMetadata.defaultModel); ConfigSchema has no
    # such key and Zod would strip it silently, leaving a line in this file
    # that looks load-bearing and is not. The cheap model is set on the
    # `e2e-haiku` fixture project instead.
    'maxConcurrent': int(os.environ['E2E_MAX_CONCURRENT']),
    'idleTimeoutMs': int(os.environ['E2E_IDLE_TIMEOUT_MS']),
    'adapters': {'claude': True, 'codex': True, 'opencode': False},
    'logLevel': 'debug',
})
# Feature flags: only seed them, never force. feature-flag.md toggles these
# and reruns `up`; forcing would silently undo the scenario's own setup.
cfg.setdefault('enableHeadlessMode', True)
cfg.setdefault('headlessStructuredOutput', True)

with open(path, 'w') as fh:
    json.dump(cfg, fh, indent=2)
    fh.write('\n')
PY

  # config.json holds the bearer in plaintext; the API warns loudly if it is
  # group/world readable.
  chmod 600 "$cfg"
  ok "config $cfg (port $E2E_API_PORT, maxConcurrent $E2E_MAX_CONCURRENT)"
}

# Directories the API expects to exist or will create, plus the isolated
# memory pools the units point at.
scaffold_data_dir() {
  mkdir -p "$E2E_DATA_DIR"/{sessions,projects,schedules,notes,logs,shared-memory,codex-shared-memory,codex-home}
  mkdir -p "$E2E_WORKSPACE_ROOT"/{ws-claude,ws-opus,ws-headless,ws-codex,ws-haiku}
  ok "data dir $E2E_DATA_DIR"
  ok "fixture workspaces under $E2E_WORKSPACE_ROOT"
}

# ---------------------------------------------------------------------------
# systemd units
# ---------------------------------------------------------------------------

install_units() {
  local tpl_dir="$SCRIPT_DIR/systemd"
  [ -d "$tpl_dir" ] || die "unit templates not found at $tpl_dir"

  local node npx
  node="$(command -v node)" || die "node not on PATH"
  npx="$(command -v npx)"   || die "npx not on PATH"

  mkdir -p "$UNIT_DIR"
  local unit
  for unit in "$API_UNIT" "$WEB_UNIT"; do
    [ -f "$tpl_dir/$unit" ] || die "missing template $tpl_dir/$unit"
    sed \
      -e "s|@REPO@|$E2E_REPO|g" \
      -e "s|@DATA_DIR@|$E2E_DATA_DIR|g" \
      -e "s|@CLAUDE_CONFIG_DIR@|$E2E_CLAUDE_CONFIG_DIR|g" \
      -e "s|@API_PORT@|$E2E_API_PORT|g" \
      -e "s|@WEB_PORT@|$E2E_WEB_PORT|g" \
      -e "s|@DIST_DIR@|$E2E_DIST_DIR|g" \
      -e "s|@NODE@|$node|g" \
      -e "s|@NPX@|$npx|g" \
      -e "s|@PATH@|$PATH|g" \
      "$tpl_dir/$unit" > "$UNIT_DIR/$unit"
  done
  systemctl --user daemon-reload
  ok "units installed to $UNIT_DIR (repo $E2E_REPO)"
}

# ---------------------------------------------------------------------------
# build
# ---------------------------------------------------------------------------

api_built() { [ -f "$E2E_REPO/apps/api/dist/server.js" ]; }
web_built() { [ -f "$E2E_REPO/apps/web/$E2E_DIST_DIR/BUILD_ID" ]; }

cmd_build() {
  require_tools
  info "Building E2E bundles in $E2E_REPO"

  # The API build is shared with the deployed instance on purpose — same
  # dist/server.js, different env. Only build it when it is missing, so a
  # `build` here never silently changes what the deployed unit is serving.
  if api_built; then
    dim "apps/api/dist already built — left alone (shared with the deployed unit)"
  else
    info "apps/api has no dist/ yet — building shared, file-store, api"
    ( cd "$E2E_REPO" \
      && npm run build --workspace=@agent-hq-orchestron/shared \
      && npm run build --workspace=@agent-hq-orchestron/file-store \
      && npm run build --workspace=@agent-hq-orchestron/api ) \
      || die "api build failed"
    ok "api built"
  fi

  # The web build is NOT shared: NEXT_PUBLIC_API_URL is baked into the client
  # bundle, so E2E needs its own output. NEXT_DIST_DIR keeps it out of
  # `.next`, and NEXT_DISABLE_SW keeps it out of public/sw.js — which is the
  # one artifact that lives outside distDir and would otherwise hand the
  # deployed PWA a precache manifest full of E2E chunk hashes.
  # `next build` rewrites apps/web/tsconfig.json in place — it reformats it
  # and appends `<distDir>/types/**/*.ts` to `include`. For an E2E build that
  # is pure noise in `git status`, and committing it would put a reference to
  # the E2E dist dir in the shared tsconfig. So restore it afterwards, but
  # only if it was clean to begin with: someone mid-edit does not want their
  # work reverted by a build script.
  local tsconfig='apps/web/tsconfig.json' tsconfig_was_clean=0
  if git -C "$E2E_REPO" rev-parse --git-dir >/dev/null 2>&1 \
     && [ -z "$(git -C "$E2E_REPO" status --porcelain -- "$tsconfig" 2>/dev/null)" ]; then
    tsconfig_was_clean=1
  fi

  info "Building apps/web → $E2E_DIST_DIR (API $(api_base), service worker off)"
  ( cd "$E2E_REPO/apps/web" \
    && NEXT_DIST_DIR="$E2E_DIST_DIR" \
       NEXT_DISABLE_SW=1 \
       NEXT_PUBLIC_API_URL="$(api_base)" \
       npm run build ) || die "web build failed"
  ok "web built → apps/web/$E2E_DIST_DIR"

  if [ "$tsconfig_was_clean" -eq 1 ] \
     && [ -n "$(git -C "$E2E_REPO" status --porcelain -- "$tsconfig" 2>/dev/null)" ]; then
    git -C "$E2E_REPO" checkout -- "$tsconfig" && dim "restored $tsconfig (next build rewrote it)"
  fi
}

# ---------------------------------------------------------------------------
# up / down / reset
# ---------------------------------------------------------------------------

wait_ready() {
  local label="$1" url="$2" deadline=$((SECONDS + READY_TIMEOUT_SECS))
  while [ $SECONDS -lt $deadline ]; do
    if curl -fsS --max-time 3 "$url" >/dev/null 2>&1; then
      ok "$label ready ($url)"
      return 0
    fi
    sleep 1
  done
  bad "$label did not become ready within ${READY_TIMEOUT_SECS}s ($url)"
  dim "logs: $0 logs ${label}"
  return 1
}

cmd_up() {
  require_linux_systemd
  require_tools
  info "Bringing up the E2E environment"

  check_agent_credentials || exit 1

  # Port collision is the failure mode that produces the most confusing
  # symptoms (a unit that flaps on restart), so name it up front.
  if port_open "$E2E_API_PORT" && ! systemctl --user is-active --quiet "$API_UNIT"; then
    die "port $E2E_API_PORT is already in use by something that is not $API_UNIT"
  fi
  if port_open "$E2E_WEB_PORT" && ! systemctl --user is-active --quiet "$WEB_UNIT"; then
    die "port $E2E_WEB_PORT is already in use by something that is not $WEB_UNIT"
  fi

  scaffold_data_dir
  write_config
  install_units

  api_built || die "apps/api/dist/server.js missing — run: $0 build"
  web_built || die "apps/web/$E2E_DIST_DIR missing — run: $0 build"

  info "Starting units"
  systemctl --user enable --now "$API_UNIT" >/dev/null 2>&1 \
    || die "failed to start $API_UNIT (see: $0 logs api)"
  wait_ready api "$(api_base)/api/health" || exit 1

  systemctl --user enable --now "$WEB_UNIT" >/dev/null 2>&1 \
    || die "failed to start $WEB_UNIT (see: $0 logs web)"
  # Through the web port, so this also proves Next's /api/* rewrite reaches
  # the E2E API and not the deployed one — the single most likely
  # misconfiguration in the whole setup.
  wait_ready web "$(web_base)/api/health" || exit 1

  info "Verifying isolation"
  assert_isolation || exit 1

  write_env_file
  log ''
  cmd_status
  log ''
  info "Next: $0 fixtures   (register the projects 00-setup.md expects)"
}

# Kill the tmux windows belonging to E2E sessions — identified from the E2E
# session records, not from the tmux name pattern, because the deployed
# instance uses the identical `orchestron-<8hex>` naming on the same tmux
# server. Guessing here would kill live work.
kill_e2e_tmux() {
  local names n=0
  names="$(python3 - "$E2E_DATA_DIR/sessions" <<'PY' 2>/dev/null
import glob, json, os, sys
d = sys.argv[1]
for f in glob.glob(os.path.join(d, '*.json')):
    try:
        with open(f) as fh:
            name = json.load(fh).get('tmuxName')
        if name:
            print(name)
    except Exception:
        pass
PY
)"
  [ -n "$names" ] || return 0
  have tmux || { warn "tmux not on PATH — cannot reap E2E panes"; return 0; }
  local name
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if tmux has-session -t "$name" 2>/dev/null; then
      tmux kill-session -t "$name" 2>/dev/null && n=$((n + 1))
    fi
  done <<< "$names"
  [ "$n" -eq 0 ] || ok "killed $n leftover E2E tmux session(s)"
}

cmd_down() {
  local keep_data=0
  [ "${1:-}" = "--keep-data" ] && keep_data=1
  require_linux_systemd
  info "Tearing down the E2E environment"

  # Reap panes BEFORE the records go away — they are the only record of
  # which tmux sessions were ours.
  kill_e2e_tmux

  local unit
  for unit in "$WEB_UNIT" "$API_UNIT"; do
    if systemctl --user list-unit-files "$unit" >/dev/null 2>&1; then
      systemctl --user disable --now "$unit" >/dev/null 2>&1 || true
      ok "stopped + disabled $unit"
    fi
  done

  if [ "$keep_data" -eq 1 ]; then
    warn "--keep-data: $E2E_DATA_DIR left in place"
  else
    assert_wipeable "$E2E_DATA_DIR"
    rm -rf "$E2E_DATA_DIR"
    ok "wiped $E2E_DATA_DIR"
    rm -rf "$E2E_WORKSPACE_ROOT"
    ok "wiped $E2E_WORKSPACE_ROOT"
  fi

  # Transcripts under the E2E CLAUDE_CONFIG_DIR are deliberately kept: they
  # are what makes a session re-adoptable, and wiping them would take the
  # OAuth credentials with them.
  dim "kept: $E2E_CLAUDE_CONFIG_DIR (credentials + transcripts)"
  dim "kept: apps/web/$E2E_DIST_DIR (rebuild only when the web code changes)"
}

cmd_reset() {
  cmd_down
  log ''
  cmd_up
}

# ---------------------------------------------------------------------------
# isolation assertions — the reason to trust this environment at all
# ---------------------------------------------------------------------------

assert_isolation() {
  local fails=0 detail e2e_storage prod_port prod_token

  detail="$(api_get /api/health/detail 2>/dev/null)" || {
    bad "/api/health/detail unreachable or rejected the E2E bearer"
    return 1
  }

  e2e_storage="$(printf '%s' "$detail" | python3 -c \
    'import json,sys;print(json.load(sys.stdin).get("storage",""))' 2>/dev/null)"
  if [ "$e2e_storage" = "$E2E_DATA_DIR" ]; then
    ok "E2E API reports storage $e2e_storage"
  else
    bad "E2E API reports storage '$e2e_storage', expected '$E2E_DATA_DIR'"
    dim "the API booted on the wrong config — check ORCHESTRON_CONFIG in $UNIT_DIR/$API_UNIT"
    fails=$((fails + 1))
  fi

  # The bearer must not be the deployed one. If it were, an E2E scenario
  # holding "the token" could drive the real instance.
  prod_token="$(json_get "$PROD_DATA_DIR/config.json" remoteToken)"
  if [ -n "$prod_token" ] && [ "$prod_token" = "$(e2e_token)" ]; then
    bad "E2E bearer is identical to the deployed instance's bearer"
    fails=$((fails + 1))
  else
    ok "E2E bearer is distinct from the deployed instance's"
  fi

  # And the deployed instance must still be answering on its own port, if it
  # was running at all. This is what catches "E2E stole port 8090".
  prod_port="$(json_get "$PROD_DATA_DIR/config.json" port)"
  prod_port="${prod_port:-8090}"
  if [ "$prod_port" = "$E2E_API_PORT" ]; then
    bad "deployed instance is configured on port $prod_port — the same as E2E"
    fails=$((fails + 1))
  else
    ok "deployed API port ($prod_port) differs from E2E ($E2E_API_PORT)"
  fi

  [ "$fails" -eq 0 ]
}

# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------

unit_state() {
  systemctl --user is-active "$1" 2>/dev/null || true
}

# What NEXT_PUBLIC_API_URL actually got baked into the served bundle. A
# mismatch against the running unit is the classic silent failure: the page
# renders, then every request 500s out of Next's rewrite.
# Read it out of routes-manifest.json rather than grepping the bundles: the
# /api/:path* rewrite destination is where next.config's API_URL actually
# lands, and it is the same value the running `next start` will proxy to.
built_api_url() {
  local manifest="$E2E_REPO/apps/web/$E2E_DIST_DIR/routes-manifest.json"
  [ -f "$manifest" ] || return 1
  python3 - "$manifest" <<'PY'
import json, re, sys
try:
    with open(sys.argv[1]) as fh:
        m = json.load(fh)
except Exception:
    sys.exit(1)
rw = m.get('rewrites') or {}
groups = rw.values() if isinstance(rw, dict) else [rw]
for group in groups:
    for entry in group or []:
        if str(entry.get('source', '')).startswith('/api/'):
            hit = re.match(r'^(https?://[^/]+)', str(entry.get('destination', '')))
            if hit:
                print(hit.group(1))
                sys.exit(0)
sys.exit(1)
PY
}

cmd_status() {
  info "E2E environment status"
  printf '  %-22s %s\n' 'repo'              "$E2E_REPO"
  printf '  %-22s %s\n' 'data dir'          "$E2E_DATA_DIR"
  printf '  %-22s %s\n' 'CLAUDE_CONFIG_DIR' "$E2E_CLAUDE_CONFIG_DIR"
  printf '  %-22s %s\n' 'api'               "$(api_base)  [$(unit_state "$API_UNIT")]"
  printf '  %-22s %s\n' 'web'               "$(web_base)  [$(unit_state "$WEB_UNIT")]"
  log ''

  local health
  if health="$(curl -fsS --max-time 3 "$(api_base)/api/health" 2>/dev/null)"; then
    ok "api liveness $health"
  else
    bad "api not answering on $(api_base)/api/health"
  fi

  if curl -fsS --max-time 5 "$(web_base)/api/health" >/dev/null 2>&1; then
    ok "web reachable, and its /api/* rewrite resolves"
  else
    bad "web not answering on $(web_base)"
  fi

  if [ -s "$E2E_CLAUDE_CONFIG_DIR/.credentials.json" ]; then
    ok "agent credentials present"
  else
    bad "agent credentials missing — see: $0 up"
  fi

  local built
  if built="$(built_api_url)"; then
    if [ "$built" = "$(api_base)" ]; then
      ok "web bundle built against $built"
    else
      bad "web bundle was built against $built but the API is $(api_base) — run: $0 build"
    fi
  else
    warn "no web build at apps/web/$E2E_DIST_DIR — run: $0 build"
  fi

  if [ -f "$E2E_DATA_DIR/config.json" ]; then
    local n
    n="$(api_get /api/projects 2>/dev/null | python3 -c \
      'import json,sys;print(len(json.load(sys.stdin).get("projects",[])))' 2>/dev/null)"
    if [ -n "$n" ]; then
      if [ "$n" -gt 0 ]; then ok "$n fixture project(s) registered"
      else warn "no projects registered — run: $0 fixtures"; fi
    fi
  fi

  log ''
  assert_isolation >/dev/null 2>&1 && ok "isolated from the deployed instance" \
    || warn "isolation checks did not all pass — run: $0 up (or see above)"
}

# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

# The four projects docs/e2e-tests/00-setup.md §4 names. Each exists so that
# "which layer did this field inherit from" is actually testable: a scenario
# asserting a `(project)` source tag needs a project that sets the value.
#
#   name|path|agentType|defaultModel|defaultEffort|defaultUseTmux
FIXTURE_SPECS=(
  "e2e-claude|$E2E_WORKSPACE_ROOT/ws-claude|claude|||"
  "e2e-claude-opus|$E2E_WORKSPACE_ROOT/ws-opus|claude|claude-opus-5|high|"
  "e2e-headless|$E2E_WORKSPACE_ROOT/ws-headless|claude|||false"
  "e2e-codex|$E2E_WORKSPACE_ROOT/ws-codex|codex|||"
  # Not in 00-setup.md's original table — added with Phase 2, and documented
  # there now. The other four are each shaped by what they must NOT set, so
  # none of them can carry the cheap model: `e2e-claude` exists precisely to
  # have nothing to inherit, and putting a model on `e2e-headless` would
  # break the `(project)` source-tag assertions in metadata-edit.md.
  # Scenarios that only need "spawn something, cheaply" use this one.
  "e2e-haiku|$E2E_WORKSPACE_ROOT/ws-haiku|claude|$E2E_DEFAULT_MODEL||"
)

cmd_fixtures() {
  require_tools
  curl -fsS --max-time 3 "$(api_base)/api/health" >/dev/null 2>&1 \
    || die "E2E API is not up — run: $0 up"

  info "Registering fixture projects"

  # Idempotent by rebuild: delete only projects whose name starts with
  # `e2e-`, then recreate. Anything hand-registered under another name in
  # this instance survives.
  local existing
  existing="$(api_get /api/projects 2>/dev/null | python3 -c '
import json, sys
for p in json.load(sys.stdin).get("projects", []):
    if str(p.get("name", "")).startswith("e2e-"):
        print(p["id"], p["name"])
' 2>/dev/null)"
  if [ -n "$existing" ]; then
    local id name
    while read -r id name; do
      [ -n "$id" ] || continue
      curl -fsS --max-time 10 -X DELETE -H "Authorization: Bearer $(e2e_token)" \
        "$(api_base)/api/projects/$id" >/dev/null 2>&1 \
        && dim "removed stale fixture $name"
    done <<< "$existing"
  fi

  local spec fname fpath ftype fmodel feffort ftmux body created
  local -a ids=()
  for spec in "${FIXTURE_SPECS[@]}"; do
    IFS='|' read -r fname fpath ftype fmodel feffort ftmux <<< "$spec"
    mkdir -p "$fpath"

    body="$(FN="$fname" FP="$fpath" FT="$ftype" FM="$fmodel" FE="$feffort" FX="$ftmux" \
      python3 - <<'PY'
import json, os
body = {
    'name': os.environ['FN'],
    'path': os.environ['FP'],
    'agentType': os.environ['FT'],
    'tags': ['e2e'],
    'group': 'e2e',
}
if os.environ.get('FM'):
    body['defaultModel'] = os.environ['FM']
if os.environ.get('FE'):
    body['defaultEffort'] = os.environ['FE']
if os.environ.get('FX'):
    body['defaultUseTmux'] = os.environ['FX'] == 'true'
print(json.dumps(body))
PY
)"

    if created="$(api_post /api/projects "$body" 2>/dev/null)"; then
      local pid
      pid="$(printf '%s' "$created" | python3 -c \
        'import json,sys;print(json.load(sys.stdin)["id"])' 2>/dev/null)"
      ids+=("$fname=$pid")
      ok "$fname → $pid"
    else
      bad "$fname could not be registered (path must exist and be a directory)"
    fi
  done

  # A manifest so a scenario run does not have to re-query and re-parse.
  # `${a[@]+...}` — an empty array is an unbound-variable error under `set -u`
  # on bash < 4.4, and "no fixture registered" is exactly when that happens.
  printf '%s\n' ${ids[@]+"${ids[@]}"} > "$E2E_DATA_DIR/fixtures.env"
  ok "manifest → $E2E_DATA_DIR/fixtures.env"
  write_env_file
}

# ---------------------------------------------------------------------------
# env file — what a scenario run sources
# ---------------------------------------------------------------------------

write_env_file() {
  local f="$E2E_DATA_DIR/e2e.env"
  {
    echo "# Generated by scripts/e2e-env.sh — source this before running a scenario."
    echo "export ORCH='$(api_base)'"
    echo "export ORCH_WEB='$(web_base)'"
    echo "export TOKEN='$(e2e_token)'"
    echo "export CLAUDE_CONFIG_DIR='$E2E_CLAUDE_CONFIG_DIR'"
    echo "export ORCHESTRON_DATA_DIR='$E2E_DATA_DIR'"
    echo "export E2E_WORKSPACE_ROOT='$E2E_WORKSPACE_ROOT'"
    # Which model a scenario should pick when it does not care. Advisory
    # only: there is no server-side global default (see write_config), so
    # what actually sets the model is the scenario, or the e2e-haiku project.
    echo "export E2E_MODEL='$E2E_DEFAULT_MODEL'"
    if [ -f "$E2E_DATA_DIR/fixtures.env" ]; then
      local line
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        # e2e-claude=<uuid> → export E2E_PROJECT_CLAUDE=<uuid>
        local k v
        k="${line%%=*}"; v="${line#*=}"
        k="$(printf '%s' "${k#e2e-}" | tr 'a-z-' 'A-Z_')"
        echo "export E2E_PROJECT_${k}='$v'"
      done < "$E2E_DATA_DIR/fixtures.env"
    fi
  } > "$f"
  chmod 600 "$f"
  ok "shell env → $f  (source it: . $f)"
}

cmd_env() {
  local f="$E2E_DATA_DIR/e2e.env"
  [ -f "$f" ] || die "no env file yet — run: $0 up"
  cat "$f"
}

cmd_token() {
  local t
  t="$(e2e_token)"
  [ -n "$t" ] || die "no token — the E2E env has not been brought up yet ($0 up)"
  printf '%s\n' "$t"
}

# ---------------------------------------------------------------------------
# logs
# ---------------------------------------------------------------------------

cmd_logs() {
  local which="${1:-api}" unit
  case "$which" in
    api) unit="$API_UNIT" ;;
    web) unit="$WEB_UNIT" ;;
    *) die "logs: expected 'api' or 'web', got '$which'" ;;
  esac
  exec journalctl --user -u "$unit" -f -n 100 --no-hostname
}

# ---------------------------------------------------------------------------
# test-self — does this script do what it claims
# ---------------------------------------------------------------------------

SELF_PASS=0
SELF_FAIL=0

# `!` is a shell keyword, not a command, so it cannot be argv[0] of a "$@"
# expansion inside check(). This is how a negated assertion gets written.
not() { ! "$@"; }

# Quiet authenticated GET — check() must not spray response bodies into the
# report.
api_get_quiet() { api_get "$1" >/dev/null 2>&1; }

check() {
  local label="$1"; shift
  if "$@"; then ok "$label"; SELF_PASS=$((SELF_PASS + 1))
  else bad "$label"; SELF_FAIL=$((SELF_FAIL + 1)); fi
}

cmd_test_self() {
  require_linux_systemd
  require_tools
  info "test-self: exercising up → assert → down → assert"
  warn "this wipes $E2E_DATA_DIR twice; it never touches $PROD_DATA_DIR"

  # Before anything is built: the deployed web build's content, so phase 3 can
  # assert it is unchanged rather than merely old.
  snapshot_prod_web_build

  # Record the deployed instance's state so we can prove we did not disturb
  # it. If it is not running, the checks below degrade to "still not running",
  # which is still the right assertion.
  local prod_url prod_up_before=0
  prod_url="$(prod_api_base)"
  curl -fsS --max-time 5 "$prod_url/api/health" >/dev/null 2>&1 && prod_up_before=1
  dim "deployed API at $prod_url before — $([ $prod_up_before -eq 1 ] && echo up || echo 'not running')"

  log ''
  info 'phase 1 — clean slate'
  cmd_down >/dev/null 2>&1 || true
  check "data dir absent after down" [ ! -d "$E2E_DATA_DIR" ]
  check "api port $E2E_API_PORT free" not port_open "$E2E_API_PORT"
  check "web port $E2E_WEB_PORT free" not port_open "$E2E_WEB_PORT"

  log ''
  info 'phase 2 — up'
  if ! cmd_up >/dev/null 2>&1; then
    bad "up failed — re-running verbosely so the reason is visible"
    cmd_up || true
    SELF_FAIL=$((SELF_FAIL + 1))
    self_report; return 1
  fi
  ok "up completed"
  check "api answers liveness" \
    curl -fsS --max-time 5 "$(api_base)/api/health" -o /dev/null
  check "api rejects an empty bearer" \
    test_api_rejects_anon
  check "api accepts the E2E bearer" api_get_quiet /api/health/detail
  check "api storage is the E2E data dir" test_storage_matches
  check "web serves, and its rewrite reaches the E2E api" test_web_rewrite
  check "config.json is mode 600" test_config_perms

  log ''
  info 'phase 3 — deployed instance undisturbed'
  if [ "$prod_up_before" -eq 1 ]; then
    check "deployed API still answering at $prod_url" \
      curl -fsS --max-time 5 "$prod_url/api/health" -o /dev/null
    check "deployed API still on its own data dir" test_prod_storage_unchanged
    # The credential boundary, stated as a test: whatever a scenario does
    # with $TOKEN, it cannot drive the deployed instance with it.
    check "deployed API rejects the E2E bearer" test_prod_rejects_e2e_token
  else
    # Not a pass and not a failure — say so rather than let a silent skip
    # read as a green isolation check.
    warn "deployed API was not reachable at $prod_url before this run — the"
    warn "'undisturbed' checks below could not be made. Re-run with it up for"
    warn "the assertion that actually matters."
  fi
  check "deployed data dir untouched by E2E writes" test_prod_dir_intact
  check "deployed web build not clobbered" test_prod_web_build_intact

  log ''
  info 'phase 4 — fixtures'
  if cmd_fixtures >/dev/null 2>&1; then
    ok "fixtures registered"
    check "all fixture projects present" test_fixture_count
    check "env file names the fixture ids" \
      grep -q '^export E2E_PROJECT_CLAUDE=' "$E2E_DATA_DIR/e2e.env"
  else
    bad "fixtures failed"
    SELF_FAIL=$((SELF_FAIL + 1))
  fi

  log ''
  info 'phase 5 — down wipes'
  cmd_down >/dev/null 2>&1 || true
  check "data dir wiped"     [ ! -d "$E2E_DATA_DIR" ]
  check "api unit inactive"  test_unit_inactive "$API_UNIT"
  check "web unit inactive"  test_unit_inactive "$WEB_UNIT"
  check "api port released" not port_open "$E2E_API_PORT"
  check "web port released" not port_open "$E2E_WEB_PORT"
  check "credentials survived the wipe" \
    test -s "$E2E_CLAUDE_CONFIG_DIR/.credentials.json"

  self_report
}

test_api_rejects_anon() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    "$(api_base)/api/health/detail")"
  [ "$code" = "401" ] || [ "$code" = "403" ]
}

test_storage_matches() {
  local s
  s="$(api_get /api/health/detail 2>/dev/null | python3 -c \
    'import json,sys;print(json.load(sys.stdin).get("storage",""))' 2>/dev/null)"
  [ "$s" = "$E2E_DATA_DIR" ]
}

# Through the web port with the E2E bearer: proves Next's rewrite target is
# the E2E API. If it were still pointed at the deployed one, the E2E bearer
# would be rejected there.
test_web_rewrite() {
  local s
  s="$(curl -fsS --max-time 10 -H "Authorization: Bearer $(e2e_token)" \
    "$(web_base)/api/health/detail" 2>/dev/null | python3 -c \
    'import json,sys;print(json.load(sys.stdin).get("storage",""))' 2>/dev/null)"
  [ "$s" = "$E2E_DATA_DIR" ]
}

test_config_perms() {
  local mode
  mode="$(stat -c '%a' "$E2E_DATA_DIR/config.json" 2>/dev/null)"
  [ "$mode" = "600" ]
}

# The deployed API must still report its OWN data dir. If bringing E2E up
# had somehow restarted it onto the E2E config, this is what catches it.
test_prod_storage_unchanged() {
  local tok s
  tok="$(json_get "$PROD_DATA_DIR/config.json" remoteToken)"
  [ -n "$tok" ] || return 0
  s="$(curl -fsS --max-time 10 -H "Authorization: Bearer $tok" \
    "$(prod_api_base)/api/health/detail" 2>/dev/null | python3 -c \
    'import json,sys;print(json.load(sys.stdin).get("storage",""))' 2>/dev/null)"
  [ "$s" = "$PROD_DATA_DIR" ]
}

test_prod_rejects_e2e_token() {
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
    -H "Authorization: Bearer $(e2e_token)" \
    "$(prod_api_base)/api/health/detail")"
  [ "$code" = "401" ] || [ "$code" = "403" ]
}

test_prod_dir_intact() {
  # Sessions/projects the deployed instance owns must still be there, and the
  # E2E run must not have added anything to them.
  [ -f "$PROD_DATA_DIR/config.json" ] || return 0
  local n
  n="$(find "$PROD_DATA_DIR/projects" -name '*.json' -newermt '-5 minutes' 2>/dev/null | wc -l)"
  [ "$n" -eq 0 ]
}

# The `.next` build the deployed unit serves, and the service worker beside
# it, must be exactly as they were. This is what proves the E2E build went to
# its own distDir and that NEXT_DISABLE_SW kept it out of public/sw.js — the
# two shared-artifact traps in this setup.
#
# Asserted by content, against a snapshot this run takes before it builds
# anything. The previous version used recency (`-newermt '-5 minutes'`), which
# is a proxy for causation rather than causation itself: a deploy that happened
# five minutes ago is indistinguishable from this run clobbering the build, and
# test-self false-failed twice on exactly that during the 2026-09-10 sweep.
PROD_WEB_SNAPSHOT=''

# Content fingerprint of the two shared artifacts. Prints one line per file
# that exists; a missing file simply contributes nothing, so appearing and
# disappearing both register as a change.
prod_web_fingerprint() {
  local d="$PROD_REPO/apps/web" f
  [ -d "$d" ] || return 0
  for f in "$d/.next/BUILD_ID" "$d/public/sw.js"; do
    [ -f "$f" ] && sha256sum "$f" 2>/dev/null
  done
  return 0
}

# Called at the top of test-self, before anything is built.
snapshot_prod_web_build() {
  PROD_WEB_SNAPSHOT="$(prod_web_fingerprint)"
  if [ -z "$PROD_WEB_SNAPSHOT" ]; then
    dim 'deployed web build — nothing to fingerprint (no build on this host yet)'
  fi
}

test_prod_web_build_intact() {
  local d="$PROD_REPO/apps/web"
  [ -d "$d" ] || return 0   # no deployed checkout on this host — nothing to protect
  if [ -z "$PROD_WEB_SNAPSHOT" ]; then
    # Never built here, so there is nothing this run could have clobbered.
    # Warn rather than fail: a green check would claim an assertion that was
    # not actually made.
    warn 'no pre-run fingerprint of the deployed web build — check skipped'
    return 0
  fi
  [ "$(prod_web_fingerprint)" = "$PROD_WEB_SNAPSHOT" ]
}

test_fixture_count() {
  local n
  n="$(api_get /api/projects 2>/dev/null | python3 -c \
    'import json,sys;print(len(json.load(sys.stdin).get("projects",[])))' 2>/dev/null)"
  [ "$n" = "${#FIXTURE_SPECS[@]}" ]
}

test_unit_inactive() {
  [ "$(unit_state "$1")" != "active" ]
}

self_report() {
  log ''
  local total=$((SELF_PASS + SELF_FAIL))
  if [ "$SELF_FAIL" -eq 0 ]; then
    printf '%s%s/%s checks passed%s\n' "$C_GREEN" "$SELF_PASS" "$total" "$C_RESET"
  else
    printf '%s%s/%s checks failed%s\n' "$C_RED" "$SELF_FAIL" "$total" "$C_RESET"
    return 1
  fi
}

# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------

usage() {
  # The header block above, minus the shebang and the trailing bare `#`.
  sed -n '3,27p' "${BASH_SOURCE[0]}" | sed 's|^# \?||'
}

main() {
  local cmd="${1:-}"
  [ $# -gt 0 ] && shift
  case "$cmd" in
    up)         cmd_up "$@" ;;
    down)       cmd_down "$@" ;;
    reset)      cmd_reset "$@" ;;
    status)     cmd_status "$@" ;;
    build)      cmd_build "$@" ;;
    fixtures)   cmd_fixtures "$@" ;;
    logs)       cmd_logs "$@" ;;
    token)      cmd_token "$@" ;;
    env)        cmd_env "$@" ;;
    wait)       cmd_wait "$@" ;;
    test-self)  cmd_test_self "$@" ;;
    ''|-h|--help|help) usage ;;
    *) die "unknown command '$cmd' — try: $0 --help" ;;
  esac
}

main "$@"

#!/usr/bin/env bash
#
# e2e-env.test.sh — unit tests for the parts of e2e-env.sh that decide things.
#
# Hermetic on purpose: no systemd, no network, no ports, nothing outside a
# temp dir. It sources e2e-env.sh (which runs no command when sourced) and
# drives its functions directly, stubbing `systemctl` and the readiness probe
# where a real one would be needed.
#
# What it is really defending is NF31: `up` used to report a web bundle it was
# not serving, because every check it made looked at the bundle on disk rather
# than at the process. The staleness decision now has a name and a test.
#
#   bash scripts/e2e-env.test.sh
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$1" >&2; }

# `it <name> <cmd...>` — the command's exit status is the assertion.
it() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi
}

# `it_not <name> <cmd...>` — inverted.
it_not() {
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then fail "$name"; else pass "$name"; fi
}

eq() {
  local name="$1" want="$2" got="$3"
  if [ "$want" = "$got" ]; then pass "$name"; else fail "$name — want '$want', got '$got'"; fi
}

# Sourcing must not start, stop, build or wipe anything. Both paths are pointed
# at a temp tree anyway, so a regression that made sourcing act would act there.
TMP="$(mktemp -d)"
cleanup() { [ -n "${TMP:-}" ] && [ -d "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT
export E2E_DATA_DIR="$TMP/data"
export E2E_REPO="$TMP/repo"
mkdir -p "$TMP/repo/apps/web"

# shellcheck source=/dev/null
. "$SCRIPT_DIR/e2e-env.sh"

printf '==> bundle_is_stale\n'
it     'a bundle newer than the process is stale'     bundle_is_stale 200 100
it_not 'a bundle older than the process is not stale' bundle_is_stale 100 200
it_not 'the same second is not stale'                 bundle_is_stale 150 150
it_not 'an unreadable build time cannot be stale'     bundle_is_stale '' 150
it_not 'an unreadable start time cannot be stale'     bundle_is_stale 150 ''
it_not 'n/a is not silently read as zero'             bundle_is_stale 150 'n/a'

printf '==> web_build_epoch\n'
BUILD_ID_PATH="$E2E_REPO/apps/web/$E2E_DIST_DIR/BUILD_ID"
mkdir -p "$(dirname "$BUILD_ID_PATH")"
it_not 'fails when there is no build' web_build_epoch
printf 'abc\n' > "$BUILD_ID_PATH"
touch -d '@1757000000' "$BUILD_ID_PATH"
eq 'reads the BUILD_ID mtime' '1757000000' "$(web_build_epoch)"

printf '==> unit_start_epoch\n'
STUB_TIMESTAMP=''
RESTARTS=0
systemctl() {
  case "$*" in
    *ExecMainStartTimestamp*) printf '%s\n' "$STUB_TIMESTAMP" ;;
    *restart*)                RESTARTS=$((RESTARTS + 1)) ;;
    *)                        return 1 ;;
  esac
}
STUB_TIMESTAMP='Thu 2026-09-11 22:40:17'
eq 'parses a systemd timestamp' "$(date -d 'Thu 2026-09-11 22:40:17' +%s)" "$(unit_start_epoch web)"
STUB_TIMESTAMP='n/a'
it_not 'fails on n/a (unit stopped)'     unit_start_epoch web
STUB_TIMESTAMP=''
it_not 'fails on empty (unit never ran)' unit_start_epoch web

printf '==> ensure_web_serving_current_bundle\n'
# The readiness probe is the only other thing it reaches out to.
WAITS=0
WAIT_RESULT=0
wait_ready() { WAITS=$((WAITS + 1)); return "$WAIT_RESULT"; }

# 1. a current bundle — no restart
RESTARTS=0; WAITS=0
STUB_TIMESTAMP='@1757000500'          # the process started after the build
systemctl() {
  case "$*" in
    *ExecMainStartTimestamp*) printf '%s\n' "$STUB_TIMESTAMP" ;;
    *restart*)                RESTARTS=$((RESTARTS + 1)) ;;
    *)                        return 1 ;;
  esac
}
it 'passes a current bundle'         ensure_web_serving_current_bundle
eq 'and does not restart it'   '0' "$RESTARTS"

# 2. a stale bundle — restarts, then confirms
RESTARTS=0; WAITS=0
systemctl() {
  case "$*" in
    # Before the restart the process predates the build; after it, it does not.
    *ExecMainStartTimestamp*)
      if [ "$RESTARTS" -eq 0 ]; then printf '@1756999000\n'; else printf '@1757000500\n'; fi ;;
    *restart*)                RESTARTS=$((RESTARTS + 1)) ;;
    *)                        return 1 ;;
  esac
}
it 'self-heals a stale bundle'          ensure_web_serving_current_bundle
eq 'by restarting the web unit once' '1' "$RESTARTS"
eq 'and waiting for it to come back' '1' "$WAITS"

# 3. a stale bundle the restart does not fix — must fail, loudly
RESTARTS=0; WAITS=0
systemctl() {
  case "$*" in
    *ExecMainStartTimestamp*) printf '@1756999000\n' ;;
    *restart*)                RESTARTS=$((RESTARTS + 1)) ;;
    *)                        return 1 ;;
  esac
}
it_not 'fails when the restart does not help' ensure_web_serving_current_bundle
eq    'having tried exactly once'       '1' "$RESTARTS"

# 4. an unreadable start time is a warning, not a restart on a guess
RESTARTS=0
systemctl() {
  case "$*" in
    *ExecMainStartTimestamp*) printf 'n/a\n' ;;
    *restart*)                RESTARTS=$((RESTARTS + 1)) ;;
    *)                        return 1 ;;
  esac
}
it 'tolerates an unreadable start time' ensure_web_serving_current_bundle
eq 'without restarting on a guess' '0' "$RESTARTS"

printf '\n'
if [ "$FAIL" -eq 0 ]; then
  printf '%s/%s checks passed\n' "$PASS" "$((PASS + FAIL))"
else
  printf '%s/%s checks failed\n' "$FAIL" "$((PASS + FAIL))" >&2
  exit 1
fi

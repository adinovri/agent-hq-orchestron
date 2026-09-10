#!/usr/bin/env bash
#
# e2e-scenario.sh — look up a scenario from docs/e2e-tests/ and print it with
# the E2E environment's own values already substituted in.
#
# The scenario files are the spec, and they are written for a human with a
# browser. What they cannot know is this run's bearer token, ports and
# fixture project ids. This prints the scenario next to those, so a manual
# sweep is copy-paste rather than cross-referencing three files.
#
#   ./scripts/e2e-scenario.sh list              every scenario id
#   ./scripts/e2e-scenario.sh list --smoke      just the [smoke] set
#   ./scripts/e2e-scenario.sh show SPAWN-01     one scenario, plus env
#   ./scripts/e2e-scenario.sh SPAWN-01          same thing
#
# This is deliberately a reader, not a runner. Executing scenarios is Phase 3
# (an LLM driving playwright); the value of having this now is that the
# parsing and the id index it needs already exist and are exercised.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${E2E_REPO:-$(cd "$SCRIPT_DIR/.." && pwd)}"
DOCS_DIR="${E2E_DOCS_DIR:-$REPO/docs/e2e-tests}"
E2E_DATA_DIR="${E2E_DATA_DIR:-$HOME/.orchestron-e2e}"

if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
else
  C_RESET=''; C_BOLD=''; C_DIM=''; C_RED=''
fi

die() { printf '%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

[ -d "$DOCS_DIR" ] || die "no scenario docs at $DOCS_DIR"

# ---------------------------------------------------------------------------

# Scenario headings look like:
#   ### SPAWN-01 — Spawn a tmux session with project defaults `[smoke]`
# A section runs to the next `### ` heading.
index_py() {
  python3 - "$DOCS_DIR" "$@" <<'PY'
import os, re, sys

docs = sys.argv[1]
mode = sys.argv[2]
arg = sys.argv[3] if len(sys.argv) > 3 else ''

HEAD = re.compile(r'^###\s+([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+)\s*(?:—|--|-)\s*(.*)$')

sections = []  # (id, title, filename, body)
for name in sorted(os.listdir(docs)):
    if not name.endswith('.md'):
        continue
    with open(os.path.join(docs, name), encoding='utf-8') as fh:
        lines = fh.read().splitlines()
    cur = None
    for line in lines:
        m = HEAD.match(line)
        if m:
            if cur:
                sections.append(cur)
            cur = [m.group(1), m.group(2).strip(), name, []]
            continue
        if cur is not None:
            cur[3].append(line)
    if cur:
        sections.append(cur)


def is_smoke(title, body):
    return '[smoke]' in title or any('[smoke]' in l for l in body[:3])


if mode == 'list':
    smoke_only = arg == '--smoke'
    shown = 0
    last_file = None
    for sid, title, fname, body in sections:
        if smoke_only and not is_smoke(title, body):
            continue
        if fname != last_file:
            print(f'\n{fname}')
            last_file = fname
        clean = title.replace('`[smoke]`', '').replace('[smoke]', '').strip()
        mark = ' [smoke]' if is_smoke(title, body) else ''
        print(f'  {sid:<14} {clean}{mark}')
        shown += 1
    print(f'\n{shown} scenario(s)')
    if smoke_only:
        # README.md's smoke table lists 11; FLAG-02/03 carry the marker but
        # are deliberately excluded from it, because they need
        # enableHeadlessMode:false plus an API restart, which invalidates
        # every other scenario's preconditions. Saying so here is the
        # difference between a valid sweep and a confusing one.
        print('\nFLAG-02 / FLAG-03 are marked [smoke] but run as their OWN sweep —')
        print('they need enableHeadlessMode:false + an API restart. See')
        print('docs/e2e-tests/README.md § Smoke set.')
    sys.exit(0)

if mode == 'show':
    want = arg.upper()
    for sid, title, fname, body in sections:
        if sid == want:
            print(f'# {sid} — {title}')
            print(f'# source: docs/e2e-tests/{fname}\n')
            # Trim the trailing `---` separator and blank padding.
            while body and body[-1].strip() in ('', '---'):
                body.pop()
            print('\n'.join(body).strip())
            sys.exit(0)
    near = [s[0] for s in sections if want.split('-')[0] == s[0].split('-')[0]]
    sys.stderr.write(f'no scenario {want}\n')
    if near:
        sys.stderr.write('same prefix: ' + ', '.join(near) + '\n')
    sys.exit(2)

sys.stderr.write(f'bad mode {mode}\n')
sys.exit(2)
PY
}

print_env() {
  local f="$E2E_DATA_DIR/e2e.env"
  printf '\n%s── environment ──%s\n' "$C_BOLD" "$C_RESET"
  if [ -f "$f" ]; then
    sed 's/^/  /' "$f"
    printf '\n  %ssource it:  . %s%s\n' "$C_DIM" "$f" "$C_RESET"
  else
    printf '  %sE2E env is not up — run: scripts/e2e-env.sh up && scripts/e2e-env.sh fixtures%s\n' \
      "$C_DIM" "$C_RESET"
  fi
}

cmd_show() {
  local id="${1:-}"
  [ -n "$id" ] || die "show: expected a scenario id, e.g. SPAWN-01"
  index_py show "$id" || exit $?
  print_env
}

main() {
  local cmd="${1:-}"
  [ $# -gt 0 ] && shift
  case "$cmd" in
    list)  index_py list "${1:-}" ;;
    show)  cmd_show "${1:-}" ;;
    ''|-h|--help|help)
      sed -n '3,19p' "${BASH_SOURCE[0]}" | sed 's|^# \?||' ;;
    # A bare id is the common case.
    *) cmd_show "$cmd" ;;
  esac
}

main "$@"

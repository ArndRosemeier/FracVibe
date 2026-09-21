#!/usr/bin/env bash
# scripts/gate.sh — THE gate for FracVibe. Nobody hand-rolls a test command.
#
# EXIT CODES (quote them exactly; never inflate):
#    0  GREEN         the tier's checks RAN and all passed
#    1  RED           the checks RAN and something failed
#    2  COMPILE-ONLY  the syntax tier ran; the Playwright suite did NOT run.
#                     A 2 must NEVER be quoted as "the gate passed".
#    9  BUSY          another gate holds the lock: REFUSED, and this run is VOID
#   10  KILLED        host guard (low available memory): VOID, re-run later
#   64  USAGE         bad tier / not in a git work tree
#
# Tier: GATE_TIER=full (default) | compile
#   full     — the Playwright smoke suite. This is what makes a change VERIFIED.
#              Takes the host-wide lock; writes a raw log.
#   compile  — `node --check` over every tracked .js file, no browser, ~1s.
#              Answers "does it still parse"; the suite is the only thing that
#              answers "does it still work". Reads nothing shared, so it does NOT
#              take the lock and can run alongside a peer's full suite.
#
# The lock lives in the git COMMON dir, so it is shared by EVERY worktree: one
# suite runs host-wide however many writers are in flight. A refusal is the lock
# WORKING — never a failure, never evidence.
#
# Raw logs are kept under $GATE_LOG_DIR (default /tmp/fracvibe-gate). The check is
# never piped through tail/head: its exit status is captured directly, so no
# pipeline can turn a red into a green.
set -u

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$SELF_DIR" rev-parse --show-toplevel 2>/dev/null)" \
  || { echo "gate: not inside a git work tree ($SELF_DIR)" >&2; exit 64; }
GIT_COMMON="$(cd "$(git -C "$REPO" rev-parse --git-common-dir)" && pwd)"
LOCK="$GIT_COMMON/fracvibe-gate.lock"
TIER="${GATE_TIER:-full}"
LOG_DIR="${GATE_LOG_DIR:-/tmp/fracvibe-gate}"
STALE_SECONDS="${GATE_STALE_SECONDS:-1800}"
MIN_AVAIL_MB="${GATE_MIN_AVAIL_MB:-500}"

case "$TIER" in
  full | compile) ;;
  *) echo "gate: unknown GATE_TIER='$TIER' (expected full|compile)" >&2; exit 64 ;;
esac

mkdir -p "$LOG_DIR" || { echo "gate: cannot create log dir $LOG_DIR" >&2; exit 64; }
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SHORT="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo nogit)"
LOG="$LOG_DIR/gate-$TIER-$SHORT-$STAMP.log"

say() { printf 'gate: %s\n' "$*"; }

suite_live() { pgrep -f 'playwright[[:space:]]+test' >/dev/null 2>&1; }
avail_mb() { awk '/^MemAvailable:/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null || echo 0; }
# The suite is served from the worktree the gate runs in (playwright's webServer
# starts `node server/server.js` with cwd = REPO). A server already on the port
# could belong to ANOTHER tree, so reusing it would silently verify the wrong
# code. We refuse instead of guessing.
port_busy() {
  if command -v ss >/dev/null 2>&1; then
    ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE ':3000$'
  else
    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE ':3000$'
  fi
}

# Ownership matters: a refused run must NEVER release the winner's lock.
LOCK_OWNED=0
write_owner() {
  {
    echo "pid=$$"
    echo "started_utc=$STAMP"
    echo "tier=$TIER"
    echo "worktree=$REPO"
    echo "head=$SHORT"
  } > "$LOCK/owner"
  LOCK_OWNED=1
}
release() { [ "$LOCK_OWNED" = 1 ] && [ -d "$LOCK" ] && rm -rf "$LOCK"; }
trap release EXIT

# Atomic acquire: mkdir either succeeds or it does not. A pgrep "look" cannot be
# trusted, because two starters can both look in the same instant and both see free.
acquire() {
  if mkdir "$LOCK" 2>/dev/null; then write_owner; return 0; fi
  local age owner_pid now
  now="$(date +%s)"
  age=$(( now - $(stat -c %Y "$LOCK" 2>/dev/null || echo "$now") ))
  owner_pid="$(sed -n 's/^pid=//p' "$LOCK/owner" 2>/dev/null | sed -n '1p')"
  if [ "$age" -gt "$STALE_SECONDS" ] && ! suite_live \
     && { [ -z "${owner_pid:-}" ] || ! kill -0 "$owner_pid" 2>/dev/null; }; then
    say "STALE lock removed (age ${age}s, owner pid ${owner_pid:-?} not alive, no suite running)"
    rm -rf "$LOCK"
    if mkdir "$LOCK" 2>/dev/null; then write_owner; return 0; fi
  fi
  say "BUSY — another gate holds the lock. THIS RUN IS REFUSED AND VOID (exit 9)."
  sed 's/^/gate:    /' "$LOCK/owner" 2>/dev/null
  suite_live && say "  (diagnostic: a live 'playwright test' process was seen — pgrep, not the lock)"
  return 9
}

# ------------------------------------------------- compile tier (cheap: no lock)
if [ "$TIER" = compile ]; then
  say "COMPILE tier — syntax-checking tracked .js. The Playwright suite does NOT run here."
  : > "$LOG"
  n=0
  fail=0
  while IFS= read -r f; do
    case "$f" in *.js) ;; *) continue ;; esac
    src="$REPO/$f"
    [ -f "$src" ] || continue
    # public/*.js are ES modules loaded by the browser; `node --check` decides
    # module-vs-script from the extension, so they are probed as .mjs copies.
    case "$f" in
      public/*) probe="$(mktemp /tmp/fv-esm-XXXXXX.mjs)" ;;
      *)        probe="$(mktemp /tmp/fv-cjs-XXXXXX.cjs)" ;;
    esac
    cp "$src" "$probe"
    n=$((n + 1))
    if node --check "$probe" >>"$LOG" 2>&1; then
      printf 'gate:   ok    %s\n' "$f"
    else
      printf 'gate:   PARSE FAIL  %s\n' "$f"
      fail=$((fail + 1))
    fi
    rm -f "$probe"
  done < <(git -C "$REPO" ls-files)

  if [ "$fail" -eq 0 ]; then
    say "COMPILE-ONLY GREEN — $n files parsed, 0 failed."
    say "The suite did NOT run: this is exit 2 and is NOT a verification."
    say "raw log $LOG"
    exit 2
  fi
  say "RED — $fail of $n files failed to parse (exit 1)."
  grep -nE 'SyntaxError|Error:' "$LOG" | sed -n '1,20p' | sed 's/^/gate:   /'
  say "raw log $LOG"
  exit 1
fi

# -------------------------------------------------- full tier (expensive: lock)
if ! acquire; then exit 9; fi
say "lock held · tier=full · worktree=$REPO · head=$SHORT · pid=$$"

A="$(avail_mb)"
if [ "$A" -gt 0 ] && [ "$A" -lt "$MIN_AVAIL_MB" ]; then
  say "KILLED — MemAvailable ${A}MB is below the ${MIN_AVAIL_MB}MB floor."
  say "THIS RUN IS VOID (exit 10). Re-run when the host is free; do not count it."
  exit 10
fi
say "host: MemAvailable ${A}MB · load $(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"

if port_busy; then
  say "REFUSED — something is already listening on :3000 (a dev server or an orphan)."
  say "The suite must be served from THIS worktree; reusing a foreign server would"
  say "silently verify the wrong code. THIS RUN IS VOID (exit 9). Stop it, then re-run."
  exit 9
fi

say "FULL tier — npm test (Playwright smoke suite). Raw log: $LOG"
( cd "$REPO" && FORCE_COLOR=0 npm test ) >"$LOG" 2>&1
rc=$?   # captured from the check itself, with no pipe in between to mask it

if [ "$rc" -eq 0 ]; then
  say "GREEN — the suite ran and passed (exit 0)."
  grep -E '^[[:space:]]+[0-9]+ (passed|failed|flaky|skipped)' "$LOG" | sed 's/^/gate:  /'
  say "raw log $LOG"
  exit 0
fi

say "RED — 'npm test' exited $rc (this gate exits 1)."
say "brief failing evidence below; the FULL expected/received block is in the RAW LOG:"
grep -nE '✘|✗|[0-9]+ failed|Error:|Expected|Received' "$LOG" \
  | sed -n '1,40p' | sed 's/^/gate:   /'
say "raw log $LOG"
exit 1

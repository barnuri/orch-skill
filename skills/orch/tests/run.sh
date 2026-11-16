#!/usr/bin/env bash
# Runner for the bash suite. Every selected *.test.sh runs as its own background job (each file builds
# its own temp homes, so files share no state) and the tallies are merged. The cost is process start
# latency, not CPU, so all files start at once.
#
# Tiers:
#   bash skills/orch/tests/run.sh               FAST (default): tests/unit/*.test.sh. bash -n, sourcing,
#                                               usage lines, in-process lib unit tests. Under 30 s.
#   bash skills/orch/tests/run.sh --changed     FAST plus the tests of the files changed against HEAD
#                                               (git diff + untracked). --changed=<ref> diffs against <ref>.
#   bash skills/orch/tests/run.sh --full        unit/ plus every <category>/*.test.sh. Final gate only.
#   bash skills/orch/tests/run.sh record wait   only files whose name contains "record" or "wait"
#                                               (all tiers); with --fast/--full/--changed it filters that tier.
# Options:
#   --budget SECS   stop the whole run after SECS; unfinished files are listed so you can rerun them.
#   ORCH_TEST_JOBS=N             at most N files at once (default: all at once on the fast tier, one
#                                per CPU otherwise; 1 = serial).
#   ORCH_TEST_FILE_CAP=SECS      per-file cap (default 30 on the fast tier, 240 otherwise). A file over
#                                its cap is killed (whole process group) and reported as TIMEOUT.
# Only --full takes a machine-wide heavy-test slot (scripts/heavy-test-lock.sh). The TypeScript suite
# and the typecheck are separate: scripts/test-all.sh runs everything.

set -u
export ORCH_NO_ANNOUNCE=1

TESTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$TESTS_DIR/../../.." && pwd)"
JOBS="${ORCH_TEST_JOBS:-0}"

mode=""
ref=HEAD
budget=0
frags=()
while [ $# -gt 0 ]; do
  case "$1" in
    --fast) mode=fast ;;
    --full) mode=full ;;
    --changed) mode=changed ;;
    --changed=*) mode=changed; ref="${1#*=}" ;;
    --budget) budget="${2:-}"; shift ;;
    --budget=*) budget="${1#*=}" ;;
    -h|--help) sed -n '2,/^$/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) printf 'run.sh: unknown option %s (see --help)\n' "$1" >&2; exit 2 ;;
    *) frags+=("$1") ;;
  esac
  shift
done
case "$budget" in ''|*[!0-9]*) printf 'run.sh: --budget needs whole seconds\n' >&2; exit 2 ;; esac
if [ -z "$mode" ]; then
  if [ ${#frags[@]} -gt 0 ]; then mode=pick; else mode=fast; fi
fi
# Outside the fast tier, at most one file per CPU at once: 70+ files at once made each file 10x slower.
if [ -z "${ORCH_TEST_JOBS:-}" ] && [ "$mode" != fast ]; then
  JOBS=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 8)
fi
if [ "$mode" = fast ]; then cap="${ORCH_TEST_FILE_CAP:-30}"; else cap="${ORCH_TEST_FILE_CAP:-240}"; fi

# A file's id is <category>/<name> (unit/locks), so unit/current-run and runs/current-run never collide.
# Parameter expansion, not basename: a fork per file costs ~0.3 s each on a loaded machine.
test_name() { local f="${1%.test.sh}"; printf '%s/%s\n' "$(x="${f%/*}"; printf '%s' "${x##*/}")" "${f##*/}"; }

# --changed: the test files for each changed path. A lib or script adds unit/<stem>, every test named
# <stem> or <stem>-*, and the extra names in changed-map.txt. A changed test file adds itself. Any
# other path (docs, src/, test helpers) adds nothing: the fast tier covers it.
changed_tests() {
  local path stem name f extra
  {
    git -C "$REPO_ROOT" diff --name-only "$ref" -- 2>/dev/null
    git -C "$REPO_ROOT" ls-files --others --exclude-standard -- skills/orch 2>/dev/null
  } | sort -u | while IFS= read -r path; do
    case "$path" in
      skills/orch/tests/*/*.test.sh) [ -f "$REPO_ROOT/$path" ] && printf '%s\n' "$REPO_ROOT/$path"; continue ;;
      skills/orch/scripts/lib/*.sh) stem=$(basename "$path" .sh) ;;
      skills/orch/scripts/dispatch.sh|skills/orch/scripts/announce.sh) stem=$(basename "$path") ;;
      *) continue ;;
    esac
    extra=$(awk -v s="$stem" '$1 == s { $1 = ""; print }' "$TESTS_DIR/changed-map.txt" 2>/dev/null)
    for f in "$TESTS_DIR"/*/*.test.sh; do
      name="${f##*/}"; name="${name%.test.sh}"
      case "$name" in "$stem"|"${stem%.sh}"|"$stem"-*) printf '%s\n' "$f"; continue ;; esac
      for e in $extra; do
        case "$name" in "$e"|"$e"-*) printf '%s\n' "$f"; break ;; esac
      done
    done
  done | sort -u
}

candidates=()
case "$mode" in
  fast) for f in "$TESTS_DIR"/unit/*.test.sh; do candidates+=("$f"); done ;;
  full|pick) for f in "$TESTS_DIR"/*/*.test.sh; do candidates+=("$f"); done ;;
  changed)
    for f in "$TESTS_DIR"/unit/*.test.sh; do candidates+=("$f"); done
    while IFS= read -r f; do
      case "$f" in "$TESTS_DIR"/unit/*) ;; *) candidates+=("$f") ;; esac
    done < <(changed_tests)
    ;;
esac

files=()
for f in ${candidates[@]+"${candidates[@]}"}; do
  [ -f "$f" ] || continue
  if [ ${#frags[@]} -gt 0 ]; then
    keep=0
    base="${f##*/}"
    cat_dir="${f%/*}"
    id="${cat_dir##*/}/${base%.test.sh}"
    for pat in "${frags[@]}"; do case "$id" in *"$pat"*) keep=1 ;; esac; done
    [ "$keep" -eq 1 ] || continue
  fi
  files+=("$f")
done
[ ${#files[@]} -gt 0 ] || { printf 'no test files match\n' >&2; exit 1; }

if [ "$mode" = full ]; then
  . "$REPO_ROOT/scripts/heavy-test-lock.sh"
  HEAVY_LOCK_CMD="skills/orch/tests/run.sh --full (full bash suite)" heavy_lock_acquire
fi

out_dir=$(mktemp -d)
# One initialised home for the whole run, cached across runs (test-home.sh): each file copies it
# (seed_home) instead of paying the 2-4 s first-run migrations per temp home.
. "$TESTS_DIR/test-home.sh"
ORCH_TEST_HOME_TEMPLATE=$(seed_home_template_cached) || { printf 'could not build the template home\n' >&2; exit 1; }
export ORCH_TEST_HOME_TEMPLATE

# Longest first: per-file seconds of earlier runs (kept outside the repo) order this run, so with a job
# limit the slow files never start last. Files with no record go first (unknown = slow).
TIMINGS="${ORCH_TEST_TIMINGS:-${TMPDIR:-/tmp}/orch-bash-test-timings}"
ordered=()
while IFS= read -r line; do ordered+=("${line#* }"); done < <(
  for f in "${files[@]}"; do
    s=$(awk -v n="$(test_name "$f")" '$1 == n {print int($2)}' "$TIMINGS" 2>/dev/null)
    # --changed: the fast tier starts first, so its signal comes before the slow mapped files.
    if [ "$mode" = changed ] && [ "${f#"$TESTS_DIR"/unit/}" != "$f" ]; then s=999999; fi
    printf '%s %s\n' "${s:-99999}" "$f"
  done | sort -rn
)
files=("${ordered[@]}")

# capped.pl <pgid-file> <rc-file> <cap-secs> <deadline-epoch|0> <cmd...>: runs cmd in its own process
# group, kills the whole group at the cap or the deadline, and writes "<rc> <secs> <ok|timeout|budget>".
# The group is killed after a normal exit too, so a file's leaked servers or jobs never outlive it.
cat > "$out_dir/capped.pl" <<'PL'
use strict; use POSIX ":sys_wait_h"; use Time::HiRes qw(time sleep);
my ($pgf, $rcf, $cap, $deadline, @cmd) = @ARGV;
my $t0 = time; my $pid = fork;
if (!$pid) { setpgrp(0, 0); exec @cmd or exit 127; }
setpgrp($pid, $pid);
open my $p, '>', $pgf; print $p $pid; close $p;
my ($why, $st) = ('ok', 0);
while (1) {
  my $r = waitpid($pid, WNOHANG);
  if ($r == $pid) { $st = $?; last; }
  my $now = time;
  my $hit = ($now - $t0 >= $cap) ? 'timeout' : ($deadline > 0 && $now >= $deadline) ? 'budget' : '';
  if ($hit) {
    $why = $hit; kill 'TERM', -$pid; sleep 2; kill 'KILL', -$pid;
    waitpid($pid, 0); $st = $?; last;
  }
  sleep 0.2;
}
kill 'TERM', -$pid;
my $rc = ($st & 127) ? 128 + ($st & 127) : $st >> 8;
open my $o, '>', "$rcf.tmp"; printf $o "%d %.1f %s\n", $rc, time - $t0, $why; close $o;
rename "$rcf.tmp", $rcf;
PL

deadline=0
[ "$budget" -gt 0 ] && deadline=$(( $(date +%s) + budget ))
pids=()
names=()
skipped=()
started=$SECONDS
running_count() {
  local p n=0
  # ${a[@]+...}: bash 3.2 (macOS) treats "${a[@]}" of an empty array as unbound under set -u.
  for p in ${pids[@]+"${pids[@]}"}; do kill -0 "$p" 2>/dev/null && n=$((n + 1)); done
  printf '%s' "$n"
}
for f in "${files[@]}"; do
  name=$(test_name "$f")
  key="${name//\//__}"
  if [ "$JOBS" -gt 0 ]; then
    while [ "$(running_count)" -ge "$JOBS" ]; do sleep 0.2; done
  fi
  if [ "$deadline" -gt 0 ] && [ "$(date +%s)" -ge "$deadline" ]; then skipped+=("$name"); continue; fi
  names+=("$name")
  perl "$out_dir/capped.pl" "$out_dir/$key.pgid" "$out_dir/$key.rc" "$cap" "$deadline" \
    bash "$f" > "$out_dir/$key.out" 2>&1 9>&- &
  pids+=($!)
done
for p in ${pids[@]+"${pids[@]}"}; do wait "$p" 2>/dev/null; done

total_pass=0
total_fail=0
bad=0
bad_files=0
bad_names=""
: > "$out_dir/secs"
for name in ${names[@]+"${names[@]}"}; do
  key="${name//\//__}"
  read -r rc secs why < "$out_dir/$key.rc" 2>/dev/null || { rc=1; secs=0; why=ok; }
  if [ "$why" = budget ]; then skipped+=("$name"); continue; fi
  printf '%s %s\n' "$name" "$secs" >> "$out_dir/secs"
  tally=$(grep -oE '[0-9]+ passed, [0-9]+ failed$' "$out_dir/$key.out" | tail -1)
  p=$(printf '%s' "$tally" | awk '{print $1}')
  fl=$(printf '%s' "$tally" | awk '{print $3}')
  total_pass=$((total_pass + ${p:-0}))
  total_fail=$((total_fail + ${fl:-0}))
  if [ "$why" = timeout ] || [ "$rc" -ne 0 ] || [ -z "$tally" ]; then
    bad_files=$((bad_files + 1)); bad_names+="$name "
  fi
  if [ "$why" = timeout ]; then
    bad=1
    printf '=== %s TIMEOUT: killed after the %ss per-file cap (ORCH_TEST_FILE_CAP) ===\n' "$name" "$cap"
    tail -20 "$out_dir/$key.out"
  elif [ "$rc" -ne 0 ] || [ -z "$tally" ]; then
    bad=1
    printf '=== %s FAILED (exit %s) ===\n' "$name" "$rc"
    cat "$out_dir/$key.out"
  fi
  printf '%-30s %4s passed, %s failed  (%ss)\n' "$name" "${p:-0}" "${fl:-?}" "$secs" >&2
done

# Remember each finished file's seconds for the next run's longest-first order (newest value wins).
if [ -s "$out_dir/secs" ]; then
  { cat "$out_dir/secs"; cat "$TIMINGS" 2>/dev/null; } | awk 'NF == 2 && !seen[$1]++' > "$TIMINGS.tmp.$$" \
    && mv -f "$TIMINGS.tmp.$$" "$TIMINGS"
  printf '\nslowest:' >&2
  sort -k2 -rn "$out_dir/secs" | head -5 | awk '{printf " %s %ss,", $1, $2}' | sed 's/,$//' >&2
  printf '\n' >&2
fi
if [ ${#skipped[@]} -gt 0 ]; then
  bad=1
  printf '\nbudget of %ss reached; not finished (%s): %s\nrerun them: bash skills/orch/tests/run.sh %s\n' \
    "$budget" "${#skipped[@]}" "${skipped[*]}" "$( [ "$mode" = full ] && printf -- '--full ')${skipped[*]}"
fi

printf '\n%s passed, %s failed (%s tier, %s files, %ss wall)\n' "$total_pass" "$total_fail" "$mode" \
  "${#names[@]}" "$((SECONDS - started))"
[ "$bad_files" -gt 0 ] && printf '%s file(s) timed out or exited non-zero: %s\n' "$bad_files" "${bad_names% }"
trash "$out_dir" 2>/dev/null || true
[ "$bad" -eq 0 ] && [ "$total_fail" -eq 0 ] || exit 1

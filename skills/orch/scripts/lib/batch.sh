#!/usr/bin/env bash
# `node batch` — many node add/report/update ops in one process. Sourced by dispatch.sh, never executed.
# Fast path (node_batch_fast): one jq program reads state.json and every op once, checks them in order
# with the rules and messages of cmd_node_add / cmd_node_report / cmd_node_update (node_set_status and
# owner_register included), and returns the new state, the event lines and the owner files, which are
# written under one per-run lock: about 2-4 process starts whatever the op count.
# Fallback (an op the fast path does not support, e.g. a dependency finished in a continued-from run,
# or ORCH_BATCH_FAST=0): every op runs through the real cmd_node_* functions on a scratch copy of the
# run (ORCH_HOME/RUNS_HOME pointed at a temp dir); when all pass, the scratch result is committed.
# Either way one bad op applies none.
#
# jq programs are single-quoted on purpose — their $vars are jq's.
# shellcheck disable=SC2016

NODE_BATCH_USAGE='dispatch.sh node batch <run-id> [--file F] [--dry-run]   (one JSON op per line on stdin or in F)'
NODE_BATCH_LOCK_WAIT_SECS=30

# One record per non-blank input line, NUL-separated: <line>\0<error>\0<argc>\0<arg>\0... The args
# are the verb then what `node <verb> <run-id>` takes after the run id.
NODE_BATCH_DEFS='
  def known: {
    add: ["op","id","label","goal","after","profile","role","tier","model","plan_backed","acceptance"],
    report: ["op","id","model","input_tokens","output_tokens","cache_read_tokens","usd","note"],
    update: ["op","id","status","job","error","at","owner","force","after","needs_user","clear_needs_user"]};
  def req($k): if (.[$k] | type) == "string" and .[$k] != "" then .[$k]
               else error("\"\($k)\" is required (a non-empty string)") end;
  def opt($k; $flag): if (.[$k] // null) == null then []
    elif (.[$k] | type) == "string" then [$flag, .[$k]]
    elif (.[$k] | type) == "number" then [$flag, (.[$k] | tostring)]
    else error("\"\($k)\" must be a string or a number") end;
  def flag($k; $flag): if .[$k] == true then [$flag] elif (.[$k] // false) == false then []
    else error("\"\($k)\" must be true or false") end;
  def after: if (.after // null) == null then []
    else (if (.after | type) == "string" then .after
          elif (.after | type) == "array" and all(.after[]; type == "string") then .after | join(",")
          else error("\"after\" must be a string or an array of strings") end)
         | if . == "" then [] else ["--after", .] end end;
  def update_after: if has("after") | not then []
    elif (.after | type) == "string" then ["--after", .after]
    elif (.after | type) == "array" and all(.after[]; type == "string") then ["--after", (.after | join(","))]
    else error("\"after\" must be a string or an array of strings") end;
  def build:
    if type != "object" then error("not a JSON object") else . end
    | (.op // null) as $op
    | if ($op | type) != "string" or (known | has($op) | not) then error("\"op\" must be add, report or update") else . end
    | ((keys - (known | .[$op])) | map(tostring)) as $extra
    | if ($extra | length) > 0 then error("unknown field(s) for \($op): \($extra | join(", "))") else . end
    | if $op == "add" then
        (if (.label // .goal // null) == null then error("\"label\" (or \"goal\") is required") else . end)
        | ["add", req("id"), (if (.label // null) != null then req("label") else req("goal") end)]
          + after + opt("profile"; "--profile") + opt("role"; "--role") + opt("tier"; "--tier")
          + opt("model"; "--model") + flag("plan_backed"; "--plan-backed") + opt("acceptance"; "--acceptance")
      elif $op == "report" then
        ["report", req("id")] + opt("model"; "--model") + opt("input_tokens"; "--input-tokens")
          + opt("output_tokens"; "--output-tokens") + opt("cache_read_tokens"; "--cache-read-tokens")
          + opt("usd"; "--usd") + opt("note"; "--note")
      else
        (if .needs_user != null and .clear_needs_user == true then error("\"needs_user\" and \"clear_needs_user\" cannot be combined") else . end)
        | (if .status != null and .status != "" then req("status") | [.] elif has("status") and .status != null then error("\"status\" must be a non-empty string") else [] end) as $s
        | ["update", req("id")] + $s + opt("job"; "--job") + opt("error"; "--error")
          + opt("at"; "--at") + opt("owner"; "--owner") + flag("force"; "--force")
          + update_after + opt("needs_user"; "--needs-user") + flag("clear_needs_user"; "--clear-needs-user")
      end
    | if any(.[]; contains("\u0000")) then error("values must not contain NUL") else . end;
'
NODE_BATCH_PARSE="$NODE_BATCH_DEFS"'
  [inputs] | to_entries[]
  | (.key + 1) as $line
  | (.value | sub("\r$"; "")) as $text
  | select($text | test("\\S"))
  | (try ($text | fromjson | {args: build, err: ""})
     catch {args: [], err: (if type == "string" then . else "invalid JSON" end)}) as $r
  | "\($line)\u0000\($r.err | gsub("\u0000"; ""))\u0000\($r.args | length)\u0000"
    + ($r.args | map(. + "\u0000") | join(""))'

# node_batch_parse <file> — fills BATCH_LINE[] BATCH_ERR[] BATCH_START[] BATCH_ARGC[] BATCH_ARGS[].
node_batch_parse() {
  local line err argc i arg
  BATCH_LINE=(); BATCH_ERR=(); BATCH_START=(); BATCH_ARGC=(); BATCH_ARGS=()
  while IFS= read -r -d '' line && IFS= read -r -d '' err && IFS= read -r -d '' argc; do
    BATCH_LINE+=("$line"); BATCH_ERR+=("$err"); BATCH_START+=("${#BATCH_ARGS[@]}"); BATCH_ARGC+=("$argc")
    i=0
    while [ "$i" -lt "$argc" ]; do
      IFS= read -r -d '' arg || break
      BATCH_ARGS+=("$arg")
      i=$((i + 1))
    done
  done < <(jq -nRj "$NODE_BATCH_PARSE" < "$1")
}

# node_batch_op <index> — sets BATCH_OP_ARGS to the op's args (verb first).
node_batch_op() { BATCH_OP_ARGS=("${BATCH_ARGS[@]:${BATCH_START[$1]}:${BATCH_ARGC[$1]}}"); }

# node_batch_summary — one line for the op in BATCH_OP_ARGS: `add x "label"`, `report x`, `update x -> done`.
node_batch_summary() {
  case "${BATCH_OP_ARGS[0]}" in
    add) printf 'add %s "%s"' "${BATCH_OP_ARGS[1]}" "${BATCH_OP_ARGS[2]}" ;;
    update) case "${BATCH_OP_ARGS[2]:-}" in
        -*|'') printf 'update %s' "${BATCH_OP_ARGS[1]}" ;;
        *) printf 'update %s -> %s' "${BATCH_OP_ARGS[1]}" "${BATCH_OP_ARGS[2]}" ;;
      esac ;;
    *) printf '%s %s' "${BATCH_OP_ARGS[0]}" "${BATCH_OP_ARGS[1]}" ;;
  esac
}

# node_batch_simulate <run-id> <scratch-dir> — runs every op against a copy of the run, in order, and
# prints `line N: <error>` for each one that fails. Exit status: number of failures (capped at 100).
# A subshell, so the ORCH_HOME/RUNS_HOME override never leaks into the commit.
node_batch_simulate() (
  local run_id="$1" sim="$2" i n=0 rc origin real_runs="$RUNS_HOME"
  mkdir -p "$sim/runs/$run_id" || exit 100
  cp "$(run_state_file "$run_id")" "$sim/orig.json" || exit 100
  cp "$sim/orig.json" "$sim/runs/$run_id/state.json" || exit 100
  # Runs this one continued from are only read (finished dependencies): link them in.
  while IFS= read -r origin; do
    [ -n "$origin" ] && [ "$origin" != "$run_id" ] && [ -d "$real_runs/$origin" ] || continue
    ln -s "$real_runs/$origin" "$sim/runs/$origin" 2>/dev/null || true
  done <<EOF
$(run_chain "$run_id")
EOF
  ORCH_HOME="$sim" RUNS_HOME="$sim/runs"
  for i in "${!BATCH_LINE[@]}"; do
    if [ -n "${BATCH_ERR[$i]}" ]; then
      printf 'line %s: %s\n' "${BATCH_LINE[$i]}" "${BATCH_ERR[$i]}" >&2
      n=$((n + 1)); continue
    fi
    node_batch_op "$i"
    "cmd_node_${BATCH_OP_ARGS[0]}" "$run_id" "${BATCH_OP_ARGS[@]:1}" >/dev/null 2>"$sim/err"; rc=$?
    if [ "$rc" -ne 0 ]; then
      printf 'line %s: %s\n' "${BATCH_LINE[$i]}" "$(tr '\n' ' ' < "$sim/err" | sed 's/ *$//')" >&2
      n=$((n + 1))
    fi
  done
  [ "$n" -le 100 ] || n=100
  exit "$n"
)

cmd_node_batch() {
  local run_id="${1:-}" src="" dry=0 file input waited=0 rc ops=""
  [ -n "$run_id" ] || { printf 'usage: %s\n' "$NODE_BATCH_USAGE" >&2; return 2; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --file) shift; src="${1:-}"; [ -n "$src" ] || { printf 'node batch: --file needs a path\n' >&2; return 2; } ;;
      --dry-run) dry=1 ;;
      *) printf 'node batch: unknown argument %s\n  usage: %s\n' "$1" "$NODE_BATCH_USAGE" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "node batch"
  file=$(run_require "$run_id") || return $?
  if [ -n "$src" ]; then
    [ -f "$src" ] && [ -r "$src" ] || { printf 'node batch: cannot read %s\n' "$src" >&2; return 2; }
    input="$src"
  else
    [ ! -t 0 ] || { printf 'node batch: pipe the ops on stdin or pass --file\n  usage: %s\n' "$NODE_BATCH_USAGE" >&2; return 2; }
    input=/dev/stdin
  fi
  # stdin is read once (a builtin) so the per-op fallback can read the same ops again.
  if [ "$input" = /dev/stdin ]; then IFS= read -r -d '' ops || true; input=/dev/fd/4; fi

  while ! orch_lock_acquire "run-$run_id"; do
    [ "$waited" -lt $((NODE_BATCH_LOCK_WAIT_SECS * 5)) ] \
      || { printf 'node batch: run %s is locked by another batch\n' "$run_id" >&2; return 75; }
    sleep 0.2; waited=$((waited + 1))
  done
  rc=3
  [ "${ORCH_BATCH_FAST:-1}" = 0 ] || { node_batch_fast "$run_id" "$dry" "$input" 4<<<"$ops"; rc=$?; }
  if [ "$rc" = 3 ]; then
    node_batch_parse "$input" 4<<<"$ops"
    if [ "${#BATCH_LINE[@]}" -gt 0 ]; then node_batch_locked "$run_id" "$dry"; rc=$?
    else printf 'node batch: no ops\n' >&2; rc=2; fi
  fi
  orch_lock_release "run-$run_id"
  return $rc
}

node_batch_locked() {
  local run_id="$1" dry="$2" sim bad rc
  sim=$(mktemp -d "${TMPDIR:-/tmp}/orch-batch-XXXXXX") || return 1
  node_batch_simulate "$run_id" "$sim"; bad=$?
  if [ "$bad" -ne 0 ]; then
    printf 'node batch: %s invalid op(s) of %s; nothing applied\n' "$bad" "${#BATCH_LINE[@]}" >&2
    rc=2
  elif [ "$dry" = 1 ]; then
    node_batch_print would
    printf 'node batch: %s op(s) valid (dry run, nothing applied)\n' "${#BATCH_LINE[@]}"
    rc=0
  else
    node_batch_commit "$run_id" "$sim"; rc=$?
  fi
  # Scratch only: trash when available (never rm), else the OS clears TMPDIR.
  if command -v trash >/dev/null 2>&1; then ( trash "$sim" >/dev/null 2>&1 & ); fi
  return $rc
}

# node_batch_print <would|ok> — one summary line per op.
node_batch_print() {
  local i
  for i in "${!BATCH_LINE[@]}"; do
    node_batch_op "$i"
    if [ "$1" = would ]; then printf 'line %s: would %s\n' "${BATCH_LINE[$i]}" "$(node_batch_summary)"
    else printf 'line %s: %s ok\n' "${BATCH_LINE[$i]}" "$(node_batch_summary)"; fi
  done
}

# node_batch_commit <run-id> <scratch> — moves the validated scratch result into place, or replays the
# ops against the real run when it changed since the scratch copy was taken.
node_batch_commit() {
  local run_id="$1" sim="$2" real sdir f i applied=0
  real=$(run_state_file "$run_id"); sdir="$sim/runs/$run_id"
  if cmp -s "$real" "$sim/orig.json"; then
    if [ -d "$sim/owners" ]; then
      mkdir -p "$(owners_dir)" && for f in "$sim/owners"/*.json; do
        [ -f "$f" ] && cp "$f" "$(owners_dir)/.${f##*/}.tmp.$$" && mv -f "$(owners_dir)/.${f##*/}.tmp.$$" "$(owners_dir)/${f##*/}"
      done
    fi
    [ ! -f "$sim/.dispatch-path" ] || owner_write_dispatch_path
    cp "$sdir/state.json" "$real.tmp.$$" && mv -f "$real.tmp.$$" "$real" || {
      printf 'node batch: could not write %s; nothing applied\n' "$real" >&2; return 1; }
    [ ! -s "$sdir/events.jsonl" ] || cat "$sdir/events.jsonl" >> "$(run_events_file "$run_id")" 2>/dev/null || true
    node_batch_print ok
    printf 'node batch: applied %s op(s)\n' "${#BATCH_LINE[@]}"
    return 0
  fi
  for i in "${!BATCH_LINE[@]}"; do
    node_batch_op "$i"
    if ! "cmd_node_${BATCH_OP_ARGS[0]}" "$run_id" "${BATCH_OP_ARGS[@]:1}"; then
      printf 'node batch: line %s failed after the run changed; applied %s of %s\n' \
        "${BATCH_LINE[$i]}" "$applied" "${#BATCH_LINE[@]}" >&2
      return 1
    fi
    applied=$((applied + 1))
    printf 'line %s: %s ok\n' "${BATCH_LINE[$i]}" "$(node_batch_summary)"
  done
  printf 'node batch: applied %s op(s) (replayed: the run changed during validation)\n' "$applied"
}

# ---- Fast path -------------------------------------------------------------------------------------
# The whole batch in ONE jq program: it parses the ops (NODE_BATCH_DEFS), checks each one in order with
# the same rules and messages as cmd_node_add / cmd_node_report / cmd_node_update (node_set_status and
# owner_register included), and prints NUL-separated records, then the new state. Records:
#   F                         -> an op needs the per-op path (a dependency in a continued-from run)
#   N                         -> no ops
#   E <msg>                   -> an invalid op (`line N: ...`), then X <op count>; no state follows
#   L <line> <summary>        -> one per op
#   V <event json>            -> one events.jsonl line
#   O <file name> <content>   -> one owners/<id>.json
#   D                         -> refresh <home>/.dispatch-path (owner_write_dispatch_path)
#   S <pretty state json>     -> the new state.json, last
NODE_BATCH_FAST="$NODE_BATCH_DEFS"'
  (now | floor) as $nowe | ($nowe | todate) as $now
  | (($prof[0].settings.llm_hub // {}) | if type == "object" then . else {} end) as $hub
  | ($jobsraw | split("\n") | map(select(length > 0))) as $jobs
  | def words($s): $s | split(" ") | map(select(length > 0));
  def inl($w; $s): words($s) | index($w) != null;
  def trimnl: gsub("\n"; " ") | sub(" +$"; "");
  def argmap: . as $a | {m: {}, i: 0}
    | until(.i >= ($a | length);
        if $a[.i] == "--plan-backed" or $a[.i] == "--force" or $a[.i] == "--clear-needs-user" then .m[$a[.i]] = true | .i += 1
        else .m[$a[.i]] = $a[.i + 1] | .i += 2 end) | .m;
  def nd($id): first(.s.nodes[] | select(.id == $id)) // null;
  def patch($id; f): .s.nodes |= map(if .id != $id then . else f end);
  def nn: if . == "" then null else . end;
  def ev($kind; $node; $from; $to; $note; $by):
    .out += ["V", ({at: $now, kind: $kind, node: ($node | nn), from: ($from | nn), to: ($to | nn),
                    note: ($note | nn), by: $by} | tojson)];
  def fail($line; $msg): .errs += ["line \($line): \($msg | trimnl)"];
  def ok($line; $sum): .ok += ["L", "\($line)", $sum];
  def sval: if . == null or . == false then "" else tostring end;
  def owner_parse:
    (gsub("^[[:space:]]+"; "") | gsub("[[:space:]]+$"; "")) as $t | ($t | ascii_downcase) as $l
    | if $t == "" then ["none", ""]
      elif $l == "coordinator" then ["none", "coordinator"]
      elif $t | test("\\A(agent[[:space:]:]+)?(ses_[A-Za-z0-9]+)\\z") then ["session", ($t | capture("(?<i>ses_[A-Za-z0-9]+)\\z").i)]
      elif $l | test("\\Apid[:[:space:]]+[0-9]+\\z") then ["process", ($l | capture("(?<i>[0-9]+)\\z").i)]
      elif any($jobs[]; . == $t) then ["job", $t]
      else ["unknown", $t] end;
  def literal_id:
    ascii_downcase as $l
    | if test("ses_[A-Za-z0-9]+") then ["session", capture("(?<i>ses_[A-Za-z0-9]+)").i]
      elif $l | test("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
        then ["claude", ($l | capture("(?<i>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})").i)]
      elif $l | test("(^|[^a-z])pid[:[:space:]-]*[0-9]+") then ["process", ($l | capture("(^|[^a-z])pid[:[:space:]-]*(?<i>[0-9]+)").i)]
      else ["none", ""] end;
  def registry($id; $owner): .out += ["O", (($owner | gsub("[^A-Za-z0-9._-]"; "_")) + ".json"),
    ({run: $run, node: $id, since: $now} | tojson)];
  def owner_register($id; $given):
    (nd($id)) as $n | ($n.owner | sval) as $owner | ($n.status | sval) as $st
    | if $owner == "" then .
      elif $given == "" and ($n.owner_bind // "") != "" and $n.owner_kind == "session"
           and (($n.owner_id // "") | startswith("ses_")) then .
      else
        ($owner | owner_parse) as [$k, $i]
        | .dp = true
        | patch($id; .owner_kind = $k | .owner_id = (if $i == "" then null else $i end))
        | if $st != "running" or $i == "" then .
          elif $k != "unknown" then registry($id; $i)
          else ($owner | literal_id) as [$lk, $li]
            | if $lk == "none" then . else
                patch($id; .owner_kind = $lk | .owner_id = $li | .owner_bind = "literal" | .owner_reason = null | .unowned = null
                  | (if .owner_state == "unbound" then .owner_state = null else . end)
                  | (if ((.owner // "") == "") then .owner = ("agent " + $li) else . end))
                | registry($id; $li)
                | ev("owner"; $id; ""; "bound"; "owner \($li) bound (literal)"; "owner-binder")
              end
          end
      end;
  def retry_at($id):
    ((nd($id).attempts // []) | length) as $n
    | ({d: $base, i: 0} | until(.i >= $n or .d >= 300; .d = ([.d * 2, 300] | min) | .i += 1) | .d) as $d
    | ($nowe + $d) | todate;
  def set_status($id; $s; $job; $err; $at; $owner0):
    (nd($id).status | sval) as $old
    | (if $owner0 != "" then $owner0 elif $s == "running" and $job != "" then $job else "" end) as $owner
    | (if $s == "error" then retry_at($id) else "" end) as $retry_at
    | (if $s == "waiting" and $old == "error" then
        patch($id; .attempts = ((.attempts // []) + [{job_id: .job_id, error: .error, finished: .finished,
          log_tail: (.log_tail // []), profile: .profile, adapter: .adapter, model: (.model // null),
          model_id: (.model_id // null), cost: (.cost // null), session: (.session // null),
          reason: "reset to waiting", retry_mode: null, retry_session: null}]))
       else . end)
    | patch($id;
        .status = $s
        | .updated = $now
        | (if ($s == "done" or $s == "error") and .started == null then .started = (.created // $at) | .backfilled = true else . end)
        | (if $job != "" then .job_id = $job else . end)
        | (if $err != "" then .error = $err else . end)
        | (if $s == "running" and .started == null then .started = $at else . end)
        | (if $s == "running" then .backfilled = false else . end)
        | (if $owner != "" then .owner = $owner else . end)
        | (if $s == "waiting" then .started = null | .finished = null | .error = null | .owner = null | .job_id = null | .owner_kind = null | .owner_id = null | .owner_state = null else . end)
        | (if $s == "done" and $by != "owner-liveness" then .unverified = null | .auto = null else . end)
        | (if ($s == "done" or $s == "error" or $s == "skipped") then .finished = $at else . end)
        | (if $s == "error" then .next_retry_at = $retry_at
           elif ($s == "running" or $s == "waiting" or $s == "done" or $s == "skipped") then .next_retry_at = null
           else . end))
    | owner_register($id; $owner0)
    | ev("status"; $id; $old; $s; $err; $by);
  def do_add($line; $a):
    $a[1] as $id | $a[2] as $label | ($a[3:] | argmap) as $m
    | ($m["--role"] // "") as $role | ($m["--profile"] // "") as $p0 | ($m["--tier"] // "") as $t0
    | ($m["--model"] // "") as $model | ($m["--acceptance"] // "") as $acc | ($m["--plan-backed"] // false) as $pb
    | (if $hub.mode == $hubmode and $p0 == "" then
         (($hub.harness // "opencode") | if . == "" or type != "string" then "opencode" else . end) + $hubsuffix
       else $p0 end) as $profile
    | (if $hub.mode == $hubmode and $t0 == "" and $role != "" then
         (($hub.role_tiers // {})[$role] // "") as $c
         | if ($c | type) == "string" and inl($c; $tiers) then $c else ($hubdefaults[$role] // "") end
       else $t0 end) as $tier
    | [($m["--after"] // "") | splits("[,[:space:]]+") | select(length > 0)] as $deps
    | (if $role != "" and (inl($role; $roles) | not) then "node add: --role must be one of: \($roles)"
       elif $t0 != "" and (inl($t0; $tiers) | not) then "node add: --tier must be one of: \($tiers)"
       elif ($id | test($idpat) | not) then "node add: id must match \($idpat)"
       elif nd($id) != null then "node add: \($id) already exists"
       else first(($deps[] as $d
         | if $d == $id then "node add: \($id) cannot depend on itself"
           elif nd($d) != null then empty
           elif .s.continued_from != null then "FALLBACK"
           else "node add: dependency \($d) is not in run \($run) or in the runs it continued (searched: \($run) )" end), null)
       end) as $e
    | if $e == "FALLBACK" then .fb = true
      elif $e != null then fail($line; $e)
      else
        .s.nodes += [{id: $id, label: $label, status: "waiting", profile: ($profile | nn),
          adapter: null, model: ($model | nn), model_id: null, job_id: null, session: null, started: null, finished: null,
          error: null, log_tail: [], usage: {}, cost: null, created: $now, updated: $now, prompt: null, dispatch_args: [], attempts: [],
          role: ($role | nn), tier: ($tier | nn), plan_backed: $pb, acceptance: ($acc | nn)}]
        | .s.edges += ($deps | map([., $id]))
        | ev("add"; $id; ""; "waiting"; $label; $by)
        | ok($line; "add \($id) \"\($label)\"")
      end;
  # node_deps_check: the normalized list, or an error string prefixed with "!".
  def deps_check($id; $list):
    . as $acc
    | [$list | split(",")[] | gsub(" "; "") | select(length > 0)] as $parts
    | (first($parts[] | select(. != "*") as $d
        | if $d == $id then "!node update: \($id) cannot depend on itself"
          elif ($acc | nd($d)) == null then "!node update: dependency \($d) is not in run \($run)"
          else empty end) // null) as $bad
    | if $bad != null then $bad else
        ($parts | join(",")) as $out
        | (.s.edges // []) as $e
        | def reach: . as $seen | ([$seen[] as $x | $e[] | select(.[0] == $x) | .[1]] + $seen | unique) as $next
            | if $next == $seen then $seen else ($next | reach) end;
        ([$id] | reach) as $reach
        | ([$parts[] | select(. != "*") | select(. as $x | $reach | index($x))] | join(",")) as $cyc
        | if $cyc != "" then "!node update: --after \($out) would make a cycle (\($cyc) already waits on \($id))" else $out end
      end;
  def deps_block($id; $dset; $deps; $nset; $needs):
    ($deps | split(",") | map(select(length > 0))) as $d
    | (if $dset then
         .s.edges = ([(.s.edges // [])[] | select(.[1] != $id)] + [$d[] | select(. != "*") | [., $id]])
         | patch($id; .after_all = ($d | index("*") != null) | .updated = $now)
       else . end)
    | (if $nset then patch($id; .needs_user = ($needs | nn) | .updated = $now) else . end)
    | (if $dset then ev("deps"; $id; ""; ""; "after: \(if $deps == "" then "none" else $deps end)"; $by) else . end)
    | (if $nset then ev("needs-user"; $id; ""; ""; (if $needs == "" then "cleared" else $needs end); $by) else . end);
  def do_update($line; $a):
    $a[1] as $id
    | (if ($a[2] // "-") | startswith("-") then "" else $a[2] end) as $s
    | ((if $s == "" then $a[2:] else $a[3:] end) | argmap) as $m
    | ($m["--job"] // "") as $job | ($m["--error"] // "") as $err | ($m["--at"] // "") as $at
    | ($m["--owner"] // "") as $owner | ($m["--force"] // false) as $force
    | ($m | has("--after")) as $dset | ($m | has("--needs-user") or has("--clear-needs-user")) as $nset
    | (if $m["--clear-needs-user"] then "" else ($m["--needs-user"] // "") end) as $needs
    | (nd($id).status | sval) as $old
    | ({waiting: "running done error skipped", running: "done error waiting skipped",
        error: "waiting running skipped", skipped: "waiting running", done: ""} | .[$old] // $statuses) as $allowed
    | (if nd($id) == null then null elif $dset then deps_check($id; $m["--after"]) else "" end) as $deps
    | (if ($m | has("--needs-user")) and $m["--needs-user"] == "" then "node update: --needs-user expects a reason (use --clear-needs-user to clear)"
       elif $s == "" and ($dset | not) and ($nset | not) then "usage: \($updateusage)"
       elif nd($id) == null then "node \($id): not in this run"
       elif $s != "" and (inl($s; $statuses) | not) then "node update: status must be one of: \($statuses)"
       elif $deps | startswith("!") then $deps[1:]
       elif $s == "" then null
       elif $old != $s and ($force | not) and (inl($s; $allowed) | not) then
         "node update: \($id) is \($old); it can move to: \(if $allowed == "" then "nothing" else $allowed end)\(if $old == "done" then " (done -> waiting needs --force)" else " (--force overrides)" end)"
       elif $job != "" and ($force | not) and (any($jobs[]; . == $job) | not) then "node update: job \($job) not found (--force records it anyway)"
       elif $at != "" and ($at | test("\\A[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\\z") | not) then "node update: --at must be an ISO time like 2026-01-02T03:04:05Z"
       elif $at != "" and (($at | try fromdate catch null) == null) then "node update: --at is not a valid time"
       elif $at != "" and ($at | fromdate) > $nowe then "node update: --at is in the future"
       else null end) as $e
    | if $e != null then fail($line; $e)
      else (if $s == "" then . else set_status($id; $s; $job; $err; (if $at == "" then $now else $at end); $owner) end)
        | deps_block($id; $dset; $deps; $nset; $needs)
        | ok($line; (if $s == "" then "update \($id)" else "update \($id) -> \($s)" end))
      end;
  def do_report($line; $a):
    $a[1] as $id | ($a[2:] | argmap) as $m
    | ($m["--model"] // "") as $model | ($m["--input-tokens"] // "") as $in | ($m["--output-tokens"] // "") as $out
    | ($m["--cache-read-tokens"] // "") as $cache | ($m["--usd"] // "") as $usd | ($m["--note"] // "") as $note
    | (if any($in, $out, $cache; . != "" and (test("\\A[0-9]+\\z") | not)) then "node report: token counts must be whole numbers"
       elif $usd != "" and ($usd | test("[^0-9.]") or test("\\..*\\.") or . == ".") then "node report: --usd must be a non-negative number"
       elif "\($model)\($in)\($out)\($cache)\($usd)\($note)" == "" then "node report: nothing to record\n  usage: \($reportusage)"
       elif nd($id) == null then "node \($id): not in this run"
       else null end) as $e
    | if $e != null then fail($line; $e)
      else patch($id; (.report // {}) as $o
          | .updated = $now
          | (if $model != "" then .model = $model else . end)
          | .report = {reported_by: "inline",
                       model: (if $model == "" then ($o.model // null) else $model end),
                       input_tokens: (if $in == "" then ($o.input_tokens // null) else ($in | tonumber) end),
                       output_tokens: (if $out == "" then ($o.output_tokens // null) else ($out | tonumber) end),
                       cache_read_tokens: (if $cache == "" then ($o.cache_read_tokens // null) else ($cache | tonumber) end),
                       usd: (if $usd == "" then ($o.usd // null) else ($usd | tonumber) end),
                       note: (if $note == "" then ($o.note // null) else $note end),
                       at: $now,
                       auto: ((if ($o.reported_by // "") | IN("owner-fill", "owner-liveness")
                               then ["input_tokens", "output_tokens", "cache_read_tokens", "usd"] | map(select($o[.] != null))
                               else ($o.auto // []) end)
                              - [(if $in != "" then "input_tokens" else empty end), (if $out != "" then "output_tokens" else empty end),
                                 (if $cache != "" then "cache_read_tokens" else empty end), (if $usd != "" then "usd" else empty end)]
                              | if length == 0 then null else . end)})
        | (if $note == "" then . else ev("note"; $id; ""; ""; $note; $by) end)
        | ok($line; "report \($id)")
      end;
  ($ops | split("\n") | to_entries
   | map((.key + 1) as $line | (.value | sub("\r$"; "")) as $text | select($text | test("\\S"))
         | try ($text | fromjson | {line: $line, args: build}) catch {line: $line, err: (if type == "string" then . else "invalid JSON" end)}))
  as $parsed
  | reduce $parsed[] as $p ({s: ., out: [], ok: [], errs: [], fb: false, dp: false};
      if .fb then .
      elif $p.err then fail($p.line; $p.err)
      elif $p.args[0] == "add" then do_add($p.line; $p.args)
      elif $p.args[0] == "update" then do_update($p.line; $p.args)
      else do_report($p.line; $p.args) end)
  | if .fb then "F\u0000"
    elif ($parsed | length) == 0 then "N\u0000"
    elif (.errs | length) > 0 then (.errs | map("E\u0000" + . + "\u0000") | join("")) + "X\u0000\($parsed | length)\u0000"
    else ([.ok | _nwise(3) | "L\u0000\(.[1])\u0000\(.[2])\u0000"] | join(""))
        + (.out | map(. + "\u0000") | join(""))
        + (if .dp then "D\u0000" else "" end) + "S\u0000", .s, "\n"
    end'

# node_batch_fast <run-id> <dry 0|1> <input-file> — 0 applied/valid, 2 invalid, 3 needs the per-op path,
# 1 write failure. One jq process; the writes are bash builtins plus one mv for state.json.
node_batch_fast() {
  local run_id="$1" dry="$2" input="$3" file tag a b state="" n=0 bad=0 dp=0 fill=0 jobs="" d base prof=/dev/null
  local -a lines=() events=() owners=()
  file=$(run_state_file "$run_id")
  for d in "$JOBS_HOME"/*/; do [ -d "$d" ] || continue; d="${d%/}"; jobs="$jobs${d##*/}"$'\n'; done
  base="${ORCH_AUTO_RETRY_BASE_SECS:-$ADVANCE_INTERVAL_DEFAULT}"
  is_uint "$base" && [ "$base" -ge 1 ] || base="$ADVANCE_INTERVAL_DEFAULT"
  [ ! -f "$PROFILES_FILE" ] || prof="$PROFILES_FILE"
  while IFS= read -r -d '' tag; do
    case "$tag" in
      F) return 3 ;;
      N) printf 'node batch: no ops\n' >&2; return 2 ;;
      E) IFS= read -r -d '' a; printf '%s\n' "$a" >&2; bad=$((bad + 1)) ;;
      X) IFS= read -r -d '' a; printf 'node batch: %s invalid op(s) of %s; nothing applied\n' "$bad" "$a" >&2; return 2 ;;
      L) IFS= read -r -d '' a; IFS= read -r -d '' b; lines+=("line $a: " "$b"); n=$((n + 1))
         case "$b" in "update "*" -> done"|"update "*" -> error"|"update "*" -> skipped") fill=1 ;; esac ;;
      V) IFS= read -r -d '' a; events+=("$a") ;;
      O) IFS= read -r -d '' a; IFS= read -r -d '' b; owners+=("$a" "$b") ;;
      D) dp=1 ;;
      S) IFS= read -r -d '' state; break ;;
    esac
  done < <(jq -j --rawfile ops "$input" --slurpfile prof "$prof" --rawfile jobsraw /dev/fd/3 \
      --arg run "$run_id" --arg by "${ORCH_EVENT_BY:-cli}" --argjson base "$base" \
      --arg statuses "$NODE_STATUSES" --arg roles "$WORK_ROLES" --arg tiers "$SMART_AUTO_TIERS" \
      --arg idpat "$ID_PATTERN" --arg hubmode "$HUB_MODE" --arg hubsuffix "$HUB_PROFILE_SUFFIX" \
      --argjson hubdefaults "$HUB_ROLE_TIERS_DEFAULT" --arg reportusage "$NODE_REPORT_USAGE" --arg updateusage "$NODE_UPDATE_USAGE" \
      "$NODE_BATCH_FAST" "$file" 3<<<"$jobs")
  [ -n "$state" ] || { printf 'node batch: could not read the batch result\n' >&2; return 1; }
  if [ "$dry" = 1 ]; then
    for ((a = 0; a < ${#lines[@]}; a += 2)); do printf '%swould %s\n' "${lines[$a]}" "${lines[$((a + 1))]}"; done
    printf 'node batch: %s op(s) valid (dry run, nothing applied)\n' "$n"
    return 0
  fi
  printf '%s' "$state" > "$file.tmp.$$" && mv -f "$file.tmp.$$" "$file" \
    || { printf 'node batch: could not write %s; nothing applied\n' "$file" >&2; return 1; }
  [ "${#events[@]}" -eq 0 ] || printf '%s\n' "${events[@]}" >> "$(run_events_file "$run_id")" 2>/dev/null || true
  if [ "${#owners[@]}" -gt 0 ] && mkdir -p "$ORCH_HOME/owners" 2>/dev/null; then
    for ((a = 0; a < ${#owners[@]}; a += 2)); do printf '%s\n' "${owners[$((a + 1))]}" > "$ORCH_HOME/owners/${owners[$a]}" 2>/dev/null; done
  fi
  [ "$dp" = 0 ] || owner_write_dispatch_path
  # cmd_node_update fills a session-bound node's final totals when it ends; once per batch here.
  if [ "$fill" = 1 ] && [ "${ORCH_OWNER_FILL:-1}" != 0 ] && [ -f "$(opencode_db_path)" ]; then
    owners_fill_index_run "$run_id" >/dev/null 2>&1 || true
  fi
  for ((a = 0; a < ${#lines[@]}; a += 2)); do printf '%s%s ok\n' "${lines[$a]}" "${lines[$((a + 1))]}"; done
  printf 'node batch: applied %s op(s)\n' "$n"
}

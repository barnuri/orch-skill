# `run carry` — move the unfinished part of a run into a new run. Sourced by dispatch.sh, never executed.
# Every state write goes through state_write_raw (runs.sh), like every other run mutation.

RUN_CARRY_USAGE='dispatch.sh run carry <run-id> [--title T] [--id NEW-ID] [--keep-skipped] [--keep-open]'

# The nodes that move: everything that is not done. Skipped nodes stay behind too, unless --keep-skipped.
# A node keeps every field it has (a running job, its session, its prompt), so work in flight is not
# interrupted and `run sync` still finds it by job id.
cmd_run_carry() {
  local run_id="${1:-}" title="" new_id="" keep_skipped=false keep_open=false file new_run total moved left existing dir
  [ -n "$run_id" ] || { printf 'usage: %s\n' "$RUN_CARRY_USAGE" >&2; return 2; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --title) shift; title="${1:-}" ;;
      --id) shift; new_id="${1:-}" ;;
      --keep-skipped) keep_skipped=true ;;
      --keep-open) keep_open=true ;;
      *) printf 'run carry: unknown argument %s\n  usage: %s\n' "$1" "$RUN_CARRY_USAGE" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "run carry"
  file=$(run_require "$run_id") || return $?

  total=$(jq '.nodes | length' "$file")
  moved=$(jq --argjson ks "$keep_skipped" \
    '[.nodes[] | select(.status != "done" and (.status != "skipped" or $ks))] | length' "$file")
  left=$((total - moved))
  if [ "$moved" -eq 0 ]; then
    printf 'nothing to carry: all %s node(s) of %s are finished\n' "$total" "$run_id"
    return 0
  fi

  [ -n "$title" ] || title="$(jq -r '.title' "$file") (continued)"
  if [ -n "$new_id" ]; then
    new_run=$(cmd_run_start "$title" --id "$new_id") || return $?
  else
    new_run=$(cmd_run_start "$title") || return $?
  fi

  # Only a node whose handoff folder already exists needs the pointer: a node that has not started gets its
  # folder under the new run like any other.
  existing=$(for dir in "$RUNS_HOME/$run_id"/out/*/; do [ -d "$dir" ] && basename "$dir"; done 2>/dev/null | jq -Rsc 'split("\n") | map(select(length > 0))')
  [ -n "$existing" ] || existing='[]'

  # New run: the moved nodes exactly as they are (a running node keeps its start time, job id and session),
  # and only the edges between them. An edge from a node that stays behind is a satisfied dependency, so
  # it is dropped rather than left pointing at a node the new run lacks.
  #
  # `out_dir` records where each node's handoff folder is. A running job already holds that path in
  # $ORCH_NODE_OUT, so the folder is never moved: `node out` in the new run answers with the old path.
  state_write_raw "$new_run" \
    '($old[0].nodes | map(select(.status != "done" and (.status != "skipped" or $ks)))
       | map(.id as $nid
             | if (.out_dir // null) != null or ($dirs | index($nid)) != null
               then . + {out_dir: (.out_dir // ($runs + "/" + $from + "/out/" + $nid))}
               else . end)) as $keep
     | ($keep | map(.id)) as $ids
     | .nodes = $keep
     | .edges = ($old[0].edges | map(select((.[0] as $a | $ids | index($a)) != null and (.[1] as $b | $ids | index($b)) != null)))
     | .continued_from = $from' \
    --slurpfile old "$file" --arg runs "$RUNS_HOME" --arg from "$run_id" --argjson ks "$keep_skipped" \
    --argjson dirs "$existing" || return 1

  # Old run: the moved nodes are marked, and the run closes unless asked to stay open. No learning is
  # recorded: a hand-over is not an outcome, and `run finish` would write one.
  state_write_raw "$run_id" \
    '.nodes |= map(if (.status != "done" and (.status != "skipped" or $ks))
                   then .status = "skipped" | .error = ("moved to run " + $to) | .finished = (.finished // $ts)
                   else . end)
     | .continued_to = $to
     | if $close then .status = "done" | .finished = (.finished // $ts) else . end' \
    --argjson ks "$keep_skipped" --arg to "$new_run" --arg ts "$(now_iso)" \
    --argjson close "$([ "$keep_open" = true ] && printf false || printf true)" || return 1

  printf '%s\n' "$new_run"
  printf 'carried %s node(s) from %s; %s finished node(s) stay there\n' "$moved" "$run_id" "$left" >&2
}

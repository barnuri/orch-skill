#!/usr/bin/env bash
# Planned runs and inter-agent messages for orch — sourced by dispatch.sh, never executed.
#
#   plan <run> "<goal>"   adds a planner node and dispatches it on settings.planner_profile; the
#                         planner writes plan.json (a task DAG) into its out dir.
#   plan apply <run>      validates plan.json and turns it into nodes + stored prompts.
#   run advance <run>     one scheduler step: sync, apply a finished plan, dispatch ready nodes
#                         up to settings.max_parallel. --until-done loops to the end.
#   msg send|read <run>   a per-run mailbox (runs/<id>/messages.jsonl) shared by the
#                         coordinator and every dispatched node.
#
# jq programs are single-quoted on purpose — their $vars are jq's, bound with --arg.
# shellcheck disable=SC2016

PLAN_USAGE='dispatch.sh plan <run-id> "<goal>|@file" [--profile P] [--node ID]'
PLAN_APPLY_USAGE='dispatch.sh plan apply <run-id> [--file plan.json]'
RUN_ADVANCE_USAGE='dispatch.sh run advance <run-id> [--until-done] [--interval SECS] [--timeout SECS] [--no-finish]'
MSG_SEND_USAGE='dispatch.sh msg send <run-id> --to orch|all|<node-id> [--from <node-id>|orch] "<text>"'
MSG_READ_USAGE='dispatch.sh msg read <run-id> [--for orch|<node-id>] [--since N] [--all]'

PLAN_NODE_DEFAULT=plan
MAX_PARALLEL_DEFAULT=4
MAX_NODES_DEFAULT=12
ADVANCE_INTERVAL_DEFAULT=15
MSG_MAX_BYTES=4000
PLAN_LABEL_MAX=80

run_prompt_file() { printf '%s/%s/prompts/%s.md\n' "$RUNS_HOME" "$1" "$2"; }
run_messages_file() { printf '%s/%s/messages.jsonl\n' "$RUNS_HOME" "$1"; }

# setting_uint <key> <default> — the setting when it is a positive integer, else the default.
setting_uint() {
  local value
  value=$(setting_get "$1" "$2")
  if is_uint "$value" && [ "$value" -ge 1 ]; then
    printf '%s\n' "$value"
  else
    printf '%s\n' "$2"
  fi
}

# One line per enabled profile on an enabled harness — the menu the planner picks workers from.
plan_profile_menu() {
  jq -r '
    (.settings.disabled_harnesses // []) as $disabled
    | .settings.default_profile as $default
    | .profiles | to_entries[]
    | select(.value.enabled != false)
    | select(.value.harness as $h | ($disabled | index($h)) == null)
    | "- \(.key)\(if .key == $default then " (default)" else "" end): harness \(.value.harness), model \(.value.model // "-")"
      + (if (.value.description // "") != "" then ". \(.value.description)" else "" end)
      + (if ((.value.strengths // []) | length) > 0 then " Strengths: \(.value.strengths | join(", "))." else "" end)
      + (if ((.value.avoid_for // []) | length) > 0 then " Avoid for: \(.value.avoid_for | join(", "))." else "" end)
  ' "$PROFILES_FILE"
}

plan_prompt_text() {
  local run_id="$1" goal="$2" out_dir="$3" max_nodes="$4" max_parallel="$5" default_profile="$6"
  cat <<EOF
You are the planner for orch run $run_id. Do not implement anything and do not edit project files.
Your only job is to read what you need, then write a plan that other coding agents will execute.

## Goal

$goal

## Working directory

$(pwd -P)

## What to decide

1. Which tasks the goal needs, and how many agents that takes. Use as few as do the job well.
2. Which tasks are independent and can run in parallel, and which must wait for others.
3. Which profile runs each task. Default to "$default_profile" unless a task clearly needs another.

## Rules

- At most $max_nodes tasks. At most $max_parallel run at the same time, so keep each parallel stage at or under $max_parallel tasks.
- Run tasks in parallel only when they touch different files or areas. Tasks that edit the same files must be sequential ("after").
- When the plan branches, end with one integration task that depends on every branch and verifies the whole result (build, tests).
- Each task prompt must be self-contained: goal, files to touch, acceptance criteria, and the command that proves it works. The worker sees only its prompt plus the handoffs of the tasks it depends on.
- Task ids match ^[A-Za-z0-9][A-Za-z0-9._-]*\$ and must not be "$PLAN_NODE_DEFAULT". "after" lists ids from this plan only.

## Profiles you can assign

$(plan_profile_menu)

## Output

Write this JSON to $out_dir/plan.json (the same path is in \$ORCH_NODE_OUT):

{"summary": "one line", "tasks": [{"id": "api", "label": "short label", "profile": "$default_profile", "after": [], "prompt": "full instructions"}]}

Also write a readable version to $out_dir/plan.md: the stages, what runs in parallel, why the split, and the risks.
Finish by replying with the summary line only.
EOF
}

# plan <run-id> "<goal>|@file" [--profile P] [--node ID]
cmd_plan() {
  case "${1:-}" in
    apply) shift; cmd_plan_apply "$@"; return $? ;;
  esac
  local run_id="${1:-}" raw_goal="${2:-}" profile="" node_id="$PLAN_NODE_DEFAULT" file goal out_dir prompt_file
  if [ -z "$run_id" ] || [ -z "$raw_goal" ]; then
    printf 'usage: %s\n       %s\n' "$PLAN_USAGE" "$PLAN_APPLY_USAGE" >&2
    return 2
  fi
  shift 2
  while [ $# -gt 0 ]; do
    case "$1" in
      --profile) shift; profile="${1:-}" ;;
      --node) shift; node_id="${1:-}" ;;
      *) printf 'plan: unknown argument %s\n  usage: %s\n' "$1" "$PLAN_USAGE" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "plan"
  file=$(run_require "$run_id") || return $?
  valid_id "$node_id" || { printf 'plan: node id must match %s\n' "$ID_PATTERN" >&2; return 2; }
  [ -n "$profile" ] || profile=$(setting_get planner_profile "")
  [ -n "$profile" ] || { printf 'plan: no planner — set settings.planner_profile or pass --profile\n' >&2; return 2; }
  profile_require "$profile" >/dev/null || return 2
  goal=$(resolve_prompt "$raw_goal") || return 1

  if ! node_require "$file" "$node_id" 2>/dev/null; then
    cmd_node_add "$run_id" "$node_id" "Plan" --profile "$profile" || return $?
  fi
  out_dir=$(node_out_dir "$run_id" "$node_id")
  prompt_file=$(run_prompt_file "$run_id" "$node_id")
  mkdir -p "$out_dir" "${prompt_file%/*}" || return 1
  plan_prompt_text "$run_id" "$goal" "$out_dir" \
    "$(setting_uint max_nodes "$MAX_NODES_DEFAULT")" "$(setting_uint max_parallel "$MAX_PARALLEL_DEFAULT")" \
    "$(setting_get default_profile "")" > "$prompt_file" || return 1
  state_write "$run_id" '.plan = {node: $n, profile: $p, applied: null, summary: null, tasks: 0}' \
    --arg n "$node_id" --arg p "$profile" || return 1
  cmd_node_dispatch "$run_id" "$node_id" --profile "$profile" "@$prompt_file"
}

# Validates a plan document against the run and the profiles; prints {errors:[…]} or
# {tasks:[…] in dependency order, warnings:[…]}. A task naming an unusable profile falls back to
# the default profile with a warning rather than failing the whole plan.
PLAN_VALIDATE_JQ='
  def idok: type == "string" and test("^[A-Za-z0-9][A-Za-z0-9._-]*$");
  def layers($t):
    reduce range(0; ($t | length) + 1) as $_ ({};
      . as $L
      | reduce $t[] as $x ($L;
          if has($x.id) then .
          else [($x.after // [])[] | $L[.]] as $ds
            | if ($ds | all(. != null)) then .[$x.id] = (($ds | max // -1) + 1) else . end
          end));
  $prof[0] as $doc
  | ($doc.settings.disabled_harnesses // []) as $disabled
  | if (.tasks | type) != "array" or (.tasks | length) == 0 then {errors: ["plan.tasks must be a non-empty array"]}
    else
      .tasks as $t
      | [$t[] | .id] as $ids
      | [ (if ($t | length) > $max then "plan has \($t | length) tasks; settings.max_nodes is \($max)" else empty end),
          ($t[] | select(.id | idok | not) | "task id \(.id | tojson) must match ^[A-Za-z0-9][A-Za-z0-9._-]*$"),
          ($ids | map(select(type == "string")) | group_by(.) | map(select(length > 1) | .[0]) | .[] | "duplicate task id \(.)"),
          ($t[] | .id as $i | select($i == $plan or (($existing | index($i)) != null)) | "task id \($i) collides with an existing node"),
          ($t[] | select((.prompt | type) != "string" or (.prompt | length) == 0) | "task \(.id) has no prompt"),
          ($t[] | select(has("after") and (.after | type) != "array") | "task \(.id): after must be an array"),
          ($t[] | .id as $i | (.after // [] | if type == "array" then .[] else empty end)
                | . as $d | select(($ids | index($d)) == null) | "task \($i) depends on unknown task \($d)")
        ] as $errs
      | if ($errs | length) > 0 then {errors: $errs}
        else
          layers($t) as $L
          | [$t[] | select($L[.id] == null) | .id] as $cyclic
          | if ($cyclic | length) > 0 then {errors: ["dependency cycle among: \($cyclic | join(", "))"]}
            else
              ($t | to_entries | map(.value + {_i: .key, layer: $L[.value.id]})) as $ordered
              | [ $ordered[] | (.profile // "") as $p | ($doc.profiles[$p] // null) as $pp
                  | if $p == "" then {task: (. + {profile: $default}), warn: null}
                    elif $pp == null then {task: (. + {profile: $default}), warn: "task \(.id): unknown profile \($p), using \($default)"}
                    elif $pp.enabled == false or (($disabled | index($pp.harness)) != null) then
                      {task: (. + {profile: $default}), warn: "task \(.id): profile \($p) is disabled, using \($default)"}
                    else {task: ., warn: null} end ] as $resolved
              | {summary: (.summary // ""),
                 warnings: [$resolved[] | .warn | select(. != null)],
                 tasks: ([$resolved[] | .task
                          | {id, layer, _i, profile, prompt,
                             label: ((.label // .id) | tostring | .[0:'"$PLAN_LABEL_MAX"']),
                             after: (.after // [])}]
                         | sort_by(.layer, ._i))}
            end
        end
    end
'

# Appended to every planned task: where its inputs are, where its handoff goes, how to talk.
plan_task_footer() {
  local run_id="$1" task_id="$2" inputs="$3" parallel="$4"
  cat <<EOF

---
orch context — run $run_id, task $task_id.
Before you start, read the handoff files in: $inputs
When you finish, write your handoff (what you did, what changed, anything the next task must know or read) to \$ORCH_NODE_OUT/handoff.md.
Running in parallel with you: ${parallel:-none}. Stay inside your own task's files.
Talk to the coordinator or another task through the run mailbox:
  bash "\$ORCH_DISPATCH" msg send $run_id --to orch "<text>"          # blockers, questions, scope changes
  bash "\$ORCH_DISPATCH" msg send $run_id --to <task-id>|all "<text>" # a heads-up another task needs
  bash "\$ORCH_DISPATCH" msg read $run_id                            # messages for you
Read your messages before you start and again before you finish.
EOF
}

# plan apply <run-id> [--file plan.json]
cmd_plan_apply() {
  local run_id="${1:-}" plan_file="" file plan_node default_profile checked
  [ -n "$run_id" ] || { printf 'usage: %s\n' "$PLAN_APPLY_USAGE" >&2; return 2; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --file) shift; plan_file="${1:-}" ;;
      *) printf 'plan apply: unknown argument %s\n  usage: %s\n' "$1" "$PLAN_APPLY_USAGE" >&2; return 2 ;;
    esac
    shift
  done
  require_jq "plan apply"
  file=$(run_require "$run_id") || return $?
  plan_node=$(jq -r --arg d "$PLAN_NODE_DEFAULT" '.plan.node // $d' "$file")
  if [ "$(jq -r '.plan.applied // empty' "$file")" != "" ]; then
    printf 'plan apply: run %s already has an applied plan\n' "$run_id" >&2
    return 2
  fi
  [ -n "$plan_file" ] || plan_file="$(node_out_dir "$run_id" "$plan_node")/plan.json"
  [ -f "$plan_file" ] || { printf 'plan apply: no plan at %s\n' "$plan_file" >&2; return 1; }
  jq -e 'type == "object"' "$plan_file" >/dev/null 2>&1 \
    || { printf 'plan apply: %s is not a JSON object\n' "$plan_file" >&2; return 1; }
  default_profile=$(setting_get default_profile "")

  checked=$(jq -c --slurpfile prof "$PROFILES_FILE" \
    --argjson existing "$(jq -c '[.nodes[].id]' "$file")" \
    --argjson max "$(setting_uint max_nodes "$MAX_NODES_DEFAULT")" \
    --arg plan "$plan_node" --arg default "$default_profile" \
    "$PLAN_VALIDATE_JQ" "$plan_file") || { printf 'plan apply: could not read %s\n' "$plan_file" >&2; return 1; }
  if printf '%s' "$checked" | jq -e 'has("errors")' >/dev/null; then
    printf '%s' "$checked" | jq -r '.errors[] | "plan apply: " + .' >&2
    return 2
  fi
  printf '%s' "$checked" | jq -r '.warnings[] | "plan apply: warning: " + .' >&2

  # The plan node itself only gains dependents when it is part of this run's graph.
  local has_plan_node=0 task id label profile after deps inputs parallel dep prompt_file count=0
  node_require "$file" "$plan_node" 2>/dev/null && has_plan_node=1
  while IFS= read -r task; do
    [ -n "$task" ] || continue
    id=$(printf '%s' "$task" | jq -r '.id')
    label=$(printf '%s' "$task" | jq -r '.label')
    profile=$(printf '%s' "$task" | jq -r '.profile // empty')
    after=$(printf '%s' "$task" | jq -r '.after | join(",")')
    deps="$after"
    [ -n "$deps" ] || { [ "$has_plan_node" -eq 1 ] && deps="$plan_node"; }
    local -a add_args=("$run_id" "$id" "$label")
    [ -n "$deps" ] && add_args+=(--after "$deps")
    [ -n "$profile" ] && add_args+=(--profile "$profile")
    cmd_node_add "${add_args[@]}" || return $?

    inputs=""
    for dep in $(printf '%s' "$deps" | tr ',' ' '); do
      inputs="$inputs${inputs:+, }$(node_out_dir "$run_id" "$dep")"
    done
    parallel=$(printf '%s' "$checked" | jq -r --arg id "$id" \
      '(.tasks[] | select(.id == $id) | .layer) as $l | [.tasks[] | select(.layer == $l and .id != $id) | .id] | join(", ")')
    prompt_file=$(run_prompt_file "$run_id" "$id")
    mkdir -p "${prompt_file%/*}" || return 1
    { printf '%s' "$task" | jq -r '.prompt'
      plan_task_footer "$run_id" "$id" "${inputs:-none}" "$parallel"
    } > "$prompt_file" || return 1
    count=$((count + 1))
  done <<EOF
$(printf '%s' "$checked" | jq -c '.tasks[]')
EOF

  state_write "$run_id" '.plan = ((.plan // {node: $n}) + {applied: $ts, summary: $s, tasks: $c})' \
    --arg n "$plan_node" --arg ts "$(now_iso)" --arg s "$(printf '%s' "$checked" | jq -r '.summary')" \
    --argjson c "$count" || return 1
  printf 'applied: %s task(s)\n' "$count"
  printf '%s' "$checked" | jq -r '"stages: " + ([.tasks | group_by(.layer)[] | map(.id) | join("+")] | join(" -> "))'
}

# Prints waiting nodes whose deps are all done, in input order, one per line.
run_ready_ids() {
  jq -r '. as $r
    | .nodes[] | select(.status == "waiting") | .id as $n
    | select(all($r.edges[] | select(.[1] == $n) | .[0] as $d | ($r.nodes[] | select(.id == $d) | .status); . == "done"))
    | .id' "$1"
}

# One scheduler step. Prints what it did, then the same counters `run sync` does.
# Exit: 0 progressed/finished, 1 a plan or dispatch failed, 3 blocked (nothing can run).
run_advance_once() {
  local run_id="$1" file plan_node plan_status max_parallel running slots id prompt dispatched="" queued="" manual=""
  file=$(run_state_file "$run_id")
  cmd_run_sync "$run_id" >/dev/null || return 1

  plan_node=$(jq -r '.plan.node // empty' "$file")
  if [ -n "$plan_node" ] && [ -z "$(jq -r '.plan.applied // empty' "$file")" ]; then
    plan_status=$(node_field "$file" "$plan_node" status)
    case "$plan_status" in
      done) cmd_plan_apply "$run_id" || return 1 ;;
      error) printf 'advance: planner node %s failed — see orch node digest %s %s\n' "$plan_node" "$run_id" "$plan_node" >&2; return 1 ;;
    esac
  fi

  max_parallel=$(setting_uint max_parallel "$MAX_PARALLEL_DEFAULT")
  running=$(jq '[.nodes[] | select(.status == "running")] | length' "$file")
  slots=$((max_parallel - running))
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    if [ -f "$(run_prompt_file "$run_id" "$id")" ]; then
      prompt="@$(run_prompt_file "$run_id" "$id")"
    else
      prompt=$(node_field "$file" "$id" prompt)
    fi
    if [ -z "$prompt" ]; then
      manual="$manual${manual:+,}$id"
      continue
    fi
    if [ "$slots" -le 0 ]; then
      queued="$queued${queued:+,}$id"
      continue
    fi
    node_dispatch_stored "$run_id" "$id" "$prompt" >/dev/null || return 1
    dispatched="$dispatched${dispatched:+,}$id"
    slots=$((slots - 1))
  done <<EOF
$(run_ready_ids "$file")
EOF

  printf 'dispatched: %s\n' "$dispatched"
  printf 'queued: %s\n' "$queued"
  [ -z "$manual" ] || printf 'needs-prompt: %s\n' "$manual"
  jq -r '"running: " + ([.nodes[] | select(.status == "running")] | length | tostring)
    + "  waiting: " + ([.nodes[] | select(.status == "waiting")] | length | tostring)
    + "  done: " + ([.nodes[] | select(.status == "done" or .status == "skipped")] | length | tostring)
    + "  error: " + ([.nodes[] | select(.status == "error")] | length | tostring)' "$file"

  # Nothing running and nothing dispatched while nodes still wait: an upstream error (or a node
  # that needs a hand-written prompt) is holding them.
  if [ -z "$dispatched" ] && [ "$(jq '[.nodes[] | select(.status == "running")] | length' "$file")" -eq 0 ] \
      && [ "$(jq '[.nodes[] | select(.status == "waiting")] | length' "$file")" -gt 0 ]; then
    printf 'blocked: %s\n' "$(jq -r '[.nodes[] | select(.status == "waiting") | .id] | join(",")' "$file")"
    return 3
  fi
  return 0
}

cmd_run_advance() {
  local run_id="${1:-}" until_done=0 interval="$ADVANCE_INTERVAL_DEFAULT" timeout=0 finish=1 file rc elapsed=0
  [ -n "$run_id" ] || { printf 'usage: %s\n' "$RUN_ADVANCE_USAGE" >&2; return 2; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --until-done) until_done=1 ;;
      --interval) shift; interval="${1:-}" ;;
      --timeout) shift; timeout="${1:-}" ;;
      --no-finish) finish=0 ;;
      *) printf 'run advance: unknown argument %s\n  usage: %s\n' "$1" "$RUN_ADVANCE_USAGE" >&2; return 2 ;;
    esac
    shift
  done
  { is_uint "$interval" && [ "$interval" -ge 1 ] && is_uint "$timeout"; } \
    || { printf 'run advance: --interval expects >= 1 and --timeout >= 0 seconds\n' >&2; return 2; }
  require_jq "run advance"
  file=$(run_require "$run_id") || return $?

  while :; do
    run_advance_once "$run_id"
    rc=$?
    [ "$rc" -eq 1 ] && return 1
    if [ "$(jq '[.nodes[] | select(.status == "waiting" or .status == "running")] | length' "$file")" -eq 0 ] \
        && [ "$(jq '.nodes | length' "$file")" -gt 0 ]; then
      if [ "$finish" -eq 1 ] && [ "$(jq -r '.status' "$file")" = "running" ]; then
        printf 'finished: %s\n' "$(cmd_run_finish "$run_id" 2>/dev/null | tail -n 1)"
      fi
      return 0
    fi
    [ "$rc" -eq 3 ] && return 3
    [ "$until_done" -eq 1 ] || return 0
    if [ "$timeout" -gt 0 ] && [ "$elapsed" -ge "$timeout" ]; then
      printf 'advance: timed out after %ss (run still active)\n' "$timeout" >&2
      return 124
    fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done
}

# --- mailbox -----------------------------------------------------------------------------------

# Best effort: when the sender runs inside Herdr, surface the message in the Herdr UI too, so a
# human watching the panes sees it without polling the mailbox. Never fails the send.
msg_herdr_notify() {
  [ "${HERDR_ENV:-}" = "1" ] || return 0
  command -v herdr >/dev/null 2>&1 || return 0
  herdr notification show "orch $1: $2 → $3" --body "$4" --sound request >/dev/null 2>&1 || true
}

# msg send <run-id> --to X [--from Y] "<text>" — one JSON line appended to the run's mailbox.
# A single short write with O_APPEND is atomic, so parallel nodes can send without a lock.
cmd_msg_send() {
  local run_id="${1:-}" to="" from="" text="" file line id
  [ -n "$run_id" ] || { printf 'usage: %s\n' "$MSG_SEND_USAGE" >&2; return 2; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --to) shift; to="${1:-}" ;;
      --from) shift; from="${1:-}" ;;
      -*) printf 'msg send: unknown argument %s\n  usage: %s\n' "$1" "$MSG_SEND_USAGE" >&2; return 2 ;;
      *) [ -z "$text" ] && text="$1" ;;
    esac
    shift
  done
  if [ -z "$to" ] || [ -z "$text" ]; then
    printf 'usage: %s\n' "$MSG_SEND_USAGE" >&2
    return 2
  fi
  require_jq "msg send"
  file=$(run_require "$run_id") || return $?
  if [ -z "$from" ]; then
    if [ "${ORCH_RUN_ID:-}" = "$run_id" ] && [ -n "${ORCH_NODE_ID:-}" ]; then from="$ORCH_NODE_ID"; else from=orch; fi
  fi
  for id in "$to" "$from"; do
    case "$id" in
      orch|all) ;;
      *) node_require "$file" "$id" || return 2 ;;
    esac
  done
  [ "$from" != all ] || { printf 'msg send: --from cannot be all\n' >&2; return 2; }
  [ "${#text}" -le "$MSG_MAX_BYTES" ] \
    || { printf 'msg send: text is over %s characters — write it to a file and send the path\n' "$MSG_MAX_BYTES" >&2; return 2; }
  line=$(jq -nc --arg ts "$(now_iso)" --arg f "$from" --arg t "$to" --arg x "$text" '{ts: $ts, from: $f, to: $t, text: $x}') || return 1
  printf '%s\n' "$line" >> "$(run_messages_file "$run_id")" || return 1
  msg_herdr_notify "$run_id" "$from" "$to" "$text"
  printf 'sent\n'
}

# msg read <run-id> [--for X] [--since N] [--all] — prints `N<TAB>ts<TAB>from -> to<TAB>text`,
# N being the line number, so a reader can pass --since N next time to see only newer messages.
cmd_msg_read() {
  local run_id="${1:-}" for_id="" since=0 all=0 box
  [ -n "$run_id" ] || { printf 'usage: %s\n' "$MSG_READ_USAGE" >&2; return 2; }
  shift
  while [ $# -gt 0 ]; do
    case "$1" in
      --for) shift; for_id="${1:-}" ;;
      --since) shift; since="${1:-}" ;;
      --all) all=1 ;;
      *) printf 'msg read: unknown argument %s\n  usage: %s\n' "$1" "$MSG_READ_USAGE" >&2; return 2 ;;
    esac
    shift
  done
  is_uint "$since" || { printf 'msg read: --since expects a line number\n' >&2; return 2; }
  require_jq "msg read"
  run_require "$run_id" >/dev/null || return $?
  if [ -z "$for_id" ]; then
    if [ "${ORCH_RUN_ID:-}" = "$run_id" ] && [ -n "${ORCH_NODE_ID:-}" ]; then for_id="$ORCH_NODE_ID"; else for_id=orch; fi
  fi
  box=$(run_messages_file "$run_id")
  [ -f "$box" ] || return 0
  jq -rs --arg me "$for_id" --argjson since "$since" --argjson all "$all" '
    to_entries[] | (.key + 1) as $n | .value
    | select($n > $since)
    | select($all == 1 or ((.to == $me or .to == "all") and .from != $me))
    | "\($n)\t\(.ts)\t\(.from) -> \(.to)\t\(.text)"' "$box"
}

cmd_msg() {
  local sub="${1:-}"
  [ $# -gt 0 ] && shift
  case "$sub" in
    send) cmd_msg_send "$@" ;;
    read) cmd_msg_read "$@" ;;
    *) printf 'usage: %s\n       %s\n' "$MSG_SEND_USAGE" "$MSG_READ_USAGE" >&2; return 2 ;;
  esac
}

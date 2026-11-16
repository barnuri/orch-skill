# shellcheck shell=bash
# Delegation state for a run: the plan, the task list and the review findings. Sourced by
# dispatch.sh, never executed. Every write goes through state_write (run lock) into state.json
# under `.delegation`. After its context is trimmed, the orch session reads it back with
# `delegate show`; nothing outside this record is trusted to survive a trim.
#
# Roles: plan and review need a strong profile (quality high or best). implement and fix need a
# profile below that. The check is deterministic; cost is not compared.

DELEGATE_USAGE='dispatch.sh delegate <run-id> plan "<text>|@file"
       dispatch.sh delegate <run-id> task add <id> --stage plan|implement|review|fix --profile P [--label L]
       dispatch.sh delegate <run-id> task set <id> todo|doing|done|blocked
       dispatch.sh delegate <run-id> finding add <task-id> "<text>"
       dispatch.sh delegate <run-id> finding close <F-id>
       dispatch.sh delegate <run-id> show [--json]'
DELEGATE_STAGES="plan implement review fix"
DELEGATE_TASK_STATUSES="todo doing done blocked"
DELEGATE_PLAN_MAX=20000
DELEGATE_INIT='.delegation //= {plan: null, tasks: [], findings: []}'

# delegate_profile_class <profile>: prints strong (quality high or best) or cheap. Exit 1 when the
# profile does not exist.
delegate_profile_class() {
  jq -e --arg p "$1" '.profiles[$p]' "$PROFILES_FILE" >/dev/null 2>&1 || return 1
  case "$(jq -r --arg p "$1" '.profiles[$p].quality // ""' "$PROFILES_FILE")" in
    high|best) printf 'strong\n' ;;
    *) printf 'cheap\n' ;;
  esac
}

# delegate_plan <run-id> "<text>|@file"
delegate_plan() {
  local run_id="$1" text="${2:-}"
  [ -n "$text" ] || { printf 'usage: %s\n' "$DELEGATE_USAGE" >&2; return 2; }
  if [ "${text#@}" != "$text" ]; then
    text="${text#@}"
    [ -f "$text" ] || { printf 'delegate plan: no file %s\n' "$text" >&2; return 2; }
    text=$(cat "$text")
  fi
  [ "${#text}" -le "$DELEGATE_PLAN_MAX" ] \
    || { printf 'delegate plan: plan is over %s characters\n' "$DELEGATE_PLAN_MAX" >&2; return 2; }
  state_write "$run_id" "$DELEGATE_INIT | .delegation.plan = \$p" --arg p "$text" || return 1
  printf 'plan stored\n'
}

# delegate_task <run-id> add <id> --stage S --profile P [--label L] | set <id> <status>
delegate_task() {
  local run_id="$1" verb="${2:-}" id="${3:-}" stage="" profile="" label="" status="" cls want file
  if [ $# -ge 2 ]; then shift 2; else shift $#; fi
  file=$(run_require "$run_id") || return $?
  case "$verb" in
    add)
      [ $# -ge 1 ] && shift
      while [ $# -gt 0 ]; do
        case "$1" in
          --stage) shift; stage="${1:-}" ;;
          --profile) shift; profile="${1:-}" ;;
          --label) shift; label="${1:-}" ;;
          *) printf 'delegate task: unknown argument %s\n' "$1" >&2; return 2 ;;
        esac
        shift
      done
      valid_id "$id" || { printf 'delegate task: bad id %s\n' "$id" >&2; return 2; }
      case " $DELEGATE_STAGES " in *" $stage "*) ;; *) printf 'delegate task: stage must be one of: %s\n' "$DELEGATE_STAGES" >&2; return 2 ;; esac
      cls=$(delegate_profile_class "$profile") || { printf 'delegate task: unknown profile %s\n' "$profile" >&2; return 2; }
      case "$stage" in plan|review) want=strong ;; *) want=cheap ;; esac
      [ "$cls" = "$want" ] \
        || { printf 'delegate task: stage %s needs a %s profile (quality high or best for strong); %s is %s\n' "$stage" "$want" "$profile" "$cls" >&2; return 2; }
      jq -e --arg i "$id" 'any(.delegation.tasks[]?; .id == $i) | not' "$file" >/dev/null \
        || { printf 'delegate task: task %s already exists\n' "$id" >&2; return 2; }
      state_write "$run_id" "$DELEGATE_INIT | .delegation.tasks += [{id: \$i, label: (if \$l == \"\" then \$i else \$l end), stage: \$s, profile: \$p, status: \"todo\"}]" \
        --arg i "$id" --arg l "$label" --arg s "$stage" --arg p "$profile" || return 1
      printf 'task %s added\n' "$id"
      ;;
    set)
      status="${2:-}"
      case " $DELEGATE_TASK_STATUSES " in *" $status "*) ;; *) printf 'delegate task: status must be one of: %s\n' "$DELEGATE_TASK_STATUSES" >&2; return 2 ;; esac
      jq -e --arg i "$id" 'any(.delegation.tasks[]?; .id == $i)' "$file" >/dev/null \
        || { printf 'delegate task: unknown task %s\n' "$id" >&2; return 2; }
      state_write "$run_id" "$DELEGATE_INIT | (.delegation.tasks[] | select(.id == \$i) | .status) = \$s" \
        --arg i "$id" --arg s "$status" || return 1
      printf 'task %s %s\n' "$id" "$status"
      ;;
    *) printf 'usage: %s\n' "$DELEGATE_USAGE" >&2; return 2 ;;
  esac
}

# delegate_finding <run-id> add <task-id> "<text>" | close <F-id>
delegate_finding() {
  local run_id="$1" verb="${2:-}" task="${3:-}" text="${4:-}" file next
  file=$(run_require "$run_id") || return $?
  case "$verb" in
    add)
      jq -e --arg i "$task" 'any(.delegation.tasks[]?; .id == $i)' "$file" >/dev/null \
        || { printf 'delegate finding: unknown task %s\n' "$task" >&2; return 2; }
      [ -n "$text" ] || { printf 'delegate finding: text is empty\n' >&2; return 2; }
      next="F$(jq '(.delegation.findings // []) | length + 1' "$file")"
      state_write "$run_id" "$DELEGATE_INIT | .delegation.findings += [{id: \$f, task: \$t, text: \$x, status: \"open\"}]" \
        --arg f "$next" --arg t "$task" --arg x "$text" || return 1
      printf '%s\n' "$next"
      ;;
    close)
      jq -e --arg f "$task" 'any(.delegation.findings[]?; .id == $f)' "$file" >/dev/null \
        || { printf 'delegate finding: unknown finding %s\n' "$task" >&2; return 2; }
      state_write "$run_id" "$DELEGATE_INIT | (.delegation.findings[] | select(.id == \$f) | .status) = \"closed\"" \
        --arg f "$task" || return 1
      printf 'finding %s closed\n' "$task"
      ;;
    *) printf 'usage: %s\n' "$DELEGATE_USAGE" >&2; return 2 ;;
  esac
}

# delegate_show <run-id> [--json]: the stored plan, task list and open findings.
delegate_show() {
  local run_id="$1" file
  file=$(run_require "$run_id") || return $?
  if [ "${2:-}" = --json ]; then
    jq -c "$DELEGATE_INIT | .delegation" "$file"
    return 0
  fi
  jq -r "$DELEGATE_INIT | .delegation as \$d
    | \"plan:\", (\$d.plan // \"(none)\"),
      \"tasks:\", (if (\$d.tasks | length) == 0 then \"  (none)\"
        else (\$d.tasks[] | \"  \\(.id)\\t\\(.stage)\\t\\(.profile)\\t\\(.status)\\t\\(.label)\") end),
      \"open findings: \([\$d.findings[] | select(.status == \"open\")] | length)\",
      (\$d.findings[] | select(.status == \"open\") | \"  \\(.id)\\t\\(.task)\\t\\(.text)\")" "$file"
}

# cmd_delegate <run-id> plan|task|finding|show ...
cmd_delegate() {
  local run_id="${1:-}" sub="${2:-}"
  [ -n "$run_id" ] && [ -n "$sub" ] || { printf 'usage: %s\n' "$DELEGATE_USAGE" >&2; return 2; }
  shift 2
  require_jq "delegate"
  case "$sub" in
    plan) delegate_plan "$run_id" "$@" ;;
    task) delegate_task "$run_id" "$@" ;;
    finding) delegate_finding "$run_id" "$@" ;;
    show) delegate_show "$run_id" "$@" ;;
    *) printf 'usage: %s\n' "$DELEGATE_USAGE" >&2; return 2 ;;
  esac
}

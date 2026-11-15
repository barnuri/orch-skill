#!/usr/bin/env bash
# Test double for the opencode, cursor-agent and pi CLIs (copy or symlink it under that name).
# Keeps one file per session in $FAKE_STATE and answers "turns=<prompts seen in this session>".
# Never calls a model.
name=$(basename "$0")
state=${FAKE_STATE:?}
mkdir -p "$state"
reply() { # <session-file> <prompt>
  printf '@@@\n%s\n' "$2" >> "$1"
  [ -z "${FAKE_AGENT_LOG:-}" ] || printf '%s\t%s\t%s\n' "$name" "$(basename "$1")" "$2" >> "$FAKE_AGENT_LOG"
  printf 'turns=%s' "$(grep -c '^@@@$' "$1")"
}
case "$name" in
  cursor-agent)
    if [ "$1" = create-chat ]; then
      [ -z "${FAKE_NO_CREATE_CHAT:-}" ] || exit 1
      id="chat$(date +%s)$RANDOM"; : > "$state/$id"; echo "$id"; exit 0
    fi
    prompt=""; resume=""
    while [ $# -gt 0 ]; do
      case "$1" in -p) prompt=$2; shift ;; --resume) resume=$2; shift ;; esac
      shift
    done
    file="$state/${resume:-fresh$RANDOM}"
    if [ -n "$resume" ] && [ ! -f "$file" ]; then echo "chat $resume not found" >&2; exit 1; fi
    reply "$file" "$prompt" ;;
  opencode)
    if [ "$1" = session ]; then
      [ -z "${FAKE_NO_SESSION_LIST:-}" ] || exit 1
      printf '['; sep=""
      for f in $(ls -t "$state"/ses_* 2>/dev/null | grep -v "\.title$"); do
        printf '%s{"id":"%s","title":"%s"}' "$sep" "$(basename "$f")" "$(head -n1 "$f.title")"; sep=","
      done
      printf ']\n'; exit 0
    fi
    prompt=$2; shift 2; sid=""; title=""
    while [ $# -gt 0 ]; do
      case "$1" in --session) sid=$2; shift ;; --title) title=$2; shift ;; esac
      shift
    done
    if [ -n "$sid" ]; then
      [ -f "$state/$sid" ] || { echo "Session not found: $sid" >&2; exit 1; }
    else
      sid="ses_$(date +%s)$RANDOM"; : > "$state/$sid"; printf '%s\n' "$title" > "$state/$sid.title"
    fi
    reply "$state/$sid" "$prompt" ;;
  pi)
    prompt=""; dir=""; sid=""
    while [ $# -gt 0 ]; do
      case "$1" in -p) prompt=$2; shift ;; --session-dir) dir=$2; shift ;; --session-id) sid=$2; shift ;; esac
      shift
    done
    if [ -z "$sid" ]; then reply "$state/ephemeral$RANDOM" "$prompt"; exit 0; fi
    mkdir -p "$dir"
    reply "$dir/$sid" "$prompt" ;;
esac

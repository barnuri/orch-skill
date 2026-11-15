#!/usr/bin/env bash
# Like fake-dispatch.sh, but runs the real profile_load of dispatch.sh (model validation from
# ORCH_MODEL_ID) and echoes the slug it resolved. Never calls a model.
[ "$1" = run ] || { echo "unexpected: $*" >&2; exit 2; }
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck disable=SC1091
source "$here/../../../../skills/orch/scripts/dispatch.sh"
profile_load "$3" || exit $?
printf 'slug=%s id=%s' "$PROFILE_MODEL" "$PROFILE_MODEL_ID"

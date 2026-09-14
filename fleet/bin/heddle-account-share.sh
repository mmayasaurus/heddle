#!/usr/bin/env bash
# Share resumable Claude Code session state with a per-account config directory.
# Keeps .claude.json per-directory: it must never be shared across accounts.
set -u

usage() {
  echo "Usage: $(basename "$0") <acctId|--all> [--dry-run]" >&2
  exit 2
}

DRY_RUN=0
TARGET=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --all) TARGET="--all" ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage ;;
    -*) echo "Unknown option: $1" >&2; usage ;;
    *)
      [[ -z "$TARGET" ]] || { echo "Only one account target is allowed." >&2; usage; }
      TARGET="$1"
      ;;
  esac
  shift
done
[[ -n "$TARGET" ]] || usage

ACCOUNTS_FILE="$HOME/.heddle/accounts.json"
CLAUDE_BIN="$(command -v claude || echo "$HOME/.local/bin/claude")"
DEFAULT_DIR="$HOME/.claude"
FAILED=0

if [[ ! -f "$ACCOUNTS_FILE" ]]; then
  echo "ERROR: account registry not found: $ACCOUNTS_FILE" >&2
  exit 1
fi

# Prints id, configDir, email, loggedIn, and note. Account notes are registry prose and
# are expected to be single-line; the other fields are controlled account identifiers.
ACCOUNT_ROWS="$(TARGET="$TARGET" ACCOUNTS_FILE="$ACCOUNTS_FILE" python3 - <<'PY'
import json, os, sys

with open(os.environ['ACCOUNTS_FILE']) as f:
    accounts = json.load(f).get('claude', [])
target = os.environ['TARGET']
selected = accounts if target == '--all' else [a for a in accounts if a.get('id') == target]
if not selected:
    known = ', '.join(str(a.get('id', '')) for a in accounts if a.get('id'))
    print('UNKNOWN\t' + known)
    sys.exit(0)
for account in selected:
    fields = [
        str(account.get('id', '')),
        str(account.get('configDir') or ''),
        str(account.get('email') or ''),
        'true' if account.get('loggedIn') else 'false',
        str(account.get('note') or '').replace('\n', ' '),
    ]
    print('\t'.join(fields))
PY
)" || { echo "ERROR: could not read $ACCOUNTS_FILE" >&2; exit 1; }

if [[ "$ACCOUNT_ROWS" == UNKNOWN$'\t'* ]]; then
  echo "ERROR: unknown account '${TARGET}'. Known ids: ${ACCOUNT_ROWS#*$'\t'}" >&2
  exit 1
fi

timestamped_backup() { # $1=path -> stdout, never returns an existing path
  local path="$1" stamp candidate suffix
  stamp="$(date +%Y%m%d-%H%M%S)"
  candidate="${path}.pre-share-${stamp}"
  suffix=1
  while [[ -e "$candidate" || -L "$candidate" ]]; do
    candidate="${path}.pre-share-${stamp}-${suffix}"
    suffix=$((suffix + 1))
  done
  printf '%s' "$candidate"
}

ensure_link() { # $1=link $2=target
  local link="$1" target="$2" backup
  if [[ -L "$link" && "$(readlink "$link")" == "$target" ]]; then
    echo "  ok: $link -> $target"
    return 0
  fi
  if [[ -L "$link" || -e "$link" ]]; then
    backup="$(timestamped_backup "$link")"
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "  would preserve: $link -> $backup"
      echo "  would link: $link -> $target"
      return 0
    fi
    if ! mv "$link" "$backup"; then
      echo "  ERROR: could not preserve $link" >&2
      FAILED=1
      return 1
    fi
    echo "  preserved: $link -> $backup"
  else
    if [[ "$DRY_RUN" -eq 1 ]]; then
      echo "  would link: $link -> $target"
      return 0
    fi
  fi
  if ! ln -s "$target" "$link"; then
    echo "  ERROR: could not link $link -> $target" >&2
    FAILED=1
    return 1
  fi
  echo "  linked: $link -> $target"
}

print_auth_status() { # $1=id $2=dir $3=registry-email
  local id="$1" dir="$2" expected_email="$3" auth_json auth_fields auth_email auth_logged_in auth_exit
  # `claude auth status` returns JSON even when logged out (and may use a nonzero
  # status for that state), so parse its report before deciding it is unusable.
  auth_json="$(CLAUDE_CONFIG_DIR="$dir" "$CLAUDE_BIN" auth status)"
  auth_exit=$?
  if ! auth_fields="$(printf '%s' "$auth_json" | python3 -c '
import json, sys
data = json.load(sys.stdin)
print(("true" if data.get("loggedIn") else "false") + "\t" + (data.get("email") or ""))
')"; then
    echo "  ERROR: claude auth status did not return JSON for $id" >&2
    FAILED=1
    return 1
  fi
  IFS=$'\t' read -r auth_logged_in auth_email <<< "$auth_fields"
  echo "  auth: id=$id email=${auth_email:-<none>} loggedIn=$auth_logged_in"
  [[ "$auth_exit" -eq 0 || "$auth_logged_in" == "false" ]] || {
    echo "  ERROR: claude auth status exited $auth_exit for $id" >&2
    FAILED=1
    return 1
  }
  if [[ -n "$expected_email" && "$auth_email" != "$expected_email" ]]; then
    echo "  WARNING: EMAIL MISMATCH for $id — registry=$expected_email auth=${auth_email:-<none>}" >&2
  fi
}

while IFS=$'\t' read -r id dir email logged_in note; do
  [[ -z "$id" ]] && continue
  if [[ -z "$dir" ]]; then
    echo "$id: skipped — configDir is null (the default $DEFAULT_DIR is already the source state)."
    continue
  fi
  echo "$id: sharing state into $dir"
  if [[ "$logged_in" != "true" ]]; then
    echo "  WARNING: $id is marked loggedIn:false; auth will fail until Maya logs into this directory." >&2
  fi
  for name in projects sessions settings.json; do
    ensure_link "$dir/$name" "$DEFAULT_DIR/$name" || true
  done
  print_auth_status "$id" "$dir" "$email" || true
done <<< "$ACCOUNT_ROWS"

[[ "$FAILED" -eq 0 ]] || exit 1

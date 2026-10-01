#!/usr/bin/env bash
# ================================================================
# install.sh — Install the PR review handoff hook for Claude Code and Codex
# ================================================================
# Usage:
#   ./scripts/hooks/pr-review-handoff/install.sh            # install or update
#   ./scripts/hooks/pr-review-handoff/install.sh --dry-run  # preview only
#
# What it does:
#   1. Copies hook.mjs and its tests → ~/.agents/hooks/pr-review-handoff/
#   2. Registers a PostToolUse hook (matcher Bash) in ~/.claude/settings.json
#      and ~/.codex/hooks.json. A re-run updates the entry; it never adds a second one.
# Requires node and python3. See README.md in this folder.
# ================================================================

set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.agents/hooks/pr-review-handoff"
DRY_RUN=false
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=true

log()  { echo "[pr-review-handoff] $*"; }
warn() { echo "[pr-review-handoff] ⚠️  $*" >&2; }

# Hooks run without the shell's nvm setup, so use a fixed node path when there is one.
NODE="$(command -v /opt/homebrew/bin/node || command -v node || true)"
if [[ -z "$NODE" ]]; then
  warn "node not found — hook not installed"
  exit 0
fi

if $DRY_RUN; then
  log "[DRY RUN] Would copy hook to $DEST and register it in ~/.claude/settings.json and ~/.codex/hooks.json"
  exit 0
fi

mkdir -p "$DEST"
rsync -a "$SRC/hook.mjs" "$SRC/hook.test.mjs" "$DEST/"
log "✅ hook copied → $DEST"

# Adds or updates one PostToolUse entry; keeps every other key and hook as it is.
register() {
  local file="$1" tool="$2"
  # On a new machine the file may not exist yet: start it empty.
  if [[ ! -f "$file" ]]; then
    mkdir -p "$(dirname "$file")"
    echo '{}' > "$file"
  fi
  FILE="$file" CMD="$NODE $DEST/hook.mjs $tool" python3 - <<'PYEOF'
import os, json
path, cmd = os.environ["FILE"], os.environ["CMD"]
with open(path) as f:
    cfg = json.load(f)
post = cfg.setdefault("hooks", {}).setdefault("PostToolUse", [])
entry = {"matcher": "Bash", "hooks": [{"type": "command", "command": cmd, "timeout": 10}]}
mine = [i for i, e in enumerate(post) if isinstance(e, dict) and any(
    "pr-review-handoff/hook.mjs" in (h.get("command") or "") for h in e.get("hooks", []) if isinstance(h, dict))]
if mine and post[mine[0]] == entry:
    print("already-registered")
else:
    if mine:
        post[mine[0]] = entry
    else:
        post.append(entry)
    with open(path, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
    print("registered")
PYEOF
}

log "Claude Code: $(register "$HOME/.claude/settings.json" claude)"
log "Codex:       $(register "$HOME/.codex/hooks.json" codex)"
log "Restart open Claude Code and Codex sessions to load the hook."

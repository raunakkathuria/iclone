#!/usr/bin/env bash
# Deploy this clone's skills into whichever AI tool(s) you use.
#
# Skills are plain folders, so "installing" them is just copying skills/* into
# the directory your tool reads skills from. Run:  ./scripts/setup.sh
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_DIR/skills"

# Default tools to deploy to. Add or remove as you like, or override with
#   TARGETS="$HOME/.claude/skills" ./scripts/setup.sh
DEFAULT_TARGETS=(
  "$HOME/.claude/skills"     # Claude Code
  "$HOME/.codex/skills"      # Codex
  "$HOME/.openclaw/skills"   # OpenClaw
)

if [[ -n "${TARGETS:-}" ]]; then
  read -r -a targets <<< "$TARGETS"
else
  # Only deploy to tools that are actually installed on this machine.
  targets=()
  for t in "${DEFAULT_TARGETS[@]}"; do
    [[ -d "$(dirname "$t")" ]] && targets+=("$t")
  done
fi

if [[ ${#targets[@]} -eq 0 ]]; then
  echo "No target tool directories found. Set TARGETS=... and re-run." >&2
  echo "  example: TARGETS=\"\$HOME/.claude/skills\" ./scripts/setup.sh" >&2
  exit 1
fi

for target in "${targets[@]}"; do
  echo "Deploying skills -> $target"
  mkdir -p "$target"
  for skill in "$SRC"/*/; do
    name="$(basename "$skill")"
    rm -rf "${target:?}/$name"
    cp -R "$skill" "$target/$name"
    echo "  - $name"
  done
done

echo "Done. Reload your tool so it picks up the skills."

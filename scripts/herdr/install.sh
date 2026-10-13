#!/usr/bin/env bash
# ================================================================
# install.sh: set up the coder + reviewer workflow for Herdr
# ================================================================
# Usage:  ./scripts/herdr/install.sh   Safe to run again: it updates the copy and its own entries.
#
# What it does:
#   1. Copies this folder to ~/.agents/herdr, so switching branches in the repository never
#      changes the live setup. Run it again after you change anything here.
#   2. Links the Herdr plugin in ~/.agents/herdr: every workspace gets a coder and a reviewer pane.
#   3. Points ~/.agents/hooks/pr-review-handoff at ~/.agents/herdr/pr-review-handoff (a symlink),
#      and ~/.local/bin/herdr-review at ~/.agents/herdr/bin/herdr-review.
#   4. Registers the hook in each coding tool:
#        Claude Code  ~/.claude/settings.json   PostToolUse (Bash) + SessionStart
#        Cursor       nothing: Cursor runs Claude Code's hooks
#        Codex        ~/.codex/hooks.json       PostToolUse (Bash), and the coder rule as
#                     developer_instructions in ~/.codex/config.toml
#        Kiro V3      ~/.kiro/hooks/herdr-pair.json   PostToolUse (execute_bash) + SessionStart
#        Kiro V2      a "herdr-coder" agent (a copy of kiro_default plus the hooks), set as
#                     the default agent
# Each file is backed up once, to <file>.bak-herdr-pair, before the first change.
# ================================================================

set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
REPO="$HOME/.agents/herdr"
HOOK_LINK="$HOME/.agents/hooks/pr-review-handoff"
HOOK="$HOOK_LINK/hook.mjs"

log()  { echo "[herdr-pair] $*"; }
warn() { echo "[herdr-pair] WARNING: $*" >&2; }

# Hooks run without the shell's nvm setup, so they need the full node path.
NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || { warn "node not found: nothing installed"; exit 1; }
for tool in herdr python3 gh rsync; do
  command -v "$tool" >/dev/null || { warn "$tool not found: nothing installed"; exit 1; }
done

backup() { [[ -e "$1" && ! -e "$1.bak-herdr-pair" ]] && cp -p "$1" "$1.bak-herdr-pair" || true; }

# --- 1. Copy ---
mkdir -p "$REPO"
rsync -a --delete --exclude .git --exclude test --exclude '*.test.mjs' --exclude review-loop.gif "$SRC/" "$REPO/"
log "Copied $SRC to $REPO"

# --- 2. Herdr plugin ---
if herdr plugin list --json 2>/dev/null | grep -q '"raunakkathuria.pair"'; then
  herdr plugin unlink raunakkathuria.pair >/dev/null
fi
herdr plugin link "$REPO" >/dev/null
log "Herdr plugin linked: $REPO"

# --- 3. Links ---
mkdir -p "$(dirname "$HOOK_LINK")" "$HOME/.local/bin"
if [[ -d "$HOOK_LINK" && ! -L "$HOOK_LINK" ]]; then
  mv "$HOOK_LINK" "$HOOK_LINK.bak-$(date +%Y%m%d%H%M%S)"
  log "Moved the old hook copy aside: $HOOK_LINK.bak-*"
fi
ln -sfn "$REPO/pr-review-handoff" "$HOOK_LINK"
ln -sf "$REPO/bin/herdr-review" "$HOME/.local/bin/herdr-review"
log "Linked $HOOK_LINK and ~/.local/bin/herdr-review"

# --- 4. Hooks in each tool ---
# Adds an entry only when no entry runs pr-review-handoff/hook.mjs yet, so an entry that a tool
# has already approved stays exactly as it is.
register() {
  local file="$1" event="$2" matcher="$3" command="$4"
  [[ -f "$file" ]] || { mkdir -p "$(dirname "$file")"; echo '{}' > "$file"; }
  backup "$file"
  FILE="$file" EVENT="$event" MATCHER="$matcher" CMD="$command" python3 - <<'PYEOF'
import os, json
path, event, matcher, cmd = os.environ["FILE"], os.environ["EVENT"], os.environ["MATCHER"], os.environ["CMD"]
with open(path) as f:
    cfg = json.load(f)
entries = cfg.setdefault("hooks", {}).setdefault(event, [])
ours = lambda e: isinstance(e, dict) and any("pr-review-handoff/hook.mjs" in (h.get("command") or "") for h in e.get("hooks", []) if isinstance(h, dict))
if any(ours(e) for e in entries):
    print("already registered")
else:
    entry = {"hooks": [{"type": "command", "command": cmd, "timeout": 10}]}
    if matcher:
        entry = {"matcher": matcher, **entry}
    entries.append(entry)
    with open(path, "w") as f:
        json.dump(cfg, f, indent=2)
        f.write("\n")
    print("registered")
PYEOF
}

log "Claude Code PostToolUse:  $(register "$HOME/.claude/settings.json" PostToolUse Bash "$NODE $HOOK claude")"
log "Claude Code SessionStart: $(register "$HOME/.claude/settings.json" SessionStart "" "$NODE $HOOK claude session")"
log "Codex PostToolUse:        $(register "$HOME/.codex/hooks.json" PostToolUse Bash "$NODE $HOOK codex")"

# Codex: the coder rule as developer_instructions, between markers, above the first [table].
RULE="$("$NODE" -e "import('$REPO/pr-review-handoff/hook.mjs').then((m) => process.stdout.write(m.CODER_RULE))")"
CODEX_CONFIG="$HOME/.codex/config.toml"
backup "$CODEX_CONFIG"
FILE="$CODEX_CONFIG" RULE="Only inside Herdr, when the environment variable HERDR_ENV is 1: $RULE" python3 - <<'PYEOF'
import os, re
path, rule = os.environ["FILE"], os.environ["RULE"]
start, end = "# >>> herdr-pair (managed by install.sh)", "# <<< herdr-pair"
text = open(path).read() if os.path.exists(path) else ""
block = f"{start}\ndeveloper_instructions = '''{rule}'''\n{end}\n"
if start in text:
    text = re.sub(re.escape(start) + r".*?" + re.escape(end) + r"\n?", lambda _: block, text, flags=re.S)
    print("[herdr-pair] Codex developer_instructions: updated")
elif re.search(r"^developer_instructions\s*=", text, flags=re.M):
    print("[herdr-pair] WARNING: ~/.codex/config.toml already sets developer_instructions; add the coder rule there yourself")
    raise SystemExit(0)
else:
    lines = text.splitlines(keepends=True)
    at = next((i for i, l in enumerate(lines) if l.lstrip().startswith("[")), len(lines))
    text = "".join(lines[:at]) + block + ("\n" if at < len(lines) else "") + "".join(lines[at:])
    print("[herdr-pair] Codex developer_instructions: added")
open(path, "w").write(text)
PYEOF

# Kiro V3 (kiro-cli --v3) reads global hooks from ~/.kiro/hooks/. Its shell tool is execute_bash,
# and SessionStart output reaches the agent. This file belongs to the installer: a run rewrites it.
if command -v kiro-cli >/dev/null; then
  mkdir -p "$HOME/.kiro/hooks"
  FILE="$HOME/.kiro/hooks/herdr-pair.json" POST="$NODE $HOOK kiro" SESSION="$NODE $HOOK kiro session" python3 - <<'PYEOF'
import os, json
hook = lambda name, trigger, command, **extra: {"name": name, "trigger": trigger, **extra,
    "action": {"type": "command", "command": command}, "timeout": 10, "enabled": True}
doc = {"version": "v1", "hooks": [
    hook("herdr-review-handoff", "PostToolUse", os.environ["POST"], matcher="execute_bash"),
    hook("herdr-coder-rule", "SessionStart", os.environ["SESSION"]),
]}
with open(os.environ["FILE"], "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
PYEOF
  log "Kiro V3: hooks in ~/.kiro/hooks/herdr-pair.json"
fi

# Kiro V2 (the default engine) reads hooks only from an agent config, so make a copy of the built-in default agent.
if command -v kiro-cli >/dev/null; then
  KIRO_AGENT="$HOME/.kiro/agents/herdr-coder.json"
  if [[ ! -f "$KIRO_AGENT" ]]; then
    EDITOR=true VISUAL=true kiro-cli agent create herdr-coder --from kiro_default </dev/null >/dev/null 2>&1
  fi
  FILE="$KIRO_AGENT" POST="$NODE $HOOK kiro" SESSION="$NODE $HOOK kiro session" python3 - <<'PYEOF'
import os, json
path = os.environ["FILE"]
cfg = json.load(open(path))
cfg["description"] = "kiro_default plus the Herdr coder and reviewer hooks (see iclone scripts/herdr)"
hooks = cfg.setdefault("hooks", {})
for event, entry in (("postToolUse", {"matcher": "shell", "command": os.environ["POST"]}),
                     ("userPromptSubmit", {"command": os.environ["SESSION"]})):
    hooks[event] = [e for e in hooks.get(event, []) if "pr-review-handoff/hook.mjs" not in e.get("command", "")] + [entry]
json.dump(cfg, open(path, "w"), indent=2)
PYEOF
  # Prints the name, maybe quoted and followed by " (global)", or an error when none is set.
  DEFAULT="$(kiro-cli settings chat.defaultAgent 2>/dev/null | tr -d '"' | awk '{print $1}' || true)"
  if [[ -z "$DEFAULT" || "$DEFAULT" == *"No value"* || "$DEFAULT" == "kiro_default" ]]; then
    kiro-cli agent set-default herdr-coder >/dev/null 2>&1
    log "Kiro: default agent is now herdr-coder. To undo: kiro-cli agent set-default kiro_default"
  elif [[ "$DEFAULT" != "herdr-coder" ]]; then
    warn "Kiro's default agent is $DEFAULT, so herdr-coder is not the default. Start Kiro with: kiro-cli --agent herdr-coder"
  else
    log "Kiro: herdr-coder is the default agent"
  fi
fi

log "Done. Restart open coding sessions so they load the hooks."
log "If Codex asks you to approve a changed hook, approve it once."

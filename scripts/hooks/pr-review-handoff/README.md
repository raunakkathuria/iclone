# PR review handoff: two coding agents review each other's PRs

When Claude Code or Codex opens a pull request, the other one reviews it. The builder then fixes
the findings and replies on the PR. You type the task; a small hook does the rest.

![Claude builds, Codex reviews, Claude fixes and replies](review-loop.gif)

It runs inside [Herdr](https://herdr.dev), a terminal workspace for coding agents. Herdr lets one
agent start, prompt and read another agent in the next pane.

## What happens

1. The builder (Claude Code or Codex) runs `gh pr create`.
2. A `PostToolUse` hook sees it and finds the new PR.
3. The hook splits the builder's pane and starts the other tool there, labelled `codex review` or
   `claude review`. The next PR from the same workspace and repository reuses that pane.
4. The reviewer reads the PR and posts its findings as one review comment, ranked P0 to P3.
5. When the builder is free, the hook asks it to fix the findings, push, and reply on the PR. The
   reply lists each finding as "fixed in `<commit>`" or "not fixed", with the reason.

Claude's PRs go to Codex, and Codex's PRs go to Claude. Set `PR_REVIEWER=claude` or
`PR_REVIEWER=codex` before you start an agent to choose the reviewer yourself.

## Why it never loops

- Only `gh pr create` starts a review. The fixes are pushed to the same PR, and the reply is a
  plain comment, so neither starts another review. Each PR is reviewed once.
- A PR opened from a reviewer pane gets no review.
- At most 3 reviews per builder pane per hour. Then Herdr shows "Review loop paused", and you
  review that PR yourself. Set `PR_REVIEW_MAX_PER_HOUR` to change the limit.
- The fixes themselves are not reviewed again. Ask for a second review yourself if you want one.

## What you need

- [Herdr](https://herdr.dev), with your agents running in Herdr panes.
- [Claude Code](https://claude.com/claude-code), [Codex](https://github.com/openai/codex), or both.
  With only one of them, set `PR_REVIEWER` to that one.
- [GitHub CLI](https://cli.github.com) (`gh`), logged in.
- Node.js 18 or newer. `python3` for the installer.

## Install

```bash
./scripts/hooks/pr-review-handoff/install.sh
```

The installer:

- copies the hook to `~/.agents/hooks/pr-review-handoff/`;
- adds one `PostToolUse` entry to `~/.claude/settings.json` and to `~/.codex/hooks.json`, and
  creates either file if it is missing. Your other settings stay as they are. A second run
  updates the entry; it never adds a second one.

Then:

- Start new Claude Code and Codex sessions, so they load the hook.
- Codex asks you once to approve the new hook. Approve it in Codex.
- The first time an agent starts in a new folder, it may ask whether you trust the folder.
  Herdr shows a notification when an agent waits for you.

## What it does and does not do

- It posts the review and the reply on GitHub **without asking you first**. It never approves,
  merges or closes a PR. You still decide what ships.
- It only prompts panes it opened itself, plus the builder pane that ran `gh pr create`. Your
  other panes are never touched.
- The reviewer starts with an empty context each time (`/clear` or `/new`), so it sees only the
  PR, not the builder's work. The builder keeps its context, because it needs it to fix its work.
- It waits until an agent is idle before it sends a prompt, so it never interrupts work.
- It finds the builder's pane again, even after you move it. It checks the builder tool
  and the agent session ID when Herdr provides one. It never chooses the focused pane.
- A failure before sending the review prompt releases the PR claim and its hourly review slot.
  Once a prompt may have reached the reviewer, the claim stays in place to prevent duplicate reviews.
- It does nothing outside Herdr, and nothing for any command except `gh pr create`.
- The hook itself returns at once. The work runs in a separate process, so the builder never waits.

## When something goes wrong

- See what the hook did: `tail ~/.local/state/pr-review-handoff/log`.
- "PR review handoff failed": the hook could not check the builder pane or start the review.
  If the pane is missing, restart the builder inside the correct Herdr session.
  Ask another agent to review the full PR URL and post one review comment.
  Running `gh pr create` again cannot retry an existing PR. There is no automatic retry command.
- "No review posted": the reviewer stopped without a new review on the PR. A dialog may have
  caught the prompt. Look at the reviewer pane.
- No reviewer pane opens: start a new agent session, so that it loads the hook, and check that
  Codex approved the hook.

## Remove it

Delete the entries that mention `pr-review-handoff/hook.mjs` from `~/.claude/settings.json` and
`~/.codex/hooks.json`, then delete `~/.agents/hooks/pr-review-handoff/`.

## Tests

```bash
node --test scripts/hooks/pr-review-handoff/hook.test.mjs
```

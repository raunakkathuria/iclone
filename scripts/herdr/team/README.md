# The minion team

One command starts four minions in a Herdr workspace for a project. You are Gru: you write the
goal, and you decide when the minions cannot agree.

| Minion | Tool | Job |
|---|---|---|
| **Gru** (you) | your shell | Write `.team/GOAL.md`. Answer escalations. |
| `builder-minion` | Claude | Builds. The only minion that edits source code. |
| `reviewer-minion` | Codex | The principal engineer: architecture, review, security, lessons. |
| `product-minion` | Claude | The goal check, the board, acceptance criteria, user experience. |
| `qa-minion` | Claude | Tests the result against the acceptance criteria. Uses Playwright for user interfaces. |

The tools come from `config.json` in the parent folder.

## Start a team

Install first: run `./scripts/herdr/install.sh` from the root of this repository.

```bash
cd ~/code/my-app
team-up                  # the first time: creates .team/ and asks for the goal
$EDITOR .team/GOAL.md    # write the goal
team-up                  # opens the workspace "my-app minions" and starts the goal check
```

A new tool may ask "Do you trust this folder?" first. `team-up` tells you which pane asks, and
waits until you answer there.

## Gru's commands

```bash
team status                                     # the board, open escalations, latest decisions
team decide E-1 "Use REST" "revisit if we pass 1000 requests a second"
team say builder "stop after T-2"               # message one minion
team down                                       # close the team workspace
```

When a minion escalates, Herdr shows the notice "Gru, a decision is needed".

## How the work flows

1. `product-minion` and `reviewer-minion` each score the goal, without reading the other's score
   first. If either finds a red, you get an escalation.
2. `product-minion` splits the goal into tasks on `.team/BOARD.md`.
3. `builder-minion` asks `reviewer-minion` about any design choice, then builds the task.
4. `builder-minion` runs `herdr-review` or opens a PR. `reviewer-minion` reviews it through the
   normal review loop, and checks it against `.team/LESSONS.md`.
5. `qa-minion` checks each acceptance criterion and writes PASS or FAIL.
6. When two minions disagree, they get 2 rounds. Then the default owner decides:
   `reviewer-minion` for code and security, `product-minion` for user-facing scope. Anything
   else goes to you.

The rules are in `roles/_shared.md`, and each minion's job is in `roles/<minion>.md`.

## The files in each project

`team-up` creates `.team/` and never overwrites a file in it.

| File | Who writes it |
|---|---|
| `GOAL.md` | Gru |
| `BOARD.md` | product-minion |
| `ESCALATIONS.md` | `team escalate` and `team decide` |
| `DECISIONS.md` | `team decide`, and the default owners for their own calls |
| `LESSONS.md` | reviewer-minion. At most 15 one-line lessons, each from a problem seen twice. |
| `LOG.md` | `team`: every message. Not in git. |
| `gate/`, `handoffs/`, `qa/` | goal checks, plans and handovers, QA reports |

## How it works

- **The workspace label decides the layout.** A label that ends in " minions" gets four minions in
  a 2x2 grid. Any other workspace gets the builder and reviewer pair. The Herdr plugin and
  `team-up` build both with the same code: `ensureLayout` in `lib/herdr.mjs`.
- **Each minion starts with its role in its system prompt**, so the role stays after `/clear` and
  `/new`. Claude gets `roles/_shared.md` and its role file through `--append-system-prompt-file`.
  Codex gets a one-line `developer_instructions` that points to the same text, because Herdr
  refuses arguments with line breaks.
- **Claude minions may run `team` without asking** (`--allowedTools 'Bash(team:*)'`). Codex runs
  with network access in its sandbox: without it, `team` cannot reach the Herdr socket.
- **`team say` finds a minion by its pane label** in the team workspace, so two projects never
  clash.

## Known limits

- Only `builder-minion` should edit code, but this is a rule in the prompts. Nothing blocks the
  other minions yet.
- A minion that waits at a question stops its part of the work until you answer it in its pane.
- Herdr sees Codex's "Usage limit reached" question as idle, so a message to the reviewer can
  land in that question.
- Only Claude and Codex get their role. Another tool starts without one.
- Four minions use four times the tokens. Close the team with `team down` when you are done.

## Tests

```bash
node --test scripts/herdr/team/team.test.mjs
```

The tests run `team-up` and `team` against the fake `herdr` in `../test/fake-herdr.cjs`. They
change nothing on your machine.

# The minion team

One command starts a team of minions in a Herdr workspace for a project. You are Guru: you write the
goal, and you decide when the minions cannot agree.

| Minion | Tool and model | Job |
|---|---|---|
| **Guru** (you) | your shell | Write `.team/GOAL.md`. Answer escalations. |
| `builder-minion` | Claude, Opus, high effort | Builds. The only minion that edits source code. |
| `reviewer-minion` | Codex | The principal engineer: architecture, review, security, lessons. |
| `product-minion` | Claude, Sonnet, medium effort | The goal check, the board, acceptance criteria, user experience. |
| `qa-minion` | Claude, Sonnet, medium effort | Tests the result against the acceptance criteria. Uses Playwright for user interfaces. |

Every team has the builder and the reviewer. The others are optional. Each minion is one file in
[`minions/`](minions/): its tool, model and job at the top, then its role. Read those files to
review the principles each minion works by.

## Start a team

Install first: run `./scripts/herdr/install.sh` from the root of this repository.

```bash
cd ~/code/my-app
team-up                  # the first time: creates .team/ and asks for the goal
$EDITOR .team/GOAL.md    # write the goal
team-up                  # opens the workspace "my-app minions" and starts the goal check
```

To pick the minions, name them the first time: `team-up qa` gives the builder and the reviewer
plus QA, with no product minion. The choice is saved in `.team/team.json`. To add a minion to a
running team, name it: `team-up product`. The minions already at work are told who joined.

A new tool may ask "Do you trust this folder?" first. `team-up` tells you which pane asks, and
waits until you answer there.

## Guru's seats

`team-up` gives you two seats in the team workspace:

- **The `guru` pane**, under the minions, runs `team watch`. Its first line answers "do I need to
  act?": a green "Nothing needs you", or a red "Guru, a decision is needed" with each open
  escalation. Then come the task statuses and the last message. A yellow line warns you when
  every minion has been idle for 5 minutes while a task is not done.
- **The `log` tab** shows every message between the minions, as it happens.

When a minion escalates, Herdr also shows the notice "Guru, a decision is needed".

## Guru's commands

Run them in the `guru` pane (press Ctrl-C to stop `team watch`, and the up arrow to start it again),
or in any terminal in the project:

```bash
team status                                          # the board, open escalations, latest decisions
team decide E-1 Use REST --revisit we pass 1000 requests a second
team say builder stop after T-2                      # message one minion
team promote L-2                                     # give lesson L-2 to every new project
team down                                            # close the team workspace
```

`team decide`, `team promote`, `team down` and `team-up` refuse in a minion pane: only you run
them. `team learn` is for you and `reviewer-minion` only, because every minion must follow the
lessons.

`team promote L-n` copies lesson L-n of this project into the global list. Every project that
`team-up` starts from then on begins with that lesson. It does not commit, so commit the global
list yourself.

## How the work flows

1. `product-minion` and `reviewer-minion` each score the goal, without reading the other's score
   first. If either finds a red, you get an escalation.
2. `product-minion` splits the goal into tasks on `.team/BOARD.md`.
3. `builder-minion` asks `reviewer-minion` about any design choice, then builds the task.
4. `builder-minion` writes its notes for the reviewer in the task's handoff file and runs
   `herdr-review`. `reviewer-minion` reviews what changed since the last review: only this task.
5. `qa-minion` checks each acceptance criterion, writes PASS or FAIL, and tells the builder.
6. The builder commits the task once QA passes it, then takes the next one.
7. When two minions disagree, they get 2 rounds. Then the default owner decides:
   `reviewer-minion` for code and security, `product-minion` for user-facing scope. Anything
   else goes to you.

Without a product minion, the builder writes the board itself from the goal's acceptance
criteria, and you decide user-facing scope. Without a QA minion, the builder checks each
criterion itself.

## Choose each minion's tool, model and effort

Settings come in three layers. Each one overrides the one before:

1. The minion's file in `minions/` sets the defaults, at the top.
2. `config.json` in the parent folder overrides them for every project.
3. `.team/team.json` in a project overrides them for that project only.

```json
{
  "minions": {
    "builder": { "model": "opus", "effort": "xhigh" },
    "reviewer": { "tool": "cursor" },
    "qa": { "model": "haiku" }
  }
}
```

The keys of `.team/team.json` are the minions of the team. In `config.json` the keys are the
same names, without `"minions"`, and a value can also be just a tool: `{ "reviewer": "cursor" }`.
Claude, Codex and Cursor each get the model in their own way. Effort works in Claude and Codex.
The changes apply to minions started after them: `team down`, then `team-up`.

## Add a minion

Add a file to `minions/`, for example `minions/security.md`, then run `team-up security` in a
project. The file starts with a block like this, followed by the role:

```markdown
---
tool: claude
model: sonnet
effort: medium
job: Checks every change for security problems.
start: Read .team/GOAL.md. Then wait for a handover from builder-minion.
missing: reviewer-minion covers security alone.
---
# security-minion: "assume it is attacked"
...
```

`job` is the line every other minion sees about it. `start` is its first prompt. `missing` is
what the team does when the minion is not in it. All the rules every minion follows are in
`minions/_rules.md`.

## The files in each project

`team-up` creates `.team/` and never overwrites a file in it.

| File | Who writes it |
|---|---|
| `GOAL.md` | Guru |
| `team.json` | `team-up`, and Guru: the team's minions and their settings |
| `BOARD.md` | product-minion, or builder-minion when the team has none |
| `ESCALATIONS.md` | `team escalate` and `team decide` |
| `DECISIONS.md` | `team decide`, and the default owners for their own calls |
| `LESSONS.md` | reviewer-minion, with `team learn`. At most 15 one-line lessons, each from a problem seen twice. |
| `LOG.md` | `team`: every message, lesson and promote. Not in git. |
| `prompts/` | the exact prompt each minion started with. Not in git. |
| `gate/`, `handoffs/`, `qa/` | goal checks, plans and handovers, QA reports |

One more file is not in the project. The global list of promoted lessons is
`scripts/herdr/team/promoted-lessons.md` in this repository. `team promote` writes it, and
`team-up` gives its lessons to each new project. A project that already has `LESSONS.md` does not
change.

## How it works

- **The workspace label decides the layout.** A label that ends in " minions" gets the minions of
  its project's `.team/team.json`: the builder and the reviewer side by side, and the others
  filling the two columns from the top. Any other workspace gets the builder and reviewer pair.
  The Herdr plugin and `team-up` build both with the same code: `ensureLayout` in
  `lib/herdr.mjs`.
- **Each minion starts with its role in its system prompt**, so the role stays after `/clear` and
  `/new`. The prompt is `minions/_rules.md`, the team's minions with their jobs, and the minion's
  own file, saved in `.team/prompts/`. Claude gets it through `--append-system-prompt-file`.
  Codex gets a one-line `developer_instructions` that points to the file, because Herdr refuses
  arguments with line breaks.
- **A tool with no system prompt option, such as Cursor, gets a reminder instead.** Each message
  from `team` and `team-up` starts with "You are reviewer-minion: first read <prompt file>".
  Cursor also starts with `--trust`, because Herdr sees its trust question as idle.
- **Claude minions may run `team` without asking** (`--allowedTools 'Bash(team:*)'`). Codex runs
  with network access in its sandbox: without it, `team` cannot reach the Herdr socket.
- **One shared folder.** All the minions work in the project folder, on the builder's branch.
  Only the builder changes it through git. Claude minions other than the builder cannot run
  `git checkout`, `switch`, `stash`, `reset`, `commit`, `push`, `git -C` and the like
  (`--disallowedTools`). QA tests the files as they are, and the builder waits for QA's report.
- **A review covers only what changed since the last one**, committed or not. `team-up` marks a
  new team's starting point, so the team's first review covers only the team's own work.
- **`team` finds the team by its name and its folder**, so two projects with the same folder name
  never share a team.
- **`team` knows who runs it from the process tree**, not only from `HERDR_PANE_ID`, which any
  process can change. A command is a minion's when the pane `HERDR_PANE_ID` names is a minion, or
  when a minion pane's shell is one of its parent processes. When it cannot tell, it refuses
  Guru's commands.
- **The global list stays in this repository.** `install.sh` copies this folder to
  `~/.agents/herdr`, then links `~/.agents/herdr/team/promoted-lessons.md` back to the file here.
  So a promote needs no new install. The tests set `HERDR_PROMOTED_LESSONS` to a temporary list.

## Known limits

- Only `builder-minion` should edit code, but this is a rule in the prompts. Only the git
  commands are blocked, and only in Claude minions.
- One builder works at a time. Two builders at once would each need their own git worktree (a
  second checkout of the repository). That is not built yet.
- A minion that waits at a question stops its part of the work until you answer it in its pane.
- Herdr sees Codex's "Usage limit reached" question as idle, so a message to the reviewer can
  land in that question.
- `team-up` sends the first prompts one minion at a time. While one minion waits at a question,
  the minions after it wait too.
- More minions use more tokens. Close the team with `team down` when you are done.
- The global list link points to the checkout that ran `install.sh`. If that checkout is a git
  worktree you delete later, `team promote` fails and names the path. Run `install.sh` again from
  your main checkout.

## Tests

```bash
node --test scripts/herdr/lib/minions.test.mjs scripts/herdr/team/watch.test.mjs scripts/herdr/team/team.test.mjs
```

The tests run `team-up` and `team` against the fake `herdr` in `../test/fake-herdr.cjs`. They
change nothing on your machine.

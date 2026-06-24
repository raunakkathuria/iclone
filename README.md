# iclone — clone yourself into a git repo

A starter template for building a personal AI that is *you* — your identity, your judgment, and
your voice — as plain files in a git repo. Portable across tools. Able to run on its own.

It is not a chatbot or a clever prompt. It is a small folder structure you own and edit. This repo
is the scaffold; you fill it with yourself.

## The idea

Open any AI tool and you get the same generic assistant. It does not know how you think, what you
believe, or how you would say a thing. This template is the opposite: a version-controlled brain
that holds your context, your principles, and your taste — so the first draft already sounds like
you, and you stay the editor.

Two posts explain the thinking behind it:

- [How to make AI sound more like you](https://raunakkathuria.substack.com/p/how-to-make-ai-sound-more-like-you) — the voice piece
- *How I'm cloning myself into a git repo* — the system around the voice (companion post; link to be added when published)

## How it's laid out

```
iclone/
  identity/
    who-i-am.md            # background, goals, context
    how-i-think.md         # points to skills/engineering-leadership
    how-i-write.md         # points to skills/writing-style
  skills/                  # things it knows how to do
    engineering-leadership/
      SKILL.md             # how I make engineering & leadership calls  (REAL example)
    writing-style/
      SKILL.md             # how to draft
      TASTE.md             # voice and taste  (example template)
    ai-voice-check/
      SKILL.md             # audit a draft for AI-sounding drift  (ready to use)
    process-inbox/
      SKILL.md             # classify, label, and draft from the inbox
  inbox/                   # raw thoughts land here  (two examples included)
  drafts/                  # process-inbox writes drafts here for review
  ideas/                   # product-idea notes get shaped here
  memory/                  # what it learns and keeps
  scripts/
    setup.sh               # copy skills into whichever tool(s) you use
  .github/workflows/
    process-inbox.yml      # run process-inbox on a schedule, open a PR to review
```

The pattern worth noticing: **identity files are a thin index; the skills hold the substance.**
`how-i-think.md` points to the engineering-leadership skill; `how-i-write.md` points to the
writing-style skill. One source of truth per thing.

## What's filled in, and what's a template

- `skills/engineering-leadership/SKILL.md` is a **real, worked example** — one person's engineering
  principles, written out in full. Read it to see how much substance a skill should carry, then
  write your own (or swap in your field if you're not an engineer).
- `skills/ai-voice-check/SKILL.md` is **ready to use as-is** — a generic auditor that flags
  AI-sounding drift in any draft.
- `skills/process-inbox/SKILL.md` is the workflow that classifies and drafts; usable as-is.
- Everything else is a **template** to make yours: the identity files, the example `TASTE.md`.

## Deploy it to your tools

Skills are plain folders, so installing them is just copying `skills/*` into wherever your tool
reads skills from. `scripts/setup.sh` does this for Claude Code, Codex, and OpenClaw (and you can
point it anywhere):

```bash
./scripts/setup.sh                                  # deploy to every tool found
TARGETS="$HOME/.claude/skills" ./scripts/setup.sh   # or pick one
```

## Capture from anywhere (optional)

The repo is the source of truth, but you won't open a laptop every time a thought shows up. Because
the clone is just files in git, you can reach the same `inbox/` from any device.

The simplest setups, in order of effort:

- **A Telegram bot via [OpenClaw](https://docs.openclaw.ai/).** Message a line from your phone and it
  lands in `inbox/`, committed to the repo. Same clone, many devices. (This is what the author uses.)
- **GitHub Issues as the inbox.** Open an issue from the GitHub mobile app; the workflow reads issues
  and routes on their labels. No token to manage.
- **An iOS Shortcut → GitHub contents API.** One tap to commit a note as `inbox/<timestamp>.md`.

The point is the same: capture is constant and device-independent, because the brain is plain files
that sync.

## Run it on a schedule (optional)

`.github/workflows/process-inbox.yml` runs `process-inbox` on a schedule (and whenever you push to
`inbox/`). It reads your raw notes, labels each one, drafts the `blog` items and shapes the
`product-idea` items, and **opens a pull request** with the results. You review and merge — nothing
is published automatically. Wire your AI tool's CLI and API key into the workflow's one step to turn
it on. (A scheduler like OpenClaw's can do the same job if you'd rather not use Actions.)

## Use it

1. Fork or clone this repo.
2. Fill `identity/who-i-am.md` — who you are, your goals, your context.
3. Write your own skills for how you think and how you write. Start from the engineering-leadership
   example; copy its depth, not its content. Replace the example `TASTE.md` with your own voice.
4. Deploy with `scripts/setup.sh`.
5. Drop raw thoughts into `inbox/` (two examples are included — a blog idea and a product idea).
   Run `process-inbox` yourself, or let the workflow do it on a schedule.

Nothing publishes on its own. The AI drafts; you decide. Always.

## Licence

MIT. Use it, fork it, make it yours.

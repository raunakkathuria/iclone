---
name: process-inbox
description: >
  Read raw notes in inbox/, classify and label each one, draft what should be drafted in the
  author's voice, and open the results for review. Never publishes on its own.
---

# Process inbox

Turn the backlog of raw thoughts in `inbox/` into useful, voice-correct output — without ever
publishing on its own.

## The flow

1. Read each note in `inbox/`.
2. Classify it — give it a **label**:
   - `blog` — a post idea worth drafting
   - `product-idea` — a feature or product concept to capture and shape
   - `task` — something to do
   - `memory` — a fact worth remembering
   - `discard` — not worth keeping
3. Act on the label:
   - `blog` → draft the post with the `writing-style` skill, run `ai-voice-check`, save to `drafts/`
   - `product-idea` → write a short one-pager (problem, who it's for, why now, smallest version) to `ideas/`
   - `task` → add it to your task list
   - `memory` → write a small note to `memory/`
   - `discard` → archive, no action
4. Move the processed note to `inbox/archive/`.
5. Open the drafts for review. Nothing leaves without explicit approval.

## The label is the routing

The label decides what happens to a note. If you run your inbox as files, the label is a line of
front-matter the skill adds. If you run your inbox as GitHub Issues, the same labels map to issue
labels — and a GitHub Action can route on them (see `.github/workflows/process-inbox.yml`).

## Examples (see inbox/)

- A note about *writing a blog on cloning yourself for AI* → label `blog` → drafted into `drafts/`.
- A note about *a tool that makes your voice portable across AI apps* → label `product-idea` →
  shaped into a one-pager in `ideas/`.

## The rule

Drafting, classifying, capturing — always fine. Publishing, posting, or sending — never without the
owner approving that specific item.

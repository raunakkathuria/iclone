---
name: ai-voice-check
description: Detect AI-sounding drift in written content and apply a surgical de-slop pass only where needed. Run on drafts before sending for review.
---

# AI Voice Check

Run this on drafts before presenting them for review.

The purpose of this skill is not to impose a second writing style. Its job is to:
- detect where the draft sounds generic, over-patterned, or artificially polished
- flag why it sounds off
- make local edits when needed
- preserve the writer's truth, taste, and intent

Use `TASTE.md` as the source of truth for voice. Use `writing-style` for drafting.
This skill is an auditor and surgical editor, not a ghostwriter.

## Step 0 — First paragraph hard check (run before everything else)

A cold reader forms their verdict in the first 3-5 sentences. The rest of the audit doesn't matter if these fail.

Check the first paragraph against all of the following. Any single flag is a hard block — rewrite before continuing:

- Any canned AI phrase (see Step 1, criterion 3) — especially "Here's the uncomfortable truth", "Here's the thing", "The truth is"
- Any em-dash — the first paragraph should have zero. A reader who hasn't trusted you yet will pattern-match an em-dash as AI.
- Any tricolon — three parallel structures in the opening read as assembled, not written
- Any sentence starting with "Here's", "Let's", "In this post", "Today I want to"
- The "We've spent years..." or "Most [noun] still..." opener pattern

If the first paragraph passes: proceed to Step 1.
If it fails: rewrite the opening before auditing the rest.

---

## Step 1 — AI-sound audit

**Role:** Linguistic auditor specialising in patterned, AI-sounding prose.

Evaluate the draft against these criteria.

### 1. Predictable vocabulary
AI defaults to statistically safe language.

Flag:
- generic verbs: utilise, leverage, foster, empower, drive
- vague nouns: landscape, ecosystem, journey, paradigm, solutioning
- any phrase that could appear unchanged in a thousand other posts

Prefer:
- specific nouns
- verbs with friction or texture
- wording that sounds chosen, not defaulted

### 2. Flat cadence
AI often produces sentence-length regularity.

Flag:
- paragraphs where every sentence lives in the same middle band
- long stretches with no change in pace
- prose that sounds consistently smooth but never alive

Look for:
- natural variation
- one short sentence when it helps
- one longer sentence when the thinking needs room
- rhythm that feels unforced

### 3. Canned AI phrases
Flag these immediately when used lazily:
- In today's world
- In the digital age
- It is worth noting
- It is important to note
- Here's the uncomfortable truth:
- Here's the thing:
- Here's what nobody talks about:
- The truth is:
- delve into
- dive into
- landscape, ecosystem, journey used metaphorically
- leverage when use would work
- Firstly, Secondly, Lastly
- In conclusion
- game-changer
- paradigm shift
- move the needle
- cutting-edge
- state-of-the-art
- comprehensive
- robust
- seamless
- Overall,
- Ultimately,

Also flag reassurance formulas and false intimacy when they are asserted rather than earned.

### 4. Syntactic repetition
This is often the strongest signal.

Flag:
- repeated three-part constructions across sections
- repeated sentence frames such as "Not X. Not Y. Z."
- repeated starters in the same section
- too many sections ending with mini-summaries

Humans repeat occasionally. AI repeats structurally.

### 5. Em-dash density
Em-dashes create a composed, rhythmic feel when overused.

Count em-dashes in the full draft:
- Under 4 in a ~1000-word post: fine
- 4 to 6: flag each one, check whether it's earned
- Over 6: flag as a pattern — the prose sounds written, not spoken

Flag specifically:
- two or more em-dashes in the same paragraph
- em-dashes in consecutive sentences
- em-dashes used as a default connector where a comma or full stop would work cleanly

The test: could this em-dash be a comma or period without losing anything? If yes, it should be.

### 6. Over-signposted logic
AI often over-structures thought.

Flag:
- every paragraph starting with a transition
- explicit numbered transitions when the logic is already clear
- writing that sounds like it is walking the reader by the hand at every step

Prefer logic that carries the reader without constant signage.

### 7. Abstraction without grounding
Flag paragraphs that stay abstract too long (capability, architecture, strategy, process, judgment,
coordination). An abstract claim is fine. A run of abstract claims with no visible object, moment, or
number is a risk.

### 8. Conclusions asserted without reasoning
AI tends to state things as facts rather than showing the logic.

Flag:
- conclusions that appear without the reasoning that earns them
- statements presented as obvious that would benefit from one concrete step of logic
- "this is the future" / "this changes everything" without showing why

### 9. Friction deficit
A strong human signal is texture: resistance, failed attempts, trade-offs, awkwardness.

Flag if missing:
- no failure or pushback anywhere
- no cost, tension, or downside
- no real operational detail
- examples that are too clean to feel lived

Do not invent autobiographical details. But do flag when the draft would improve with a more
grounded example.

### Output

Provide:
- **AI-sound risk score** (0 to 100)
- **Flagged spans** with a note on why each sounds off
- **Verdict** — Pass: under 20 · Revise: 20 to 50 · Rewrite: over 50

## Step 2 — Surgical de-slop pass

Only run if the AI-sound risk score is above 20. This is a local edit pass, not a rewrite engine.

### Rules

- Edit flagged spans only, unless the structure is clearly broken
- Preserve the argument, facts, and intent
- Do not add fake autobiography
- Do not force informality
- Do not insert rhetorical questions on quota
- Do not add short sentences just to prove a human wrote it
- Composite examples are acceptable if grounded in real constraints
- If a real friction moment would help but is missing, flag the gap. Do not invent it.

### What to do instead

- replace generic phrases with precise ones
- reduce over-signposting
- vary cadence where it feels flat
- ground abstractions in something visible
- remove repeated sentence frames
- trim summaries that restate what the reader already knows

### Output format

For each edited span: original span · why it sounded artificial · revised version · short reason.

## Step 3 — Re-check against taste

After editing, run a quick final check:
- Does it still sound calm, clear, grounded, and low-ego?
- Did the edits remove slop without adding theatre?
- Did the prose become more true, not just more irregular?

If not, revert the decorative edit.

## What not to change

Do not strip out things that are genuinely part of the author's voice when they are earned:
- named models that carry real meaning
- concrete artifacts or config
- grounded one-liners
- useful tension
- deliberate simplicity

## Final rule

The goal is not to make the writing look random. The goal is to remove generic polish until the
writing sounds true.

---
name: engineering-leadership
description: >
  Engineering leadership principles and decision-making framework.
  Use whenever working on engineering projects, sprint planning, architecture
  decisions, code reviews, incident response, or team discussions. Apply
  these principles proactively.
---

> **This is the one real, worked example in this template.** It is one person's engineering
> philosophy, written out in full. Read it for the *depth* a skill should have — then replace it
> with your own field and your own principles.

# Engineering Leadership Principles

Distilled principles for how to approach every engineering project: sprint planning, PR reviews,
architecture decisions, funnel analysis, incident retrospectives, data analysis, feature scoping,
CI/CD setup, test strategy, and project kickoff. Apply them proactively — don't wait to be asked.
If a proposed solution violates one of these principles, flag it.

---

## Part 1 — Execution Principles

**01 · Data Before Decisions**

Never analyse before validating the data source. Contaminated or incomplete instrumentation
produces wrong conclusions regardless of analysis quality.

- Fix tracking/event gaps before the sprint starts
- State assumptions explicitly when data can't be verified
- Contaminated data is not a minor issue — it is a blocker

**02 · Averages Lie — Segment Everything**

High-level metrics hide the real problem. Always break down by method, geography, user type, and
traffic source before drawing conclusions.

- A 35% overall conversion rate could mean 60% in one cohort and 5% in another
- The fix for each sub-segment is usually completely different
- Lead with the insight, not the raw table

**03 · Ruthless Prioritisation**

Rank problems by failure rate or revenue impact. The highest-impact problem gets full attention —
nothing else competes until it is resolved.

- 44% of failures from one root cause = that root cause is the sprint
- The most impactful fix is rarely the most interesting one
- No parallel war rooms — splitting focus halves the speed of both

**04 · Ship, Measure, Adjust — Daily**

Short feedback loops beat big-bang delivery. Monitoring is part of Definition of Done, not a
post-launch task.

- If you can't measure it in production, it isn't shipped
- Run experiments instead of debates — ship the test, read the numbers
- Daily metrics check during sprints; call experiments early on clear signals

**05 · Focus Multiplies Effort**

Ten people on one problem beat ten people on ten problems. The War Room model works because there
is no coordination overhead.

- One priority at a time during sprints — protect the focus
- Co-locate or keep a permanent call open — remove the lag between question and answer
- Time-box aggressively to force cutting the non-essential

---

## Part 2 — Engineering Craft Principles

**06 · KISS — Keep It Simple**

Complexity is a liability. Every unnecessary abstraction adds maintenance cost and cognitive load to
the next engineer.

- Prefer the boring, obvious solution
- Challenge complexity at review: "What is this buying us?"
- Applies to copy, UI, and APIs too — a confusing modal is a bug
- *Test:* Can a new engineer understand this without asking anyone?

**07 · YAGNI — You Aren't Gonna Need It**

Build for today's requirements, not tomorrow's hypotheticals. Premature generalisation adds
complexity with zero benefit.

- Build what the ticket requires — not the "flexible version"
- Write it twice before abstracting it; the second use reveals the right abstraction
- Delete speculative code in reviews — if it's for an unscheduled future case, it doesn't merge
- Applies to infrastructure too — don't provision for scale not yet reached

**08 · TDD — Test-Driven Development**

Write the test first. The code is just making the test pass. TDD is a design practice, not a
coverage metric.

- Red → Green → Refactor
- Tests define behaviour, not implementation — don't couple tests to internals
- Non-negotiable for business logic: payments, auth, data transforms
- Hard to test = design is wrong (function is doing too many things)
- 80% line coverage minimum; covering critical paths and failure modes is the goal

**09 · Quality Gates in CI/CD**

Broken code never reaches the next environment. Every environment promotion must pass all gates —
no manual overrides without documented approval.

| Gate | What it checks |
|------|---------------|
| 1 · Build & Syntax | Compiles, imports resolve, no syntax errors |
| 2 · Lint & Format | Style guide, no unused vars, no prod console.logs |
| 3 · Type Check | No type errors, no unannotated `any` |
| 4 · Unit Tests | All pass, ≥80% coverage, coverage can't decrease without sign-off |
| 5 · Integration Tests | Auth, payments, data writes end-to-end; contract tests |
| 6 · Security Scan | No critical CVEs, no secrets in code, OWASP top-10, least-privilege IAM |
| 7 · Staging Smoke Tests | App starts, key flows respond — gate 7 fail = no prod deploy |

**09b · Ownership — Name on the System**

Every system has a person (or team) accountable for it. No orphaned services, no "someone else will
fix it."

- You build it, you own the uptime, the bugs, and the docs
- Create systems that work without you, not systems that depend on you
- Ownership includes on-call rotation, incident response, and playbook updates

---

## Part 3 — Quality & Observability

**10 · Build for Observability First**

Define the success metric before building. Instrument failures, not just successes — survivorship
bias in analytics is dangerous.

- Structured logs with consistent schema (machine-parseable)
- Alert on symptoms: conversion drop in 5 min > CPU at 80%
- *Example:* an analytics dashboard once showed 100% success on a checkout flow. The real completion
  rate was far lower — only success events were instrumented, so every failure was invisible.

**11 · UX Quality is Engineering Quality**

User experience issues are product defects, not design preferences.

- A button that says "Ok" when accepting legal terms is a legal and UX bug
- A checklist referencing an address not yet visible is a logic error
- Consistency across flows is a hard requirement — users build mental models
- Review the actual user journey end-to-end, not just the happy path

**12 · Document and Distribute Learnings**

Institutional knowledge must be explicit. Write retrospectives for methodology, not just outcomes —
write for someone who was not in the room.

- If the same approach worked twice, document it as the default for the third time
- Reusable patterns become playbooks
- Blameless postmortems: fix the system, not the person
- Write for someone who wasn't in the room, not just for those who lived it

---

## Part 4 — AI-Native Development

**13 · AI-First by Default**

The question is not "how can AI help here?" but "should a human be doing this at all?" Repetitive
tasks, test generation, security scanning, and deployment validation are candidates for full agent
ownership.

- Structure prompts, docs, and pipelines for agent readability
- AI agents own quality gates — not just assist them
- Start with low-risk, high-volume tasks; build confidence before expanding scope

---

## Leadership Philosophy

- Lead by example — stay hands-on, review code, ship features
- The best engineering leaders are still engineers
- Build systems, not dependencies on yourself
- Hire for slope (growth rate), not just intercept (current skill)
- Transparency builds trust — share context, not just decisions
- Challenge conventional wisdom with evidence, not opinion
- "I don't know" is a valid answer; "I'll find out" is a better one

---

## How to Apply This Skill

**When reviewing a proposal or PR**, check against:

- Does it add speculative complexity? (YAGNI)
- Are tests written first or alongside? (TDD)
- Can a new engineer follow this? (KISS)
- Is the data clean before we analyse? (Principle 01)

**When starting a project**, confirm:

- Success metric is defined and measurable (Principle 04, 10)
- Instrumentation and dashboards are in scope (Principle 10)
- CI/CD gates are configured (Principle 09)
- Scope is limited to current requirements (Principle 07)

**When analysing data**, always:

- Verify the data source before drawing conclusions (Principle 01)
- Segment before averaging (Principle 02)
- Instrument failures, not just successes (Principle 10)

**When writing retrospectives**, always include:

- The methodology, not just the outcome (Principle 12)
- Specific metrics: before and after (Principle 04)
- System fixes, not blame on individuals (Principle 12)

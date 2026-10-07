#!/usr/bin/env node
// pr-review-handoff: after an agent creates a pull request, a different agent reviews it.
// It works for Claude Code and Codex, and only inside Herdr. Nobody has to name panes or agents.
//
// Usage (the tool sends its hook event as JSON on stdin):
//   node hook.mjs claude|codex       PostToolUse hook; the argument is the tool that built the PR
//
// What it does after "gh pr create":
//   1. Finds the new PR with "gh pr view" in the folder the command ran in.
//   2. Picks the reviewer tool: the other tool (claude -> codex, codex -> claude),
//      or PR_REVIEWER=claude|codex to choose one.
//   3. Reuses the reviewer pane it made before in this workspace, or splits the builder's pane
//      and starts a new reviewer there. It never prompts a pane it did not make.
//   4. Clears the reviewer's context and sends the review prompt. The reviewer posts its
//      findings on the PR.
//   5. When the builder is free again, asks it to fix the findings, push, and reply on the PR
//      with what it fixed and what it did not. Herdr notifications tell you when an agent needs you.
//
// The hook returns at once. The work runs in a detached process, so the builder never waits.
// Log: ~/.local/state/pr-review-handoff/log. Errors also appear as Herdr notifications.
// Source: https://github.com/raunakkathuria/iclone (scripts/hooks/pr-review-handoff/). MIT.
// Install or update with install.sh in that folder.
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const STATE_DIR = process.env.PR_HANDOFF_STATE_DIR || join(homedir(), '.local/state/pr-review-handoff');
const SHELL_TOOLS = new Set(['Bash', 'Shell']);
// Only where a command starts, so "gh pr create" inside a quote or a comment does not count.
const GH_PR_CREATE = /(?:^|[;&|(]|\n)\s*gh\s+pr\s+create\b/;
const OTHER_TOOL = { claude: 'codex', codex: 'claude' };
const CLEAR_COMMAND = { claude: '/clear', codex: '/new' };
const READY = new Set(['idle', 'done']);
// A PR created longer ago than this was not made by the command, which may have failed.
const MAX_PR_AGE_SECONDS = 600;
// Loop guard: at most this many reviews per builder pane per hour. PR_REVIEW_MAX_PER_HOUR changes it.
const MAX_REVIEWS_PER_HOUR = Number(process.env.PR_REVIEW_MAX_PER_HOUR) || 3;
const HOUR = 3_600_000;
const MINUTE = 60_000;

const unquote = (s) => s.replace(/^(["'])([\s\S]*)\1$/, '$2');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Pure helpers (unit-tested in hook.test.mjs) ---

// The heredocs that one line opens, in order: { word, tabs }. "tabs" is true for "<<-", which
// strips leading tabs from the closing line. A "<<" counts only outside single quotes and
// outside arithmetic such as $((1 << 2)). Inside double quotes it counts only within "$(...)",
// or a `...` backtick substitution, as in --body "$(cat <<'EOF' ...)". "<<<" is a here-string.
export function heredocsOpened(line) {
  const found = [];
  const stack = []; // "'", '"', 'cmd' for $(...) or (...), 'tick' for `...`, 'math' for $((...))
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const top = stack.at(-1);
    if (top === "'") { if (c === "'") stack.pop(); continue; }
    if (c === '\\') { i++; continue; }
    if (top === '"') {
      if (c === '"') stack.pop();
      else if (line.startsWith('$((', i)) { stack.push('math'); i += 2; }
      else if (line.startsWith('$(', i)) { stack.push('cmd'); i += 1; }
      else if (c === '`') stack.push('tick');
      continue;
    }
    if (top === 'math') {
      if (line.startsWith('))', i)) { stack.pop(); i++; }
      continue;
    }
    if (c === "'" || c === '"') { stack.push(c); continue; }
    if (c === '`') { if (top === 'tick') stack.pop(); else stack.push('tick'); continue; }
    if (line.startsWith('((', i)) { stack.push('math'); i++; continue; }
    if (c === '(') { stack.push('cmd'); continue; }
    if (c === ')') { if (top === 'cmd') stack.pop(); continue; }
    if (!line.startsWith('<<', i)) continue;
    if (line[i + 2] === '<') { i += 2; continue; }
    let j = i + 2;
    const tabs = line[j] === '-';
    if (tabs) j++;
    while (line[j] === ' ' || line[j] === '\t') j++;
    // The delimiter is one shell word: quoted parts, escaped characters, or plain characters.
    let word = '';
    while (j < line.length && !/[\s;&|<>()`]/.test(line[j])) {
      // $'EOF' is ANSI-C quoting: the delimiter is EOF.
      if (line[j] === '$' && line[j + 1] === "'") { j++; continue; }
      if (line[j] === "'" || line[j] === '"') {
        const close = line.indexOf(line[j], j + 1);
        if (close < 0) break;
        word += line.slice(j + 1, close);
        j = close + 1;
      } else if (line[j] === '\\') { word += line[j + 1] ?? ''; j += 2; }
      else { word += line[j]; j++; }
    }
    if (word) found.push({ word, tabs });
    i = j - 1;
  }
  return found;
}

// The command without the bodies of its heredocs. A heredoc body is text, never a command, so
// "&& gh pr create" written inside one must not count. Each body ends at a line that is exactly
// its word (after leading tabs, for "<<-"), and the bodies of one line end in order.
export function withoutHeredocs(command) {
  const kept = [];
  const open = [];
  for (const line of command.split('\n')) {
    if (open.length) {
      const { word, tabs } = open[0];
      if ((tabs ? line.replace(/^\t+/, '') : line) === word) open.shift();
      continue;
    }
    kept.push(line);
    open.push(...heredocsOpened(line));
  }
  return kept.join('\n');
}

export function isPrCreate(event) {
  const command = event?.tool_input?.command;
  return SHELL_TOOLS.has(event?.tool_name) && typeof command === 'string' && GH_PR_CREATE.test(withoutHeredocs(command));
}

// The folder "gh pr create" ran in: the event's folder, changed by a "cd X &&" before it.
export function commandDir(command, cwd) {
  const at = command.search(GH_PR_CREATE);
  const before = at >= 0 ? command.slice(0, at) : command;
  let dir = cwd;
  // Each cd starts from where the one before it left off: "cd a && cd b" ends in a/b.
  for (const [, cd] of before.matchAll(/(?:^|&&|;)\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
    const next = unquote(cd).replace(/^~(?=\/|$)/, homedir());
    dir = isAbsolute(next) ? next : join(dir, next);
  }
  return dir;
}

// What "gh pr create" printed, from the tool's result. Each tool keeps it in a different
// field, so this searches the whole result. "failed" means gh made no new PR. The URL is used
// only when the output has exactly one PR URL: another command in the same line, such as
// "gh pr view 3 && gh pr create", can print a different PR first.
export function createResult(event) {
  const raw = event?.tool_response;
  const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  const urls = [...new Set(text.match(/https:\/\/github\.com\/[^/\s"\\]+\/[^/\s"\\]+\/pull\/\d+/g) ?? [])];
  return { failed: /already exists/i.test(text), url: urls.length === 1 ? urls[0] : null };
}

// Whether the PR is on the branch the command made a PR for. --head can be "owner:branch".
export function sameBranch(expected, headRefName) {
  return !expected || expected.replace(/^[^:]+:/, '') === headRefName;
}

// The branch given with --head or -H, if any. Without it, gh uses the current branch.
export function headBranch(command) {
  const m = /\bgh\s+pr\s+create\b.*?(?:--head[=\s]|-H\s)\s*("[^"]+"|'[^']+'|[^\s;&|]+)/s.exec(command);
  return m ? unquote(m[1]) : null;
}

export function reviewerTool(builder, env = {}) {
  const chosen = env.PR_REVIEWER;
  if (chosen && CLEAR_COMMAND[chosen]) return chosen;
  return OTHER_TOOL[builder] ?? 'codex';
}

// A unique agent name from the pane ID, which Herdr never reuses: "wW:p3" -> "review-codex-ww-p3".
export function agentName(tool, paneId) {
  return `review-${tool}-${paneId}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
}

// Split a wide pane to the right and a tall one down. Terminal cells are about twice as tall as wide.
export function splitDirection(rect) {
  return rect && rect.width >= rect.height * 2.5 ? 'right' : 'down';
}

export const reviewLabel = (tool) => `${tool} review`;

// Whether a pane is a reviewer pane this hook opened on this server. A reviewer that opens a PR
// must not start another review, or reviews could chain without end. The label check keeps a
// user's pane safe if its ID once belonged to a reviewer pane before a server restart.
export function isReviewerPane(reviewers, socket, pane) {
  if (!pane) return false;
  const saved = Object.entries(reviewers).some(([key, id]) => key.startsWith(`${socket}|`) && id === pane.pane_id);
  return saved && /^(claude|codex) review$/.test(pane.label ?? '');
}

// The review start times that fall inside the last hour, oldest first.
export function recentStarts(times = [], now = Date.now()) {
  return times.filter((t) => now - (typeof t === 'number' ? t : t.at) < HOUR);
}

// "owner/repo" from a PR URL, so that each repository gets its own reviewer pane.
export function repoOf(url) {
  return /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1] ?? url;
}

// Whether a saved pane is still the reviewer pane this hook made. The ID alone is not proof:
// it could belong to another pane after a server restart. So the hook's own label must match too.
// Returns 'reuse' (the reviewer runs there), 'restart' (the reviewer exited) or null (not ours).
export function ownReviewerPane(pane, workspace, tool) {
  if (!pane || pane.workspace_id !== workspace || pane.label !== reviewLabel(tool)) return null;
  if (pane.agent === tool) return 'reuse';
  return pane.agent ? null : 'restart';
}

export function reviewPrompt(pr) {
  return [
    `Review pull request ${pr.url} (#${pr.number}).`,
    'You are an independent reviewer: you did not write this change, so judge it only by the code and the repository rules.',
    'First read the repository AGENTS.md or CLAUDE.md. If it defines a code-verifier or reviewer role, act as that role.',
    `Use gh pr view ${pr.url} and gh pr diff ${pr.url}. Always pass the full URL, not the number.`,
    'Check correctness, security, tests, and fit with the project rules.',
    'Do not edit, commit or push anything.',
    'Write only actionable findings, ranked P0 (must fix before merge) to P3 (nice to have), each with file:line and a one-line fix.',
    `Post them as one review comment with gh pr review ${pr.url} --comment --body-file <file>. If you find nothing, post a review comment that says so, the same way.`,
    'Then reply with the link to your comment.',
  ].join(' ');
}

// The builder keeps its context: it needs it to fix its own work.
export function fixPrompt(pr, reviewUrl, reviewer) {
  return [
    `${reviewer} reviewed your pull request ${pr.url}. The review: ${reviewUrl}.`,
    `Read it with gh pr view ${pr.url} --comments.`,
    'If it has no findings, do nothing more.',
    'Otherwise, for each finding: fix it, or decide not to and know why. Commit and push the fixes.',
    `Then reply with one comment: gh pr comment ${pr.url} --body-file <file>.`,
    'Start the reply with a link to the review. List every finding by its rank and title, then "fixed in <commit>" or "not fixed" with the reason.',
    'Post the reply without asking first: the repository owner wants this loop to run on its own.',
  ].join(' ');
}

// --- Side effects ---

function log(message) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(join(STATE_DIR, 'log'), `${new Date().toISOString()} [${process.pid}] ${message}\n`);
  } catch { /* logging must never fail the hook */ }
}

const HERDR = process.env.HERDR_BIN_PATH || 'herdr';

// Runs a herdr command and returns its JSON result. Herdr prints errors as JSON on stderr.
function herdr(...args) {
  try {
    const out = execFileSync(HERDR, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim() ? JSON.parse(out).result : null;
  } catch (e) {
    let code = 'failed';
    try { code = JSON.parse(e.stderr).error.code; } catch { /* not JSON */ }
    const error = new Error(`herdr ${args.slice(0, 2).join(' ')}: ${code}: ${String(e.stderr || e.message).trim()}`);
    error.code = code;
    throw error;
  }
}

function notify(title, body, sound = 'request') {
  try { herdr('notification', 'show', title, '--body', body, '--sound', sound); } catch (e) { log(e.message); }
}

async function findPr(dir, head) {
  // GitHub can take a moment to show a new PR, so try a few times.
  for (let i = 0; i < 4; i++) {
    try {
      const args = ['pr', 'view', ...(head ? [head] : []), '--json', 'number,url,state,createdAt,headRefName'];
      return JSON.parse(execFileSync('gh', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
    } catch { await sleep(3000); }
  }
  return null;
}

// The PR's reviews: how many, and the link to the newest. Null when gh cannot tell.
// Plain comments do not count, so another comment, or the builder's reply, is never taken
// for the review.
export function reviews(pr) {
  try {
    const out = execFileSync('gh', ['api', `repos/${repoOf(pr.url)}/pulls/${pr.number}/reviews?per_page=100`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    const items = JSON.parse(out).filter((r) => r.submitted_at)
      .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at));
    return { count: items.length, newest: items.at(-1)?.html_url ?? null };
  } catch { return null; }
}

// Reserves the PR. Returns false when another worker already reserved it.
const claimFile = (url) => join(STATE_DIR, 'handed-off', createHash('sha1').update(url).digest('hex'));
function claimPr(url, token) {
  const dir = join(STATE_DIR, 'handed-off');
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(claimFile(url), JSON.stringify({ url, token }), { flag: 'wx' });
    return true;
  } catch { return false; }
}

// One review at a time per reviewer pane. A lock older than 3 hours is left over from a crash.
async function withLock(key, work) {
  const lock = join(STATE_DIR, 'locks', key);
  mkdirSync(join(STATE_DIR, 'locks'), { recursive: true });
  for (;;) {
    try { mkdirSync(lock); break; } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 180 * MINUTE) rmSync(lock, { recursive: true, force: true }); } catch { /* gone */ }
      await sleep(2000);
    }
  }
  try { return await work(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

// Reviewer panes this hook made, by session, workspace and tool.
const REVIEWERS_FILE = join(STATE_DIR, 'reviewers.json');
function loadReviewers() { try { return JSON.parse(readFileSync(REVIEWERS_FILE, 'utf8')); } catch { return {}; } }

// When each builder pane started a review, for the loop guard. One file per pane, so a write for
// one pane never wipes another pane's times.
const startsFile = (key) => join(STATE_DIR, 'review-starts', `${createHash('sha1').update(key).digest('hex')}.json`);
function loadStarts(key) { try { return JSON.parse(readFileSync(startsFile(key), 'utf8')); } catch { return []; } }
function saveStarts(key, times) {
  mkdirSync(join(STATE_DIR, 'review-starts'), { recursive: true });
  writeFileSync(startsFile(key), JSON.stringify(times));
}

// Takes a review slot for one builder pane: checks the hourly limit, claims the PR, and saves the
// start time, all under one lock per pane. Without the lock, workers for PRs made at the same time
// could all read the same count and all pass. Returns 'ok', 'paused' or 'duplicate'.
// holdMs is for the test only: it widens the gap between the read and the write.
export async function takeReviewSlot(slotKey, url, max = MAX_REVIEWS_PER_HOUR, holdMs = 0, token = randomUUID()) {
  return withLock(`slot-${createHash('sha1').update(slotKey).digest('hex')}`, async () => {
    const starts = recentStarts(loadStarts(slotKey));
    if (holdMs) await sleep(holdMs);
    if (starts.length >= max) return 'paused';
    if (!claimPr(url, token)) return 'duplicate';
    saveStarts(slotKey, [...starts, { at: Date.now(), token }]);
    return 'ok';
  });
}
// Only the worker that reserved a review can release it before sending a review prompt.
export async function releaseReviewSlot(slotKey, url, token) {
  return withLock(`slot-${createHash('sha1').update(slotKey).digest('hex')}`, async () => {
    let claim;
    try { claim = JSON.parse(readFileSync(claimFile(url), 'utf8')); } catch { return false; }
    if (claim.token !== token) return false;
    saveStarts(slotKey, recentStarts(loadStarts(slotKey)).filter((t) => t.token !== token));
    rmSync(claimFile(url));
    return true;
  });
}
function saveReviewer(key, paneId) {
  const all = loadReviewers();
  all[key] = paneId;
  writeFileSync(REVIEWERS_FILE, JSON.stringify(all, null, 2));
}

// Waits until the agent is ready for input. Tells the human once if it is waiting for them.
async function waitReady(pane, who, timeoutMs) {
  const end = Date.now() + timeoutMs;
  let told = false;
  while (Date.now() < end) {
    const status = herdr('agent', 'get', pane).agent.agent_status;
    if (READY.has(status)) return true;
    if (status === 'blocked' && !told) {
      notify(`${who} needs you`, `Answer the question in pane ${pane}. The PR review loop continues after that.`);
      told = true;
    }
    await sleep(3000);
  }
  return false;
}

// Starts the reviewer tool in a pane that is at a shell prompt. The new shell may still be loading.
async function startReviewer(pane, tool) {
  const name = agentName(tool, pane);
  for (let i = 0; i < 5; i++) {
    try {
      herdr('agent', 'start', name, '--kind', tool, '--pane', pane, '--timeout', '60000');
      await sleep(5000); // Herdr reports ready a little before the agent's input box is
      return;
    } catch (e) {
      if (e.code === 'agent_not_ready') return; // started, but waiting at a question; waitReady handles it
      if (i === 4) throw e;
      await sleep(2000);
    }
  }
}

// Sends the prompt and checks that the agent starts working on it. An agent that has only just
// started can drop input, so a prompt that never starts any work is sent again.
async function sendPrompt(pane, text) {
  for (let i = 0; i < 3; i++) {
    try {
      // --wait returns when the agent is ready again or waiting for the human; waitReady handles both.
      herdr('agent', 'prompt', pane, text, '--wait', '--timeout', '30000');
      return true;
    } catch (e) {
      if (e.code === 'timeout') return true; // it is working: the turn is longer than 30 seconds
      if (e.code !== 'agent_prompt_stalled') throw e;
      log(`prompt to ${pane} stalled; trying again`);
      await sleep(5000);
    }
  }
  return false;
}

async function getReviewerPane({ key, workspace, builderPane, tool, dir }) {
  const savedPane = loadReviewers()[key];
  if (savedPane) {
    let pane = null;
    try { pane = herdr('pane', 'get', savedPane).pane; } catch { /* pane closed */ }
    const state = ownReviewerPane(pane, workspace, tool);
    if (state === 'reuse') return { pane: savedPane, fresh: false };
    if (state === 'restart') {
      await startReviewer(savedPane, tool);
      return { pane: savedPane, fresh: true };
    }
  }
  const layout = herdr('pane', 'layout', '--pane', builderPane).layout;
  const rect = layout.panes.find((p) => p.pane_id === builderPane)?.rect;
  const pane = herdr('pane', 'split', '--pane', builderPane, '--direction', splitDirection(rect), '--cwd', dir, '--no-focus').pane.pane_id;
  saveReviewer(key, pane);
  herdr('pane', 'rename', pane, reviewLabel(tool));
  await startReviewer(pane, tool);
  return { pane, fresh: true };
}

async function worker(builder, eventFile) {
  const event = JSON.parse(readFileSync(eventFile, 'utf8'));
  rmSync(eventFile, { force: true });
  const socket = process.env.HERDR_SOCKET_PATH;
  if (!socket) throw new Error('Herdr socket is missing. Run the builder in a live Herdr pane.');
  // --current resolves Herdr's caller alias after a pane move. It never uses UI focus.
  const current = herdr('pane', 'current', '--current').pane;
  if (!current?.pane_id || !current.workspace_id || current.agent !== builder) {
    throw new Error(`The caller pane no longer hosts ${builder}. Restart the builder in its Herdr pane.`);
  }
  if (event.session_id && current.agent_session?.kind === 'id' && event.session_id !== current.agent_session.value) {
    throw new Error('The caller pane hosts a different agent session. Restart the builder in its Herdr pane.');
  }
  const builderPane = current.pane_id;
  const workspace = current.workspace_id;
  process.env.HERDR_PANE_ID = builderPane;
  process.env.HERDR_WORKSPACE_ID = workspace;
  if (isReviewerPane(loadReviewers(), socket, current)) {
    notify('PR from a reviewer pane', `Pane ${builderPane} is a reviewer, so its PR gets no automatic review.`);
    return log(`skip: gh pr create ran in reviewer pane ${builderPane}`);
  }
  const command = withoutHeredocs(event.tool_input.command);
  const dir = commandDir(command, event.cwd || process.cwd());
  // gh prints the new PR's URL; a failed create says the PR "already exists".
  const created = createResult(event);
  if (created.failed) return log(`skip: gh pr create made no new PR in ${dir}`);
  const head = headBranch(command);
  const pr = await findPr(dir, created.url || head);
  if (!pr) return log(`no PR found in ${dir}`);
  // With --head, the PR must be on that branch. The folder's current branch is not checked: the
  // same command may switch branches after "gh pr create" ("&& git switch main").
  if (!sameBranch(head, pr.headRefName)) return log(`skip ${pr.url}: its branch ${pr.headRefName} is not ${head}`);
  const age = (Date.now() - Date.parse(pr.createdAt)) / 1000;
  if (pr.state !== 'OPEN' || age > MAX_PR_AGE_SECONDS) return log(`skip ${pr.url}: state ${pr.state}, ${Math.round(age)}s old`);
  const slotKey = `${socket}|${builderPane}`;
  const token = randomUUID();
  const slot = await takeReviewSlot(slotKey, pr.url, MAX_REVIEWS_PER_HOUR, 0, token);
  if (slot === 'paused') {
    notify(`Review loop paused: PR #${pr.number}`, `Pane ${builderPane} reached ${MAX_REVIEWS_PER_HOUR} reviewed PRs in the last hour. Review this one yourself, or raise PR_REVIEW_MAX_PER_HOUR.`);
    return log(`skip ${pr.url}: ${MAX_REVIEWS_PER_HOUR} reviews from ${builderPane} in the last hour`);
  }
  if (slot === 'duplicate') return log(`skip ${pr.url}: already handed off`);

  const tool = reviewerTool(builder, process.env);
  // One reviewer pane per session, workspace, repository and tool.
  const key = `${socket}|${workspace}|${repoOf(pr.url)}|${tool}`;
  const ctx = { key, workspace, builderPane, tool, dir };
  log(`${pr.url}: built by ${builder}, review by ${tool}`);
  const lockKey = createHash('sha1').update(key).digest('hex');
  let mayHaveSubmitted = false;
  let reviewUrl;
  try {
    reviewUrl = await withLock(lockKey, async () => {
      const who = `${tool} reviewer`;
      const { pane, fresh } = await getReviewerPane(ctx);
      if (!(await waitReady(pane, who, 180 * MINUTE))) throw new Error(`${pr.url}: reviewer ${pane} never became ready`);
      if (!fresh) {
        // Each review starts from an empty context, so it cannot see earlier work.
        herdr('agent', 'prompt', pane, CLEAR_COMMAND[tool]);
        await sleep(3000);
        if (!(await waitReady(pane, who, 2 * MINUTE))) throw new Error(`${pr.url}: reviewer ${pane} did not become ready after clearing context`);
      }
      const before = reviews(pr);
      // Keep duplicate protection if prompt delivery fails with an uncertain result.
      mayHaveSubmitted = true;
      if (!(await sendPrompt(pane, reviewPrompt(pr)))) {
        notify(`${who} did not start`, `Send the review of ${pr.url} to pane ${pane} yourself.`);
        return log(`${pr.url}: prompt to ${pane} stalled 3 times`);
      }
      log(`${pr.url}: review started in ${pane}`);
      if (!(await waitReady(pane, who, 180 * MINUTE))) return log(`${pr.url}: review still running after 3 hours`);
      // "Ready" alone does not prove a review: the prompt may have landed on a dialog. A new
      // review on the PR does.
      const after = reviews(pr);
      if (!before || !after || after.count <= before.count) {
        notify(`No review posted: PR #${pr.number}`, `The ${who} stopped without a new review. Check pane ${pane}.`);
        return log(`${pr.url}: reviewer ${pane} stopped, but no new review on the PR`);
      }
      log(`${pr.url}: review posted: ${after.newest}`);
      return after.newest;
    });
  } catch (error) {
    if (!mayHaveSubmitted) {
      await releaseReviewSlot(slotKey, pr.url, token);
      log(`${pr.url}: startup failed; released review reservation`);
    }
    throw error;
  }
  // Outside the lock: waiting for a busy builder must not hold up other reviews.
  if (reviewUrl) await handBack(builder, ctx.builderPane, pr, reviewUrl, tool);
}

// Asks the builder to fix the findings and reply. It waits until the builder is free, so it
// never interrupts work. It only prompts the pane that ran "gh pr create", with the same tool.
async function handBack(builder, pane, pr, reviewUrl, reviewer) {
  let current = null;
  try { current = herdr('pane', 'get', pane).pane; } catch { /* pane closed */ }
  if (current?.agent !== builder) {
    notify(`Review posted: PR #${pr.number}`, `The ${builder} builder pane is gone. Fix the findings yourself: ${reviewUrl}`);
    return log(`${pr.url}: builder ${pane} is gone; not handed back`);
  }
  const who = `${builder} builder`;
  if (!(await waitReady(pane, who, 180 * MINUTE))) return log(`${pr.url}: builder ${pane} busy for 3 hours; not handed back`);
  if (!(await sendPrompt(pane, fixPrompt(pr, reviewUrl, reviewer)))) {
    notify(`${who} did not start`, `Ask pane ${pane} to fix the review yourself: ${reviewUrl}`);
    return log(`${pr.url}: fix prompt to ${pane} stalled 3 times`);
  }
  log(`${pr.url}: fixes asked from ${pane}`);
  notify(`Review posted: PR #${pr.number}`, `${reviewer} reviewed it. ${builder} is now fixing the findings.`, 'done');
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

// The hook part: checks the event, hands the work to a detached process, and exits at once.
async function hook(builder) {
  const event = JSON.parse((await readStdin()) || '{}');
  if (!isPrCreate(event)) return;
  if (process.env.HERDR_ENV !== '1' || !process.env.HERDR_PANE_ID || !process.env.HERDR_WORKSPACE_ID) return;
  mkdirSync(STATE_DIR, { recursive: true });
  const eventFile = join(STATE_DIR, `event-${process.pid}-${Date.now()}.json`);
  writeFileSync(eventFile, JSON.stringify(event));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), builder, '--worker', eventFile], { detached: true, stdio: 'ignore' });
  child.unref();
  log(`hook: ${builder} ran gh pr create; worker ${child.pid}`);
}

async function main([builder = 'claude', mode, eventFile]) {
  if (!OTHER_TOOL[builder]) return;
  if (mode === '--worker') await worker(builder, eventFile);
  else await hook(builder);
}

// A hook must never break the agent's work: it always exits 0 and prints nothing.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((e) => {
    log(`error: ${e.stack || e.message}`);
    if (process.env.HERDR_ENV === '1' && process.env.HERDR_SOCKET_PATH) {
      notify('PR review handoff failed', `${e.message.slice(0, 240)} Check ~/.local/state/pr-review-handoff/log.`);
    }
  }).finally(() => { process.exitCode = 0; });
}

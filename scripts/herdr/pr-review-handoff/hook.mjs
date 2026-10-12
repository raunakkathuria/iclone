#!/usr/bin/env node
// pr-review-handoff: the coder's finished work goes to the reviewer pane, and the findings come
// back to the coder. It runs inside Herdr, with any coding tool Herdr detects.
//
// Each workspace has a pane labelled "coder" and one labelled "reviewer" (the Herdr plugin in
// this repository makes them). The tool in each pane is whatever runs there now.
//
// Usage (the tool sends its hook event as JSON on stdin):
//   node hook.mjs claude|codex|kiro          PostToolUse hook after a shell command
//   node hook.mjs claude|kiro session        SessionStart (Claude, Cursor, Kiro V3) or
//                                            userPromptSubmit (Kiro V2) hook: tells the coder to
//                                            run herdr-review
//
// It starts a review after two shell commands:
//   gh pr create   The reviewer posts one review on the PR. The coder then fixes the findings,
//                  pushes, and replies on the PR.
//   herdr-review   For local work with no PR. The reviewer writes its findings to a file in
//                  /tmp/herdr-review/, and the coder fixes them.
//
// The hook returns at once. The work runs in a detached process, outside the agent's sandbox.
// Log: ~/.local/state/pr-review-handoff/log. Errors also appear as Herdr notifications.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CLEAR_COMMAND, STATE_DIR, ensureLayout, herdr, loadConfig, log, notify, pickReviewer, roleOf, sleep,
  startAgent, withLock,
} from '../lib/herdr.mjs';

// Shell tool names: Claude Code and Codex "Bash", Cursor "Shell", Kiro V2 "shell", Kiro V3 "execute_bash".
const SHELL_TOOLS = new Set(['Bash', 'Shell', 'shell', 'execute_bash']);
// Only where a command starts, so "gh pr create" inside a quote or a comment does not count.
const GH_PR_CREATE = /(?:^|[;&|(]|\n)\s*gh\s+pr\s+create\b/;
const HERDR_REVIEW = /(?:^|[;&|(]|\n)\s*herdr-review\b/;
const READY = new Set(['idle', 'done']);
// Every coding tool may write here, even in a sandbox. PR_HANDOFF_FINDINGS_DIR is for tests.
const FINDINGS_DIR = process.env.PR_HANDOFF_FINDINGS_DIR || '/tmp/herdr-review';
// A PR created longer ago than this was not made by the command, which may have failed.
const MAX_PR_AGE_SECONDS = 600;
// Loop guard: at most this many reviews per coder pane per hour. PR_REVIEW_MAX_PER_HOUR changes it.
const MAX_REVIEWS_PER_HOUR = Number(process.env.PR_REVIEW_MAX_PER_HOUR) || 3;
const HOUR = 3_600_000;
const MINUTE = 60_000;
// A reviewer that is ready again this soon, with no review, never got the prompt.
const LOST_PROMPT_MS = Number(process.env.PR_HANDOFF_LOST_PROMPT_MS) || 20_000;

// What the coder is told at the start of each session, so that it asks for a review when done.
export const CODER_RULE = [
  'You work in a Herdr workspace as the coder. A reviewer agent runs in the pane labelled "reviewer".',
  'When you finish a change and do not open a pull request, run `herdr-review` from the repository folder as your last step, then stop.',
  'It sends your local changes to the reviewer, and the findings come back to you as a new prompt.',
  'A pull request you open with `gh pr create` goes to the reviewer on its own, so do not run `herdr-review` for it.',
  'Do not run `herdr-review` for fixes that a review asked for, and never when your task is to review work.',
].join(' ');

const unquote = (s) => s.replace(/^(["'])([\s\S]*)\1$/, '$2');

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

function shellCommand(event) {
  const command = event?.tool_input?.command;
  return SHELL_TOOLS.has(event?.tool_name) && typeof command === 'string' ? withoutHeredocs(command) : null;
}

export function isPrCreate(event) {
  return GH_PR_CREATE.test(shellCommand(event) ?? '');
}

export function isReviewRequest(event) {
  return HERDR_REVIEW.test(shellCommand(event) ?? '');
}

// The folder the command ran in. Cursor sends an empty cwd, so fall back to its tool input and
// its workspace root.
export function eventDir(event, env = {}) {
  return event?.cwd || event?.tool_input?.cwd || env.CLAUDE_PROJECT_DIR || event?.workspace_roots?.[0] || process.cwd();
}

// The folder a command ran in: the event's folder, changed by a "cd X &&" before it.
export function commandDir(command, cwd, pattern = GH_PR_CREATE) {
  const at = command.search(pattern);
  const before = at >= 0 ? command.slice(0, at) : command;
  let dir = cwd;
  // Each cd starts from where the one before it left off: "cd a && cd b" ends in a/b.
  for (const [, cd] of before.matchAll(/(?:^|&&|;)\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/g)) {
    const next = unquote(cd).replace(/^~(?=\/|$)/, homedir());
    dir = isAbsolute(next) ? next : join(dir, next);
  }
  return dir;
}

// What "gh pr create" printed, from the tool's result: Cursor calls it tool_output, the others
// tool_response. "failed" means gh made no new PR. The URL is used only when the output has
// exactly one PR URL: another command in the same line, such as "gh pr view 3 && gh pr create",
// can print a different PR first.
export function createResult(event) {
  const raw = event?.tool_response ?? event?.tool_output;
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

// The pane that ran the command. The agent's session ID is the surest match. Then the pane
// Herdr resolves for the caller, then the pane labelled "coder" in the caller's workspace: the
// caller's pane ID can be stale, for example after a server restart.
export function findBuilderPane(panes, { current, sessionId, workspace }) {
  const bySession = sessionId && panes.find((p) => p.agent_session?.value === sessionId);
  return bySession || current || panes.find((p) => p.workspace_id === workspace && roleOf(p.label) === 'coder') || null;
}

// The reviewer pane in the coder's workspace, the one in the same tab first.
export function findReviewerPane(panes, builder) {
  const reviewers = panes.filter((p) => p.pane_id !== builder.pane_id && p.workspace_id === builder.workspace_id
    && roleOf(p.label) === 'reviewer');
  return reviewers.find((p) => p.tab_id === builder.tab_id) ?? reviewers[0] ?? null;
}

// The review start times that fall inside the last hour, oldest first.
export function recentStarts(times = [], now = Date.now()) {
  return times.filter((t) => now - (typeof t === 'number' ? t : t.at) < HOUR);
}

// "owner/repo" from a PR URL.
export function repoOf(url) {
  return /github\.com\/([^/]+\/[^/]+)\/pull\//.exec(url)?.[1] ?? url;
}

// The reviewer pane starts in the workspace folder, which can be another checkout than the
// coder's, so every review prompt names the checkout to work in.
function reviewerRules(root) {
  return [
    'You are an independent reviewer: you did not write this change, so judge it only by the code and the repository rules.',
    'You are not the coder, so do not run herdr-review.',
    `Work in ${root}: run every command there, and first read the AGENTS.md or CLAUDE.md there. If it defines a code-verifier or reviewer role, act as that role.`,
  ];
}
const FINDINGS = 'Write only actionable findings, ranked P0 (must fix before merge) to P3 (nice to have), each with file:line and a one-line fix.';

export function reviewPrompt(pr, root) {
  return [
    `Review pull request ${pr.url} (#${pr.number}). Its repository is checked out in ${root}.`,
    ...reviewerRules(root),
    `Use gh pr view ${pr.url} and gh pr diff ${pr.url}. Always pass the full URL, not the number.`,
    'Check correctness, security, tests, and fit with the project rules.',
    'Do not edit, commit or push anything.',
    FINDINGS,
    `Post them as one review comment with gh pr review ${pr.url} --comment --body-file <file>. If you find nothing, post a review comment that says so, the same way.`,
    'Then reply with the link to your comment.',
  ].join(' ');
}

// The coder keeps its context: it needs it to fix its own work.
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

export function localReviewPrompt({ root, base, file }) {
  return [
    `Review the local changes in the git repository ${root}. They have no pull request.`,
    ...reviewerRules(root),
    `See the changes with git -C ${root} status and git -C ${root} diff ${base}. Read new untracked files too.`,
    'Check correctness, security, tests, and fit with the project rules.',
    `Do not edit, commit or push anything. The only file you write is ${file}.`,
    FINDINGS,
    `Write them to ${file}. If you find nothing, write "No findings." to that file.`,
    'Then reply with the path of the file.',
  ].join(' ');
}

export function localFixPrompt({ root, file }, reviewer) {
  return [
    `${reviewer} reviewed your local changes in ${root}. The findings are in ${file}. Read that file.`,
    'If it says "No findings.", do nothing more.',
    'Otherwise, for each finding: fix it, or decide not to and know why.',
    'Then reply with a short list: each finding by its rank and title, then "fixed" or "not fixed" with the reason.',
    'Do not run herdr-review for these fixes.',
  ].join(' ');
}

// What a session hook prints, so the tool adds the coder rule to its context. Claude Code and
// Cursor read hookSpecificOutput; Kiro adds plain output to the context.
export function sessionOutput(tool, rule = CODER_RULE) {
  if (tool === 'kiro') return `${rule}\n`;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: rule } });
}

// --- Side effects ---

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
// Plain comments do not count, so another comment, or the coder's reply, is never taken
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

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();

// The top folder of the git checkout that holds dir, or null when dir is not in one.
function gitRoot(dir) {
  try { return git(dir, 'rev-parse', '--show-toplevel'); } catch { return null; }
}

// Feeds a git command's output into a hash as it arrives, so a large diff never sits in memory.
function hashGit(root, args, hash, input = null) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', root, ...args], { stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdout.on('data', (chunk) => hash.update(chunk));
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`git ${args[0]} failed in ${root}: ${stderr.trim()}`))));
    if (input !== null) child.stdin.end(input);
  });
}

// The local changes to review: everything since the branch left the remote's default branch,
// committed or not, and untracked files. Null when there is nothing to review. The hash covers
// the diff and the content of each untracked file, so any new change gets a new review.
// A git failure throws: it is reported, never taken for "no changes".
async function localChanges(root) {
  let base = 'HEAD';
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
    try { base = git(root, 'merge-base', 'HEAD', ref); break; } catch { /* no such ref */ }
  }
  const quiet = spawnSync('git', ['-C', root, 'diff', '--quiet', base], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' });
  if (quiet.status !== 0 && quiet.status !== 1) throw new Error(`git diff failed in ${root}: ${(quiet.stderr || quiet.error?.message || '').trim()}`);
  const untracked = git(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean);
  if (quiet.status === 0 && !untracked.length) return null;
  const hash = createHash('sha1');
  await hashGit(root, ['diff', '--binary', base], hash);
  if (untracked.length) {
    hash.update(untracked.join('\0'));
    // git hash-object prints one ID per file, made from the file's content.
    await hashGit(root, ['hash-object', '--stdin-paths'], hash, `${untracked.join('\n')}\n`);
  }
  return { base, hash: hash.digest('hex') };
}

// Reserves a review. Returns false when another worker already reserved it.
const claimFile = (key) => join(STATE_DIR, 'handed-off', createHash('sha1').update(key).digest('hex'));
function claim(key, token) {
  mkdirSync(join(STATE_DIR, 'handed-off'), { recursive: true });
  try {
    writeFileSync(claimFile(key), JSON.stringify({ key, token }), { flag: 'wx' });
    return true;
  } catch { return false; }
}

// When each coder pane started a review, for the loop guard. One file per pane, so a write for
// one pane never wipes another pane's times.
const startsFile = (key) => join(STATE_DIR, 'review-starts', `${createHash('sha1').update(key).digest('hex')}.json`);
function loadStarts(key) { try { return JSON.parse(readFileSync(startsFile(key), 'utf8')); } catch { return []; } }
function saveStarts(key, times) {
  mkdirSync(join(STATE_DIR, 'review-starts'), { recursive: true });
  writeFileSync(startsFile(key), JSON.stringify(times));
}
const slotLock = (slotKey) => `slot-${createHash('sha1').update(slotKey).digest('hex')}`;

// Takes a review slot for one coder pane: checks the hourly limit, claims the review, and saves
// the start time, all under one lock per pane. Without the lock, workers that start at the same
// time could all read the same count and all pass. Returns 'ok', 'paused' or 'duplicate'.
// holdMs is for the test only: it widens the gap between the read and the write.
export async function takeReviewSlot(slotKey, key, max = MAX_REVIEWS_PER_HOUR, holdMs = 0, token = randomUUID()) {
  return withLock(slotLock(slotKey), async () => {
    const starts = recentStarts(loadStarts(slotKey));
    if (holdMs) await sleep(holdMs);
    if (starts.length >= max) return 'paused';
    if (!claim(key, token)) return 'duplicate';
    saveStarts(slotKey, [...starts, { at: Date.now(), token }]);
    return 'ok';
  });
}
// Only the worker that reserved a review can release it before sending a review prompt.
export async function releaseReviewSlot(slotKey, key, token) {
  return withLock(slotLock(slotKey), async () => {
    let held;
    try { held = JSON.parse(readFileSync(claimFile(key), 'utf8')); } catch { return false; }
    if (held.token !== token) return false;
    saveStarts(slotKey, recentStarts(loadStarts(slotKey)).filter((t) => t.token !== token));
    rmSync(claimFile(key));
    return true;
  });
}

// Waits until the agent is ready for input. Tells the human once if it is waiting for them.
// With checks = 2 the agent must be ready twice in a row, 3 seconds apart: between two of its
// questions, an agent such as Kiro looks ready for a moment.
async function waitReady(pane, who, timeoutMs, checks = 1) {
  const end = Date.now() + timeoutMs;
  let told = false;
  let ready = 0;
  while (Date.now() < end) {
    const status = herdr('agent', 'get', pane).agent.agent_status;
    ready = READY.has(status) ? ready + 1 : 0;
    if (ready >= checks) return true;
    if (status === 'blocked' && !told) {
      notify(`${who} needs you`, `Answer the question in pane ${pane}. The review loop continues after that.`);
      told = true;
    }
    await sleep(3000);
  }
  return false;
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

// Finds the coder pane (see findBuilderPane). Throws when there is none.
function resolveBuilder(event) {
  let current = null;
  // --current resolves Herdr's caller alias after a pane move. It never uses UI focus.
  try { current = herdr('pane', 'current', '--current').pane; } catch (e) { log(`pane current: ${e.code}`); }
  let panes = [];
  try { panes = herdr('pane', 'list').panes; } catch (e) { log(`pane list: ${e.code}`); }
  const pane = findBuilderPane(panes, { current, sessionId: event.session_id, workspace: process.env.HERDR_WORKSPACE_ID });
  if (!pane?.pane_id || !pane.workspace_id) throw new Error('Could not find the coder pane. Run the coder inside a Herdr pane.');
  return pane;
}

// The reviewer pane in the coder's workspace, with a tool running. Adds the pane, or starts a
// tool in it, when that is missing.
async function getReviewer(builder, builderTool) {
  const find = () => findReviewerPane(herdr('pane', 'list', '--workspace', builder.workspace_id).panes, builder);
  let pane = find();
  let fresh = false;
  // Another run (the plugin) may hold the layout lock; then wait for it to finish.
  for (let i = 0; i < 12 && !pane; i++) {
    if (!(await ensureLayout(builder.workspace_id, loadConfig(), builder.pane_id))) await sleep(5000);
    pane = find();
    fresh = true;
  }
  if (!pane) throw new Error(`No reviewer pane in workspace ${builder.workspace_id}.`);
  if (!pane.agent) {
    await startAgent(pane.pane_id, 'reviewer', pickReviewer(builderTool, loadConfig(), process.env));
    pane = find();
    fresh = true;
  }
  if (!pane?.agent) throw new Error(`No tool runs in the reviewer pane ${pane?.pane_id}. Start one there.`);
  return { pane: pane.pane_id, tool: pane.agent, fresh };
}

// Sends one review to the reviewer pane and hands the result back to the coder.
// job: { builder, builderTool, slotKey, key, token, title, prompt, before(), after(before), fix(result, reviewer) }
async function runReview(job) {
  const socket = process.env.HERDR_SOCKET_PATH;
  const lockKey = `review-${createHash('sha1').update(`${socket}|${job.builder.workspace_id}`).digest('hex')}`;
  let mayHaveSubmitted = false;
  let reviewer;
  let result;
  try {
    // One review at a time per workspace: there is one reviewer pane.
    result = await withLock(lockKey, async () => {
      reviewer = await getReviewer(job.builder, job.builderTool);
      const who = `${reviewer.tool} reviewer`;
      log(`${job.key}: review by ${reviewer.tool} in ${reviewer.pane}`);
      if (reviewer.tool === job.builderTool) {
        notify('Review is not independent', `The reviewer pane ${reviewer.pane} runs ${reviewer.tool}, the same tool as the coder. The review runs anyway.`);
      }
      if (!(await waitReady(reviewer.pane, who, 180 * MINUTE))) throw new Error(`${job.key}: reviewer ${reviewer.pane} never became ready`);
      if (!reviewer.fresh) {
        // Each review starts from an empty context, so it cannot see earlier work.
        const clear = CLEAR_COMMAND[reviewer.tool];
        if (clear) {
          herdr('agent', 'prompt', reviewer.pane, clear);
          await sleep(3000);
          if (!(await waitReady(reviewer.pane, who, 2 * MINUTE))) throw new Error(`${job.key}: reviewer ${reviewer.pane} did not become ready after clearing context`);
        } else log(`${job.key}: no clear command for ${reviewer.tool}; the reviewer keeps its context`);
      }
      const before = job.before();
      // Keep duplicate protection if prompt delivery fails with an uncertain result.
      mayHaveSubmitted = true;
      for (let attempt = 1; ; attempt++) {
        const sent = Date.now();
        if (!(await sendPrompt(reviewer.pane, job.prompt))) {
          notify(`${who} did not start`, `Send the review of ${job.title} to pane ${reviewer.pane} yourself.`);
          return log(`${job.key}: prompt to ${reviewer.pane} stalled 3 times`);
        }
        log(`${job.key}: review started in ${reviewer.pane}`);
        if (!(await waitReady(reviewer.pane, who, 180 * MINUTE, 2))) return log(`${job.key}: review still running after 3 hours`);
        // "Ready" alone does not prove a review: the prompt may have landed on a dialog.
        const done = job.after(before);
        if (done) {
          log(`${job.key}: review done: ${done}`);
          return done;
        }
        // A real review takes longer than this. Codex, for one, drops the first prompt after /new.
        if (Date.now() - sent < LOST_PROMPT_MS && attempt < 3) {
          log(`${job.key}: reviewer ${reviewer.pane} was ready again at once with no review; sending the prompt again`);
          await sleep(3000);
          continue;
        }
        notify(`No review: ${job.title}`, `The ${who} stopped without a review. Check pane ${reviewer.pane}.`);
        return log(`${job.key}: reviewer ${reviewer.pane} stopped, but wrote no review`);
      }
    });
  } catch (error) {
    if (!mayHaveSubmitted) {
      const released = await releaseReviewSlot(job.slotKey, job.key, job.token).catch((releaseError) => {
        log(`${job.key}: release failed: ${releaseError.message}`);
        return false;
      });
      log(`${job.key}: startup failed; ${released ? 'released' : 'kept'} review reservation`);
    }
    throw error;
  }
  // Outside the lock: waiting for a busy coder must not hold up other reviews.
  if (result) await handBack(job, result, reviewer.tool);
}

// Asks the coder to fix the findings. It waits until the coder is free, so it never interrupts
// work. It prompts whatever tool runs in the coder pane now, even if you switched tools.
async function handBack(job, result, reviewerTool) {
  const pane = job.builder.pane_id;
  let current = null;
  try { current = herdr('pane', 'get', pane).pane; } catch { /* pane closed */ }
  if (!current?.agent) {
    notify(`Review done: ${job.title}`, `No tool runs in the coder pane ${pane}. Fix the findings yourself: ${result}`);
    return log(`${job.key}: coder ${pane} has no agent; not handed back`);
  }
  const who = `${current.agent} coder`;
  if (!(await waitReady(pane, who, 180 * MINUTE))) return log(`${job.key}: coder ${pane} busy for 3 hours; not handed back`);
  if (!(await sendPrompt(pane, job.fix(result, reviewerTool)))) {
    notify(`${who} did not start`, `Ask pane ${pane} to fix the review yourself: ${result}`);
    return log(`${job.key}: fix prompt to ${pane} stalled 3 times`);
  }
  log(`${job.key}: fixes asked from ${pane} (${current.agent})`);
  notify(`Review done: ${job.title}`, `${reviewerTool} reviewed it. ${current.agent} is now fixing the findings.`, 'done');
}

// Finds the coder pane, applies the loop guards and takes a review slot. Returns the job
// fields, or null when this review must not run.
async function prepare(tool, event, key, title) {
  if (!process.env.HERDR_SOCKET_PATH) throw new Error('Herdr socket is missing. Run the coder in a live Herdr pane.');
  const builder = resolveBuilder(event);
  const builderTool = builder.agent ?? tool;
  process.env.HERDR_PANE_ID = builder.pane_id;
  process.env.HERDR_WORKSPACE_ID = builder.workspace_id;
  if (roleOf(builder.label) === 'reviewer') {
    // A PR from the reviewer is unusual, so say so. A herdr-review run there is only noise.
    if (!key.startsWith('local:')) notify('PR from the reviewer pane', `Pane ${builder.pane_id} is the reviewer, so its PR gets no automatic review.`);
    log(`skip ${key}: the request came from reviewer pane ${builder.pane_id}`);
    return null;
  }
  const slotKey = `${process.env.HERDR_SOCKET_PATH}|${builder.pane_id}`;
  const token = randomUUID();
  const slot = await takeReviewSlot(slotKey, key, MAX_REVIEWS_PER_HOUR, 0, token);
  if (slot === 'paused') {
    notify(`Review loop paused: ${title}`, `Pane ${builder.pane_id} reached ${MAX_REVIEWS_PER_HOUR} reviews in the last hour. Review this one yourself, or raise PR_REVIEW_MAX_PER_HOUR.`);
    log(`skip ${key}: ${MAX_REVIEWS_PER_HOUR} reviews from ${builder.pane_id} in the last hour`);
    return null;
  }
  if (slot === 'duplicate') { log(`skip ${key}: already handed off`); return null; }
  log(`${key}: built by ${builderTool} in ${builder.pane_id}`);
  return { builder, builderTool, slotKey, key, token, title };
}

async function prWorker(tool, event) {
  const command = withoutHeredocs(event.tool_input.command);
  const dir = commandDir(command, eventDir(event, process.env));
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
  const job = await prepare(tool, event, pr.url, `PR #${pr.number}`);
  if (!job) return;
  await runReview({
    ...job,
    prompt: reviewPrompt(pr, gitRoot(dir) ?? dir),
    before: () => reviews(pr),
    // A new review on the PR proves the review happened. Plain comments do not count.
    after: (before) => {
      const now = reviews(pr);
      return before && now && now.count > before.count ? now.newest : null;
    },
    fix: (reviewUrl, reviewer) => fixPrompt(pr, reviewUrl, reviewer),
  });
}

async function localWorker(tool, event) {
  const dir = commandDir(withoutHeredocs(event.tool_input.command), eventDir(event, process.env), HERDR_REVIEW);
  const root = gitRoot(dir);
  if (!root) return log(`skip herdr-review in ${dir}: not a git repository`);
  const changes = await localChanges(root);
  if (!changes) return log(`skip herdr-review in ${root}: no changes`);
  const local = { root, ...changes, file: join(FINDINGS_DIR, `${Date.now()}-${changes.hash.slice(0, 8)}.md`) };
  const job = await prepare(tool, event, `local:${local.root}:${local.hash}`, `local changes in ${local.root.split('/').at(-1)}`);
  if (!job) return;
  mkdirSync(FINDINGS_DIR, { recursive: true });
  await runReview({
    ...job,
    prompt: localReviewPrompt(local),
    before: () => null,
    after: () => (existsSync(local.file) && statSync(local.file).size > 0 ? local.file : null),
    fix: (file, reviewer) => localFixPrompt({ ...local, file }, reviewer),
  });
}

async function readStdin() {
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

// The hook part: checks the event, hands the work to a detached process, and exits at once.
async function hook(tool) {
  const event = JSON.parse((await readStdin()) || '{}');
  const kind = isPrCreate(event) ? 'pr' : isReviewRequest(event) ? 'local' : null;
  if (!kind) return;
  if (process.env.HERDR_ENV !== '1' || !process.env.HERDR_PANE_ID || !process.env.HERDR_WORKSPACE_ID) return;
  mkdirSync(STATE_DIR, { recursive: true });
  const eventFile = join(STATE_DIR, `event-${process.pid}-${Date.now()}.json`);
  writeFileSync(eventFile, JSON.stringify(event));
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), tool, `--${kind}-worker`, eventFile], { detached: true, stdio: 'ignore' });
  child.unref();
  log(`hook: ${tool} ran ${kind === 'pr' ? 'gh pr create' : 'herdr-review'}; pane ${process.env.HERDR_PANE_ID}, socket ${process.env.HERDR_SOCKET_PATH}; worker ${child.pid}`);
}

// The session part: gives the coder the rule, inside Herdr only, and never in the reviewer pane.
async function session(tool) {
  await readStdin();
  if (process.env.HERDR_ENV !== '1') return;
  try {
    if (roleOf(herdr('pane', 'current', '--current').pane?.label) === 'reviewer') return;
  } catch { /* unknown pane: give the rule */ }
  process.stdout.write(sessionOutput(tool));
}

async function main([tool = 'claude', mode, eventFile]) {
  if (mode === 'session') return session(tool);
  if (mode === '--pr-worker' || mode === '--local-worker') {
    const event = JSON.parse(readFileSync(eventFile, 'utf8'));
    rmSync(eventFile, { force: true });
    return mode === '--pr-worker' ? prWorker(tool, event) : localWorker(tool, event);
  }
  return hook(tool);
}

// The hook runs through a symlink (~/.agents/hooks/pr-review-handoff), and Node loads the real file.
function invokedDirectly() {
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; }
}

// A hook must never break the agent's work: it always exits 0, and prints only the session rule.
if (invokedDirectly()) {
  main(process.argv.slice(2)).catch((e) => {
    log(`error: ${e.stack || e.message}`);
    if (process.env.HERDR_ENV === '1' && process.env.HERDR_SOCKET_PATH) {
      notify('Review handoff failed', `${e.message.slice(0, 240)} Ask the reviewer pane to review it yourself. Check ~/.local/state/pr-review-handoff/log.`);
    }
  }).finally(() => { process.exitCode = 0; });
}

// Shared helpers for the coder + reviewer setup in Herdr. Used by the Herdr plugin (pair.mjs)
// and by the PR review hook (pr-review-handoff/hook.mjs).
//
// Roles come from pane labels: the pane labelled "coder" writes the code, the pane labelled
// "reviewer" reviews it. The tool in each pane is whatever Herdr detects there, so you can
// switch tools at any time.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATE_DIR = process.env.PR_HANDOFF_STATE_DIR || join(homedir(), '.local/state/pr-review-handoff');
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The command that starts a new conversation, so a reviewer never sees its earlier reviews.
export const CLEAR_COMMAND = { claude: '/clear', codex: '/new', cursor: '/clear', kiro: '/clear' };
const DEFAULT_CONFIG = { coder: 'claude', reviewer: 'codex' };
const MINUTE = 60_000;

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function log(message) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(join(STATE_DIR, 'log'), `${new Date().toISOString()} [${process.pid}] ${message}\n`);
  } catch { /* logging must never fail the caller */ }
}

// Runs a herdr command and returns its JSON result. Herdr prints errors as JSON on stderr.
export function herdr(...args) {
  try {
    const out = execFileSync(process.env.HERDR_BIN_PATH || 'herdr', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return out.trim() ? JSON.parse(out).result : null;
  } catch (e) {
    let code = 'failed';
    try { code = JSON.parse(e.stderr).error.code; } catch { /* not JSON */ }
    const error = new Error(`herdr ${args.slice(0, 2).join(' ')}: ${code}: ${String(e.stderr || e.message).trim()}`);
    error.code = code;
    throw error;
  }
}

export function notify(title, body, sound = 'request') {
  try { herdr('notification', 'show', title, '--body', body, '--sound', sound); } catch (e) { log(e.message); }
}

// The default tools for new panes, from config.json at the repository root.
export function loadConfig(file = join(REPO_ROOT, 'config.json')) {
  try { return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(file, 'utf8')) }; } catch { return { ...DEFAULT_CONFIG }; }
}

// "coder", "reviewer" or null. "codex review" and the like are reviewer panes from the old hook.
export function roleOf(label) {
  if (label === 'coder') return 'coder';
  if (label === 'reviewer' || /^[a-z]+ review$/i.test(label ?? '')) return 'reviewer';
  return null;
}

// The tool to start in an empty reviewer pane: PR_REVIEWER if set, else the configured reviewer,
// unless the coder already uses that tool; then the configured coder tool.
export function pickReviewer(builder, config = DEFAULT_CONFIG, env = {}) {
  if (env.PR_REVIEWER) return env.PR_REVIEWER;
  return config.reviewer !== builder ? config.reviewer : config.coder;
}

// Split a wide pane to the right and a tall one down. Terminal cells are about twice as tall as wide.
export function splitDirection(rect) {
  return rect && rect.width >= rect.height * 2.5 ? 'right' : 'down';
}

// A unique agent name from the pane ID, which Herdr never reuses: ("reviewer", "w1:p2") -> "reviewer-w1-p2".
export function agentName(role, paneId) {
  return `${role}-${paneId}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
}

// Which pane of a workspace is the coder and which the reviewer. Pure: works on `pane list` output.
// The coder is coderId when given (the pane that asked for a review), else the pane labelled
// "coder", else a pane with an agent (the focused one first), else the focused pane, else the
// first. Either can be null.
export function planLayout(panes, coderId = null) {
  const others = panes.filter((p) => roleOf(p.label) !== 'reviewer');
  const coder = others.find((p) => p.pane_id === coderId)
    ?? others.find((p) => roleOf(p.label) === 'coder')
    ?? others.find((p) => p.agent && p.focused)
    ?? others.find((p) => p.agent)
    ?? others.find((p) => p.focused)
    ?? others[0] ?? null;
  const reviewers = panes.filter((p) => roleOf(p.label) === 'reviewer');
  const reviewer = reviewers.find((p) => p.label === 'reviewer') ?? reviewers[0] ?? null;
  return { coder, reviewer };
}

// Whether Herdr may start an agent in the pane: no agent now, none waiting to resume after a
// restart, and the shell at its prompt.
function isFreeShell(pane) {
  if (pane.agent || pane.agent_session) return false;
  try {
    const info = herdr('pane', 'process-info', '--pane', pane.pane_id).process_info;
    return info.foreground_process_group_id === info.shell_pid;
  } catch { return false; }
}

// Codex asks about updates when it starts, and Herdr sees that question as idle, so a review
// prompt would land on it. Agents started here skip that question.
const AGENT_ARGS = { codex: ['-c', 'check_for_update_on_startup=false'] };

// Starts a tool in a pane that is at a shell prompt. A new shell may still be loading, so it
// tries again a few times. Returns false when the agent waits at a question (for example
// "Do you trust this folder?"); Herdr then shows it as blocked.
export async function startAgent(pane, role, kind) {
  for (let i = 0; i < 5; i++) {
    try {
      const extra = AGENT_ARGS[kind] ? ['--', ...AGENT_ARGS[kind]] : [];
      herdr('agent', 'start', agentName(role, pane), '--kind', kind, '--pane', pane, '--timeout', '60000', ...extra);
      await sleep(5000); // Herdr reports ready a little before the agent's input box is
      return true;
    } catch (e) {
      if (e.code === 'agent_not_ready') {
        notify(`${kind} needs you`, `Answer the question in the ${role} pane ${pane}.`);
        return false;
      }
      if (i === 4) throw e;
      await sleep(2000);
    }
  }
}

// One run at a time per key. A lock older than staleMs is left over from a crash.
// tryLock returns a release function, or null when another run holds the lock.
export function tryLock(key, staleMs = 10 * MINUTE) {
  const dir = join(STATE_DIR, 'locks', key);
  mkdirSync(join(STATE_DIR, 'locks'), { recursive: true });
  try { mkdirSync(dir); } catch {
    try { if (Date.now() - statSync(dir).mtimeMs > staleMs) rmSync(dir, { recursive: true, force: true }); } catch { /* gone */ }
    try { mkdirSync(dir); } catch { return null; }
  }
  return () => rmSync(dir, { recursive: true, force: true });
}

// Waits for the lock instead of giving up.
export async function withLock(key, work, staleMs = 180 * MINUTE) {
  let release;
  while (!(release = tryLock(key, staleMs))) await sleep(2000);
  try { return await work(); } finally { release(); }
}

// Makes sure the workspace has a coder pane and a reviewer pane, each with a tool running.
// Safe to run many times: it only adds what is missing and never touches a running agent.
// Returns the two pane IDs, or null when another run is doing the work.
export async function ensureLayout(workspace, config = loadConfig(), coderId = null) {
  const release = tryLock(`layout-${workspace.replace(/[^A-Za-z0-9_-]/g, '-')}`);
  if (!release) return null;
  try {
    const panes = herdr('pane', 'list', '--workspace', workspace).panes;
    let { coder, reviewer } = planLayout(panes, coderId);
    if (!coder) return { coder: null, reviewer: reviewer?.pane_id ?? null };
    if (coder.label !== 'coder') herdr('pane', 'rename', coder.pane_id, 'coder');
    if (reviewer && reviewer.label !== 'reviewer') herdr('pane', 'rename', reviewer.pane_id, 'reviewer');
    if (!reviewer) {
      const rect = herdr('pane', 'layout', '--pane', coder.pane_id).layout.panes.find((p) => p.pane_id === coder.pane_id)?.rect;
      const cwd = coder.foreground_cwd || coder.cwd;
      const id = herdr('pane', 'split', '--pane', coder.pane_id, '--direction', splitDirection(rect),
        ...(cwd ? ['--cwd', cwd] : []), '--no-focus').pane.pane_id;
      herdr('pane', 'rename', id, 'reviewer');
      reviewer = herdr('pane', 'get', id).pane;
      log(`layout ${workspace}: reviewer pane ${id} next to coder ${coder.pane_id}`);
    }
    let coderTool = coder.agent ?? coder.agent_session?.agent;
    if (isFreeShell(coder)) {
      coderTool = config.coder;
      await startAgent(coder.pane_id, 'coder', coderTool);
      log(`layout ${workspace}: started ${coderTool} in coder ${coder.pane_id}`);
    }
    if (isFreeShell(reviewer)) {
      const tool = pickReviewer(coderTool ?? config.coder, config, process.env);
      await startAgent(reviewer.pane_id, 'reviewer', tool);
      log(`layout ${workspace}: started ${tool} in reviewer ${reviewer.pane_id}`);
    }
    return { coder: coder.pane_id, reviewer: reviewer.pane_id };
  } finally { release(); }
}

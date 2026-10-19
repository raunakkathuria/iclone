// Shared helpers for the minions in Herdr. Used by the Herdr plugin (pair.mjs) and by the PR
// review hook (pr-review-handoff/hook.mjs).
//
// Roles come from pane labels: the pane labelled "builder-minion" writes the code, the pane
// labelled "reviewer-minion" reviews it. The tool in each pane is whatever Herdr detects there,
// so you can switch tools at any time. A workspace whose label ends in " minions" is a team:
// it also gets "product-minion" and "qa-minion", and each minion starts with its role prompt.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATE_DIR = process.env.PR_HANDOFF_STATE_DIR || join(homedir(), '.local/state/pr-review-handoff');
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// The command that starts a new conversation, so a reviewer never sees its earlier reviews.
export const CLEAR_COMMAND = { claude: '/clear', codex: '/new', cursor: '/clear', kiro: '/clear' };
const DEFAULT_CONFIG = { builder: 'claude', reviewer: 'codex', product: 'claude', qa: 'claude' };
const MINUTE = 60_000;
// The pane label of each role. A pair has the first two; a team has all four.
export const MINIONS = { builder: 'builder-minion', reviewer: 'reviewer-minion', product: 'product-minion', qa: 'qa-minion' };

// The label of a project's team workspace, and whether a workspace label is one.
export const teamLabel = (dir) => `${basename(dir)} minions`;
export const isTeam = (label) => /\sminions$/.test(label ?? '');

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

// The role of a pane label: a key of MINIONS, or null. Old labels still count: "coder",
// "reviewer", and "codex review" and the like from the first version of the hook.
export function roleOf(label) {
  const role = Object.keys(MINIONS).find((r) => MINIONS[r] === label);
  if (role) return role;
  if (label === 'coder') return 'builder';
  if (label === 'reviewer' || /^[a-z]+ review$/i.test(label ?? '')) return 'reviewer';
  return null;
}

// The tool to start in an empty reviewer pane: PR_REVIEWER if set, else the configured reviewer,
// unless the builder already uses that tool; then the configured builder tool.
export function pickReviewer(builder, config = DEFAULT_CONFIG, env = {}) {
  if (env.PR_REVIEWER) return env.PR_REVIEWER;
  return config.reviewer !== builder ? config.reviewer : config.builder;
}

// Split a wide pane to the right and a tall one down. Terminal cells are about twice as tall as wide.
export function splitDirection(rect) {
  return rect && rect.width >= rect.height * 2.5 ? 'right' : 'down';
}

// A unique agent name from the pane ID, which Herdr never reuses: ("reviewer", "w1:p2") -> "reviewer-w1-p2".
export function agentName(role, paneId) {
  return `${role}-${paneId}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 32);
}

// Which pane of a workspace has which role. Pure: works on `pane list` output. The builder is
// builderId when given (the pane that asked for a review), else the builder pane by label, else
// a pane with an agent (the focused one first), else the focused pane, else the first. The other
// roles come from labels only. Any of them can be null.
export function planLayout(panes, builderId = null) {
  // The builder is a pane with the builder role or with no role.
  const free = panes.filter((p) => [null, 'builder'].includes(roleOf(p.label)));
  const builder = free.find((p) => p.pane_id === builderId)
    ?? free.find((p) => roleOf(p.label) === 'builder')
    ?? free.find((p) => p.agent && p.focused)
    ?? free.find((p) => p.agent)
    ?? free.find((p) => p.focused)
    ?? free[0] ?? null;
  const byLabel = (role) => {
    const found = panes.filter((p) => roleOf(p.label) === role);
    return found.find((p) => p.label === MINIONS[role]) ?? found[0] ?? null;
  };
  return { builder, reviewer: byLabel('reviewer'), product: byLabel('product'), qa: byLabel('qa') };
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

// The role prompt of a team minion: the shared team rules plus the role's own file, from
// team/roles/. Written to one file, because Claude takes one prompt file.
export function rolePromptFile(role) {
  const roles = join(REPO_ROOT, 'team', 'roles');
  const file = join(STATE_DIR, 'minions', `${role}.md`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${readFileSync(join(roles, '_shared.md'), 'utf8')}\n${readFileSync(join(roles, `${role}.md`), 'utf8')}`);
  return file;
}

// The arguments that start a team minion with its role. The role stays through /clear and /new.
// Claude reads the prompt file and may run `team` without asking. Codex gets a one-line pointer
// to the file (Herdr refuses arguments with line breaks), and network access in its sandbox:
// without it, `team` cannot reach the Herdr socket.
export function roleArgs(role, kind, file = rolePromptFile(role)) {
  if (kind === 'claude') return ['--append-system-prompt-file', file, '--allowedTools', 'Bash(team:*)'];
  if (kind === 'codex') {
    const pointer = `You are ${MINIONS[role]}, one of the minions. Before every task and every review, read ${file} and follow it.`;
    return ['-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true',
      '-c', `developer_instructions=${JSON.stringify(pointer)}`];
  }
  log(`no role arguments for ${kind}; ${MINIONS[role]} starts without its role`);
  return [];
}

// Starts a tool in a pane that is at a shell prompt. A new shell may still be loading, so it
// tries again a few times. Returns false when the agent waits at a question (for example
// "Do you trust this folder?"); Herdr then shows it as blocked.
export async function startAgent(pane, role, kind, args = []) {
  const label = MINIONS[role] ?? role;
  for (let i = 0; i < 5; i++) {
    try {
      const all = [...(AGENT_ARGS[kind] ?? []), ...args];
      const extra = all.length ? ['--', ...all] : [];
      herdr('agent', 'start', agentName(label, pane), '--kind', kind, '--pane', pane, '--timeout', '60000', ...extra);
      await sleep(5000); // Herdr reports ready a little before the agent's input box is
      return true;
    } catch (e) {
      if (e.code === 'agent_not_ready') {
        notify(`${kind} needs you`, `Answer the question in the ${label} pane ${pane}.`);
        return false;
      }
      if (i === 4) throw e;
      await sleep(2000);
    }
  }
}

const READY = new Set(['idle', 'done']);

// Waits until the agent is ready for input. Tells the human once if it is waiting for them.
// With checks = 2 the agent must be ready twice in a row, 3 seconds apart: between two of its
// questions, an agent such as Kiro looks ready for a moment.
export async function waitReady(pane, who, timeoutMs, checks = 1) {
  const end = Date.now() + timeoutMs;
  let told = false;
  let ready = 0;
  while (Date.now() < end) {
    const status = herdr('agent', 'get', pane).agent.agent_status;
    ready = READY.has(status) ? ready + 1 : 0;
    if (ready >= checks) return true;
    if (status === 'blocked' && !told) {
      notify(`${who} needs you`, `Answer the question in pane ${pane}. The work continues after that.`);
      told = true;
    }
    await sleep(3000);
  }
  return false;
}

// Sends the prompt and checks that the agent starts working on it. An agent that has only just
// started can drop input, so a prompt that never starts any work is sent again.
export async function sendPrompt(pane, text) {
  for (let i = 0; i < 3; i++) {
    try {
      // --wait returns when the agent is ready again or waiting for the human; the caller checks which.
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

// Makes sure the workspace has its minions, each with a tool running: a builder and a reviewer,
// and in a team workspace also a product and a QA minion, in a 2x2 grid. Safe to run many times:
// it only adds what is missing and never touches a running agent. Returns the pane ID of each
// role, or null when another run is doing the work.
export async function ensureLayout(workspace, config = loadConfig(), builderId = null) {
  const release = tryLock(`layout-${workspace.replace(/[^A-Za-z0-9_-]/g, '-')}`);
  if (!release) return null;
  try {
    const team = isTeam(herdr('workspace', 'get', workspace).workspace?.label);
    const panes = herdr('pane', 'list', '--workspace', workspace).panes;
    const found = planLayout(panes, builderId);
    if (!found.builder) return { builder: null, reviewer: found.reviewer?.pane_id ?? null };
    const roles = team ? ['builder', 'reviewer', 'product', 'qa'] : ['builder', 'reviewer'];
    // Label before starting a tool: a tool's session hook reads the label when it starts.
    for (const role of roles) {
      const pane = found[role];
      if (pane && pane.label !== MINIONS[role]) herdr('pane', 'rename', pane.pane_id, MINIONS[role]);
    }
    const { builder } = found;
    const cwd = builder.foreground_cwd || builder.cwd;
    const split = (from, direction, role) => {
      const id = herdr('pane', 'split', '--pane', from.pane_id, '--direction', direction,
        ...(cwd ? ['--cwd', cwd] : []), '--no-focus').pane.pane_id;
      herdr('pane', 'rename', id, MINIONS[role]);
      log(`layout ${workspace}: ${role} pane ${id} next to ${from.pane_id}`);
      return herdr('pane', 'get', id).pane;
    };
    if (!found.reviewer) {
      const rect = herdr('pane', 'layout', '--pane', builder.pane_id).layout.panes.find((p) => p.pane_id === builder.pane_id)?.rect;
      found.reviewer = split(builder, team ? 'right' : splitDirection(rect), 'reviewer');
    }
    if (team) {
      found.product ??= split(builder, 'down', 'product');
      found.qa ??= split(found.reviewer, 'down', 'qa');
    }
    let builderTool = builder.agent ?? builder.agent_session?.agent;
    for (const role of roles) {
      const pane = found[role];
      if (!isFreeShell(pane)) continue;
      const tool = role === 'reviewer' ? pickReviewer(builderTool ?? config.builder, config, process.env) : config[role];
      if (role === 'builder') builderTool = tool;
      await startAgent(pane.pane_id, role, tool, team ? roleArgs(role, tool) : []);
      log(`layout ${workspace}: started ${tool} in ${role} ${pane.pane_id}`);
    }
    return Object.fromEntries(roles.map((role) => [role, found[role].pane_id]));
  } finally { release(); }
}
